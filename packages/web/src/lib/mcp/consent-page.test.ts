// Pins the §25.3 consent page (INNOBOX_SPEC.md), including its anti-phishing shape: the heading
// names the DESTINATION (this computer / the https host / the custom scheme) with the host as the
// most prominent element; the "Approving sends an access code to …" sentence; the "Unverified
// application" notice for a client nobody has approved or one registered under 24 hours ago, and
// nothing extra otherwise; the required "I started this connection" checkbox that gates the
// Approve button's primary styling with pure CSS (no script on the page); and HTML escaping of
// every interpolated value. Also the non-redirecting error page, and the forwarding page that
// answers Approve and Deny: one HTML-escaped URL as both its refresh target and its Continue link,
// the verdict and the destination in its heading, no script — and a consent handler that answers
// with that page and never with a redirect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeDestination,
  escapeHtml,
  htmlResponse,
  REFERRER_POLICY,
  renderConsentPage,
  renderErrorPage,
  renderForwardPage,
  UNVERIFIED_CLIENT_MINUTES,
  type ConsentPageInput,
} from "./consent-page";
import { redirectWith } from "./oauth";

const base: ConsentPageInput = {
  clientName: "Claude Code",
  redirectUri: "http://127.0.0.1:33418/callback",
  personName: "Pat Example",
  requestId: "4f1c0e4a-2b7e-4c2a-9d7e-8f1a2b3c4d5e",
  restrictedShared: true,
  everApproved: true,
  registeredMinutesAgo: UNVERIFIED_CLIENT_MINUTES + 1,
};

const render = (extra: Partial<ConsentPageInput> = {}) => renderConsentPage({ ...base, ...extra });

test("destination: loopback is this computer; https is the host; a custom scheme is scheme://", () => {
  assert.deepEqual(describeDestination("http://localhost:6274/oauth/callback"), { kind: "loopback", label: "this computer" });
  assert.deepEqual(describeDestination("http://[::1]:8080/cb"), { kind: "loopback", label: "this computer" });
  assert.deepEqual(describeDestination("https://claude.ai/api/mcp/auth_callback"), { kind: "https", label: "claude.ai" });
  assert.deepEqual(describeDestination("https://app.example.com:8443/cb"), { kind: "https", label: "app.example.com:8443" });
  assert.deepEqual(describeDestination("cursor://anysphere.cursor-retrieval/oauth/callback"), { kind: "custom", label: "cursor://" });
  assert.deepEqual(describeDestination("com.example.app:/oauth"), { kind: "custom", label: "com.example.app://" });
});

test("heading per destination kind, with the host as the prominent element and the warning sentence", () => {
  const loopback = render();
  assert.ok(loopback.includes(`<h1>Connect Claude Code on <span class="destination">this computer</span>?</h1>`));
  assert.ok(loopback.includes("Approving sends an access code to an application on this computer. Only approve a connection you started from your own AI tool."));

  const https = render({ redirectUri: "https://claude.ai/api/mcp/auth_callback" });
  assert.ok(https.includes(`<h1>Connect Claude Code at <span class="destination">claude.ai</span>?</h1>`));
  assert.ok(https.includes("Approving sends an access code to claude.ai. Only approve a connection you started from your own AI tool."));

  const custom = render({ redirectUri: "cursor://anysphere.cursor-retrieval/oauth/callback" });
  assert.ok(custom.includes(`<h1>Connect Claude Code at <span class="destination">cursor://</span>?</h1>`));
  assert.ok(custom.includes("Approving sends an access code to cursor://."));

  // The destination is styled larger than the heading that carries the client name.
  const destinationSize = Number(/\.destination\{[^}]*font:\s*800\s+(\d+)px/.exec(loopback)?.[1]);
  const headingSize = Number(/\bh1\{[^}]*font:\s*\d+\s+(\d+)px/.exec(loopback)?.[1]);
  assert.ok(destinationSize > headingSize, `${destinationSize} > ${headingSize}`);
  assert.ok(!loopback.includes("<script"), "no script at all");
});

test("unverified notice: never approved, or registered under 24 hours ago; nothing when both are fine", () => {
  const trusted = render();
  assert.ok(!trusted.includes("Unverified application"));
  assert.ok(!trusted.includes("connected this application before"));
  assert.ok(!trusted.includes("registered"));

  const neverApproved = render({ everApproved: false });
  assert.ok(neverApproved.includes("Unverified application"));
  assert.ok(neverApproved.includes("Nobody in your organization has connected this application before."));
  assert.ok(!neverApproved.includes("It was registered"));

  const fresh = render({ registeredMinutesAgo: 3.7 });
  assert.ok(fresh.includes("Unverified application"));
  assert.ok(fresh.includes("It was registered 3 minutes ago."));
  assert.ok(!fresh.includes("connected this application before"));
  assert.ok(render({ registeredMinutesAgo: 1 }).includes("It was registered 1 minute ago."));
  assert.ok(render({ registeredMinutesAgo: 60 }).includes("It was registered 1 hour ago."));
  assert.ok(render({ registeredMinutesAgo: 23 * 60 + 59 }).includes("It was registered 23 hours ago."));
  assert.ok(!render({ registeredMinutesAgo: UNVERIFIED_CLIENT_MINUTES }).includes("Unverified"), "exactly 24 hours is no longer fresh");

  const both = render({ everApproved: false, registeredMinutesAgo: 0 });
  assert.ok(both.includes("Nobody in your organization has connected this application before. It was registered 0 minutes ago."));
  // The notice sits above the form's buttons, in the warn tone.
  assert.ok(both.indexOf('class="warn"') < both.indexOf("<form"));
  assert.ok(both.includes("--warn:"));
});

test("the confirmation checkbox is in the form, required, and gates Approve's primary styling by CSS", () => {
  const html = render();
  assert.ok(html.includes(`<input type="checkbox" id="confirm" name="confirm" value="1" required>`));
  assert.ok(html.includes(`<label for="confirm" class="confirm">I started this connection from my own AI tool</label>`));
  assert.ok(html.includes(`<button type="submit" name="decision" value="approve" class="primary">Approve</button>`));
  assert.ok(html.includes(`<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>`), "Deny needs no tick");
  assert.ok(html.includes("#confirm:checked~.actions .primary{background:var(--accent)"), "primary styling only once ticked");
  assert.ok(!/\nbutton\.primary\{/.test(html), "unticked, Approve looks like the secondary button");
  // The checkbox, the label and the actions are siblings inside the form (the CSS relies on it).
  const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
  assert.ok(form.indexOf('id="confirm"') < form.indexOf('class="actions"'));
  assert.ok(form.includes(`<input type="hidden" name="request_id" value="${base.requestId}">`));
  assert.ok(form.includes('action="/oauth/consent"') && form.includes('method="post"'));
});

test("§25.3 referrer policy: all three pages are same-origin and never no-referrer", () => {
  // Under no-referrer a browser sends `Origin: null` on the approval's form POST, and the §2.4
  // check on POST /oauth/consent refuses it — nobody could approve a connection. On the forwarding
  // page same-origin means its navigation to the client carries no Referer.
  assert.equal(REFERRER_POLICY, "same-origin");
  const forwarding = renderForwardPage({ outcome: "approved", redirectUri: base.redirectUri, target: `${base.redirectUri}?code=c` });
  for (const html of [render(), renderErrorPage("x"), forwarding]) {
    const metas = html.match(/<meta name="referrer"[^>]*>/g) ?? [];
    assert.deepEqual(metas, [`<meta name="referrer" content="same-origin">`], "exactly one referrer meta, same-origin");
    assert.ok(!html.includes("no-referrer"));
    // In the head, before any content: a policy declared after the form would not govern it.
    assert.ok(html.indexOf('<meta name="referrer"') < html.indexOf("</head>"));
  }
});

test("grant wording, the restricted-content note and the revoke pointer", () => {
  const html = render({ restrictedShared: false });
  assert.ok(html.includes("Signed in as <strong>Pat Example</strong>."));
  assert.ok(html.includes("Read the challenges, solutions and comments you can see."));
  assert.ok(html.includes("Submit challenges, propose solutions, edit and resubmit your own items, comment and follow — as you, marked 'via agent'."));
  assert.ok(html.includes("It cannot like, change a status, assign, triage or administer."));
  assert.ok(html.includes("Namespace-restricted challenges are not shared with agents."));
  assert.ok(html.includes('<a href="/agents">AI agents</a>'));
  assert.ok(!render({ restrictedShared: true }).includes("Namespace-restricted"));
  assert.ok(!html.includes("§"), "no spec reference reaches the page");
});

test("every interpolated value is escaped", () => {
  const html = render({
    clientName: '<script>alert("x")</script>',
    redirectUri: "https://evil.example/cb?x=<b>",
    personName: "A & B",
    requestId: '"id"',
    everApproved: false,
  });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("<title>Connect &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; to InnoBox</title>"));
  assert.ok(html.includes("A &amp; B"));
  assert.ok(html.includes('value="&quot;id&quot;"'));
  assert.ok(html.includes(`<span class="destination">evil.example</span>`), "the host alone, never the query");
  assert.equal(escapeHtml(`'<>&"`), "&#39;&lt;&gt;&amp;&quot;");
});

/** The refresh target and the Continue link of a rendered forwarding page, HTML-unescaped. */
function forwardTargets(html: string): { refresh: string; link: string } {
  const unescape = (v: string) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const refresh = /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(html);
  const link = /<a class="go" href="([^"]*)">Continue<\/a>/.exec(html);
  assert.ok(refresh && link, "one refresh and one Continue link");
  return { refresh: unescape(refresh[1]!), link: unescape(link[1]!) };
}

test("§25.3 forwarding page: the refresh and the Continue link are the same URL, at once, in the head", () => {
  const redirectUri = "https://ai.example.com/oauth/clients/mcp:innobox/callback";
  const target = redirectWith(redirectUri, { code: "c0de", state: "s t&a=te", iss: "https://innobox.example.com" });
  const html = renderForwardPage({ outcome: "approved", redirectUri, target });

  assert.deepEqual(forwardTargets(html), { refresh: target, link: target });
  assert.equal(new URL(target).searchParams.get("state"), "s t&a=te", "the parameters survive the round trip");
  assert.equal((html.match(/http-equiv="refresh"/g) ?? []).length, 1);
  assert.ok(html.includes('content="0;url=https://ai.example.com/'), "no delay, and the URL starts with its scheme, never a quote");
  assert.ok(html.indexOf('http-equiv="refresh"') < html.indexOf("</head>"), "declared in the head");
  assert.ok(!html.includes("<script") && !html.includes("<form"), "no script and nothing to submit");
  assert.ok(!html.includes("§"), "no spec reference reaches the page");
});

test("§25.3 forwarding page: says Approved or Declined and words the destination as the consent page does", () => {
  const page = (outcome: "approved" | "denied", redirectUri: string) => renderForwardPage({ outcome, redirectUri, target: redirectUri });
  assert.ok(page("approved", "https://claude.ai/api/mcp/auth_callback").includes(`<h1>Approved. Returning to <span class="destination">claude.ai</span>…</h1>`));
  assert.ok(page("denied", "https://claude.ai/api/mcp/auth_callback").includes(`<h1>Declined. Returning to <span class="destination">claude.ai</span>…</h1>`));
  assert.ok(page("approved", "http://127.0.0.1:33418/callback").includes(`Returning to <span class="destination">this computer</span>…`));
  assert.ok(page("approved", "cursor://anysphere.cursor-retrieval/oauth/callback").includes(`Returning to <span class="destination">cursor://</span>…`));
  const html = page("approved", "https://claude.ai/api/mcp/auth_callback");
  assert.ok(html.includes("<title>Returning to claude.ai</title>"));
  assert.ok(html.includes(`<p class="muted">If nothing happens, select Continue.</p>`));
  // Continue is the page's one control, styled as the primary button.
  assert.ok(html.includes("a.go{") && /a\.go\{[^}]*background:var\(--accent\)/.test(html));
  assert.ok(!html.includes("AI agents"), "nothing else on the page");
});

test("§25.3 forwarding page: a redirect URI and a state full of markup stay inert", () => {
  // Through the real builder: the URL serializer already encodes what a client could put there.
  const redirectUri = `myapp://cb/"><script>alert(1)</script>?x='y'&z=<b>`;
  const built = redirectWith(redirectUri, { error: "access_denied", state: `"><img src=x onerror=alert(1)>`, iss: "https://innobox.example.com" });
  // And with a target that is NOT encoded: the page escapes whatever it is given, by itself.
  const raw = `https://a.example/cb?x="><script>alert(1)</script>&y='z'&state=<img src=x onerror=alert(1)>`;
  for (const target of [built, raw]) {
    const html = renderForwardPage({ outcome: "denied", redirectUri, target });
    assert.ok(!html.includes("<script>") && !html.includes("<img") && !html.includes("<b>"));
    // Every attribute the URL sits in is closed only by the page's own quote, so the whole URL
    // comes back out of both.
    assert.deepEqual(forwardTargets(html), { refresh: target, link: target });
    assert.equal((html.match(/<meta /g) ?? []).length, 4, "charset, viewport, referrer, refresh — no injected fifth");
    assert.equal((html.match(/<a /g) ?? []).length, 1);
  }
});

test("§25.3: the answer to a consent is a 200 page with no Location, and the handler never redirects", async () => {
  const res = htmlResponse(renderForwardPage({ outcome: "approved", redirectUri: base.redirectUri, target: `${base.redirectUri}?code=c` }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  // Source-level (the handler needs the session layer, which the unit runner cannot load): neither
  // the route nor the logic it delegates to can produce a redirect. A 303 to the client is blocked
  // by any CSP whose form-action does not name the client — after the code has been minted.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const route = readFileSync(path.join(here, "..", "..", "app", "oauth", "consent", "route.ts"), "utf8");
  const logic = readFileSync(path.join(here, "consent.ts"), "utf8");
  assert.ok(route.includes("await answerConsent(pool, user.id,"), "the route delegates to answerConsent");
  for (const source of [route, logic]) {
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.ok(!/\bLocation\b/.test(code) && !/status:\s*30\d/.test(code) && !code.includes("Response.redirect"), "no redirect of any kind");
  }
  assert.ok(logic.includes('forward("denied", { error: "access_denied"') && logic.includes('forward("approved", { code: approved.code'));
});

test("the error page escapes its message and points back to AI agents", () => {
  const html = renderErrorPage("The request names \"<redirect_uri>\" more than once.");
  assert.ok(html.includes("This connection can't be completed"));
  assert.ok(html.includes("&quot;&lt;redirect_uri&gt;&quot;"));
  assert.ok(!html.includes("<redirect_uri>"));
  assert.ok(html.includes('<a href="/agents">AI agents</a>'));
});
