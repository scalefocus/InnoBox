# Next.js standalone build for the InnoBox web tier. Self-hosted; never Vercel. (INNOBOX_SPEC.md §2)
FROM node:20-alpine AS base
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

# --- runtime (standalone output) ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# ca-certificates explicitly so outbound HTTPS (Entra, Graph mail) has a CA trust store.
RUN apk add --no-cache ca-certificates
COPY --from=build /app/packages/web/.next/standalone ./
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static
COPY --chmod=755 --from=build /app/packages/web/public ./packages/web/public
EXPOSE 3000
# Run unprivileged (no runtime writes needed).
USER node
# standalone server entrypoint produced by Next for the web package
CMD ["node", "packages/web/server.js"]
