# Agent session authority

A live agent attempt may read, message, and control other sessions in the same
workspace when both sessions' `agentAccess` scopes allow it. Parent/child
lineage is never an access deny. First-party session tools (`sessions_list`,
`session_get`, `session_events`, `session_wait`, `session_steer`,
pause/resume/cancel) are the capability surface; the access scope below is the
lock, and unprompted hijack inside an allowed scope is an instruction problem. `session_wait` authorizes
every watched target exactly as `session_events` does (`session.events.read`)
before it subscribes to live fanout; the caller's own session is always an
allowed self target. Slack-private sessions stay same-root for agents, and
`user_private` still requires the initiating human as owner — this is not a new
impersonation path.

This policy applies only to authenticated `agent_attempt` callers. Human and
service callers continue through their existing workspace, private-session, and
optional embedding-host authorization rules.

`session_get({})` resolves only the session in the authenticated exact agent
attempt claims, then performs the same live-attempt and target authorization as
an explicit ID. A child reads itself, never its parent or root. Sessionless,
human, and operator callers must provide `sessionId`; session-like metadata on
a non-agent grant is not a current-agent context. Explicit IDs retain ordinary
private-session and host restrictions. Both compact and full projections remain
bounded; self reads inspect state, not conversation history. REST/SDK session
reads still require explicit IDs. Attempt catalogs and their generated Codemode
declarations derive the optional field from the first-party MCP schema; an
already-frozen catalog does not change in place.

## Agent access scope

Every session carries `agentAccess` (`session`, `user`, or `workspace`; raw
create default `workspace`), an optional opaque `endUser: { source, id }`
label, and `memoryScope` (`workspace`, `user`, `session`, or `off`). They are
frozen on the session row at create and inherited by every child, which may
only narrow them (`workspace` > `user` > `session`; memory `workspace` > `user`
> `session` > `off`; a child may not name a different `endUser`). A widening
request is a 403, and `memoryScope: "user"` without a label is a 422. The MCP
`session_create` tool accepts only `memoryScope`; access and the label are
always inherited.

The rule, applied only to `agent_attempt` actors and only when the target is
outside the caller's own root tree:

- the caller's own tree (root, parent, siblings, descendants) is always allowed;
- if either side is `session`, deny;
- if either side is `user`, allow only when both carry the same
  `endUser` pair;
- otherwise (both `workspace`) allow, subject to the private/Slack/host checks
  below.

The same predicate filters `sessions_list`, `GET /sessions`, agent topology, and
Slack discovery through `SessionAuthorizationListScope.agentAccessViewer`, so a
`workspace`-scoped caller never learns a `session`- or `user`-scoped peer
exists. Humans and the organization API key are unaffected: these sessions stay
`workspace_shared`.

`endUser` is a label, never a principal: it scopes memory
(`end_user:<source>:<id>`) and filters lists, and it grants nothing. Its shape
matches the external-identity pair used by white-label embedding so the two can
later be joined by value.

## Relationship policy

The server reconstructs the exact live caller attempt. Caller-supplied lineage
is never accepted. After that, the agent access scope, Slack-private, and
`user_private` owner checks still run. An optional embedding-host `SessionAuthorizationPort` may narrow the
result; it cannot grant a private session OpenGeni already denied, and it cannot
widen a cross-session projection from exact-target to whole-root.

| Target relative to caller | Read | Message (`session.append`) | Mutate/control |
| --- | --- | --- | --- |
| Self | Yes | Yes | Session-local operations; an agent cannot Steer itself; tool approvals are never agent-decidable |
| Immediate child, parent, sibling, or skipped generation in the caller's own root tree | Yes, subject to private/host checks | Yes, subject to private/host checks | Yes, subject to ordinary permissions and private/host checks |
| Unrelated root, both sides `agentAccess: "workspace"` | Yes, subject to private/host checks | Yes, subject to private/host checks | Yes, subject to ordinary permissions and private/host checks |
| Unrelated root, both sides `agentAccess: "user"` with the same `endUser` | Yes | Yes | Yes, subject to ordinary permissions |
| Unrelated root where either side is `agentAccess: "session"`, or `"user"` with a different or missing `endUser` | No | No | No |
| Slack-private session outside the caller's root | No | No | No |
| `user_private` session whose owner is not the initiating human | No | No | No |

Goal tools remain self-only. Compact `sessions_list` discovery still requires a
live attempt.

Related-work matching does not widen this table. OpenGeni resolves the exact
caller and optional host list scope before applying lifecycle/root/parent/
recency filters, matching titles, active goals, or typed work claims, counting
results, or expanding authorized ancestors. A claim is non-exclusive advisory
evidence and grants no read, message, or control authority. The projection's
literal `advisoryOnly` and `noAdditionalAccess` fields are part of the wire
contract; no match automatically Steers, pauses, cancels, reassigns, or messages
a session. See [`work-discovery.md`](work-discovery.md).

Structured human input versus tool approvals: a live attempt holding
`sessions:control` may answer (or skip, when allowed) another session's
pending structured human-input request through `session_human_input_respond`
(`session.human_input.write`); the answer is recorded as
`respondedBy: agent_attempt:<attemptId>` and resumes that session's blocked
turn exactly like a human answer. A pending tool approval
(`session.approval.write`) is denied to every agent attempt on every surface,
including a child the caller spawned, and an embedding-host port cannot widen
that. The parent learns that a child is blocked through the
`child_requires_action` notice (see
[`durable-agent-inputs.md`](durable-agent-inputs.md)). Production sessions stay `workspace_shared` until visibility
lifecycle is wired; that separate tenancy activation must keep intersecting
these private/host checks rather than replacing them.

Cross-session projections use exact-target mode so a peer read does not receive
parent- or descendant-derived metadata for other sessions.

## Enforcement and composition

`requireSessionAuthorization` in `@opengeni/core` owns the mandatory preflight
check for HTTP, streams, first-party MCP, Codemode, and shared core session
commands. The transactional Agent Message, Steer, Pause, Resume, and Cancel
seam repeats live-attempt, interruption, self-steer, and goal-self fences under
the canonical session and attempt locks. Both validate the exact current attempt
before addressing the target. An optional embedding-host `SessionAuthorizationPort`
runs only after the preflight check and may narrow the result; it cannot widen
private-session access.

Authority never widens down a tree or through a side door:

- `resolveFirstPartyMcpToolsForCreate` rejects a child `firstPartyMcpTools`
  request outside the parent's effective selection, exactly as
  `firstPartyMcpPermissions` were already fenced.
- `PUT /sessions/:id/tool-policy` from an agent attempt may only narrow a
  parentless session's current tools and selection; humans and API keys keep
  the ability to widen a top-level session.
- A scheduled task created by an agent freezes the creating session's effective
  tools, permissions, and `{ agentAccess, endUser, memoryScope }` as its creator
  policy (`packages/core/src/domain/scheduled-tasks.ts`, migration 0426), and
  every session it generates uses that policy instead of deployment defaults.
- The Codemode SDK proxy (`/v1/workspaces/:workspaceId/codemode/sdk/*`) mints
  its agent token from the session's permissions intersected with the
  permissions the session's selected first-party tools require, and
  `siteSessionPath` is an explicit method-plus-path allowlist: session list,
  create, read, events, stream, send, queue, and composer drafts. Tool policy,
  visibility, forks, steer, and control are not reachable from a sandbox.
- A session-scoped grant without a signed `firstPartyMcpTools` claim registers
  no first-party tools.

`test/session-agent-access-contract-surface.test.ts` pins every
`/sessions/:sessionId` route and every target-session MCP tool to the seam;
adding a session-read entry point requires updating that allowlist deliberately.

The non-bypassable operational prompt tells the agent to use session tools for
user-requested session management, and to spawn a child worker for a subtask
rather than hijacking an unrelated existing session. The prompt does not widen
authority; the relationship policy above remains the enforcement boundary. A
leaf turn without those tools continues the work itself.

Canonical implementation: `packages/runtime/src/operational-instructions.ts`,
`packages/core/src/session-authorization.ts`,
`packages/db/src/session-control.ts`, `packages/db/src/index.ts`,
`apps/api/src/routes/sessions.ts`, and `apps/api/src/mcp/server.ts`.
