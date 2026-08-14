#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1090
source "$repo_root/deploy/stacks/opensandbox-source.lock"

controller_tag="docker.io/opensandbox/controller:v0.2.0"
server_tag="docker.io/opensandbox/server:v0.2.2"

sed \
  -e "s|${controller_tag}|${OPENSANDBOX_CONTROLLER_IMAGE}|g" \
  -e "s|${server_tag}|${OPENSANDBOX_SERVER_IMAGE}|g"