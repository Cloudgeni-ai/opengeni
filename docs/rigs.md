# Rigs

A workspace owns named **rigs**: versioned sandbox machine definitions (a base image, a setup script, self-declared health checks, credential-hook refs, and default variable-set refs). A session **binds** to a rig at creation and **freezes** the rig's currently-active version onto the session row — the rig can gain new versions later without ever moving that session's box out from under it. Agents cannot edit a rig directly; they **propose changes**, which a clean-replay verification run ("rig CI") admits or rejects.

## Invariants

1. **Versions are append-only and content-immutable.** `rig_versions` rows are never updated in place; only the `active` flag flips. Exactly one version per rig can be active at a time (a partial unique index on `(rig_id) WHERE active`).
2. **A session's rig binding is frozen at creation.** `sessions.rig_id`/`sessions.rig_version_id` are set once, from the explicit `rigId` on create or the workspace's default rig, and never move — even if the rig is promoted to a new active version mid-session. A shared box (`sandbox: 'shared'` or an explicit group) must carry the same frozen `rig_version_id` as the rest of its group; a mismatch 422s at create.
3. **Two change kinds, two trust levels.** `setup_append` is additive (one already-verified-in-a-live-box shell command) and **auto-merges into a new active version on a green clean-replay run** — no `rigs:manage` needed. `definition_edit` is a full next-version edit (image/script/checks/credential hooks/default variable sets) that still runs the same clean-replay verification but always lands `proposed`; promoting it to a new active version requires `rigs:manage`.
4. **Bounded verifier ownership requires a two-phase shared-queue rollout.** A rig verifier is a standalone throwaway sandbox, not a turn/viewer lease. Phase A installs the tenant-consistent `rig_verification` owner registry and teaches the reaper to recognize active exact owner rows while leaving verifier creation on the legacy path. This Phase B revision adds exact owner registration behind a strict default-off gate and rejects before provider creation while the gate is false. Rig-verification dispatches remain paused until Phase B is deployed everywhere and live worker-revision evidence proves no lease-only predecessor can receive the shared reaper activity.
5. **Workspace isolation.** `rigs`, `rig_versions`, and `rig_changes` are all FORCE-RLS workspace-scoped tables, same as every other workspace table.
6. **Rig setup never touches selfhosted.** The rig-setup hook is part of the same owned-hooks block as the repository-clone and credential hooks, which is skipped entirely when the turn's effective sandbox backend is `selfhosted` (a [Connected Machine](connected-machines.md) is the user's own computer; the platform never runs setup against it). A machine-targeted turn therefore always behaves as if rig-less for setup purposes, even when the session carries a rig binding.

## Configuration

- `OPENGENI_RIG_SETUP_TIMEOUT_MS` — the budget for the rig's own setup script, separate from the general 120s sandbox-lifecycle-hook default. Defaults to 600000 (10 minutes). Applies to both a live turn's setup hook and a rig-CI verification run.
- `OPENGENI_RIG_VERIFICATION_EPHEMERAL_OWNERS_ENABLED` — strict boolean Phase-B activation gate, default `false`. Phase A parses this setting but does not consume it. Phase B consumes it and fails closed before provider creation while false; there is no legacy unowned fallback. Keep it false through both code rollouts and enable it only after every shared-queue worker is proven to run the Phase-B revision and the owner-aware reaper.
- No dedicated encryption key: a rig's `setupScript`/`image`/`checks` are not secret material — secrets are attached only via the rig's `defaultVariableSetIds`, which reference workspace variable-sets and are subject to their own encryption (see [`variable-sets.md`](variable-sets.md)).

## Rig setup at runtime

When a session's frozen rig version carries a non-empty `setupScript`, the worker threads a `rigSetup` descriptor (rig id, version id, script, `rigSetupTimeoutMs`) into the agent build. The resulting `rig-setup` sandbox lifecycle hook runs **first** among the `beforeAgentStart` hooks — before credential hooks and the repository-clone hook — so any tooling it installs is available to what follows. The hook is idempotent and **marker-guarded**: it writes and runs the script under coreutils `timeout` once per box, then touches `/var/opengeni/rig-setup-<versionId>.done` only on a zero exit, so a warm box re-entering the hook on a later turn skips a script that already succeeded, and a failed/timed-out run retries next turn. Concurrent turn holders on the same shared box coordinate through a lock directory so only one of them actually runs the script. Three runtime events narrate the outcome: `rig.setup.started`, then exactly one of `rig.setup.completed`, `rig.setup.skipped` (marker already present), or `rig.setup.failed` (nonzero exit or timeout — **fails the turn closed**).

### Image precedence

A rig version's `image`, when set, is the top of the image precedence chain: **rig > pack > deployment default**. It overrides both the deployment's `OPENGENI_DOCKER_IMAGE`/`OPENGENI_MODAL_IMAGE_REF` and any enabled capability pack's `sandboxImage` (see [`packs.md`](packs.md)). A rig version with no image (or a rig-less session) falls through unchanged to pack/deployment resolution.

### Credential hooks

`credentialHooks` on a rig version are string ids resolved against the same built-in sandbox-lifecycle-hook registry as the deployment's `OPENGENI_SANDBOX_PREPARATION_PROFILES` hooks (currently `azure-cli-login`); an unknown id throws at per-turn build time, not silently. They are **unioned** with the deployment's profile-driven hooks, deduped by id, with the deployment hooks keeping their leading position — a rig can add credential setup a deployment profile doesn't already provide, but never removes one the deployment declares.

### Default variable sets

A rig version's `defaultVariableSetIds` are decrypted and merged in listed order, then layered **below** the session's own attached variable set in the env-injection chain:

```
deployment allowlist < git identity < rig default variable sets < workspace variable set < run-scoped GitHub auth
```

A later entry wins on a name collision, so a session's own variable-set attachment always overrides a rig default with the same variable name. See [`variable-sets.md`](variable-sets.md) for the rest of that layering (redaction, reserved names, the managed-sandbox-only scope).

### Agent-visible doctrine

A rig-bound turn's system instructions carry a non-bypassable doctrine block (composed into the CORE, so a white-labelled persona template can never drop it) naming the rig and active version and telling the agent: its sandbox is an ephemeral fork that dies with the box, a durable change needs `rig_propose_change` with the exact command that already worked, and `rig_get` shows the rig's current setup/checks before reinstalling anything.

### Default rig resolution

A session's rig binding resolves at create as: the explicit `rigId` on the create payload if given, else the workspace's `default_rig_id` (`workspaces.default_rig_id`), else rig-less. An explicit unknown/inactive `rigId` is a caller error (422). A stale workspace-default (deleted rig, or one somehow left with no active version) degrades silently to rig-less rather than failing the create. There is currently no API or web-console surface to set `default_rig_id` — it is a schema column consumed by session creation with no write path yet.

## Permissions

| Permission | Grants |
|---|---|
| `rigs:use` | List/read rigs, versions, and changes; propose a `setup_append` or `definition_edit` change; trigger (re-)verification. The additive, agent-trusted path. |
| `rigs:manage` | Create/edit/delete a rig, mint a version directly, activate (roll back to) any existing version, and promote a verified `definition_edit` change to a new active version. |

## API

| Method and path | Permission | Notes |
|---|---|---|
| `GET /v1/workspaces/:workspaceId/rigs` | `rigs:use` | List rigs (each with its active version). |
| `POST /v1/workspaces/:workspaceId/rigs` | `rigs:manage` | Create a rig with inline version-1 content. 409 on duplicate name. Caps: 50 rigs/workspace, 100 checks/rig, 50 credential hooks/rig, 25 default variable sets/rig. |
| `GET /v1/workspaces/:workspaceId/rigs/:rigId` | `rigs:use` | One rig. |
| `PATCH /v1/workspaces/:workspaceId/rigs/:rigId` | `rigs:manage` | Rename / description only — version content is never edited in place. |
| `DELETE /v1/workspaces/:workspaceId/rigs/:rigId` | `rigs:manage` | 409 while any session references the rig. |
| `GET /v1/workspaces/:workspaceId/rigs/:rigId/versions` | `rigs:use` | All versions, newest included. |
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/versions` | `rigs:manage` | Mint and activate a new version directly (bypasses change/verification — a manager-authored edit). |
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/versions/:versionId/activate` | `rigs:manage` | Rollback / promote-activate: flips which existing version is active. Mints no new version and never touches content. |
| `GET /v1/workspaces/:workspaceId/rigs/:rigId/changes` | `rigs:use` | Recent changes, newest first. |
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/changes` | `rigs:use` | Propose a change against the rig's current active version. Starts verification immediately. |
| `GET /v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId` | `rigs:use` | One change, including its verification record once it has run. |
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId/verify` | `rigs:use` | Re-run verification for a change. |
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId/promote` | `rigs:manage` | Promote a verified `definition_edit` change to a new active version. 422 if not yet passed verification. |
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/verify` | `rigs:use` | Re-verify the rig's current active version's checks (not tied to any pending change). |

## Verification and change promotion (rig CI)

> **Phase B activation freeze:** this revision rejects before provider creation while `OPENGENI_RIG_VERIFICATION_EPHEMERAL_OWNERS_ENABLED=false`. Do not enable the flag or resume rig verification until completing the shared-queue convergence proof in [Bounded verifier ownership rollout](#bounded-verifier-ownership-rollout). Existing business-outcome behavior below is unchanged once safely activated.

Every proposed change is verified the same way, in a throwaway sandbox with no attached secrets:

1. Require the Phase-B activation gate; while false, reject before any provider create.
2. Establish a fresh sandbox session (`rig-verification-<changeId>` or `rig-version-verification-<versionId>`), applying the candidate version's image via the same `rig > pack > deployment` precedence as a live turn.
3. On every exact provider create/replacement callback, record the identity locally before awaiting durable owner registration. Provider ownership tags are written only after registration and remain diagnostic.
4. If the candidate version has a non-empty `setupScript`, run the rig-setup hook against it.
5. For a `setup_append` change, run the proposed command; a nonzero exit rejects the change immediately without running the declared checks.
6. Run every declared check (`RigCheck.command`), recording `exitCode`/`output` per check.
7. Classify the outcome, then independently settle idempotent exact deactivation for every candidate identity and provider termination with `Promise.allSettled`. This also handles a registration commit whose response was lost; expiry remains the process-death/database-failure backstop.

| Kind | Checks passed? | Infra error? | Outcome |
|---|---|---|---|
| `setup_append` | yes | no | `merged` — a new version is minted from the base version with the command appended to `setupScript`, and activated automatically. No `rigs:manage` involved. |
| `definition_edit` | yes | no | `proposed` (verification recorded, `verification.passed = true`) — awaits an explicit `rigs:manage` promote. |
| either | no | no | `rejected`. |
| either | — | yes | `failed` (retryable — establishing the sandbox, running a command, or persisting state threw). |

A `definition_edit` promote (`POST .../changes/:changeId/promote`) re-validates that the change is `proposed` with `verification.passed === true` before minting the new version from the change's base version plus its payload overrides (fields the payload omits inherit from the base). Both promotion paths (`setup_append` auto-merge and `definition_edit` explicit promote) mint the new version with `activate: true` in the same call, so a rig never has a moment with zero active versions.

Rig audit events (`rig.change.proposed`, `rig.verification.started`/`.passed`/`.failed`, `rig.change.merged`/`.rejected`/`.failed`, `rig.version.activated`/`.promoted`) are recorded through the standard workspace audit log for every step above.

## Bounded verifier ownership rollout

The worker replicas share one Temporal control task queue. Any compatible worker can execute a reaper activity, so a normal rolling deployment does **not** prove that the worker which registered a verifier will also perform the next sweep. A Phase-B verifier owner is safe only when every worker eligible for that queue understands the owner registry.

### Upgrade and activation

1. Start from the Phase-A predecessor with rig-verification dispatch paused. Do not enqueue new change or version verification, and let already-running legacy verifiers finish or be cleaned up.
2. Apply migration `0068_rig_verification_ephemeral_ownership.sql` and deploy Phase A. Keep `OPENGENI_RIG_VERIFICATION_EPHEMERAL_OWNERS_ENABLED=false` (its value is parsed but inert in Phase A).
3. Prove every API/worker replica and every worker polling the shared control queue runs Phase A or newer. A partial Phase-A/predecessor rollout is safe only because no revision is creating verifier owner rows; dispatch stays paused.
4. Deploy Phase B with the flag still false. Its verifier path must reject before provider creation while false; no fallback to an unowned sandbox is allowed.
5. Again prove every worker polling the shared queue runs Phase B and its owner-aware reaper. Exercise queue routing so reaper activities land on multiple replicas; verify each one consumes the unified lease-plus-owner projection.
6. Enable `OPENGENI_RIG_VERIFICATION_EPHEMERAL_OWNERS_ENABLED=true` in a separate configuration rollout. Only now may rig-verification dispatch resume.
7. Run a live verifier longer than two minutes and observe at least the +120s, +150s, and +180s reaper sweeps. The exact active owner row must protect only its registered provider instance. Confirm that each destructive candidate is revalidated against the current exact-instance projection after provider enumeration; an unavailable or inconsistent revalidation must fail closed and preserve the box. On every verifier exit, exact deactivation and provider termination run independently. Expiry is the process-death backstop, not ordinary cleanup.

Provider tags remain best-effort diagnostics throughout. Missing or copied tags never establish ownership. The initial unified database projection is only a sweep classifier, not destruction authority: registration can commit after that snapshot, so the reaper performs a second exact current-instance lookup immediately before terminating each candidate. Lookup failure or an inconsistent result preserves the candidate for a later pass. The common two-minute create/registration grace covers fresh stale-tagged boxes as well as unattributed boxes, while older wrong-instance, expired, stale, and unattributed boxes remain eligible for cleanup.
The runtime app role has tenant-scoped `SELECT` on the owner registry but no direct table mutation privilege. Register/rebind and exact deactivation run only through pinned `SECURITY DEFINER` functions that verify the transaction's account/workspace scope; role provisioning reapplies this protected-table exception after every ordinary schema-wide DML grant.

### Partial rollout, rollback, and downgrade

- **Phase-B worker rollback to Phase A:** first disable the flag and pause dispatch. Phase-A reapers still recognize active Phase-B owner rows, so already-created exact instances remain protected while they finish, deactivate, or expire. Phase-A workers must not receive new verifier work during the rollback because their verifier path is legacy/unowned.
- **Rollback to the Phase-A predecessor:** forbidden while any active verifier owner row exists. Disable Phase-B creation, pause dispatch, prove all active rows have deactivated or expired and their providers are gone, and only then roll workers back. Keep the expand-only migration/table in place; do not reverse schema during worker rollback.
- **Mixed Phase-B/Phase-A workers:** safe only with activation false and dispatch paused. If activation is true, a Phase-A worker can receive verifier work and create an unowned sandbox even though its reaper recognizes other owners.
- **Mixed Phase-A/predecessor reapers:** never safe for Phase-B owner creation. A predecessor reaper sees only leases and will terminate a valid verifier after the unattributed grace, regardless of which worker created it.

## Composition with variable sets

A rig's `defaultVariableSetIds` reference workspace variable-sets by id (validated to exist in the workspace at rig create/edit/change-propose time — an unknown or cross-workspace id 422s, same as a session's own `variableSetId` attachment). They are pure references: a rig never stores variable values itself, and deleting a variable-set that a rig still references is unaffected by the rig (variable-set deletion semantics are governed entirely by [`variable-sets.md`](variable-sets.md#deletion-semantics), not by rig references). At runtime the rig's default sets are decrypted and merged in listed order, then the session's own attached set is layered on top and wins any name collision — see [Default variable sets](#default-variable-sets) above.

## MCP surface

The first-party MCP server exposes rig tools, gated by the same permissions as the REST routes and **registered only for grants that hold them**:

- `rig_list` (`rigs:use`) — workspace rigs and their active versions.
- `rig_get` (`rigs:use`) — one rig, its versions, and recent changes.
- `rig_propose_change` (`rigs:use`) — propose an additive `setup_append` change (the exact command that already worked in this sandbox) and start verification. On a session-scoped call this attributes the change to `session:<sessionId>` rather than the caller's user subject.
- `rig_verify` (`rigs:use`) — trigger verification: pass `changeId` to (re-)verify a proposed change, or omit it to re-verify the active version's checks.
- `rig_promote` (`rigs:manage`) — promote a verified `definition_edit` change to a new active version. **Not registered for a default sandboxed-agent session**: the worker's default first-party delegated token carries `rigs:use` but not `rigs:manage`, so an agent can propose and get changes verified but can never itself promote a `definition_edit` — the same "agents cannot self-escalate" pattern as variable-set management (see [`variable-sets.md`](variable-sets.md#mcp-surface)). A `setup_append` change needs no promote tool at all: a green clean-replay run merges it automatically.

## Deletion and rollback semantics

- **Delete.** `DELETE .../rigs/:rigId` 409s while any session still references the rig (`sessions.rig_id`); there is no cascade-detach — retire or wait out the referencing sessions first, then delete.
- **Rollback.** There is no "revert" operation distinct from activation: `POST .../versions/:versionId/activate` flips the active flag to any existing version (older or newer) without minting new content or touching version rows. A rollback is exactly that call against an older version id.
- **A session's binding never moves.** Activating a different version — whether via rollback or a fresh promote — changes what *new* sessions and re-verification see as "the active version"; it never migrates an already-bound session's frozen `rig_version_id`. A session that wants the newer (or rolled-back) version must be recreated.
