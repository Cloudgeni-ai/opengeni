#!/usr/bin/env bash
# proveit-staging-x5 — orchestrate the selfhosted V-matrix N× (default 5) against
# a DEPLOYED, MANAGED-MODE control plane (point it at your deployment via
# OGE_API / OGE_RELAY_HOST / OGE_NS). Seeds ONE dedicated synthetic managed account + workspace (+ owner
# membership for the token subject), runs proveit-selfhosted-staging.ts N times with
# per-run evidence dirs, aggregates pass/fail, and — ONLY with OGE_TEARDOWN=1 —
# reaps the synthetic account at the end.
#
# The control-plane Postgres is firewalled (reachable only from inside the api pod),
# so the seed/teardown SQL runs a tiny `postgres`-pkg helper INSIDE the api pod via
# `kubectl exec` (same mechanism as the driver's db()).
#
# Required env:  OGE_VM_IP           the external Azure Linux VM running the agent
# Common env:    OGE_DEPLOYED_SHA    the deployed source SHA (provenance, evidence)
#                OGE_RUNS            iterations (default 5)
#                OGE_ACCOUNT/OGE_WS  reuse an already-seeded account/workspace
#                OGE_TEARDOWN=1      reap the synthetic account after the runs
set -euo pipefail

# Operator config: source proveit.local.env (gitignored) if present, so a full run is a
# single command. Copy proveit.local.env.example -> proveit.local.env and fill it in.
HERE_EARLY="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE_EARLY/proveit.local.env" ]; then set -a; . "$HERE_EARLY/proveit.local.env"; set +a; fi

NS="${OGE_NS:-opengeni}"
API="${OGE_API:?set OGE_API (copy apps/api/scripts/proveit.local.env.example -> proveit.local.env)}"
RELAY_HOST="${OGE_RELAY_HOST:?set OGE_RELAY_HOST (see proveit.local.env.example)}"
RUNS="${OGE_RUNS:-5}"
VM_IP="${OGE_VM_IP:?set OGE_VM_IP (see proveit.local.env.example)}"
VM_USER="${OGE_VM_USER:?set OGE_VM_USER (see proveit.local.env.example)}"
VM_HOST="${OGE_VM_HOST:?set OGE_VM_HOST (see proveit.local.env.example)}"
SSH_KEY="${OGE_SSH_KEY:-/tmp/staging-verify/vm_key}"
DEPLOYED_SHA="${OGE_DEPLOYED_SHA:-unknown}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DRIVER="$HERE/proveit-selfhosted-staging.ts"
EVID_BASE="${OGE_EVID_BASE:-$HERE/../../../docs/design/sandbox-surfacing/evidence/selfhosted-staging}"
mkdir -p "$EVID_BASE"

echo "== resolving api pod in ns $NS =="
APIPOD="$(kubectl get pods -n "$NS" -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')"
[ -n "$APIPOD" ] || { echo "FATAL: no api pod in ns $NS"; exit 1; }
echo "api pod = $APIPOD"

# stage the in-pod query helper (query on stdin, |-joined rows on stdout)
cat > /tmp/ogq.mjs <<'HELPER'
import postgres from "postgres";
const sql = postgres(process.env.OPENGENI_DATABASE_URL, { ssl: "require", max: 1 });
const q = await Bun.stdin.text();
try {
  // RLS-protected tables (sessions/credit_ledger) need the opengeni.account_id /
  // opengeni.workspace_id GUCs; set them from env before the caller's query (no-op
  // when unset — the seed inserts only permissive tables before any account exists).
  const rlsAcct = process.env.OGE_RLS_ACCOUNT, rlsWs = process.env.OGE_RLS_WS;
  if (rlsAcct) await sql.unsafe("select set_config('opengeni.account_id', $1, false)", [rlsAcct]);
  if (rlsWs) await sql.unsafe("select set_config('opengeni.workspace_id', $1, false)", [rlsWs]);
  const rows = await sql.unsafe(q);
  const out = (Array.isArray(rows) ? rows : []).map((r) => Object.values(r).map((v) => v === null ? "" : String(v)).join("|")).join("\n");
  process.stdout.write(out);
} catch (e) { process.stderr.write("OGQ_ERR " + e.message); process.exit(3); } finally { await sql.end(); }
HELPER
kubectl exec -i -n "$NS" "$APIPOD" -- bash -lc 'cat > /tmp/ogq.mjs' < /tmp/ogq.mjs
# db() threads the seeded account/workspace into the RLS GUCs (empty until seeded — the
# seed itself only touches permissive tables; teardown's session delete needs them set).
db() { kubectl exec -i -n "$NS" "$APIPOD" -- bash -lc "cd /app && OGE_RLS_ACCOUNT='${ACCOUNT:-}' OGE_RLS_WS='${WS:-}' bun /tmp/ogq.mjs"; }

# seed (or reuse) a dedicated synthetic account + workspace + owner membership.
if [ -n "${OGE_ACCOUNT:-}" ] && [ -n "${OGE_WS:-}" ]; then
  ACCOUNT="$OGE_ACCOUNT"; WS="$OGE_WS"
  echo "== reusing account=$ACCOUNT ws=$WS =="
else
  SEED="$(db <<'SQL'
with a as (insert into managed_accounts (name) values ('BYO Verify (ephemeral)') returning id),
     w as (insert into workspaces (account_id, name) select id, 'BYO Verify WS (ephemeral)' from a returning id, account_id),
     m as (insert into workspace_memberships (account_id, workspace_id, subject_id, role)
           select account_id, id, 'proveit-selfhosted', 'owner' from w returning workspace_id)
-- DISTINCT aliases are load-bearing: the postgres client returns one object per
-- row, so two columns both named "id" collapse to a single key (workspace id),
-- handing the SAME value to ACCOUNT and WS. account_id/workspace_id keep them apart.
select (select id from a) as account_id, (select id from w) as workspace_id;
SQL
)"
  ACCOUNT="${SEED%%|*}"; WS="${SEED##*|}"
  [ -n "$ACCOUNT" ] && [ -n "$WS" ] || { echo "FATAL: seed failed: [$SEED]"; exit 1; }
  echo "== seeded account=$ACCOUNT ws=$WS =="
fi

# NOTE: no credit-ledger seeding. The matrix never calls createSessionForRequest
# (the driver inserts its session row directly) and never dispatches an LLM agent
# turn — it only drives sandboxes_list / sandbox_swap / run_on (Channel-A exec on
# an already-active sandbox). None of those touch the managed-mode credit gate
# (requireLimit "agent_run:create" / ensureRunAllowed), so a zero-balance synthetic
# account runs clean. (credit_ledger_entries is RLS-protected anyway; a raw insert
# via the app role is denied — and would only be needed for a real billed turn.)

# run the V-matrix N times (sequential — one VM, one agent at a time).
declare -a RESULTS
ALL_PASS=1
for i in $(seq 1 "$RUNS"); do
  echo ""
  echo "############### RUN $i / $RUNS ###############"
  OGE_NS="$NS" OGE_API="$API" OGE_RELAY_HOST="$RELAY_HOST" OGE_WS="$WS" OGE_ACCOUNT="$ACCOUNT" \
  OGE_VM_IP="$VM_IP" OGE_VM_USER="$VM_USER" OGE_VM_HOST="$VM_HOST" OGE_SSH_KEY="$SSH_KEY" \
  OGE_DEPLOYED_SHA="$DEPLOYED_SHA" OGE_RUN_INDEX="$i" OGE_EVID_BASE="$EVID_BASE" \
    bun "$DRIVER" || true
  SUM="$EVID_BASE/run-$i/00-summary.json"
  if [ -f "$SUM" ]; then
    P="$(jq -r '.passed' "$SUM")"; T="$(jq -r '.total' "$SUM")"; F="$(jq -r '.failed' "$SUM")"
    # GREEN requires a COMPLETE run: total>0 AND zero failures AND every check passed.
    # (A driver that crashes mid-seed writes total=0/failed=0 — that is NOT green; the
    # old `[ "$F" = "0" ]`-only test scored such a crash as a false green.)
    if [ "${T:-0}" -gt 0 ] && [ "$F" = "0" ] && [ "$P" = "$T" ]; then
      RESULTS+=("run$i: $P/$T passed ✅")
    else
      RESULTS+=("run$i: $P/$T passed, ${F} failed — INCOMPLETE/FAILING ❌")
      ALL_PASS=0
      echo "run $i NOT GREEN:"; jq -r '.checks[] | select(.pass==false) | "  FAIL [\(.id)] \(.what) — \(.detail)"' "$SUM"
    fi
  else
    RESULTS+=("run$i: NO-SUMMARY (driver crashed before summary)")
    ALL_PASS=0
  fi
done

echo ""
echo "################# AGGREGATE #################"
printf '%s\n' "${RESULTS[@]}"
echo "deployedSha=$DEPLOYED_SHA  api=$API  account=$ACCOUNT  ws=$WS"
[ "$ALL_PASS" = "1" ] && echo "RESULT: ALL RUNS GREEN ✅" || echo "RESULT: NOT ALL GREEN ❌"

# teardown is gated (M12 cleanup runs only after staging is fully verified).
if [ "${OGE_TEARDOWN:-0}" = "1" ]; then
  echo "== teardown: reaping synthetic account $ACCOUNT =="
  db <<SQL
delete from workspace_memberships where workspace_id='$WS';
delete from sessions where workspace_id='$WS';
delete from workspaces where id='$WS';
delete from managed_accounts where id='$ACCOUNT';
SQL
  echo "teardown complete"
else
  echo "(synthetic account retained; re-run with OGE_TEARDOWN=1 to reap, or reuse via OGE_ACCOUNT=$ACCOUNT OGE_WS=$WS)"
fi

[ "$ALL_PASS" = "1" ]
