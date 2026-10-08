// Auth.js (next-auth v4) catch-all: sign-in, OIDC callback, session, sign-out.
// All configuration lives in lib/authOptions.ts; route protection in src/middleware.ts.
// The POST handler is a thin wrapper: on a sign-out Auth.js accepted, it additionally expires
// every `next-auth.*` cookie the request carried (INNOBOX_SPEC.md §3, lib/auth-cookie-sweep.ts).
import type { NextRequest } from "next/server";
import NextAuth from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { applySignOutCookieSweep } from "@/lib/auth-cookie-sweep";

type RouteContext = { params: Promise<{ nextauth: string[] }> };

const handler = NextAuth(authOptions) as (req: NextRequest, ctx: RouteContext) => Promise<Response>;

async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const res = await handler(req, ctx);
  const { nextauth } = await ctx.params;
  if (nextauth?.[0] !== "signout") return res;
  return applySignOutCookieSweep(req.headers.get("cookie"), res);
}

export { handler as GET, POST };
