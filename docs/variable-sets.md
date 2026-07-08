# Workspace Variable sets

A workspace owns named **variable-sets**: sets of variable set variables whose values are secret. An variable set is **attached** to runnable things — a session (at creation only), a scheduled task, or a capability pack installation that declares it uses one — and its values are injected into the sandbox at materialization time for runs whose session carries the attachment.

## Invariants

1. **Write-only values.** No API response, session event, log, span, or audit record ever contains a variable value. Reads return names and metadata (version, timestamps) only; there is no read-back even at create time. Rotation is `PUT` with a new value.
2. **No attachment, no injection.** A run whose session has `variableSetId = null` gets exactly the pre-existing behavior: the deployment env allowlist, git identity, and run-scoped GitHub auth. Nothing more. (This injection describes a **managed sandbox**; a Connected Machine session is not injected this way — see [Env injection is a managed-sandbox concept](#env-injection-is-a-managed-sandbox-concept).)
3. **Agents cannot self-attach.** The worker's **default** first-party MCP delegated token never carries `variable-sets:use`, and the MCP scheduled-task tools reject attachment changes (set **or** detach) and instruction edits to variable set-attached tasks for grants without it. A session only holds a stronger first-party token when its creator explicitly granted one at creation (`firstPartyMcpPermissions`, capped by the creating grant) — agents can never escalate themselves.
4. **Workspace isolation.** Both tables are protected by the same forced row-level-security policy as every other workspace table.
5. **Encryption at rest.** Values are AES-256-GCM encrypted with an operator key (`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`) held outside Postgres. A database dump alone does not reveal values.

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

`workspace:admin` implies both. Reads are deliberately not folded under `workspace:read`: listing the names of secret sets is itself sensitive. A workspace API key holding only `variable-sets:use` can attach but can never read values — consistent with the write-only design. Editing the `agentConfig` of a scheduled task that has an variable set attached also requires `variable-sets:use`, because changing the instructions of a secret-bearing task is equivalent to attaching those secrets to new instructions. Changing or removing a task's attachment (including `variableSetId: null`) requires it for the same reason.

## API

| Method and path | Permission | Notes |
|---|---|---|
| `GET /v1/workspaces/:workspaceId/variable-sets` | `variable-sets:use` | Variable sets with variable metadata. |
| `POST /v1/workspaces/:workspaceId/variable-sets` | `variable-sets:manage` | Create with optional initial variables. 409 on duplicate name. Caps: 25 variable-sets/workspace, 100 variables/variable set. |
| `GET /v1/workspaces/:workspaceId/variable-sets/:variableSetId` | `variable-sets:use` | Metadata only. |
| `PATCH /v1/workspaces/:workspaceId/variable-sets/:variableSetId` | `variable-sets:manage` | Rename / description. |
| `DELETE /v1/workspaces/:workspaceId/variable-sets/:variableSetId` | `variable-sets:manage` | 409 while attached (see deletion semantics). |
| `PUT /v1/workspaces/:workspaceId/variable-sets/:variableSetId/variables/:name` | `variable-sets:manage` | Set or rotate one value; bumps `version`. |
| `DELETE /v1/workspaces/:workspaceId/variable-sets/:variableSetId/variables/:name` | `variable-sets:manage` | Remove a variable. |

Attachment points:

- `POST /v1/workspaces/:id/sessions` accepts `variableSetId`. The attachment is fixed at creation; follow-up `user.message` events cannot add or switch one. The `session.created` event carries `variableSetId`/`variable setName` (names only).
- `POST`/`PATCH /v1/workspaces/:id/scheduled-tasks` accept `variableSetId` (null detaches on update). Changing the attachment of a task with a live reusable session returns 409 — the session keeps its creation-time attachment, so recreate the task instead.
- `POST /v1/workspaces/:id/packs/:packId/enable` accepts `variableSetId` when a pack declares an `variable set` block; required variables are checked by **name**. Scheduled tasks created from that installation's templates inherit the attachment without re-checking `variable-sets:use` on the caller — it was authorized at enable time.

An unknown or cross-workspace `variableSetId` in any attachment payload returns `422 unknown variableSetId`; RLS makes the two cases indistinguishable by design.

### Variable names

Names must match `^[A-Z][A-Z0-9_]*$` (max 128 chars). Names the platform manages or that act as loader-injection vectors are rejected with 422:

- exact: `HOME`, `PATH`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `IFS`, `ENV`, `BASH_ENV`, `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `PERL5OPT`, `PERL5LIB`, `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT`
- prefixes: `OPENGENI_`, `GIT_CONFIG_`, `GIT_AUTHOR_`, `GIT_COMMITTER_`, `LD_`, `DYLD_`

## Composition with the deployment allowlist

`OPENGENI_SANDBOX_ENV_ALLOWLIST` and `OPENGENI_SANDBOX_PREPARATION_PROFILES` keep their meaning: the deployment operator forwards those process-env values into every sandbox. Workspace variable-sets are layered on top per run:

```
deployment allowlist < git identity < workspace variable set < run-scoped GitHub auth
```

Later wins. A session bound to a [rig](rigs.md) with `defaultVariableSetIds` gets one more layer, inserted **below** the session's own attached variable set: `deployment allowlist < git identity < rig default variable sets < workspace variable set < run-scoped GitHub auth`. A rig default is pure convenience for tooling every session on that rig should have; the session's own attachment still wins any name collision. Reserved-name validation prevents collisions with the platform-managed git/GitHub entries, so the run-scoped GitHub token block always applies last untouched. Note that sandbox lifecycle hooks are profile-driven: workspace-provided `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` only trigger the `azure-cli-login` hook on deployments that enable the `azure` preparation profile; on profile-less deployments the values are injected but no login hook runs.

### Env injection is a managed-sandbox concept

This whole layering — the deployment allowlist, git identity, workspace variable set, and the run-scoped GitHub-auth block that always applies last — describes a **managed sandbox**: a box OpenGeni provisions and injects variable set into. A session that runs on a [Connected Machine](../SECURITY.md#connected-machines) is a different backend and is **not** injected this way:

- **The GitHub-token injection is skipped.** A machine-targeted turn does not mint or distribute a run-scoped GitHub App token; the machine uses its **own** git credentials. The "last, untouched" GitHub block above simply does not exist for a machine turn.
- **No env reaches the machine over the wire.** The run's declared variable set is still assembled server-side (and threaded into the session manifest so the SDK's per-turn manifest-env delta stays empty — the internal parity guard), but the command RPC to the machine carries an empty variable set. Workspace-variable set values are therefore not delivered to a machine's commands.

Practically: attaching an variable set shapes what a managed sandbox sees; it does not push secrets onto a Connected Machine. If a machine run needs a secret, it must already be present in that machine's own local variable set.

## Deletion semantics

- An variable set attached to scheduled tasks cannot be deleted (409 from the API; `ON DELETE RESTRICT` as the database backstop). Detach the tasks first.
- An variable set attached to sessions in a non-terminal state (`queued`, `running`, `requires_action`) cannot be deleted (409). Wait for them to finish or cancel them.
- Sessions in `idle`, `failed`, or `cancelled` state do **not** block deletion; their `variable set_id` is set to NULL (`ON DELETE SET NULL`) so run history is preserved. An idle **reusable** session cannot be silently detached this way: its scheduled task holds its own RESTRICT-backed attachment (and the API refuses to change a live reusable task's attachment), so deletion stays blocked until the task is detached or deleted — and a deleted task never re-dispatches. Be aware of the consequence: sending a new message to a formerly-attached idle session after its variable set was deleted runs **without** workspace variable set injection, indistinguishable from a never-attached session. If the work depends on the secrets, create a new session with a current attachment.

## Rotation

`PUT .../variables/:name` is both set and rotate (the `version` counter increments). A rotated value takes effect on the **next turn**: resumed sandboxes refresh their manifest on resume where the sandbox client supports manifest application, and runs in flight keep the values they loaded at turn start.

## Redaction and residual exposure

Values never enter the events pipeline by construction — injection is server-side and the API is write-only. As defense-in-depth against an agent echoing values (for example running `env`), the worker replaces exact occurrences of every attached value (length >= 6) with `[redacted:<NAME>]` in all session events it publishes for that turn. Known residual exposure, stated honestly:

- `agent_run_states.serialized_run_state` may contain echoed values inside tool transcripts. It is RLS-protected and never returned by any API route, and it must stay intact for session resume, so it is not redacted.
- A sandboxed agent with network access can exfiltrate any secret it is given. Attaching an variable set **is** granting those secrets to that run. Attach the smallest variable set that does the job.
- Worker telemetry carries ids only (`opengeni.variable set_id` on the run span); heartbeats and logs never carry the value map.

## MCP surface

The first-party MCP server exposes variable set tools, gated by the same permissions as the REST routes and **registered only for grants that hold them**:

- `variable set_list` (`variable-sets:use`) — variable-sets with variable names and metadata, never values.
- `variable set_set_variable` (`variable-sets:manage`) — set or rotate one variable, targeted by `variableSetId` or by `variable setName` (created on first use). The value arrives in plain tool arguments by design: the calling agent (e.g. an orchestrating "manager" holding a grant with `variable-sets:manage`) is trusted with the secrets it persists. Responses stay write-only — metadata, never values.
- `session_create` (`sessions:create`) accepts `variableSetId`; attachment requires `variable-sets:use` like the REST route. There is deliberately no attach-after-create tool because attachment is fixed at session creation (see above).

The invariant that sandboxed agents cannot reach workspace secrets is unchanged: the worker's **default** first-party delegated token carries neither `variable-sets:use` nor `variable-sets:manage`, so none of these tools are registered for it. The `scheduled_tasks_create`/`scheduled_tasks_update` tools accept `variableSetId` but reject any attachment change — set or detach — unless the calling grant holds `variable-sets:use`, which the sandboxed agent's default first-party token never does.

### Manager sessions: per-session first-party MCP permissions

`CreateSessionRequest.firstPartyMcpPermissions` (REST `POST /sessions` and the MCP `session_create` tool) lets an operator create a session whose first-party MCP token carries a **non-default permission set** — this is how a manager-style session sees the orchestration (`sessions:*`), variable set, and `github:use` tools. Two rules keep this safe:

1. **Capped at creation.** Every requested permission must be held by the creating grant (`workspace:admin` covers all); otherwise the request is rejected with 403. A session can never out-rank its creator, and a manager spawning workers via `session_create` can only delegate a subset of what it was itself granted.
2. **Fixed for the session's lifetime.** Like variable set attachment, the permission set is fixed at creation; there is no way for a running agent to widen its own token.
