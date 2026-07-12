FROM docker:29.6.1-cli@sha256:862099ada15c669000bef53aa4cb9d821262829f45b0dda2159ccb276443043b AS docker-cli

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS dependencies

WORKDIR /app

# OS packages are independent of the JavaScript lockfile. Keep this layer ahead
# of dependency manifests so an ordinary package update never repeats apt work.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
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

RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile

FROM dependencies AS source

ARG OPENGENI_SERVER_VERSION
ENV OPENGENI_SERVER_VERSION=$OPENGENI_SERVER_VERSION

COPY --chown=bun:bun . .

ENV NODE_ENV=production
USER bun

FROM source AS api
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

FROM source AS worker
# The docker sandbox backend needs the Docker CLI to talk to the mounted host
# daemon socket. Copy the immutable official client and CLI plugins only; the
# daemon remains outside this image and no floating apt repository participates
# in a same-SHA rebuild.
USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
USER bun
CMD ["bun", "run", "--cwd", "apps/worker", "start"]

FROM source AS web-build
ARG OPENGENI_DEPLOYMENT_REVISION=dev
ENV VITE_OPENGENI_DEPLOYMENT_REVISION=$OPENGENI_DEPLOYMENT_REVISION
RUN bun run --cwd apps/web build

FROM web-build AS web
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/web", "start"]
