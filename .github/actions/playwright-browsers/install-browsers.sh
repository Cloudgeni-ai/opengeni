#!/usr/bin/env bash
# Installs the pinned Playwright browsers and, on Linux, the system packages
# they need. Inputs arrive through the environment (see action.yml).
#
# On Linux the system packages are a separate phase rather than
# `playwright install --with-deps`, so the Ubuntu archive is not on the
# runtime path: when the archive is unreachable (for example when DNS for
# ubuntu.com fails while other hosts resolve), `--with-deps` fails the job even
# though everything it needs could come from elsewhere. In order:
#
#   1. Skip apt when nothing is missing (a local `apt-get install -s`).
#   2. Install what is missing from a deb cache that actions/cache restores
#      (PLAYWRIGHT_DEB_DIR), with no network. The cache holds the debs for
#      every browser, so any job that fills it serves every other job.
#   3. Only then use the network: download into the cache and install, with
#      apt retries and backoff. Archive mirrors whose host does not resolve
#      are dropped first, and a fallback mirror outside ubuntu.com takes the
#      lead, so apt never spends its budget on dead DNS names.
#   4. If that also fails, continue when every shared library the browsers
#      link resolves (only fonts or tools are missing), and fail otherwise.
#
# The first browser attempt gets whatever the system packages phase left of
# ATTEMPT_TIMEOUT_SECONDS, so the worst case stays
# ATTEMPTS x (ATTEMPT_TIMEOUT_SECONDS + KILL_AFTER_SECONDS).
# Browser and package lists are space-separated words on purpose.
# shellcheck disable=SC2086
set -uo pipefail

# The Ubuntu archive is signed, so apt verifies whatever these mirrors serve.
# They live outside ubuntu.com, so they stay reachable when it does not.
FALLBACK_MIRRORS="${PLAYWRIGHT_FALLBACK_MIRRORS:-https://mirrors.edge.kernel.org/ubuntu/ https://mirrors.mit.edu/ubuntu/}"
APT_CONF_DIR="${PLAYWRIGHT_APT_CONF_DIR:-/etc/apt/apt.conf.d}"
APT_MIRRORS="${PLAYWRIGHT_APT_MIRRORS:-/etc/apt/apt-mirrors.txt}"
DEB_DIR="${PLAYWRIGHT_DEB_DIR:-}"
BROWSERS_DIR="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/.cache/ms-playwright}"
SYSTEM_DEPS_ATTEMPTS="${SYSTEM_DEPS_ATTEMPTS:-4}"
# The deb cache holds the packages of every browser, so one key serves all.
ALL_DEPS_TARGETS="chromium chromium-headless-shell firefox webkit"

started=${SECONDS}

only_shell=""
deps_browsers="${PLAYWRIGHT_BROWSERS}"
if [ "${PLAYWRIGHT_ONLY_SHELL}" = "true" ]; then
  only_shell="--only-shell"
  # The headless shell has its own dependency set.
  deps_browsers="$(printf ' %s ' "${PLAYWRIGHT_BROWSERS}" | sed 's/ chromium / chromium-headless-shell /g' | xargs)"
fi

set_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1" >> "${GITHUB_OUTPUT}"
  fi
}

configure_apt() {
  # Bound each request, and wait for a dpkg lock a killed attempt may have
  # left instead of failing at once. Few retries: a dead host costs the full
  # timeout on every retry of every file.
  printf '%s\n' \
    'Acquire::Retries "2";' \
    'Acquire::http::Timeout "20";' \
    'Acquire::https::Timeout "20";' \
    'DPkg::Lock::Timeout "60";' \
    | sudo tee "${APT_CONF_DIR}/99playwright-browsers-network" >/dev/null
}

resolves() {
  timeout 5 getent ahosts "$1" >/dev/null 2>&1
}

mirror_host() {
  sed -E 's#^[a-z+]+://([^/:]+).*#\1#' <<<"$1"
}

# Hosted runners fetch through a mirror list (mirror+file:). Before the first
# download, drop entries whose host does not resolve and add the fallback
# mirrors: first when a primary is gone, last otherwise. Only amd64 is served
# from the main archive mirrors. Runs once.
mirrors_prepared=false
prepare_mirrors() {
  [ "${mirrors_prepared}" = "false" ] || return 0
  mirrors_prepared=true
  if [ ! -f "${APT_MIRRORS}" ] || [ "$(dpkg --print-architecture 2>/dev/null)" != "amd64" ]; then
    return 0
  fi
  local line uri live=() fallbacks=() dropped=0
  while IFS= read -r line; do
    case "${line}" in "" | "#"*) continue ;; esac
    uri="${line%%[[:space:]]*}"
    case " ${FALLBACK_MIRRORS} " in *" ${uri} "*) continue ;; esac
    if resolves "$(mirror_host "${uri}")"; then
      live+=("${line}")
    else
      echo "::warning::apt mirror $(mirror_host "${uri}") does not resolve; skipping it."
      dropped=$((dropped + 1))
    fi
  done <"${APT_MIRRORS}"
  for uri in ${FALLBACK_MIRRORS}; do
    if resolves "$(mirror_host "${uri}")"; then
      fallbacks+=("${uri}")
    else
      echo "::warning::Fallback apt mirror $(mirror_host "${uri}") does not resolve; skipping it."
    fi
  done
  if [ "${#live[@]}" -eq 0 ] && [ "${#fallbacks[@]}" -eq 0 ]; then
    echo "::warning::No apt mirror resolves; keeping the runner's mirror list."
    return 0
  fi
  local priority=10
  [ "${dropped}" -eq 0 ] || priority=0
  {
    for uri in "${fallbacks[@]}"; do
      [ "${priority}" -ne 0 ] || printf '%s\tpriority:0\n' "${uri}"
    done
    for line in "${live[@]}"; do
      printf '%s\n' "${line}"
    done
    for uri in "${fallbacks[@]}"; do
      [ "${priority}" -eq 0 ] || printf '%s\tpriority:10\n' "${uri}"
    done
  } | sudo tee "${APT_MIRRORS}.playwright" >/dev/null
  sudo mv "${APT_MIRRORS}.playwright" "${APT_MIRRORS}"
}

# Prints the packages the given browsers still need, one per line. A local
# `apt-get install -s` simulation inside Playwright; no network.
missing_packages() {
  local output status=0
  output="$(timeout --kill-after="${KILL_AFTER_SECONDS}s" 60s \
    bun x playwright install-deps --dry-run "$@" 2>&1)" || status=$?
  if [ "${status}" -ne 0 ] && ! grep -q '^Missing system dependencies' <<<"${output}"; then
    printf '%s\n' "${output}" >&2
    return 1
  fi
  awk '/^Missing system dependencies/ { listing = 1; next } listing && /^  [^ ]+$/ { print $1 }' <<<"${output}"
}

deb_file() {
  compgen -G "${DEB_DIR}/${1}_*.deb" | head -n 1
}

# Fills the deb cache with every browser's packages, using the network only
# for what it lacks. Succeeds when the cache holds them all, at the versions
# and hashes the package lists name.
fill_deb_cache() {
  local deadline=$1 all attempt=1 delay=10 remaining status
  all="$(missing_packages ${ALL_DEPS_TARGETS})" || return 1
  mkdir -p "${DEB_DIR}/partial"
  status=0
  sudo apt-get install -y --no-install-recommends --download-only --no-download \
    -o Dir::Cache::archives="${DEB_DIR}" ${all} >/dev/null 2>&1 || status=$?
  if [ "${status}" -eq 0 ]; then
    finish_deb_cache
    echo "The deb cache holds all $(wc -w <<<"${all}") browser system packages."
    return 0
  fi
  echo "The deb cache lacks some of the $(wc -w <<<"${all}") browser system packages; downloading them."
  prepare_mirrors
  while :; do
    remaining=$((deadline - SECONDS))
    [ "${remaining}" -ge 1 ] || { finish_deb_cache; return 1; }
    echo "::group::Download browser system packages attempt ${attempt}/${SYSTEM_DEPS_ATTEMPTS}"
    # Refresh the lists first: the archive drops superseded versions, so the
    # runner image's lists soon name debs that 404. A partly failed refresh
    # still leaves usable lists, so it never stops the download.
    timeout --kill-after="${KILL_AFTER_SECONDS}s" "${remaining}s" sudo apt-get update || true
    remaining=$((deadline - SECONDS))
    status=124
    if [ "${remaining}" -ge 1 ]; then
      status=0
      timeout --kill-after="${KILL_AFTER_SECONDS}s" "${remaining}s" \
        sudo apt-get install -y --no-install-recommends --download-only \
        -o Dir::Cache::archives="${DEB_DIR}" ${all} || status=$?
    fi
    echo "::endgroup::"
    if [ "${status}" -eq 0 ]; then
      # Drop debs the package lists no longer name (an older image's).
      sudo apt-get autoclean -o Dir::Cache::archives="${DEB_DIR}" >/dev/null 2>&1 || true
      finish_deb_cache
      return 0
    fi
    echo "::warning::Download browser system packages attempt ${attempt} failed with exit ${status}."
    remaining=$((deadline - SECONDS))
    if [ "${attempt}" -ge "${SYSTEM_DEPS_ATTEMPTS}" ] || [ "${remaining}" -le $((delay + 30)) ]; then
      finish_deb_cache
      return 1
    fi
    sleep "${delay}"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

# apt's working files stay out of the saved cache, and the runner user owns it.
finish_deb_cache() {
  sudo rm -rf "${DEB_DIR}/partial" "${DEB_DIR}/lock"
  sudo chown -R "$(id -u):$(id -g)" "${DEB_DIR}"
}

# Installs the given packages from the deb cache with no network.
install_from_deb_cache() {
  local files=() package file
  for package in "$@"; do
    file="$(deb_file "${package}")"
    if [ -z "${file}" ]; then
      echo "The deb cache has no ${package}."
      return 1
    fi
    files+=("${file}")
  done
  mkdir -p "${DEB_DIR}/partial"
  echo "::group::Install $# browser system packages from the deb cache"
  # apt resolves against the image's package lists and uses the cached debs
  # when their versions match; dpkg installs the cached debs when the lists
  # moved on. Only missing packages are installed, so nothing is downgraded.
  local status=0
  sudo apt-get install -y --no-install-recommends --no-download \
    -o Dir::Cache::archives="${DEB_DIR}" "$@" || status=$?
  if [ "${status}" -ne 0 ]; then
    status=0
    sudo dpkg -i --refuse-downgrade "${files[@]}" || status=$?
    if [ "${status}" -ne 0 ]; then
      sudo dpkg --configure -a >/dev/null 2>&1 || true
    fi
  fi
  echo "::endgroup::"
  finish_deb_cache
  return "${status}"
}

# Playwright's own apt install, with retries and backoff.
install_from_network() {
  local deadline=$1 attempt=1 delay=10 status remaining
  prepare_mirrors
  while :; do
    remaining=$((deadline - SECONDS))
    if [ "${remaining}" -lt 1 ]; then
      echo "::warning::Browser system packages ran out of their ${SYSTEM_DEPS_BUDGET_SECONDS}s budget."
      return 1
    fi
    echo "::group::Browser system packages attempt ${attempt}/${SYSTEM_DEPS_ATTEMPTS}"
    status=0
    timeout --kill-after="${KILL_AFTER_SECONDS}s" "${remaining}s" \
      bun x playwright install-deps ${deps_browsers} || status=$?
    echo "::endgroup::"
    if [ "${status}" -eq 0 ]; then
      return 0
    fi
    echo "::warning::Browser system packages attempt ${attempt} failed with exit ${status}."
    # Finish whatever a killed dpkg left half-configured.
    sudo dpkg --configure -a >/dev/null 2>&1 || true
    remaining=$((deadline - SECONDS))
    if [ "${attempt}" -ge "${SYSTEM_DEPS_ATTEMPTS}" ] || [ "${remaining}" -le $((delay + 30)) ]; then
      echo "::warning::Browser system packages failed to install after ${attempt} bounded attempts."
      return 1
    fi
    sleep "${delay}"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

# Installs the given packages from the deb cache, then succeeds when nothing
# the browsers need is missing any more.
install_from_cache_and_check() {
  local remaining
  install_from_deb_cache "$@" || return 1
  remaining="$(missing_packages ${deps_browsers})" || return 1
  still_missing="${remaining}"
  if [ -n "${remaining}" ]; then
    return 1
  fi
  echo "Installed the browser system packages from the deb cache."
}

install_system_packages() {
  local deadline=$((SECONDS + SYSTEM_DEPS_BUDGET_SECONDS)) needed
  if ! needed="$(missing_packages ${deps_browsers})"; then
    echo "::warning::Could not check the browser system packages; installing them with apt."
    needed="unknown"
  fi
  still_missing="${needed}"
  if [ -z "${needed}" ]; then
    echo "Browser system packages are already installed; skipping apt."
    return 0
  fi
  configure_apt
  if [ -n "${DEB_DIR}" ] && [ "${needed}" != "unknown" ]; then
    mkdir -p "${DEB_DIR}"
    # Offline first: a restored cache (possibly from an older image or newer
    # package lists) usually covers this job without any network.
    if install_from_cache_and_check ${needed}; then
      # Where the cache is saved, make it complete for every browser.
      if [ "${PLAYWRIGHT_DEBS_SAVE:-false}" = "true" ] && fill_deb_cache "${deadline}"; then
        set_output "debs-complete=true"
      fi
      return 0
    fi
    if fill_deb_cache "${deadline}"; then
      set_output "debs-complete=true"
    fi
    install_from_cache_and_check ${needed} && return 0
  fi
  install_from_network "${deadline}"
}

# Every shared library the installed browsers link resolves on this host.
browser_libraries_resolve() {
  local unresolved
  unresolved="$(find "${BROWSERS_DIR}" -type f \( -perm -u+x -o -name '*.so*' \) -print0 2>/dev/null \
    | xargs -0 -r ldd 2>/dev/null | grep 'not found' | sort -u)"
  if [ -n "${unresolved}" ]; then
    printf '%s\n' "${unresolved}"
    return 1
  fi
}

with_deps=""
system_packages=ok
if [ "${PLAYWRIGHT_RUNNER_OS}" = "Linux" ]; then
  sudo python3 "${PLAYWRIGHT_ACTION_PATH}/exclude-google-chrome-apt.py"
  install_system_packages || system_packages=failed
else
  with_deps="--with-deps"
fi

browsers_installed=false
attempt=1
while [ "${attempt}" -le "${ATTEMPTS}" ]; do
  attempt_timeout="${ATTEMPT_TIMEOUT_SECONDS}"
  if [ "${attempt}" -eq 1 ]; then
    attempt_timeout=$((ATTEMPT_TIMEOUT_SECONDS - (SECONDS - started)))
    if [ "${attempt_timeout}" -lt 1 ]; then
      echo "::error::Browser system packages used the whole ${ATTEMPT_TIMEOUT_SECONDS}s attempt."
      exit 1
    fi
  fi
  echo "::group::Playwright install attempt ${attempt}/${ATTEMPTS}"
  # The runner invokes the step as `bash --noprofile --norc -eo pipefail`;
  # the `|| status=$?` guard keeps a failing attempt from aborting the loop.
  status=0
  timeout --kill-after="${KILL_AFTER_SECONDS}s" "${attempt_timeout}s" \
    bun x playwright install ${with_deps} ${only_shell} ${PLAYWRIGHT_BROWSERS} || status=$?
  echo "::endgroup::"
  if [ "${status}" -eq 0 ]; then
    browsers_installed=true
    break
  fi
  if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
    echo "::warning::Playwright install attempt ${attempt} exceeded ${attempt_timeout}s and was killed."
  else
    echo "::warning::Playwright install attempt ${attempt} failed with exit ${status}."
  fi
  attempt=$((attempt + 1))
done
if [ "${browsers_installed}" != "true" ]; then
  echo "::error::Playwright install failed after ${ATTEMPTS} bounded attempts."
  exit 1
fi

if [ "${system_packages}" = "failed" ]; then
  if unresolved="$(browser_libraries_resolve)"; then
    echo "::warning::Browser system packages are missing ($(xargs <<<"${still_missing}")), but every library the browsers link resolves; continuing."
    exit 0
  fi
  printf '%s\n' "${unresolved}"
  echo "::error::Browser system packages are missing and the browsers cannot load their libraries."
  exit 1
fi
exit 0
