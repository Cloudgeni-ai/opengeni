#!/usr/bin/env bash
# Builds, on the stack VM, everything the environment runs, from two
# commits (env.sh build):
#   - from OPENGENI_SHA: Opengeni's images (api, worker, web, relay),
#     imported into k3s, and its sandbox and desktop images, pushed to
#     REGISTRY. An image without /usr/local/bin/opengeni-agent
#     (ADR 21) gets the agent built from the same commit (agent.Dockerfile);
#   - from COMPUTE_SHA: compute-control's image (into k3s) and the host
#     bundle (deploy/host/bundle.sh), uploaded to gs://BUCKET/bundles;
#   - the stored sandbox images: compute-host build-image of the sandbox
#     and desktop images, stored in the fleet's archive.
# Writes ~/e2e/out/build.env. Each step is skipped when its output for the
# same commit exists.
set -euo pipefail
shopt -s inherit_errexit
: "${OPENGENI_SHA:?}" "${COMPUTE_SHA:?}" "${REGISTRY:?}" "${BUCKET:?}"
export PATH=$HOME/.cargo/bin:$HOME/.bun/bin:/snap/bin:$PATH
og=/srv/e2e/opengeni
cm=/srv/e2e/compute
here=$(cd "$(dirname "$0")" && pwd)
out=$HOME/e2e/out
mkdir -p "$out"
ogtag=e2e-${OPENGENI_SHA:0:12}
log() { printf '[build %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
imported() { sudo k3s ctr -n k8s.io images ls -q | grep -qx "docker.io/library/$1"; }
to_k3s() {
  imported "$1" && return
  docker save "$1" | sudo k3s ctr -n k8s.io images import - >/dev/null
}
has_agent() { docker run --rm --entrypoint /bin/sh "$1" -c 'test -x /usr/local/bin/opengeni-agent'; }

log "checkouts"
git -C /srv/e2e/src fetch -q origin "$OPENGENI_SHA" "$COMPUTE_SHA"
git -C "$og" checkout -q --detach "$OPENGENI_SHA"
git -C "$cm" checkout -q --detach "$COMPUTE_SHA"
# The fleet's artifacts are named by the parts of compute/ they are built
# from, so a commit that changes only the chart, the docs or this suite
# reuses them (and the hosts keep their bundle).
cmtree=$(git -C "$cm" ls-tree "$COMPUTE_SHA" compute/ | grep -v -e '	compute/e2e$' -e '	compute/docs$' -e '	compute/lab$' |
  sha256sum | cut -c1-40)
cmtag=e2e-${cmtree:0:12}
gcloud auth configure-docker "${REGISTRY%%/*}" --quiet >/dev/null 2>&1

# The API image needs the artifact runtime bundle release automation stages
# per architecture (.release/artifact-runtime/amd64; artifact-runtime.yml
# builds it for eight targets). The environment copies it from a published
# Opengeni API image, ARTIFACT_RUNTIME_FROM, whose artifact tool matches.
bundle=$og/.release/artifact-runtime/amd64
if [ ! -f "$bundle/installation.json" ]; then
  : "${ARTIFACT_RUNTIME_FROM:?ARTIFACT_RUNTIME_FROM (a published opengeni-api image) is required}"
  log "artifact runtime from $ARTIFACT_RUNTIME_FROM"
  rm -rf "$bundle"
  mkdir -p "$bundle"
  holder=$(docker create "$ARTIFACT_RUNTIME_FROM")
  # The image keeps it read-only; the Dockerfile makes it so again.
  docker cp "$holder:/app/artifact-runtime/." - | tar -x -C "$bundle" --delay-directory-restore
  docker rm "$holder" >/dev/null
  chmod -R u+w "$bundle"
fi

log "Opengeni images $ogtag"
for target in api worker web; do
  image=opengeni-$target:$ogtag
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    log "  $image"
    docker build -q -f "$og/docker/opengeni.Dockerfile" --target "$target" -t "$image" "$og" >/dev/null
  fi
  to_k3s "$image"
done
if ! docker image inspect "opengeni-relay:$ogtag" >/dev/null 2>&1; then
  log "  opengeni-relay:$ogtag"
  docker build -q -f "$og/agent/crates/opengeni-relay/Dockerfile" -t "opengeni-relay:$ogtag" "$og/agent" >/dev/null
fi
to_k3s "opengeni-relay:$ogtag"

log "compute-control image $cmtag"
if ! docker image inspect "opengeni-compute-control:$cmtag" >/dev/null 2>&1; then
  docker build -q -f "$cm/compute/docker/control.Dockerfile" -t "opengeni-compute-control:$cmtag" "$cm/compute" >/dev/null
fi
to_k3s "opengeni-compute-control:$cmtag"

# The sandbox images, by digest.
sandbox_image() {
  local dockerfile=$2 ref=$REGISTRY/$1:$ogtag
  if ! docker image inspect "$ref" >/dev/null 2>&1 || ! has_agent "$ref"; then
    log "  $ref"
    # The artifact runtime bundle (above) was assembled for another commit,
    # which the sandbox images verify; they build without it (the artifact
    # tool in the sandbox is then unavailable, which no check uses).
    docker build -q -f "$og/docker/$dockerfile" --build-arg OPENGENI_ARTIFACT_RUNTIME_BUNDLE=.release/none \
      -t "$ref" "$og" >/dev/null
    if ! has_agent "$ref"; then
      log "  $ref has no opengeni-agent: adding one built from $OPENGENI_SHA"
      docker build -q -f "$here/agent.Dockerfile" --build-arg "BASE=$ref" -t "$ref" "$og/agent" >/dev/null
    fi
  fi
  docker push -q "$ref" >/dev/null
  docker image inspect --format '{{index .RepoDigests 0}}' "$ref"
}
log "sandbox images"
SANDBOX_REF=$(sandbox_image opengeni-sandbox sandbox.Dockerfile)
DESKTOP_REF=$(sandbox_image opengeni-desktop desktop.Dockerfile)

log "host bundle $cmtag"
bundle=compute-host-$cmtag-x86_64-linux.tar.gz
if [ ! -f "$out/bundle/$bundle" ]; then
  (cd "$cm/compute" && VERSION=$cmtag OUT=$out/bundle CARGO_TARGET_DIR=$HOME/e2e/target bash deploy/host/bundle.sh)
fi
BUNDLE_SHA256=$(cut -d' ' -f1 "$out/bundle/$bundle.sha256")
BUNDLE_URL=gs://$BUCKET/bundles/$bundle
gcloud storage cp --quiet --no-clobber "$out/bundle/$bundle" "$BUNDLE_URL" 2>/dev/null ||
  gcloud storage cp --quiet "$out/bundle/$bundle" "$BUNDLE_URL"
rm -rf "$out/host" && mkdir -p "$out/host"
tar -xzf "$out/bundle/$bundle" -C "$out/host" --strip-components=1

# compute-host build-image, stored in the fleet's archive: prints the id
# creates name the image by.
stored() {
  local ref=$1 cache
  cache=$out/stored-$(printf '%s' "$1" | sha256sum | cut -c1-16)-$cmtag
  if [ ! -s "$cache" ]; then
    log "  build-image $ref"
    sudo env REGISTRY_TOKEN="$(gcloud auth print-access-token)" "$out/host/compute-host" build-image "$ref" \
      --guest "$out/host/guest" --output "/var/tmp/e2e-image.ext4" --registry-user oauth2accesstoken \
      --store "gs://$BUCKET/archive" | tee "$cache.json" >/dev/null
    sudo rm -f /var/tmp/e2e-image.ext4
    jq -r .image "$cache.json" >"$cache"
  fi
  cat "$cache"
}
log "stored images"
SANDBOX_IMAGE=$(stored "$SANDBOX_REF")
DESKTOP_IMAGE=$(stored "$DESKTOP_REF")

cat >"$out/build.env" <<EOF
OPENGENI_SHA=$OPENGENI_SHA
COMPUTE_SHA=$COMPUTE_SHA
OPENGENI_TAG=$ogtag
COMPUTE_TAG=$cmtag
SANDBOX_REF=$SANDBOX_REF
DESKTOP_REF=$DESKTOP_REF
SANDBOX_IMAGE=$SANDBOX_IMAGE
DESKTOP_IMAGE=$DESKTOP_IMAGE
BUNDLE_URL=$BUNDLE_URL
BUNDLE_SHA256=$BUNDLE_SHA256
EOF
cat "$out/build.env"
