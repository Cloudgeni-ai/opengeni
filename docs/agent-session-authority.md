# Agent session authority

OpenGeni treats the immutable session parent graph as an agent authority
boundary. A workspace permission or permissive embedding-host policy can grant
a capability, but it cannot let a live agent attempt address an arbitrary
session.

This policy applies only to authenticated `agent_attempt` callers. Human and
service callers continue through their existing workspace, private-session, and
optional embedding-host authorization rules.

## Relationship policy

The server reconstructs the exact live caller attempt and reads both sessions'
immutable `parent_session_id` and `root_session_id`. Caller-supplied lineage is
never accepted.

| Target relative to caller | Read | Message (`session.append`) | Mutate/control |
| --- | --- | --- | --- |
| Self | Yes | Yes | Session-local operations only; existing self-control guards remain |
| Immediate child | Yes | Yes | Yes, subject to ordinary permissions |
| Immediate parent | Yes | Yes | No |
| Sibling, other branch, or unrelated root | No | No | No |
| Skipped generation | No | No | No |

Parent reads are an explicit bounded set. Exact configured-secret reads,
Codemode calls, first-party MCP impersonation, acknowledgements, and every
write/control operation remain unavailable upstream. A child reports to its
parent through the canonical durable machine-input boundary; it cannot Pause,
Resume, Cancel, or Steer the parent and thereby influence siblings indirectly.

Parent control of an immediate child may retain the existing recursive subtree
semantics. This is deliberate: the parent owns the child workstream. A deeper
descendant must be reached through its immediate manager rather than by
skipping a generation.

## Discovery is separate

`sessions_list` remains the compact discovery surface. In standalone mode a
live agent may continue to discover workspace session summaries; a stale or
replaced attempt cannot. Detailed reads and mutations then pass the relationship
policy above.

User-private versus workspace-shared discovery is a separate organization
tenancy activation. This policy neither activates those read paths nor infers a
private owner. When visibility activation ships, its database list scope must be
intersected with this invariant rather than replacing or widening it.

## Enforcement and composition

`requireSessionAuthorization` in `@opengeni/core` owns the mandatory preflight
check for HTTP, streams, first-party MCP, Codemode, and shared core session
commands. The transactional Agent Message, Steer, Pause, Resume, and Cancel
seam repeats the mutation relationship fence under the canonical session and
attempt locks. Both validate the exact current attempt before evaluating the
target relationship. An optional embedding-host `SessionAuthorizationPort`
runs only after the preflight check and may narrow the result; it cannot widen
it. Cross-session projections use exact-target mode so a child reading its
parent does not receive parent- or descendant-derived metadata for other
sessions.

The check reuses the session rows already needed for actor and target
authorization. Immutable root snapshots and the indexed
`(workspace_id, parent_session_id)` relationship avoid recursive graph traversal
on the mutation path.

## Product behavior

Independent top-level sessions remain human-controlled. One top-level agent may
discover that another workstream exists, but cannot stop or redirect it. A user
can Pause or Cancel the old work themselves. A future explicit, user-authorized
handoff may grant one named takeover without restoring ambient lateral agent
authority.

The non-bypassable operational prompt tells the agent to use session tools for
user-requested session management, and to spawn a child worker for a subtask
rather than hijacking an unrelated existing session. The prompt does not widen
authority; the relationship policy above remains the enforcement boundary. A
leaf turn without those tools continues the work itself.

Canonical implementation: `packages/runtime/src/operational-instructions.ts`,
`packages/core/src/session-authorization.ts`,
`packages/db/src/session-control.ts`, `packages/db/src/index.ts`,
`apps/api/src/routes/sessions.ts`, and `apps/api/src/mcp/server.ts`.
