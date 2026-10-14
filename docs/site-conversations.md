# Conversations created through Sites

## Behavior

- The host bridge supplies the published Site identity. Session creation records
  `_opengeniSiteOrigin: { siteId, title }` in existing session metadata. The title
  is a creation-time label; the stable Site ID is the identity.
- Origin is descriptive, not permission, project membership, or parentage.
  It is a caller-asserted, server-validated Site association, not proof that code
  executed inside a Site. An authorized API client can provide an existing
  same-workspace Site/version pair too. Never use this label for authorization
  or security/audit attestation.
  Opening a pre-existing conversation does not relabel it. Existing unlabelled
  sessions are not guessed/backfilled from prompts or publishing sessions.
- Ordinary browsing groups unfiled, unpinned Site-created root conversations in
  a stable Site row. Recent/working activity lifts the row using existing rail
  ordering. Counts cover the currently loaded authorized trees, like scheduled
  run grouping; opening the Site's Conversations panel provides paginated history.
- Explicit projects and pins win. Search and custom browsing remain session-first.
  The origin link remains on individual rows and in the session header regardless
  of placement. The group is presentation only: no fake session is persisted and
  no parent-control authority is introduced.
- The host Site detail page has a Conversations tab: search, active/archived,
  refresh, and pagination. It works independently of generated Site navigation.

## API and implementation

`GET /v1/workspaces/:id/sessions?view=page&originSiteId=<uuid>` combines Site
origin with ordinary project/search/date/visibility filters before pagination.
Origin is bound into continuation cursors. Successful responses echo
`originSiteId`; the SDK fails explicitly against servers that ignore it.
The first-party `sessions_list` tool accepts the same UUID filter.

The Site-bound SDK accepts `originSiteId: "current"`; the host replaces it with
its host-supplied Site ID. Sandbox previews have no published identity and resolve it
to an empty history, not the entire workspace. Other session SDK calls keep their
existing behavior and authentication.

The published HTTP bridge supplies `x-opengeni-site-id` and
`x-opengeni-site-version`. The API verifies their workspace/version relationship,
then scopes creation through `withSiteSessionOrigin`. The first-party tool
gateway uses the same scope. Concurrent requests remain isolated, including
the in-memory MCP transport. Caller-provided origin metadata is discarded.
Historical versions remain valid provenance after publication/archive so normal
response-loss retries are not broken by a mutable current-version check.
Site code reaches only the `SITE_OPERATIONS` allowlist (method plus exact path
shape, in `packages/contracts/src/site-operations.ts`). The host binds requests
to its workspace and rejects unsafe URL paths, and the API enforces the same
allowlist again for every request carrying the host's frame headers
(`apps/api/src/site-frame-guard.ts`); ordinary API handlers then authorize the
allowed operation as the viewer. Sandbox previews use the same routing with
the agent's existing proxy permission ceiling, not viewer credentials.
Integration-tool allowlists and ordinary approval rules remain separate and unchanged.

A Site page sends message text, never authority. On messages, steering, queue
changes and composer drafts it may set the text, annotations, model, reasoning
effort, latency mode and the client ids and revisions that make a request
retry-safe (`siteFrameBodyRefusal`). Anything else with a value is refused with
403 `site_frame_field_forbidden`, naming the field: approval decisions, answers
to human-input requests (with or without secret answers), resources, personal
resource attachments, MCP credential updates, connection account choices and
hidden model context. The console bridge refuses them before forwarding and the
API refuses them again.

Approvals and answers for a conversation started from a console Site happen in
the console, in the conversation itself, not inside the Site. A Site that embeds
`SessionConversation` shows the pending request, but its Approve, Reject and
answer controls get the 403 above; the person opens the conversation in the
console (the origin link on the Site's Conversations tab) to respond.

A Site page starts a session with a message and a model only. Session create
accepts `initialMessage`, `requestedSessionId`, `idempotencyKey`,
`clientEventId`, `model`, `reasoningEffort`, `latencyMode`, `startMode` and
`metadata` (keys starting with `_opengeni` are dropped), and refuses any other
field with a value (tools, MCP servers, first-party tools and permissions,
vault policy, connections, sandbox or environment choice, working directory,
resources, Skills, agent overrides, model context, learning overrides, goal,
project, visibility, usage limit, nesting). The session then runs on a minimal
Site profile: no vault access and the workspace defaults for everything else.
An agent started from a Site page is also clamped (`assertNotSiteClampedAgent`):
it cannot create or change schedules, automations, Site publications,
workspace instructions, Skills, Knowledge or secrets, so it does not learn.
Published Sites start their agents as `site:<siteId>` with the publication's
own tools and limits instead (see `docs/site-runtime-api.md`).

## Agent defaults

The Sites skill recommends a selector for this Site's conversations plus New
conversation. First Send creates one session with a retry-stable idempotency key;
thereafter the standard `SessionConversation` owns chat interaction. No project
is created just for grouping. A user may instead request a project-wide or
workspace-wide interface. These are defaults, not product restrictions.

## Validation

Cover origin stamping/concurrent isolation, actual MCP transport propagation,
host/preview binding, SQL filtering before pagination and cursor binding,
project/pin precedence, search, aggregate counts and keyboard projection.
Inspect the Conversations tab and origin links in the local browser before handoff.
