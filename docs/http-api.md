# HTTP API overview

Opengeni's public contract is the workspace-scoped HTTP API served by
`apps/api`. Canonical protected routes include the workspace id in the URL, and
every request resolves to an internal access grant before route code touches
workspace-owned data. Most clients should use the typed
[`@opengeni/sdk`](../packages/sdk/README.md) rather than calling routes
directly; this page lists the main route families so the shape of the API is
easy to see. Authentication and access modes are described in
[`credentials.md`](credentials.md) and
[`deployment.md` § Security Boundary](deployment.md#security-boundary), and
the product-integration contract (organization API keys, organization
workspaces, external users) in [`product-integration.md`](product-integration.md).

## Core endpoints

- `GET /healthz`
- `GET /v1/config/client`
- `POST /v1/client-errors` (public web client error beacon with scrubbed,
  bounded error diagnostics; see
  [`application-observability.md`](application-observability.md#web-client-errors))
- `POST /v1/analytics-consent` (public, content-free count of analytics banner
  answers; see [`application-observability.md`](application-observability.md#analytics-consent))
- `POST /v1/workspaces/:workspaceId/chat/completions` and
  `GET /v1/workspaces/:workspaceId/models` (stateless OpenAI-compatible single
  model calls without tools; see [`chat-completions.md`](chat-completions.md))
- `GET /v1/access/me`
- `GET /v1/organization-memberships` (managed-human self membership and personal-workspace identity)
- `POST /v1/organizations/additional` (managed-human creation of another isolated organization with its first shared workspace)
- bounded/keyset `GET /v1/organization-invitations` and exact subject-bound
  `POST /v1/organization-invitations/:id/accept`
- `GET|POST /v1/organizations/:id/invitations` for bounded admin listing and
  creation, plus explicit invitation revoke
- `GET /v1/organizations/:id/members` and revision-fenced member lifecycle `PATCH`
- `GET|PATCH /v1/organizations/:id/retention-policy`
- `GET|POST /v1/organizations/:id/personal-api-keys` and
  `DELETE /v1/organizations/:id/personal-api-keys/:apiKeyId` (keys that act as
  the person who created them; see [`credentials.md`](credentials.md))
- `GET /v1/workspaces`
- `POST /v1/workspaces`
- `POST /v1/workspaces/:workspaceId/sessions`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/events`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/events/stream` (SSE; backfills from Postgres by event sequence)
- `POST /v1/workspaces/:workspaceId/sessions/:sessionId/events`

`GET /v1/workspaces/:workspaceId/sessions?view=page&sessionIds=<id>,<id>`
selects up to 200 known sessions (SDK: `listSessionSummaryPage(workspaceId,
{ sessionIds })`). It narrows the caller's ordinary list: private sessions of
other people, archived rows (unless `archiveStatus=all`) and every other filter,
including `search`, still apply, and the response carries
`sessionIdsApplied: true`. With `projection=summary` each row also has
`activeTurnId` and `latestTurn` (`id`, `status`, `startedAt`, `finishedAt`): the
last queued turn, else the executing turn, else the most recently finished one.
Hosts that keep their own record of a chat read its title and state this way
instead of copying events.

`PUT /v1/workspaces/:workspaceId/sessions/:sessionId/retention` with
`{ "keepLive": true | false }` exempts a session from the idle-session archive
(`sessions:control`; 409 `SESSION_ARCHIVED_READ_ONLY` once archived). Session
create accepts `keepLive: true` too. Sessions carry `retention` (`keepLive` and
the archive state); messages to an archived session return 409
`SESSION_ARCHIVED_READ_ONLY`. The session list accepts
`contentArchivedOnly=true` to list only archived sessions, and
`GET /v1/config/client` reports `sessionArchive: { enabled, idleDays }` when the
deployment archives idle sessions. `PUT
/v1/workspaces/:workspaceId/sessions/:sessionId/archive` with
`{ "archived": true }` archives a chat for everyone (`sessions:control`); within
ten seconds `{ "archived": false }` undoes it, after that the archive is final
(409 `session_archive_final`), and 409 `session_archive_blocked` lists what keeps
a chat live. See
[`session-storage-lifecycle.md`](session-storage-lifecycle.md).

Session create accepts `unattended: true` for a session no person will follow
until its task ends, such as an API automation or another headless run. The
agent is told that a question would end the work unanswered, so it settles open
choices with the most conventional option, does the reversible work, leaves
steps only a person can take undone and reports its assumptions and those
steps. Tools that wait for a person (`request_human_input`,
`interaction_request_human`) are not offered. A call that needs someone's
approval under the workspace's tool permissions is not run and not approved:
it returns at once with an error result saying nobody can approve it in an
unattended session, so the agent works around it and lists it as a step left
for a person. Permissions and approval policy stay exactly as configured; no
approval request is opened for the refused call. The setting is recorded at
create under the reserved `_opengeniUnattended` metadata key (session create
ignores a caller-supplied value for it). It is not inherited by child
sessions, a fork of the session is attended (a person makes it to continue the
work), and a keyed retry that changes it is an idempotency conflict. Omitted or
`false` keeps the ordinary interactive behavior.

Session reads include `unattended`, whether the next turns run unattended.
`PUT /v1/workspaces/:workspaceId/sessions/:id/unattended` with
`{ "unattended": true | false }` turns it on or off from the next turn (the
chat's **Work without me** switch in the Agent tab uses the same call; SDK
`updateSessionUnattended`). The switch changes only whether a person is waited
for: while it is on, a call that needs approval is refused as above, and a
question or hand-off to a person returns at once with a result saying no one
will answer. The system instructions and tool list follow how the chat
started and never change mid-chat, so earlier requests stay cacheable: a chat
that started unattended (the create option, or a scheduled or event-triggered
chat that started unattended) keeps the unattended instructions and has no tool
that waits for a person, and a chat that started attended keeps both tools.
Each turn whose setting differs from how the chat started carries a short note
in that turn's input instead: the unattended guidance when the chat was
switched to work without a person, or that a person is now present and can
answer when a chat that started unattended is attended again (the agent then
asks in its reply). A
turn already waiting for a person's answer resumes attended when that answer
arrives. It needs `sessions:control`, returns the session, and returns 409
`SESSION_ARCHIVED_READ_ONLY` for an archived session. A fork keeps this switch.

Chats that a scheduled task or event trigger starts are unattended by default,
because no person answers during the run. A task sets `agentConfig.unattended`
to choose explicitly; a task that sets `agentConfig.approvalTimeoutSeconds`
without it stays attended, since its owner chose to answer its approvals. A
task that posts into an existing chat follows that chat.

Explicit choices win: the create option, the switch (or its API call) and a
task's own `agentConfig.unattended` stay until someone changes them. Only the
automatic default for scheduled and event-triggered chats ends by itself:
when a person sends a message in the chat from the web app, Slack or a voice
call, the chat runs attended from that message on (its approvals wait for that
person; its instructions stay as the chat started). Messages sent with an API
key, from an embedding product or by another agent do not change it.

Session goals support `GET`, `PATCH`, and idempotent `DELETE` on
`/v1/workspaces/:workspaceId/sessions/:id/goal`; `GET` 404s for a goal-less
session unless the client opts in with `?absent=null` (200 `null`). See
[`goals.md`](goals.md).

Scheduled tasks add `GET /v1/workspaces/:workspaceId/scheduled-tasks/attention`
(failed runs and schedules blocked by an unusable account) and the owner-only
`POST .../scheduled-tasks/:taskId/refresh-access`; see
[`scheduled-task-access.md`](scheduled-task-access.md).

Expired offboarded personal data and the organization-tenancy parity check are
explicit operator commands, not API routes; see
[`organization-tenancy.md`](organization-tenancy.md).

## Usage allowance endpoints

- `GET|PUT|DELETE /v1/workspaces/:workspaceId/allowance`
- `POST /v1/workspaces/:workspaceId/allowance/grants`
- `PUT /v1/workspaces/:workspaceId/members/:subjectId/allowance`
- `PUT /v1/workspaces/:workspaceId/members/external/:source/:externalId/allowance`
- `GET /v1/workspaces/:workspaceId/usage` (period selection and member pagination)
- `GET /v1/workspaces/:workspaceId/usage/me` (authenticated subject only)

See [usage allowances](usage-allowances.md) for USD-micro units, CAS,
organization-only budget authority, workspace-admin member splits, frozen
attribution, and post-call overshoot. The packaged conversation proxy serves
only the own-usage read; it never forwards allowance mutations or the roster.
The same suffixes exist beneath
`/v1/workspaces/external/:workspaceSource/:workspaceExternalId` for exact,
existing organization-tenant lookups without provisioning or expanded authority.

## Task usage limit endpoints

- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/usage-limit`
- `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/usage-limit`
- `usageLimitMicros` on `POST /v1/workspaces/:workspaceId/sessions` (new roots only)

See [task usage limits](session-usage-limits.md) for the API-equivalent basis,
root scope, compare-and-set writes, person/host-only authority, the
`session_usage_limit_reached` refusal and rollout. The packaged conversation
proxy forwards neither the routes nor the create field.

## GitHub endpoints

- `GET /v1/workspaces/:workspaceId/github/app`
- `GET /v1/workspaces/:workspaceId/github/connect`
- `GET /v1/workspaces/:workspaceId/github/repositories`
- `POST /v1/workspaces/:workspaceId/github/repositories/sync`
- `POST /v1/workspaces/:workspaceId/github/installations/select`
- `POST /v1/workspaces/:workspaceId/github/installations` (legacy, `410 Gone`)
- `DELETE /v1/workspaces/:workspaceId/github/installations/:installationId`
- `POST /v1/workspaces/:workspaceId/github/app-manifest`
- `GET /v1/github/app-manifest/callback`
- `GET /v1/github/setup`
- `GET /v1/github/oauth/callback`

See [`github-app.md`](github-app.md) for the authority contract.

## Document and Knowledge endpoints

- `GET /v1/workspaces/:workspaceId/document-bases`
- `POST /v1/workspaces/:workspaceId/document-bases`
- `GET /v1/workspaces/:workspaceId/document-bases/:baseId/documents`
- `POST /v1/workspaces/:workspaceId/document-bases/:baseId/documents`
- `POST /v1/workspaces/:workspaceId/document-bases/:baseId/search`
- `POST /v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId/reindex`
- `POST /v1/workspaces/:workspaceId/knowledge/search`
- `GET /v1/workspaces/:workspaceId/knowledge/memories`
- `POST /v1/workspaces/:workspaceId/knowledge/memories`
- `GET /v1/workspaces/:workspaceId/knowledge/memories/:memoryId`
- `PATCH /v1/workspaces/:workspaceId/knowledge/memories/:memoryId`

See [`knowledge.md`](knowledge.md).

## Connected Machine endpoints

All return `404` unless `OPENGENI_SANDBOX_SELFHOSTED_ENABLED=true`:

- `POST /v1/enrollments/device/start` (agent-side, unauthenticated)
- `POST /v1/enrollments/device/poll` (agent-side, unauthenticated)
- `POST /v1/enrollments/device/lookup`
- `POST /v1/enrollments/token/exchange` (agent-side headless enroll-token redemption)
- `POST /v1/workspaces/:workspaceId/enrollments/device/approve`
- `POST /v1/workspaces/:workspaceId/enrollments/device/deny`
- `POST /v1/workspaces/:workspaceId/enrollments/token` (mint a headless enroll token)
- `GET /v1/workspaces/:workspaceId/enrollments`
- `POST /v1/workspaces/:workspaceId/enrollments/:enrollmentId/revoke`

`POST /v1/workspaces/:workspaceId/sessions` (and the `session_create` MCP tool)
accept `targetSandboxId` (the enrolled machine to run on) and `workingDir` (the
per-session folder; only valid alongside `targetSandboxId`, and omitted means
the machine's default working root). See
[`connected-machines.md`](connected-machines.md).
