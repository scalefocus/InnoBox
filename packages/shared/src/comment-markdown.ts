// §44 Comments: Markdown and links (INNOBOX_SPEC.md §44.3, §44.4). Pure and client-safe — exposed
// at `@innobox/shared/comment-markdown` for the comment thread and the comment box's Preview tab.
//
// A comment's display text is parsed into a small tree of the kinds §44.3 allows; the page builds
// its elements from that tree. No HTML string is produced anywhere, so nothing a person types can
// become markup. The server stores and returns the text as written and never calls this.
//
// The reading is CommonMark's (micromark, through mdast-util-from-markdown), plus two GFM
// extensions: `~~strikethrough~~` and bare addresses. What §44.3 does not support is switched off
// in the tokenizer (`UNSUPPORTED`), not removed afterwards — that is what leaves it as typed.
//
// THE CONTRACT BELOW (types and signatures) IS FIXED — the thread and the Preview tab are built
// against it.
import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import type { Link, Nodes, PhrasingContent, RootContent } from "mdast";

/** Where a mention sits in a comment's display text, in UTF-16 code units (§44.10). */
export interface CommentMentionRange {
  start: number;
  length: number;
}

export type CommentInline =
  | { type: "text"; value: string }
  /** A line break is a line break (§44 decision 3). */
  | { type: "break" }
  | { type: "strong"; children: CommentInline[] }
  | { type: "emphasis"; children: CommentInline[] }
  | { type: "strike"; children: CommentInline[] }
  /** Inline code: `value` is shown as it is, in the mono font. */
  | { type: "code"; value: string }
  /** `href` has passed `commentLinkHref` — always an absolute http(s) address. Its children never
   *  hold another link or a mention (a mention inside a link's label is plain text). */
  | { type: "link"; href: string; children: CommentInline[] }
  /** One of the `mentions` ranges: `index` is its position in that array, `text` the display text
   *  it covers ("@Ana Petrova"). Never produced inside code or a link. */
  | { type: "mention"; index: number; text: string };

export type CommentBlock =
  | { type: "paragraph"; children: CommentInline[] }
  /** A fenced code block: `value` keeps its spaces and line breaks; the language is dropped. */
  | { type: "codeBlock"; value: string }
  /** `start` is the first number of an ordered list (null on a bullet list). Each item is a list
   *  of blocks, so lists nest and may hold quotes and code blocks. */
  | { type: "list"; ordered: boolean; start: number | null; items: CommentBlock[][] }
  | { type: "quote"; children: CommentBlock[] };

/** §44.4: every link opens in a new tab, with no opener and no referrer. */
export const COMMENT_LINK_TARGET = "_blank";
export const COMMENT_LINK_REL = "noopener noreferrer";

/**
 * §44.4 — the link rule. The address a link opens, or null when the text must NOT become a link:
 * only an absolute `http:` or `https:` address qualifies (a bare `www.` address is opened over
 * https). Every other scheme (`javascript:`, `data:`, `file:`, `mailto:`, `tel:` …), a relative
 * address and an e-mail address answer null.
 */
export function commentLinkHref(url: string): string | null {
  const trimmed = url.trim();
  const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * §44.3 "What does not": the CommonMark constructs switched off in the tokenizer, by micromark's
 * own names. Headings (`# …` and underlined ones), rules, raw HTML, indented code, images,
 * reference definitions — which takes reference links and footnote-like text with it — and
 * character references (`&amp;`) are then ordinary text. Tables, task lists and footnotes are GFM
 * extensions that are simply never switched on.
 */
const UNSUPPORTED = [
  "headingAtx",
  "setextUnderline",
  "thematicBreak",
  "htmlFlow",
  "htmlText",
  "codeIndented",
  "labelStartImage",
  "definition",
  "characterReference",
];

const PARSER: Options = {
  extensions: [gfmStrikethrough({ singleTilde: false }), gfmAutolinkLiteral(), { disable: { null: UNSUPPORTED } }],
  mdastExtensions: [gfmStrikethroughFromMarkdown(), gfmAutolinkLiteralFromMarkdown()],
};

// A mention is handed to the parser as a placeholder — U+E000, its index in `mentions`, U+E001 —
// which no Markdown rule reads. Both marks are removed from the text first, so nothing a person
// types can pass for one (the API removes them from every stored comment as well, §44.5).
const MARKS = /[]/g;
const PLACEHOLDER = /(\d+)/g;

interface Context {
  /** What the parser reads: line breaks as "\n", each mention a placeholder. */
  source: string;
  /** The text each placeholder stands for, by its index in `mentions`. */
  covered: Map<number, string>;
}

/** Text without the private-use marks, and with one kind of line break. */
function clean(text: string): string {
  return text.replace(MARKS, "").replace(/\r\n?/g, "\n");
}

/**
 * The parser's input. A range counts when it lies inside the text, starts at an "@", covers more
 * than the "@" and does not overlap a range before it in `mentions`; every other range is ignored.
 */
function prepare(text: string, mentions: readonly CommentMentionRange[]): Context {
  const covered = new Map<number, string>();
  const units: { index: number; start: number; end: number }[] = [];
  mentions.forEach((range, index) => {
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.length)) return;
    const { start } = range;
    const end = start + range.length;
    if (start < 0 || range.length < 2 || end > text.length || text[start] !== "@") return;
    if (units.some((unit) => start < unit.end && unit.start < end)) return;
    const name = clean(text.slice(start, end));
    if (name.length < 2) return;
    covered.set(index, name);
    units.push({ index, start, end });
  });
  units.sort((a, b) => a.start - b.start);

  let source = "";
  let at = 0;
  for (const unit of units) {
    source += `${clean(text.slice(at, unit.start))}${unit.index}`;
    at = unit.end;
  }
  source += clean(text.slice(at));
  // micromark drops a leading byte order mark, which would shift every offset it reports.
  return { source: source.replace(/^﻿+/, ""), covered };
}

/** Parser output back to what was typed: every placeholder as the text it covers. */
function restore(value: string, ctx: Context): string {
  return value.replace(PLACEHOLDER, (_whole, index: string) => ctx.covered.get(Number(index)) ?? "");
}

/**
 * A run of text as nodes — its line breaks as breaks (§44 decision 3) and its placeholders as
 * mentions, or as their plain text where a mention may not stand (`plain`: a link's label, text
 * shown as typed).
 */
function textInlines(value: string, ctx: Context, plain: boolean): CommentInline[] {
  const out: CommentInline[] = [];
  const lines = (run: string) => {
    run.split("\n").forEach((line, i) => {
      if (i > 0) out.push({ type: "break" });
      if (line !== "") out.push({ type: "text", value: line });
    });
  };
  if (plain) {
    lines(restore(value, ctx));
    return out;
  }
  let at = 0;
  for (const match of value.matchAll(PLACEHOLDER)) {
    lines(value.slice(at, match.index));
    const index = Number(match[1]);
    const text = ctx.covered.get(index);
    if (text !== undefined) out.push({ type: "mention", index, text });
    at = match.index + match[0].length;
  }
  lines(value.slice(at));
  return out;
}

function merged(nodes: CommentInline[]): CommentInline[] {
  const out: CommentInline[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === "text" && last?.type === "text") last.value += node.value;
    else out.push(node);
  }
  return out;
}

/** The exact text a node was parsed from, when the parser recorded where it stands. */
function sourceOf(node: Nodes, ctx: Context): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? ctx.source.slice(start, end) : undefined;
}

function plainText(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("children" in node) return (node.children as readonly Nodes[]).map(plainText).join("");
  return "";
}

/** A node shown as typed: its source text, or the text it holds when it has no position. */
function asTyped(node: Nodes, ctx: Context): CommentInline[] {
  return textInlines(sourceOf(node, ctx) ?? plainText(node), ctx, true);
}

/** Nothing to click on: no children, or only white space. */
function isBlank(nodes: readonly CommentInline[]): boolean {
  return nodes.every((node) => node.type === "break" || (node.type === "text" && node.value.trim() === ""));
}

/**
 * §44.4: a link only when its address passes `commentLinkHref`; otherwise — any other scheme, a
 * relative address, an e-mail address — the text exactly as typed. So is a labelled link with
 * nothing in its label, which would be a link nobody can see.
 */
function link(node: Link, ctx: Context): CommentInline[] {
  const typed = sourceOf(node, ctx);
  const url = restore(node.url, ctx);
  // The autolink extension reads a bare `www.` address as http; it opens over https.
  const bareWww = /^www\./i.test(typed ?? plainText(node)) && url.startsWith("http://");
  // Only a BARE address may leave its scheme out: a labelled link needs an absolute http(s) one,
  // so `[text](www.example.com)` — a relative address, as CommonMark reads it — is shown as typed.
  const href = bareWww ? commentLinkHref(url.slice("http://".length)) : /^https?:\/\//i.test(url) ? commentLinkHref(url) : null;
  if (href === null) return asTyped(node, ctx);
  const children = inlines(node.children, ctx, true);
  return isBlank(children) ? asTyped(node, ctx) : [{ type: "link", href, children }];
}

function inline(node: PhrasingContent, ctx: Context, inLink: boolean): CommentInline[] {
  switch (node.type) {
    case "text":
      return textInlines(node.value, ctx, inLink);
    case "break":
      return [{ type: "break" }];
    case "strong":
      return [{ type: "strong", children: inlines(node.children, ctx, inLink) }];
    case "emphasis":
      return [{ type: "emphasis", children: inlines(node.children, ctx, inLink) }];
    case "delete":
      return [{ type: "strike", children: inlines(node.children, ctx, inLink) }];
    case "inlineCode":
      return [{ type: "code", value: restore(node.value, ctx) }];
    case "link":
      // CommonMark has no link inside a link; were one ever reported, only its label is kept.
      return inLink ? inlines(node.children, ctx, true) : link(node, ctx);
    default:
      return asTyped(node, ctx);
  }
}

function inlines(nodes: readonly PhrasingContent[], ctx: Context, inLink: boolean): CommentInline[] {
  return merged(nodes.flatMap((node) => inline(node, ctx, inLink)));
}

/** A list or a quote with nothing in it at any depth: a lone marker, or a rule typed `- - -`. */
function isEmptyContainer(node: RootContent): boolean {
  if (node.type === "list") return node.children.every((item) => item.children.every(isEmptyContainer));
  if (node.type === "blockquote") return node.children.every(isEmptyContainer);
  return false;
}

function blocks(nodes: readonly RootContent[], ctx: Context): CommentBlock[] {
  const out: CommentBlock[] = [];
  const paragraph = (children: CommentInline[]) => {
    if (children.length > 0) out.push({ type: "paragraph", children });
  };
  for (const node of nodes) {
    // With rules switched off, `- - -` and `* * *` read as lists inside lists that hold nothing;
    // §44.3 shows a rule as typed. The same goes for a lone `-`, `1.` or `>`. Only on one line:
    // a longer slice of the source could carry an enclosing quote's `>` with it.
    if (isEmptyContainer(node)) {
      const typed = sourceOf(node, ctx);
      if (typed !== undefined && !typed.includes("\n")) {
        paragraph(textInlines(typed, ctx, true));
        continue;
      }
    }
    switch (node.type) {
      case "paragraph":
        paragraph(inlines(node.children, ctx, false));
        break;
      case "code":
        out.push({ type: "codeBlock", value: restore(node.value, ctx) });
        break;
      case "blockquote":
        out.push({ type: "quote", children: blocks(node.children, ctx) });
        break;
      case "list":
        out.push({
          type: "list",
          ordered: node.ordered === true,
          start: node.ordered === true ? (node.start ?? 1) : null,
          items: node.children.map((item) => blocks(item.children, ctx)),
        });
        break;
      default:
        paragraph(asTyped(node, ctx));
    }
  }
  return out;
}

/**
 * How many lists, quotes and formatting marks may sit inside one another. Nothing a person writes
 * by hand comes near it; a comment made of thousands of nested markers does, and a tree that deep
 * could exhaust the stack of whatever walks it. Past the limit the comment is shown as plain text.
 */
export const COMMENT_MAX_NESTING = 32;

const NESTING: ReadonlySet<string> = new Set(["list", "blockquote", "strong", "emphasis", "delete", "link"]);

/** Walked with a list of its own, not by recursion: this is the check that guards the recursion. */
function nestsTooDeep(root: Nodes): boolean {
  const pending: [Nodes, number][] = [[root, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, outside] = next;
    const depth = NESTING.has(node.type) ? outside + 1 : outside;
    if (depth > COMMENT_MAX_NESTING) return true;
    if ("children" in node) for (const child of node.children as readonly Nodes[]) pending.push([child, depth]);
  }
  return false;
}

/**
 * The cheap form of the same limit, taken BEFORE the parser runs: a line that opens more lists and
 * quotes than `COMMENT_MAX_NESTING` (`> > > …`, `- - - …`). The parser's own work on thousands of
 * nested markers is what costs a reader's browser time, so such a comment never reaches it. One
 * pass over each line, no backtracking.
 */
function opensTooManyContainers(source: string): boolean {
  for (const line of source.split("\n")) {
    let markers = 0;
    let i = 0;
    while (i < line.length) {
      const ch = line.charAt(i);
      // A list marker opens a list only when white space (or the line's end) follows it; a row of
      // dashes or asterisks typed as a separator opens nothing and is not counted.
      const opens = (at: number) => at >= line.length || line.charAt(at) === " " || line.charAt(at) === "\t";
      if (ch === " " || ch === "\t") {
        i += 1;
      } else if (ch === ">") {
        markers += 1;
        i += 1;
      } else if (ch === "-" || ch === "*" || ch === "+") {
        if (!opens(i + 1)) break;
        markers += 1;
        i += 1;
      } else if (ch >= "0" && ch <= "9") {
        let end = i;
        while (end < line.length && line.charAt(end) >= "0" && line.charAt(end) <= "9") end += 1;
        const after = line.charAt(end);
        if ((after !== "." && after !== ")") || !opens(end + 1)) break;
        markers += 1;
        i = end + 1;
      } else {
        break;
      }
      if (markers > COMMENT_MAX_NESTING) return true;
    }
  }
  return false;
}

/** No Markdown at all: paragraphs on blank lines, line breaks kept, mentions in place. */
function plainBlocks(ctx: Context): CommentBlock[] {
  return ctx.source
    .split(/\n{2,}/)
    .filter((part) => part.trim() !== "")
    .map((part): CommentBlock => ({ type: "paragraph", children: textInlines(part, ctx, false) }));
}

/**
 * §44.3: a comment's display text as a tree. `mentions` are the ranges of the text that are
 * mentions (as the API reports them, or as binding finds them in the Preview tab); each is one
 * unit to the parser — formatting can wrap it, but no character of a name is read as Markdown.
 * A range that does not fit the text is ignored. Never throws: text the parser cannot take, or
 * that nests deeper than `COMMENT_MAX_NESTING`, is returned as plain paragraphs.
 */
export function parseCommentMarkdown(text: string, mentions: readonly CommentMentionRange[] = []): CommentBlock[] {
  const ctx = prepare(typeof text === "string" ? text : "", Array.isArray(mentions) ? mentions : []);
  try {
    if (opensTooManyContainers(ctx.source)) return plainBlocks(ctx);
    const tree = fromMarkdown(ctx.source, PARSER);
    return nestsTooDeep(tree) ? plainBlocks(ctx) : blocks(tree.children, ctx);
  } catch {
    return plainBlocks(ctx);
  }
}
