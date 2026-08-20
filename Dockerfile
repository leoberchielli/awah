# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- full dependencies (the build needs the devDependencies) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/sdk/package.json ./packages/sdk/
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter @awah/api build
RUN pnpm --filter @awah/web build

# ---- production dependencies ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/sdk/package.json ./packages/sdk/
# The dashboard already came out compiled from the build stage, so its
# dependencies never reach the runtime. Its package.json is copied anyway, only
# so the lockfile still matches the workspace — without it --frozen-lockfile
# refuses to install.
RUN pnpm install --frozen-lockfile --prod --filter @awah/api...

# ---- runtime ----
FROM base AS runtime

# Filled in by CI. They end up in the labels and in /health, so whoever is
# supporting an instance can tell what is running without having to ask.
ARG AWAH_VERSION=dev
ARG AWAH_REVISION=unknown
ARG AWAH_BUILD_DATE=unknown

LABEL org.opencontainers.image.title="AWAH"
LABEL org.opencontainers.image.description="WhatsApp gateway with a durable queue, a risk engine and clustered sessions"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/leoberchielli/awah"
LABEL org.opencontainers.image.documentation="https://github.com/leoberchielli/awah#readme"
LABEL org.opencontainers.image.version="${AWAH_VERSION}"
LABEL org.opencontainers.image.revision="${AWAH_REVISION}"
LABEL org.opencontainers.image.created="${AWAH_BUILD_DATE}"

ENV NODE_ENV=production
ENV AWAH_VERSION=${AWAH_VERSION}
ENV AWAH_REVISION=${AWAH_REVISION}
# Explicit: the process runs from /app, and the panel sits next to the bundle.
ENV DASHBOARD_DIR=/app/apps/api/public

RUN apk add --no-cache tini

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
# The dashboard becomes static files served by the API itself, same origin.
COPY --from=build /app/apps/web/dist ./apps/api/public
# The migration runner reads the .sql files from here at run time.
COPY packages/db/migrations ./packages/db/migrations

USER node
EXPOSE 2900

# No curl in the image: Node does the check itself, and the image stays small.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2900)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini as PID 1 so SIGTERM reaches Node and the orderly shutdown actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
