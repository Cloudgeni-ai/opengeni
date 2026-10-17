# 20. Opengeni runs on the fabric through its e2b backend

Status: Accepted, 2026-10-17

## Context

Opengeni chooses one sandbox backend per deployment (Modal, E2B, Daytona,
Runloop, OpenSandbox, a person's own machine and others), each a small
registration around an SDK adapter. The fabric needs to serve Opengeni
sessions: create, commands and terminals, files, preview ports, and a
sandbox that comes back with its files and programs after a pause. The
fabric already speaks E2B's API and runs E2B's envd in every guest
(ADR 19), so that E2B clients work unchanged.

Opengeni's e2b backend is dormant: the E2B SDK it loads is not installed,
and its API key setting is checked but never handed to the SDK, which
reads its connection (key, domain, API address) only from `E2B_*`
variables.

The options were:

1. **Opengeni's e2b backend, pointed at our front door.** Commands, PTYs,
   files, preview hosts (`<port>-<id>.<domain>`), pause at the timeout and
   exact resume through `connect` already exist and are the surface the
   front door's conformance suite runs.
2. **A new `compute` backend speaking compute-control's own API.** It
   would show our sleep directly and skip envd, but adds a second client
   to maintain in Opengeni and a second public API to keep stable, and
   serves no other client.
3. **The self-hosted machine backend**, an Opengeni machine agent in
   every sandbox. Machines are long-lived and enrolled one by one; a
   sandbox is neither, and the agent costs memory in every guest.
4. **OpenSandbox's API.** Another protocol to build, for nothing E2B's
   does not already give.

## Decision

- **Option 1.** Opengeni uses `OPENGENI_SANDBOX_BACKEND=e2b` against the
  fabric. The fabric's own API stays the fleet's internal interface.
- **The connection is explicit configuration.** Opengeni installs the E2B
  SDK at the version the front door's conformance suite pins (2.56.0) and
  passes the API key, the domain and, optionally, the API address and a
  single sandbox address to the SDK for every create and resume, through
  `OPENGENI_E2B_API_KEY`, `OPENGENI_E2B_DOMAIN`, `OPENGENI_E2B_API_URL`
  and `OPENGENI_E2B_SANDBOX_URL`. Nothing depends on ambient `E2B_*`
  variables, and none of it is stored in a session's saved state. The
  same settings point Opengeni at E2B's own cloud.
- **Names and TLS.** Every name under the domain reaches the front door
  over TLS with a certificate for `*.<domain>`; preview hosts need that
  even when `OPENGENI_E2B_SANDBOX_URL` sends envd traffic to one address,
  routed by the `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers.
- **Workspace capture stays tar.** Opengeni's portable workspace tar
  (the default) remains its way to carry a workspace to a new sandbox.
  The front door does not serve E2B snapshots by id (ADR 19), so
  `OPENGENI_E2B_WORKSPACE_PERSISTENCE=snapshot` is not supported on it.
- **Recommended lifecycle**: `OPENGENI_E2B_TIMEOUT_ACTION=pause` and
  `OPENGENI_E2B_AUTO_RESUME=true`. Idle sandboxes sleep on the fabric
  regardless, so E2B's timeout is not the cost lever it is on E2B's cloud;
  a paused sandbox is saved and comes back on Opengeni's next `connect`.
- **The proof** is a real Opengeni development stack session on the
  fabric: create, commands, files, a preview port, pause and resume, with
  the method and results in `docs/measurements.md`. The Opengeni change
  lives on the branch `feat/opengeni-e2b-endpoint`.

## Consequences

- One front door serves Opengeni, E2B's SDKs and the comparison with
  E2B, with the same client code.
- Opengeni sees E2B's lifecycle words, not our sleep levels; the two meet
  only in pause and timeout (ADR 19). A session's first command after a
  long idle waits for the wake, as it does on any sleeping sandbox.
- envd runs in every guest, a few MiB each.
- The SDK adapter Opengeni uses does not pass connection options, so
  Opengeni carries a small patch to it until the adapter accepts them.
- The proof found two more defects in that adapter, which any E2B
  backend would hit, and the same patch fixes them. E2B's terminal
  always starts an interactive login bash, and the adapter typed each
  command into it, so a terminal command never finished and a turn
  waiting for one hung until the sandbox timed out; the command now runs
  from a one-shot script and the shell exits with its status. And in an
  image whose workspace root belongs to root, E2B's default user could
  not write the workspace; creating a sandbox now hands that one
  directory to the default user, as root, when it has to. Because the
  first change alters the command output the model sees, it waits for
  review as a draft pull request.
- Opengeni has no tool that gives the model a preview link on any
  backend. A preview port is reachable at `https://<port>-<id>.<domain>`,
  and the adapter's exposed-port lookup returns that address; showing it
  to the model is Opengeni's choice, not the fabric's.
- Features E2B's backend lacks in Opengeni, and the front door's gaps
  (snapshots by id, volumes), stay gaps until either side adds them.
