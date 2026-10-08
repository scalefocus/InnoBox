// Guards the pill-switch contract in globals.css (INNOBOX_SPEC.md §2.2).
//
// Why a CSS test: the knob used to be positioned by `[data-theme="dark"] .toggle-knob`, a
// selector keyed to the document theme rather than to the control. That works while the theme
// toggle is the only switch on the page and breaks silently the moment a second one exists —
// the e-mail preference knob would sit "on" for every dark-mode user and refuse to move when
// clicked. No other test would catch it: the e2e suite runs in the light theme, so the bad
// selector never matches there.
//
// So the invariant is asserted at its source. A switch's knob is positioned from its OWN
// aria-checked; the single permitted [data-theme] rule is the pre-hydration fallback, which
// must stay scoped to .toggle-theme so it can never reach another switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// packages/web/src/components → packages/web/src/app/globals.css
const CSS = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app", "globals.css"),
  "utf8",
);

/** Every selector in the stylesheet that positions a `.toggle-knob`. */
function knobRules(): string[] {
  return CSS.split("\n")
    .filter((line) => line.includes(".toggle-knob") && line.includes("translateX"))
    .map((line) => line.trim());
}

test("the knob is positioned from the switch's own aria-checked", () => {
  assert.ok(
    CSS.includes('.toggle[aria-checked="true"] .toggle-knob'),
    "the state-driven rule is what makes a second switch on the page possible",
  );
});

test("no knob rule is keyed to the ambient theme except the scoped pre-hydration fallback", () => {
  const themeKeyed = knobRules().filter((rule) => rule.includes("[data-theme"));
  for (const rule of themeKeyed) {
    assert.ok(
      rule.includes(".toggle-theme"),
      `a [data-theme] knob rule must be scoped to .toggle-theme, else it drags every switch ` +
        `along with the theme: ${rule}`,
    );
  }
});

test("the theme toggle carries .toggle-theme, so the fallback selector still matches it", () => {
  const tsx = readFileSync(
    join(resolve(dirname(fileURLToPath(import.meta.url))), "ThemeToggle.tsx"),
    "utf8",
  );
  assert.match(tsx, /className="toggle toggle-theme"/);
  assert.match(tsx, /aria-checked=\{theme === "dark"\}/); // what the fallback hands over to
});

test("the preference variant reports its state on the track too", () => {
  assert.match(CSS, /\.toggle-pref\[aria-checked="true"\][^}]*background: var\(--accent\)/);
});

// Travel direction is per-switch (§2.2): the theme toggle slides right for dark, the e-mail
// preference slides LEFT for on. The two rules carry EQUAL specificity, so the override rests
// entirely on source order — reorder the stylesheet and the switch silently inverts, with the
// accent track then reading "on" while the knob says "off". Hence both assertions below.
test("the preference switch rests left when on and slides right when off", () => {
  assert.match(CSS, /\.toggle-pref\[aria-checked="true"\] \.toggle-knob \{ transform: none; \}/);
  assert.match(
    CSS,
    /\.toggle-pref\[aria-checked="false"\] \.toggle-knob \{ transform: translateX\(28px\); \}/,
  );
});

test("the inverted rules follow the generic one, which is what makes them win", () => {
  const generic = CSS.indexOf('.toggle[aria-checked="true"] .toggle-knob');
  const inverted = CSS.indexOf('.toggle-pref[aria-checked="true"] .toggle-knob');
  assert.ok(generic !== -1 && inverted !== -1);
  assert.ok(
    inverted > generic,
    "equal specificity means the later rule wins: the .toggle-pref override must stay below " +
      "the generic .toggle rule, or the e-mail switch inverts",
  );
});

test("the mobile topbar reflow rule cannot reach switches outside the topbar", () => {
  const orderRules = CSS.split("\n").filter(
    (line) => line.includes(".toggle") && line.includes("order:"),
  );
  assert.ok(orderRules.length > 0);
  for (const rule of orderRules) {
    assert.ok(rule.trim().startsWith(".topbar "), `topbar-only rule leaked: ${rule.trim()}`);
  }
});
