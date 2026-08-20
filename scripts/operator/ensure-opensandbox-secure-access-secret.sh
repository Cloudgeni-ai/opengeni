#!/usr/bin/env bash
set -euo pipefail

# Idempotently create the OSEP-0011 signing-key Secret on the cluster.
# Never prints key material. Does not overwrite an existing Secret.

namespace="${1:-opensandbox-system}"
secret_name="${2:-opensandbox-secure-access}"

if kubectl -n "$namespace" get secret "$secret_name" >/dev/null 2>&1; then
  echo "secret ${secret_name} already exists in ${namespace}"
  exit 0
fi

keys="${OPENGENI_OPENSANDBOX_SECURE_ACCESS_KEYS:-}"
active="${OPENGENI_OPENSANDBOX_SECURE_ACCESS_ACTIVE_KEY:-a}"
if [ -z "$keys" ]; then
  keys="a=$(openssl rand -base64 32 | tr -d '\n')"
fi

kubectl -n "$namespace" create secret generic "$secret_name" \
  --from-literal=keys="$keys" \
  --from-literal=active-key="$active"
