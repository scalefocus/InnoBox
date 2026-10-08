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
  async headers() {
    return [{ source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] }];
  },
};

export default nextConfig;
