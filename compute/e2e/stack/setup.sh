#!/usr/bin/env bash
# The stack VM's tools, as root (env.sh stack): Docker with BuildKit,
# the Rust and C toolchains the host bundle needs, Bun and Playwright for
# the suite, Caddy for the public front, Helm and k3s (through the
# repository's own pinned bootstrap), and one clone of the repository with
# a worktree per commit. Idempotent.
set -euo pipefail
: "${REPO_URL:?}" "${OPENGENI_SHA:?}" "${COMPUTE_SHA:?}" "${E2E_USER:?}"
HELM_VERSION=v3.22.1
HELM_SHA256=896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea
# Caddy from its own release, pinned (Ubuntu's is 2.6); the package stays
# for its service unit and user.
CADDY_VERSION=2.11.7
CADDY_SHA256=727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b
log() { printf '[setup %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
home=$(getent passwd "$E2E_USER" | cut -d: -f6)
as_user() { sudo -u "$E2E_USER" -H bash -lc "$1"; }

log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-buildx git jq rsync build-essential musl-tools pkg-config \
  libssl-dev clang cmake protobuf-compiler unzip xfsprogs e2fsprogs caddy python3 >/dev/null
usermod -aG docker "$E2E_USER"
systemctl enable --now docker
# Builds are big; the boot disk holds them.
sysctl -qw fs.inotify.max_user_watches=1048576 fs.inotify.max_user_instances=8192

log "Caddy $CADDY_VERSION"
if ! caddy version 2>/dev/null | grep "^v$CADDY_VERSION " >/dev/null; then
  work=$(mktemp -d)
  curl -fsSL -o "$work/caddy.tgz" \
    "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  echo "$CADDY_SHA256  $work/caddy.tgz" | sha256sum -c --quiet -
  tar -xzf "$work/caddy.tgz" -C "$work" caddy
  install -m 0755 "$work/caddy" /usr/bin/caddy
  rm -rf "$work"
  # An upgrade of the package would put its own binary back.
  apt-mark hold caddy >/dev/null
  systemctl restart caddy
fi

log "Helm $HELM_VERSION"
if ! helm version --short 2>/dev/null | grep "^$HELM_VERSION" >/dev/null; then
  work=$(mktemp -d)
  curl -fsSL -o "$work/helm.tgz" "https://get.helm.sh/helm-$HELM_VERSION-linux-amd64.tar.gz"
  echo "$HELM_SHA256  $work/helm.tgz" | sha256sum -c --quiet -
  tar -xzf "$work/helm.tgz" -C "$work"
  install -m 0755 "$work/linux-amd64/helm" /usr/local/bin/helm
  rm -rf "$work"
fi

log "the repository at $OPENGENI_SHA and $COMPUTE_SHA"
src=/srv/e2e/src
install -d -o "$E2E_USER" -g "$E2E_USER" /srv/e2e
as_user "set -e
  [ -d $src/.git ] || git clone -q --no-checkout $REPO_URL $src
  cd $src
  git fetch -q origin $OPENGENI_SHA $COMPUTE_SHA
  for pair in opengeni:$OPENGENI_SHA compute:$COMPUTE_SHA; do
    name=\${pair%%:*}; sha=\${pair#*:}
    if [ -d /srv/e2e/\$name ]; then
      git -C /srv/e2e/\$name checkout -q --detach \$sha
    else
      git worktree add -q --detach /srv/e2e/\$name \$sha
    fi
  done"

log "Rust and Bun for $E2E_USER"
as_user '[ -x ~/.cargo/bin/rustup ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain none'
as_user "cd /srv/e2e/compute/compute && ~/.cargo/bin/rustup show active-toolchain >/dev/null 2>&1 || ~/.cargo/bin/rustup toolchain install \$(sed -n 's/^channel *= *\"\\(.*\\)\"/\\1/p' rust-toolchain.toml) --profile minimal"
as_user "cd /srv/e2e/compute/compute && ~/.cargo/bin/rustup target add x86_64-unknown-linux-musl >/dev/null"
bun_version=$(cat /srv/e2e/opengeni/.bun-version)
as_user "[ \"\$(~/.bun/bin/bun --version 2>/dev/null)\" = $bun_version ] || curl -fsSL https://bun.sh/install | bash -s bun-v$bun_version >/dev/null"

log "k3s (scripts/operator/bootstrap-opensandbox-k3s.sh)"
if ! /usr/local/bin/k3s kubectl get --raw=/readyz >/dev/null 2>&1; then
  bash /srv/e2e/compute/scripts/operator/bootstrap-opensandbox-k3s.sh
fi
install -d -o "$E2E_USER" -g "$E2E_USER" "$home/.kube"
install -m 0600 -o "$E2E_USER" -g "$E2E_USER" /etc/rancher/k3s/k3s.yaml "$home/.kube/config"
ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl
log "ready"
