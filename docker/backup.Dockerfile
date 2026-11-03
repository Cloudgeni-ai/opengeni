# Independent operator utility: no application runtime, database driver or SDK.
ARG POSTGRES_MAJOR=18
ARG BUN_VERSION=1.4.4
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
ARG TARGETARCH
# restic stores, deduplicates, compresses and encrypts the dumps. Pinned static
# release binary, verified against the published SHA-256 per architecture.
ARG RESTIC_VERSION=0.19.1
ARG RESTIC_SHA256_AMD64=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c
ARG RESTIC_SHA256_ARM64=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465
RUN apt-get update \
    && apt-get install -y --no-install-recommends bzip2 ca-certificates curl rclone util-linux \
    && case "$TARGETARCH" in \
         amd64) sha="$RESTIC_SHA256_AMD64" ;; \
         arm64) sha="$RESTIC_SHA256_ARM64" ;; \
         *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/restic.bz2 \
         "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${TARGETARCH}.bz2" \
    && echo "$sha  /tmp/restic.bz2" | sha256sum -c - \
    && bunzip2 -c /tmp/restic.bz2 > /usr/local/bin/restic \
    && chmod 0755 /usr/local/bin/restic \
    && rm /tmp/restic.bz2 \
    && apt-get purge -y --auto-remove curl bzip2 \
    && rm -rf /var/lib/apt/lists/* \
    && restic version
COPY --from=bun /out/bun /usr/local/bin/bun
WORKDIR /app
COPY scripts/backup.ts scripts/backup.ts
COPY scripts/backup/config.ts scripts/backup/process.ts scripts/backup/runner.ts scripts/backup/
RUN install -d -m 0700 -o 1000 -g 1000 /var/lib/opengeni-backup
USER 1000:1000
ENTRYPOINT ["bun", "/app/scripts/backup.ts"]
CMD ["--help"]
