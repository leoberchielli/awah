# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- dependências completas (build precisa das devDependencies) ----
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

# ---- dependências de produção ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/sdk/package.json ./packages/sdk/
# O dashboard já saiu compilado do estágio de build; as dependências dele não
# entram no runtime. O package.json vem junto só para o lockfile continuar
# batendo com o workspace — sem ele, --frozen-lockfile recusa a instalação.
RUN pnpm install --frozen-lockfile --prod --filter @awah/api...

# ---- runtime ----
FROM base AS runtime

# Preenchidos pelo CI. Ficam nos rótulos e no /health, para quem dá suporte
# saber o que está rodando sem precisar perguntar.
ARG AWAH_VERSION=dev
ARG AWAH_REVISION=unknown
ARG AWAH_BUILD_DATE=unknown

LABEL org.opencontainers.image.title="AWAH"
LABEL org.opencontainers.image.description="Gateway de WhatsApp com fila durável, motor de risco e sessões em cluster"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/leandroberchielli/awah"
LABEL org.opencontainers.image.documentation="https://github.com/leandroberchielli/awah#readme"
LABEL org.opencontainers.image.version="${AWAH_VERSION}"
LABEL org.opencontainers.image.revision="${AWAH_REVISION}"
LABEL org.opencontainers.image.created="${AWAH_BUILD_DATE}"

ENV NODE_ENV=production
ENV AWAH_VERSION=${AWAH_VERSION}
ENV AWAH_REVISION=${AWAH_REVISION}
# Explícito: o processo roda a partir de /app, e o painel fica ao lado do bundle.
ENV DASHBOARD_DIR=/app/apps/api/public

RUN apk add --no-cache tini

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
# O dashboard vira estático servido pela própria API, na mesma origem.
COPY --from=build /app/apps/web/dist ./apps/api/public
# O runner de migration lê os .sql daqui em tempo de execução.
COPY packages/db/migrations ./packages/db/migrations

USER node
EXPOSE 2900

# Sem curl na imagem: o próprio Node faz a checagem, e a imagem não engorda por isso.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2900)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini como PID 1 para que SIGTERM chegue ao Node e o desligamento ordenado rode.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
