ARG BUN_VERSION=1.4.4
# Apply the shared embedded-root mitigation natively on the build machine to
# the target architecture's binary, without executing a foreign-architecture Bun.
FROM oven/bun:${BUN_VERSION} AS bun-target
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS bun-distrusted
COPY --from=bun-target /usr/local/bin/bun /out/bun
RUN --mount=type=bind,source=docker,target=/opt/opengeni-docker \
  bun /opt/opengeni-docker/distrust-embedded-roots.ts /opt/opengeni-docker/distrusted-roots.pem /out/bun

FROM oven/bun:${BUN_VERSION}-slim AS runtime
COPY --from=bun-distrusted /out/bun /usr/local/bin/bun
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown bun:bun /data
WORKDIR /app
COPY --chown=bun:bun scripts/merge-batcher/ ./scripts/merge-batcher/
USER bun
ENV BATCHER_MODE=shadow BATCHER_GIT_DIR=/data/objects.git BATCHER_OUTPUT_DIR=/data/shadow PORT=8080
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD bun -e 'const r=await fetch("http://127.0.0.1:"+(process.env.PORT||8080)+"/healthz");process.exit(r.ok?0:1)'
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "scripts/merge-batcher/main.ts"]
CMD ["run"]
