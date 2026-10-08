// Repository hygiene: no internal spec references in user-facing surfaces (INNOBOX_SPEC.md §21.9).
//
// The section markers in INNOBOX_SPEC.md are internal to that document. A person using InnoBox has
// no access to the spec and no way to resolve "10.1", so a marker that reaches an API error
// message, the changelog, page copy, or an e-mail reads as leaked internal shorthand.
//
// The distinction this test draws is comment vs. not-comment. Markers in code comments, JSDoc, and
// SQL comments are correct and encouraged — they are how the implementation stays anchored to the
// spec. What survives comment-stripping, however, is a string literal or JSX text: something a user
// can see. So: strip the comments, then fail on anything left.
//
// Like the attribution scanner next door, the needle is built from a character code rather than
// written out, so this file does not match itself and needs no self-exclusion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = String.fromCharCode(0xa7);

// packages/web/src/lib → repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/** Tests are not a user-facing surface: they may cite the spec freely. */
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

function packageSourceFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    try {
      out.push(...sourceFiles(join(PACKAGES_DIR, pkg.name, "src")));
    } catch {
      // A package without a src/ tree — nothing to scan.
    }
  }
  return out;
}

/**
 * Blank out every comment while preserving line structure, so offenders keep their line numbers.
 * Block comments cover JSDoc and braced JSX comments alike; the SQL rule covers comments inside
 * template literals, which would otherwise survive as "string content".
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "")
    .replace(/--.*$/gm, "");
}

/** Repo-relative, POSIX-separated, so failures read the same on Windows and Linux. */
function repoPath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

test("no spec section reference reaches a user-facing string", () => {
  const files = packageSourceFiles();
  // Guard against a silently empty scan (a moved tree would make this test vacuously pass).
  assert.ok(files.length > 50, `expected to scan a real source tree, found ${files.length} files`);

  const offenders: string[] = [];
  for (const file of files) {
    stripComments(readFileSync(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (line.includes(MARKER)) offenders.push(`${repoPath(file)}:${i + 1}`);
      });
  }

  assert.deepEqual(
    offenders,
    [],
    `spec section markers are internal to INNOBOX_SPEC.md and must not appear in anything a user can see — ` +
      `error messages, changelog entries, page copy, e-mail templates (INNOBOX_SPEC.md ${MARKER}21.9). ` +
      `Comments may cite the spec freely; these are not comments: ${offenders.join(", ")}`,
  );
});
