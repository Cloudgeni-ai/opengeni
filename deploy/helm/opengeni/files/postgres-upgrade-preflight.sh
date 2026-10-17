#!/bin/bash
# Rehearses an embedded Postgres major-version upgrade before it happens.
#
# Runs as a Helm pre-upgrade hook from the new server image while the old
# server keeps serving, so a failure stops the release before the StatefulSet
# changes and nothing goes down. It copies the schema (no rows) of every
# database into a scratch cluster of the old major, then runs the new
# pg_upgrade --check against that copy. pg_upgrade's compatibility checks read
# schema and installed libraries, not rows, so they fail here exactly as they
# would fail in the in-place upgrade: a reg* column, a removed type, an
# extension library missing from the new image, and so on.
set -euo pipefail

: "${PG_MAJOR:?PG_MAJOR is required (set by the PostgreSQL image)}"
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
OLD_ROOT=${OPENGENI_POSTGRES_OLD_ROOT:-/opengeni-postgres-old}
WORK=${OPENGENI_POSTGRES_PREFLIGHT_WORK:-/opengeni-postgres-preflight}
NEW_MAJOR=${PG_MAJOR%%.*}
NEW_BIN="/usr/lib/postgresql/$NEW_MAJOR/bin"

log() { printf 'postgres-upgrade-preflight: %s\n' "$*" >&2; }
fail() {
  log "$*"
  exit 1
}
as_postgres() { gosu postgres "$@"; }
live() { "$NEW_BIN/psql" -X -A -t -v ON_ERROR_STOP=1 -d postgres -c "$1"; }

LIVE_MAJOR=$(live "SELECT pg_catalog.current_setting('server_version_num')::int / 10000")
if [ "$LIVE_MAJOR" = "$NEW_MAJOR" ]; then
  log "the running server is already PostgreSQL $NEW_MAJOR; nothing to check"
  exit 0
fi
[ "$LIVE_MAJOR" -lt "$NEW_MAJOR" ] ||
  fail "the running server is PostgreSQL $LIVE_MAJOR but postgres.image is PostgreSQL $NEW_MAJOR"

OLD_BIN="$OLD_ROOT/usr/lib/postgresql/$LIVE_MAJOR/bin"
[ -x "$OLD_BIN/postgres" ] ||
  fail "postgres.majorUpgrade.fromImage did not provide PostgreSQL $LIVE_MAJOR binaries; set it to the running PostgreSQL $LIVE_MAJOR image"
[ -x "$NEW_BIN/pg_upgrade" ] || fail "the server image has no $NEW_BIN/pg_upgrade"

# The scratch clusters mirror what the in-place upgrade creates: data
# checksums follow the live cluster, and both use the image's defaults.
checksums=--no-data-checksums
old_checksums=()
if [ "$(live "SHOW data_checksums")" = "on" ]; then
  checksums=--data-checksums
  old_checksums=(--data-checksums)
fi

old_data="$WORK/old"
new_data="$WORK/new"
sockets="$WORK/sockets"
dumps="$WORK/dumps"
mkdir -p "$sockets" "$dumps"
chown -R postgres:postgres "$WORK"
chmod 700 "$WORK"

log "copying the PostgreSQL $LIVE_MAJOR schema of every database into a scratch cluster"
as_postgres "$OLD_BIN/initdb" -D "$old_data" -U "$PGUSER" --auth=trust --no-sync "${old_checksums[@]}" >/dev/null
stop_old() { as_postgres "$OLD_BIN/pg_ctl" -D "$old_data" -m fast -w stop >/dev/null 2>&1 || true; }
trap stop_old EXIT
as_postgres "$OLD_BIN/pg_ctl" -D "$old_data" -w -l "$WORK/old-server.log" \
  -o "-c listen_addresses='' -c unix_socket_directories='$sockets' -c fsync=off" start >/dev/null
scratch() { PGHOST="$sockets" PGPASSWORD="" "$OLD_BIN/psql" -X -q "$@"; }

# Roles first. The install user already exists in the scratch cluster, so its
# CREATE ROLE is the one error a correct copy can raise.
"$OLD_BIN/pg_dumpall" --globals-only --no-role-passwords >"$dumps/globals.sql"
if ! scratch -d postgres -v ON_ERROR_STOP=0 -f "$dumps/globals.sql" 2>"$dumps/globals.err" >/dev/null; then
  fail "restoring roles into the scratch cluster failed: $(cat "$dumps/globals.err")"
fi
if grep '^psql:.*ERROR:' "$dumps/globals.err" | grep -v "role \"$PGUSER\" already exists" | grep -q .; then
  fail "restoring roles into the scratch cluster failed: $(cat "$dumps/globals.err")"
fi

while IFS= read -r database; do
  [ -n "$database" ] || continue
  log "copying the schema of database $database"
  if [ "$database" = postgres ]; then
    "$OLD_BIN/pg_dump" --schema-only -d postgres >"$dumps/postgres.sql"
    scratch -d postgres -v ON_ERROR_STOP=1 -f "$dumps/postgres.sql" >/dev/null
  else
    "$OLD_BIN/pg_dump" --schema-only --create -d "$database" >"$dumps/database.sql"
    scratch -d postgres -v ON_ERROR_STOP=1 -f "$dumps/database.sql" >/dev/null
  fi
done < <(live "SELECT datname FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname")
stop_old
trap - EXIT

as_postgres "$NEW_BIN/initdb" -D "$new_data" -U "$PGUSER" --auth=trust --no-sync "$checksums" >/dev/null
log "running PostgreSQL $NEW_MAJOR pg_upgrade --check against the copy"
cd "$WORK"
# pg_upgrade names the objects behind each failure or warning in report files;
# print them so the hook's log says what to change or watch.
reports() {
  find "$new_data" -path '*pg_upgrade_output.d*' -name '*.txt' -print0 2>/dev/null |
    while IFS= read -r -d '' report; do
      log "$(basename "$report"):"
      cat "$report" >&2
    done
}
# pg_upgrade refuses a remote PGHOST; it only talks to the scratch sockets.
if ! as_postgres env -u PGHOST -u PGPORT -u PGPASSWORD -u PGDATABASE "$NEW_BIN/pg_upgrade" \
  --old-bindir "$OLD_BIN" \
  --new-bindir "$NEW_BIN" \
  --old-datadir "$old_data" \
  --new-datadir "$new_data" \
  --username "$PGUSER" \
  --socketdir "$sockets" \
  --link \
  --retain \
  --check; then
  reports
  fail "pg_upgrade --check failed: the PostgreSQL $LIVE_MAJOR to $NEW_MAJOR upgrade would fail. Nothing was changed; the running server keeps serving."
fi
reports
log "pg_upgrade --check passed: the PostgreSQL $LIVE_MAJOR schema can be upgraded to $NEW_MAJOR"
