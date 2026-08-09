FROM oven/bun:1.3.14 AS base

WORKDIR /app

ARG OPENGENI_SERVER_VERSION
ENV OPENGENI_SERVER_VERSION=$OPENGENI_SERVER_VERSION

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY examples/northstar-support/package.json examples/northstar-support/package.json
COPY packages/agent-proto/package.json packages/agent-proto/package.json
COPY packages/artifact-kernel-wasm-document/package.json packages/artifact-kernel-wasm-document/package.json
COPY packages/artifact-kernel-wasm-presentation/package.json packages/artifact-kernel-wasm-presentation/package.json
COPY packages/artifact-kernel-wasm-spreadsheet/package.json packages/artifact-kernel-wasm-spreadsheet/package.json
COPY packages/artifact-tool/package.json packages/artifact-tool/package.json
COPY packages/codex/package.json packages/codex/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/deployment/package.json packages/deployment/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/github/package.json packages/github/package.json
COPY packages/network/package.json packages/network/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/ogtool/package.json packages/ogtool/package.json
COPY packages/react/package.json packages/react/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/testing/package.json packages/testing/package.json
COPY patches patches

RUN bun install --frozen-lockfile

COPY --chown=bun:bun . .

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
USER bun

FROM base AS northstar-demo-build
RUN bun run --cwd examples/northstar-support build

FROM northstar-demo-build AS northstar-demo
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "--cwd", "examples/northstar-support", "start"]

# Shared exact artifact runtime for every server-side authority that opens the
# native kernel. Release automation must stage one verified bundle per OCI
# architecture at `.release/artifact-runtime/<amd64|arm64>/`. The bundle is
# root-owned/read-only, and both API and materializer image builds fail before
# publication if its complete release/install chain or facade probe is invalid.
FROM base AS artifact-runtime-base
ARG TARGETARCH
ARG OPENGENI_ARTIFACT_RUNTIME_BUNDLE=.release/artifact-runtime
USER root
RUN case "$TARGETARCH" in \
      amd64) expected_target=linux-x64-gnu ;; \
      arm64) expected_target=linux-arm64-gnu ;; \
      *) echo "unsupported artifact runtime OCI architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && printf '%s' "$expected_target" >/tmp/opengeni-artifact-runtime-target
RUN install -d -o root -g root -m 0555 /app/artifact-runtime
COPY --chown=root:root ${OPENGENI_ARTIFACT_RUNTIME_BUNDLE}/${TARGETARCH}/ /app/artifact-runtime/
RUN expected_target="$(cat /tmp/opengeni-artifact-runtime-target)" \
  && actual_target="$(bun -e 'const value=await Bun.file("/app/artifact-runtime/installation.json").json();process.stdout.write(typeof value.target==="string"?value.target:"")')" \
  && test "$actual_target" = "$expected_target" \
  || { echo "artifact runtime bundle target does not match OCI architecture" >&2; exit 1; }
RUN chmod -R a-w /app/artifact-runtime
ENV OPENGENI_ARTIFACT_RUNTIME_MANIFEST=/app/artifact-runtime/installation.json \
  OPENGENI_ARTIFACT_TOOL_ENTRY=/app/artifact-runtime/skill-facade-entry.mjs
USER bun
RUN bun packages/artifact-tool/src/runtime-cli-entry.ts doctor --json

FROM artifact-runtime-base AS api
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
USER bun
RUN bun scripts/build-runtime-processes.ts api
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
CMD ["bun", "apps/api/dist/process/index.js"]

FROM base AS worker
# The docker sandbox backend needs the Docker CLI to talk to the mounted host
# daemon socket. Interactive/cancellable commands use the Agents SDK's
# host-side Python PTY bridge, so Python must live in this worker image rather
# than only inside the sandbox. The daemon remains outside this image.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && /usr/bin/python3 -c 'import pty' \
  && rm -rf /var/lib/apt/lists/*
ENV OPENAI_AGENTS_PYTHON=/usr/bin/python3
USER bun
RUN bun scripts/build-runtime-processes.ts worker
CMD ["bun", "apps/worker/dist/process/index.js"]

# Dedicated durable live-hint outbox dispatcher. It has no native artifact
# runtime and authenticates with the narrow dispatcher-only PostgreSQL role.
FROM base AS artifact-outbox-dispatcher
ENV OPENGENI_ARTIFACT_OUTBOX_ENABLED=true \
  OPENGENI_ARTIFACT_OUTBOX_DATABASE_ROLE=opengeni_artifact_outbox_dispatcher \
  OPENGENI_ARTIFACT_OUTBOX_HTTP_PORT=9466
RUN bun scripts/build-runtime-processes.ts artifact-outbox
EXPOSE 9466
CMD ["bun", "apps/worker/dist/process/artifact-outbox/artifact-outbox-entry.js"]

# Dedicated artifact materializer image. It inherits the same exact runtime
# authority as API and never compiles, downloads, or substitutes kernel bytes.
FROM artifact-runtime-base AS artifact-materializer
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o bun -g bun -m 0755 /opt/opengeni/bin
USER bun
RUN bun build --compile packages/artifact-tool/src/materializer-cli-entry.ts \
  --outfile /opt/opengeni/bin/opengeni-artifact-materializer
USER root
RUN chown root:root /opt/opengeni/bin/opengeni-artifact-materializer \
  && chmod 0555 /opt/opengeni/bin/opengeni-artifact-materializer
USER bun
ENV OPENGENI_ARTIFACT_MATERIALIZER_ENABLED=true \
  OPENGENI_ARTIFACT_MATERIALIZER_EXECUTABLE=/opt/opengeni/bin/opengeni-artifact-materializer \
  OPENGENI_ARTIFACT_MATERIALIZER_BWRAP=/usr/bin/bwrap \
  OPENGENI_ARTIFACT_MATERIALIZER_PRLIMIT=/usr/bin/prlimit \
  OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_ROLE=opengeni_artifact_materializer \
  OPENGENI_ARTIFACT_MATERIALIZER_HTTP_PORT=9465
# Build-time load verifies the complete manifest/file chain and native ABI.
RUN /opt/opengeni/bin/opengeni-artifact-materializer --opengeni-materializer-identity-v1
RUN bun scripts/build-runtime-processes.ts artifact-materializer
EXPOSE 9465
CMD ["bun", "apps/worker/dist/process/artifact-materializer/artifact-materializer-entry.js"]

FROM base AS web-build
ARG OPENGENI_DEPLOYMENT_REVISION=dev
ENV VITE_OPENGENI_DEPLOYMENT_REVISION=$OPENGENI_DEPLOYMENT_REVISION
RUN bun run --cwd apps/web build

FROM web-build AS web
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/web", "start"]
