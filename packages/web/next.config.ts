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
  // `next dev` only, and only when the Jenkins e2e job asks for it. By default dev disposes a
  // route's compiled entry after 60 s idle, so a long e2e run recompiles the same routes over and
  // over — each recompile a 5–35 s stall on the CI agent and a potential Fast Refresh full reload
  // of the page under test. The job pre-compiles every route (scripts/e2e-warmup.mjs) and this
  // keeps them resident for the whole run. Local dev keeps Next's default.
  ...(process.env.E2E_KEEP_ROUTES_COMPILED === "1"
    ? { onDemandEntries: { maxInactiveAge: 24 * 60 * 60 * 1000, pagesBufferLength: 1000 } }
    : {}),
  async headers() {
    return [{ source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] }];
  },
};

export default nextConfig;
