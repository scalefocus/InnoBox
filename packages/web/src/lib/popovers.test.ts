// Popovers — one shared treatment (INNOBOX_SPEC.md §2.2, §13.4, §13.8).
//
// Every popover (a floating panel anchored to a trigger: menus, dropdown result lists, hover/focus
// cards, pickers) carries the shared `.menu-pop` class: a ~120 ms fade + scale on open, played once
// on mount, an instant close (unmount, no exit animation), and no motion at all under
// `prefers-reduced-motion: reduce`. Like the attribution and spec-reference scanners next door,
// this is a source-level hygiene check: it reads the TSX and globals.css as text, so it needs no
// DOM, and it fails loudly when a popover drifts back to bespoke motion or chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// packages/web/src/lib → packages/web/src.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GLOBALS_CSS = readFileSync(join(SRC, "app", "globals.css"), "utf8").replace(/\r\n/g, "\n");

/**
 * The root class of each in-scope popover → the file that renders it. Each root class is the
 * popover's own (an exact class token, not a `-item`/`-head` child), so every place it appears in a
 * `className` must also carry `menu-pop`.
 */
const POPOVERS: Record<string, string> = {
  "user-menu": "components/AppShell.tsx", // account menu
  "msg-panel": "components/NotificationBell.tsx", // notification panel (desktop)
  "dir-card": "components/DirectoryCard.tsx", // directory hover card
  "search-ac": "components/TopbarSearch.tsx", // topbar search autocomplete
  "user-search-pop": "app/admin/triage/page.tsx", // triage assignee pickers (FloatingResults)
};

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Every static `className="…"` value in a source file, split into class tokens. */
function classNameTokenLists(source: string): string[][] {
  return [...source.matchAll(/className=(?:"([^"]*)"|\{\s*["'`]([^"'`]*)["'`]\s*\})/g)].map((m) =>
    (m[1] ?? m[2] ?? "").split(/\s+/).filter(Boolean),
  );
}

function srcPath(file: string): string {
  return relative(SRC, file).split(sep).join("/");
}

/** The declarations of the first top-level rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[1];
}

test("each in-scope popover renders with the shared .menu-pop class", () => {
  for (const [rootClass, file] of Object.entries(POPOVERS)) {
    const lists = classNameTokenLists(readFileSync(join(SRC, file), "utf8")).filter((tokens) =>
      tokens.includes(rootClass),
    );
    assert.ok(lists.length > 0, `${file}: no className carries the popover root class "${rootClass}"`);
    for (const tokens of lists) {
      assert.ok(tokens.includes("menu-pop"), `${file}: "${tokens.join(" ")}" is a popover without menu-pop`);
    }
  }
});

test("no popover root class appears anywhere without .menu-pop", () => {
  const files = tsxFiles(SRC);
  // Guard against a silently empty scan (a moved tree would make this test vacuously pass).
  assert.ok(files.length > 20, `expected to scan a real source tree, found ${files.length} files`);
  const offenders: string[] = [];
  for (const file of files) {
    for (const tokens of classNameTokenLists(readFileSync(file, "utf8"))) {
      const root = tokens.find((t) => t in POPOVERS);
      if (root && !tokens.includes("menu-pop")) offenders.push(`${srcPath(file)}: "${tokens.join(" ")}"`);
    }
  }
  assert.deepEqual(offenders, [], `popovers missing the shared treatment:\n${offenders.join("\n")}`);
});

test("the challenge-detail assignee search uses the shared treatment", () => {
  const source = readFileSync(join(SRC, "app", "challenges", "[number]", "page.tsx"), "utf8");
  const lists = classNameTokenLists(source).filter((t) => t.includes("user-search-pop"));
  assert.ok(lists.length > 0, "the assignee search popover is missing");
  for (const tokens of lists) assert.ok(tokens.includes("menu-pop"));
});

test(".menu-pop opens in 120 ms with a fade + scale", () => {
  const body = ruleBody(GLOBALS_CSS, ".menu-pop");
  assert.ok(body, "globals.css has no top-level .menu-pop rule");
  assert.match(body, /animation:\s*menu-pop-in\s+(?:0?\.12s|120ms)\b/, `unexpected .menu-pop animation: ${body.trim()}`);
  const keyframes = /@keyframes menu-pop-in\s*\{([^\n]*)\}/.exec(GLOBALS_CSS)?.[1] ?? "";
  assert.match(keyframes, /from\s*\{[^}]*opacity:\s*0;[^}]*scale\(\.96\)[^}]*var\(--menu-pop-y/);
  assert.match(keyframes, /to\s*\{[^}]*opacity:\s*1;[^}]*scale\(1\)/);
});

test(".menu-pop is silenced under prefers-reduced-motion", () => {
  assert.match(
    GLOBALS_CSS,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.menu-pop\s*\{\s*animation:\s*none;?\s*\}/,
  );
});

test("close is instant: no exit animation survives in globals.css", () => {
  for (const dead of ["menu-pop-closing", "menu-pop-out", "menu-pop-fade-in", "menu-pop-fade-out"]) {
    assert.ok(!GLOBALS_CSS.includes(dead), `globals.css still defines the exit-animation piece "${dead}"`);
  }
});

test("the search autocomplete sets its own motion origin (chrome comes from .menu-pop)", () => {
  const body = ruleBody(GLOBALS_CSS, ".search-ac");
  assert.ok(body, "globals.css has no .search-ac rule");
  assert.match(body, /transform-origin:\s*top center/);
  assert.match(body, /--menu-pop-y:\s*-6px/);
});

test(".menu-pop owns the shared chrome: surface fill, line-strong border, radius-sm, shadow, 5 px padding", () => {
  const body = ruleBody(GLOBALS_CSS, ".menu-pop");
  assert.ok(body, "globals.css has no top-level .menu-pop rule");
  assert.match(body, /background:\s*var\(--surface\)/);
  assert.match(body, /border:\s*1px solid var\(--line-strong\)/);
  assert.match(body, /border-radius:\s*var\(--radius-sm\)/);
  assert.match(body, /box-shadow:\s*var\(--shadow\)/);
  assert.match(body, /(?:^|[;\s])padding:\s*5px\s*;/);
});

test("no popover restates (or overrides) the chrome in its own top-level rule — nothing bespoke", () => {
  const CHROME = /(?:^|[;\s{])(background(?:-color)?|border(?:-radius)?|box-shadow|padding(?:-[a-z]+)?)\s*:/;
  for (const rootClass of Object.keys(POPOVERS)) {
    const body = ruleBody(GLOBALS_CSS, `.${rootClass}`);
    assert.ok(body, `globals.css has no top-level .${rootClass} rule`);
    const hit = CHROME.exec(body);
    assert.equal(hit, null, `.${rootClass} restates popover chrome (${hit?.[1]}) — it belongs to .menu-pop`);
  }
});
