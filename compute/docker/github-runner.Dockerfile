# syntax=docker/dockerfile:1.7
# A GitHub Actions runner for compute's runner pools (ADR 23): GitHub's own
# runner image, a Docker engine for jobs, and a command that starts the
# runner with the just-in-time configuration a pool gives each sandbox.
# Build context: the compute/ directory.
#
#   docker build -f docker/github-runner.Dockerfile -t github-runner .
#
# A pool's base template is this image, or one built FROM it with a
# project's own tools; its warm templates are saved from sandboxes of it.
# Jobs run as `runner` (uid 1001, passwordless sudo, in the docker group)
# in /home/runner/_work, as on GitHub's own runners.
ARG RUNNER_VERSION=2.338.2

FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}
USER root
# Docker's engine from Docker's repository, signed by its key; the image
# carries the client already.
RUN set -eux; \
  apt-get update -qq; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git git-lfs gnupg iptables jq unzip util-linux xz-utils zip zstd >/dev/null; \
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; \
  . /etc/os-release; \
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list; \
  apt-get update -qq; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    containerd.io docker-buildx-plugin docker-ce docker-ce-cli docker-compose-plugin >/dev/null; \
  rm -rf /var/lib/apt/lists/*; \
  usermod -aG docker runner; \
  docker --version; dockerd --version
COPY --chmod=0755 docker/github-runner-start.sh /usr/local/bin/compute-runner-start
CMD ["/usr/local/bin/compute-runner-start"]
