# Agent session authority

A live agent attempt may read, message, and control other sessions in the same
workspace. Parent/child lineage is not an access deny. First-party session
tools (`sessions_list`, `session_get`, `session_events`, `session_wait`,
`session_steer`, pause/resume/cancel) are the capability surface; unprompted
hijack is an instruction problem, not a second lock. `session_wait` authorizes
every watched target exactly as `session_events` does (`session.events.read`)
before it subscribes to live fanout; the caller's own session is always an
allowed self target. Slack-private sessions stay same-root for agents, and
`user_private` still requires the initiating human as owner — this is not a new
impersonation path.

This policy applies only to authenticated `agent_attempt` callers. Human and
service callers continue through their existing workspace, private-session, and
optional embedding-host authorization rules.

## Relationship policy

The server reconstructs the exact live caller attempt. Caller-supplied lineage
is never accepted. After that, Slack-private and `user_private` owner checks
still run. An optional embedding-host `SessionAuthorizationPort` may narrow the
result; it cannot grant a private session OpenGeni already denied, and it cannot
widen a cross-session projection from exact-target to whole-root.

| Target relative to caller | Read | Message (`session.append`) | Mutate/control |
| --- | --- | --- | --- |
| Self | Yes | Yes | Session-local operations; an agent cannot Steer itself |
| Immediate child, parent, sibling, skipped generation, or unrelated root | Yes, subject to private/host checks | Yes, subject to private/host checks | Yes, subject to ordinary permissions and private/host checks |
| Slack-private session outside the caller's root | No | No | No |
| `user_private` session whose owner is not the initiating human | No | No | No |

Goal tools remain self-only. Compact `sessions_list` discovery still requires a
live attempt. Production sessions stay `workspace_shared` until visibility
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

The non-bypassable operational prompt tells the agent to use session tools for
user-requested session management, and to spawn a child worker for a subtask
rather than hijacking an unrelated existing session. The prompt does not widen
authority; the relationship policy above remains the enforcement boundary. A
leaf turn without those tools continues the work itself.

Canonical implementation: `packages/runtime/src/operational-instructions.ts`,
`packages/core/src/session-authorization.ts`,
`packages/db/src/session-control.ts`, `packages/db/src/index.ts`,
`apps/api/src/routes/sessions.ts`, and `apps/api/src/mcp/server.ts`.
