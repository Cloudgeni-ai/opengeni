# The GKE side's sandbox image: our lab guest's root filesystem, plus Agent
# Sandbox's Python runtime server, which is how its router runs a command.
# The server's libraries live apart from the image's own Python packages and
# only the server sees them. `image.sh` builds it.
ARG BASE
FROM python:3.12-slim AS libs
RUN pip install --no-cache-dir --target /opt/runtime-libs \
    fastapi==0.138.0 uvicorn==0.49.0 python-multipart==0.0.32 starlette==1.6.0 \
    pydantic==2.13.4 pydantic-core==2.46.4 anyio==4.14.2 h11==0.16.0 click==8.4.1 \
    idna==3.18 typing-extensions==4.15.0 typing-inspection==0.4.2 \
    annotated-types==0.7.0 annotated-doc==0.0.4

FROM ${BASE}
COPY --from=libs /opt/runtime-libs /opt/runtime-libs
COPY main.py /opt/runtime/main.py
RUN mkdir -p /app && chown 1000:1000 /app
USER 1000
WORKDIR /app
ENV SANDBOX_BASE_DIR=/app
EXPOSE 8888
CMD ["python3", "-c", "import sys; sys.path[:0] = ['/opt/runtime', '/opt/runtime-libs']; import uvicorn; uvicorn.run('main:app', host='0.0.0.0', port=8888, log_level='warning')"]
