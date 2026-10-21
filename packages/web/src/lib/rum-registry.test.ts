// §14.12 route registry completeness (INNOBOX_SPEC.md): every authenticated page has a name in the
// registry, so "Other" stays empty in practice, and the registry names no page that does not
// exist. Walks app/**/page.tsx and turns each file path into its App Router template.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUM_ROUTES, RUM_UNMONITORED_TEMPLATES, rumRouteFor } from "@innobox/shared/rum";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

function pageTemplates(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Route groups "(x)" add no segment; "api" holds route handlers, not pages.
      if (prefix === "" && entry.name === "api") continue;
      const segment = /^\(.*\)$/.test(entry.name) ? "" : `/${entry.name}`;
      out.push(...pageTemplates(path.join(dir, entry.name), prefix + segment));
    } else if (entry.name === "page.tsx") {
      out.push(prefix === "" ? "/" : prefix);
    }
  }
  return out;
}

const pages = pageTemplates(appDir);

test("every authenticated page is in the registry", () => {
  assert.ok(pages.length > 10, "found the app's pages");
  const registered = new Set(RUM_ROUTES.map((r) => r.template));
  const missing = pages.filter((t) => !registered.has(t) && !RUM_UNMONITORED_TEMPLATES.includes(t));
  assert.deepEqual(missing, [], "add these pages to RUM_ROUTES in packages/shared/src/rum.ts");
});

test("the registry names no page that does not exist", () => {
  const existing = new Set(pages);
  const stale = RUM_ROUTES.map((r) => r.template).filter((t) => !existing.has(t));
  assert.deepEqual(stale, []);
});

test("each page's own path resolves to its own template", () => {
  for (const template of pages.filter((t) => !RUM_UNMONITORED_TEMPLATES.includes(t))) {
    const concrete = template.replace(/\[[^\]]+\]/g, "123");
    assert.equal(rumRouteFor(concrete), template, concrete);
  }
});

test("names are unique, so no two table rows read alike", () => {
  const names = RUM_ROUTES.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
});
