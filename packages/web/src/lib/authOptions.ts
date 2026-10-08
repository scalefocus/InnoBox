// NextAuth (v4) configuration — Entra ID OIDC sign-in (ENTRA_AUTH_SPEC.md §5, layer 1).
// Token validation (issuer pinned to the tenant, audience = client id, RS256 via JWKS,
// pkce/state/nonce) is delegated to the library and pinned by this config. The JWT session
// cookie carries `oid` + display basics ONLY — roles resolve from SCIM-synced group
// membership on every request (lib/auth.ts), NEVER from token claims (invariant 1).
import type { NextAuthOptions } from "next-auth";
import AzureADProvider from "next-auth/providers/azure-ad";
import CredentialsProvider from "next-auth/providers/credentials";
import { pool } from "./db";
import { upsertDevUser } from "./users";
import { resolveEntraSignIn } from "./signin-relink";
import { recordSystemEvent } from "../app/api/admin/system-log/store";

declare module "next-auth" {
  interface Session {
    /** Entra object id (== users.external_id) of the signed-in user. */
    oid?: string;
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    oid?: string;
  }
}

/** The raw Entra ID-token claims next-auth passes to callbacks as `profile`. */
interface EntraClaims {
  oid?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
}

// Dev bypass (spec §2 rollout): NODE_ENV is "production" in production builds, so the
// Credentials provider below can never be registered there — the flag is a no-op.
const devAuthEnabled = process.env.INNOBOX_DEV_AUTH === "1" && process.env.NODE_ENV !== "production";

const providers: NextAuthOptions["providers"] = [
  AzureADProvider({
    // Display name shown on any provider-labeled control ("Sign in with Entra ID") — never
    // the library default "Azure Active Directory". The sign-in UI is in-shell (AppShell),
    // not the removed default Auth.js page (ENTRA_AUTH_SPEC.md §5, layer 1).
    name: "Entra ID",
    tenantId: process.env.ENTRA_TENANT_ID,
    clientId: process.env.ENTRA_CLIENT_ID ?? "",
    clientSecret: process.env.ENTRA_CLIENT_SECRET ?? "",
    authorization: { params: { scope: "openid profile email" } },
    checks: ["pkce", "state", "nonce"],
    // Replaces the provider default, which also fetches the user photo from Graph —
    // reconciliation owns photos (spec §5); sign-in needs claims only.
    profile(claims) {
      return {
        id: (claims.oid as string | undefined) ?? claims.sub,
        name: (claims.name as string | undefined) ?? null,
        email: claims.email ?? null,
      };
    },
  }),
];

if (devAuthEnabled) {
  providers.push(
    CredentialsProvider({
      id: "dev",
      name: "Dev sign-in",
      // Defaults pre-fill the built-in NextAuth sign-in form (its `value` key is spread
      // straight onto the rendered <input>) so local dev sign-in is a one-click submit.
      credentials: {
        name: { label: "Display name", type: "text", value: "Dev" },
        email: { label: "Email (optional)", type: "text", value: "dev@innobox.innovate" },
        admin: { label: "Platform admin (\"1\" = yes)", type: "text", value: "1" },
        // "1" leaves a newly created persona unseen for /quick-start (INNOBOX_SPEC.md §13.7) —
        // used only by the dedicated onboarding e2e spec; every other dev/e2e sign-in defaults
        // to already-seen so it isn't interrupted by the onboarding redirect.
        freshOnboarding: { label: "Fresh onboarding (\"1\" = yes)", type: "text", value: "0" },
      },
      // Upserts a REAL local user (+ dev admin group/mapping/membership when requested)
      // so RBAC still resolves from the database — the session never carries roles.
      async authorize(credentials) {
        const name = credentials?.name?.trim();
        if (!name) return null;
        const user = await upsertDevUser(pool, {
          name,
          email: credentials?.email?.trim() || null,
          admin: credentials?.admin === "1",
          freshOnboarding: credentials?.freshOnboarding === "1",
        });
        if (!user.active) return null; // deactivated dev users are refused like real leavers
        return { id: user.externalId, name: user.displayName, email: user.email };
      },
    }),
  );
}

export const authOptions: NextAuthOptions = {
  providers,
  secret: process.env.NEXTAUTH_SECRET,
  // No default Auth.js sign-in page: the Home landing (`/`) is the sign-in surface, and the
  // in-shell "Sign in with Entra ID" button drives OIDC directly. Sign-in errors (e.g. a
  // deactivated account → AccessDenied) are handed back to `/` as `?error=` (ENTRA_AUTH_SPEC.md §5).
  pages: { signIn: "/" },
  // Rolling JWT cookie session, 7-day cap (spec §2): re-issued at most daily on activity.
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "dev") return true; // authorize() already upserted + active-checked
      const claims = profile as EntraClaims | undefined;
      const oid = claims?.oid;
      if (!oid) return false; // no immutable identity key — refuse
      // Existing row by oid (deactivated → refused), else the SCIM relink repair, else JIT; a
      // UPN collision nothing may relink is refused (→ /?error=AccessDenied) and recorded in
      // the system log (INNOBOX_SPEC.md §3 sign-in relink, §14.7).
      const result = await resolveEntraSignIn(
        pool,
        { oid, preferredUsername: claims?.preferred_username, email: claims?.email, name: claims?.name },
        {
          // Fire-and-forget, like every system-log insert: never blocks or fails the sign-in.
          recordConflict: (event) => {
            void recordSystemEvent(pool, event).catch((err: unknown) =>
              console.error(JSON.stringify({ level: "error", msg: "system-log insert failed", error: String(err) })),
            );
          },
        },
      );
      return result.ok;
    },
    async jwt({ token, user, account, profile }) {
      if (account) {
        // First issue for this sign-in; later requests just re-serialize the token.
        const claims = profile as EntraClaims | undefined;
        token.oid = account.provider === "dev" ? user?.id : claims?.oid;
        token.name = claims?.name ?? user?.name ?? token.name;
        token.email = claims?.email ?? user?.email ?? token.email;
      }
      return token;
    },
    async session({ session, token }) {
      session.oid = token.oid;
      return session;
    },
  },
};
