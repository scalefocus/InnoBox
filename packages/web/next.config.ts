import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security-headers";

// Standalone output (INNOBOX_SPEC.md §2): the container runs `node .next/standalone/server.js`
// behind the compose proxy. Never Vercel.
// Image optimization is off: InnoBox renders no next/image, and its optimizer depends on
// sharp, whose libvips binary is LGPL-3.0 — excluded from the install (root package.json
// pnpm.ignoredOptionalDependencies) to keep the production tree copyleft-free
// (INNOBOX_SPEC.md §21.1).
//
// §2.4 web security baseline: no X-Powered-By, and the env-independent security headers on EVERY
// response — including the /_next/* assets the middleware matcher skips. The per-request headers
// (the nonce-bearing CSP, and HSTS, which follows the runtime PUBLIC_BASE_URL) are set by
// src/middleware.ts; nothing here may depend on runtime env, since headers() is evaluated at build.
const nextConfig: NextConfig = {
  output: "standalone",
  images: { unoptimized: true },
  poweredByHeader: false,
  // `next dev` only. Next 16 answers /_next/* requests whose Origin isn't localhost with a 403, and
  // the Jenkins e2e drives the dev server at http://127.0.0.1:3000 — so without this every JS chunk
  // is refused, nothing hydrates, and the whole suite times out. Ignored by production builds.
  allowedDevOrigins: ["127.0.0.1"],
  // `next dev` only. Next 16 writes AGENTS.md + CLAUDE.md into packages/web when it detects an AI
  // coding agent; the repository's agent context lives at the root, so keep dev from adding files.
  agentRules: false,
  // `next dev` only, and only for the Jenkins e2e server (E2E_DEV_SERVER=1). Turbopack writes every
  // compiled route to its filesystem cache (.next/dev/cache, on by default in dev); "full" eviction
  // then drops that output from memory after each cache snapshot, instead of only when it expects a
  // large saving or the host is short of memory. The job pre-compiles every route
  // (scripts/e2e-warmup.mjs), so a test's first request to a route restores it from disk in about
  // 0.1–0.2 s — no recompile, no Fast Refresh reload. Measured on all 157 entries: ~2 GB RSS with
  // a 1.2 GB JS heap, against ~4.6 GB RSS without eviction (and 2.85 GB of heap, past Next's dev
  // restart threshold under load, when the e2e still ran webpack with every route kept compiled).
  // Local dev keeps Turbopack's default ("auto").
  ...(process.env.E2E_DEV_SERVER === "1" ? { experimental: { turbopackMemoryEviction: "full" } } : {}),
  async headers() {
    return [{ source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] }];
  },
};

export default nextConfig;
