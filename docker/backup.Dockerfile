# Independent operator utility: no application runtime, database driver or SDK.
ARG POSTGRES_MAJOR=18
ARG BUN_VERSION=1.4.3
# Bun trusts roots compiled into its own binary, apart from the OS store. Distrust
# the compromised emSign roots there once, natively on the build machine, for the
# target architecture's Bun (never executed here); every stage that runs or
# ships Bun copies this binary (see docker/distrust-embedded-roots.ts).
FROM oven/bun:${BUN_VERSION} AS bun-target
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS bun
COPY --from=bun-target /usr/local/bin/bun /out/bun
RUN --mount=type=bind,source=docker,target=/opt/opengeni-docker \
  bun /opt/opengeni-docker/distrust-embedded-roots.ts /opt/opengeni-docker/distrusted-roots.pem /out/bun
FROM postgres:${POSTGRES_MAJOR}-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends age rclone ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /out/bun /usr/local/bin/bun
WORKDIR /app
COPY scripts/backup.ts scripts/backup.ts
COPY scripts/backup/config.ts scripts/backup/process.ts scripts/backup/runner.ts scripts/backup/
RUN install -d -m 0700 -o 1000 -g 1000 /var/lib/opengeni-backup
USER 1000:1000
ENTRYPOINT ["bun", "/app/scripts/backup.ts"]
CMD ["--help"]
