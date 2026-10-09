# Independent operator utility: no application runtime, database driver or SDK.
ARG POSTGRES_MAJOR=17
FROM oven/bun:1.4.0 AS bun
FROM postgres:${POSTGRES_MAJOR}-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends age rclone ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY scripts/backup.ts scripts/backup.ts
COPY scripts/backup/config.ts scripts/backup/process.ts scripts/backup/runner.ts scripts/backup/
RUN install -d -m 0700 -o 1000 -g 1000 /var/lib/opengeni-backup
USER 1000:1000
ENTRYPOINT ["bun", "/app/scripts/backup.ts"]
CMD ["--help"]
