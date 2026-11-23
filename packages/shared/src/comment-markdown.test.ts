// §44.3 / §44.4 — the comment parser and the link rule: every row of the Markdown table, nesting,
// each unsupported construct shown as typed, line breaks, escapes, mentions as one unit, and what
// may and may not become a link.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMENT_LINK_REL,
  COMMENT_LINK_TARGET,
  COMMENT_MAX_NESTING,
  commentLinkHref,
  parseCommentMarkdown,
  type CommentBlock,
  type CommentInline,
  type CommentMentionRange,
} from "./comment-markdown.js";

const md = parseCommentMarkdown;

// The expected tree, written the way the comment reads.
const text = (value: string): CommentInline => ({ type: "text", value });
const br: CommentInline = { type: "break" };
const strong = (...children: CommentInline[]): CommentInline => ({ type: "strong", children });
const em = (...children: CommentInline[]): CommentInline => ({ type: "emphasis", children });
const strike = (...children: CommentInline[]): CommentInline => ({ type: "strike", children });
const code = (value: string): CommentInline => ({ type: "code", value });
const link = (href: string, ...children: CommentInline[]): CommentInline => ({ type: "link", href, children });
/** A bare address: it reads in full, as typed. */
const bare = (href: string, typed: string): CommentInline => link(href, text(typed));
const mention = (index: number, covered: string): CommentInline => ({ type: "mention", index, text: covered });
const p = (...children: CommentInline[]): CommentBlock => ({ type: "paragraph", children });
const codeBlock = (value: string): CommentBlock => ({ type: "codeBlock", value });
const ul = (...items: CommentBlock[][]): CommentBlock => ({ type: "list", ordered: false, start: null, items });
const ol = (start: number, ...items: CommentBlock[][]): CommentBlock => ({ type: "list", ordered: true, start, items });
const quote = (...children: CommentBlock[]): CommentBlock => ({ type: "quote", children });
/** Shown as typed: one paragraph holding exactly these characters. */
const typed = (value: string): CommentBlock[] => [p(text(value))];

/** The ranges of the given "@Name"s, each found after the one before it. */
function at(value: string, ...names: string[]): CommentMentionRange[] {
  let from = 0;
  return names.map((name) => {
    const start = value.indexOf(name, from);
    assert.notEqual(start, -1, `"${name}" is in the text`);
    from = start + name.length;
    return { start, length: name.length };
  });
}

/** Every string a tree holds — what a reader could be shown, and every address a link opens. */
function strings(blocks: readonly CommentBlock[]): string[] {
  const out: string[] = [];
  const inline = (node: CommentInline): void => {
    if (node.type === "text" || node.type === "code") out.push(node.value);
    else if (node.type === "mention") out.push(node.text);
    else if (node.type !== "break") {
      if (node.type === "link") out.push(node.href);
      node.children.forEach(inline);
    }
  };
  const block = (node: CommentBlock): void => {
    if (node.type === "paragraph") node.children.forEach(inline);
    else if (node.type === "codeBlock") out.push(node.value);
    else if (node.type === "quote") node.children.forEach(block);
    else node.items.forEach((item) => item.forEach(block));
  };
  blocks.forEach(block);
  return out;
}

function links(blocks: readonly CommentBlock[]): string[] {
  const out: string[] = [];
  const inline = (node: CommentInline): void => {
    if (node.type === "link") out.push(node.href);
    if ("children" in node) node.children.forEach(inline);
  };
  const block = (node: CommentBlock): void => {
    if (node.type === "paragraph") node.children.forEach(inline);
    else if (node.type === "quote") node.children.forEach(block);
    else if (node.type === "list") node.items.forEach((item) => item.forEach(block));
  };
  blocks.forEach(block);
  return out;
}

// ── §44.3 "What renders" — one test per row of the table ────────────────────────────────────────

test("**text** and __text__ are bold", () => {
  assert.deepEqual(md("**bold** and __bold__"), [p(strong(text("bold")), text(" and "), strong(text("bold")))]);
  assert.deepEqual(md("in the **middle** of it"), [p(text("in the "), strong(text("middle")), text(" of it"))]);
});

test("*text* and _text_ are italic", () => {
  assert.deepEqual(md("*slanted* and _slanted_"), [p(em(text("slanted")), text(" and "), em(text("slanted")))]);
  assert.deepEqual(md("snake_case_name stays"), typed("snake_case_name stays"), "an underscore inside a word is not italic");
});

test("~~text~~ is strikethrough, and a single tilde is not", () => {
  assert.deepEqual(md("~~gone~~ but ~kept~"), [p(strike(text("gone")), text(" but ~kept~"))]);
  assert.deepEqual(md("about ~5 minutes"), typed("about ~5 minutes"));
});

test("`text` is inline code, and nothing inside it is read as Markdown", () => {
  assert.deepEqual(md("run `pnpm test` now"), [p(text("run "), code("pnpm test"), text(" now"))]);
  assert.deepEqual(md("`**x** <b> \\* [a](https://example.com)`"), [p(code("**x** <b> \\* [a](https://example.com)"))]);
  assert.deepEqual(md("``a ` b``"), [p(code("a ` b"))], "a longer fence holds a backtick");
  assert.deepEqual(md("`one\ntwo`"), [p(code("one\ntwo"))], "a line break inside it stays in the value");
});

test("lines between two ``` lines are a code block: spaces and line breaks kept, the language dropped", () => {
  assert.deepEqual(md("```ts\nconst a = 1;\n    indented **not bold**\n\n# not a heading\n```"), [
    codeBlock("const a = 1;\n    indented **not bold**\n\n# not a heading"),
  ]);
  assert.deepEqual(md("before\n```\ncode\n```\nafter"), [p(text("before")), codeBlock("code"), p(text("after"))]);
  assert.deepEqual(md("~~~\ntilde fence\n~~~"), [codeBlock("tilde fence")]);
  assert.deepEqual(md("```\nnever closed\n**still code**"), [codeBlock("never closed\n**still code**")]);
  assert.deepEqual(md("```\n```"), [codeBlock("")], "an empty block is still a block");
});

test("lines starting '- ' or '* ' are a bullet list", () => {
  const list = [ul([p(text("one"))], [p(text("two"))], [p(text("three"))])];
  assert.deepEqual(md("- one\n- two\n- three"), list);
  assert.deepEqual(md("* one\n* two\n* three"), list);
  assert.deepEqual(md("intro\n- one\n- two"), [p(text("intro")), ul([p(text("one"))], [p(text("two"))])]);
});

test("lines starting '1. ', '2. ' … are a numbered list that starts at its first number", () => {
  assert.deepEqual(md("1. one\n2. two"), [ol(1, [p(text("one"))], [p(text("two"))])]);
  assert.deepEqual(md("3. three\n4. four\n5. five"), [ol(3, [p(text("three"))], [p(text("four"))], [p(text("five"))])]);
  assert.deepEqual(md("7. seven\n7. also"), [ol(7, [p(text("seven"))], [p(text("also"))])], "only the first number counts");
});

test("lines starting '> ' are a quote", () => {
  assert.deepEqual(md("> quoted"), [quote(p(text("quoted")))]);
  assert.deepEqual(md("> first\n> second\n\nreply"), [quote(p(text("first"), br, text("second"))), p(text("reply"))]);
});

test("[text](address) and a bare address are links", () => {
  assert.deepEqual(md("[the docs](https://example.com/docs) and https://example.com/x"), [
    p(link("https://example.com/docs", text("the docs")), text(" and "), bare("https://example.com/x", "https://example.com/x")),
  ]);
});

test("a backslash before a Markdown character gives that character, not formatting", () => {
  assert.deepEqual(md("\\*not italic\\* \\_nor this\\_ \\*\\*nor bold\\*\\*"), typed("*not italic* _nor this_ **nor bold**"));
  assert.deepEqual(md("\\**italic, after a star*"), [p(text("*"), em(text("italic, after a star")))], "only the escaped one");
  assert.deepEqual(md("\\`code\\` \\[label](address) \\~~kept\\~~"), typed("`code` [label](address) ~~kept~~"));
  assert.deepEqual(md("\\- not a list"), typed("- not a list"));
  assert.deepEqual(md("1\\. not a list"), typed("1. not a list"));
  assert.deepEqual(md("\\> not a quote"), typed("> not a quote"));
  assert.deepEqual(md("a \\\\ b"), typed("a \\ b"), "an escaped backslash is one backslash");
  assert.deepEqual(md("C:\\Users\\ana"), typed("C:\\Users\\ana"), "a backslash before a letter stays");
  assert.deepEqual(md("\\`\\`\\`\nnot code\n\\`\\`\\`"), [p(text("```"), br, text("not code"), br, text("```"))]);
});

// ── Nesting ─────────────────────────────────────────────────────────────────────────────────────

test("lists nest, and an ordered list may sit in a bullet list", () => {
  assert.deepEqual(md("- a\n  - b\n    - c\n- d"), [
    ul([p(text("a")), ul([p(text("b")), ul([p(text("c"))])])], [p(text("d"))]),
  ]);
  assert.deepEqual(md("- fruit\n  1. apple\n  2. pear\n- veg"), [
    ul([p(text("fruit")), ol(1, [p(text("apple"))], [p(text("pear"))])], [p(text("veg"))]),
  ]);
  assert.deepEqual(md("2. b\n   - c\n   - d"), [ol(2, [p(text("b")), ul([p(text("c"))], [p(text("d"))])])]);
});

test("a quote may hold a list, a code block and another quote", () => {
  assert.deepEqual(md("> - one\n> - two\n>\n> after"), [
    quote(ul([p(text("one"))], [p(text("two"))]), p(text("after"))),
  ]);
  assert.deepEqual(md("> ```\n> a\n>  b\n> ```"), [quote(codeBlock("a\n b"))]);
  assert.deepEqual(md("> outer\n> > inner"), [quote(p(text("outer")), quote(p(text("inner"))))]);
});

test("a list item may hold a quote, a code block and a second paragraph", () => {
  assert.deepEqual(md("1. step\n   > note\n\n   ```\n   code\n   ```\n\n   done"), [
    ol(1, [p(text("step")), quote(p(text("note"))), codeBlock("code"), p(text("done"))]),
  ]);
});

test("lists and quotes hold the inline formatting, and formatting nests", () => {
  assert.deepEqual(md("- **bold** and `code`\n- [link](https://example.com/a) ~~old~~"), [
    ul(
      [p(strong(text("bold")), text(" and "), code("code"))],
      [p(link("https://example.com/a", text("link")), text(" "), strike(text("old")))],
    ),
  ]);
  assert.deepEqual(md("> *quoted* https://example.com/q"), [
    quote(p(em(text("quoted")), text(" "), bare("https://example.com/q", "https://example.com/q"))),
  ]);
  assert.deepEqual(md("*a **b** ~~c~~ `d`*"), [
    p(em(text("a "), strong(text("b")), text(" "), strike(text("c")), text(" "), code("d"))),
  ]);
  assert.deepEqual(md("***both***"), [p(em(strong(text("both"))))]);
});

// ── §44.3 "What does not" — shown as typed ──────────────────────────────────────────────────────

test("a heading is shown as typed", () => {
  assert.deepEqual(md("# Title"), typed("# Title"));
  assert.deepEqual(md("## Section\nbody"), [p(text("## Section"), br, text("body"))]);
  assert.deepEqual(md("Title\n====="), [p(text("Title"), br, text("====="))], "an underlined heading");
  assert.deepEqual(md("Title\n---"), [p(text("Title"), br, text("---"))]);
});

test("a table is shown as typed", () => {
  assert.deepEqual(md("| a | b |\n|---|---|\n| 1 | 2 |"), [
    p(text("| a | b |"), br, text("|---|---|"), br, text("| 1 | 2 |")),
  ]);
});

test("an image is an exclamation mark followed by an ordinary link", () => {
  assert.deepEqual(md("![chart](https://example.com/chart.png)"), [
    p(text("!"), link("https://example.com/chart.png", text("chart"))),
  ]);
  assert.deepEqual(md("![chart](data:image/png;base64,AAAA)"), typed("![chart](data:image/png;base64,AAAA)"));
});

test("a horizontal rule is shown as typed", () => {
  for (const rule of ["---", "***", "___", "- - -", "* * *", "_ _ _", "----------"]) {
    assert.deepEqual(md(rule), typed(rule), rule);
  }
  assert.deepEqual(md("above\n\n---\n\nbelow"), [p(text("above")), p(text("---")), p(text("below"))]);
  assert.deepEqual(md("- a\n- - -\n- b"), [ul([p(text("a"))], [p(text("- -"))], [p(text("b"))])], "inside a list");
});

test("a list marker or a quote mark with nothing after it is shown as typed", () => {
  for (const lone of ["-", "*", "1.", ">", "> -"]) assert.deepEqual(md(lone), typed(lone), lone);
  assert.deepEqual(md("-\n-"), [ul([], [])], "over several lines it stays a list of empty items");
});

test("a task list is a bullet list whose boxes are shown as typed", () => {
  assert.deepEqual(md("- [ ] to do\n- [x] done"), [ul([p(text("[ ] to do"))], [p(text("[x] done"))])]);
});

test("raw HTML is shown as typed", () => {
  assert.deepEqual(md("<b>bold</b>"), typed("<b>bold</b>"));
  assert.deepEqual(md("a <script>alert(1)</script> b"), typed("a <script>alert(1)</script> b"));
  assert.deepEqual(md('<img src=x onerror="alert(1)">'), typed('<img src=x onerror="alert(1)">'));
  assert.deepEqual(md("<!-- hidden -->"), typed("<!-- hidden -->"));
  assert.deepEqual(md("<div>\nblock\n</div>"), [p(text("<div>"), br, text("block"), br, text("</div>"))]);
  assert.deepEqual(md("<b>**bold**</b>"), [p(text("<b>"), strong(text("bold")), text("</b>"))], "Markdown around it still reads");
});

test("indented text is a paragraph, not code", () => {
  assert.deepEqual(md("    four spaces"), typed("four spaces"));
  assert.deepEqual(md("\tone tab"), typed("one tab"));
  assert.deepEqual(md("text\n\n    indented **bold**\n\nmore"), [
    p(text("text")),
    p(text("indented "), strong(text("bold"))),
    p(text("more")),
  ]);
});

test("a character reference is shown as typed", () => {
  assert.deepEqual(md("&amp; &lt;b&gt; &#35; &#x1F600; &copy;"), typed("&amp; &lt;b&gt; &#35; &#x1F600; &copy;"));
  assert.deepEqual(md("[x](https://example.com/?a=1&amp;b=2)"), [p(link("https://example.com/?a=1&amp;b=2", text("x")))]);
});

test("a reference definition, a reference link and a footnote are shown as typed", () => {
  assert.deepEqual(md("[docs]: /somewhere\n\nSee [docs] and [the docs][docs]."), [
    p(text("[docs]: /somewhere")),
    p(text("See [docs] and [the docs][docs].")),
  ]);
  assert.deepEqual(md("[docs]: https://example.com/d"), [
    p(text("[docs]: "), bare("https://example.com/d", "https://example.com/d")),
  ]);
  assert.deepEqual(md("Text[^1]\n\n[^1]: The note."), [p(text("Text[^1]")), p(text("[^1]: The note."))]);
});

// ── Line breaks ─────────────────────────────────────────────────────────────────────────────────

test("a line break is a line break", () => {
  assert.deepEqual(md("one\ntwo\nthree"), [p(text("one"), br, text("two"), br, text("three"))]);
  assert.deepEqual(md("one  \ntwo"), [p(text("one"), br, text("two"))], "two spaces before it");
  assert.deepEqual(md("one\\\ntwo"), [p(text("one"), br, text("two"))], "a backslash before it");
  assert.deepEqual(md("**one\ntwo**"), [p(strong(text("one"), br, text("two")))], "inside formatting");
  assert.deepEqual(md("- one\n  two"), [ul([p(text("one"), br, text("two"))])], "inside a list item");
});

test("a blank line starts a new paragraph, and several count as one", () => {
  assert.deepEqual(md("one\n\ntwo"), [p(text("one")), p(text("two"))]);
  assert.deepEqual(md("one\n\n\n\n\ntwo"), [p(text("one")), p(text("two"))]);
  assert.deepEqual(md("one\n  \n\t\ntwo"), [p(text("one")), p(text("two"))], "lines of white space are blank");
  assert.deepEqual(md("\n\none\n\n"), [p(text("one"))], "at the start and the end");
  assert.deepEqual(md(""), []);
  assert.deepEqual(md(" \n\n \n"), []);
});

test("Windows and old Mac line breaks read as line breaks", () => {
  assert.deepEqual(md("one\r\ntwo\r\n\r\nthree"), [p(text("one"), br, text("two")), p(text("three"))]);
  assert.deepEqual(md("one\rtwo"), [p(text("one"), br, text("two"))]);
  assert.deepEqual(md("```\r\na\r\nb\r\n```"), [codeBlock("a\nb")]);
  assert.deepEqual(md("- one\r\n- two"), [ul([p(text("one"))], [p(text("two"))])]);
  // A mention's range counts the characters of the text as it was handed over.
  const body = "one\r\ntwo @Ana Petrova\r\n\r\nthree";
  assert.deepEqual(md(body, at(body, "@Ana Petrova")), [
    p(text("one"), br, text("two "), mention(0, "@Ana Petrova")),
    p(text("three")),
  ]);
});

// ── Mentions ────────────────────────────────────────────────────────────────────────────────────

test("a mention is one node carrying its index and the text it covers", () => {
  const body = "Thanks @Ana Petrova and @Bob Ivanov!";
  assert.deepEqual(md(body, at(body, "@Ana Petrova", "@Bob Ivanov")), [
    p(text("Thanks "), mention(0, "@Ana Petrova"), text(" and "), mention(1, "@Bob Ivanov"), text("!")),
  ]);
  assert.deepEqual(md(body), typed(body), "with no ranges the same text is plain");
  assert.deepEqual(md("@Ana Petrova", at("@Ana Petrova", "@Ana Petrova")), [p(mention(0, "@Ana Petrova"))]);
});

test("formatting can wrap a mention", () => {
  const body = "**@Ana Petrova** _@Bob Ivanov_ ~~@Cy Young~~ *ask @Dee Lin today*";
  assert.deepEqual(md(body, at(body, "@Ana Petrova", "@Bob Ivanov", "@Cy Young", "@Dee Lin")), [
    p(
      strong(mention(0, "@Ana Petrova")),
      text(" "),
      em(mention(1, "@Bob Ivanov")),
      text(" "),
      strike(mention(2, "@Cy Young")),
      text(" "),
      em(text("ask "), mention(3, "@Dee Lin"), text(" today")),
    ),
  ]);
});

test("a mention sits in a list item and in a quote", () => {
  const body = "- @Ana Petrova first\n\n> @Bob Ivanov said";
  assert.deepEqual(md(body, at(body, "@Ana Petrova", "@Bob Ivanov")), [
    ul([p(mention(0, "@Ana Petrova"), text(" first"))]),
    quote(p(mention(1, "@Bob Ivanov"), text(" said"))),
  ]);
});

test("inside inline code and a code block a mention is the plain name", () => {
  const inline = "see `@Ana Petrova` here";
  assert.deepEqual(md(inline, at(inline, "@Ana Petrova")), [p(text("see "), code("@Ana Petrova"), text(" here"))]);
  const block = "```\nping @Ana Petrova\n```";
  assert.deepEqual(md(block, at(block, "@Ana Petrova")), [codeBlock("ping @Ana Petrova")]);
  const info = "```@Ana Petrova\ncode\n```";
  assert.deepEqual(md(info, at(info, "@Ana Petrova")), [codeBlock("code")], "in the dropped language name");
});

test("inside a link's label or address a mention is plain text", () => {
  const label = "[ask @Ana Petrova](https://example.com/a)";
  assert.deepEqual(md(label, at(label, "@Ana Petrova")), [p(link("https://example.com/a", text("ask @Ana Petrova")))]);
  const bold = "[**@Ana Petrova**](https://example.com/a)";
  assert.deepEqual(md(bold, at(bold, "@Ana Petrova")), [p(link("https://example.com/a", strong(text("@Ana Petrova"))))]);
  const address = "[profile](https://example.com/@Ana)";
  assert.deepEqual(md(address, at(address, "@Ana")), [p(link("https://example.com/@Ana", text("profile")))]);
  const bareAddress = "www.example.com/@Ana";
  assert.deepEqual(md(bareAddress, at(bareAddress, "@Ana")), [p(bare("https://www.example.com/@Ana", "www.example.com/@Ana"))]);
  const refused = "[ask @Ana Petrova](javascript:alert(1)) then @Ana Petrova";
  assert.deepEqual(md(refused, at(refused, "@Ana Petrova", "@Ana Petrova")), [
    p(text("[ask @Ana Petrova](javascript:alert(1)) then "), mention(1, "@Ana Petrova")),
  ]);
});

test("no character of a name is read as Markdown", () => {
  const underscore = "Ask @Ana_P* about *it*";
  assert.deepEqual(md(underscore, at(underscore, "@Ana_P*")), [
    p(text("Ask "), mention(0, "@Ana_P*"), text(" about "), em(text("it"))),
  ]);
  const everything = "Hi @B*b `Iv` [x](https://example.com) **z** <b> there *ok*";
  const name = "@B*b `Iv` [x](https://example.com) **z** <b>";
  assert.deepEqual(md(everything, at(everything, name)), [p(text("Hi "), mention(0, name), text(" there "), em(text("ok")))]);
  const twice = "*@A*a* and @B_b_";
  assert.deepEqual(md(twice, at(twice, "@A*a", "@B_b_")), [p(em(mention(0, "@A*a")), text(" and "), mention(1, "@B_b_"))]);
  const digits = "@Ana Petrova. Thanks\n@Bob Ivanov) too";
  assert.deepEqual(md(digits, at(digits, "@Ana Petrova", "@Bob Ivanov")), [
    p(mention(0, "@Ana Petrova"), text(". Thanks"), br, mention(1, "@Bob Ivanov"), text(") too")),
  ], "a mention at the start of a line never starts a numbered list");
});

test("a range that does not fit the text is ignored, and the others keep their index", () => {
  const body = "x @Ana Petrova y @Bob Ivanov";
  const ana = { start: 2, length: 12 };
  const bob = { start: 17, length: 11 };
  const expected = (anaIndex: number, bobIndex: number) => [
    p(text("x "), mention(anaIndex, "@Ana Petrova"), text(" y "), mention(bobIndex, "@Bob Ivanov")),
  ];
  assert.deepEqual(md(body, [ana, bob]), expected(0, 1));
  assert.deepEqual(md(body, [bob, ana]), expected(1, 0), "the order of the ranges does not matter");
  assert.deepEqual(md(body, [{ start: 99, length: 4 }, ana, { start: 20, length: 50 }, bob]), expected(1, 3), "past the end");
  assert.deepEqual(md(body, [{ start: -1, length: 4 }, ana, bob]), expected(1, 2), "before the start");
  assert.deepEqual(md(body, [{ start: 3, length: 4 }, ana, { start: 0, length: 1 }, bob]), expected(1, 3), "not at an @");
  assert.deepEqual(md(body, [{ start: 2, length: 1 }, { start: 2, length: 0 }, ana, bob]), expected(2, 3), "only the @");
  assert.deepEqual(md(body, [{ start: 2.5, length: 3 }, { start: 2, length: Number.NaN }, ana, bob]), expected(2, 3));
});

test("of two ranges that overlap, the one listed first stands", () => {
  const body = "x @Ana Petrova y";
  assert.deepEqual(md(body, [{ start: 2, length: 12 }, { start: 2, length: 4 }]), [
    p(text("x "), mention(0, "@Ana Petrova"), text(" y")),
  ]);
  assert.deepEqual(md(body, [{ start: 2, length: 4 }, { start: 2, length: 12 }]), [
    p(text("x "), mention(0, "@Ana"), text(" Petrova y")),
  ]);
  assert.deepEqual(md(body, [{ start: 2, length: 12 }, { start: 2, length: 12 }]), [
    p(text("x "), mention(0, "@Ana Petrova"), text(" y")),
  ], "the same range twice");
  const nested = "@Ana @Bob";
  assert.deepEqual(md(nested, [{ start: 0, length: 9 }, { start: 5, length: 4 }]), [p(mention(0, "@Ana @Bob"))]);
});

test("U+E000 and U+E001 in the text are removed, so the text cannot forge a mention", () => {
  // What a placeholder would look like, typed by hand.
  assert.deepEqual(md("\uE0000\uE001 hello"), typed("0 hello"));
  assert.deepEqual(md("**\uE000bold\uE001**"), [p(strong(text("bold")))]);
  // A real mention after them still lands on its "@": the range counts the removed characters.
  const body = "\uE0000\uE001 said @Ana Petrova, \uE0001\uE001";
  assert.deepEqual(md(body, at(body, "@Ana Petrova")), [p(text("0 said "), mention(0, "@Ana Petrova"), text(", 1"))]);
  // Inside the covered text they are dropped as well.
  const inside = "@Ana\uE000 Petrova";
  assert.deepEqual(md(inside, [{ start: 0, length: inside.length }]), [p(mention(0, "@Ana Petrova"))]);
  // Where a placeholder is turned back into text rather than into a mention.
  assert.deepEqual(md("`\uE0000\uE001`"), [p(code("0"))]);
  assert.deepEqual(md("```\n\uE0000\uE001\n```"), [codeBlock("0")]);
  assert.deepEqual(md("[\uE0000\uE001](javascript:\uE0000\uE001)"), typed("[0](javascript:0)"));
  // Neither mark ever comes back out.
  const samples: [string, CommentMentionRange[]][] = [
    [body, at(body, "@Ana Petrova")],
    [inside, [{ start: 0, length: inside.length }]],
    ["`\uE0000\uE001` [\uE0000\uE001](https://example.com/\uE0000\uE001) www.example.com/\uE001\uE000", []],
    ["> \uE000\n\n- \uE001\n\n```\uE000\n\uE0001\uE001\n```", []],
  ];
  for (const [sample, ranges] of samples) {
    for (const value of strings(md(sample, ranges))) assert.doesNotMatch(value, /[\uE000\uE001]/, JSON.stringify(sample));
  }
});

// ── §44.4 Links ─────────────────────────────────────────────────────────────────────────────────

test("a bare http or https address is a link that reads as typed", () => {
  assert.deepEqual(md("http://example.com/a"), [p(bare("http://example.com/a", "http://example.com/a"))]);
  assert.deepEqual(md("go to https://example.com/a?b=1&c=2#d now"), [
    p(text("go to "), bare("https://example.com/a?b=1&c=2#d", "https://example.com/a?b=1&c=2#d"), text(" now")),
  ]);
  assert.deepEqual(md("HTTPS://EXAMPLE.COM/Path"), [p(bare("https://example.com/Path", "HTTPS://EXAMPLE.COM/Path"))]);
  assert.deepEqual(md("<https://example.com/a>"), [p(bare("https://example.com/a", "https://example.com/a"))]);
  assert.deepEqual(md("**https://example.com/a**"), [p(strong(bare("https://example.com/a", "https://example.com/a")))]);
});

test("a bare www. address is a link opened over https", () => {
  assert.deepEqual(md("www.example.com"), [p(bare("https://www.example.com/", "www.example.com"))]);
  assert.deepEqual(md("see www.example.com/docs?x=1 today"), [
    p(text("see "), bare("https://www.example.com/docs?x=1", "www.example.com/docs?x=1"), text(" today")),
  ]);
  assert.deepEqual(md("WWW.Example.com"), [p(bare("https://www.example.com/", "WWW.Example.com"))]);
  assert.deepEqual(md("note.www.example.com"), [p(text("note."), bare("https://www.example.com/", "www.example.com"))]);
  // Only a bare one: an address typed with http keeps it.
  assert.deepEqual(md("http://www.example.com"), [p(bare("http://www.example.com/", "http://www.example.com"))]);
  assert.deepEqual(md("[www.example.com](http://www.example.com)"), [
    p(link("http://www.example.com/", text("www.example.com"))),
  ]);
});

test("punctuation that ends a sentence after a bare address is not part of it", () => {
  const a = "https://example.com/a";
  assert.deepEqual(md(`See ${a}.`), [p(text("See "), bare(a, a), text("."))]);
  assert.deepEqual(md(`Is it ${a}?`), [p(text("Is it "), bare(a, a), text("?"))]);
  assert.deepEqual(md(`Wow ${a}!`), [p(text("Wow "), bare(a, a), text("!"))]);
  assert.deepEqual(md(`First ${a}, then ${a}; done: ${a}:`), [
    p(text("First "), bare(a, a), text(", then "), bare(a, a), text("; done: "), bare(a, a), text(":")),
  ]);
  assert.deepEqual(md(`(${a})`), [p(text("("), bare(a, a), text(")"))]);
  assert.deepEqual(md(`"${a}"`), [p(text('"'), bare(a, a), text('"'))]);
  assert.deepEqual(md("www.example.com."), [p(bare("https://www.example.com/", "www.example.com"), text("."))]);
  assert.deepEqual(md("https://example.com/a_(b)"), [p(bare("https://example.com/a_(b)", "https://example.com/a_(b)"))], "a balanced bracket stays");
});

test("a labelled link takes an absolute http or https address", () => {
  assert.deepEqual(md("[docs](https://example.com/docs)"), [p(link("https://example.com/docs", text("docs")))]);
  assert.deepEqual(md("[docs](http://example.com/docs)"), [p(link("http://example.com/docs", text("docs")))]);
  assert.deepEqual(md('[docs](https://example.com/docs "A title")'), [p(link("https://example.com/docs", text("docs")))], "a title is ignored");
  assert.deepEqual(md("[docs](<https://example.com/a b>)"), [p(link("https://example.com/a%20b", text("docs")))]);
  assert.deepEqual(md("[**bold** and `code`](https://example.com/a)"), [
    p(link("https://example.com/a", strong(text("bold")), text(" and "), code("code"))),
  ]);
});

test("a link's label never holds another link", () => {
  assert.deepEqual(md("[https://safe.example/x](https://other.example/y)"), [
    p(link("https://other.example/y", text("https://safe.example/x"))),
  ]);
  assert.deepEqual(md("[www.safe.example and ana@example.com](https://other.example/y)"), [
    p(link("https://other.example/y", text("www.safe.example and ana@example.com"))),
  ]);
});

const REFUSED = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html,<b>x</b>",
  "file:///etc/passwd",
  "mailto:ana@example.com",
  "tel:+15550100",
  "sms:+15550100",
  "ftp://example.com/file",
  "/challenges/12",
  "../up",
  "page.html",
  "#comment-5",
  "?q=1",
  "//example.com/x",
  "http:example.com",
  "https:/example.com",
  "example.com",
];

test("a labelled link with any other address is shown as typed", () => {
  for (const address of REFUSED) {
    const source = `[label](${address})`;
    assert.deepEqual(md(source), typed(source), source);
    assert.deepEqual(md(`a ${source} b`), typed(`a ${source} b`), source);
  }
  assert.deepEqual(md("[**bold** label](javascript:alert(1))"), typed("[**bold** label](javascript:alert(1))"), "its label too");
  assert.deepEqual(md("[two\nlines](mailto:ana@example.com)"), [p(text("[two"), br, text("lines](mailto:ana@example.com)"))]);
  assert.deepEqual(md('[x](javascript:alert(1) "https://example.com")'), typed('[x](javascript:alert(1) "https://example.com")'));
  assert.deepEqual(md("[](https://example.com/a)"), typed("[](https://example.com/a)"), "nothing to click on");
});

test("a bare address with any other scheme is not a link", () => {
  for (const address of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "tel:+15550100", "ftp://example.com/file", "/challenges/12", "example.com/path"]) {
    assert.deepEqual(md(`open ${address} now`), typed(`open ${address} now`), address);
  }
  assert.deepEqual(md("<javascript:alert(1)>"), typed("<javascript:alert(1)>"));
  assert.deepEqual(md("<ftp://example.com/file> <tel:+15550100>"), typed("<ftp://example.com/file> <tel:+15550100>"));
});

test("an e-mail address is not a link", () => {
  assert.deepEqual(md("Write to ana@example.com today."), typed("Write to ana@example.com today."));
  assert.deepEqual(md("mailto:ana@example.com"), typed("mailto:ana@example.com"));
  assert.deepEqual(md("<ana@example.com> and <mailto:ana@example.com>"), typed("<ana@example.com> and <mailto:ana@example.com>"));
  assert.deepEqual(md("**ana.petrova+box@mail.example.com**"), [p(strong(text("ana.petrova+box@mail.example.com")))]);
});

test("an address inside inline code or a code block is not a link", () => {
  assert.deepEqual(md("`https://example.com/a` and `www.example.com`"), [
    p(code("https://example.com/a"), text(" and "), code("www.example.com")),
  ]);
  assert.deepEqual(md("```\nhttps://example.com/a\n[x](https://example.com/b)\n```"), [
    codeBlock("https://example.com/a\n[x](https://example.com/b)"),
  ]);
});

test("CH-12 and SOL-34 are ordinary text", () => {
  assert.deepEqual(md("See CH-12 and SOL-34."), typed("See CH-12 and SOL-34."));
});

test("every link a comment yields opens an http or https address", () => {
  const body = [
    "https://example.com/a www.example.com [b](http://example.com/b) ![c](https://example.com/c.png) <https://example.com/d>",
    ...REFUSED.map((address) => `[x](${address}) <${address}> ${address}`),
    "- [e](https://example.com/e)\n\n> www.example.com/f",
  ].join("\n\n");
  const hrefs = links(md(body));
  assert.deepEqual(hrefs, [
    "https://example.com/a",
    "https://www.example.com/",
    "http://example.com/b",
    "https://example.com/c.png",
    "https://example.com/d",
    "https://example.com/e",
    "https://www.example.com/f",
  ]);
  for (const href of hrefs) assert.equal(commentLinkHref(href), href);
});

test("the link rule: only an absolute http or https address, www. over https", () => {
  assert.equal(commentLinkHref("https://example.com"), "https://example.com/");
  assert.equal(commentLinkHref("http://example.com/a?b=c#d"), "http://example.com/a?b=c#d");
  assert.equal(commentLinkHref("  https://example.com/x  "), "https://example.com/x");
  assert.equal(commentLinkHref("HTTPS://EXAMPLE.COM/Path"), "https://example.com/Path");
  assert.equal(commentLinkHref("www.example.com"), "https://www.example.com/");
  assert.equal(commentLinkHref("WWW.Example.com/a"), "https://www.example.com/a");
  assert.equal(commentLinkHref("https://example.com:8443/a b"), "https://example.com:8443/a%20b");
  for (const address of [...REFUSED, "ana@example.com", "", "   ", "https://", "wwwexample.com", " javascript:alert(1)", "java\nscript:alert(1)"]) {
    assert.equal(commentLinkHref(address), null, JSON.stringify(address));
  }
});

test("every link opens in a new tab, with no opener and no referrer", () => {
  assert.equal(COMMENT_LINK_TARGET, "_blank");
  assert.equal(COMMENT_LINK_REL, "noopener noreferrer");
});

// ── Odds and ends ───────────────────────────────────────────────────────────────────────────────

test("neighbouring pieces of text come back as one text node", () => {
  // Three pieces to the parser: text, a refused e-mail link, text.
  assert.deepEqual(md("a b@example.com c"), [p(text("a b@example.com c"))]);
  assert.deepEqual(md("x \\* [y](/z) \\* w"), [p(text("x * [y](/z) * w"))]);
});

test("a comment nested past the limit is shown as plain text, with its line breaks and mentions", () => {
  const deep = (levels: number) => `${"> ".repeat(levels)}x`;
  let tree = md(deep(COMMENT_MAX_NESTING));
  for (let level = 0; level < COMMENT_MAX_NESTING; level++) {
    const [only] = tree;
    assert.equal(tree.length, 1);
    assert.equal(only?.type, "quote", `level ${level}`);
    tree = only?.type === "quote" ? only.children : [];
  }
  assert.deepEqual(tree, typed("x"));

  assert.deepEqual(md(deep(COMMENT_MAX_NESTING + 1)), typed(deep(COMMENT_MAX_NESTING + 1)));
  const lists = `${"- ".repeat(COMMENT_MAX_NESTING + 1)}x`;
  assert.deepEqual(md(lists), typed(lists));

  const body = `${deep(COMMENT_MAX_NESTING + 1)}\nsecond **line**\n\n\n@Ana Petrova [x](https://example.com)`;
  assert.deepEqual(md(body, at(body, "@Ana Petrova")), [
    p(text(deep(COMMENT_MAX_NESTING + 1)), br, text("second **line**")),
    p(mention(0, "@Ana Petrova"), text(" [x](https://example.com)")),
  ]);
});

test("the parser never throws", () => {
  const hostile = [
    "*".repeat(3000),
    "_".repeat(3000),
    "[".repeat(3000),
    "]".repeat(3000),
    "[a](".repeat(700),
    "`".repeat(3000),
    "~".repeat(3000),
    "> ".repeat(400),
    "- ".repeat(400),
    "1. ".repeat(300),
    "*a ".repeat(300) + "b*".repeat(300),
    "\\".repeat(3001),
    "\u0000\uFEFF\uFFFF\uD800 **x** \uDC00",
    "\uFEFF\uFEFF[x](javascript:alert(1)) **y**",
    "<".repeat(1500) + ">".repeat(1500),
    "&".repeat(3000),
    "www.".repeat(700),
    "https://".repeat(400),
    "@".repeat(3000),
    "\n".repeat(3000),
    "```\n".repeat(500),
  ];
  for (const sample of hostile) {
    const mentions = [{ start: 0, length: 2 }, { start: 1, length: 5000 }, { start: sample.length - 2, length: 2 }];
    assert.doesNotThrow(() => md(sample), JSON.stringify(sample.slice(0, 12)));
    assert.doesNotThrow(() => md(sample, mentions), JSON.stringify(sample.slice(0, 12)));
    assert.ok(Array.isArray(md(sample)));
  }
  assert.deepEqual(md("\uFEFF\uFEFF[x](javascript:alert(1)) **y**"), [p(text("[x](javascript:alert(1)) "), strong(text("y")))]);
  // Not what the types allow, but what a caller could still hand over.
  assert.deepEqual(md(undefined as any), []);
  assert.deepEqual(md(null as any, null as any), []);
  assert.deepEqual(md("**x**", [null, "no", { start: "0" }] as any), [p(strong(text("x")))]);
});

test("a labelled link needs an absolute http(s) address — only a bare address may leave the scheme out (§44.4)", () => {
  assert.deepEqual(md("[the docs](www.example.com)"), [p(text("[the docs](www.example.com)"))]);
  assert.deepEqual(md("[the docs](example.com/a)"), [p(text("[the docs](example.com/a)"))]);
  assert.deepEqual(md("[the docs](https://www.example.com)"), [p(link("https://www.example.com/", text("the docs")))]);
  assert.deepEqual(md("www.example.com"), [p(bare("https://www.example.com/", "www.example.com"))]);
});

test("the nesting limit is checked before the parser runs, and a separator line is not nesting", () => {
  // Thousands of nested markers never reach the parser: the answer is plain text, at once.
  for (const marker of ["> ", ">", "- ", "* ", "+ ", "1. ", "1) "]) {
    const hostile = `${marker.repeat(2400)}x`.slice(0, 5000);
    const started = Date.now();
    const tree = md(hostile);
    assert.ok(Date.now() - started < 250, `${JSON.stringify(marker)} is refused cheaply`);
    assert.deepEqual(tree, [p(text(hostile))], JSON.stringify(marker));
  }
  // A row of dashes, asterisks or digits is a separator or a word, not forty nested lists: the rest
  // of the comment keeps its formatting.
  for (const row of ["-".repeat(40), "*".repeat(40), "=".repeat(40), "1".repeat(40), "-->".repeat(20)]) {
    const tree = md(`**before**\n\n${row}\n\n**after**`);
    assert.deepEqual(tree[0], p(strong(text("before"))), row);
    assert.deepEqual(tree[tree.length - 1], p(strong(text("after"))), row);
  }
});
