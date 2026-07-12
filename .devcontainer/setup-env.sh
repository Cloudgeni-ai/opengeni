#!/usr/bin/env bash
# Prepare .env for `bun run dev`. Outside Codespaces this only seeds .env from
# .env.example. Inside Codespaces it also points the web console, Vite host
# allowlist, and API CORS at the Codespace's forwarded hostnames, because the
# browser reaches the dev stack through https://<codespace>-<port>.<domain>
# instead of 127.0.0.1.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ -f .env ] || cp .env.example .env

if [ -z "${CODESPACES:-}" ] || [ -z "${CODESPACE_NAME:-}" ]; then
  exit 0
fi

domain="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
web_host="${CODESPACE_NAME}-3000.${domain}"
api_url="https://${CODESPACE_NAME}-8000.${domain}"
escaped_web_host="${web_host//./\\.}"

set_env() {
  local key="$1" value="$2"
  grep -v "^${key}=" .env > .env.tmp || true
  mv .env.tmp .env
  printf '%s=%s\n' "$key" "$value" >> .env
}

set_env VITE_API_BASE_URL "$api_url"
set_env OPENGENI_WEB_ALLOWED_HOSTS "$web_host"
set_env OPENGENI_CORS_ALLOW_ORIGIN_REGEX "'^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?\$|^https://${escaped_web_host}\$'"

echo "Codespaces .env configured: web https://${web_host} -> api ${api_url}"
echo "Run 'bun run dev' to start the stack, then make port 8000 Public in the Ports panel."
