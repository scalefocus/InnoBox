// Repository hygiene: every timestamp renders through the shared formatter (CLAUDE.md invariant 10,
// INNOBOX_SPEC.md §14.3).
//
// Timestamps are stored UTC and converted at display by components/DateFormat.tsx → useDateFmt(),
// which applies the platform's EU/US style. A bare `toLocaleDateString()` instead follows the
// browser's own locale, so the same row reads 12/06/2026 for one admin and 6/12/2026 for another,
// whatever the platform setting says (GAP-46 was exactly this, on both triage tabs).
//
// So: outside DateFormat.tsx, no web source may format a date itself. Number formatting
// (`count.toLocaleString()`) is fine — only the date-specific calls, a `toLocaleString()` chained
// directly on `new Date(...)`, and a hand-built `Intl.DateTimeFormat` are flagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// packages/web/src/lib → packages/web/src.
const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORMATTER = join(WEB_SRC, "components", "DateFormat.tsx");

const FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /\.toLocale(?:Date|Time)String\(/, label: "toLocaleDateString/toLocaleTimeString" },
  { pattern: /\bnew Date\([^)]*\)\.toLocaleString\(/, label: "new Date(...).toLocaleString" },
  { pattern: /\bnew Intl\.DateTimeFormat\(/, label: "new Intl.DateTimeFormat" },
];

function isScannable(name: string): boolean {
  if (name.endsWith(".test.ts") || name.endsWith(".dbtest.ts")) return false;
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile() && isScannable(entry.name)) out.push(full);
  }
  return out;
}

/** Blank out comments, keeping line numbers, so prose that names these calls is not flagged. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
}

function repoPath(file: string): string {
  return relative(WEB_SRC, file).split(sep).join("/");
}

test("timestamps render only through the shared DateFormat formatter", () => {
  const files = sourceFiles(WEB_SRC).filter((file) => file !== FORMATTER);
  // Guard against a silently empty scan (a moved tree would make this test vacuously pass).
  assert.ok(files.length > 50, `expected to scan a real source tree, found ${files.length} files`);

  const offenders: string[] = [];
  for (const file of files) {
    stripComments(readFileSync(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        for (const { pattern, label } of FORBIDDEN) {
          if (pattern.test(line)) offenders.push(`${repoPath(file)}:${i + 1} — ${label}`);
        }
      });
  }
  assert.deepEqual(offenders, [], `format timestamps with useDateFmt() instead:\n${offenders.join("\n")}`);
});

test("the formatter itself is still where the scan expects it", () => {
  const source = readFileSync(FORMATTER, "utf8");
  assert.match(source, /export function useDateFmt\(/);
});
