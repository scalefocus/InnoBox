# Next.js standalone build for the InnoBox web tier. Self-hosted; never Vercel. (INNOBOX_SPEC.md §2)
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# --- deps + build (monorepo aware) ---
FROM base AS build
# Copy the lockfile so the install is reproducible (--frozen-lockfile fails on drift).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @innobox/shared build
RUN pnpm --filter @innobox/web build
# Build output inherits the build-context file modes, and a checkout made under a strict umask
# (e.g. 077 on the deploy host) is owner-only — root-owned 0600 files the runtime's `node` user
# cannot read ("Cannot read package config /app/package.json: permission denied"). Make the
# runtime tree world-readable (and directories traversable), as the worker image does.
RUN chmod -R a+rX packages/web/.next/standalone packages/web/.next/static packages/web/public

# --- runtime (standalone output) ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# ca-certificates explicitly so outbound HTTPS (Entra, Graph mail) has a CA trust store.
RUN apk add --no-cache ca-certificates
COPY --from=build /app/packages/web/.next/standalone ./
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=build /app/packages/web/public ./packages/web/public
EXPOSE 3000
# Run unprivileged (no runtime writes needed).
USER node
# standalone server entrypoint produced by Next for the web package
CMD ["node", "packages/web/server.js"]
