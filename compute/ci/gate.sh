#!/usr/bin/env bash
# The compute gate: every check of compute/ on one Linux machine with KVM,
# from formatting to real Firecracker VMs, the smoke suite and the E2B
# conformance suite. CI runs the steps a hosted runner can (see
# .github/workflows/compute-ci.yml); a lab host prepared by
# lab/host-setup.sh runs them all before a merge.
#
# Run as an ordinary user with passwordless sudo, from compute/ or with SRC
# naming it. Ordinary tests run as that user, since some fault-injection
# tests rely on permission errors root would not see; steps that need root
# run their test binaries under sudo.
#
#   [STEPS="fmt clippy ..."] [LAB=/lab] [PROFILE=nested] ci/gate.sh
#
# Steps, in this order (STEPS picks some; default all):
#   fmt clippy arch workspace python    no KVM needed
#   lab-setup                           prepares LAB with lab/host-setup.sh
#                                       when it lacks Firecracker, the guest
#                                       kernel or the base image
#   pager networking engine save_wake lab guest smoke conformance
#                                       real VMs, as root
#
# Settings: SRC (this checkout's compute/), LAB (/lab), PROFILE (`nested` or
# `bare-metal`; the agent's own choice when unset), STORE (a directory or
# gs:// URL for save_wake, LAB/gate-store), SANDBOXES (12, for `lab`),
# SHARED_EXTENTS (a directory on XFS or btrfs, LAB/at), GUEST (where
# guest/build.sh puts its output, LAB/gate-guest), CARGO_TARGET_DIR.
#
# Every step's status counts: the gate ends with GATE_PASSED, or with
# GATE_FAILED and the failed steps and exits 1. KVM steps set
# COMPUTE_TEST_REQUIRE, so a test that would skip for want of the lab, the
# store or the guest fails instead of passing silently. The last line is
# GATE_DONE.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${SRC:-$(cd "$HERE/.." && pwd)}
LAB=${LAB:-/lab}
STORE=${STORE:-$LAB/gate-store}
SANDBOXES=${SANDBOXES:-12}
SHARED_EXTENTS=${SHARED_EXTENTS:-$LAB/at}
GUEST=${GUEST:-$LAB/gate-guest}
ALL="fmt clippy arch workspace python lab-setup pager networking engine save_wake lab guest smoke conformance"
STEPS=${STEPS:-$ALL}
export PATH=$HOME/.cargo/bin:$PATH
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$SRC/target}
cd "$SRC" || exit 1

FAILED=()
wants() { case " $STEPS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
step() { echo "== $(date -u +%H:%M:%S) $*"; }
root() { CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER="sudo -E" "$@"; }
profile() { if [ -n "${PROFILE:-}" ]; then echo "COMPUTE_TEST_PROFILE=$PROFILE"; fi; }
# check NAME FILTER CMD...: runs CMD, shows the lines of its output FILTER
# matches, and records NAME as failed if CMD exits non-zero.
check() {
  local name=$1 filter=$2 log status
  shift 2
  log=$(mktemp)
  "$@" >"$log" 2>&1
  status=$?
  grep -E "$filter" "$log" | head -200
  if [ "$status" -ne 0 ]; then
    FAILED+=("$name")
    echo "!! $name exited $status; its last lines:"
    tail -60 "$log"
  fi
  rm -f "$log"
}
TESTS='^test result|FAILED|panicked|^error|skipped:'

for name in $STEPS; do
  case " $ALL " in *" $name "*) ;; *) echo "unknown step $name" >&2; exit 2 ;; esac
done
echo "gate of $SRC on $(hostname), $(uname -r), steps: $STEPS"

if wants fmt; then
  step fmt
  check fmt '^Diff' cargo fmt --all --check
fi
if wants clippy; then
  step clippy
  check clippy '^(error|warning)' cargo clippy --locked --workspace --all-targets -- -D warnings
fi
if wants arch; then
  step arch
  # The baseline is compared with the base branch's copy where git can
  # find it; a copied tree without .git checks the rules alone.
  if git rev-parse --git-dir >/dev/null 2>&1; then
    check arch '.' cargo arch
  else
    check arch '.' cargo arch --no-base
  fi
fi
if wants workspace; then
  step workspace tests
  mkdir -p "$SHARED_EXTENTS"
  check workspace "$TESTS" env COMPUTE_TEST_SHARED_EXTENTS_DIR="$SHARED_EXTENTS" \
    COMPUTE_TEST_REQUIRE=shared-extents cargo test --locked --workspace
fi
if wants python; then
  step python
  check python '^(Ran|OK|FAILED)' bash -c 'cd smoke && python3 -m unittest discover -s compute_smoke/tests -t .'
fi
if wants lab-setup; then
  step "lab-setup ($LAB)"
  if [ -x "$LAB/bin/firecracker" ] && [ -x "$LAB/bin/jailer" ] && [ -f "$LAB/vmlinux" ] && [ -f "$LAB/base.ext4" ]; then
    echo "lab ready: $("$LAB/bin/firecracker" --version | head -1)"
  else
    check lab-setup '^\[host-setup' env LAB_DIR="$LAB" SWAP_SIZE="${SWAP_SIZE:-4G}" bash lab/host-setup.sh
  fi
fi
if wants pager; then
  step pager kernel tests
  check pager "$TESTS" root cargo test --locked -p compute-pager -- --ignored
fi
if wants networking; then
  step networking
  check networking "$TESTS" root env COMPUTE_TEST_LAB="$LAB" COMPUTE_TEST_REQUIRE=lab \
    cargo test --locked -p compute-host --lib net:: -- --test-threads 1
fi
if wants engine; then
  step engine
  check engine "$TESTS" root env COMPUTE_TEST_LAB="$LAB" COMPUTE_TEST_REQUIRE=lab \
    cargo test --locked --release -p compute-engine --test firecracker -- --test-threads 1
fi
if wants save_wake; then
  step "save_wake (store $STORE)"
  case $STORE in gs://* | az://* | s3://*) ;; *) sudo rm -rf "$STORE" ;; esac
  # shellcheck disable=SC2046 # profile() prints one word or nothing
  check save_wake "$TESTS" root env COMPUTE_TEST_LAB="$LAB" COMPUTE_TEST_REQUIRE=lab,store \
    $(profile) COMPUTE_TEST_STORE="$STORE" \
    cargo test --locked --release -p compute-host --test save_wake -- --test-threads 1
  case $STORE in gs://* | az://* | s3://*) ;; *) sudo rm -rf "$STORE" ;; esac
fi
if wants lab; then
  step "lab ($SANDBOXES sandboxes)"
  # shellcheck disable=SC2046
  check lab "$TESTS" root env COMPUTE_TEST_LAB="$LAB" COMPUTE_TEST_REQUIRE=lab \
    $(profile) COMPUTE_TEST_SANDBOXES="$SANDBOXES" \
    cargo test --locked --release -p compute-host --test lab -- --test-threads 1
fi
if wants guest || wants conformance; then
  if ! command -v musl-gcc >/dev/null; then
    sudo apt-get install -y -qq musl-tools >/dev/null 2>&1
  fi
  step "guest build ($GUEST)"
  check guest-build '^\[guest-build|^error' env OUT="$GUEST" bash guest/build.sh
fi
if wants guest; then
  step guest
  # shellcheck disable=SC2046
  check guest "$TESTS" root env COMPUTE_TEST_LAB="$LAB" COMPUTE_TEST_REQUIRE=lab,guest \
    $(profile) COMPUTE_TEST_GUEST="$GUEST" \
    cargo test --locked --release -p compute-host --test guest -- --test-threads 1
fi
if wants smoke; then
  step smoke
  smoke_tests=$(find smoke/compute_smoke/scenarios -name '[a-z]*.py' | wc -l)
  smoke_log=$(mktemp)
  SRC=$SRC LAB=$LAB bash "$HERE/smoke-run.sh" >"$smoke_log" 2>&1
  grep -E "^[0-9]{2}:|^END |suite exit" "$smoke_log"
  passed=$(grep -c "END .*PASS" "$smoke_log")
  if ! grep -q "^suite exit 0$" "$smoke_log" || [ "$passed" -ne "$smoke_tests" ]; then
    FAILED+=("smoke")
    echo "!! smoke: $passed of $smoke_tests passed; its last lines:"
    tail -60 "$smoke_log"
  fi
  rm -f "$smoke_log"
fi
if wants conformance; then
  step conformance
  check conformance-build '^error' cargo build --locked --release -p compute-host -p compute-control
  check conformance '^== |^SUITE|^END |checks passed|^not ok' sudo -E env PATH="$PATH" LAB="$LAB" \
    CONTROL_BIN="$CARGO_TARGET_DIR/release/compute-control" \
    HOST_BIN="$CARGO_TARGET_DIR/release/compute-host" GUEST="$GUEST" ${PROFILE:+PROFILE=$PROFILE} \
    bash conformance/e2b/run.sh
fi

if [ ${#FAILED[@]} -eq 0 ]; then
  step GATE_PASSED
  step GATE_DONE
else
  step "GATE_FAILED: ${FAILED[*]}"
  step GATE_DONE
  exit 1
fi
