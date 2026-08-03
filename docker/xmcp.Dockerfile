# syntax=docker/dockerfile:1.7

# Builds the official X XMCP source at a fixed upstream commit. The source is
# fetched by immutable Git revision and archive checksum rather than copied
# into OpenGeni.
FROM python:3.12-slim

ARG XMCP_REVISION=63d34362d88ed9f94d54ccd5ecd5bb4d12e11759
ARG XMCP_ARCHIVE_SHA256=c971b3339291869fc9f74334d794862c8b528e2091f0116cc55e77c291c61578

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000 \
    X_API_DEBUG=0 \
    X_OAUTH_PRINT_AUTH_HEADER=0

WORKDIR /opt/xmcp

ADD --checksum=sha256:${XMCP_ARCHIVE_SHA256} https://github.com/xdevplatform/xmcp/archive/${XMCP_REVISION}.tar.gz /tmp/xmcp.tar.gz
COPY docker/xmcp-entrypoint.py /opt/xmcp-entrypoint.py

RUN set -eux; \
    tar -xzf /tmp/xmcp.tar.gz --strip-components=1 -C /opt/xmcp; \
    rm -f /tmp/xmcp.tar.gz; \
    python -m pip install --no-cache-dir -r /opt/xmcp/requirements.txt; \
    rm -rf /root/.cache

RUN groupadd --system --gid 65532 xmcp \
    && useradd --system --uid 65532 --gid 65532 --home-dir /nonexistent --shell /usr/sbin/nologin xmcp \
    && chown -R 65532:65532 /opt/xmcp

USER 65532:65532
EXPOSE 8000
CMD ["python", "/opt/xmcp-entrypoint.py"]