import type { NextConfig } from "next";

// Standalone output (INNOBOX_SPEC.md §2): the container runs `node .next/standalone/server.js`
// behind the compose proxy. Never Vercel.
// Image optimization is off: InnoBox renders no next/image, and its optimizer depends on
// sharp, whose libvips binary is LGPL-3.0 — excluded from the install (root package.json
// pnpm.ignoredOptionalDependencies) to keep the production tree copyleft-free
// (INNOBOX_SPEC.md §21.1).
const nextConfig: NextConfig = {
  output: "standalone",
  images: { unoptimized: true },
};

export default nextConfig;
