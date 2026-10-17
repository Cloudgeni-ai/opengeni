#!/usr/bin/env bash
# Runs the E2B conformance suite against a real fleet on this machine: the
# fleet service with its E2B front door serving HTTPS, one host agent in
# the fleet with its guard, real Firecracker VMs booted from the public
# Opengeni sandbox image and a minimal image, and object storage. Then the
# unchanged E2B JS SDK, the E2B client Opengeni uses and the E2B-style
# smoke scenarios run against the front door. See README.md.
#
# Run as root on a lab host (../../lab/host-setup.sh), with node 22 and
# python 3.10 or later on PATH:
#
#   CONTROL_BIN=target/release/compute-control HOST_BIN=target/release/compute-host \
#     GUEST=~/guest-out sudo -E conformance/e2b/run.sh
#
# Settings (environment):
#   LAB        the lab directory: bin/firecracker, bin/jailer, vmlinux (/lab)
#   GUEST      the directory guest/build.sh made (required)
#   HOST_BIN, CONTROL_BIN  the two binaries (required)
#   PROFILE    the host's memory profile, `nested` or `bare-metal` (host's choice)
#   STORE      object storage for the host, such as gs://bucket/prefix; by
#              default a local Azurite emulator, which the suite starts
#   WORK       scratch directory ($LAB/t/e2b-conformance)
#   RESULTS    where results and measurements go ($WORK/results)
#   SUITES     which suites run: any of `sdk headers adapter smoke` (all)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
LAB=${LAB:-/lab}
WORK=${WORK:-$LAB/t/e2b-conformance}
RESULTS=${RESULTS:-$WORK/results}
SUITES=${SUITES:-sdk headers adapter smoke}
: "${GUEST:?set GUEST to the directory guest/build.sh made}"
: "${HOST_BIN:?set HOST_BIN to compute-host}"
: "${CONTROL_BIN:?set CONTROL_BIN to compute-control}"
HOST_BIN=$(realpath "$HOST_BIN")
CONTROL_BIN=$(realpath "$CONTROL_BIN")

DOMAIN=e2b.test
CGROUP=/sys/fs/cgroup/compute-e2b
API=127.0.0.1:18080
HOSTS=127.0.0.1:18443
FLEET_LISTEN=127.0.0.1:17443
FRONT=127.0.0.1:443
SANDBOX_IMAGE=ghcr.io/cloudgeni-ai/opengeni-sandbox:0.20.0
MINIMAL_IMAGE=busybox:1.37

pids=()
cleanup() {
  local status=$?
  # The host first, so it stops its VMs while its guard still runs.
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  sleep 2
  for pid in "${pids[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
  if [[ -d $CGROUP ]]; then
    for vm in "$CGROUP"/*/; do [[ -f $vm/cgroup.kill ]] && echo 1 > "$vm/cgroup.kill" || true; done
  fi
  echo "logs and results: $WORK"
  exit "$status"
}
trap cleanup EXIT

say() { printf '== %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

rm -rf "$WORK/state" "$WORK/run" "$WORK/azurite"
mkdir -p "$WORK/tls" "$WORK/run" "$RESULTS"
cd "$HERE"

say "installing the pinned clients"
[[ -d node_modules ]] || npm install --no-audit --no-fund --loglevel=error

if [[ -z ${STORE:-} ]]; then
  if (exec 3<>/dev/tcp/127.0.0.1/10000) 2>/dev/null; then
    echo "port 10000 is taken; stop what holds it, or set STORE" >&2
    exit 1
  fi
  say "starting Azurite for object storage"
  node_modules/.bin/azurite-blob --silent --skipApiVersionCheck --location "$WORK/azurite" \
    --blobHost 127.0.0.1 --blobPort 10000 > "$WORK/azurite.log" 2>&1 &
  pids+=($!)
  export AZURE_STORAGE_USE_EMULATOR=true
  STORE="az://conformance/run-$(date +%s)"
  node --input-type=module -e '
    import { BlobServiceClient } from "@azure/storage-blob";
    const service = BlobServiceClient.fromConnectionString("UseDevelopmentStorage=true");
    for (let i = 0; ; i += 1) {
      try { await service.getContainerClient("conformance").createIfNotExists(); break; }
      catch (error) { if (i > 50) throw error; await new Promise((r) => setTimeout(r, 200)); }
    }'
fi

say "making certificates"
(
  cd "$WORK/tls"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
    -keyout ca.key -out ca.pem -subj "/CN=conformance authority" \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign 2>/dev/null
  issue() {
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$1.key" \
      -out "$1.csr" -subj "/CN=$1" 2>/dev/null
    printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth,clientAuth\nbasicConstraints=CA:FALSE\n' \
      "$2" > "$1.ext"
    openssl x509 -req -in "$1.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
      -extfile "$1.ext" -out "$1.pem" 2>/dev/null
  }
  issue service "DNS:localhost,IP:127.0.0.1"
  issue h1 "DNS:h1,IP:127.0.0.1"
  issue front "DNS:api.$DOMAIN,DNS:*.$DOMAIN"
)

say "building images"
build() {
  local name=$1 reference=$2
  shift 2
  local started
  started=$(date +%s.%N)
  "$HOST_BIN" build-image "$reference" --guest "$GUEST" --output "$WORK/$name.ext4" "$@" \
    > "$RESULTS/image-$name.json"
  node -e 'const fs=require("fs"); const [file, started] = process.argv.slice(1);
    const built = JSON.parse(fs.readFileSync(file)); built.buildSeconds = Date.now()/1000 - Number(started);
    fs.writeFileSync(file, JSON.stringify(built, null, 2)); console.log(built.image);' \
    "$RESULTS/image-$name.json" "$started"
}
build sandbox "$SANDBOX_IMAGE" > /dev/null
MINIMAL_ID=$(build minimal "$MINIMAL_IMAGE" --store "$STORE")

KEY=e2b_$(openssl rand -hex 20)
OPERATOR_KEY=op_$(openssl rand -hex 20)
printf 'conformance %s\noperator %s\n' "$KEY" "$OPERATOR_KEY" > "$WORK/run/keys"

say "starting the fleet service"
RUST_LOG=${RUST_LOG:-info} "$CONTROL_BIN" serve --database memory \
  --api "$API" --hosts "$HOSTS" \
  --cert "$WORK/tls/service.pem" --key "$WORK/tls/service.key" --host-ca "$WORK/tls/ca.pem" \
  --archive "$STORE" --keys-file "$WORK/run/keys" \
  --stored-image "minimal=$MINIMAL_ID" \
  --e2b-listen "$FRONT" --e2b-domain "$DOMAIN" \
  --e2b-tls-cert "$WORK/tls/front.pem" --e2b-tls-key "$WORK/tls/front.key" \
  --e2b-template base=base:2x1024 --e2b-template minimal=minimal:1x512 \
  > "$WORK/control.log" 2>&1 &
pids+=($!)

say "starting the host's guard and agent"
profile=()
[[ -n ${PROFILE:-} ]] && profile=(--memory-profile "$PROFILE")
"$HOST_BIN" guard --cgroup "$CGROUP" --lease-file "$WORK/run/lease.json" \
  --lock "$WORK/run/guard.lock" --suspending "$WORK/run/suspending" --watchdog none \
  > "$WORK/guard.log" 2>&1 &
pids+=($!)
RUST_LOG=${RUST_LOG:-info} "$HOST_BIN" --socket "$WORK/run/agent.sock" serve \
  --root "$WORK/state" --firecracker "$LAB/bin/firecracker" --jailer "$LAB/bin/jailer" \
  --kernel "$LAB/vmlinux" --base-image "$WORK/sandbox.ext4" --cgroup "$CGROUP" \
  --network --restore-notice-port 53 --template-ready-port 54 --template 2x1024:1 \
  --store "$STORE" "${profile[@]}" \
  --fleet-control "https://localhost:${HOSTS##*:}" --fleet-name h1 \
  --fleet-address "$FLEET_LISTEN" --fleet-listen "$FLEET_LISTEN" \
  --fleet-cert "$WORK/tls/h1.pem" --fleet-key "$WORK/tls/h1.key" --fleet-ca "$WORK/tls/ca.pem" \
  --fleet-lease-file "$WORK/run/lease.json" --fleet-guard-lock "$WORK/run/guard.lock" \
  > "$WORK/host.log" 2>&1 &
pids+=($!)

say "waiting for the host to join and its warm sandbox to be ready"
for i in $(seq 1 300); do
  if curl -fsS -H "X-API-Key: $OPERATOR_KEY" "http://$API/v1/hosts" 2>/dev/null \
    | grep -q '"h1"'; then
    break
  fi
  [[ $i == 300 ]] && { echo "the host never joined"; tail -20 "$WORK/host.log"; exit 1; }
  sleep 1
done

export E2B_API_KEY=$KEY E2B_DOMAIN=$DOMAIN E2B_API_URL="https://api.$DOMAIN"
export NODE_EXTRA_CA_CERTS=$WORK/tls/ca.pem CONFORMANCE_DOMAIN=$DOMAIN
export CONFORMANCE_FLEET_API="http://$API" CONFORMANCE_RESULTS=$RESULTS
export CONFORMANCE_HOST_STATUS="$HOST_BIN --socket $WORK/run/agent.sock status"
export NODE_OPTIONS="--require $HERE/resolve.cjs"

failed=0
for suite in $SUITES; do
  say "suite $suite"
  case $suite in
    sdk) node sdk.mjs || failed=1 ;;
    headers) E2B_SANDBOX_URL="https://api.$DOMAIN" CONFORMANCE_PART=headers node sdk.mjs || failed=1 ;;
    adapter) node adapter.mjs || failed=1 ;;
    smoke)
      (cd ../../smoke && COMPUTE_SMOKE_TARGET=e2b SSL_CERT_FILE=$WORK/tls/ca.pem \
        COMPUTE_SMOKE_E2B_ADDRESS=127.0.0.1 COMPUTE_SMOKE_SOCKET=$WORK/run/agent.sock \
        python3 -m compute_smoke run --category ecw) || failed=1 ;;
    *) echo "unknown suite $suite"; failed=1 ;;
  esac
done
if [[ $failed == 0 ]]; then say "CONFORMANCE_PASSED"; else say "CONFORMANCE_FAILED"; exit 1; fi
