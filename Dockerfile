# syntax=docker/dockerfile:1.7
#
# EmailBot - portable images for any container platform (no provider config).
#
#   docker build --target api    -t emailbot-api .
#   docker build --target worker -t emailbot-worker .
#   docker build --target web    -t emailbot-web \
#     --build-arg VITE_SUPABASE_URL=https://<project>.supabase.co \
#     --build-arg VITE_SUPABASE_ANON_KEY=<public anon key> \
#     --build-arg VITE_API_URL=https://api.<domain> .
#
# Platforms that cannot pass --target (Render) select the same stages with a
# build argument instead. Render turns each environment variable into a build
# argument, so each service sets EMAILBOT_TARGET=api|worker|web:
#
#   docker build --build-arg EMAILBOT_TARGET=api -t emailbot-api .
#
# Without --target or EMAILBOT_TARGET the build stops with an error instead of
# silently producing the wrong image.
#
# Runtime configuration (secrets included) comes from environment variables
# at deploy time; nothing secret is baked into the images. See docs/deployment.md.

ARG NODE_VERSION=22
ARG EMAILBOT_TARGET=target-required

# ---------------------------------------------------------------- base
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Every workspace manifest (the lockfile is validated against all of them).
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
COPY packages/rules-engine/package.json packages/rules-engine/
COPY packages/shared/package.json packages/shared/
COPY packages/types/package.json packages/types/
COPY packages/validation/package.json packages/validation/

# ---------------------------------------------------------------- build
# Filtered installs skip the monorepo root, so the Supabase CLI (a root dev
# dependency that downloads a binary) is never installed in images.
FROM manifests AS build
RUN pnpm install --frozen-lockfile \
      --filter "@emailbot/api..." --filter "@emailbot/worker..." --filter "@emailbot/web..."
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

FROM build AS build-server
RUN pnpm --filter "@emailbot/api..." --filter "@emailbot/worker..." run build

FROM build AS build-web
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_URL
# NODE_ENV=production makes the build fail fast on missing / local / non-HTTPS URLs.
RUN NODE_ENV=production \
    VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
    VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY" \
    VITE_API_URL="$VITE_API_URL" \
    pnpm --filter "@emailbot/web..." run build

# ---------------------------------------------------------------- production dependencies
FROM manifests AS prod-deps-api
RUN pnpm install --frozen-lockfile --prod --filter "@emailbot/api..."

FROM manifests AS prod-deps-worker
RUN pnpm install --frozen-lockfile --prod --filter "@emailbot/worker..."

# ---------------------------------------------------------------- api
FROM base AS api
ENV NODE_ENV=production
COPY --from=prod-deps-api /repo ./
COPY --from=build-server /repo/packages/types/dist packages/types/dist
COPY --from=build-server /repo/packages/validation/dist packages/validation/dist
COPY --from=build-server /repo/packages/shared/dist packages/shared/dist
COPY --from=build-server /repo/packages/rules-engine/dist packages/rules-engine/dist
COPY --from=build-server /repo/apps/api/dist apps/api/dist
USER node
# PORT (platform) or API_PORT; 3000 by default.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || process.env.API_PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]

# ---------------------------------------------------------------- worker
FROM base AS worker
ENV NODE_ENV=production
COPY --from=prod-deps-worker /repo ./
COPY --from=build-server /repo/packages/types/dist packages/types/dist
COPY --from=build-server /repo/packages/validation/dist packages/validation/dist
COPY --from=build-server /repo/packages/shared/dist packages/shared/dist
COPY --from=build-server /repo/packages/rules-engine/dist packages/rules-engine/dist
COPY --from=build-server /repo/apps/worker/dist apps/worker/dist
USER node
# Health endpoint only when WORKER_HEALTH_PORT (or PORT) is set: GET /livez, GET /readyz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const p = process.env.WORKER_HEALTH_PORT || process.env.PORT; if (!p) process.exit(0); fetch('http://127.0.0.1:' + p + '/livez').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "apps/worker/dist/index.js"]

# ---------------------------------------------------------------- web (static, nginx as non-root on 8080)
FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/web/security-headers.conf.template /tmp/security-headers.conf.template
COPY --from=build-web /repo/apps/web/dist /usr/share/nginx/html
USER root
# The CSP computed at build time (from the VITE_* origins) is also sent as a header, with frame-ancestors.
RUN mkdir -p /etc/nginx/snippets \
 && policy="$(cat /usr/share/nginx/html/csp-policy.txt)" \
 && sed "s|__CSP__|${policy}|" /tmp/security-headers.conf.template > /etc/nginx/snippets/security-headers.conf \
 && rm /usr/share/nginx/html/csp-policy.txt /tmp/security-headers.conf.template
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

# ---------------------------------------------------------------- target selection (build argument)
FROM base AS target-required
RUN echo "Set EMAILBOT_TARGET to api, worker or web (or build with --target)." >&2 && exit 1

# Same image as the selected stage (user, CMD, HEALTHCHECK and ports are
# inherited). Only the three runtime stages are accepted: a build or
# dependency stage would ship sources and dev dependencies.
FROM ${EMAILBOT_TARGET} AS selected
ARG EMAILBOT_TARGET
RUN case "$EMAILBOT_TARGET" in api|worker|web) ;; *) echo "EMAILBOT_TARGET must be api, worker or web" >&2; exit 1 ;; esac
