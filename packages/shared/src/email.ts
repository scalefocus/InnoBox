// SERVER-ONLY entry for the §12 email channel (node:crypto inside) — import via
// "@innobox/shared/email". The wrapper/template helpers (email-template.ts — also server-only,
// since the wrapper sanitizer is a real HTML parser) are exported from the main index.
export * from "./email-crypto.js";
export * from "./email-graph.js";
