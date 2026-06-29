# 10 — Staging verification: the self-hosted sandbox V-matrix

**Status: VERIFIED.** The full self-hosted (BYO-compute) sandbox surface was proven
end-to-end against a real **managed-mode** deployment of merged `main`, driving a real
external Linux VM enrolled as a sandbox — **26/26 checks green across 5 consecutive runs.**

## What this proves

The self-hosted sandbox path is real, not just compiling: an operator enrolls their own
machine, the agent attaches/swaps to it, and every surfaced capability works against it —
structured Channel-A file/git/terminal services, the interactive PTY and desktop
framebuffer streamed over the relay, fleet liveness/metrics, and create-time machine
targeting. The matrix runs against a live control plane (managed mode: delegated
`workspace:admin` tokens, Stripe billing mode, managed entitlements), a live relay, and a
real VM dialing out over NATS.

## The matrix (26 checks)

Grouped by the capability each proves:

- **Provisioning & identity** — `SEED` (session row + synthesized group box), `MINT`
  (workspace:admin delegated token).
- **MCP surface** — `MCP` (tools/list envelope), `MCP-FLEET`
  (`sandboxes_list`/`attach`/`swap`/`run_on`/`provision` registered), **`MCP-TARGET`
  (`session_create` advertises `targetSandboxId` — create-time machine targeting).**
- **Install** — `INSTALL-BAKED` (the control plane self-serves the per-SHA signed agent
  from `/agent/*`), `INSTALL` (the agent installs on the VM with no external download host).
- **Enrollment (V2)** — `V2-START` (device/start → pending enrollment), `V2-APPROVE`
  (approve → enrollment + sandbox rows), `V2-ROWS` (rows persist, `kind=selfhosted`).
- **Fleet attach/swap (V3)** — `V3-LIST` (group box + enrolled machine both listed),
  `V3-LIVENESS` (machine ONLINE via a real ControlRpc ping over NATS), `V3-SWAP`
  (heterogeneous swap group→selfhosted, epoch-fenced), `V3-SWAPBACK`.
- **Structured Channel-A (V4)** — `V4-EXEC` (`run_on` exec on the VM), `V4-FS` (write+read
  round-trip), `V4-GIT` (init/commit/log).
- **Interactive streams (V5/V6), over the relay** — `V5-CAPS` (terminalStream is the relay
  PTY ws, not a provider tunnel), `V5-PTY` (live PTY round-trip reaches the VM shell),
  `V6-ACK` (un-redacted desktop-consent gate), `V5b-CAPS-POSTACK`, `V6-CAPS` (desktopStream
  is the relay framebuffer), `V6-FB` (≥1 framebuffer frame received).
- **Metrics (V9)** — `V9-METRICS` (fleet machine surfaced with a cpu/mem heartbeat sample),
  `V9-SERIES` (time-series endpoint returns samples).
- **Teardown** — `REVOKE` (enrollment revoked via the workspace-scoped API).

## Provenance

Verified against merged `main` at SHA `310680188` (the combined feature, including the PR
that closed the create-time machine-targeting gap by exposing `targetSandboxId` on the
`session_create` MCP tool). The run also exercises the relay channel-affinity / stream
`lease_cold` fix and the install-from-control-plane path (a baked, signed agent served from
the API — no external download host).

## Reproducing

The harness lives at `apps/api/scripts/`:

- `proveit-selfhosted-staging.ts` — the single-run matrix driver. Self-installs the agent on
  a target VM over SSH, drives the MCP + REST + relay surfaces, and asserts each claim,
  writing per-check evidence.
- `proveit-staging-x5.sh` — orchestrates N consecutive runs against a seeded synthetic
  account/workspace, aggregates pass/fail, and (opt-in) reaps the synthetic account.

It is **deployment-agnostic**: point it at any managed-mode deployment via env
(`OGE_API`, `OGE_RELAY_HOST`, `OGE_VM_IP`, `OGE_VM_USER`, `OGE_VM_HOST`, `OGE_NS`). The
firewalled control-plane Postgres is reached through the API pod (the conventional
firewalled-DB-via-pod pattern), using the role in `OPENGENI_DATABASE_URL`.

### RLS note (managed deployments)

When the control-plane Postgres enforces row-level security on
`sessions` / `credit_ledger_entries` (workspace isolation) and the app DB role is not
`BYPASSRLS`, a direct seed/teardown of those tables must set the RLS-context GUCs
(`opengeni.account_id`, `opengeni.workspace_id`) on the connection before the write —
otherwise the insert/delete is denied by the `WITH CHECK` / `USING` predicate. The harness
does this in its in-pod query helper (the permissive `managed_accounts` / `workspaces` /
`workspace_memberships` tables need no such context).
