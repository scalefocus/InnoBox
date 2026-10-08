// Repository hygiene: the attribution removability rule (INNOBOX_SPEC.md §2.2).
//
// InnoBox is released under Apache-2.0, which grants no trademark rights: the creating
// organization's brand ships as the default look but a fork must be able to strip it. This test
// keeps that a one-edit operation by confining the organization's name, inside the product tree,
// to a closed allowlist — the sidebar colophon and the e2e assertion that it renders. Every other
// occurrence fails the test, in copy, comments, tests, fixtures, or configuration defaults alike.
//
// The scan covers the WHOLE packages/** tree, not just src/. The earlier src-only scope silently
// excluded e2e/, which is exactly how the discovery.spec.ts occurrence came to exist unrecorded;
// allowlisting it explicitly makes it a known second occurrence instead of a blind spot.
//
// LICENSE and NOTICE are outside packages/ and carry the copyright holder by design (§21.1).
//
// The name is assembled from fragments on purpose: spelling it out would make this file itself an
// occurrence, and excluding the scanner from its own scan would blunt the check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ORG = ["Scale", "focus"].join("");
const NEEDLE = ORG.toLowerCase();

// packages/web/src/lib → repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/** The colophon line rendered by the app shell — the one occurrence a user ever sees. */
const SHELL = "packages/web/src/components/AppShell.tsx";
/** The e2e assertion that the colophon renders. Deliberate, and on the rebranding checklist. */
const COLOPHON_SPEC = "packages/web/e2e/discovery.spec.ts";
const ALLOWLIST = new Set([SHELL, COLOPHON_SPEC]);

/** Build output and installed dependencies are not the product tree. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Every package in full — src, e2e, scripts, fixtures, and package manifests alike. */
function packageSourceFiles(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    out.push(...sourceFiles(join(PACKAGES_DIR, pkg.name)));
  }
  return out;
}

/** Repo-relative, POSIX-separated, so the allowlist reads the same on Windows and Linux. */
function repoPath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

test("the organization is named nowhere in packages/** outside the allowlist", () => {
  const files = packageSourceFiles();
  // Guard against a silently empty scan (a moved tree would make this test vacuously pass).
  assert.ok(files.length > 50, `expected to scan a real source tree, found ${files.length} files`);

  const offenders = files
    .filter((file) => !ALLOWLIST.has(repoPath(file)))
    .filter((file) => readFileSync(file, "utf8").toLowerCase().includes(NEEDLE))
    .map(repoPath);

  assert.deepEqual(
    offenders,
    [],
    `the creating organization may be named only in the sidebar colophon and its e2e assertion ` +
      `(INNOBOX_SPEC.md §2.2 removability rule); found it in: ${offenders.join(", ")}`,
  );
});

// An allowlist entry that no longer matches a real file would silently widen the rule: the scan
// would still pass while the occurrence it was covering had moved somewhere unallowlisted.
test("every allowlisted path exists and actually contains the name", () => {
  const scanned = new Set(packageSourceFiles().map(repoPath));
  for (const allowed of ALLOWLIST) {
    assert.ok(scanned.has(allowed), `allowlisted path is not in the scanned tree: ${allowed}`);
    assert.ok(
      readFileSync(join(REPO_ROOT, allowed), "utf8").toLowerCase().includes(NEEDLE),
      `allowlisted path no longer contains the name and should be removed from the allowlist: ${allowed}`,
    );
  }
});

test("the colophon carries exactly one mention, above the community line", () => {
  const shell = readFileSync(join(REPO_ROOT, SHELL), "utf8");

  const mentions = shell.toLowerCase().split(NEEDLE).length - 1;
  assert.equal(mentions, 1, `the app shell must name the organization exactly once, found ${mentions}`);

  const createdBy = `<span className="colophon-sub">Created by ${ORG}</span>`;
  const community = '<span className="colophon-sub">Powered by the community</span>';
  assert.ok(shell.includes(createdBy), "the colophon must render the created-by attribution line");
  assert.ok(shell.includes(community), "the colophon must render the community attribution line");
  assert.ok(shell.indexOf(createdBy) < shell.indexOf(community), "the community line goes below the created-by line");
});
