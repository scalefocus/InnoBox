import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_WRAPPER_PLACEHOLDER,
  countWrapperPlaceholders,
  sanitizeWrapperHtml,
  validateWrapperHtml,
  textToHtmlFragment,
  renderWrappedEmailHtml,
  renderEmailText,
} from "./email-template.js";

const BASE = "https://innobox.example.com";

// ── Wrapper sanitizer: a real parser + explicit allowlist (§12 *E-mail content safety*) ─────

test("sanitize: script/iframe/object/embed removed with content", () => {
  const dirty = `<p>hi</p><script>alert(1)</script><iframe src="x"></iframe><object data="x">o</object><embed src="x"><p>bye</p>`;
  assert.equal(sanitizeWrapperHtml(dirty), "<p>hi</p><p>bye</p>");
});

test("sanitize: form tags stripped, children kept", () => {
  assert.equal(sanitizeWrapperHtml(`<form action="/x"><b>keep</b></form>`), "<b>keep</b>");
});

test("sanitize: form controls, frames, and buttons never survive", () => {
  const out = sanitizeWrapperHtml(`<form><input name="p" value="x"><button formaction="https://x">go</button><select><option>o</option></select></form><frameset><frame src="https://x"></frameset>`);
  assert.doesNotMatch(out, /<(form|input|button|select|option|frame|frameset)\b/i);
  assert.doesNotMatch(out, /formaction/i);
});

test("sanitize: on* handlers and javascript: URLs dropped, safe attrs kept", () => {
  const clean = sanitizeWrapperHtml(`<a href="javascript:alert(1)" onclick="x()" title="t">go</a><img src="https://x/y.png" onerror="p()">`);
  assert.equal(clean, `<a title="t">go</a><img src="https://x/y.png" />`);
});

test("sanitize: the quoted-'>' attribute bypass of a regex sanitizer is parsed correctly", () => {
  // A regex tag-matcher ends the tag at the '>' inside the quoted title and lets onclick through.
  const out = sanitizeWrapperHtml(`<a title=">" onclick=alert(1)>x</a>`);
  assert.doesNotMatch(out, /onclick/i);
  assert.doesNotMatch(out, /alert/);
  assert.match(out, /<a title="&gt;">x<\/a>/);
});

test("sanitize: style, meta, base, and link elements are dropped", () => {
  const out = sanitizeWrapperHtml(
    `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/x.css"><style>body{background:url(https://evil.example/t.png)}</style><title>T</title></head><body><p>${EMAIL_WRAPPER_PLACEHOLDER}</p></body></html>`,
  );
  assert.doesNotMatch(out, /<(meta|base|link|style)\b/i);
  assert.doesNotMatch(out, /evil\.example/);
  assert.match(out, /<body><p>\[SYSTEM MESSAGE\]<\/p><\/body>/);
});

test("sanitize: only https, mailto, and cid URL schemes survive", () => {
  const out = sanitizeWrapperHtml(
    `<a href="https://ok.example/">a</a><a href="mailto:x@example.com">b</a><img src="cid:logo"><a href="http://plain.example/">c</a><a href="data:text/html,x">d</a><a href="vbscript:x">e</a><img src="data:image/png;base64,AAAA"><a href="//proto.example/">f</a>`,
  );
  assert.match(out, /href="https:\/\/ok\.example\/"/);
  assert.match(out, /href="mailto:x@example\.com"/);
  assert.match(out, /src="cid:logo"/);
  assert.doesNotMatch(out, /http:\/\/plain|data:|vbscript:|\/\/proto/);
});

test("sanitize: obfuscated javascript: scheme (whitespace/control chars/entities) still dropped", () => {
  for (const href of ["java\nscript:alert(1)", " javascript:alert(1)", "jav&#x09;ascript:alert(1)", "JaVaScRiPt:alert(1)", "&#106;avascript:alert(1)"]) {
    const clean = sanitizeWrapperHtml(`<a href="${href}">x</a>`);
    assert.ok(!clean.includes("href"), `${JSON.stringify(href)} → ${clean}`);
  }
});

test("sanitize: a style attribute carrying script or off-scheme url() is dropped whole", () => {
  assert.equal(sanitizeWrapperHtml(`<td style="width:expression(alert(1))">x</td>`), "<td>x</td>");
  assert.equal(sanitizeWrapperHtml(`<td style="background:url(javascript:alert(1))">x</td>`), "<td>x</td>");
  assert.equal(sanitizeWrapperHtml(`<td style="background:url(http://t.example/p.png)">x</td>`), "<td>x</td>");
  assert.match(sanitizeWrapperHtml(`<td style="background:url(https://cdn.example/p.png)">x</td>`), /style=/);
});

test("sanitize: nested/split drop-tags cannot reassemble into live active content", () => {
  for (const dirty of [
    `<scr<iframe></iframe>ipt>alert(1)</scr<iframe></iframe>ipt>`,
    `<scr</iframe>ipt>alert(2)</scr</iframe>ipt>`,
    `<scr<form>ipt>alert(3)</scr</form>ipt>`,
    `<<script>script>alert(4)<</script>/script>`,
  ]) {
    const out = sanitizeWrapperHtml(dirty);
    assert.ok(!/<script/i.test(out), out);
  }
});

test("sanitize: conditional comments and style attributes survive (email idioms)", () => {
  const html = `<!--[if mso]>outlook<![endif]--><table><tr><td style="color:#082773">x</td></tr></table>`;
  assert.equal(sanitizeWrapperHtml(html), html);
});

test("sanitize: comments are kept as-is, but a '<!--' inside an attribute is not a comment", () => {
  // The parser — not a regex — decides what is a comment, so a fake one spanning attributes
  // cannot smuggle an event handler back in on restore.
  const out = sanitizeWrapperHtml(`<a title="<!--" onclick="alert(1)" href="https://x.example/" id="-->">y</a>`);
  assert.doesNotMatch(out, /onclick/i);
  // Abruptly closed and '--!>'-terminated comments never resurrect the markup after them.
  for (const dirty of [`<!--><img src=x onerror=alert(1)>-->`, `<!-- a --!><img src=x onerror=alert(1)> -->`]) {
    const o = sanitizeWrapperHtml(dirty);
    assert.doesNotMatch(o, /onerror/i, o);
  }
  // The downlevel-revealed pattern keeps both comments around the (sanitized) content.
  const dl = `<!--[if !mso]><!--><p>modern</p><!--<![endif]-->`;
  assert.equal(sanitizeWrapperHtml(dl), dl);
});

test("sanitize: email layout markup passes through", () => {
  const html = `<table width="600" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#ffffff"><tr><td colspan="2" valign="top"><font face="Arial" color="#333333"><b>Hi</b> <i>there</i></font><br /><img src="https://cdn.example/logo.png" alt="logo" width="120" /></td></tr></table>`;
  assert.equal(sanitizeWrapperHtml(html), html);
});

// ── Placeholder contract ──────────────────────────────────────────────────────────────────

test("placeholder contract: exactly one required", () => {
  assert.equal(validateWrapperHtml(`<div>no placeholder</div>`).ok, false);
  assert.equal(validateWrapperHtml(`<div>${EMAIL_WRAPPER_PLACEHOLDER} and ${EMAIL_WRAPPER_PLACEHOLDER}</div>`).ok, false);
  const v = validateWrapperHtml(`<div>${EMAIL_WRAPPER_PLACEHOLDER}</div>`);
  assert.equal(v.ok, true);
  assert.equal(countWrapperPlaceholders((v as { sanitized: string }).sanitized), 1);
});

test("placeholder is case-sensitive", () => {
  assert.equal(validateWrapperHtml(`<div>[system message]</div>`).ok, false);
});

test("placeholder validation runs AFTER sanitization (placeholder inside script/style doesn't count)", () => {
  assert.equal(validateWrapperHtml(`<script>${EMAIL_WRAPPER_PLACEHOLDER}</script>`).ok, false);
  assert.equal(validateWrapperHtml(`<style>${EMAIL_WRAPPER_PLACEHOLDER}</style>`).ok, false);
});

// ── Message rendering: only the app's own links are clickable ───────────────────────────────

test("textToHtmlFragment: escapes, links the app's own URLs, and preserves line breaks", () => {
  const frag = textToHtmlFragment(`<b>&\nView it: ${BASE}/challenges/12`, BASE);
  assert.ok(frag.startsWith("&lt;b&gt;&amp;<br>"));
  assert.ok(frag.includes(`<a href="${BASE}/challenges/12">${BASE}/challenges/12</a>`));
});

test("textToHtmlFragment: a URL on any other origin stays escaped plain text", () => {
  for (const foreign of [
    "https://evil.example/login",
    "http://innobox.example.com/challenges/1", // scheme differs → different origin
    "https://innobox.example.com:8443/x", // port differs
    "https://innobox.example.com.evil.example/x", // suffix trick
    "https://innobox.example.com@evil.example/x", // userinfo trick
  ]) {
    const frag = textToHtmlFragment(`Title with ${foreign} in it`, BASE);
    assert.doesNotMatch(frag, /<a\b/, foreign);
    assert.ok(frag.includes(foreign.replace(/&/g, "&amp;")), frag);
  }
});

test("textToHtmlFragment: markup in a URL-ish string cannot break out", () => {
  const frag = textToHtmlFragment(`https://evil.example/"><script>alert(1)</script>`, BASE);
  assert.doesNotMatch(frag, /<script|<a\b/);
  const own = textToHtmlFragment(`${BASE}/x"onmouseover="alert(1)`, BASE);
  assert.doesNotMatch(own, /" ?onmouseover="/);
});

test("textToHtmlFragment: no base URL → nothing is linked", () => {
  assert.doesNotMatch(textToHtmlFragment(`${BASE}/challenges/1`, ""), /<a\b/);
  assert.doesNotMatch(textToHtmlFragment(`${BASE}/challenges/1`, "not a url"), /<a\b/);
});

test("textToHtmlFragment: trailing sentence punctuation is not part of the link", () => {
  const frag = textToHtmlFragment(`See ${BASE}/challenges/3.`, BASE);
  assert.ok(frag.includes(`<a href="${BASE}/challenges/3">${BASE}/challenges/3</a>.`), frag);
});

test("renderWrappedEmailHtml: substitutes once and always appends the manage footer", () => {
  const html = renderWrappedEmailHtml(`<div>${EMAIL_WRAPPER_PLACEHOLDER}</div>`, "hello $& world", "https://s.example.com/");
  assert.ok(html.includes("hello $&amp; world")); // `$&` in the message must not trigger replace() patterns
  assert.ok(html.includes(`href="https://s.example.com/profile"`));
  assert.ok(html.includes("Manage email notifications"));
});

test("renderWrappedEmailHtml: re-sanitizes a stored wrapper on render", () => {
  // A row saved before a sanitizer change still renders clean.
  const stored = `<div onclick="x()"><a title=">" onclick=alert(1)>t</a><script>bad()</script>${EMAIL_WRAPPER_PLACEHOLDER}</div>`;
  const html = renderWrappedEmailHtml(stored, "msg", BASE);
  assert.doesNotMatch(html, /onclick|<script|bad\(\)/i);
  assert.ok(html.includes("msg"));
});

test("renderWrappedEmailHtml: a stored wrapper whose placeholder no longer survives falls back", () => {
  const html = renderWrappedEmailHtml(`<style>${EMAIL_WRAPPER_PLACEHOLDER}</style>`, "the message", BASE);
  assert.ok(html.includes("the message"));
});

test("renderWrappedEmailHtml: only same-origin links in the message become anchors", () => {
  const html = renderWrappedEmailHtml(
    `<div>${EMAIL_WRAPPER_PLACEHOLDER}</div>`,
    `New comment: see https://phish.example/reset\n\n${BASE}/challenges/7`,
    BASE,
  );
  assert.ok(html.includes(`<a href="${BASE}/challenges/7">`));
  assert.doesNotMatch(html, /<a href="https:\/\/phish/);
  // The foreign URL survives as plain text, in place, right after the words that preceded it.
  assert.match(html, /New comment: see https:\/\/phish\.example\/reset<br>/);
});

test("textToHtmlFragment: trailing punctuation is trimmed from links, and a long punctuation run stays fast", () => {
  const html = textToHtmlFragment(`Open ${BASE}/challenges/7!).`, BASE);
  assert.ok(html.startsWith(`Open <a href="${BASE}/challenges/7">${BASE}/challenges/7</a>`));
  assert.ok(html.endsWith("!)."));

  const hostile = `${BASE}/x${"!".repeat(50_000)}y`;
  const started = Date.now();
  textToHtmlFragment(hostile, BASE);
  assert.ok(Date.now() - started < 1000, "linear in the input length");
});

test("renderEmailText: appends the manage line (absolute when base URL known)", () => {
  assert.ok(renderEmailText("msg", "https://s.example.com").includes("https://s.example.com/profile"));
  assert.ok(renderEmailText("msg", "").includes("Manage email notifications"));
});
