# Scoped Variable Sets

Variable sets are named encrypted secret collections with one explicit owner scope:

- **Organization:** discoverable from every workspace in the organization; mutation requires `account:admin`.
- **Workspace:** discoverable only in the origin workspace. This is the default and preserves legacy `/environments` behavior.
- **Only me:** owned by the authenticated active organization member, private by default, and discoverable from any workspace that member currently accesses.

A variable set is attached to runnable things — a session, a scheduled task, or a capability pack installation that declares it uses one — and its values are injected only after exact runtime authority is revalidated. A session may select up to 25 explicit Variable Sets in ordered low-to-high precedence. The legacy singular `variableSetId` remains an alias for the final, highest-precedence explicit set.

The web creation form makes this scope a required, explicit choice and every
list row carries the same Organization, Workspace, or Only me label. Scope is a
property of the resource, not a duplicate navigation hierarchy. Only an active
managed organization member can create an Only-me set, and organization scope
requires account-administrator authority.

## Invariants

1. **Plaintext has one explicit read boundary.** Generic workspace, session, event, capability, installation, list, and variable-set metadata responses remain value-free. One dedicated REST route and one live-session MCP tool return exactly one configured value, and only when the caller holds both the resource permission and literal `secrets:read`.
2. **No attachment, no injection.** A run whose session has an empty `variableSetIds` selection and no Rig defaults gets exactly the pre-existing behavior: the deployment env allowlist, git identity, and run-scoped GitHub auth. Nothing more. (This injection describes a **managed sandbox**; a Connected Machine session is not injected this way — see [Env injection is a managed-sandbox concept](#env-injection-is-a-managed-sandbox-concept).)
3. **Attachment and use are separate.** Creating or changing a runnable attachment requires both `variable-sets:attach` and `variable-sets:use`; neither permission implies the other. `variable-sets:attach` alone permits detaching, while `variable-sets:use` alone permits neither attaching nor detaching. Neither implies metadata, write, or plaintext-read authority.
4. **Capability-only storage boundary.** The runtime role has no direct DML on variable-set or ciphertext tables. Security-definer routines enforce organization/workspace/user visibility and mutation rules under forced RLS.
5. **Encryption at rest.** Values are AES-256-GCM encrypted with an operator key (`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`) held outside Postgres. A database dump alone does not reveal values.
6. **No content rewriting.** If an authorized agent echoes a configured value into model history, events, tool results, errors, memory, or UI-visible OpenGeni data, that content remains exact. Public or third-party telemetry uses a sink-local, closed schema and never writes back over canonical OpenGeni data.

## Rollout

The emergency release removed heuristic rewriting from internal content. This
follow-up adds the dedicated permissioned plaintext-read contract across the
REST API, SDK, React client, first-party MCP, and UI. Historical content already
rewritten by an older release cannot be reconstructed.

## Deliberate v1 storage decision

`docs/packs.md` states that connector secrets should live behind `credentialRef` in an external broker, not in Postgres. Scoped Variable Sets deliberately differ: they DO store secret values in Postgres, encrypted with an operator key that lives only in the deployment's secret set. The current lossless `v2:` envelope preserves every UTF-16 code unit and the reader retains historical `v1:` compatibility; a future keyed envelope or external reference can still use another prefix without a schema change. Use `credentialRef` connectors for OAuth-broker-shaped credentials; use Variable Sets for plain `NAME=value` material an agent process expects.

## Configuration

```sh
openssl rand -base64 32   # generate OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY
```

- The key must decode to exactly 32 bytes; boot validation fails otherwise.
- `OPENGENI_PRODUCT_ACCESS_MODE=managed` outside `local`/`test` requires the key at boot.
- In other modes the key is optional: until it is set, variable set write routes and attachment validation return `503 workspace variable sets require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`, and a run whose session somehow carries an attachment fails closed.
- Losing the key makes stored values unrecoverable (runs with attachments fail closed); rotate by re-entering values.

## Permissions

| Permission             | Grants                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| `variable-sets:list`   | List variable-set containers and metadata.                             |
| `variable-sets:read`   | Read one variable-set container and metadata.                          |
| `variable-sets:write`  | Create, rename, or delete variable-set containers.                     |
| `variable-sets:attach` | Authorize attachment changes; adding or retaining a selected set also requires `variable-sets:use`. |
| `variable-sets:use`    | Authorize runtime use of an attached variable set; never attach or reveal plaintext by itself. |
| `secrets:list`         | List configured secret names, versions, and timestamps.                |
| `secrets:read`         | Retrieve one exact plaintext configured secret through a dedicated operation. |
| `secrets:write`        | Create, rotate, or delete configured secret values.                    |

No variable-set permission implies another. The deprecated
`variable-sets:manage`, `environments:use`, and `environments:manage`
permissions remain accepted only where explicitly checked; they do not expand
into the granular permissions. `workspace:admin` likewise does not imply
`secrets:read`; plaintext authority must be present literally on the grant.
The rollout migration adds the six granular permissions, including
`secrets:read`, only to existing human workspace-admin memberships. It does not
rewrite API keys or frozen session grants. A principal that creates an API key
or delegates a session may grant `secrets:read` only when the principal itself
holds it literally.

Reads are deliberately not folded under `workspace:read`: listing the names of
secret sets is itself sensitive. Editing the `agentConfig` of a scheduled task
that has a variable set attached also requires `variable-sets:use`, because
changing the instructions of a secret-bearing task is equivalent to attaching
those secrets to new instructions. Setting or changing a non-null attachment
requires both attachment permissions; removing one requires
`variable-sets:attach`.

## API

| Method and path                                                                   | Permission(s)                                    | Notes                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/workspaces/:workspaceId/variable-sets`                                   | `variable-sets:list` + `secrets:list`            | Variable sets with variable metadata, never plaintext values.                                                                |
| `POST /v1/workspaces/:workspaceId/variable-sets`                                  | `variable-sets:write`; plus `secrets:write` when initial values are present; organization scope also requires `account:admin` | Create with `scope: organization | workspace | user` (omission defaults to workspace). 409 on duplicate active name within the owner scope. |
| `GET /v1/workspaces/:workspaceId/variable-sets/:variableSetId`                    | `variable-sets:read` + `secrets:list`            | Metadata only.                                                                                                               |
| `GET /v1/workspaces/:workspaceId/variable-sets/:variableSetId/variables/:name`    | `variable-sets:read` + literal `secrets:read`    | Return one exact plaintext value and metadata; read and metadata-only audit commit atomically.                               |
| `PATCH /v1/workspaces/:workspaceId/variable-sets/:variableSetId`                  | `variable-sets:write`                            | Rename / description.                                                                                                        |
| `DELETE /v1/workspaces/:workspaceId/variable-sets/:variableSetId`                 | `variable-sets:write` + `secrets:write`          | 409 while attached (see deletion semantics).                                                                                 |
| `PUT /v1/workspaces/:workspaceId/variable-sets/:variableSetId/variables/:name`    | `variable-sets:write` + `secrets:write`          | Set or rotate one value; bumps `version`.                                                                                    |
| `DELETE /v1/workspaces/:workspaceId/variable-sets/:variableSetId/variables/:name` | `variable-sets:write` + `secrets:write`          | Remove a variable.                                                                                                           |
| `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/variable-sets`               | `sessions:control` + `variable-sets:attach`; each selected set also requires `variable-sets:use` | Replace the complete ordered explicit selection between turns. Rejects shared/live sandbox use and takes effect only after a cold rotation fence. |

Creating or changing a non-null attachment requires both
`variable-sets:attach` and `variable-sets:use`. Detaching requires
`variable-sets:attach`; the permissions remain independent and neither implies
the other.

Attachment points:

- `POST /v1/workspaces/:id/sessions` accepts ordered `variableSetIds`. Later entries win collisions. The legacy `variableSetId`/`environmentId` alias, when supplied, is normalized as the final highest-precedence explicit set. Duplicate ids and selections wider than 25 are rejected.
- `PUT /v1/workspaces/:id/sessions/:sessionId/variable-sets` replaces the complete ordered explicit selection. It is a control-plane change, not a `user.message` field: the session must have no active turn, must own a singleton sandbox group, and must have no live lease holders. A successful change emits `session.variable_sets.updated`, records metadata-only attach/detach/reorder audit facts, and expires any warm lease so neither a cached manifest nor a baked process environment can serve the new selection. The next turn or sandbox operation starts from a cold runtime boundary.
- Create, Send, and Steer may also carry `personalResourceAttachment` with
  `once | session | always`. This does not change the session's fixed
  ordered Variable Set selection, Rig, or Rig version. It atomically issues authority for the
  server-derived personal subset of that current closure in the same transaction
  that accepts the logical turn. Established-session requests must carry the
  expected session authority epoch; create binds the new epoch server-side.
  Workspace-shared use requires warning receipt version 1 and an explicit
  acknowledgement. The event/turn/audit projections contain mode, context,
  kinds, count, and warning version only—never values or resource ids.
  Migration 0306 is a drained maintenance cutover: stop every API/control/turn
  worker and provide the exact old/new runtime login list through
  `OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES`; never restart a pre-0306
  image after it commits.
  The browser uses the ordinary scoped resource metadata to classify a fixed
  selection before presenting this delegation choice. Organization- and
  workspace-scoped Variable Sets and Rigs never render the **Your resource
  access** control or surface Personal-catalog failures; that UI is reserved
  for selections positively identified as user-scoped.
- `POST`/`PATCH /v1/workspaces/:id/scheduled-tasks` accept `variableSetId` (null detaches on update). Setting or changing a non-null attachment requires both permissions; detaching requires `variable-sets:attach`. Changing the attachment of a task with a live reusable session returns 409 because the task's accepted execution snapshot must remain stable; explicitly reconfigure the quiescent target session or recreate the task instead.
- Organization- and workspace-scoped Variable Sets on scheduled runs materialize under the exact fenced service turn (`scheduler`) and do not invent an initiating human. User-scoped Variable Sets remain different: they require the frozen causal human and exact personal-resource grant described next. This distinction applies identically to standalone database decryption and a host-provided `sandboxSecrets` credential boundary.
- When the selected Variable Set, Rig, or one of the Rig version's defaults is personal, scheduled-task acceptance freezes the causal human plus exact membership/resource/grant generations. Each occurrence revalidates and copies that immutable authority before dispatch; task edits, current Rig defaults, the current API user, and workspace defaults are never fallback authority. `once` grants belong to one admitted occurrence across recovery attempts. A rolling upgrade pauses legacy tasks that lack this ledger, and an explicit resume converts them before dispatch; old-writer authority-free runs are rejected in PostgreSQL. Only identifiers and generations are stored in this ledger; plaintext still crosses only the ordinary materialization/read boundaries described above.
- Direct session `once` follows the same logical-work rule: acceptance consumes
  it once for the turn, while same-turn worker recovery reuses the accepted
  receipt. New goal continuations and machine-input successor turns do not
  inherit a once snapshot; machine updates already coalesced into the accepted
  turn remain part of that exact turn. A nonowner in a shared session cannot
  attach or resolve the owner's personal fixed resources.
- `POST /v1/workspaces/:id/packs/:packId/enable` accepts `variableSetId` when a pack declares a `variable set` block and requires both attachment permissions; required variables are checked by **name**. Scheduled tasks created from that installation's templates inherit the attachment without re-checking either permission on the caller — both were authorized at enable time.

An organization- or user-scoped `variableSetId` may originate in another workspace in the same organization when its scoped authority makes it visible from the target workspace. Unknown, inaccessible, workspace-scoped foreign, and cross-organization ids return `422 unknown variableSetId`; RLS makes those cases indistinguishable by design.

### Variable names

Names must match `^[A-Z][A-Z0-9_]*$` (max 128 chars). Names the platform manages or that act as loader-injection vectors are rejected with 422:

- exact: `HOME`, `PATH`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `IFS`, `ENV`, `BASH_ENV`, `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `PERL5OPT`, `PERL5LIB`, `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `AZURE_DEVOPS_EXT_PAT`, `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT`
- prefixes: `OPENGENI_`, `GIT_CONFIG_`, `GIT_AUTHOR_`, `GIT_COMMITTER_`, `LD_`, `DYLD_`

## Composition with the deployment allowlist

`OPENGENI_SANDBOX_ENV_ALLOWLIST` and `OPENGENI_SANDBOX_PREPARATION_PROFILES` keep their meaning: the deployment operator forwards those process-env values into every sandbox. Scoped Variable Sets are layered on top per run:

```
deployment allowlist < git identity < ordered explicit session Variable Sets < run-scoped GitHub auth
```

Later wins. A session bound to a [rig](rigs.md) with `defaultVariableSetIds` gets those defaults first, in the Rig version's listed order, followed by every explicit session set in the session's listed order: `deployment allowlist < git identity < ordered Rig defaults < ordered explicit session sets < run-scoped GitHub auth`. Scope never changes precedence. A Rig default is pure convenience for tooling every session on that Rig should have; any later explicit session set wins the same-name collision. Reserved-name validation prevents collisions with the platform-managed git/GitHub entries, so the run-scoped GitHub token block always applies last untouched. Note that sandbox lifecycle hooks are profile-driven: workspace-provided `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` only trigger the `azure-cli-login` hook on deployments that enable the `azure` preparation profile; on profile-less deployments the values are injected but no login hook runs.

### Env injection is a managed-sandbox concept

This whole layering — the deployment allowlist, git identity, workspace variable set, and the run-scoped GitHub-auth block that always applies last — describes a **managed sandbox**: a box OpenGeni provisions and injects variables into. A session that runs on a [Connected Machine](../SECURITY.md#connected-machines) is a different backend and is **not** injected this way:

- **The GitHub-token injection is skipped.** A machine-targeted turn does not mint or distribute a run-scoped GitHub App token; the machine uses its **own** git credentials. The "last, untouched" GitHub block above simply does not exist for a machine turn.
- **No env reaches the machine over the wire.** The run's declared variable set is still assembled server-side (and threaded into the session manifest so the SDK's per-turn manifest-env delta stays empty — the internal parity guard), but the command RPC to the machine carries an empty variable set. Workspace variable-set values are therefore not delivered to a machine's commands.

Practically: attaching a variable set shapes what a managed sandbox sees; it does not push secrets onto a Connected Machine. If a machine run needs a secret, it must already be present in that machine's own local variable set.

## Deletion semantics

- A variable set attached to live scheduled tasks cannot be deleted (409 from the API; `ON DELETE RESTRICT` as the database backstop). Detach or delete those tasks first. Scheduled-task deletion is a one-way tombstone that atomically clears the live Variable Set attachment while retained run snapshots keep their credential-free audit evidence, so a deleted task does not consume attachment quota or block later Variable Set deletion.
- A variable set attached to **any** session cannot be deleted (409), including an idle or terminal session. Replace that session's ordered selection through the dedicated quiescent control route, or delete the session/workstream first. This keeps every session mutation behind its activity-revision and cold-rotation fences instead of using a cross-session cascade as an implicit detach operation.
- The authorized organization-retention finalizer is the only exception to that ordinary attachment guard. After offboarding has revoked the owning membership, finalization pauses dependent scheduled tasks and removes only that member's Variable Sets from eligible target-owned private or unowned workspace-shared session selections. A pre-turn `queued` session is eligible only when the canonical quiescence proof finds no queued turn, attempt, holder, pending update, realtime work, retained process, or other live state. The finalizer preserves the relative order and final-entry alias of every surviving set, requests cold rotation for any warm unheld quiescent sandbox group, and writes the session event plus metadata-only detach audit in the same transaction before deleting the set. A session privately owned by another membership, a non-quiescent session/group, or a still-held group fails closed; ordinary API/user deletion never enters this protocol and remains blocked while any attachment exists.

## Rotation

`PUT .../variables/:name` is both set and rotate (the `version` counter increments). A rotated value takes effect on the **next turn**: resumed sandboxes refresh their manifest on resume where the sandbox client supports manifest application, and runs in flight keep the values they loaded at turn start.

## Exact content and exposure model

OpenGeni does not replace an echoed value in model context, history, events,
memory, tool calls/results, failures, diagnostics, transcription, or UI. These
surfaces preserve accepted content exactly. This is deliberately separate from
the configured-secret read boundary:

- a sandboxed agent with network access can exfiltrate any secret it is given;
  attaching a variable set grants real plaintext authority inside that managed
  sandbox, so attach the smallest set that does the job;
- agents may deliberately persist injected plaintext in their own sandbox;
- worker telemetry uses metadata only and never copies the configured value;
- public or third-party telemetry uses reviewed structural fields only; that
  projection never changes stored data, model context, tool results, or UI;
- historical bytes already replaced or omitted by older versions are
  irrecoverable.

## MCP surface

The first-party MCP server exposes variable set tools, gated by the same permissions as the REST routes and **registered only for grants that hold them**:

- `variable_set_list` (`variable-sets:list` + `secrets:list`) — variable-sets with variable names and metadata, never values.
- `variable_set_get_variable` (`variable-sets:read` + literal `secrets:read`) — return one exact plaintext value. It is available only on a session-bound first-party MCP server, never codemode, and additionally requires a current signed workspace/session/turn/attempt/generation claim plus the `session.secret.read` host authorization operation. The database rechecks that the exact attempt is live before atomically committing the read and metadata-only audit.
- `variable_set_set_variable` (`variable-sets:write` + `secrets:write`) — set or rotate one variable, targeted by `variableSetId` or by `variableSetName` (created on first use). The value arrives in plain tool arguments by design; responses return metadata, never values.
- `session_create` (`sessions:create`) accepts `variableSetIds` plus the legacy singular alias; attachment requires both `variable-sets:attach` and `variable-sets:use` like the REST route. There is deliberately no agent-facing attach-after-create tool: post-start replacement is an explicit human/control-plane operation with quiescence and cold-rotation fences.

The worker's current **default** first-party delegated token carries both
`variable-sets:list|write|attach|use` and `secrets:list|write`. It does not carry
the deprecated `variable-sets:manage` compatibility permission, and list/write
tools are registered from the granular permissions directly. It still cannot
read a configured value or change its own current attachment because the
default grant contains neither `variable-sets:read` nor literal `secrets:read`.
A creator can narrow or otherwise customize a session's current permissions
through explicit, creator-capped `firstPartyMcpPermissions`.

Every plaintext read records actor, target name/reference, action, version,
timestamp, and session/turn/attempt/generation when present. The audit never
stores the value, ciphertext, transformed value, or a digest standing in for
the value. A plaintext read fails closed if the audit write cannot commit.

### Manager sessions: per-session first-party MCP permissions

`CreateSessionRequest.firstPartyMcpPermissions` (REST `POST /sessions` and the MCP `session_create` tool) lets an operator create a session whose first-party MCP token carries a **non-default permission set** — this is how a manager-style session sees the orchestration (`sessions:*`), variable set, and `github:use` tools. Three rules keep this safe:

1. **Capped at creation.** Every requested permission must be held by the creating grant (`workspace:admin` covers all); otherwise the request is rejected with 403. A session can never out-rank its creator, and a manager spawning workers via `session_create` can only delegate a subset of what it was itself granted.
2. **Inherited by default for children.** A top-level omission uses the deployment's normal worker defaults. A child created from a worker-signed session claim instead inherits a creation-time snapshot of the creator's effective set, so omission cannot widen a narrowed manager into the standalone defaults or drift when deployment defaults change later.
3. **Fixed for the session's lifetime.** Like variable set attachment, the permission set is fixed at creation; there is no way for a running agent to widen its own token.
