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
Site profile: no vault access, the workspace's default agent capabilities with
workspace administration and browser and computer control turned off (so the
page cannot reach the viewer's sandboxes, Connected Machines or Chrome through
`run_on`, `sandbox_attach`, `sandbox_swap`, `sandbox_provision`, `browser_*` or
`computer_*`), with `sandboxBackend: "none"`. First-party tools are explicit:
the Site's requested tools plus its own data tools, not workspace defaults.
Registry connections carry `allowedTools` with the exact names declared by the
Site, intersected with the connection's allowlist and member permissions at
execution. Empty means none; duplicate references intersect their lists.
Workers it starts can only narrow that.
An agent started from a Site page is also clamped (`assertNotSiteClampedAgent`):
it cannot create or change schedules, automations, Site publications,
workspace instructions, Skills, Knowledge or secrets, so it does not learn.
Nor can it change the workspace itself, its members, connections,
integrations, webhooks, network routes or settings, the organization
profile, Connected Machines or sandbox environments. It cannot reach compute
beyond its own session's: it cannot run on, attach, swap or provision a
sandbox or Connected Machine, drive a browser or computer session, or start a
worker on a chosen machine (`targetSandboxId`), a self-hosted backend or
another session's sandbox group (403); its workers share its sandbox or get a
new managed one. It changes a Site's content (new versions, rollback, archive,
restore, audience) only for the Site it was started from and Sites an agent in
its own session tree created with the artifact tools (the Site's first version
records that session), published or not, so a page cannot spread itself
through the person's other Sites. Sites it creates over HTTP record no source
session, so it cannot change them later; agents create Sites with
`artifacts_create`. The first-party tools refuse those writes with
`site_agent_clamped`:

- `knowledge_*` writes and `instruction_policy_save`;
- `secret_save`, `secret_move` and `secret_delete`;
- `skill_save`, `skill_install`, `skill_publish` and `skill_remove`;
- `company_profile_propose` and `company_profile_confirm`;
- `connected_machine_enroll_token`, `connected_machine_enable_screen_control`
  and `connected_machine_remove`;
- `rig_propose_change`, `rig_verify` and `rig_promote`;
- `run_on`, `sandbox_attach`, `sandbox_swap` and `sandbox_provision`;
- `artifacts_publish`, `artifacts_rollback`, `artifacts_archive` and
  `artifacts_restore` for any other Site.

Over HTTP the clamp is an allowlist (`SITE_AGENT_WRITES` in
`apps/api/src/site-agent-guard.ts`). Under `/v1/workspaces/:workspaceId` such
an agent may send writes only to:

- its tools: the first-party MCP endpoint (and its docs and files servers),
  Codemode calls and SDK proxy, and the tool gateway's calls;
- conversations: starting one (a child of its own session, so it stays
  clamped), renaming, archiving or deleting one it reaches, and working in
  one (events, steer, control, queue, composer draft, retry, context, goal,
  artifacts, files, git, terminal, background commands);
- files and content: uploads and download links, new Sites and uploads, Site Data and a Site's files (only for the Site it was
  started from), and a Site's versions, rollback, status and audience (under
  the rule above);
- reads sent as POST: Knowledge and document searches, download links, the
  Knowledge save dry run and a Connected Machine audience preview;
- feedback.

Documents, spreadsheets and presentations (`/editable-artifacts` writes, and
the first-party `editable_artifact_create`, `_import`, `_apply` and `_export` tools)
are open only when a published Site the agent was started from declares one
of those first-party tools in its current version's requested tools;
otherwise they are refused like any other write. Its other tools are the
Site's declared tools, intersected with what the person may use.

Every other write, including `PATCH` or `DELETE` on the workspace itself, a
session's agent, tools, servers, credentials, variable sets, vaults, Skills,
usage limit and admin access, tool approvals, browser and computer sessions
(which can drive the viewer's Chrome or screen), and any route family added
later, is refused with 403 before the route runs. The refusal names what it
would change ("workspace settings" when no narrower name fits). Paths are
matched percent-decoded, as the router sees them, and reading stays open.
`apps/api/test/site-agent-guard.test.ts` pins the open routes against the
registered route table. A session started from a Site page cannot get
session admin access (409), and an agent acting for a Site page cannot run
`admin_action_call`.
Published Sites start their agents as `site:<siteId>` with the publication's
own tools and limits instead (see `docs/site-runtime-api.md`): workspace
tools only for members who may use connections, never for people outside
the workspace, and the limits of the viewer's audience
(`docs/published-sites.md`, "Limits and billing").

## Agent defaults

Every published-host conversation gets this Site's `site_data_query` and
`site_data_write`; enabled SQL adds `site_sql_run`, and members also get read-only
`site_sql_query`. Calls act as the conversation's viewer and refuse other Site ids
and management operations. There is no sandbox, and publication settings offer no
sandbox opt-in. Members get no Site budget or stamped session usage limit, even
after a previous conversation; they retain normal model selection and subscriptions.
Non-members receive an explicit credit-billed model, one Site budget and an optional
per-person budget; anonymous guests additionally meet bot guards. Admission reserves
a $0.25 turn estimate by default, not the entire conversation cap; outstanding
reservations return retryable `site_budget_busy`.
The executable session ceiling is metered spend plus that funded reservation.
Further sends, steering and resumes fund a top-up before execution; a single
provider call can overshoot before metering. Data tools revalidate the current
audience on every call, independently of best-effort cancellation.

Funding admission retains a durable pending token across the gap before enqueue.
Start, Send, Steer, queued-message Steer, composer submission and Resume carry that
token through the in-process dispatch; session writer transactions lock and verify
it before accepting work. Idle settlement cannot release pending funding. A returned
refusal revokes the token and reconciles the locked canonical queue; a lost response
retains it. After ten minutes, recovery may revoke an abandoned token, but releases
funds only if the locked queue has no accepted work or physical writers. A delayed
dispatch with the revoked token cannot enqueue. Neither timeout nor an idle status
alone proves that funding can be released.

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
