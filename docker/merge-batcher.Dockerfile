FROM oven/bun:1.4.3-slim
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
