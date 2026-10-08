// Auth.js (next-auth v4) catch-all: sign-in, OIDC callback, session, sign-out.
// All configuration lives in lib/authOptions.ts; route protection in src/middleware.ts.
import NextAuth from "next-auth";
import { authOptions } from "@/lib/authOptions";

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
