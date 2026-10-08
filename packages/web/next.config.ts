import type { NextConfig } from "next";

// Standalone output (INNOBOX_SPEC.md §2): the container runs `node .next/standalone/server.js`
// behind the compose proxy. Never Vercel.
const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
