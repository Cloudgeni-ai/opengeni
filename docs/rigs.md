# Rigs

A workspace owns named **rigs**: versioned sandbox machine definitions (a base image, a setup script, self-declared health checks, credential-hook refs, and default variable-set refs). A session **binds** to a rig at creation and **freezes** the rig's currently-active version onto the session row — the rig can gain new versions later without ever moving that session's box out from under it. Agents cannot edit a rig directly; they **propose changes**, which a clean-replay verification run ("rig CI") admits or rejects.

## Invariants

1. **Versions are append-only and content-immutable.** `rig_versions` rows are never updated in place; only the `active` flag flips. Exactly one version per rig can be active at a time (a partial unique index on `(rig_id) WHERE active`).
2. **A session's rig binding is frozen at creation.** `sessions.rig_id`/`sessions.rig_version_id` are set once, from the explicit `rigId` on create or the workspace's default rig, and never move — even if the rig is promoted to a new active version mid-session. A shared box (`sandbox: 'shared'` or an explicit group) must carry the same frozen `rig_version_id` as the rest of its group; a mismatch 422s at create.
3. **Verification never activates.** `rigs:use` can propose only an additive `setup_append` (the exact command already proven in the caller's sandbox) and request verification. A green run leaves either change kind `proposed` with `verification.passed=true`: verified, awaiting a `rigs:manage` promotion. `definition_edit` proposal and every durable version mint/activation are manager operations.
4. **Verification runs the exact artifact in a throwaway, secret-free sandbox.** For `setup_append`, the base setup plus append are composed exactly as promotion will store them and executed once in one Bash process from `/workspace`; shell state such as `cd`, exports, functions, `set`, traps, `exit`, and `pipefail` therefore has the same semantics in verification and cold materialization. Setup and each declared check have hard in-sandbox timeouts and structured status/exit/duration results. No default variable-set values or credential hooks are loaded. The normal activity path completes a bounded provider/session cleanup sequence before it records the outcome; cleanup failure is recorded as an infrastructure failure, never as verified.
5. **Workspace isolation.** `rigs`, `rig_versions`, and `rig_changes` are all FORCE-RLS workspace-scoped tables, same as every other workspace table.
6. **Rig setup never touches selfhosted.** The rig-setup hook is part of the same owned-hooks block as the repository-clone and credential hooks, which is skipped entirely when the turn's effective sandbox backend is `selfhosted` (a [Connected Machine](connected-machines.md) is the user's own computer; the platform never runs setup against it). A machine-targeted turn therefore always behaves as if rig-less for setup purposes, even when the session carries a rig binding.

## Configuration

- `OPENGENI_RIG_SETUP_TIMEOUT_MS` — the per-artifact budget for the rig's own setup script and each declared verification check, separate from the general 120s sandbox-lifecycle-hook default. Defaults to 600000 (10 minutes). In rig CI, every artifact is additionally bounded by one absolute 12-minute aggregate setup/check deadline that starts before sandbox establishment; the effective timeout is the smaller of this setting and the remaining aggregate budget.
- Rig CI never launches an artifact after that aggregate deadline. It records the setup or every not-yet-started check as explicitly skipped and fails the verification as infrastructure-invalid; a timeout caused by the aggregate budget is also infrastructure-invalid rather than an ordinary check rejection.
- Verification cleanup is part of the outcome fence: before any change settlement or version verification audit, the worker bounds `client.delete(sessionState)` to 30 seconds, then tries the available session `terminate`, `kill`, and `close` primitives in order until one succeeds. If no cleanup path succeeds, it records a redacted actionable error and the outcome is failed.
- No dedicated encryption key: a rig's `setupScript`/`image`/`checks` are not secret material — secrets are attached only via the rig's `defaultVariableSetIds`, which reference workspace variable-sets and are subject to their own encryption (see [`variable-sets.md`](variable-sets.md)).

## Rig setup at runtime

When a session's frozen rig version carries a non-empty `setupScript`, the worker threads a `rigSetup` descriptor (rig id, version id, script, `rigSetupTimeoutMs`) into the agent build. The resulting `rig-setup` sandbox lifecycle hook runs **first** among the `beforeAgentStart` hooks — before credential hooks and the repository-clone hook — so any tooling it installs is available to what follows. The hook is idempotent and **marker-guarded**: it writes and runs the script under coreutils `timeout` once per box, then touches `/var/opengeni/rig-setup-<versionId>.done` only on a zero exit, so a warm box re-entering the hook on a later turn skips a script that already succeeded, and a failed/timed-out run retries next turn. Concurrent turn holders on the same shared box coordinate through a lock directory so only one of them actually runs the script. Three runtime events narrate the outcome: `rig.setup.started`, then exactly one of `rig.setup.completed`, `rig.setup.skipped` (marker already present), or `rig.setup.failed` (nonzero exit or timeout — **fails the turn closed**).

### Image precedence

A rig version's `image`, when set, is the top of the image precedence chain: **rig > pack > deployment default**. It overrides both the deployment's `OPENGENI_DOCKER_IMAGE`/`OPENGENI_MODAL_IMAGE_REF` and any enabled capability pack's `sandboxImage` (see [`packs.md`](packs.md)). A rig version with no image (or a rig-less session) falls through unchanged to pack/deployment resolution.

### Credential hooks

`credentialHooks` on a rig version are string ids resolved against the same built-in sandbox-lifecycle-hook registry as the deployment's `OPENGENI_SANDBOX_PREPARATION_PROFILES` hooks (currently `azure-cli-login`); an unknown id throws at per-turn build time, not silently. They are **unioned** with the deployment's profile-driven hooks, deduped by id, with the deployment hooks keeping their leading position — a rig can add credential setup a deployment profile doesn't already provide, but never removes one the deployment declares.

### Default variable sets

A rig version's `defaultVariableSetIds` are decrypted and merged in listed order, then layered **below** the session's own attached variable set in the env-injection chain. Binding a session (explicitly or through the workspace default) or scheduled task to a rig that can inject defaults requires `variable-sets:use`; authorization provenance is persisted and the worker refuses decryption for legacy/unvalidated bindings:

```
deployment allowlist < git identity < rig default variable sets < workspace variable set < run-scoped GitHub auth
```

A later entry wins on a name collision, so a session's own variable-set attachment always overrides a rig default with the same variable name. See [`variable-sets.md`](variable-sets.md) for the rest of that layering (redaction, reserved names, the managed-sandbox-only scope).

### Agent-visible doctrine

A rig-bound turn's system instructions carry a non-bypassable doctrine block (composed into the CORE, so a white-labelled persona template can never drop it) naming the rig and active version and telling the agent: its sandbox is an ephemeral fork that dies with the box, a durable change needs `rig_propose_change` with the exact command that already worked, and `rig_get` shows the rig's current setup/checks before reinstalling anything.

### Default rig resolution

A session's rig binding resolves at create as: the explicit `rigId` on the create payload if given, else the workspace's `default_rig_id` (`workspaces.default_rig_id`), else rig-less. An explicit unknown/inactive `rigId` is a caller error (422). A stale workspace-default (deleted rig, or one somehow left with no active version) degrades silently to rig-less rather than failing the create. A Rigs manager can set or clear the workspace default from the rig UI or `PUT /v1/workspaces/:workspaceId/default-rig`.

## Permissions

| Permission | Grants |
|---|---|
| `rigs:use` | List/read rigs, versions, and changes; propose an exact already-worked `setup_append`; trigger clean (re-)verification. Never mints or activates a version. |
| `rigs:manage` | Create/edit/delete a rig, propose `definition_edit`, mint a version directly, activate (roll back to) any existing version, and promote either verified change kind exactly once. |

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
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/changes` | `rigs:use` for `setup_append`; `rigs:manage` for `definition_edit` | Propose against the current active version and start verification. Optional `idempotencyKey` collapses retries; a lost Temporal start is repaired against the DB-committed attempt. |
| `GET /v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId` | `rigs:use` | One change, including its verification record once it has run. |
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId/verify` | `rigs:use` | Re-run verification for a change. |
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/changes/:changeId/promote` | `rigs:manage` | Promote either verified change kind. Base-version/OCC fenced and idempotent: retries return the one version already minted. |
| `POST /v1/workspaces/:workspaceId/rigs/:rigId/verify` | `rigs:use` | Re-verify the rig's current active version's checks (not tied to any pending change). |
| `PUT /v1/workspaces/:workspaceId/default-rig` | `rigs:manage` | Set a workspace-local default with `{ "rigId": "..." }`, or clear it with `{ "rigId": null }`. |

## Verification and change promotion (rig CI)

Every proposed change is verified the same way, in a throwaway sandbox with no attached secrets:

1. Establish a fresh sandbox session (`rig-verification-<changeId>-attempt-<attempt>` or `rig-version-verification-<versionId>-<randomId>`), applying the candidate version's image via the same `rig > pack > deployment` precedence as a live turn.
2. Build the exact candidate artifact. For `setup_append`, compose `base.setupScript + "\n" + command` once; never execute base and append in separate shells.
3. Run that candidate setup as one Bash script under the per-artifact timeout and the one absolute aggregate deadline, recording structured status/exit/duration/output. A nonzero exit rejects it; an ambiguous exit, provider failure, or deadline exhaustion fails infrastructure-closed.
4. Run every uniquely named declared check under the remaining aggregate deadline and the per-artifact timeout, recording status/exit/duration/bounded redacted output. If setup fails, every declared check is recorded as explicitly skipped with the setup-failure reason. If the aggregate expires, no unstarted check is launched and each is recorded as explicitly skipped with the deadline reason. Zero checks records `checksConfigured=false` and reads **No checks configured**, never healthy.
5. Re-check the active base and attempt fence before settlement. Duplicate names, stale base, cancellation, exceptions, or launch ambiguity fail closed; a late zombie attempt cannot overwrite recovery.
6. Complete the bounded cleanup sequence before classifying the normal activity result. Successful cleanup permits a verified/rejected/failed settlement; if every cleanup primitive fails, the persisted outcome is an infrastructure `failed` record with a bounded redacted error, never a verified result. Temporal cancellation/failure uses an attempt-fenced non-cancellable failure settlement so the change cannot remain falsely promotable or be overwritten by a late zombie.

Change attempts use deterministic Temporal workflow ids. Repeating a start observes the active/successful run, while failed-only workflow-id reuse can restart the same DB-committed `verifying` attempt if Temporal failed before its non-cancellable cleanup reached Postgres. A new explicit verification increments the attempt and therefore receives a new workflow id.

| Kind | Checks passed? | Infra error? | Outcome |
|---|---|---|---|
| `setup_append` | yes | no | `proposed` with `verification.passed = true` — verified, awaiting manager promotion; active version unchanged. |
| `definition_edit` | yes | no | `proposed` with `verification.passed = true` — verified, awaiting manager promotion; active version unchanged. |
| either | no | no | `rejected`. |
| either | — | yes | `failed` (retryable — establishing the sandbox, running a command, or persisting state threw). |

A promote (`POST .../changes/:changeId/promote`) re-validates `proposed` plus `verification.passed === true`, locks the rig and change, verifies the current active version still equals the verified base, then mints and activates in one transaction. Concurrent/repeated promotion returns the same result version without minting or reactivating it; stale-base promotion is a 409. Failures and cancellations never alter the prior active version.

Rig audit events (`rig.change.proposed`/`.verified`/`.merged`/`.rejected`/`.failed`, `rig.verification.started`/`.passed`/`.failed`/`.no_checks`, `rig.version.activated`/`.promoted`) are recorded through the standard workspace audit log for every step above.

## Composition with variable sets

A rig's `defaultVariableSetIds` reference workspace variable-sets by id (validated to exist in the workspace at rig create/edit/change-propose time — an unknown or cross-workspace id 422s, same as a session's own `variableSetId` attachment). They are pure references: a rig never stores variable values itself, and deleting a variable-set that a rig still references is unaffected by the rig (variable-set deletion semantics are governed entirely by [`variable-sets.md`](variable-sets.md#deletion-semantics), not by rig references). At runtime the rig's default sets are decrypted and merged in listed order, then the session's own attached set is layered on top and wins any name collision — see [Default variable sets](#default-variable-sets) above.

A scheduled task persists the authorization provenance for its rig binding and copies it to each new session. A task with a live reusable session cannot swap or detach its rig: the reusable session keeps its frozen rig version and secret boundary, so changing that attachment requires recreating the task. Editing that task's instructions or tools continues to require `variable-sets:use` whenever its rig defaults were authorized.

## MCP surface

The first-party MCP server exposes rig tools, gated by the same permissions as the REST routes and **registered only for grants that hold them**:

- `rig_list` (`rigs:use`) — workspace rigs and their active versions.
- `rig_get` (`rigs:use`) — one rig with one bounded active definition plus
  compact-by-query historical version/change summaries. The complete
  pretty-printed MCP result is capped at 64 KiB. Historical setup scripts,
  check bodies, change payloads, and verification logs are not copied into
  model context; totals, counts, byte facts, previews, and truncation facts make
  the omission explicit. `versionLimit` and `changeLimit` independently bound
  the two histories (default 20, maximum 100). The access-controlled REST
   version/change detail routes above remain the exact retained-detail surface.
- `rig_propose_change` (`rigs:use`) — propose an additive `setup_append` change (the exact command that already worked in this sandbox), optionally with an idempotency key, and ensure verification starts. A green result explicitly awaits manager promotion.
- `rig_verify` (`rigs:use`) — trigger verification: pass `changeId` to (re-)verify a proposed change, or omit it to re-verify an active version that has declared checks.

There is deliberately **no agent-visible manager promotion tool**, even when a delegated token carries `rigs:manage`. Promotion stays on the manager REST/UI surface.

## Deletion and rollback semantics

- **Delete.** `DELETE .../rigs/:rigId` 409s while any session still references the rig (`sessions.rig_id`); there is no cascade-detach — retire or wait out the referencing sessions first, then delete.
- **Rollback.** There is no "revert" operation distinct from activation: `POST .../versions/:versionId/activate` flips the active flag to any existing version (older or newer) without minting new content or touching version rows. A rollback is exactly that call against an older version id.
- **A session's binding never moves.** Activating a different version — whether via rollback or a fresh promote — changes what *new* sessions and re-verification see as "the active version"; it never migrates an already-bound session's frozen `rig_version_id`. A session that wants the newer (or rolled-back) version must be recreated.
