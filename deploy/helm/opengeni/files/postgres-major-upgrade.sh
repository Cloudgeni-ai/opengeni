#!/bin/bash
# Embedded Postgres data-directory guard and in-place major-version upgrade.
#
# Runs as an init container from the server image before PostgreSQL starts.
# Without an older data directory it does nothing. With one, it either refuses
# (upgrade not enabled) or runs pg_upgrade --link from the older binaries that
# the postgres-old-binaries init container copied into $OLD_ROOT.
#
# Every step is restartable: the new cluster is never started before the
# final rename, so an interrupted upgrade is undone by restoring the old
# pg_control and discarding the half-built directory.
set -euo pipefail

: "${PGDATA:?PGDATA is required}"
: "${PG_MAJOR:?PG_MAJOR is required (set by the PostgreSQL image)}"
OLD_ROOT=${OPENGENI_POSTGRES_OLD_ROOT:-/opengeni-postgres-old}
UPGRADE_ENABLED=${OPENGENI_POSTGRES_MAJOR_UPGRADE:-false}
NEW_MAJOR=${PG_MAJOR%%.*}
NEW_DIR="$PGDATA.upgrading-to-$NEW_MAJOR"
READY_MARKER="$NEW_DIR/.opengeni-upgrade-complete"

log() { printf 'postgres-major-upgrade: %s\n' "$*" >&2; }
fail() {
  log "$*"
  exit 1
}
as_postgres() { gosu postgres "$@"; }

retained_dirs() {
  find "$(dirname "$PGDATA")" -mindepth 1 -maxdepth 1 -type d -name "$(basename "$PGDATA").pre-upgrade-from-*" -print
}

# A crash between the two final renames leaves only the finished new
# directory: complete the swap.
if [ ! -e "$PGDATA" ] && [ -f "$READY_MARKER" ]; then
  log "completing the interrupted final rename of the upgraded PostgreSQL $NEW_MAJOR directory"
  mv "$NEW_DIR" "$PGDATA"
  rm -f "$PGDATA/.opengeni-upgrade-complete"
  exit 0
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  # Never let the image entrypoint initialize an empty cluster over an
  # upgrade that was moved aside but not finished.
  if [ -n "$(retained_dirs)" ]; then
    fail "$PGDATA is missing but a pre-upgrade directory exists ($(retained_dirs | tr '\n' ' ')). Refusing to create an empty cluster. Restore the directory or finish the upgrade by hand."
  fi
  log "no existing PostgreSQL data directory; nothing to check"
  exit 0
fi

OLD_MAJOR=$(cat "$PGDATA/PG_VERSION")
if [ "$OLD_MAJOR" = "$NEW_MAJOR" ]; then
  if [ -d "$NEW_DIR" ]; then
    fail "$NEW_DIR exists beside a PostgreSQL $NEW_MAJOR data directory; inspect and remove it by hand"
  fi
  exit 0
fi
if ! [[ "$OLD_MAJOR" =~ ^[0-9]+$ ]] || [ "$OLD_MAJOR" -gt "$NEW_MAJOR" ]; then
  fail "data directory is PostgreSQL $OLD_MAJOR but the image is PostgreSQL $NEW_MAJOR; use an image of at least version $OLD_MAJOR"
fi
if [ "$UPGRADE_ENABLED" != "true" ]; then
  fail "data directory is PostgreSQL $OLD_MAJOR but the image is PostgreSQL $NEW_MAJOR. Either set postgres.image.tag back to a PostgreSQL $OLD_MAJOR image, or set postgres.majorUpgrade.enabled=true with postgres.majorUpgrade.fromImage at PostgreSQL $OLD_MAJOR to upgrade in place."
fi

OLD_BIN="$OLD_ROOT/usr/lib/postgresql/$OLD_MAJOR/bin"
NEW_BIN="/usr/lib/postgresql/$NEW_MAJOR/bin"
[ -x "$OLD_BIN/postgres" ] ||
  fail "postgres.majorUpgrade.fromImage did not provide PostgreSQL $OLD_MAJOR binaries; set it to a PostgreSQL $OLD_MAJOR image built on the same OS release as postgres.image"
[ -x "$NEW_BIN/pg_upgrade" ] || fail "the server image has no $NEW_BIN/pg_upgrade"

# An earlier attempt that did not finish: undo it. The new cluster was never
# started, so restoring pg_control makes the old cluster usable again.
if [ -d "$NEW_DIR" ]; then
  log "discarding an unfinished upgrade attempt in $NEW_DIR"
  if [ -f "$PGDATA/global/pg_control.old" ] && [ ! -f "$PGDATA/global/pg_control" ]; then
    mv "$PGDATA/global/pg_control.old" "$PGDATA/global/pg_control"
  fi
  rm -rf "$NEW_DIR"
fi
[ -f "$PGDATA/global/pg_control" ] || fail "$PGDATA/global/pg_control is missing; refusing to continue"
RETAINED="$PGDATA.pre-upgrade-from-$OLD_MAJOR"
[ ! -e "$RETAINED" ] || fail "$RETAINED already exists; move it away and restart the pod"

# The same ownership and mode the image entrypoint enforces before every
# start; volume group-ownership handling can loosen them, and PostgreSQL
# refuses a group-writable data directory.
find "$PGDATA" \! -user postgres -exec chown postgres '{}' +
chmod 700 "$PGDATA"

checksums=--no-data-checksums
if "$OLD_BIN/pg_controldata" "$PGDATA" | grep -Eq '^Data page checksum version:[[:space:]]+[1-9]'; then
  checksums=--data-checksums
fi

log "upgrading PostgreSQL $OLD_MAJOR data in $PGDATA to PostgreSQL $NEW_MAJOR (pg_upgrade --link)"
mkdir -p "$NEW_DIR"
chown postgres:postgres "$NEW_DIR"
chmod 700 "$NEW_DIR"
as_postgres "$NEW_BIN/initdb" -D "$NEW_DIR" -U "${POSTGRES_USER:-postgres}" "$checksums" >/dev/null

work=$(mktemp -d)
chown postgres:postgres "$work"
cd "$work"
upgrade=(
  "$NEW_BIN/pg_upgrade"
  --old-bindir "$OLD_BIN"
  --new-bindir "$NEW_BIN"
  --old-datadir "$PGDATA"
  --new-datadir "$NEW_DIR"
  --username "${POSTGRES_USER:-postgres}"
  --socketdir "$work"
  --link
)
as_postgres "${upgrade[@]}" --check
as_postgres "${upgrade[@]}"

# The new cluster keeps its own postgresql.conf (the image's defaults, with
# server parameters supplied as -c flags); access rules and ALTER SYSTEM
# settings carry over.
for file in pg_hba.conf pg_ident.conf postgresql.auto.conf; do
  if [ -f "$PGDATA/$file" ]; then
    cp -p "$PGDATA/$file" "$NEW_DIR/$file"
  fi
done
touch "$READY_MARKER"
chown postgres:postgres "$READY_MARKER"
sync

mv "$PGDATA" "$RETAINED"
mv "$NEW_DIR" "$PGDATA"
rm -f "$PGDATA/.opengeni-upgrade-complete"
sync
log "upgraded to PostgreSQL $NEW_MAJOR. The old directory is kept at $RETAINED; once the new cluster has started it can no longer be used and can be deleted after verification. Run 'vacuumdb --all --analyze-in-stages --missing-stats-only', then 'vacuumdb --all --analyze-only', and ALTER EXTENSION ... UPDATE for each extension."
