#!/usr/bin/env bash
# The end-to-end environment for Opengeni compute on Google Cloud: a whole
# Opengeni (the Helm chart on a one-node k3s, with its API, workers, web,
# relay, Postgres, Temporal, NATS and object storage) built from one
# commit, the fleet service (the chart's computeControl) and a host fleet
# from deploy/terraform/gcp-compute, and the suite in suite/ that drives
# real agent sessions through it. See README.md.
#
# Run it from a checkout (its compute/e2e) on a workstation with gcloud,
# terraform, ssh, rsync, jq, gh (to find a published API image) and, for the
# model, az:
#
#   PROJECT=p compute/e2e/env.sh up          # everything, idempotent
#   PROJECT=p compute/e2e/env.sh model-up    # a model deployment for the run
#   PROJECT=p compute/e2e/env.sh deploy      # hands it to Opengeni
#   PROJECT=p compute/e2e/env.sh suite       # the checks; results in $STATE/runs
#   PROJECT=p compute/e2e/env.sh model-down
#   PROJECT=p compute/e2e/env.sh down        # deletes everything up made
#
# Steps of up, each also runnable alone: infra (addresses, NAT, firewall,
# registry), fleet (terraform), stack (the VM and its tools), build (images,
# the host bundle and the stored sandbox images, from OPENGENI_REF and
# COMPUTE_REF), deploy (secrets, the chart, the public front). Also: status
# and ssh [command].
#
# Settings: PROJECT; ZONE (europe-west4-a); PREFIX (compute-e2e; every
# resource's name starts with it); LABELS (purpose=compute-e2e, as k=v,...);
# OPENGENI_REF, the commit Opengeni's images come from (origin/main);
# COMPUTE_REF, the commit of compute/ and the chart (this checkout's HEAD);
# both must be pushed to REPO_URL. HOSTS (3), HOST_MACHINE (n2-standard-8),
# STACK_MACHINE (n2-standard-32), SSH_FROM (this machine's address), STATE
# (~/.cache/compute-e2e/$PREFIX: Terraform state, keys and results, never in
# the repository). The model: AZURE_OPENAI_ACCOUNT, AZURE_OPENAI_GROUP,
# MODEL_NAME, MODEL_VERSION, MODEL_SKU (GlobalStandard), MODEL_CAPACITY.
set -euo pipefail

PROJECT=${PROJECT:?set PROJECT, the Google Cloud project}
ZONE=${ZONE:-europe-west4-a}
REGION=${ZONE%-*}
PREFIX=${PREFIX:-compute-e2e}
LABELS=${LABELS:-purpose=compute-e2e}
HOSTS=${HOSTS:-3}
HOST_MACHINE=${HOST_MACHINE:-n2-standard-8}
STACK_MACHINE=${STACK_MACHINE:-n2-standard-32}
REPO_URL=${REPO_URL:-https://github.com/Cloudgeni-ai/opengeni.git}
STATE=${STATE:-$HOME/.cache/compute-e2e/$PREFIX}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECKOUT=$(cd "$HERE/../.." && pwd)
STACK=$PREFIX-stack
USER_NAME=e2e
KEY=$STATE/id_e2e
# The image hosts build their base image from (sandboxes that name none).
BASE_IMAGE_REF=${BASE_IMAGE_REF:-docker.io/library/ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac}
# The fleet service's host endpoint on the stack VM: the chart's hosts
# Service as a NodePort.
HOSTS_PORT=30843

mkdir -p "$STATE"
chmod 700 "$STATE"
log() { printf '[e2e %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
g() { gcloud --project "$PROJECT" --quiet "$@"; }
exists() { "$@" >/dev/null 2>&1; }
sha() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
labels_json() {
  jq -cn --arg l "$LABELS" '$l | split(",") | map(select(length > 0) | split("=") | {(.[0]): .[1]}) | add // {}'
}
address() { g compute addresses describe "$1" --region "$REGION" --format='value(address)'; }
bucket() { printf '%s-archive-%s' "$PREFIX" "$(printf '%s' "$PROJECT" | sha | cut -c1-8)"; }
registry() { printf '%s-docker.pkg.dev/%s/%s' "$REGION" "$PROJECT" "$PREFIX"; }

resolve_refs() {
  OPENGENI_SHA=$(git -C "$CHECKOUT" rev-parse --verify "${OPENGENI_REF:-origin/main}^{commit}")
  COMPUTE_SHA=$(git -C "$CHECKOUT" rev-parse --verify "${COMPUTE_REF:-HEAD}^{commit}")
  printf 'OPENGENI_SHA=%s\nCOMPUTE_SHA=%s\n' "$OPENGENI_SHA" "$COMPUTE_SHA" >"$STATE/refs"
}

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o "UserKnownHostsFile=$STATE/known_hosts"
  -o LogLevel=ERROR -o ConnectTimeout=10 -o ServerAliveInterval=15)
stack_ip() {
  [ -f "$STATE/stack_ip" ] || address "$STACK-ip" >"$STATE/stack_ip"
  cat "$STATE/stack_ip"
}
on() { ssh "${SSH_OPTS[@]}" "$USER_NAME@$(stack_ip)" "$@"; }
copy_to() {
  local dest=$1
  shift
  scp -q "${SSH_OPTS[@]}" "$@" "$USER_NAME@$(stack_ip):$dest"
}
copy_from() { scp -q -r "${SSH_OPTS[@]}" "$USER_NAME@$(stack_ip):$1" "$2"; }
push_scripts() {
  on 'mkdir -p e2e/suite'
  copy_to e2e/ "$HERE"/stack/*
  copy_to e2e/suite/ "$HERE"/suite/*
}

# --- infra: addresses, Cloud NAT for the hosts, firewall, registry --------
infra() {
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "$USER_NAME" -f "$KEY"
  local from=${SSH_FROM:-$(curl -fsS https://api.ipify.org)/32}
  log "addresses"
  exists g compute addresses describe "$STACK-ip" --region "$REGION" ||
    g compute addresses create "$STACK-ip" --region "$REGION"
  exists g compute addresses describe "$STACK-internal" --region "$REGION" ||
    g compute addresses create "$STACK-internal" --region "$REGION" --subnet default
  exists g compute addresses describe "$PREFIX-nat-ip" --region "$REGION" ||
    g compute addresses create "$PREFIX-nat-ip" --region "$REGION"
  rm -f "$STATE/stack_ip"
  log "Cloud NAT: hosts have no public addresses"
  exists g compute routers describe "$PREFIX-router" --region "$REGION" ||
    g compute routers create "$PREFIX-router" --region "$REGION" --network default
  exists g compute routers nats describe "$PREFIX-nat" --router "$PREFIX-router" --region "$REGION" ||
    g compute routers nats create "$PREFIX-nat" --router "$PREFIX-router" --region "$REGION" \
      --nat-external-ip-pool "$PREFIX-nat-ip" --nat-custom-subnet-ip-ranges default
  local nat
  nat=$(address "$PREFIX-nat-ip")
  log "firewall: SSH from $from; HTTPS from it, the hosts' NAT and the stack; HTTP for certificates"
  rule "$PREFIX-ssh" tcp:22 "$from"
  rule "$PREFIX-https" tcp:443 "$from,$nat/32,$(stack_ip)/32"
  rule "$PREFIX-acme" tcp:80 0.0.0.0/0
  log "registry $(registry)"
  exists g artifacts repositories describe "$PREFIX" --location "$REGION" ||
    g artifacts repositories create "$PREFIX" --location "$REGION" --repository-format docker \
      --labels "$LABELS"
}
rule() {
  if exists g compute firewall-rules describe "$1"; then
    g compute firewall-rules update "$1" --source-ranges "$3"
  else
    g compute firewall-rules create "$1" --network default --allow "$2" --source-ranges "$3" \
      --target-tags "$STACK"
  fi
}

# --- fleet: deploy/terraform/gcp-compute ---------------------------------
# Terraform authenticates with the gcloud account's token, so a workstation
# needs no separate application-default login.
tf() {
  GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) TF_DATA_DIR=$STATE/terraform/data \
    terraform -chdir="$STATE/terraform/module" "$@"
}
fleet() {
  local dir=$STATE/terraform internal bundle_url bundle_sha
  mkdir -p "$dir"
  rsync -a --delete --exclude .terraform --exclude '*.tfstate*' \
    "$CHECKOUT/deploy/terraform/gcp-compute/" "$dir/module/"
  internal=$(address "$STACK-internal")
  # Before the first build the template names no bundle; the group stays
  # empty until the fleet service grows it.
  bundle_url=gs://$(bucket)/bundles/none.tar.gz
  bundle_sha=0000000000000000000000000000000000000000000000000000000000000000
  if [ -f "$STATE/bundle" ]; then
    # shellcheck disable=SC1091
    . "$STATE/bundle"
    bundle_url=$BUNDLE_URL
    bundle_sha=$BUNDLE_SHA256
  fi
  jq -n --arg project "$PROJECT" --arg prefix "$PREFIX" --arg region "$REGION" --arg zone "$ZONE" \
    --argjson labels "$(labels_json)" --arg machine "$HOST_MACHINE" --arg url "$bundle_url" \
    --arg sha "$bundle_sha" --arg base "$BASE_IMAGE_REF" --arg stack "$STACK" \
    --arg internal "$internal/32" --argjson port "$HOSTS_PORT" --arg bucket "$(bucket)" '{
      project_id: $project, name_prefix: $prefix, region: $region, zone: $zone, labels: $labels,
      machine_type: $machine, initial_hosts: 0, assign_external_ip: false,
      host_bundle: {url: $url, sha256: $sha}, base_image_ref: $base,
      control_url: "https://\($stack):\($port)", control_dns_names: [$stack],
      control_source_ranges: [$internal], control_target_tags: [$stack], control_hosts_port: $port,
      archive_bucket: $bucket, for_tests: true
    }' >"$dir/e2e.tfvars.json"
  log "terraform apply (host bundle $bundle_sha)"
  tf init -input=false -upgrade >"$STATE/terraform-init.log"
  tf apply -input=false -auto-approve -state="$dir/terraform.tfstate" -var-file="$dir/e2e.tfvars.json" \
    >"$STATE/terraform.log" 2>&1 || { tail -40 "$STATE/terraform.log" >&2; return 1; }
  local out=$STATE/fleet
  mkdir -p "$out"
  chmod 700 "$out"
  for name in archive host_group host_memory_mib control_service_account host_service_account fleet_ca_pem \
    control_certificate_pem control_private_key_pem; do
    tf output -state="$dir/terraform.tfstate" -raw "$name" >"$out/$name"
  done
  chmod 600 "$out/control_private_key_pem"
  # The stack pushes its images there and build-image reads them back.
  g artifacts repositories add-iam-policy-binding "$PREFIX" --location "$REGION" \
    --member "serviceAccount:$(cat "$out/control_service_account")" --role roles/artifactregistry.writer \
    >/dev/null
}

# --- stack: the VM Opengeni and the fleet service run on -----------------
stack() {
  resolve_refs
  if ! exists g compute instances describe "$STACK" --zone "$ZONE"; then
    log "stack VM $STACK ($STACK_MACHINE), with the fleet service's identity"
    g compute instances create "$STACK" --zone "$ZONE" --machine-type "$STACK_MACHINE" \
      --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
      --boot-disk-size 500GB --boot-disk-type pd-ssd \
      --address "$(stack_ip)" --private-network-ip "$(address "$STACK-internal")" \
      --service-account "$(cat "$STATE/fleet/control_service_account")" --scopes cloud-platform \
      --tags "$STACK" --labels "$LABELS" \
      --metadata "enable-oslogin=FALSE,ssh-keys=$USER_NAME:$(cat "$KEY.pub")"
  fi
  for _ in $(seq 60); do on true 2>/dev/null && break; sleep 5; done
  on true
  push_scripts
  log "tools on $STACK (setup.sh; log in $STATE/setup.log)"
  on "sudo REPO_URL=$REPO_URL OPENGENI_SHA=$OPENGENI_SHA COMPUTE_SHA=$COMPUTE_SHA E2E_USER=$USER_NAME bash e2e/setup.sh" \
    >"$STATE/setup.log" 2>&1 || { tail -40 "$STATE/setup.log" >&2; return 1; }
}

# --- build: images, the host bundle, the stored sandbox images ----------
# The newest published canary API image, for its artifact runtime bundle
# (build.sh), unless ARTIFACT_RUNTIME_FROM names one.
artifact_runtime_from() {
  if [ -n "${ARTIFACT_RUNTIME_FROM:-}" ]; then
    printf '%s' "$ARTIFACT_RUNTIME_FROM"
    return
  fi
  local tag
  tag=$(gh api "/orgs/cloudgeni-ai/packages/container/opengeni-api/versions?per_page=20" \
    --jq '[.[] | .metadata.container.tags[] | select(startswith("canary-sha-"))][0]')
  printf 'ghcr.io/cloudgeni-ai/opengeni-api:%s' "${tag:?no canary opengeni-api image found}"
}
build() {
  resolve_refs
  push_scripts
  log "build on $STACK: Opengeni $OPENGENI_SHA, compute $COMPUTE_SHA (log in $STATE/build.log)"
  on "OPENGENI_SHA=$OPENGENI_SHA COMPUTE_SHA=$COMPUTE_SHA REGISTRY=$(registry) BUCKET=$(bucket) ARTIFACT_RUNTIME_FROM=$(artifact_runtime_from) bash e2e/build.sh" \
    >"$STATE/build.log" 2>&1 || { tail -60 "$STATE/build.log" >&2; return 1; }
  copy_from e2e/out/build.env "$STATE/build.env"
  # shellcheck disable=SC1091
  . "$STATE/build.env"
  printf 'BUNDLE_URL=%s\nBUNDLE_SHA256=%s\n' "$BUNDLE_URL" "$BUNDLE_SHA256" >"$STATE/bundle"
}

# --- deploy: secrets, the chart, the public front ------------------------
deploy() {
  push_scripts
  on 'mkdir -p e2e/fleet && chmod 700 e2e/fleet'
  copy_to e2e/fleet/ "$STATE"/fleet/*
  local model=/dev/null
  [ -f "$STATE/model.env" ] && model=$STATE/model.env
  log "deploy on $STACK (log in $STATE/deploy.log)"
  # The model's key travels on stdin, never on a command line.
  on "STACK_IP=$(stack_ip) HOSTS=$HOSTS ZONE=$ZONE HOSTS_PORT=$HOSTS_PORT bash e2e/deploy.sh" \
    <"$model" >"$STATE/deploy.log" 2>&1 || { tail -60 "$STATE/deploy.log" >&2; return 1; }
  tail -5 "$STATE/deploy.log" >&2
}

# --- the model: an Azure OpenAI deployment for the run -------------------
model_up() {
  local account=${AZURE_OPENAI_ACCOUNT:?AZURE_OPENAI_ACCOUNT} group=${AZURE_OPENAI_GROUP:?AZURE_OPENAI_GROUP}
  local name=${MODEL_DEPLOYMENT:-${MODEL_NAME:?MODEL_NAME}}
  if ! exists az cognitiveservices account deployment show -n "$account" -g "$group" --deployment-name "$name"; then
    log "Azure OpenAI deployment $name (${MODEL_NAME:?MODEL_NAME} ${MODEL_VERSION:?MODEL_VERSION}) on $account"
    az cognitiveservices account deployment create -n "$account" -g "$group" --deployment-name "$name" \
      --model-name "$MODEL_NAME" --model-version "$MODEL_VERSION" --model-format OpenAI \
      --sku-name "${MODEL_SKU:-GlobalStandard}" --sku-capacity "${MODEL_CAPACITY:-500}" >/dev/null
  fi
  local endpoint key
  endpoint=$(az cognitiveservices account show -n "$account" -g "$group" --query properties.endpoint -o tsv)
  key=$(az cognitiveservices account keys list -n "$account" -g "$group" --query key1 -o tsv)
  (umask 077 && printf 'MODEL_DEPLOYMENT=%s\nAZURE_OPENAI_BASE_URL=%s/openai/v1\nAZURE_OPENAI_API_KEY=%s\n' \
    "$name" "${endpoint%/}" "$key" >"$STATE/model.env")
  log "model $name ready; run deploy to hand it to Opengeni"
}
model_down() {
  local account=${AZURE_OPENAI_ACCOUNT:?AZURE_OPENAI_ACCOUNT} group=${AZURE_OPENAI_GROUP:?AZURE_OPENAI_GROUP}
  local name=${MODEL_DEPLOYMENT:-${MODEL_NAME:?MODEL_NAME}}
  if exists az cognitiveservices account deployment show -n "$account" -g "$group" --deployment-name "$name"; then
    log "deleting Azure OpenAI deployment $name"
    az cognitiveservices account deployment delete -n "$account" -g "$group" --deployment-name "$name"
  fi
  rm -f "$STATE/model.env"
}

# --- suite ----------------------------------------------------------------
suite() {
  resolve_refs
  push_scripts
  local run
  run=${RUN:-$(date -u +%Y%m%dT%H%M%SZ)}
  log "suite run $run (Opengeni $OPENGENI_SHA, compute $COMPUTE_SHA)"
  on "RUN=$run ONLY='${ONLY:-}' OPENGENI_SHA=$OPENGENI_SHA COMPUTE_SHA=$COMPUTE_SHA PROJECT=$PROJECT ZONE=$ZONE bash e2e/suite.sh" |
    tee "$STATE/suite-$run.log" || true
  mkdir -p "$STATE/runs"
  copy_from "e2e/runs/$run" "$STATE/runs/" || true
  if [ -f "$STATE/runs/$run/results.md" ]; then cat "$STATE/runs/$run/results.md"; fi
}

# --- down -----------------------------------------------------------------
down() {
  log "deleting the stack VM"
  if exists g compute instances describe "$STACK" --zone "$ZONE"; then
    g compute instances delete "$STACK" --zone "$ZONE"
  fi
  local dir=$STATE/terraform
  if [ -f "$dir/terraform.tfstate" ]; then
    log "terraform destroy (group, template, bucket, authority, accounts, rules)"
    tf destroy -input=false -auto-approve -state="$dir/terraform.tfstate" -var-file="$dir/e2e.tfvars.json" \
      >"$STATE/terraform-destroy.log" 2>&1 || { tail -40 "$STATE/terraform-destroy.log" >&2; return 1; }
  fi
  log "registry, firewall, NAT, addresses"
  if exists g artifacts repositories describe "$PREFIX" --location "$REGION"; then
    g artifacts repositories delete "$PREFIX" --location "$REGION"
  fi
  for r in "$PREFIX-ssh" "$PREFIX-https" "$PREFIX-acme"; do
    if exists g compute firewall-rules describe "$r"; then g compute firewall-rules delete "$r"; fi
  done
  if exists g compute routers describe "$PREFIX-router" --region "$REGION"; then
    g compute routers delete "$PREFIX-router" --region "$REGION"
  fi
  for a in "$STACK-ip" "$STACK-internal" "$PREFIX-nat-ip"; do
    if exists g compute addresses describe "$a" --region "$REGION"; then
      g compute addresses delete "$a" --region "$REGION"
    fi
  done
  rm -f "$STATE/bundle" "$STATE/build.env" "$STATE/stack_ip" "$STATE/known_hosts"
  status
}

status() {
  log "what exists with prefix $PREFIX"
  g compute instances list --filter "name~^$PREFIX" --format 'table(name,zone.basename(),status,networkInterfaces[0].networkIP)'
  g compute addresses list --filter "name~^$PREFIX" --format 'table(name,address,status)'
  g compute firewall-rules list --filter "name~^$PREFIX" --format 'table(name,sourceRanges.list())'
  g compute instance-groups managed list --filter "name~^$PREFIX" --format 'table(name,targetSize)'
  g compute instance-templates list --filter "name~^$PREFIX" --format 'value(name)'
  g compute routers list --filter "name~^$PREFIX" --format 'value(name)'
  g storage buckets list --filter "name~^$PREFIX" --format 'value(name)'
  g artifacts repositories list --location "$REGION" --filter "name~$PREFIX" --format 'value(name)' 2>/dev/null
  g iam service-accounts list --filter "email~^$PREFIX" --format 'value(email)'
}

case "${1:-}" in
  up) infra; fleet; stack; build; fleet; deploy ;;
  infra) infra ;;
  fleet) fleet ;;
  stack) stack ;;
  build) build ;;
  deploy) deploy ;;
  model-up) model_up ;;
  model-down) model_down ;;
  suite) suite ;;
  down) down ;;
  status) status ;;
  ssh) shift; on "$@" ;;
  *) sed -n '2,33p' "$0" >&2; exit 2 ;;
esac
