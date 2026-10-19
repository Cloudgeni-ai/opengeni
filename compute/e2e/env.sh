#!/usr/bin/env bash
# The end-to-end environment for Opengeni compute on Google Cloud: a whole
# Opengeni (the Helm chart on a one-node k3s, with its API, workers, web,
# relay, Postgres, Temporal, NATS and object storage) built from one
# commit, the control service (the chart's computeControl) and a host fleet
# from deploy/terraform/gcp-compute, and the suite in suite/ that drives
# real agent sessions through it. See README.md.
#
# Run it from a checkout (its compute/e2e) on a workstation with gcloud,
# terraform, ssh, rsync, jq, bun (to verify the suite's results against the
# hosts' journals), gh (to find a published API image) and, for the model,
# az:
#
#   PROJECT=p compute/e2e/env.sh up          # everything, idempotent
#   PROJECT=p compute/e2e/env.sh model-up    # a model deployment for the run
#   PROJECT=p compute/e2e/env.sh deploy      # hands it to Opengeni
#   PROJECT=p compute/e2e/env.sh hosts       # hosts on that control service
#   PROJECT=p compute/e2e/env.sh suite       # the checks; results in $STATE/runs
#   PROJECT=p compute/e2e/env.sh model-down
#   PROJECT=p compute/e2e/env.sh down        # deletes everything up made
#
# Steps of up, each also runnable alone: infra (addresses, NAT, firewall,
# registry), fleet (terraform), stack (the VM and its tools), build (images,
# the host bundle and the stored sandbox images, from OPENGENI_REF and
# COMPUTE_REF), deploy (secrets, the chart, the public front), hosts (the
# group's hosts replaced if their template is older, then each live on
# the control service just deployed). Also: status,
# ssh [command], and host-logs [run] (each host's journal into the run's
# results; suite does it after every run).
#
# Settings: PROJECT; ZONE (europe-west4-a); PREFIX (compute-e2e; every
# resource's name starts with it); LABELS (purpose=compute-e2e, as k=v,...);
# OPENGENI_REF, the commit Opengeni's images come from (origin/main);
# OPENGENI_MERGE_REFS, further Opengeni refs merged into it on the stack VM
# before building (space-separated; for branches not yet on one branch);
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
# The control service's host endpoint on the stack VM: the chart's hosts
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
  OPENGENI_MERGE=""
  local ref
  for ref in ${OPENGENI_MERGE_REFS:-}; do
    OPENGENI_MERGE="${OPENGENI_MERGE:+$OPENGENI_MERGE }$(git -C "$CHECKOUT" rev-parse --verify "$ref^{commit}")"
  done
  COMPUTE_SHA=$(git -C "$CHECKOUT" rev-parse --verify "${COMPUTE_REF:-HEAD}^{commit}")
  printf 'OPENGENI_SHA=%s\nOPENGENI_MERGE="%s"\nCOMPUTE_SHA=%s\n' "$OPENGENI_SHA" "$OPENGENI_MERGE" "$COMPUTE_SHA" >"$STATE/refs"
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
  # Hosts have no public address: their journals come over the stack VM.
  local internal
  internal=$(g compute addresses describe "$STACK-internal" --region "$REGION" --format='value(address)')
  rule "$PREFIX-ssh-hosts" tcp:22 "$internal/32" "$PREFIX-host"
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
      --target-tags "${4:-$STACK}"
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
  # empty until the control service grows it.
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
      control_url: "https://\($stack):\($port)",
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
  for name in archive host_group host_memory_mib control_service_account host_service_account \
    host_authority_pem host_authority_key_pem; do
    tf output -state="$dir/terraform.tfstate" -raw "$name" >"$out/$name"
  done
  chmod 600 "$out/host_authority_key_pem"
  tf output -state="$dir/terraform.tfstate" -json identity_tokens >"$out/identity_tokens.json"
  # The service's hostUrl is the URL hosts are given, exactly: their
  # identity tokens are for it.
  jq -r .control_url "$dir/e2e.tfvars.json" >"$out/control_url"
  # The stack pushes its images there and build-image reads them back.
  g artifacts repositories add-iam-policy-binding "$PREFIX" --location "$REGION" \
    --member "serviceAccount:$(cat "$out/control_service_account")" --role roles/artifactregistry.writer \
    >/dev/null
  # The suite's fault injection (vm-crash kills one sandbox's VMM) and
  # its looks at a guest's console reach the hosts as the stack VM's
  # identity over OS Login, on this environment's hosts only; down removes it.
  g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$(cat "$out/control_service_account")" \
    --role roles/compute.osAdminLogin --condition "$(host_login_condition)" >/dev/null
}

# --- hosts: the group's hosts on the control service under test ---------
# After deploy, so every host gets its certificate from, and registers
# with, the control service the run tests rather than the one before it.
hosts() {
  # The group takes a new template only for hosts it makes (hosts outlive
  # their agent, ADR 9). Between runs no sandbox here needs keeping, so the
  # environment replaces hosts that run an older bundle at once.
  local group=$PREFIX-hosts names
  if [ "$(g compute instance-groups managed describe "$group" --zone "$ZONE" \
    --format='value(status.versionTarget.isReached)')" != True ]; then
    log "replacing the hosts of $group with the new template"
    g compute instance-groups managed rolling-action replace "$group" --zone "$ZONE" \
      --max-surge "$HOSTS" --max-unavailable "$HOSTS" >/dev/null
    # Until the old hosts are gone, so no sandbox of the next run lands on one.
    g compute instance-groups managed wait-until "$group" --zone "$ZONE" --version-target-reached \
      --timeout 1800 >/dev/null
  fi
  names=$(g compute instance-groups managed list-instances "$group" --zone "$ZONE" \
    --format='value(instance.basename())' | tr '\n' ' ')
  [ -n "${names// /}" ] || { log "$group has no hosts"; return 1; }
  push_scripts
  on "bash e2e/hosts.sh $names" >"$STATE/hosts.log" 2>&1 || { tail -5 "$STATE/hosts.log" >&2; return 1; }
  tail -1 "$STATE/hosts.log" >&2
}

# The condition of the stack VM's OS Login on the hosts: this environment's
# host instances, nothing else.
host_login_condition() {
  printf 'expression=resource.name.startsWith("projects/%s/zones/%s/instances/%s-host-"),title=%s-host-login' \
    "$PROJECT" "$ZONE" "$PREFIX" "$PREFIX"
}
# Whether the project still grants <account> that OS Login: 0 it does,
# 1 it does not, 2 unknown (the policy could not be read), which callers
# must report rather than take as absent.
host_login_bound() {
  local policy found
  policy=$(g projects get-iam-policy "$PROJECT" --flatten bindings --format json) || return 2
  found=$(jq --arg member "serviceAccount:$1" --arg title "$PREFIX-host-login" \
    'any(.[]; .bindings.role == "roles/compute.osAdminLogin" and ((.bindings.members // []) | index($member)) != null and .bindings.condition.title == $title)' \
    <<<"$policy") || return 2
  case $found in
    true) return 0 ;;
    false) return 1 ;;
    *) return 2 ;;
  esac
}

# --- stack: the VM Opengeni and the control service run on -----------------
stack() {
  resolve_refs
  if ! exists g compute instances describe "$STACK" --zone "$ZONE"; then
    log "stack VM $STACK ($STACK_MACHINE), with the control service's identity"
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
  log "build on $STACK: Opengeni $OPENGENI_SHA${OPENGENI_MERGE:+ merged with $OPENGENI_MERGE}, compute $COMPUTE_SHA (log in $STATE/build.log)"
  on "OPENGENI_SHA=$OPENGENI_SHA OPENGENI_MERGE='$OPENGENI_MERGE' COMPUTE_SHA=$COMPUTE_SHA REGISTRY=$(registry) BUCKET=$(bucket) ARTIFACT_RUNTIME_FROM=$(artifact_runtime_from) bash e2e/build.sh" \
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
  on "STACK_IP=$(stack_ip) HOSTS=$HOSTS ZONE=$ZONE HOSTS_PORT=$HOSTS_PORT FRESH=${FRESH:-0} bash e2e/deploy.sh" \
    <"$model" >"$STATE/deploy.log" 2>&1 || { tail -60 "$STATE/deploy.log" >&2; return 1; }
  tail -5 "$STATE/deploy.log" >&2
}

# --- the model: an Azure OpenAI deployment for the run -------------------
# A deployment this environment creates is recorded in $STATE/model.created
# (account, group, name and Azure's creation time); model-down deletes only
# a deployment that matches that record, and leaves one it found already
# there.
MODEL_RECORD=$STATE/model.created
# Azure's creation time of a deployment, which tells it from a later one of
# the same name: prints it and succeeds; returns 1 when Azure says there is
# no such deployment, 2 when it could not say (any other error, or no time).
model_lookup() {
  local err out
  err=$(mktemp)
  if out=$(az cognitiveservices account deployment show -n "$1" -g "$2" --deployment-name "$3" \
    --query systemData.createdAt -o tsv 2>"$err"); then
    rm -f "$err"
    [ -n "$out" ] || return 2
    printf '%s\n' "$out"
    return 0
  fi
  if grep -qiE 'NotFound|could not be found|does not exist' "$err"; then
    rm -f "$err"
    return 1
  fi
  cat "$err" >&2
  rm -f "$err"
  return 2
}
# The record of a deployment this environment created (nonempty time only).
model_record() { printf 'account=%s\ngroup=%s\nname=%s\ncreated=%s' "$@"; }
model_recorded() {
  [ -n "$4" ] && [ -f "$MODEL_RECORD" ] && [ "$(cat "$MODEL_RECORD")" = "$(model_record "$@")" ]
}
model_up() {
  local account=${AZURE_OPENAI_ACCOUNT:?AZURE_OPENAI_ACCOUNT} group=${AZURE_OPENAI_GROUP:?AZURE_OPENAI_GROUP}
  local name=${MODEL_DEPLOYMENT:-${MODEL_NAME:?MODEL_NAME}} created rc=0
  created=$(model_lookup "$account" "$group" "$name") || rc=$?
  case $rc in
    1)
      log "Azure OpenAI deployment $name (${MODEL_NAME:?MODEL_NAME} ${MODEL_VERSION:?MODEL_VERSION}) on $account"
      az cognitiveservices account deployment create -n "$account" -g "$group" --deployment-name "$name" \
        --model-name "$MODEL_NAME" --model-version "$MODEL_VERSION" --model-format OpenAI \
        --sku-name "${MODEL_SKU:-GlobalStandard}" --sku-capacity "${MODEL_CAPACITY:-500}" >/dev/null
      created=
      for _ in 1 2 3 4 5 6; do
        created=$(model_lookup "$account" "$group" "$name") && break
        created=
        sleep 10
      done
      if [ -z "$created" ]; then
        log "created deployment $name but Azure gave no creation time to record it by; model-down cannot" \
          "prove it is this environment's, so delete it by hand when done"
        return 1
      fi
      (umask 077 && model_record "$account" "$group" "$name" "$created" >"$MODEL_RECORD")
      ;;
    0)
      if model_recorded "$account" "$group" "$name" "$created"; then
        log "reusing deployment $name, which this environment created"
      else
        log "using deployment $name, which was already there: model-down will leave it"
      fi
      ;;
    *)
      log "could not ask Azure about deployment $name on $account"
      return 1
      ;;
  esac
  local endpoint key
  endpoint=$(az cognitiveservices account show -n "$account" -g "$group" --query properties.endpoint -o tsv)
  key=$(az cognitiveservices account keys list -n "$account" -g "$group" --query key1 -o tsv)
  (umask 077 && printf 'MODEL_DEPLOYMENT=%s\nAZURE_OPENAI_BASE_URL=%s/openai/v1\nAZURE_OPENAI_API_KEY=%s\n' \
    "$name" "${endpoint%/}" "$key" >"$STATE/model.env")
  log "model $name ready; run deploy to hand it to Opengeni"
}
# Deletes the deployment only if Azure shows the one this environment
# recorded creating; the record goes only once that one is known gone.
model_down() {
  local account=${AZURE_OPENAI_ACCOUNT:-} group=${AZURE_OPENAI_GROUP:-} name=${MODEL_DEPLOYMENT:-${MODEL_NAME:-}}
  if [ -f "$MODEL_RECORD" ]; then
    account=$(sed -n 's/^account=//p' "$MODEL_RECORD")
    group=$(sed -n 's/^group=//p' "$MODEL_RECORD")
    name=$(sed -n 's/^name=//p' "$MODEL_RECORD")
  fi
  if [ -z "$account" ] || [ -z "$group" ] || [ -z "$name" ]; then
    log "no record of a deployment this environment created, and no AZURE_OPENAI_ACCOUNT, AZURE_OPENAI_GROUP and MODEL_NAME"
    rm -f "$STATE/model.env"
    return 0
  fi
  local created rc=0
  created=$(model_lookup "$account" "$group" "$name") || rc=$?
  case $rc in
    1)
      log "no deployment $name on $account"
      rm -f "$STATE/model.env" "$MODEL_RECORD"
      ;;
    0)
      if model_recorded "$account" "$group" "$name" "$created"; then
        log "deleting Azure OpenAI deployment $name, which this environment created"
        az cognitiveservices account deployment delete -n "$account" -g "$group" --deployment-name "$name"
        rc=0
        model_lookup "$account" "$group" "$name" >/dev/null || rc=$?
        if [ "$rc" -ne 1 ]; then
          log "deployment $name may still be there; keeping the record in $MODEL_RECORD"
          return 1
        fi
        rm -f "$STATE/model.env" "$MODEL_RECORD"
      else
        # Not the one recorded: the recorded one is gone (this one has
        # another creation time) or there never was one.
        log "leaving deployment $name: this environment did not create it (no matching record in $MODEL_RECORD)"
        rm -f "$STATE/model.env" "$MODEL_RECORD"
      fi
      ;;
    *)
      log "could not ask Azure about deployment $name; keeping the record in $MODEL_RECORD"
      return 1
      ;;
  esac
}

# --- suite ----------------------------------------------------------------
# A run's name names its directory here and on the stack VM, which suite
# empties first: one plain name (letters, digits, '.', '_', '-'; not '.'
# or '..' and nothing else starting with a dot).
safe_run() {
  if [[ ! $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
    log "RUN must be one plain name (letters, digits, '.', '_', '-', starting with a letter or digit), not '$1'"
    return 1
  fi
}
suite() {
  resolve_refs
  push_scripts
  local run
  run=${RUN:-$(date -u +%Y%m%dT%H%M%SZ)}
  safe_run "$run" || return 2
  log "suite run $run (against the deployed build)"
  # The remote suite's status (nonzero when a check failed or was skipped,
  # or it could not run), then the results are copied and verified against
  # the hosts' journals; any of it failing fails the step.
  local status=0 verified=0 dir=$STATE/runs/$run collector
  # A sandbox's guest console goes with the sandbox, which the run deletes
  # at its end, so it is copied while the run goes on.
  # Only this invocation's results count: none from an earlier run of the
  # same name, here or on the stack VM.
  mkdir -p "$dir"
  rm -f "$dir/results.json" "$dir/results.md"
  on "rm -rf -- 'e2e/runs/$run'"
  consoles_loop "$dir" "$(date -u +%s)" &
  collector=$!
  on "RUN=$run ONLY='${ONLY:-}' KEEP='${KEEP:-}' PROJECT=$PROJECT ZONE=$ZONE bash e2e/suite.sh" |
    tee "$STATE/suite-$run.log" || status=$?
  kill "$collector" 2>/dev/null || true
  wait "$collector" 2>/dev/null || true
  mkdir -p "$STATE/runs"
  local copied=0
  copy_from "e2e/runs/$run" "$STATE/runs/" || copied=$?
  RUN=$run host_logs || log "could not collect the hosts' journals"
  if [ "$copied" -ne 0 ] || [ ! -f "$dir/results.json" ]; then
    log "suite run $run: its results did not come back (copy exited $copied, the suite exited $status)"
    return $((status == 0 ? 1 : status))
  fi
  bun "$HERE/suite/verify.ts" "$dir" || verified=$?
  cat "$dir/results.md"
  [ "$status" -eq 0 ] || return "$status"
  return "$verified"
}

# This account's OS Login user, with gcloud's own key registered for a day.
os_login_user() {
  local login=$HOME/.ssh/google_compute_engine
  [ -f "$login" ] || ssh-keygen -q -t ed25519 -N '' -f "$login"
  g compute os-login ssh-keys add --key-file "$login.pub" --ttl 1d >/dev/null
  g compute os-login describe-profile --format='value(posixAccounts[0].username)'
}

# Runs a command on a host as root's caller, over the stack VM.
on_host() {
  local user=$1 ip=$2
  shift 2
  ssh -n -T -i "$HOME/.ssh/google_compute_engine" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
    -o "UserKnownHostsFile=$STATE/known_hosts" -o LogLevel=ERROR -o ConnectTimeout=20 \
    -o "ProxyCommand=ssh ${SSH_OPTS[*]} -W %h:%p $USER_NAME@$(stack_ip)" "$user@$ip" "$@"
}

# Until killed: every minute, copies the guest console of every sandbox
# that wrote to it since <epoch> into <dir>/consoles-<host>.log ("== <id>"
# before each), keeping the last copy that had any.
consoles_loop() {
  local dir=$1 since=$2 user name ip
  user=$(os_login_user) || return 0
  for (( ; ; )); do
    while read -r name ip; do
      on_host "$user" "$ip" "for f in \$(sudo find /var/lib/compute/state/vm/firecracker -mindepth 2 -maxdepth 2 \
        -name console.log -newermt @$since 2>/dev/null); do echo \"== \$(basename \$(dirname \$f))\"; sudo cat \$f; done" \
        >"$dir/.consoles-$name.log" 2>/dev/null || true
      if [ -s "$dir/.consoles-$name.log" ]; then
        mv "$dir/.consoles-$name.log" "$dir/consoles-$name.log"
      else
        rm -f "$dir/.consoles-$name.log"
      fi
    done < <(g compute instances list --filter "name~^$PREFIX-host" --format 'value(name,networkInterfaces[0].networkIP)')
    sleep 60
  done
}

# Each host's journal since the run began (all of it without a run) into
# $STATE/runs/$RUN, and the guest console of each sandbox the run's results
# name that the host still has (a kept run's, KEEP=1; suite copies them
# while it runs too): OS Login over the stack VM, which the hosts allow SSH
# from.
host_logs() {
  local run=${RUN:-} dir since=() name
  [ -z "$run" ] || safe_run "$run" || return 2
  dir=$STATE/runs/${run:-hosts-$(date -u +%Y%m%dT%H%M%SZ)}
  mkdir -p "$dir"
  # From a minute before the run began (results.json), or the whole journal.
  local began
  began=$(jq -r '.started // empty | sub("[.][0-9]+Z$"; "Z") | fromdateiso8601 - 60' "$dir/results.json" 2>/dev/null || true)
  [ -n "$began" ] && since=(--since "@$began")
  local user ip sandboxes
  user=$(os_login_user)
  sandboxes=$(grep -oE 'sandbox [0-9a-f]{32}' "$dir/results.json" 2>/dev/null | cut -d' ' -f2 | sort -u | tr '\n' ' ' || true)
  while read -r name ip; do
    log "journal of $name"
    on_host "$user" "$ip" "sudo journalctl --no-pager -o short-iso-precise ${since[*]} -u 'compute-*'" \
      >"$dir/host-$name.log" 2>"$dir/host-$name.err" || log "no journal from $name (see host-$name.err)"
    [ -n "$sandboxes" ] || continue
    # Only if the host still has them: the copy made during the run stays.
    on_host "$user" "$ip" \
      "for id in $sandboxes; do f=/var/lib/compute/state/vm/firecracker/\$id/console.log; if sudo test -f \$f; then echo \"== \$id\"; sudo cat \$f; fi; done" \
      >"$dir/.consoles-$name.log" 2>/dev/null || true
    if [ -s "$dir/.consoles-$name.log" ]; then mv "$dir/.consoles-$name.log" "$dir/consoles-$name.log"; else rm -f "$dir/.consoles-$name.log"; fi
  done < <(g compute instances list --filter "name~^$PREFIX-host" --format 'value(name,networkInterfaces[0].networkIP)')
}

# --- down -----------------------------------------------------------------
# Deletes everything up made, carrying on past a failure so one stuck
# resource does not keep the rest alive; fails at the end naming what is
# left, which status then lists.
down() {
  local left=()
  log "deleting the stack VM"
  if exists g compute instances describe "$STACK" --zone "$ZONE"; then
    g compute instances delete "$STACK" --zone "$ZONE" || left+=("stack VM $STACK")
  fi
  local login_sa
  login_sa=$(cat "$STATE/fleet/control_service_account" 2>/dev/null || true)
  if [ -n "$login_sa" ]; then
    local bound=0
    host_login_bound "$login_sa" || bound=$?
    case $bound in
      0)
        log "the stack VM's OS Login on the hosts"
        g projects remove-iam-policy-binding "$PROJECT" --member "serviceAccount:$login_sa" \
          --role roles/compute.osAdminLogin --condition "$(host_login_condition)" >/dev/null ||
          left+=("OS Login binding for $login_sa")
        ;;
      1) ;;
      *) left+=("OS Login binding for $login_sa (could not read the project's IAM policy)") ;;
    esac
  fi
  local dir=$STATE/terraform
  if [ -f "$dir/terraform.tfstate" ]; then
    log "terraform destroy (group, template, bucket, accounts, rules)"
    if ! tf destroy -input=false -auto-approve -state="$dir/terraform.tfstate" -var-file="$dir/e2e.tfvars.json" \
      >"$STATE/terraform-destroy.log" 2>&1; then
      tail -40 "$STATE/terraform-destroy.log" >&2
      left+=("terraform (see $STATE/terraform-destroy.log)")
    fi
  fi
  log "registry, firewall, NAT, addresses"
  if exists g artifacts repositories describe "$PREFIX" --location "$REGION"; then
    g artifacts repositories delete "$PREFIX" --location "$REGION" || left+=("registry $PREFIX")
  fi
  for r in "$PREFIX-ssh" "$PREFIX-ssh-hosts" "$PREFIX-https" "$PREFIX-acme"; do
    if exists g compute firewall-rules describe "$r"; then g compute firewall-rules delete "$r" || left+=("firewall rule $r"); fi
  done
  if exists g compute routers describe "$PREFIX-router" --region "$REGION"; then
    g compute routers delete "$PREFIX-router" --region "$REGION" || left+=("router $PREFIX-router")
  fi
  for a in "$STACK-ip" "$STACK-internal" "$PREFIX-nat-ip"; do
    if exists g compute addresses describe "$a" --region "$REGION"; then
      g compute addresses delete "$a" --region "$REGION" || left+=("address $a")
    fi
  done
  rm -f "$STATE/bundle" "$STATE/build.env" "$STATE/stack_ip" "$STATE/known_hosts"
  status
  if [ "${#left[@]}" -gt 0 ]; then
    log "not deleted: ${left[*]}"
    return 1
  fi
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
  g iam roles list --project "$PROJECT" --filter "name~${PREFIX//-/_}" --format 'value(name,deleted)'
  local login_sa
  login_sa=$(cat "$STATE/fleet/control_service_account" 2>/dev/null || true)
  if [ -n "$login_sa" ]; then
    local bound=0
    host_login_bound "$login_sa" || bound=$?
    case $bound in
      0) printf 'project IAM: roles/compute.osAdminLogin for %s on %s hosts\n' "$login_sa" "$PREFIX" ;;
      1) ;;
      *) printf 'project IAM: could not read the policy; roles/compute.osAdminLogin for %s may remain\n' "$login_sa" ;;
    esac
  fi
  # The model deployment this environment recorded creating, or else the
  # one the settings name.
  local account=${AZURE_OPENAI_ACCOUNT:-} group=${AZURE_OPENAI_GROUP:-} name=${MODEL_DEPLOYMENT:-${MODEL_NAME:-}} record=none
  if [ -f "$MODEL_RECORD" ]; then
    record="created here"
    account=$(sed -n 's/^account=//p' "$MODEL_RECORD")
    group=$(sed -n 's/^group=//p' "$MODEL_RECORD")
    name=$(sed -n 's/^name=//p' "$MODEL_RECORD")
  fi
  if [ -n "$account" ] && [ -n "$name" ]; then
    if ! command -v az >/dev/null; then
      log "azure openai deployment $name on $account (record: $record): az is not installed to look"
    else
      local created rc=0
      created=$(model_lookup "$account" "$group" "$name") || rc=$?
      case $rc in
        0) printf 'azure openai deployment %s on %s, created %s (record: %s)\n' "$name" "$account" "$created" "$record" ;;
        1) [ "$record" = none ] || printf 'azure openai deployment %s on %s: gone, record left\n' "$name" "$account" ;;
        *) printf 'azure openai deployment %s on %s (record: %s): Azure could not say whether it exists\n' "$name" "$account" "$record" ;;
      esac
    fi
  fi
}

case "${1:-}" in
  up) infra; fleet; stack; build; fleet; deploy; hosts ;;
  infra) infra ;;
  fleet) fleet ;;
  stack) stack ;;
  build) build ;;
  deploy) deploy ;;
  hosts) hosts ;;
  model-up) model_up ;;
  model-down) model_down ;;
  suite) suite ;;
  down) down ;;
  status) status ;;
  ssh) shift; on "$@" ;;
  host-logs) RUN=${2:-${RUN:-}} host_logs ;;
  *) sed -n '2,33p' "$0" >&2; exit 2 ;;
esac
