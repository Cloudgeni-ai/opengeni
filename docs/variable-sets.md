# Workspace Variable Sets

A workspace owns named **variable-sets**: sets of variables whose values are secret. A variable set is **attached** to runnable things — a session (at creation only), a scheduled task, or a capability pack installation that declares it uses one — and its values are injected into the sandbox at materialization time for runs whose session carries the attachment.

## Invariants

1. **The current value API is write-only.** Generic workspace, session, event, capability, installation, and variable-set metadata responses remain value-free. Reads return names and metadata (version, timestamps) only; this emergency release does not yet expose a plaintext read route or tool.
2. **No attachment, no injection.** A run whose session has `variableSetId = null` gets exactly the pre-existing behavior: the deployment env allowlist, git identity, and run-scoped GitHub auth. Nothing more. (This injection describes a **managed sandbox**; a Connected Machine session is not injected this way — see [Env injection is a managed-sandbox concept](#env-injection-is-a-managed-sandbox-concept).)
3. **Agents cannot change their own attachment or self-escalate.** The current worker default includes `variable-sets:use` and `variable-sets:manage`, so an agent can manage sets and attach one when it creates a child session, but the write-only API does not reveal stored values. A session only holds a different first-party permission set when its creator explicitly grants one at creation (`firstPartyMcpPermissions`, capped by the creating grant), and there is no attach-after-create operation.
4. **Workspace isolation.** Both tables are protected by the same forced row-level-security policy as every other workspace table.
5. **Encryption at rest.** Values are AES-256-GCM encrypted with an operator key (`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`) held outside Postgres. A database dump alone does not reveal values.
6. **No content rewriting.** If an authorized agent echoes a configured value into model history, events, tool results, errors, memory, or UI-visible OpenGeni data, that content remains exact. Public or third-party telemetry uses a sink-local, closed schema and never writes back over canonical OpenGeni data.

## Emergency rollout

This emergency release removes heuristic rewriting from internal content and
retains the existing write-only variable-set API. The approved permissioned
plaintext-read contract is recorded below as a target, not as a live feature;
it will follow in small reviewed changes across the backend, SDK, MCP, and UI.
Historical content already rewritten by an older release cannot be
reconstructed.

## Deliberate v1 storage decision

`docs/packs.md` states that connector secrets should live behind `credentialRef` in an external broker, not in Postgres. Workspace variable-sets deliberately differ: they DO store secret values in Postgres, encrypted with an operator key that lives only in the deployment's secret set. v1 ships no external secret-manager integration; the `v1:` ciphertext prefix leaves room for `v2:<keyId>:...` key rotation or external references without a schema change. Use `credentialRef` connectors for OAuth-broker-shaped credentials; use variable-sets for plain `NAME=value` material an agent process expects.

## Configuration

```sh
openssl rand -base64 32   # generate OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY
```

- The key must decode to exactly 32 bytes; boot validation fails otherwise.
- `OPENGENI_PRODUCT_ACCESS_MODE=managed` outside `local`/`test` requires the key at boot.
- In other modes the key is optional: until it is set, variable set write routes and attachment validation return `503 workspace variable sets require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`, and a run whose session somehow carries an attachment fails closed.
- Losing the key makes stored values unrecoverable (runs with attachments fail closed); rotate by re-entering values.

## Permissions

| Permission | Grants |
|---|---|
| `variable-sets:use` | List/read variable-sets (names + metadata) and attach them to sessions, scheduled tasks, and pack installations. |
| `variable-sets:manage` | Create/rename/delete variable-sets and set/rotate/delete variable values. |

`workspace:admin` implies both current permissions. The deprecated
`environments:use` and `environments:manage` aliases retain the same behavior.
Reads are deliberately not folded under `workspace:read`: listing the names of
secret sets is itself sensitive. A workspace API key holding only
`variable-sets:use` can attach but cannot read values, consistent with the
current write-only design. Editing the `agentConfig` of a scheduled task that
has a variable set attached also requires `variable-sets:use`, because changing
the instructions of a secret-bearing task is equivalent to attaching those
secrets to new instructions. Changing or removing an attachment requires it for
the same reason.

## API

| Method and path | Permission | Notes |
|---|---|---|
| `GET /v1/workspaces/:workspaceId/variable-sets` | `variable-sets:use` | Variable sets with variable metadata, never plaintext values. |
| `POST /v1/workspaces/:workspaceId/variable-sets` | `variable-sets:manage` | Create with optional initial variables. 409 on duplicate name. Caps: 25 variable-sets/workspace, 100 variables/variable set. |
| `GET /v1/workspaces/:workspaceId/variable-sets/:variableSetId` | `variable-sets:use` | Metadata only. |
| `PATCH /v1/workspaces/:workspaceId/variable-sets/:variableSetId` | `variable-sets:manage` | Rename / description. |
| `DELETE /v1/workspaces/:workspaceId/variable-sets/:variableSetId` | `variable-sets:manage` | 409 while attached (see deletion semantics). |
| `PUT /v1/workspaces/:workspaceId/variable-sets/:variableSetId/variables/:name` | `variable-sets:manage` | Set or rotate one value; bumps `version`. |
| `DELETE /v1/workspaces/:workspaceId/variable-sets/:variableSetId/variables/:name` | `variable-sets:manage` | Remove a variable. |

Attachment points:

- `POST /v1/workspaces/:id/sessions` accepts `variableSetId`. The attachment is fixed at creation; follow-up `user.message` events cannot add or switch one. The `session.created` event carries `variableSetId`/`variableSetName` (names only).
- `POST`/`PATCH /v1/workspaces/:id/scheduled-tasks` accept `variableSetId` (null detaches on update). Changing the attachment of a task with a live reusable session returns 409 — the session keeps its creation-time attachment, so recreate the task instead.
- `POST /v1/workspaces/:id/packs/:packId/enable` accepts `variableSetId` when a pack declares a `variable set` block; required variables are checked by **name**. Scheduled tasks created from that installation's templates inherit the attachment without re-checking `variable-sets:use` on the caller — it was authorized at enable time.

An unknown or cross-workspace `variableSetId` in any attachment payload returns `422 unknown variableSetId`; RLS makes the two cases indistinguishable by design.

### Variable names

Names must match `^[A-Z][A-Z0-9_]*$` (max 128 chars). Names the platform manages or that act as loader-injection vectors are rejected with 422:

- exact: `HOME`, `PATH`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `IFS`, `ENV`, `BASH_ENV`, `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `PERL5OPT`, `PERL5LIB`, `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `AZURE_DEVOPS_EXT_PAT`, `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT`
- prefixes: `OPENGENI_`, `GIT_CONFIG_`, `GIT_AUTHOR_`, `GIT_COMMITTER_`, `LD_`, `DYLD_`

## Composition with the deployment allowlist

`OPENGENI_SANDBOX_ENV_ALLOWLIST` and `OPENGENI_SANDBOX_PREPARATION_PROFILES` keep their meaning: the deployment operator forwards those process-env values into every sandbox. Workspace variable-sets are layered on top per run:

```
deployment allowlist < git identity < workspace variable set < run-scoped GitHub auth
```

Later wins. A session bound to a [rig](rigs.md) with `defaultVariableSetIds` gets one more layer, inserted **below** the session's own attached variable set: `deployment allowlist < git identity < rig default variable sets < workspace variable set < run-scoped GitHub auth`. A rig default is pure convenience for tooling every session on that rig should have; the session's own attachment still wins any name collision. Reserved-name validation prevents collisions with the platform-managed git/GitHub entries, so the run-scoped GitHub token block always applies last untouched. Note that sandbox lifecycle hooks are profile-driven: workspace-provided `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` only trigger the `azure-cli-login` hook on deployments that enable the `azure` preparation profile; on profile-less deployments the values are injected but no login hook runs.

### Env injection is a managed-sandbox concept

This whole layering — the deployment allowlist, git identity, workspace variable set, and the run-scoped GitHub-auth block that always applies last — describes a **managed sandbox**: a box OpenGeni provisions and injects variables into. A session that runs on a [Connected Machine](../SECURITY.md#connected-machines) is a different backend and is **not** injected this way:

- **The GitHub-token injection is skipped.** A machine-targeted turn does not mint or distribute a run-scoped GitHub App token; the machine uses its **own** git credentials. The "last, untouched" GitHub block above simply does not exist for a machine turn.
- **No env reaches the machine over the wire.** The run's declared variable set is still assembled server-side (and threaded into the session manifest so the SDK's per-turn manifest-env delta stays empty — the internal parity guard), but the command RPC to the machine carries an empty variable set. Workspace variable-set values are therefore not delivered to a machine's commands.

Practically: attaching a variable set shapes what a managed sandbox sees; it does not push secrets onto a Connected Machine. If a machine run needs a secret, it must already be present in that machine's own local variable set.

## Deletion semantics

- A variable set attached to scheduled tasks cannot be deleted (409 from the API; `ON DELETE RESTRICT` as the database backstop). Detach the tasks first.
- A variable set attached to sessions in a non-terminal state (`queued`, `running`, `requires_action`) cannot be deleted (409). Wait for them to finish or cancel them.
- Sessions in `idle`, `failed`, or `cancelled` state do **not** block deletion; their `variable_set_id` is set to NULL (`ON DELETE SET NULL`) so run history is preserved. An idle **reusable** session cannot be silently detached this way: its scheduled task holds its own RESTRICT-backed attachment (and the API refuses to change a live reusable task's attachment), so deletion stays blocked until the task is detached or deleted — and a deleted task never re-dispatches. Be aware of the consequence: sending a new message to a formerly-attached idle session after its variable set was deleted runs **without** workspace variable set injection, indistinguishable from a never-attached session. If the work depends on the secrets, create a new session with a current attachment.

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

- `variable_set_list` (`variable-sets:use`) — variable-sets with variable names and metadata, never values.
- `variable_set_set_variable` (`variable-sets:manage`) — set or rotate one variable, targeted by `variableSetId` or by `variableSetName` (created on first use). The value arrives in plain tool arguments by design; responses stay write-only and return metadata, never values.
- `session_create` (`sessions:create`) accepts `variableSetId`; attachment requires `variable-sets:use` like the REST route. There is deliberately no attach-after-create tool because attachment is fixed at session creation (see above).

The worker's current **default** first-party delegated token carries both
`variable-sets:use` and `variable-sets:manage`, so these write-only tools are
registered for it. It still cannot read a configured value or change its own
creation-time attachment. A creator can narrow or otherwise customize a
session's current permissions through explicit, creator-capped
`firstPartyMcpPermissions`.

## Approved permissioned-read target — not yet live

The approved follow-up adds dedicated permissions without allowing a legacy
scope to imply plaintext access:

| Permission | Target grant |
|---|---|
| `variable-sets:list` | List variable-set containers and metadata. |
| `variable-sets:read` | Read one variable-set container and metadata. |
| `variable-sets:write` | Create, rename, or delete variable-set containers. |
| `variable-sets:use` | Attach and inject variable sets; never reveal plaintext by itself. |
| `secrets:list` | List configured secret names and versions. |
| `secrets:read` | Retrieve one exact plaintext configured secret through a dedicated operation. |
| `secrets:write` | Create, rotate, or delete configured secret values. |

The target operations compose both resource and value scopes:

| Target operation | Required permission(s) |
|---|---|
| List variable sets and variable metadata | `variable-sets:list` + `secrets:list` |
| Get one variable set and variable metadata | `variable-sets:read` + `secrets:list` |
| Create/update/delete a variable-set container | `variable-sets:write` |
| Attach a variable set | `variable-sets:use` |
| Read one exact value | `variable-sets:read` + literal `secrets:read` |
| Set/rotate/delete one value | `variable-sets:write` + `secrets:write` |

The dedicated REST read will be
`GET /v1/workspaces/:workspaceId/variable-sets/:variableSetId/variables/:name`.
The matching MCP tool will be `variable_set_get_variable`. An agent call must
also present a live signed session claim for the exact workspace, session, turn,
attempt, and execution generation and pass a new `session.secret.read`
authorization operation. Cancellation, attempt replacement, generation
advance, permission removal, membership revocation, and API-key revocation must
deny the next read. The default first-party grant will not include
`secrets:read`.

Every list/read/write will commit a metadata-only access audit atomically with
the operation. The audit records actor, target name/reference, action, version,
timestamp, and session/turn/attempt/generation when present; it never stores the
value, ciphertext, transformed value, or a digest standing in for the value. A
plaintext read fails closed if that audit write cannot commit. REST, SDK, React,
MCP, and UI reveal/copy/edit surfaces ship only after cross-tenant forced-RLS,
revocation, stale-attempt, and exact round-trip tests pass.

### Manager sessions: per-session first-party MCP permissions

`CreateSessionRequest.firstPartyMcpPermissions` (REST `POST /sessions` and the MCP `session_create` tool) lets an operator create a session whose first-party MCP token carries a **non-default permission set** — this is how a manager-style session sees the orchestration (`sessions:*`), variable set, and `github:use` tools. Three rules keep this safe:

1. **Capped at creation.** Every requested permission must be held by the creating grant (`workspace:admin` covers all); otherwise the request is rejected with 403. A session can never out-rank its creator, and a manager spawning workers via `session_create` can only delegate a subset of what it was itself granted.
2. **Inherited by default for children.** A top-level omission uses the deployment's normal worker defaults. A child created from a worker-signed session claim instead inherits a creation-time snapshot of the creator's effective set, so omission cannot widen a narrowed manager into the standalone defaults or drift when deployment defaults change later.
3. **Fixed for the session's lifetime.** Like variable set attachment, the permission set is fixed at creation; there is no way for a running agent to widen its own token.
