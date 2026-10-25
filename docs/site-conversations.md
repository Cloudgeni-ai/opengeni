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
- Site sessions are omitted from ordinary workspace lists, message search and
  discovery snapshots, including for their owner. Explicit Site history is
  available through the Site's Conversations tab and `originSiteId` filter,
  only for the authorized viewer. Hiding is presentation; native authorization
  and restrictive RLS independently protect reads, events, files, controls and
  agent descendants, including direct guessed URLs.
- The console sidebar opts in with the session list's `siteConversations`
  option. `group` (a non-archived root page) keeps Site conversations out of
  the rows and returns `siteGroups` with its first page: one complete row per
  Site and project with the viewer's conversation count over the requested
  archive scope, latest activity and status counts, bounded to the 200 most
  recently active (`siteGroupsTruncated` marks more). Its continuation pages
  are ordinary default pages. `include` lists them as ordinary rows and is
  bound into its cursor; the sidebar uses it for search, Archived, pins and
  work a Site conversation spawned. Both use the same viewer authorization,
  so another viewer's private Site conversation is never counted, titled or
  listed, and agent callers keep their own-root bound. List hints report the
  viewer's changed Site conversations separately as `siteSessionIds`, so
  ordinary lists ignore them. A Site row is stable: its conversations stay
  nested under it, collapsed by default, whichever session is open. A Site's
  title in its row refreshes with the next list read.
- Every way into a Site opens the console's Site view
  (`/workspaces/:workspaceId/sites/:siteId`): its sidebar row, the Artifacts
  list (and its Copy link), a duplicated Site, links and notifications naming
  `/artifacts/:id` without a tab (replaced, so Back leaves the Site), and the
  Site tab of its details. The Site fills the page and a
  chat panel sits beside it with one conversation open, the newest unless
  `?conversation=<id>` chooses one. The panel doesn't list conversations (the
  Site's sidebar row does); it shows the open one as a regular chat with the
  model picker, narrower, titled in its header. It resizes from its left edge
  (drag, or the arrow keys, Home and End on the focused handle; double-click
  resets) between 320 and 720 px, leaving the Site at least 360 px where there
  is room, and hides to a strip (Enter on the handle, or its button). Width
  and hidden state are remembered per person in this browser; choosing a
  conversation shows a hidden panel again. The conversation open without a
  choice is fixed when the Site opens, so activity in another conversation
  never swaps it out. A `?conversation=` that isn't one of this Site's own
  top-level, unarchived conversations falls back to the Site. A nested row,
  and a session's Site origin link, open that view with the conversation
  selected; opening one also opens its Site row once per visit to the Site,
  and closing the row again is respected. **New** starts a conversation the
  way the Site's own chat does, sending the Site and its current version
  (`x-opengeni-site-id`, `x-opengeni-site-version`) with only the fields a
  Site may set, so it is private to the viewer and listed under the Site. It
  doesn't offer voice-first start. Once open, New stays open until a
  conversation is chosen (choosing the Site's own row again does not close
  it). The panel follows `siteSessionIds` hints, so a conversation started in
  the Site beside it becomes the newest when the Site is next opened. The
  panel's menu opens the conversation as a full chat or the Site's details
  (`/artifacts/:id?tab=settings`; Versions for people who can't manage it).
  The details page is reached by tab (`?tab=versions|conversations|data|settings`,
  Versions by default) and `/sessions/:id` keeps working. **Edit with
  Opengeni** on the details page opens the Site view with `?new=true`: a new
  conversation in the panel (shown even if it was hidden), its composer
  focused once the Site has loaded; the address then drops `?new`, so Back or
  a reload doesn't repeat it.
- The Site view edits the Site live, with today's permissions: anyone who can
  see the Site and has `artifacts:publish` can change it; visitors can't, and
  there are no drafts or approval step.
  - The conversation knows its Site. When a conversation is created from the
    panel (the request carries the Site headers without the frame marker, so
    it isn't Site code, and its caller may publish), the API attaches
    `siteConversationContext` (`@opengeni/contracts/site-session-http`) to
    its first message as server-authored `modelContext`: the Site's id,
    title and the version shown, and that a change is published as a new
    version straight away. For someone who may publish, the panel attaches
    the same context, with the version then live, to every later message
    (`sendExtras`); others get none, as from the API. It is
    ordinary model-visible context, never authority; a caller still can't
    set its own context on a Site create (403), and a published host's
    conversations get none.
  - The preview follows the Site. `useSiteLiveVersion` checks the Site when
    the open conversation's tool call returns or its turn ends
    (`SessionConversation`'s `onEvent`, which fires only for events newer
    than the history it opened with), every five seconds while the page is
    visible (versions published from anywhere else), and on focus, coming
    back online or into view; overlapping checks share one. A check reads
    only the Site and its current version (`GET
    /v1/workspaces/:workspaceId/published-artifacts/:artifactId/current`,
    `getWorkspaceArtifactCurrent` in the SDK, `artifacts:read`, without
    provenance, so it needs no session reads); the history is read again
    only when that changed. Against a server without it (404 or 405) every
    check reads the history. A Site that is gone (403 or 404) stops the timed
    checks. `SiteView` gets the current `versionId` and reloads in place when
    it changes, replacing the frame once, in the same render as its HTML,
    and keeping the version on screen until the new one has loaded; a failed
    update tries again, waiting longer each time (up to 30 seconds), and a
    hidden tab waits until it is shown. The frame's label says what is true
    (`ArtifactSandbox` `liveState`): **Live**, **Updating** while a new
    version loads, or **Reconnecting** when a check or update failed (the
    version shown stays); on a narrow screen only its dot shows, and it is
    still announced. On a Site published to the web, the header's link to
    the published Site stands in for **Live**, and **Updating** or
    **Reconnecting** shows beside it.
  - The version chip in the Site's header (`SiteVersionMenu`) shows the live
    version and its recent history (eight, then **All versions** on the
    details page). **Undo last change** restores the version that was live
    before the change that made the current one live (a publish or a
    restore, so a second Undo goes forward again and reads **Undo
    restore**), else the revision before;
    **Restore** on any listed version does the same. Both use the existing
    rollback with `expectedCurrentVersionId`, so a version published
    meanwhile wins and the chip says "The Site changed meanwhile". People
    without publish permission, and archived Sites, get the history only.
    In full screen its menu opens inside the full-screen frame. An archived
    Site's view links to its details, where it can be restored.
- A Site is a sidebar row even before anyone asks it anything. Placement has
  one rule: a Site is a top-level row in the project of the chat that created
  it (the session tree of its first version), and new Site conversations are
  filed in that project too, so the Site and its conversations stay together.
  A create that names no project (omitted or `null`) files the conversation
  with its Site; only a named project overrides that. Starting or moving
  conversations never takes a Site out of its own project.
  It is a row of its own rather than a child of that chat because a chat's
  children in the sidebar are the work it spawned, and a Site outlives and is
  used apart from its chat. The row is listed when the viewer lists that chat
  (respecting its archive state and filters) or, with no filter or search
  applied, has opened the Site, and only for a Site in the viewer's audience;
  other artifacts never get rows. Opening the Site view (`/sites/:id`) in the
  console (`POST
  /v1/workspaces/:workspaceId/published-artifacts/:artifactId/opened`,
  `recordSiteOpened` in the SDK, `artifacts:read`) records this person's
  latest open, which only lists the Site. A row's activity is the latest of
  its conversations, its newest published version (creation is the first)
  and the chats that published its versions (the one that created it and any
  used to edit it), as far as the viewer can see them. So Sites in use rise
  and untouched ones sort down like old sessions, without being hidden.
  Opening a Site is not activity, just as opening a chat is not. Archiving,
  restoring, rolling back or any other write to the Site's record is not
  activity either. Opens are personal and never visible to anyone
  else; a Site page cannot record one. The console records one open per page
  (router history entry) that shows the Site view: not again when its client
  is replaced, only once a page that loaded hidden is shown, and not again
  when a reload, a restored tab or going Back shows a page where this tab
  already recorded it (remembered in `sessionStorage` after the write
  succeeds). Pages the open Site view moves to, such as choosing a
  conversation, belong to the same open. Without a router history key, every
  visit counts. Without
  conversations a row has no count and nothing to disclose; it opens the
  Site view. Conversations someone moved to another project nest under a row
  for the Site in that project, and the Site keeps its row in its own one.
- Every sidebar row has Pin and Archive one click away (hover or keyboard
  focus shows them over the row's time; right-click and the touch overflow
  menu offer them too). For a Site row both are personal sidebar state
  (`site_sidebar_states`, `PUT
  /v1/workspaces/:workspaceId/published-artifacts/:artifactId/sidebar`,
  `updateSiteSidebarState` in the SDK, `artifacts:read`, refused on a Site
  origin) and never change the Site or anyone else's sidebar. Pin moves the
  row, with its conversations, into Pinned, once across projects. Archive
  hides the row and its conversations from this person's sidebar only; the
  Site stays published and others still see it. Undo, or opening the Site
  again, restores it; a pin is kept. Archived Sites are not listed under the
  Archived filter. Archive on a spawned chat's row archives its workstream,
  since archive belongs to the top-level chat.
- Disabling private sessions explicitly refuses new Site conversations. There
  is no shared fallback. Existing native privacy policy and membership checks
  remain authoritative. App code cannot choose another owner or share a session.
- Historical published-host mappings are backfilled from their exact recorded
  audience. Old console origin labels do not prove a sole viewer, so those
  shared histories are not silently converted or exposed as new private Site
  history. Existing Site HTML and source are not rewritten.

## Allowing an existing chat in a private console Site

In the console's Site **Conversations** tab, the owner can choose **Allow an
existing chat**. This grants that private Site access to one exact chat owned
by the same person. It does not share the chat with other viewers, move it,
change its tools, rewrite its creation origin, or grant access to descendants.
Making the Site shared or archiving it disables this extra access. Existing
Site-created conversations retain their original audience rules.

Owner-authorized agents can use the normal SDK's `setSiteSessionAccess` and
`listSiteSessionAccess` with normal owner authority, regardless of turn surface.
Site page code cannot manage these grants. Published guest/runtime Sites do not consume them.

Inside the console Site, use `listSessionPage(workspaceId, { siteAccessId:
"current" })` to list available chats, then mount the normal
`SessionConversation` with the chosen session ID. `originSiteId` still means
creation provenance and does not include explicitly allowed older chats.
Both list filters remain viewer-authorized and bound into pagination cursors.

The Site retains the same operation and text-only body restrictions; approvals,
credentials, attachments and hidden model context still belong in the console.
Site-submitted turns record their real Site origin and retain the chat's normal
execution authority, identical to console turns.
**Remove access** revokes subsequent reads and writes immediately; an open event
stream rechecks every two seconds and closes on revocation. Already accepted
work is not cancelled and already delivered text cannot be recalled.

Management routes are `GET /v1/workspaces/:workspaceId/published-artifacts/:siteId/session-access`
and `PUT`/`DELETE` on its `/:sessionId` suffix. They are deliberately absent from
the frame operation allowlist. Migration `0842_site_session_access.sql` adds
the tenant/owner-isolated grant table without backfilling or modifying sessions.

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

The injected browser client is the checked-in
`packages/sdk/src/site-browser-runtime.gen.ts`, built from the SDK and shared
Site route contracts. After changing either dependency, use the repository's
pinned Bun to run `bun scripts/generate-site-browser-runtime.ts` and commit its
output. `bun scripts/generate-site-browser-runtime.ts --check` verifies freshness
without rewriting it; CI runs this before package builds, which otherwise
regenerate the file and can hide stale committed bytes. The generated-runtime
SDK tests execute those bytes through the real host bridge and preview transport;
the Site conversations browser test also executes the injected script tag.

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

A Site-created chat uses ordinary workspace defaults: tools, capabilities,
vault policy, compute, memory and agent reach. Explicit restrictions use ordinary
host-owned chat settings, never fields controlled by the page. Create fields
remain host-owned; see `SITE_FRAME_SESSION_CREATE_FIELDS`. Origin metadata
remains server-authored. A page cannot replace identity, hidden instructions,
vault policy or tool permissions through a nested agent configuration.

An existing chat has identical tools and authority whether a turn comes from
the console or a Site. There is no Site agent clamp, ancestor walk, special
write allowlist, artifact creation-tree exception or admin-access refusal.
Normal owner access, per-tool permissions, accepted authority and approvals
still apply. Revoking a Site/chat grant prevents further page requests; it
does not retroactively rewrite an accepted turn's authority.

## Agent defaults

Published workspace members dispatch as their verified, live member identity
with ordinary chat defaults. The publication's optional author instructions
remain explicit; no platform restrictions are prepended. The historical
`agent.tools` publication field does not narrow member chats or cancel them
when edited. Direct page tool declarations remain enforced separately.

Visitors outside the workspace still use the `site:<siteId>` service identity,
with viewer-bound data tools, no workspace tools or sandbox, and funded usage
limits. This is their actual authority, not a member downgrade. Current
audience is rechecked on every data-tool call. Guest continuations normalize
their legacy service profile atomically through `site-publishing/agent-session.ts`.

No migration rewrites stored member settings or previously accepted work.
Older chats keep their explicit saved selections, editable normally in the
console, but no longer encounter computed Site-origin refusals. New member
chats inherit normal defaults, including normal sandbox costs and approval
pauses. Approvals still require the console.

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

### Staging acceptance (release-coordinator owned)

These migrations require a maintenance cutover: drain old API and worker writers,
apply the reviewed release's migrations and role provisioning, then start the
matching source. Do not run old Site writers against the new audience schema.
The backfill only binds historical published conversations with an existing
viewer mapping; existing Site source, titles and historical console chats are
not rewritten. This recipe does not authorize a deployment.

Run the deterministic source checks against an isolated PostgreSQL fixture first:

```sh
OPENGENI_REQUIRE_REAL_DB=1 bun test --max-concurrency=4 \
  packages/db/test/migration-0793-private-site-sessions.test.ts \
  apps/api/test/site-frame-boundary-postgres.test.ts \
  apps/api/test/published-sites-postgres.test.ts
bun test packages/sdk/test/site-ai.test.ts apps/api/test/sse-stream-bounds.test.ts
bun scripts/public-api/check.ts
OPENGENI_REQUIRE_REAL_DB=1 bun scripts/public-api/sdk-compat.ts
```

Use the repository's pinned Bun/Node and an explicitly configured
`OPENGENI_TEST_PG_URL`; do not point test fixtures at the staging application
database. After the coordinator deploys the exact reviewed source:

1. Create a disposable Site and two ordinary test members. Open both the console
   iframe and its published host as each member. Start one optional chat and one
   `client.ai.run({ initialMessage: appPrompt, idempotencyKey })` action. The app
   renders its own streamed/final output; no chat component is required. Verify
   retrying the same key does not create another session.
2. Verify the signed-in creator/owner is the real member, not the Site author or
   a service identity. Verify each action is absent from ordinary workspace
   session lists, sidebar, message search and pins. An explicit Site-origin list
   may return only work the requesting viewer is allowed to see.
3. Try the other viewer's known ID through detail, events, live stream, queue,
   turns, file-list/download and control/send paths. Expect refusal, including
   for workspace administrators. Repeat with two independent guest cookie jars;
   a guest's current jar may reconnect, the second must not. Do not inspect or
   publish private prompts in the acceptance record.
4. In the disposable organization, disable private sessions and verify explicit
   creation refusal, not shared fallback. Restore the setting. Revoke one test
   member or unpublish the disposable Site; verify the published host refuses
   further admission/stream delivery and native cancellation stops existing work.
5. Exercise a small deterministic pending/approval fixture, cancellation, failure,
   reconnect and observation abort. Pending is not success; observation abort is
   not execution cancellation. Existing tool selection, approvals and model
   eligibility remain authoritative. Use mocked providers for automated coverage;
   no load test or paid model probe is necessary for this source acceptance.
6. Check a member's ordinary model/subscription eligibility and an outsider's
   credit-only model and Site/per-person caps. In Insights compare source-stamped
   Site actual charges to model-debit ledger totals, separately from frozen
   API-equivalent/subscription/own-key estimates. Private/unavailable Site names
   must aggregate anonymously, with no session/viewer/prompt fields. Platform
   requests/rows/storage appear separately with their billing mode. Usage shows
   limit settings, not those analytics.
7. Inspect actual Insights and Usage in light/dark at desktop and mobile widths.
   Record the deployed source SHA, test outcomes and any limitations, then remove
   only the disposable test Site/accounts and restore settings changed above.
