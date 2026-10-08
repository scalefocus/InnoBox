# InnoBox worker: SCIM 2.0 endpoints + Entra reconciliation + ClamAV scan pipeline +
# notification dispatch. Singleton, leader-locked via Postgres advisory lock. (INNOBOX_SPEC.md §2)
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
# Copy the lockfile so the install is reproducible (--frozen-lockfile fails on drift).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/worker ./packages/worker
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @innobox/shared build
RUN pnpm --filter @innobox/worker build
# `pnpm deploy` creates a self-contained directory with all production deps and copies
# workspace packages as real directories (no symlinks) — cleanly resolves the subpath
# exports issue that arises when the virtual-store symlinks are moved between images.
RUN pnpm --filter @innobox/worker --prod deploy /deploy && \
    chmod -R a+rX /deploy

FROM node:20-alpine AS runner
# ca-certificates explicitly so outbound HTTPS (Entra, Graph mail) has a CA trust store.
RUN apk add --no-cache ca-certificates
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /deploy .
# Run unprivileged (no runtime writes needed).
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
