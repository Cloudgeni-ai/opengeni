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
- New Site execution is private to its viewer. Console viewers and signed-in
  workspace members use native `user_private` sessions owned by their verified
  human identity. Published guests and signed-in outsiders retain the existing
  Site service execution and limits, with an immutable Site/viewer audience on
  the native session and descendants. A guest's existing cookie/visitor principal
  supplies continuity; losing it does not grant access to another visit.
- Site sessions are omitted from ordinary workspace lists, sidebar, pins,
  message search and discovery snapshots, including for their owner. Explicit
  Site history is still available through the Site's Conversations tab and
  `originSiteId` filter, only for the authorized viewer. Hiding is presentation;
  native authorization and restrictive RLS independently protect reads, events,
  files, controls and agent descendants, including direct guessed URLs.
- Disabling private sessions explicitly refuses new Site conversations. There
  is no shared fallback. Existing native privacy policy and membership checks
  remain authoritative. App code cannot choose another owner or share a session.
- Historical published-host mappings are backfilled from their exact recorded
  audience. Old console origin labels do not prove a sole viewer, so those
  shared histories are not silently converted or exposed as new private Site
  history. Existing Site HTML and source are not rewritten.

## Inline AI and app-defined interaction

`createOpenGeniSiteClient().ai` is a convenience over native session creation and
replayable events, not another execution engine. Apps choose their own prompts,
context serialization, input controls and result presentation. No visible chat
history, conversation selector, task buttons or prompt templates are required.

```ts
const site = createOpenGeniSiteClient();
const result = await site.ai.run({
  initialMessage: appDefinedPrompt,
  idempotencyKey: actionId, // retain this across retries of the same action
}, {
  onSession: rememberHandle,
  onText: appendOutput,
  signal: observationAbort.signal,
});
if (result.status === "completed") renderAppResult(result.text);
else renderWaitingOrCancelled(result.status);
```

The app may validate/parse returned text into its own result schema. Model
failure rejects; approval/input waits return `pending`, not a successful answer.
Aborting observation does not cancel execution. Use native session control when
cancellation is intended. `site.ai.result(id)` replays without creating work;
pass the retained `turnId` to resume a particular pending turn. With `after`,
output contains only the subsequent suffix, so retain earlier text; omit it to
rebuild the full answer. Retain handles only in viewer-private storage, never a
shared Site Data row. Published opaque frames have no browser local/session storage.

For an app that needs chat, use `SessionConversation` and native history. A
selector and New conversation are optional product choices. Never send the
initial prompt again after successful creation. Private conversation ownership
does not make separately published artifacts or shared Site Data private; use
their existing audience controls deliberately.

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
Published members start as their verified human identity; outsiders start as
`site:<siteId>` with an immutable viewer binding. Both use the publication's
own tools and existing authority ceilings (see `docs/site-runtime-api.md`): workspace
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

Existing published-host chats are normalized before their next admitted Send,
Steer, queued-message Steer, composer submission or Resume. The trusted host
atomically restores only this Site's viewer-bound data tools and permissions,
the artifact capability and platform instructions, selects no sandbox, and
stops inheriting workspace-default tools. It preserves only the conversation's
still-authorized connector refs. A version marker and audit event commit with
the configuration, so a failed write refuses admission and retries safely.
Already accepted in-flight execution is not rewritten. No republish is needed.

Funding admission retains a durable pending token across the gap before enqueue.
Start, Send, Steer, queued-message Steer, composer submission and Resume carry that
token through the in-process dispatch; session writer transactions lock and verify
it before accepting work. Idle settlement cannot release pending funding. A returned
refusal revokes the token and reconciles the locked canonical queue; a lost response
retains it. After ten minutes, recovery may revoke an abandoned token, but releases
funds only if the locked queue has no accepted work or physical writers. A delayed
dispatch with the revoked token cannot enqueue. Neither timeout nor an idle status
alone proves that funding can be released.

An idempotent Start replay checks the canonical `session.created` marker, not
merely whether a session row exists. A committed but uninitialized keyed shell
gets a funded repair admission and re-enters core's existing keyed Start repair.
The original prompt and model remain accepted; repair counts no extra conversation
or turn and stamps only the newly funded allowance. The initialization marker is
checked again under the admission lock so a concurrent successful repair is replayed
without reserving more money.

## Accounting and Insights

Immutable session origin stamps `site_id` on model facts and model debit ledger
entries. Workspace Insights → Site AI groups those source-stamped amounts by
Site, never guessed titles. Actual credit charges come from negative model
debits; API-equivalent amounts are frozen estimates, with subscription and own-key
estimates separate and incomplete pricing identified. They are not extra charges.
Private/unavailable Site identities are grouped anonymously. No viewer identity,
conversation ID, prompt or output is returned. Existing Insights detail readers
also apply the Site audience when their definer owner bypasses RLS.

Site platform requests, rows and storage live in Insights separately from AI
costs; their existing usage-only/shadow/credit mode remains explicit. Usage
retains limit settings. Historical console work without proven Site attribution
remains in workspace totals, not a guessed Site bucket.

## Validation

Cover origin stamping/concurrent isolation, actual MCP transport propagation,
console/published-host ownership, cross-viewer and guest denial across reads,
events/files/control, discovery/pagination/search, policy refusal, native
cancellation and exact accounting. Preview the actual Insights and limits UI
in light/dark desktop/mobile before handoff.
