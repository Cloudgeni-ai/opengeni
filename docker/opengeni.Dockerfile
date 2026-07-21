FROM oven/bun:1.3.13 AS base

WORKDIR /app

ARG OPENGENI_SERVER_VERSION
ENV OPENGENI_SERVER_VERSION=$OPENGENI_SERVER_VERSION

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY examples/northstar-support/package.json examples/northstar-support/package.json
COPY packages/agent-proto/package.json packages/agent-proto/package.json
COPY packages/codex/package.json packages/codex/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/deployment/package.json packages/deployment/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/github/package.json packages/github/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/react/package.json packages/react/package.json
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
# "The agent ships inside the control-plane": the SIGNED per-SHA opengeni-agent
# Linux musl binaries (+ .sha256/.minisig) are staged into agent/install/baked/ by
# the CI step scripts/bake-agent.sh BEFORE this build, and arrive in the image via
# the `COPY --chown=bun:bun . .` above. The API serves them from /agent/* (see
# apps/api/src/routes/install.ts), so a fresh machine installs an agent that matches
# THIS control plane exactly. The signing key never enters this build — signing is
# done in the pre-build CI step. When nothing is baked (a plain `docker build`),
# agent/install/baked/ holds only its placeholder and /agent/* 302-redirects to the
# GitHub Release (the public archive + install.sh fallback). No Dockerfile change is
# needed to switch between the two: it is purely whether the baked files are present.
EXPOSE 8000
CMD ["bun", "run", "--cwd", "apps/api", "start"]

FROM base AS worker
# The docker sandbox backend needs the Docker CLI to talk to the mounted host
# daemon socket. Install the client only; the daemon remains outside this image.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*
USER bun
CMD ["bun", "run", "--cwd", "apps/worker", "start"]

FROM base AS web-build
ARG OPENGENI_DEPLOYMENT_REVISION=dev
ENV VITE_OPENGENI_DEPLOYMENT_REVISION=$OPENGENI_DEPLOYMENT_REVISION
RUN bun run --cwd apps/web build

FROM web-build AS web
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/web", "start"]
