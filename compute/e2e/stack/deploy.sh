#!/usr/bin/env bash
# Deploys, on the stack VM, Opengeni and its fleet service with the chart
# from COMPUTE_SHA and the images build.sh made (env.sh deploy):
#   - generated secrets, kept in ~/e2e/secrets across deploys;
#   - the chart (release og, namespace opengeni) with its Postgres,
#     Temporal, NATS (auth callout) and Garage fixtures, the relay, the
#     compute backend as the deployment's default, and computeControl:
#     its own schema and role in that Postgres, API over HTTPS from an e2e
#     authority Opengeni trusts, the hosts endpoint as a NodePort with the
#     fleet authority's certificate, an Ed25519 link key and Opengeni's
#     team link, the fleet's archive and group;
#   - Caddy in front, with Let's Encrypt certificates for sslip.io names of
#     the VM's address: opengeni.<ip> (web and API, the agent gateway),
#     relay.<ip> and files.<ip> (object storage).
# A model's settings (env.sh model-up) arrive on stdin. Waits until the
# fleet service reports HOSTS hosts.
set -euo pipefail
: "${STACK_IP:?}" "${HOSTS:?}" "${ZONE:?}" "${HOSTS_PORT:?}"
export PATH=$HOME/.cargo/bin:$HOME/.bun/bin:/snap/bin:$PATH
# shellcheck disable=SC1091
. "$HOME/e2e/out/build.env"
fleet=$HOME/e2e/fleet
sec=$HOME/e2e/secrets
chart=/srv/e2e/compute/deploy/helm/opengeni
ns=opengeni
release=og
full=$release-opengeni
domain=$(printf '%s' "$STACK_IP" | tr . -).sslip.io
app=opengeni.$domain
relay=relay.$domain
files=files.$domain
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
k() { kubectl -n "$ns" "$@"; }
mkdir -p "$sec"
chmod 700 "$sec"
umask 077

model=$(cat)
if [ -n "$model" ]; then printf '%s\n' "$model" >"$sec/model.env"; fi

log "secrets"
gen() { [ -s "$sec/$1" ] || openssl rand -hex 32 >"$sec/$1"; }
for name in postgres app-db compute-db delegation stream relay enrollment nats-control nats-callout \
  compute-opengeni-key compute-operator-key; do
  gen "$name"
done
[ -s "$sec/link.pem" ] || openssl genpkey -algorithm ed25519 -out "$sec/link.pem" 2>/dev/null
if [ ! -s "$sec/nats-seed" ]; then
  docker run --rm --entrypoint bun "opengeni-api:$OPENGENI_TAG" -e '
    import { nkeys } from "@opengeni/events";
    const account = nkeys.createAccount();
    console.log(new TextDecoder().decode(account.getSeed()) + "\t" + account.getPublicKey());' |
    tee >(cut -f1 >"$sec/nats-seed") | cut -f2 >"$sec/nats-public"
  sleep 1
fi
# The fleet service's API certificate, from an authority of this
# environment that Opengeni's pods trust.
if [ ! -s "$sec/api-ca.pem" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
    -keyout "$sec/api-ca.key" -out "$sec/api-ca.pem" -subj "/CN=compute e2e API authority" 2>/dev/null
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$sec/api.key" \
    -out "$sec/api.csr" -subj "/CN=$full-compute-control.$ns.svc" 2>/dev/null
  openssl x509 -req -in "$sec/api.csr" -CA "$sec/api-ca.pem" -CAkey "$sec/api-ca.key" -CAcreateserial \
    -days 30 -out "$sec/api.pem" 2>/dev/null -extfile <(printf 'subjectAltName=DNS:%s,DNS:%s\nextendedKeyUsage=serverAuth\n' \
    "$full-compute-control.$ns.svc" "$full-compute-control.$ns.svc.cluster.local")
fi

kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# Each Secret from a directory of one file per key: no value on a command
# line.
pg=$full-postgres
put() { mkdir -p "$sec/k8s/$1" && printf '%s' "$3" >"$sec/k8s/$1/$2"; }
secret() { k create secret generic "$1" --from-file="$sec/k8s/$1" --dry-run=client -o yaml | k apply -f - >/dev/null; }
rm -rf "$sec/k8s"
put opengeni-runtime OPENGENI_DELEGATION_SECRET "$(cat "$sec/delegation")"
put opengeni-runtime OPENGENI_STREAM_TOKEN_SECRET "$(cat "$sec/stream")"
put opengeni-runtime OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET "$(cat "$sec/relay")"
put opengeni-runtime OPENGENI_ENROLLMENT_SIGNING_SECRET "$(cat "$sec/enrollment")"
put opengeni-runtime OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED "$(cat "$sec/nats-seed")"
put opengeni-runtime OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY "$(cat "$sec/nats-public")"
put opengeni-runtime OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD "$(cat "$sec/nats-control")"
put opengeni-runtime OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD "$(cat "$sec/nats-callout")"
put opengeni-runtime OPENGENI_COMPUTE_API_KEY "$(cat "$sec/compute-opengeni-key")"
put opengeni-runtime OPENGENI_DATABASE_URL "postgres://opengeni_app:$(cat "$sec/app-db")@$pg:5432/opengeni"
if [ -s "$sec/model.env" ]; then
  # shellcheck disable=SC1091
  . "$sec/model.env"
  put opengeni-runtime OPENGENI_AZURE_OPENAI_API_KEY "$AZURE_OPENAI_API_KEY"
fi
put opengeni-migrations OPENGENI_MIGRATIONS_DATABASE_URL "postgres://opengeni:$(cat "$sec/postgres")@$pg:5432/opengeni"
put opengeni-migrations OPENGENI_APP_DATABASE_PASSWORD "$(cat "$sec/app-db")"
put opengeni-postgres POSTGRES_PASSWORD "$(cat "$sec/postgres")"
put compute-db COMPUTE_DATABASE_PASSWORD "$(cat "$sec/compute-db")"
put compute-keys keys "$(printf 'opengeni %s\noperator %s' "$(cat "$sec/compute-opengeni-key")" "$(cat "$sec/compute-operator-key")")"
put compute-link link.pem "$(cat "$sec/link.pem")"
put compute-hosts-tls tls.crt "$(cat "$fleet/control_certificate_pem")"
put compute-hosts-tls tls.key "$(cat "$fleet/control_private_key_pem")"
put compute-hosts-tls ca.crt "$(cat "$fleet/fleet_ca_pem")"
put compute-api-tls tls.crt "$(cat "$sec/api.pem")"
put compute-api-tls tls.key "$(cat "$sec/api.key")"
put compute-api-tls ca.crt "$(cat "$sec/api-ca.pem")"
for name in "$sec"/k8s/*; do secret "$(basename "$name")"; done

log "values"
jq -n --arg app "$app" --arg relay "$relay" --arg files "$files" --arg ogtag "$OPENGENI_TAG" \
  --arg cmtag "$COMPUTE_TAG" --arg archive "$(cat "$fleet/archive")" --arg group "$(cat "$fleet/host_group")" \
  --arg sandbox "$SANDBOX_IMAGE" --arg desktop "$DESKTOP_IMAGE" --arg hosts "$HOSTS" \
  --argjson port "$HOSTS_PORT" --arg model "${MODEL_DEPLOYMENT:-}" --arg base "${AZURE_OPENAI_BASE_URL:-}" '
  def img($r): {repository: $r, tag: $ogtag, pullPolicy: "IfNotPresent"};
  {
    global: {imageRegistry: ""},
    secret: {existingSecret: "opengeni-runtime"},
    migrations: {image: img("opengeni-api"), secret: {existingSecret: "opengeni-migrations"}},
    api: {image: img("opengeni-api")},
    worker: {image: img("opengeni-worker")},
    web: {image: img("opengeni-web")},
    relay: {enabled: true, replicaCount: 1, image: img("opengeni-relay")},
    postgres: {enabled: true, auth: {existingSecret: "opengeni-postgres"},
      runtime: {existingSecret: "opengeni-runtime"}},
    temporal: {enabled: true, postgres: {existingSecret: "opengeni-postgres"}},
    nats: {enabled: true, authCallout: {enabled: true}},
    garage: {enabled: true, publicEndpoint: "https://\($files)", sandboxEndpoint: "https://\($files)"},
    selfhosted: {enabled: true, relayUrl: "wss://\($relay)"},
    config: ({
      OPENGENI_SANDBOX_BACKEND: "compute",
      OPENGENI_SANDBOX_DESKTOP_ENABLED: "true",
      OPENGENI_PUBLIC_BASE_URL: "https://\($app)",
      OPENGENI_WEB_BASE_URL: "https://\($app)",
      OPENGENI_WEB_ALLOWED_HOSTS: $app,
      OPENGENI_COMPUTE_IMAGE: "opengeni",
      OPENGENI_COMPUTE_DESKTOP_IMAGE: "opengeni-desktop"
    } + (if $model == "" then {} else {
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_AZURE_OPENAI_BASE_URL: $base,
      OPENGENI_OPENAI_ALLOWED_MODELS: $model,
      OPENGENI_OPENAI_MODEL: $model
    } end)),
    computeControl: {
      enabled: true,
      image: {repository: "opengeni-compute-control", tag: $cmtag, pullPolicy: "IfNotPresent"},
      database: {existingSecret: "compute-db"},
      keys: {existingSecret: "compute-keys"},
      hostsTls: {secretName: "compute-hosts-tls"},
      apiTls: {secretName: "compute-api-tls"},
      link: {existingSecret: "compute-link"},
      teamLinks: {opengeni: "wss://\($app)/v1/compute/agent-link"},
      archive: $archive,
      storedImages: {opengeni: $sandbox, "opengeni-desktop": $desktop},
      gcpGroup: $group,
      extraArgs: ["--scale-min=\($hosts)"],
      hostsService: {type: "NodePort", nodePort: $port}
    }
  }' >"$HOME/e2e/values.json"

log "helm upgrade --install $release ($chart at $COMPUTE_SHA, images $OPENGENI_TAG)"
helm upgrade --install "$release" "$chart" -n "$ns" -f "$HOME/e2e/values.json" --wait --timeout 25m

log "Caddy for $app, $relay and $files"
ip() { k get svc "$1" -o jsonpath='{.spec.clusterIP}'; }
port() { k get svc "$1" -o jsonpath="{.spec.ports[?(@.name==\"$2\")].port}"; }
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$app {
	@api path /v1/* /healthz /install.sh /install.ps1 /uninstall.sh /opengeni-agent-minisign.pub /agent/* /.well-known/*
	reverse_proxy @api $(ip "$full-api"):$(port "$full-api" http)
	reverse_proxy $(ip "$full-web"):$(port "$full-web" http)
}
$relay {
	reverse_proxy $(ip "$full-relay"):$(k get svc "$full-relay" -o jsonpath='{.spec.ports[0].port}')
}
$files {
	reverse_proxy $(ip "$full-garage"):3900
}
EOF
sudo systemctl reload caddy || sudo systemctl restart caddy
for _ in $(seq 60); do curl -fsS "https://$app/healthz" >/dev/null 2>&1 && break; sleep 5; done
curl -fsS "https://$app/healthz" >/dev/null

log "waiting for $HOSTS hosts"
key=$(cat "$sec/compute-operator-key")
k port-forward "svc/$full-compute-control" 18080:8080 >/dev/null 2>&1 &
forward=$!
trap 'kill $forward 2>/dev/null || true' EXIT
sleep 3
for _ in $(seq 120); do
  count=$(curl -fsS --cacert "$sec/api-ca.pem" --resolve "$full-compute-control.$ns.svc:18080:127.0.0.1" \
    -H "X-API-Key: $key" "https://$full-compute-control.$ns.svc:18080/v1/hosts" 2>/dev/null |
    jq '[.[] | select(.state == "live")] | length' 2>/dev/null || echo 0)
  [ "${count:-0}" -ge "$HOSTS" ] && break
  sleep 10
done
log "hosts ready: ${count:-0} of $HOSTS"
cat >"$HOME/e2e/endpoints.env" <<EOF
OPENGENI_URL=https://$app
RELAY_URL=wss://$relay
FILES_URL=https://$files
COMPUTE_SERVICE=$full-compute-control.$ns.svc
EOF
log "Opengeni at https://$app"
