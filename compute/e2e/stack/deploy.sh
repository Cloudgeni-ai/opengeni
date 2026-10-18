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
export KUBECONFIG=$HOME/.kube/config
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
# NATS over wss for Connected Machines (the connected-machine check); the
# hosts and their sandboxes reach Opengeni only over the agent link.
nats=nats.$domain
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
  # The auth callout's account key pair (seed, then public key).
  docker run --rm natsio/nats-box:0.20.0 nk -gen account -pubout >"$sec/nats-keys"
  sed -n 1p "$sec/nats-keys" >"$sec/nats-seed"
  sed -n 2p "$sec/nats-keys" >"$sec/nats-public"
  rm -f "$sec/nats-keys"
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

log "diagnostics sink"
# Opengeni exports a closed record of each failure rather than logging its
# causes; diagnostics.py keeps them in a file the suite copies into its runs.
internal=$(hostname -I | awk '{print $1}')
sudo tee /etc/systemd/system/e2e-diagnostics.service >/dev/null <<UNIT
[Unit]
Description=Opengeni failure diagnostics for the e2e environment
[Service]
User=$USER
ExecStart=/usr/bin/python3 $HOME/e2e/diagnostics.py $internal 4319 $HOME/e2e/diagnostics.jsonl
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable -q e2e-diagnostics
sudo systemctl restart e2e-diagnostics

log "values"
jq -n --arg app "$app" --arg relay "$relay" --arg files "$files" --arg nats "$nats" --arg ogtag "$OPENGENI_TAG" \
  --arg cmtag "$COMPUTE_TAG" --arg archive "$(cat "$fleet/archive")" --arg group "$(cat "$fleet/host_group")" \
  --argjson hostmib "$(cat "$fleet/host_memory_mib")" \
  --arg sandbox "$SANDBOX_IMAGE" --arg desktop "$DESKTOP_IMAGE" --arg hosts "$HOSTS" \
  --argjson port "$HOSTS_PORT" --arg model "${MODEL_DEPLOYMENT:-}" --arg base "${AZURE_OPENAI_BASE_URL:-}" \
  --arg diagnostics "http://$internal:4319" '
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
      args: ["-c", "max_connections=500"],
      runtime: {existingSecret: "opengeni-runtime"}},
    temporal: {enabled: true, postgres: {existingSecret: "opengeni-postgres"}},
    nats: {enabled: true, authCallout: {enabled: true}},
    garage: {enabled: true, publicEndpoint: "https://\($files)", sandboxEndpoint: "https://\($files)"},
    selfhosted: {enabled: true, relayUrl: "wss://\($relay)", natsUrl: "wss://\($nats)"},
    config: ({
      OPENGENI_SANDBOX_BACKEND: "compute",
      OPENGENI_SANDBOX_DESKTOP_ENABLED: "true",
      # The sandbox rollout controls of the managed deployment
      # (values.preview-managed.example.yaml): turns own the
      # sandbox lease, which enrolling a compute sandbox agent needs.
      OPENGENI_SANDBOX_OWNERSHIP_ENABLED: "true",
      OPENGENI_SANDBOX_LAZY_PROVISION: "true",
      OPENGENI_RIG_VERIFICATION_LEASE_OWNERSHIP_ENABLED: "false",
      OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
      OPENGENI_PUBLIC_BASE_URL: "https://\($app)",
      OPENGENI_WEB_BASE_URL: "https://\($app)",
      OPENGENI_WEB_ALLOWED_HOSTS: $app,
      OPENGENI_COMPUTE_IMAGE: "opengeni",
      OPENGENI_COMPUTE_DESKTOP_IMAGE: "opengeni-desktop",
      OPENGENI_OBSERVABILITY_DIAGNOSTICS_ENDPOINT: $diagnostics
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
      scaling: {hostMemoryMib: $hostmib, min: ($hosts | tonumber), max: (($hosts | tonumber) + 2)},
      hostsService: {type: "NodePort", nodePort: $port}
    }
  }' >"$HOME/e2e/values.json"

log "helm upgrade --install $release ($chart at $COMPUTE_SHA, images $OPENGENI_TAG)"
# No --wait: the chart migrates Opengeni's database in a post-install hook,
# which Helm would only run once every pod is ready, and the pods are not
# ready before the migrations. Helm still waits for the hook Jobs; the
# rollouts are awaited after. (compute-control's role and schema come from
# an ordinary Job of the release, which its pods wait for.)
helm upgrade --install "$release" "$chart" -n "$ns" -f "$HOME/e2e/values.json" --timeout 25m
for name in $(k get deploy -o name); do
  k rollout status "$name" --timeout 15m
done

log "Caddy for $app, $relay, $files and $nats"
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
$nats {
	reverse_proxy $(ip "$full-nats"):$(port "$full-nats" websocket)
}
EOF
sudo systemctl reload caddy || sudo systemctl restart caddy
for _ in $(seq 60); do curl -fsS "https://$app/healthz" >/dev/null 2>&1 && break; sleep 5; done
curl -fsS "https://$app/healthz" >/dev/null

log "waiting for $HOSTS hosts"
key=$(cat "$sec/compute-operator-key")
# The service's address on the cluster network, which the node reaches
# directly (a port-forward would stay bound to one replica as it rolls).
fabric=$(ip "$full-compute-control")
for _ in $(seq 120); do
  count=$(curl -fsS --cacert "$sec/api-ca.pem" --resolve "$full-compute-control.$ns.svc:8080:$fabric" \
    -H "X-API-Key: $key" "https://$full-compute-control.$ns.svc:8080/v1/hosts" 2>/dev/null |
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
