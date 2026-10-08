// The §12 email HTML wrapper: sanitization, the [SYSTEM MESSAGE] placeholder contract, and
// the pure renderers that turn a notification's plain text into the wrapped HTML + text parts.
// Server-only: the sanitizer is a real HTML parser (sanitize-html over htmlparser2) with an
// explicit e-mail-safe allowlist, run when the wrapper is saved AND again when it is rendered.
// INNOBOX_SPEC.md §12 (HTML message wrapper, *E-mail content safety*).
import { randomBytes } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { Parser } from "htmlparser2";

/** The literal, case-sensitive token the wrapper must contain exactly once. */
export const EMAIL_WRAPPER_PLACEHOLDER = "[SYSTEM MESSAGE]";

/** Count occurrences of the literal placeholder (case-sensitive). */
export function countWrapperPlaceholders(html: string): number {
  return html.split(EMAIL_WRAPPER_PLACEHOLDER).length - 1;
}

// ── Wrapper sanitizer (§12 *E-mail content safety*) ─────────────────────────────────────────

/** E-mail-safe elements: document skeleton, layout tables, block/inline text formatting,
 *  lists, images, and links. Everything else is dropped (its text kept, except NON_TEXT). */
const ALLOWED_TAGS = [
  "html", "head", "body", "title",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "div", "span", "p", "br", "hr", "center", "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "b", "strong", "i", "em", "u", "s", "strike", "small", "big", "sub", "sup", "font", "abbr",
  "ul", "ol", "li", "dl", "dt", "dd",
  "a", "img",
];

/** Disallowed elements removed together with their content (active or hidden content that
 *  must never leak as text either). */
const NON_TEXT_TAGS = [
  "script", "style", "textarea", "option", "xmp", "noscript", "template",
  "iframe", "frame", "frameset", "noframes", "object", "embed", "applet",
  "select", "svg", "math",
];

const GLOBAL_ATTRS = ["style", "class", "id", "align", "valign", "dir", "lang", "title", "width", "height", "bgcolor", "role"];

const ALLOWED_ATTRS: Record<string, string[]> = {
  "*": GLOBAL_ATTRS,
  table: ["border", "cellpadding", "cellspacing", "summary"],
  td: ["colspan", "rowspan", "nowrap"],
  th: ["colspan", "rowspan", "nowrap", "scope"],
  col: ["span"],
  colgroup: ["span"],
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "border"],
  font: ["color", "face", "size"],
  ol: ["start", "type"],
  ul: ["type"],
};

/** A style attribute carrying script-ish or off-scheme URL content is dropped whole (CSS
 *  `url(...)` must be https or cid, matching the URL-attribute rule). */
function unsafeStyle(style: string): boolean {
  const s = style.replace(/\\/g, "").replace(/\s+/g, "").toLowerCase();
  if (/expression\(|javascript:|vbscript:|behavior:|-moz-binding|@import/.test(s)) return true;
  for (const m of s.matchAll(/url\(['"]?([^'")]*)/g)) {
    if (!/^(https:|cid:)/.test(m[1] ?? "")) return true;
  }
  return false;
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRS,
  nonTextTags: NON_TEXT_TAGS,
  disallowedTagsMode: "discard",
  allowedSchemes: ["https", "mailto", "cid"],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ["href", "src", "cite", "background"],
  allowProtocolRelative: false,
  allowVulnerableTags: false,
  transformTags: {
    "*": (tagName, attribs) => {
      if (attribs.style !== undefined && unsafeStyle(attribs.style)) {
        const { style: _dropped, ...rest } = attribs;
        return { tagName, attribs: rest };
      }
      return { tagName, attribs };
    },
  },
};

/** HTML comments are kept as-is (§12): the conditional comments HTML e-mail layouts depend on
 *  are inert in browsers. sanitize-html drops comments, so they are lifted out first — located
 *  by the SAME parser sanitize-html uses (so a `<!--` inside an attribute value is never
 *  mistaken for one) — replaced by unforgeable text tokens, and put back after sanitizing.
 *  Only a well-formed `<!-- … -->` is restored; anything else the parser calls a comment
 *  (bogus comments, CDATA, `--!>`-terminated) is dropped. */
function liftComments(html: string): { text: string; comments: string[]; token: (i: number) => string } {
  let nonce = randomBytes(12).toString("hex");
  while (html.includes(nonce)) nonce = randomBytes(12).toString("hex");
  const token = (i: number) => `innoboxcmt${nonce}n${i}e`;

  const ranges: { start: number; end: number }[] = [];
  const parser = new Parser({
    oncomment() {
      ranges.push({ start: parser.startIndex, end: parser.endIndex });
    },
  });
  parser.write(html);
  parser.end();

  const comments: string[] = [];
  let out = "";
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor || r.end < r.start) continue; // defensive: overlapping/odd range
    const raw = html.slice(r.start, r.end + 1);
    out += html.slice(cursor, r.start);
    cursor = r.end + 1;
    const inner = raw.slice(4, -3);
    const wellFormed =
      raw.startsWith("<!--") && raw.endsWith("-->") && raw.length >= 7 && !inner.includes("-->") && !inner.includes("--!>");
    if (!wellFormed) continue; // dropped
    out += token(comments.length);
    comments.push(raw);
  }
  out += html.slice(cursor);
  return { text: out, comments, token };
}

/**
 * Sanitize the ADMIN-authored wrapper (§12) with a real HTML parser against an explicit
 * allowlist: e-mail-safe layout/text elements, images, and links survive; script, style,
 * meta, base, link, forms, frames and every `on*` attribute are dropped, as is any URL whose
 * scheme isn't https, mailto, or cid. HTML comments are kept as-is.
 */
export function sanitizeWrapperHtml(html: string): string {
  if (typeof html !== "string" || html === "") return "";
  const { text, comments, token } = liftComments(html);
  let out = sanitizeHtml(text, SANITIZE_OPTIONS);
  comments.forEach((raw, i) => {
    out = out.split(token(i)).join(raw);
  });
  return out;
}

export type WrapperValidation = { ok: true; sanitized: string } | { ok: false; error: string };

/** Sanitize + enforce the placeholder contract: exactly one literal [SYSTEM MESSAGE]. */
export function validateWrapperHtml(html: string): WrapperValidation {
  if (typeof html !== "string" || html.trim() === "") return { ok: false, error: "the wrapper cannot be empty" };
  const sanitized = sanitizeWrapperHtml(html);
  const n = countWrapperPlaceholders(sanitized);
  if (n === 0) return { ok: false, error: `the wrapper must contain the placeholder ${EMAIL_WRAPPER_PLACEHOLDER}` };
  if (n > 1) return { ok: false, error: `the placeholder ${EMAIL_WRAPPER_PLACEHOLDER} may appear only once (found ${n})` };
  return { ok: true, sanitized };
}

// ── Message rendering ─────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const TRAILING_URL_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")"]);

/** Drop trailing sentence punctuation from a matched URL. A plain backwards scan rather than a
 *  `[…]+$` regex, which backtracks quadratically on a long run of punctuation mid-URL. */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING_URL_PUNCTUATION.has(url[end - 1]!)) end--;
  return url.slice(0, end);
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Turn a notification's rendered plain text into an HTML fragment: escaped, newlines as <br>.
 * A URL becomes a clickable anchor ONLY when its origin equals `baseUrl`'s (the app's own
 * PUBLIC_BASE_URL — the deep link every notification carries, §12). Any other URL — one a user
 * wrote into a title or comment — stays escaped plain text: readable and copyable, never a
 * link lent the service mailbox's trust (§12 *E-mail content safety*). With no usable base URL,
 * nothing is linked.
 */
export function textToHtmlFragment(text: string, baseUrl: string): string {
  const appOrigin = baseUrl ? originOf(baseUrl) : null;
  let out = "";
  let cursor = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const start = m.index ?? 0;
    // Trailing sentence punctuation is not part of the link.
    const url = trimTrailingPunctuation(m[0]);
    out += escapeHtml(text.slice(cursor, start));
    const safe = escapeHtml(url);
    out += appOrigin !== null && originOf(url) === appOrigin ? `<a href="${safe}">${safe}</a>` : safe;
    cursor = start + url.length;
  }
  out += escapeHtml(text.slice(cursor));
  return out.replace(/\n/g, "<br>\n");
}

/** The always-appended opt-out pointer (§12). Absolute when the base URL is known. */
export function manageEmailFooterHtml(baseUrl: string): string {
  const inner = baseUrl
    ? `<a href="${escapeHtml(baseUrl.replace(/\/$/, ""))}/profile">Manage email notifications</a>`
    : "Manage email notifications in your innobox profile.";
  return `<p style="margin-top:24px;font-size:12px;color:#888888">${inner}</p>`;
}

export function manageEmailFooterText(baseUrl: string): string {
  return baseUrl
    ? `\n\n—\nManage email notifications: ${baseUrl.replace(/\/$/, "")}/profile`
    : "\n\n—\nManage email notifications in your innobox profile.";
}

/** The minimal wrapper used when a stored one no longer satisfies the placeholder contract
 *  after re-sanitizing (e.g. a row saved before a sanitizer change hid it in dropped markup). */
const FALLBACK_WRAPPER = `<div>${EMAIL_WRAPPER_PLACEHOLDER}</div>`;

/**
 * Render the HTML part of a notification email: the stored wrapper is sanitized again (so a
 * row stored before a sanitizer change is still cleaned on use), the plain-text message
 * becomes an HTML fragment substituted for [SYSTEM MESSAGE], and the manage-preferences footer
 * is appended even when the template omits it.
 */
export function renderWrappedEmailHtml(wrapperHtml: string, messageText: string, baseUrl: string): string {
  let wrapper = sanitizeWrapperHtml(wrapperHtml);
  if (countWrapperPlaceholders(wrapper) !== 1) wrapper = FALLBACK_WRAPPER;
  const fragment = textToHtmlFragment(messageText, baseUrl);
  return wrapper.replace(EMAIL_WRAPPER_PLACEHOLDER, () => fragment) + manageEmailFooterHtml(baseUrl);
}

/** Render the plain-text alternative part: the existing text rendering + the manage line. */
export function renderEmailText(messageText: string, baseUrl: string): string {
  return messageText + manageEmailFooterText(baseUrl);
}
