FROM oven/bun:1.3.13 AS base

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/deployment/package.json packages/deployment/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/github/package.json packages/github/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/testing/package.json packages/testing/package.json

RUN bun install --frozen-lockfile

COPY --chown=bun:bun . .

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
USER bun

FROM base AS api
EXPOSE 8000
CMD ["bun", "run", "--cwd", "apps/api", "start"]

FROM base AS worker
CMD ["bun", "run", "--cwd", "apps/worker", "start"]

FROM base AS web-build
ARG OPENGENI_DEPLOYMENT_REVISION=dev
ENV VITE_OPENGENI_DEPLOYMENT_REVISION=$OPENGENI_DEPLOYMENT_REVISION
RUN bun run --cwd apps/web build

FROM web-build AS web
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/web", "start"]
