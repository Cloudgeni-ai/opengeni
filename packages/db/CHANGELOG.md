# @opengeni/db

## 6.22.0

### Patch Changes

- 1f25da5: Approval run states are checked against their size limits in one linear pass in the worker before any database work, on save and on read. The database no longer counts their JSON nodes with `jsonb_path_query`, which took quadratic time: a run state with a few hundred thousand array elements cost seconds to minutes of database CPU, partly while the session row was locked.
- 6597d38: The Console sessions list loads again for organizations with many sessions: each page's per-session cost is now one lookup by the credit ledger's idempotency index instead of a full ledger scan per session, which exceeded the Console's 20 s query limit. Spend per organization key also reads the ledger once instead of once per managed workspace. Totals are unchanged.
- c36183c: Disconnecting a Google account (Gmail, Drive, Calendar or a Google integration) now ends Opengeni's access at Google too: the disconnected connection no longer keeps any Google tokens, and the grant is revoked with Google once the disconnect is saved. Google revokes a grant for every connection of that Google account, so while another of your connections of the same account is still connected, the grant stays at Google and only the disconnected connection's tokens are deleted. When Google can't be reached, the stored tokens are still deleted. Other services disconnect as before.

  `revokeConnection` accepts `replacementCredentialEncrypted` to replace the stored credential in the same write.

- 0d72a8b: Count the JSON nodes and object properties of session history items in linear time. The counts previously came from row-producing `jsonb_path_query('strict $.**')` scans, which Postgres serves in quadratic time for large items; they now come from `jsonb_path_query_array` with the same results and the same history limits.
- 07ecbcc: Skills whose SKILL.md description is a multi-line YAML block install again: the installed Skill's summary folds line breaks into spaces, and any remaining invalid Skill metadata returns a 422 instead of a server error. Chat titles now work on chat-API routes that report unset usage counters as null, and a failed title logs a content-free reason (the failing stage, error name and provider status or code).
- c105ed2: Microsoft Teams feedback (thumbs up or down) on replies in routed 1:1 chats, including Personal and other non-home workspaces, and in chats with agents anyone in the organization may use, is now recorded instead of being refused as `feedback_not_permitted`. It is authorized like the chat itself: the reacting person must be the linked owner of that chat, with live organization membership and access to its workspace (organization-agent chats record as `teams-agent:<agentId>` while the agent is still open to them). `TeamsDeliveredReply` adds the chat's `workspace_id`, `actor_id` and `agent_id`. Linking a Teams account with workspace routing now also refuses an agent acting for the person; only the person signed in to Opengeni themselves can link.
- Updated dependencies [d50092b]
- Updated dependencies [07ecbcc]
  - @opengeni/contracts@6.22.0
  - @opengeni/observability@6.22.0
  - @opengeni/codemode@6.22.0
  - @opengeni/codex@6.22.0
  - @opengeni/config@6.22.0
  - @opengeni/network@6.22.0
  - @opengeni/subscriptions@6.22.0
  - @opengeni/xai-subscription@6.22.0

## 6.21.0

### Minor Changes

- 92396d0: A stopped Modal or Docker sandbox is forgotten a day after every chat that works in it is archived, as a compute sandbox is.

  - Its saved workspace goes with it, and the checkpoint GC deletes the Modal snapshot it named, which had no expiry. Before, it was kept until the chats were deleted.
  - The same rule as for compute: a chat restored within a day keeps its sandbox, one stored automatically after weeks unused loses it at once, and a sandbox shared by several chats stays while any of them is live. A chat restored later continues on a new sandbox and is told the old files are gone.
  - New definer `opengeni_private.cold_sandboxes_of_archived_chats_v1` (migration 1404), withheld from the runtime for one release; until a later migration grants it nothing changes.

### Patch Changes

- 7d0d52b: Dynamics 365 Finance and Operations now works in every Microsoft Dynamics connection without a flag. Its tools run on the environment's OData data entities with the person's own sign-in, so customers no longer add Opengeni to **Allowed MCP clients** and calls don't use Copilot Credits. Agents list and describe data entities, query one company or all of them (with counts), and create, update and delete records; changes ask first. `OPENGENI_MICROSOFT_DYNAMICS_FINANCE_OPERATIONS_ENABLED` is removed and ignored if still set.

  Existing Finance and Operations connections switch from the ERP MCP server's tools to the `fno_*` tools, so tool permissions saved under the old tool names no longer apply; set them again on the new tools. Tenants that consented before the app requested **Access Dynamics AX data** (`Odata.FullAccess`) need an administrator to consent again.

- 3a1bc06: The retained-process reconciler no longer fails a whole pass when a process in another workspace becomes due while it takes its workspace fences.

  - Migration 1405 makes `opengeni_private.claim_terminal_retained_processes` take the fences itself and claim only rows in the workspaces it fenced. A row that became due in between is left for the next pass.
  - Before, on databases whose migration role bypasses row security (for example a superuser), such a row reached the claim's update and the session-tenancy fence trigger rejected it with SQLSTATE 55000, failing the reconcile pass.
  - Same signatures, owner and grants; no runtime change is needed.

- Updated dependencies [7d0d52b]
- Updated dependencies [ef4c334]
- Updated dependencies [ce864c0]
- Updated dependencies [6ac2cd4]
- Updated dependencies [6acbb24]
  - @opengeni/config@6.21.0
  - @opengeni/contracts@6.21.0
  - @opengeni/codemode@6.21.0
  - @opengeni/codex@6.21.0
  - @opengeni/observability@6.21.0
  - @opengeni/network@6.21.0
  - @opengeni/subscriptions@6.21.0
  - @opengeni/xai-subscription@6.21.0

## 6.20.1

### Patch Changes

- @opengeni/codemode@6.20.1
- @opengeni/codex@6.20.1
- @opengeni/config@6.20.1
- @opengeni/contracts@6.20.1
- @opengeni/network@6.20.1
- @opengeni/observability@6.20.1
- @opengeni/subscriptions@6.20.1
- @opengeni/xai-subscription@6.20.1

## 6.20.0

### Minor Changes

- e37485b: An organization's Anthropic API connection can hold several API keys, for example one per Anthropic organization whose credits it uses. The connection's own key stays the first, so an organization with one key works exactly as before, and model ids stay `organization-anthropic/…`. Admins add, rename and remove keys under Models on the Anthropic API page; each new key is checked with Anthropic's free model listing first, stored encrypted and never shown again.

  Each chat keeps one key, so its prompt cache stays warm, and moves to another key only when Anthropic refuses its key for lack of credits. A refused key is marked **Out of credits** and left out until an admin chooses **Serve again**; when every key is out of credits, the request fails without being sent. Rate limits keep their usual handling. Claude subscription models never use these keys, and nothing buys credits or enables top-ups.

  New routes under `/v1/organizations/:organizationId/model-providers/anthropic/api-keys`; the SDK calls them with `listOrganizationAnthropicApiKeys`, `addOrganizationAnthropicApiKey`, `updateOrganizationAnthropicApiKey`, `removeOrganizationAnthropicApiKey` and `serveOrganizationAnthropicApiKeyAgain`.

- 2a207b4: Microsoft Teams (with workspace routing) now serves agents whose Who can use it is `Anyone in <organization>` to full members of the connected Teams tenant who aren't in the agent's workspace, with Slack's open-agent rules: 1:1 chats only, never guests (Teams' `getMemberById` must say `userRole` "user" in the connected tenant), live organization membership at enqueue, admission and delivery, and a one-time notice that the workspace's members can see the chat, which runs as the agent's read-only service principal `teams-agent:<agentId>`. A one-off `in <Workspace>: …` message continues the person's chat there and its replies start with a `**Workspace**` header.

  - Stored Teams chat choices and switch-card options must name a shared agent of the named workspace (`teams_route_target_invalid`); a card needs the person's live link (`teams_link_missing`) and holds at most 100 options (`TEAMS_ROUTE_PROMPT_MAX_OPTIONS`); a reach change committed during an enqueue's access check refuses it (`teams_reach_changed`).
  - Breaking for direct `@opengeni/db` users: `clearTeamsChatChoice` takes `{ actorId, subjectId }` and clears only that person's choice. `listTeamsAgentDirectory` accepts `preferWorkspaceIds`, returns `organizationAccess` and reads up to 1,000 agents. New: `getTeamsAgentInWorkspace`, `getTeamsTurnRouting`, `teamsOrganizationAgentSubjectId`, `teamsOrganizationAgentIdFromSubject`, `TEAMS_ORGANIZATION_AGENT_ROUTE_PREFIX`, `AGENT_ORGANIZATION_ACCESS_SQL`.

- 9c17a87: `tool_search` now shows an integration's Connect card itself when a search clearly names one integration the person can connect (exactly one named, by a distinctive mention such as "on Slack", "ClickUp" or "Airtabel"), instead of relying on the agent to call `capability_authorization_request` next. It posts the card through that same tool when the search call is accepted, with the same authorization, tool selection and policy, and does not post it again until the person writes (a first-connection card never stands in for a reconnect card); the search result then says the card is shown. Model calls of the tool are unchanged. Searches naming several integrations, an installed one, or a name used as an ordinary word keep today's notice, as does any search where the card tool answers without a card; when the card call fails or times out, the notice no longer says whether a card was shown.

  Whether a card is in the chat is now stated in every result: `tool_search` results that name a connectable integration carry `connectCard` (`shown`, and when shown its `capabilityId`, `eventId` and `alreadyShown`), and every `capability_authorization_request` result carries `cardShown` (and `alreadyShown` for a repeat from search). `@opengeni/contracts` exports `TOOL_DISCOVERY_CARD_META_KEY`, the request `_meta` key that marks a card request from tool discovery, and `@opengeni/db`'s `appendTurnCapabilityCardOnce` takes an optional `{ sinceLatestMessage }` to reuse a card any turn shows since the person's latest message (only this turn's when no person has written), and now reuses only a card of the same kind (a first connection, or a reconnect of the same connection).

### Patch Changes

- ae3972e: The Microsoft Dynamics connection now supports Dynamics 365 Business Central. Paste the Business Central web client address (`https://businesscentral.dynamics.com/<tenant>/<environment>?company=…`) and sign in; one connection covers every company in the environment. Agents list companies and entities, query with OData, create, update and delete records and run actions such as posting, through the Business Central API (v2.0) as the signed-in user. Changes ask first by default.
- 0e273b0: Opengeni Console can run as its own platform on a `console.*` or `*.console.*` host (console.opengeni.ai, staging.console.opengeni.ai). There, every page stays in Console: Console's own sign-in, Members, Usage and billing and the organization name inside Console, an account menu with Sign out, and no links into the app. Verification emails, invitation links, Google sign-in returns and Stripe returns open on the allowed host the request came from (`OPENGENI_BETTER_AUTH_ALLOWED_HOSTS`).

  New optional `OPENGENI_BETTER_AUTH_COOKIE_PREFIX` renames the auth cookies (for example to keep staging apart from production on a shared parent domain). Unset keeps the current cookie names, so existing sessions stay signed in.

  Console usage by model now reports calls and input, output and cached tokens from the credit ledger instead of zeros. GitHub sign-in is hidden on the Console host.

- cf65a72: Fix several failures seen in production:

  - An attached file whose name merely contains two dots (such as `notes..txt`) no longer fails the turn. Sandbox file names still refuse empty, `.`, `..`, path separators and NUL, and uploads name a bare `.` or `..` `file`.
  - A completed video from an Only-me chat is delivered to the chat. The reconciliation service read the result as a service actor that could not see the private chat, so the operation retried forever with "Completed video generation lost its retained artifact".
  - Checking a session's work while the session is being deleted reports it idle instead of failing the activity with `SessionControlInvariantError`.
  - A chat deleted while its title is generated ends the title operation quietly instead of warning "Independent session title failed".
  - A caller that disconnects from `POST /v1/workspaces/:workspaceId/tools/{resolve,invoke,target-approvals,manifest}` gets the client-gone 499 (empty body) instead of a 500, counted as `aborted` in `opengeni_tool_target_operations_total`.
  - A request that reads a session deleted while it runs no longer fails with a 500 "Session … does not exist in its workspace". A request that names that session (for example `GET /v1/workspaces/:workspaceId/machines?sessionId=…`) answers 404 "session not found"; any other request, such as a list whose page included it, answers 409 (retryable only for reads). The missing-session case of `SessionControlInvariantError` is now the `SessionMissingFromWorkspaceError` subclass.
  - The web app picks its root providers from the rendered route rather than the pending location, so navigating to Security settings or phone sign-in no longer shows "Opengeni app context is not ready".
  - Temporal "Activity failed" / "Workflow failed" logs add `failureMessageHash` (a hash of the explaining cause's message with identifiers, numbers and quoted values removed) and, for code-authored invariant errors, that template as `failureMessage`.

- Updated dependencies [ae3972e]
- Updated dependencies [0e273b0]
- Updated dependencies [52ef65b]
- Updated dependencies [e37485b]
- Updated dependencies [cf65a72]
- Updated dependencies [6c10a4d]
- Updated dependencies [9c17a87]
  - @opengeni/contracts@6.20.0
  - @opengeni/config@6.20.0
  - @opengeni/observability@6.20.0
  - @opengeni/codex@6.20.0
  - @opengeni/codemode@6.20.0
  - @opengeni/network@6.20.0
  - @opengeni/subscriptions@6.20.0
  - @opengeni/xai-subscription@6.20.0

## 6.19.0

### Patch Changes

- 227650c: A Connected Machine update the server stops hearing about no longer stays stuck. An update outlives the connection its request arrived on, since each connection lasts only as long as its five-minute broker credential, but the agent sent its progress through that connection, so progress after it closed could be lost: a failed or still-waiting update could read as `waiting_for_idle` with no blockers for good, on the release promoted back then, and the server never asked again because an accepted update was the agent's to finish. The agent now reports update progress through its current connection. The server treats an unfinished update it has not heard about for 30 minutes (an unanswered request after 10) as lost, and the next heartbeat, or Update now, replaces it with a request for the release promoted now. An agent still carrying the old update refuses it as busy updating and is asked again later. `beginEnrollmentAgentUpdate` takes an optional `replaceUnfinishedBefore` for this.
- 973329a: Chats that share one sandbox (a parent and its workers) now each keep their own personal GitHub pass, broker routes and `gh` setup, so Git and `gh` in one chat no longer fail with "authorization is no longer current" after another chat on the box ran. The repository remote stays `https://github.com/<owner>/<repo>`, no token enters the sandbox, renewal updates only its own chat, and chat directories unused for a day are removed.

  A personal repository resource that also carries stray GitHub App fields is accepted with those fields ignored (access is still checked as the person), and a request without a running agent attempt now says so instead of asking to reconnect GitHub.

  Repairing an uninstalled GitHub App installation while GitHub can't be reached now says "GitHub couldn't be reached" with **Check again** (the API answers 503 `provider_unreachable`) instead of opening the account chooser. When a reinstall replaces the old installation, its approval choices move to the new one with their original setter, and the old installation's rows are removed.

- 7c378ac: Session event pages stay fast on PostgreSQL 16.16, 17.12 and 18.7. On those releases the planner can scan the payload before joining the ordered ID list, so the byte-sized page prefix rescanned the whole session at every step instead of looking up the next event by ID; large pages slowed down quadratically. The next ID is now read through a subquery, which keeps it an index lookup on every PostgreSQL version.
- 1b6b22f: No behaviour change. The session event page sizing query now documents the actual PostgreSQL cause of the November 2026 slowdown (the CVE-2026-116327 leakproofness rule under row-level security), and its plan test also fails if any recursive step filters rows out of a scan.
- 226fe73: A durable Send that gets no definitive answer (the connection drops, or Opengeni is updating) now keeps its message as the draft, so it survives closing the page and shows on the person's other devices, as it did when every Send saved the draft first. Before, a message typed and sent within the autosave pause was in no draft, and closing the tab before the send went through lost it. The draft is written only while it is still at the revision the Send went ahead from, so it never brings back a message the server already accepted and never writes over another device's newer draft. When the Send lands later, the server clears a draft holding exactly what it sent.

  An accepted Send now always moves the draft past the revision it went ahead from, also when nothing was ever saved: it creates an empty draft at revision 1 instead of leaving none.

- Updated dependencies [a85adef]
  - @opengeni/contracts@6.19.0
  - @opengeni/codemode@6.19.0
  - @opengeni/codex@6.19.0
  - @opengeni/config@6.19.0
  - @opengeni/observability@6.19.0
  - @opengeni/network@6.19.0
  - @opengeni/subscriptions@6.19.0
  - @opengeni/xai-subscription@6.19.0

## 6.18.0

### Minor Changes

- f313a0e: An agent's Who can use it has a third choice, `Anyone in <organization>`: a shared agent that full members of its organization may also use from chat integrations, not only its workspace's members. It replaces Slack's per-Slack-workspace option that let linked organization members use an agent, so the agent decides it once and every chat integration follows it. Slack does today, and Teams will read the same setting through the integration-neutral check in `apps/api/src/integrations/organization-agents.ts`.

  - `visibility` on agents (requests and responses) accepts and returns `"organization"` alongside `"private"` and `"workspace"`. Choosing it needs an organization admin (403 otherwise); narrowing it back doesn't. Only me clears it.
  - Slack's safety checks for these agents are unchanged: the person must be a full member of the connected Slack team, in a conversation only that team can see, with a linked Slack account, and an active, full member of the organization, read live on every message. They are told once that the agent's workspace can see the chat, and the chat runs as the agent's read-only service principal.
  - The agent page's Slack section no longer has its own open switch. `AgentSlackAvailability.open` still says whether linked organization members can use the agent there, and `PUT …/slack/:connectionId` with `open` still works: it changes the agent's Who can use it, in every Slack workspace.
  - Migration 1379 adds `agents.organization_access` (default false; rolling). Every write keeps `agent_slack_installs.open` equal to it, and while an agent is in Slack it is open only if every installation is (the column decides only for an agent in no Slack installation), so the previous release behaves the same during the rollout and a change it makes holds, also after a rollback: closing the agent in one Slack workspace closes it everywhere. The one visible effect: if a server on the previous release adds an organization agent to another Slack workspace during the rollout, the agent closes to the organization until an organization admin chooses Anyone in again (the safe direction). A later contract step backfills the column from `open` and stops reading `open`.

  Agents contract (migrations 1380 to 1399): a shared agent is available in every linked Slack workspace at once. The temporary one-Slack-workspace-per-agent limit is gone, with the agent page's Move here; the `agent_slack_single_install` error code is deprecated and never returned, and `putAgentSlackInstall` no longer takes `moveFromOther`. `listAgentsMissingFromSlack` now takes the installation's `connectionId` and lists the shared agents not yet in that installation.

  - The Slack records that pointed at `slack_agents` (channel routes, interactions, user states, proposals, intro posts, suggestions) now reference the agent's installation in `agent_slack_installs`, with the same delete behaviour, and `agent_slack_installs.install_workspace_id` records the installation's own workspace. Before the new keys are validated, migration 1389 cleans up rows that would fail them the way each key's delete rule would (chats and proposals are unlinked and kept; the rest are deleted) and logs the count per table.
  - Nothing writes `bot_templates` or `slack_agents` any more (an agent's leftover `slack_agents` row is deleted when the agent is renamed, made Only me or removed) and the legacy sync triggers are dropped.
  - The legacy Slack agents API shows an agent once per installation with the agent's own `version`. Its item routes take an optional `connectionId` query parameter (SDK: the `SlackAgentInstallationOptions` argument); channels and intros of an agent in several installations need it (`slack_agent_installation_required`) unless exactly one of them belongs to the path workspace. Open use and deleting act on the agent itself, as before.
  - Breaking for direct `@opengeni/db` users: removed the legacy bot template functions (`listBotTemplates`, `getBotTemplate`, `createBotTemplate`, `updateBotTemplate`, `deleteBotTemplate`, `BotTemplateRecord`, `BotTemplateLimitError`) and `lockAgentLegacySlackVersion`; `legacySlackAgentAvatar` is now `agentSlackAvatar`. Use the agents data layer.
  - Upgrade requirement for self-hosted and embedded deployments: upgrade from a release that contains the agents API switch (#7274) and apply this release only when no running binary is older. Rolling back past that release afterwards is not safe.
  - Accepted rollout effects while the previous release still serves (or after a rollback to it), for an agent in a second Slack workspace: a route card's agent pick there answers "That agent no longer exists", the legacy Slack agents item routes answer 404 for it, and the previous release's Move here (if it has one) deletes the other Slack workspace's channel settings, which this release then adds back empty. All fail closed and end when this release serves again.

### Patch Changes

- 9188c1d: Claude accounts now show whether paid usage credits ("extra usage") are on. The usage read takes the account's usage-credits setting from the reset programs' `event_props.extra_usage_state` (`enabled`, `disabled`, `not_configured`) and keeps the `extra_usage` object when Claude sends it (whether the credits can pay right now, and the month's cap and spend in cents). Before, the usage-credits state came only from `extra_usage`, which reads that skip spend reporting always answer with `null`, so an account with usage credits switched on showed as having none. `ClaudeExtraUsage` gains `state`, and `claudeUsageCreditsState()` gives `on`, `off` or `unknown`: a missing or unrecognized report is unknown, never off. The pooled usage response gains `usageCredits` (Claude only), each pooled account's state. Account rows carry a "Usage credits on" chip, the account page says whether usage credits are on, off or not reported, and the pooled-limits card and the organization's Claude heading name or count the accounts that have them on. This is read and display only: Opengeni never turns usage credits on, buys credits or changes auto-reload.
- 3bc721a: A chat waiting for Codex subscription capacity now waits honestly and wakes on real capacity. Before a waiting turn is judged, the waiter re-reads both usage and every account's live model list, so it judges the same pool the resumed turn will be placed on: it no longer resumes a turn only to have it park again a second later, and the expected time it names is the reset of an account that actually offers the turn's model (and latency tier), or no time at all when none is known. A waiting turn no longer fails after ten resumptions with text only an operator could act on; it keeps waiting, with the existing backoff between resumptions. The chat and the inbox notification now say the message will be answered as soon as there is room, and that switching to another model continues sooner.
- d83e5f2: The agent now continues on its own after a person connects a server the agent asked to add (`custom_mcp_setup_request`, including Microsoft Dynamics environments), as it already does for catalog connect cards. That card is posted before the capability exists, so the continuation now also finds it by the capability's MCP endpoint.
- d83e5f2: Two workspaces can now add the same Microsoft Dynamics environment. A workspace's Dynamics entry no longer stores its address in the catalog's `mcp_url` column, which is unique across workspaces, so adding an environment another workspace already uses no longer fails with an internal error. Reads still return the address as `mcpUrl`.
- 3d2f6ed: Archiving a Knowledge collection now also archives what is only inside it: its sub-collections and the entries that no other live collection holds or live entry cites. Before, they stayed in use and moved to the top of Collections, so archived collections seemed to come back. Undo, or restoring the collection, brings back everything archived with it. Entries that are also in another live collection or cited from outside it, entries you can't change, and anything archived separately keep their state.
- 35a2a06: Continuation turns (goal continuations, finished waits and background commands, child results) now take the learning modes their chat accepted most recently, instead of the modes of the turn that originally caused them. Before, a chain of continuations could carry settings from days earlier while turns started by a person or a schedule used the current settings, so a chat alternated between old and new modes after a settings change and re-sent its full governance block on every alternation. A chain with no later turn in the chat keeps exactly the policy it was accepted under, explicit chat overrides still win, scheduled-run provenance still follows the cause, and a child's first turn still inherits from its parent turn.
- f318955: The denied network rule (`denied-network-v1`) now also matches a new owner's sign-ins after organization setup. Farms set up from a fresh address and sign in from a denied network a minute later; that sign-in was never recorded, so the account kept its Free credit. Each evaluation within seven days of setup now records the owner's newer sign-ins first (one indexed look-up; writes only when there is a newer sign-in) and then matches as before. Exact networks only, owners only, keyed hashes only, manual decisions and operator releases kept, and failures fail open.
- Updated dependencies [f313a0e]
- Updated dependencies [6813960]
- Updated dependencies [9188c1d]
- Updated dependencies [3105a8b]
- Updated dependencies [ea2f259]
- Updated dependencies [a16189c]
- Updated dependencies [89cf4ba]
- Updated dependencies [917393e]
  - @opengeni/contracts@6.18.0
  - @opengeni/config@6.18.0
  - @opengeni/observability@6.18.0
  - @opengeni/network@6.18.0
  - @opengeni/codemode@6.18.0
  - @opengeni/codex@6.18.0
  - @opengeni/xai-subscription@6.18.0
  - @opengeni/subscriptions@6.18.0

## 6.17.0

### Minor Changes

- 43aa19d: An agent shared with its workspace now works in every Slack workspace linked to that workspace, with no separate step to make it available there. It doesn't matter where it was made: the app, a chat, a chat started in Slack (`bot_template_save` or `slack_agent_propose`) or the API. People call it by name (`@Opengeni <Name> …`), and who can use it is still decided only by Who can use it and, per Slack workspace, the existing option that lets linked organization members use it. Someone who calls an agent they can't use is told why.

  Existing shared agents and bot templates join their linked Slack workspaces the first time Opengeni reads that Slack workspace's agents, or when any agent of the organization is created, renamed or shared, so a new agent never takes an older agent's name. The oldest agent keeps a name when two share it. Agents in personal workspaces stay in the app. There is no schema migration: availability still uses `agent_slack_installs` and the legacy `slack_agents` rows, which older releases read as switched on.

  - Creating or renaming a shared agent whose name another agent already uses in a linked Slack workspace, or that Slack can't use, is refused with `agent_slack_name_taken` (409) or `agent_slack_name_invalid` (422), from the API, the app's form and `bot_template_save`.
  - `bot_template_save` returns a `slack` field saying how people ask the new agent in each linked Slack workspace, and its description asks the agent to tell the person.
  - Making an agent Only me is no longer refused: it leaves Slack, along with its channel settings and intros. The form says so.
  - `AgentSlackInstall.unavailable` says why an agent isn't available in a linked Slack workspace (for example Only me, a name clash, or the current one-Slack-workspace limit). The agent page shows how to call it, or that reason, per Slack workspace; the on/off switch is gone. The open option and Introduce remain.
  - `DELETE /v1/workspaces/:workspaceId/agents/:agentId/slack/:connectionId` answers 409 `agent_slack_always_available`. Make the agent Only me to take it out of Slack. The Agents API has not been in a production release or a published SDK yet, so no existing integration relied on the old answer.
  - Any member who can start chats can now make an agent people call by name in Slack, in every linked Slack workspace, including Slack apps the organization shares. Before, turning an agent on in Slack needed a workspace admin. Opening it to linked organization members still needs an organization admin.
  - While an agent is in one Slack workspace at a time, it goes to its own workspace's Slack app first, then those its organization shares, each by Slack workspace name. `PUT …/slack/:connectionId` on another linked Slack workspace moves it there in one step, so it is never in neither (the page's Move here, which says what it drops): open use turns off and its channel settings and intros there are cleared.
  - Adding an agent to Slack on its own doesn't change the agent's version, so an open edit form still saves.
  - The older `POST`/`PATCH /bot-templates` API also makes a shared template available in Slack at once. It keeps accepting names Slack can't use or that clash; such an agent stays out of Slack and its page says why.
  - Making an agent Only me and then shared again starts it fresh in Slack: open use and channel settings are not kept.
  - During a rolling deploy, servers on the previous release still refuse Only me for an agent in Slack and still show the old switch, which can turn Slack off. A server on this release adds such an agent back within a minute.
  - `@opengeni/db` adds `listAgentsMissingFromSlack`; `putAgentSlackInstall` accepts a null actor, `automatic` for availability Opengeni adds on its own, and `moveFromOther` to move an agent between Slack installations in one transaction.

  Compatibility exception: https://github.com/Cloudgeni-ai/opengeni/pull/7395#issuecomment-6741026523

### Patch Changes

- 8073ab6: Owners and admins can be asked to confirm admin changes with a passkey. With `OPENGENI_ADMIN_PASSKEY_STEP_UP=required`, changes to members, invitations, billing, API keys, shared integrations and settings from a browser need a session confirmed with a passkey: signed in with one, or confirmed once in that session. Creating a personal API key needs it too for an owner or admin. Otherwise the API refuses with `ADMIN_PASSKEY_STEP_UP_REQUIRED` and the console asks for the passkey, then sends the change again; the session stays confirmed until it ends. The phone app, and agents and personal API keys acting for a person, are not asked. Migration 1365 adds `auth_sessions.mfa_verified_at`.
- deccb54: Your GitHub's action approvals have a fourth choice, **Settings and deletions** (group `sensitive` in `GET`/`PATCH /v1/workspaces/:workspaceId/github/action-policies` and the `updateGitHubActionPolicy` app action), next to Create and update work, Submit reviews and Merge pull requests. It covers what agents do as the person with `gh` and Git that is hard to undo: repository settings, secrets, variables and environments, deletions, tag and default-branch rewrites, and requests the gateway doesn't recognise. These used to ask every time with no way to change it; they now follow this choice. It defaults to Ask, so nothing changes until the person picks Allow (or Block). A connection-wide Allow for every GitHub tool doesn't cover it, and a connection-wide Block covers it only while it has no choice of its own. Writes whose repositories the gateway can't confirm (account and organization writes, unreadable requests, unresolvable GraphQL nodes, judged per GraphQL mutation so a bundled write on an allowed repository can't vouch for another) still always ask while the person allows only chosen repositories (or removed one from the chat), because the repository allowlist can't apply to them; with All my repositories at write access they follow the policy too. An approved request that is sent again keeps the policy action it was recorded under, so it still runs if the gateway classifies it differently the second time. The workspace app has no such group: a personal actor's `groups` carries `sensitive` (`PersonalGitHubActionPolicyGroup`, also the type of the update request's `group`), and setting it for the app answers 400.

  Deleting or force-updating an agent's own branch now follows Create and update work when `gh` encodes the branch's slashes (`git/refs/heads%2Fmy%2Fbranch`, as `gh pr merge --delete-branch` sends), instead of always asking.

- 849c7f8: Organization invitations, and the account setup links sent with them, now last at most 48 hours. A request for a longer lifetime is capped at 48 hours after creation instead of refused, and the response returns the stored expiry. Invitations that already exist keep their expiry. The web app now asks for 48 hours instead of 7 days.
- e3cb3c1: Your GitHub accepts repository owners whose logins contain an underscore, as enterprise managed users' do (`octocat_acme`). Choosing, searching, attaching and using such repositories now works everywhere personal GitHub checks an owner: the repository chooser and its stored selection (migration 1370 widens the database check, 1371 validates it), a typed repository URL in the chat's repository picker, agent-created workers and schedules, the `gh` gateway, the account repository tools and the repository identity shown to the agent. Owners still need 1 to 39 letters, digits, `-` or `_`, starting with a letter or digit. The documentation also states that a schedule an agent saves with Your GitHub repositories runs as the person only while those repositories stay in their chosen list (or All my repositories) and the account stays connected, and never falls back to the workspace's GitHub app.
- 1fcdfaa: A session workflow no longer retries a quiescence receipt forever when the session was archived after its turn was cancelled. The database refuses every write for an archived or imported session, so the receipt activity now proves the session is read-only, logs what the database refused, and fails non-retryably; the workflow drops the moot receipt and closes, and the session peek reports read-only sessions so nothing else is attempted. Temporal "Activity failed" log lines now also carry reviewed failure facts (error class, ApplicationFailure type and retryability, SQLSTATE, the constant reason and function our own database code raised, and the persistence stage) instead of only "temporal sdk failure logged".
- 2a1d906: Skip the exact quiescence and pending-writer queries on the turn peek and claim paths when a cheap probe shows the session has no attempt that could await its quiescence receipt, saving their planning cost on most turns.
- 8f94b2c: A subscription connection's recorded plan now follows its token on every refresh. Refreshes outside a chat turn (live voice and other operations, usage reads, administered connections) used to store the new token but drop the plan it reports, so a connection whose provider plan changed kept showing the old one. Every refresh path now runs one shared rotation and persists through the same database writer, which records the plan (a token that reports none keeps the recorded plan) and clears the connection's model cooldowns when the plan changed. Migration 1367 lets that writer accept a refresh outside a chat turn.
- 241ce71: Teams workspace routing, behind `OPENGENI_TEAMS_WORKSPACE_ROUTING_ENABLED` (off by default). When it's on, a linked person's 1:1 chat can start work in any workspace of the connecting organization they can start chats in, as in Slack:

  - `switch` shows a card with their workspaces and agents. A message sent before they choose waits on the card.
  - `in <Workspace>: …` sends one message elsewhere.
  - `Name: …` or `+name` asks one of the organization's shared agents.
  - Agent replies carry an "**Agent** · Workspace" header, and the first reply after a choice says where the chat is saved.

  Organization membership, the person's authority in the target workspace and the organization's reach are read live at enqueue, admission and delivery. A choice that no longer works is refused, never served from another workspace.

  With routing on:

  - Linking is open to any active full member of the organization, still bound to the Teams user's Microsoft identity. The link card opens `/teams/connect`.
  - Organization admins limit which workspaces Teams can reach with the same **Available in Opengeni** control as Slack, through `GET`/`PUT /v1/workspaces/:workspaceId/integrations/teams/reach` (`TeamsBot.getReach` and `setReach` in the SDK).
  - `TeamsBotStatus.workspaceRouting` says whether routing is on.

  Group chats and channels are unchanged.

  Database: migration 1373 adds where an organization lets its Teams connection start work (`teams_bot_installations.reach_*`: every workspace by default, or selected ones, plus Personal workspaces), the agent a 1:1 route runs as (`teams_bot_routes.agent_id`), each linked person's chosen workspace and agent (`teams_bot_chat_choices`) and the switch cards they were shown (`teams_bot_route_prompts`, `teams_bot_route_prompt_options`). Every new target column has a same-account CHECK and composite foreign keys, and the new tables use workspace row-level security. Migration 1374 indexes `teams_bot_routes.agent_id` concurrently. `enqueueTeamsMessage` accepts an agent and a caller-supplied live authority check for a 1:1 route's workspace and agent, and refuses a route that names an agent without one. Disconnecting Teams removes waiting switch cards. Both migrations are rolling: the previous release ignores the new columns and tables.

- b2372f2: Turn timing profiles (version 2) put context compaction inside a turn in its own `compaction_ms` category. A compaction whose summary call has no model request audit (the Messages subscription path) was charged to `after_tool_ms`, which made Opengeni's time between a tool result and the next step look about 100 times larger on that path than it is.
- Updated dependencies [8073ab6]
- Updated dependencies [43aa19d]
- Updated dependencies [b1b69fc]
- Updated dependencies [deccb54]
- Updated dependencies [668c5ed]
- Updated dependencies [e3cb3c1]
- Updated dependencies [1fcdfaa]
- Updated dependencies [f2b4d85]
- Updated dependencies [241ce71]
- Updated dependencies [4d7c96e]
  - @opengeni/config@6.17.0
  - @opengeni/contracts@6.17.0
  - @opengeni/observability@6.17.0
  - @opengeni/subscriptions@6.17.0
  - @opengeni/codemode@6.17.0
  - @opengeni/codex@6.17.0
  - @opengeni/network@6.17.0
  - @opengeni/xai-subscription@6.17.0

## 6.16.0

### Patch Changes

- fb19875: Approval cards now read in the host's words and language. A saved review carries codes beside its English text: `reasonCode` for why it asks or is blocked, `approveLabelCode` when the button is the plain "Approve action" or "Allow", `toolName` for the action, and per field the argument it stands for (`key`) and a plain yes or no (`booleanValue`). The card, the approval list, the step in the chat (`toolDisplayName`) and the history line after a decision word these through the host's `messages`: `approvalSurface.approveAction` and `approvalSurface.allow` for the button, `toolActionReview.reason.*` for the reason, `toolActionReview.yes` and `.no` for yes or no values, and new host keys to name a connector's actions and fields the same way as `connectService.<id>.name`: `toolAction.<toolName>.title`, `toolAction.<toolName>.field.<argument>` and, for every tool, `toolField.<argument>`. Without host words nothing changes.
- 4c84667: Free-credit farm protection by known bad network. A new owner-only setting, `deniedNetworkMode` (`off` by default; `observe` or `enforce`), holds the Free credit of a new self-serve owner whose exact network (IPv4 address or IPv6 /64) was used in the last 90 days by an account with a denied decision or a currently held account, through its signup or its owner's sign-ins, even when it is the only signup from that network. /24 and /48 prefixes never trigger it, invited members never count, manual decisions and operator releases are kept, and failures fail open. Sign-in networks are stored only as HMAC-SHA256 values under a random per-schema database key; the migration captures them for accounts already denied or held. `scripts/operator/promotion-decisions.ts` adds `--denied-network-mode` and `--rule`, and `--network-holds` lists these holds with their own reason. See `docs/signup-abuse-protection.md`.
- Updated dependencies [fb19875]
- Updated dependencies [54dc5da]
- Updated dependencies [01feadc]
  - @opengeni/contracts@6.16.0
  - @opengeni/xai-subscription@6.16.0
  - @opengeni/codemode@6.16.0
  - @opengeni/codex@6.16.0
  - @opengeni/config@6.16.0
  - @opengeni/observability@6.16.0
  - @opengeni/network@6.16.0
  - @opengeni/subscriptions@6.16.0

## 6.15.0

### Minor Changes

- 60d067d: Claude subscription usage now matches what Claude reports today. The usage refresh reads the account's limit reset grants (presenting Claude Code's CLI surface, which Claude requires for them) and, while at a limit, the at-limit reset program. `ClaudeSubscriptionUsage` gains optional `limitResets`, `wallReset`, `limits`, `extraUsage`, `surfaceWindows` and `serviceState`, and the SDK exports their types. The account page lists each grant with what it clears, resets left, expiry and whether it can be used now. `@opengeni/db` adds the adapter-level claim and claim-then-refresh helpers (idempotent request ids); Opengeni never claims a grant on its own.

  The weekly limit model responses call `seven_day_overage_included` is treated as the weekly Fable limit: it limits Fable models only and shows as "Fable week". Responses served in the slow tier or grace zone mark a connection constrained (`SubscriptionQuota.constrainedUntil`): it still serves, but placement prefers accounts with plain capacity, and busy slow-tier slots are a short rate limit rather than the weekly limit.

- bf804ef: Chats created with an API key are now labelled by the key's name with an "API key" hint in the sidebar's creator groups and hover cards (for example "Codex operator 2026-09-11 · API key") instead of a raw principal id, and other services show a "Service" hint; a key or service without a name shows just "API key" or "Service", never an id. An API key's chats form one group (people and services keep their exact frozen kind) even when older chats recorded the key as a subject and newer ones as a service, keys that share a name are told apart by a number, and an API key never gets a person's initials chip. On the Schedules page, a schedule owned by an API key shows a bot icon instead of initials, and "API key" instead of the raw key id when the key has no name. How people are shown is unchanged.

  The session list API accepts `createdBySubjectId` without `createdByKind`, matching every session that subject created whichever kind it was recorded as; `createdByKind` alone is still rejected. The SDK's `listSessionPage` `createdBy.kind` is now optional to match, and `@opengeni/db` session list filters accept a creator without a kind. Requests that send both keep their exact behaviour.

### Patch Changes

- 20e9d79: An event added to a chat while Opengeni is archiving it, after the archive has read the chat's events, again appears in the stored transcript. Since the transcript started being written from the events the archive bundle reads, such an event was left out of both the bundle and the transcript. One more read after the bundle picks up these late events; normally it finds none.

  Purging an archived chat's content now treats an invalid starting table (not a whole number, negative, or past the last table) as the first table. Such a value could previously skip every table and record the purge as complete with content still left. Valid starting tables behave as before.

- 5525e63: A waiting turn now restates its reset to everyone who was told, not only the person. When a later check finds the reset later than the one announced (its time passed without capacity, or a longer limit binds) or unknown, the session's timeline gets a new waiting event naming the reset that now holds, and a worker's parent gets a further `child_waiting_capacity` notice whose dedupe key adds that reset (child lifecycle notice protocol revision 4). An unchanged or earlier reset says nothing new.
- cd033ae: A Codex model gated above the client version Opengeni presents no longer strands turns. The version refusal ("requires a newer version of Codex") now fails the turn with `codex_client_version_rejected` and is never treated as a plan refusal, even when it carries an upgrade code. When the backend hides a model from every connected account's live model list, home-provider placement no longer waits behind another account's unrelated quota reset: it runs on capacity, and the provider's answer decides. Nothing is written against the account, so service returns as soon as the presented version is new enough.
- 464e61f: Collect session content blobs that no model-context snapshot or tool catalog refers to any more. Each model request replaced the attempt's snapshot and left the replaced request body chunks behind until the session was archived; the session storage maintenance pass can now delete them under a per-session lock that every blob writer and snapshot reader holds shared. Migration 1359 adds the collector without runtime access; a later migration grants it.
- 3bab763: `ConnectPanel` now keeps the organization approval help up when a sign-in comes back cancelled or denied with an administrator approval link stored on the attempt, for example after someone leaves Microsoft's "Need admin approval" page with Cancel or "Return to the application without granting consent". It used to treat the cancel as finished and quietly go back to the service list. The help offers the message for IT, the approval link, "Try signing in again" (a fresh setup for the same service unless the host passes `onRetry`) and "Back to connections". A plain cancel that stores no approval link still closes quietly.

  `ConnectPanel`, `ConnectChooser`, `ConnectAccounts` and `ConnectionDiscovery` accept `finishInPopup`. Set it when your `onAuthorize` opens the provider's sign-in in a popup: the popup then ends on a small page that closes itself instead of loading your return URL, a second copy of your app, inside it. The closing page now says "Go back to where you started to continue" rather than naming the chat.

  Once a service connects, older unfinished setups by the same person for the same service, owner and destination no longer appear in the pending list (`GET /v1/workspaces/:workspaceId/connect/attempts`), so a host's "continue setup" entry for that service goes away. Custom connections (MCP servers, OpenAPI and GraphQL sources) share one provider ID across different services and are never hidden this way.

  The page a sign-in popup ends on and the page an administrator sees after the Microsoft approval link can now use the deployment's language: set `OPENGENI_CONNECT_RESULT_PAGE_TEXT_JSON` (fields `lang`, `signInFinishedTitle`, `signInFinishedBody`, `adminApprovedTitle`, `adminApprovedBody`, `adminNotApprovedTitle`, `adminNotApprovedBody`, `closeWindow`). Any field left out stays in English. `@opengeni/config` exports `parseConnectResultPageTextJson` and `ConnectResultPageTextSchema`.

- b81b7be: The direct model API (`/v1/workspaces/:workspaceId/chat/completions` and its `/models` list) is now always API use, whatever credential signs the call. A person's own browser session or native app credential is billed like an API key: only purchased credit pays, never Free or other plan credit, and connected subscriptions are not offered. Without credit the call is refused with `api_credits_required`, as before; the message on this endpoint now ends "Add credits to use the API." for every caller, API keys included. An agent's call keeps its chat's origin, a trusted in-process dispatcher's origin is kept, and internal (legacy) accounts stay app use. Chats and other app features are unchanged. `billingOriginOverride` in `@opengeni/db` reads the origin a trusted dispatcher fixed.
- 2107e6f: Removing a duplicate login no longer leaves a connector saying "Sign in again" next to a working account. A connector's status now follows the person's accounts that still exist: a working one first, then one that needs signing in again; a removed login no longer counts. When only removed logins are left, the connector offers Connect instead of a Reconnect that could never succeed. The same applies in chat: a connector card no longer refuses with "More than one personal account matches" because of removed duplicates; it reconnects the person's one remaining login, or connects a new one when none is left.

  The OAuth client no longer counts as part of an account's identity. A login made before a deployment replaced its OAuth client (for example its Google client) is still recognised as the same account: connecting again reuses it instead of saving a duplicate, and reconnecting it no longer fails as a different account. Migration 1362 merges the duplicate personal Slack, Gmail, Google Calendar, Google Drive and Atlassian logins that were saved under different clients, using migration 1226's rules (same person, server, authorization server and verified account; the kept login must hold every scope of the merged one; logins that something depends on, now including Slack agents, are left in place). Of two working logins it keeps the one that refreshed most recently, so a login on a retired client is no longer kept over one that has refreshed since.

  Gmail no longer sends `include_granted_scopes`. Gmail, Google Drive and Google Calendar share one Google client, so Google's consent screen listed the person's earlier Drive and Calendar grants, and the Gmail token carried them. Gmail now asks for and holds only Gmail access. Connecting Gmail, Drive or Calendar shows Google's account picker, and reconnecting an account names it to Google, so Google no longer signs in whichever account the browser used last.

- 060c983: A sub-agent failure that its parent agent has already received no longer shows a red dot or an "unread failures" count on the parent's sidebar row, hover card, project totals or Needs you, and nothing the failed session logs afterwards counts as unread there either. Failures nobody took on still show: a top-level chat that fails, a failure whose notice its parent has not consumed, or a sub-agent that fails again after a retry. Sessions carry a new optional `failureHandled` flag.
- ab4941f: Reject rolling migrations that revoke, drop or rename a routine, table privilege or schema that the previous release's runtime posture still requires, judged against the posture of the main merge base and the pinned production baseline.
- 05ac4a2: Existing meetings' audio is now converted to the compact kept format too. The recording retention sweep converts a few tracks per run to one Opus file per track and deletes their uploaded pieces, as new meetings already are.
- 6c6eac9: A missing runtime EXECUTE grant no longer takes the API and workers out of service. When the runtime role lacks EXECUTE on a routine the binary requires (a declared private routine or a target-schema capability), startup and readiness now report it as degraded and stay ready. It is reported through a structured warning, the `opengeni_runtime_database_degraded_findings` gauge and the new `OpenGeniRuntimeDatabaseGrantMissing` warning alert. Calls to the affected routines still fail with a permission error. A finding counts as degraded only when granting the missing EXECUTE removes it without raising any other finding.

  Unsafe posture still fails startup and readiness:

  - excess, PUBLIC or forbidden privileges
  - wrong owners or search paths
  - RLS problems
  - forbidden role attributes or memberships
  - missing CONNECT or schema USAGE
  - missing or ambiguous objects
  - anything that cannot be inspected

  The posture CLI (the Helm migration job), the runtime-posture compatibility workflow and the previous-binary checks keep the strict evaluation, where every finding still fails.

  Embedders: `runtimeDatabaseReadyCheck` and the worker's `databasePosture` readiness now also degrade on a missing required grant. Both take an optional listener for the degraded findings (`onDegraded`, and `onDegradedDatabasePosture` on `runOpenGeniWorker`). New exports from `@opengeni/db`:

  - `classifyRuntimeDatabasePosture`, `assertRuntimeDatabaseReadiness` and `reportRuntimeDatabaseDegraded`
  - the types `RuntimeDatabasePostureFindings`, `RuntimeDatabaseDegradedListener` and `RuntimeDatabaseDegradedObserver`
  - the constants `RUNTIME_DATABASE_DEGRADED_GAUGE`, `RUNTIME_DATABASE_DEGRADED_LOG_INTERVAL_MS` and `RUNTIME_DATABASE_DEGRADED_LOG_FINDINGS`

- c71c1d1: Agents are told when their managed sandbox was stopped. A stopped sandbox is restored from its saved `/workspace`, so files elsewhere (such as `/tmp`) and running programs may be gone, and agents used to find out only from failing commands. The first turn attempt after a stop the agent hasn't acted since now carries one sentence with the time and what may be gone. With the short idle grace, this appears on most turns that follow a pause after sandbox use. A box found lost during a turn is not covered. The reaper's stop event now records `providerStopped`, so a Connected Machine's drain, which stops nothing, is not reported.
- 329ad8f: Free-credit farm protection by signup network. Each new self-serve organization records keyed hashes of the owner's client (IPv4 address or IPv6 /64) and its /24 or /48 prefix (never the address itself, kept 90 days), in every mode; invited members are never recorded. A new owner-only, revision-fenced setting (`off` by default) can observe or enforce an IP-velocity rule that holds Free credit, not access or purchased funds, from the 3rd new organization from one address within 24 hours, and can refuse organization setup with HTTP 429 after 5 from one address in an hour. The onboarding screen shows the server's message for that refusal. `scripts/operator/promotion-decisions.ts` adds `--network-velocity`, `--network-velocity-set`, `--network-holds` and `--network-release-holds`. See `docs/signup-abuse-protection.md`.
- f22647a: The system prompt no longer changes when repository Skills are added or removed, the workspace becomes unreachable or degraded, or a turn switches between deferred and indexed Skill discovery. It keeps one stable "Repository skills" notice, and the live index reaches the model as a durable "Repository skills" developer history item, written only when it changes, frozen per turn and placed before the turn that first sees it. The current run sees the item at the same position later turns load it from, so earlier signed Claude thinking and cached prefixes stay valid. The one-shot request for a missing session title is now part of the turn's operational notice instead of being appended to the first request's system prompt. New exports: `ensureSessionRepositorySkills` (`@opengeni/db`), `repositorySkillsContextItem`, `readRepositorySkillsContext` and `latestRepositorySkillsIndex` (`@opengeni/contracts`), and the `publishRepositorySkills` agent option (`@opengeni/runtime`).
- 3721c96: Index the turn-start lookups that walked whole session histories: the next turn position, the attempt-claim recovery-warning receipt checks, and the skill write receipt lookups behind every preference snapshot.
- 4459bd7: Voice calls open and follow along more cleanly. The voice model now gets the agent's working notes as whole messages when each note completes. Before, every streaming fragment ("You pic", "ked up, so…") arrived as its own context item, and final answers showed up twice. A final answer now reaches the voice once, as the turn's result. The resume prompt for chats with earlier voice calls no longer demands total silence at the start, which contradicted a call the agent placed ("speak first"). The placed-call opening also says to answer right away, or to answer the person's hello if they spoke first.
- ee44e4b: A voice call now hears the agent's actual answer when the agent ends its turn by waiting for input. That answer is stored as the turn's `reply` with an empty `output`, and the realtime projection read only `output`, so the voice model received an empty result and made an outcome up. The projection now uses `output`, then `reply`, and when a turn finished with neither it says so explicitly instead of sending empty text.
- Updated dependencies [708848c]
- Updated dependencies [b110015]
- Updated dependencies [5525e63]
- Updated dependencies [60d067d]
- Updated dependencies [da60317]
- Updated dependencies [19ab8c3]
- Updated dependencies [cd033ae]
- Updated dependencies [3bab763]
- Updated dependencies [f92ff08]
- Updated dependencies [060c983]
- Updated dependencies [dfeab20]
- Updated dependencies [e3df016]
- Updated dependencies [9885d37]
- Updated dependencies [f22647a]
- Updated dependencies [850b4d5]
  - @opengeni/contracts@6.15.0
  - @opengeni/config@6.15.0
  - @opengeni/subscriptions@6.15.0
  - @opengeni/codex@6.15.0
  - @opengeni/observability@6.15.0
  - @opengeni/codemode@6.15.0
  - @opengeni/network@6.15.0
  - @opengeni/xai-subscription@6.15.0

## 6.14.0

### Minor Changes

- c976c87: Agents have one text, their Instructions: First message is gone from the agent editor, the agent page, export, `bot_template_save` and the docs. The editor is icon, name, what it helps with, Instructions, Remember across chats and who can use it. Starting a chat with an agent (`?agent=`, or an older `?botTemplateId=` link) selects it and leaves the composer as it is.

  Nothing is dropped or migrated. Every read joins an existing First message after the Instructions as its own paragraph, led by "When a chat starts:" so one-time setup stays for the start of a chat (`agentInstructionsWithFirstMessage` in `@opengeni/contracts`, `agentInstructionsSql` in `@opengeni/db`), so the editor, the API, Slack and a chat's agent layer all see the same text, and a chat with such an agent now follows it as part of its Instructions. The next change to the agent stores the joined text with an empty First message, unless the two together pass the 20,000-character limit, when both are kept as they were; the editor then saves other changes and asks to shorten the Instructions only when they are edited. The legacy `bot_templates` and `slack_agents` rows copy what is stored, never a cut text, so an older server writing them back during a rollout loses nothing. `Agent.firstMessage` is always empty and `hasFirstMessage` false; the fields stay for older clients. `firstMessage` on create and update, `bot_template_save`'s `firstMessage` and `setupInstructions`, and `/bot-templates` `setupInstructions` are still accepted and become Instructions. `/bot-templates` lists only agents made as templates, with their Instructions as `setupInstructions`. The `first_message` column stays.

  The agent icon picker opens on the emoji choices and colours, also for a new agent with no icon yet. Browsing the tabs or a colour chooses nothing; picking an emoji, icon or letters makes it the icon, in the colour browsed. Before, it showed only the Emoji, Icon and Letters tabs until one was clicked.

  "Remember across chats" is a switch in the agent form, and new agents start with it on: from the app form (including Make this an agent) and from a chat's `bot_template_save`, which now also creates the agent's Memory collection and reports in its result's `memory.status` whether that collection is `ready`, `pending_review`, `learning_off` or `not_saved`, with a note for the person. Saving the agent in the app sets up a missing collection. Agents made from a Slack proposal already started with Memory on. Existing agents keep their setting, and `CreateAgentRequest.memoryEnabled` still defaults to off when the API caller omits it.

### Patch Changes

- 23964f7: More access fixes now start a blocked chat's saved message by themselves. These are a reactivated organization member (by an admin or through external identity reactivation), an accepted invitation, an organization admin's workspace access grant, external first-use and stated memberships, explicit external member onboarding, and Slack access approval. A restored organization membership releases saved messages in every workspace of that organization (`releaseMembershipBlocksInOrganization` in `@opengeni/core`, `listOrganizationWorkspaceIds` in `@opengeni/db`). As before, each message starts exactly once, and a paused chat waits until it is resumed.
- cb3cf2c: An archived session's purge now resumes at the table it left unfinished instead of calling every already-empty table again on each step, and still ends with one pass over every table that confirms nothing is left. It deletes the same rows with far fewer database calls.
- 936423e: Archiving a session now writes its readable transcript from the event rows the bundle export already read, instead of reading every kept event from the database a second time. The transcript reads exactly as before. A compressed JSON lines file that fails while its producer is busy elsewhere now fails the producer's next write instead of waiting forever, and no longer leaves an unhandled rejection behind.
- f80cd7a: Releases can roll out over the production binary again. Migration 1283 withholds the runtime grant on the inventory of meeting tracks not yet kept compact, because the binary in production rejects that grant on a routine it does not know. Until a later release grants it again, existing meetings' audio stays as it is; new meetings are still kept compact.
- c472500: A meeting transcript now says where a track recorded nothing, such as "Ingrid's microphone wasn't recording from 17:39 to 45:35. Everyone else was still recorded." Before, a microphone that was unplugged or tab sharing that ended left a voice missing with no explanation, so the transcript looked like it had skipped speech. Each track's new `unrecorded` field lists those stretches. The server works them out from the chunks' start times when a recording is finalized (migration 1353 adds the column). Older meetings get them the next time they are transcribed. Stretches under two seconds are ignored. The web and phone transcripts show a quiet line where each one starts, naming the person when the track carries one named voice and saying "Nothing was recorded" where every track was silent at once; no turn runs across one. `@opengeni/react/recordings` exports `transcriptUnrecordedMarks`, `interleaveUnrecordedMarks`, `trackSpeakerName` and `unrecordedMarkText` for embedders that render their own transcript, and `groupTranscriptTurns` takes the times no turn may run across.
- 0b65ea4: Turn timing profiles: a router (`tool_invoke`) call whose arguments were stored as a JSON string made the profile query fail with an invalid regular expression, so the sweep skipped the rest of that workspace. The pattern now stays within PostgreSQL's limit, and a page of turns whose history cannot be read is reported and skipped while the pass moves on.
- Updated dependencies [c976c87]
- Updated dependencies [6ae0528]
- Updated dependencies [e33947d]
- Updated dependencies [3b853ca]
- Updated dependencies [dd11dad]
- Updated dependencies [ec9cfe4]
- Updated dependencies [91320a4]
- Updated dependencies [c7ba98b]
- Updated dependencies [5628a56]
- Updated dependencies [c472500]
  - @opengeni/contracts@6.14.0
  - @opengeni/config@6.14.0
  - @opengeni/observability@6.14.0
  - @opengeni/codemode@6.14.0
  - @opengeni/codex@6.14.0
  - @opengeni/network@6.14.0
  - @opengeni/subscriptions@6.14.0
  - @opengeni/xai-subscription@6.14.0

## 6.13.0

### Patch Changes

- b15212e: A message that couldn't start because of access now starts by itself once that is fixed. When its machine is allowed for the chat, the sender's workspace access is restored, or the chat moves to a machine it may use, the saved message is released and started exactly once. A paused, cancelled or edited chat is left alone, and a claim that raced the change is re-read instead of parked. The "Recheck access" button is gone. The notice says what is blocking the message and offers the one action that fixes it: the machine's owner gets "Allow for this chat", others learn who can allow it, and lost membership names a workspace admin. Only an unknown failure offers "Try again". A claim refused because a personal machine isn't approved now reads as "Machine access needed", not as a generic permission check. `useSessionStart` adds `allowMachine`, `needsMachineAccess` and `refresh`, and `@opengeni/react` exports `allowMachineForChat`, `sessionAdmissionNeedsMachineAccess` and `sessionAdmissionMachineAccessCopy`.
- Updated dependencies [1c7aa2a]
- Updated dependencies [67905a7]
  - @opengeni/contracts@6.13.0
  - @opengeni/config@6.13.0
  - @opengeni/codemode@6.13.0
  - @opengeni/codex@6.13.0
  - @opengeni/observability@6.13.0
  - @opengeni/network@6.13.0
  - @opengeni/subscriptions@6.13.0
  - @opengeni/xai-subscription@6.13.0

## 6.12.0

### Minor Changes

- 64fd53f: An agent can now ask to attach a repository the workspace GitHub App offers to its own chat with the new first-party `github_repository_attach` tool. Every call waits for a person's approval through the ordinary tool approval card, in the app and in the Slack thread of a chat started from Slack. The card names the repository, the branch and the access, and says when a person removed the repository from the chat earlier. Where nobody can answer, such as a scheduled or unattended run, the call is refused.

  The API attaches only a call a person approved for exactly that repository and branch, from the same workspace GitHub App catalog and `github:use` permission as the repository picker, and never an archived or empty repository. The repository joins the chat's repositories as best effort (`optional`), ends any earlier removal record, and is one of the chat's repositories from the next turn. Asking for a repository the chat already has reports the branch it has, and a repository the App has since stopped offering no longer blocks attaching another. A new `session.resources.added` event records it.

  `@opengeni/core` adds `attachSessionRepositoryResource`, `@opengeni/db` adds `listPersonApprovedFirstPartyToolCalls`, and the timeline shows the call as "Attaching a code repository".

  An approval card for a first-party call whose review states its target facts now lists those facts, in the app and in Slack, as app action cards do; the call's raw arguments stay in Details. The Slack bot message card shows its channel and message this way too.

- 34ff418: An agent's call stops ringing on the person's other Android phones as soon as it is answered or declined on one of them, or the agent cancels it, even when the app on those phones is not running. Settling a call withdraws rings the server has not sent yet and sends each Android phone that rang a silent `opengeniCall` "ended" message with the reason, which shares the ring's collapse key and expires with the ring. Migration 1343 adds the database routine for this without granting it to the runtime; until a later migration grants it, settling a call behaves as before.
- bd4f53a: A new Slack task now starts with the repositories in the person's new-chat form, the same ones a new chat in the app would start with, instead of up to five repositories gathered from every session the person used in the last 30 days. It keeps the existing limits: at most five, in form order, only through the workspace GitHub App catalog on each repository's default branch, archived and empty repositories skipped, and every one best effort. A form with no repositories starts the task with none. Connectors, Opengeni tools, Sandbox Environment and compute still follow the workspace defaults, and an explicitly chosen model still carries over.

  `@opengeni/core` adds `getActorNewSessionStartChoices`, which reads the form once and returns the explicitly chosen model policy and the form's repositories. `getActorNewSessionModelChoice` is unchanged.

  Breaking: `@opengeni/db` removes `listRecentSessionRepositoryResources`, which only served the old Slack selection.

- f1999bf: Every finished agent turn now gets a timing profile that says where its wall time went: queue, startup, dispatch, model inference, provider overhead, network, model requests without provider timing, stalled requests, hosted web search, remote MCP tools, sandbox tools, Opengeni's own tools, sandbox setup, human and capacity waits, the gaps after model requests and tool calls, recovery and turn end. The control maintenance schedule computes it from the turn's session event log after the turn settles, so nothing is added to the turn itself, and stores it in the new `turn_timing_profiles` table (migration 1351) with the turn's model, reasoning effort, status and the steps of every model request and tool call, including each remote MCP call's id, tool name, start, end and outcome. Profiles are kept as long as the turn and are visible under the same workspace and chat rules as the event log.

  New metrics `opengeni_turn_timing_seconds_total` and `opengeni_turn_wall_seconds` feed dashboards, and `bun run db:backfill-turn-timing-profiles` profiles existing history. Migration 1352 adds a finished-turn index concurrently. `@opengeni/db` adds `computeTurnTimingProfile`, `recordTurnTimingProfile` and `recordMissingTurnTimingProfiles`. See `docs/turn-timing-profiles.md`.

- c0b9f88: Add workspace-scoped stateless typed decisions with SDK `decide`. Reuse the
  deployment's configured decision model, chat-completions authority, usage settlement
  and residency checks. Calls are deployment-funded, independent of customer agent
  allowances, with optional tenant-label attribution and off-path usage receipts.
  Preserve typed refusals and reported, estimated and unknown provider costs.

### Patch Changes

- 2aa8ba4: Consolidate response and tool-result persistence under their existing attempt fences and batch queued lifecycle observations, reducing per-step database round trips without changing model inputs.
- 7332869: "Allow once" for a personal Connected Machine now works. Accepting the message used the one-time grant and filed its receipt against the message, but the check before the turn ran on the machine only accepted a receipt filed against the attempt, so every such turn failed with "A database error occurred." Migration 1340 lets that check accept the message's receipt for the same grant, turn, account and authority generation, so the message runs on the machine (including a retried attempt of the same turn), and the next message needs approval again. A turn whose machine approval is missing, used up, revoked or expired now ends with "Machine access needed: this chat isn’t allowed to use “<machine>” right now." (failure code `machine_access_required`) instead of a database error, and the machine's owner gets an "Allow for this chat" action in the failed-turn banner that approves the machine for the chat and continues. Failed-turn analytics add the `machine_access` class and the `allow_machine` action.
- d29c500: Make storing archived chats cheaper for the database: deleting a stored chat's model history and machine inputs now checks the rows that reference them with an index seek instead of scanning every workspace's delivered updates for each deleted row.
- 831f2ef: A subscription capacity wait now reports the reset that actually blocks, and its notification no longer promises a time that has passed. A provider quota refusal that came without a reset time got a five-hour fallback deadline even while the account's weekly allowance was spent, so the wait named that fallback, an account with extra credits was retried when it ended and refused again, and the chat stayed stuck past the time it promised. A running quota exhaustion now lasts until every usage window still spent beside it resets (`quotaExhaustionHeldByWindows`), so the wait names the earliest real reset across the eligible accounts and resumes then; a usage reading that shows the limit lifted still ends it early. The person's inbox notification for a long wait is updated in place (same key, no new alert) whenever a later check finds the wait ends later than it said, after its time passed without capacity, or that no reset time is known.
- 4eb53af: Reduce chat-open database work by reusing bounded request authorization and catalog inputs, activating read-only external identity lookup, and avoiding redundant session and voice projections. Fresh stream authorization and write-path fences remain live.
- 2117a2d: When a chat's own model cannot summarize older history, the turn no longer fails with "start a new session". On an OpenAI-compatible endpoint, a summary request rejected with HTTP 400 or 422 is first sent once more without its output cap, and a summary from that retry is held to the cap by cutting it from the middle. If the summary still fails in a way that repeating it cannot fix (a definitive rejection, a non-temporary failed response, or an empty or unusable summary, including one cut off at the output limit), the history is trimmed instead: platform context and the newest requests are kept as a summarized checkpoint keeps them, and a fixed note stands in for the summary. No other model is asked, so no history leaves the chat's provider. Retryable, temporary, transport, authentication and quota failures, cancellation, Codex remote compaction and the rebuild when a Codex chat switches model keep their existing handling, with history unchanged. The provider's own error message, bounded, is now recorded in the structured `providerMessage` field of the session's events (the trimmed checkpoint's `fallback`, the `summarization_failed` skip and `turn.failed`), never in free-text errors or worker logs. The timeline shows "Older messages trimmed" with the provider's reason behind Details.
- a898141: Background maintenance no longer sweeps connected-command output that can never be captured. A live runner reports the finished operations it still holds, and that report collects their output. Output that is still uncaptured is now recorded as unavailable instead of being retried every few minutes forever:

  - a day after its command exited, if its runner was seen alive at least an hour after the exit;
  - otherwise, after a week.

  A personal Connected Machine used from another workspace only gets the one-week limit, because its last-seen time is not visible from there.

  For a runner that reports its own operation inventory, such as a compute sandbox, the database recheck now backs off to once every six hours. That runner still collects its output itself whenever it talks. Captured output, recent output and the legacy Connected Machine retry schedule are unchanged.

- 85622d5: A continued turn (a goal continuation, a wake-up, a command or child result) now resolves its connector accounts inside the turn claim with far fewer database round trips. Each fact the resolution needs is read once: workspace membership, the Personal-workspace check, the person's own accounts and the logins turned on in the workspace (now in one scope), and connection metadata (now one read per origin workspace instead of one per connection). The number of scopes and round trips no longer grows with the number of connectors. The checks, transaction, session lock and resulting accounts, delegations and gaps are unchanged.
- 8cc1ddd: An agent moving its turn onto a personal (Only me) Connected Machine whose approval for the turn was used up, revoked or expired now gets a typed refusal instead of a raw database error. `sandbox_swap`, `sandbox_attach` and `run_on` return the new code `machine_access_required`, whose reason starts with "Machine access needed: this chat isn’t allowed to use “<machine>” right now.", and the chat stays on its current machine. That sentence now comes from one shared helper, `machineAccessNeededMessage` in `@opengeni/contracts`, used by the failed-turn banner, the worker's turn failure and the refusal.
- a43ce53: Preserve connector exclusions when seeding the next new-chat draft after Send. Restoring a customized draft on another client now keeps following workspace integrations minus the selected exclusions, rather than silently pinning an empty connector list. Deliberately selected tool sets, including an empty set, remain unchanged.
- c63eeb2: A new chat whose draft has an Agent learning setting can be sent again. The composer saved Agent learning in the new-chat draft, but the server's check that Send matches the saved draft left it out, so every such Send was refused as a draft conflict and the person was told the draft kept changing in another tab. The check now compares every option a new-chat draft can hold, taken from the draft contract itself, and treats an Agent learning setting with nothing overridden as unset. The composer names another tab or window only when the draft really changed since its Send saved it; otherwise it stops retrying and says the message couldn't be sent.
- 3929153: Prepare incoming voice connections while ringing only on phones with a native audio device that guarantees silence until Answer. Hold context delivery until the answering phone wins, release unused preparations silently, and retain connect-on-answer behavior on other hosts.
- 752da12: The database readiness check is cheaper. Its table inventory now finds column-level grants by checking only the columns that have their own privileges, instead of calling `has_any_column_privilege`, which reads every column of every table into a fresh connection's catalog cache. It reports the same privileges as before. Concurrent API readiness probes now share one outstanding posture inspection, as worker probes already do, so a slow database no longer ties up one pooled connection per probe. Every probe that starts after an inspection finishes still runs a full, live inspection.
- 2e1e9c6: Send always wins over the saved draft. Starting a new chat or sending in an existing chat now carries exactly what is in the box and is never refused because the draft changed, on web, the Mac app and mobile; retries stay safe through the message's client event ID.

  API change: `expectedNewSessionDraftRevision` on create and `expectedDraftRevision` on composer submit no longer make the server refuse a Send with `NEW_SESSION_DRAFT_CONFLICT` or `DRAFT_CHANGED`. They are now the revision the sender last saw, the basis for clearing the draft: after an accepted Send the server clears the draft only while it is still at that revision or holds exactly what was sent. Otherwise a newer draft typed on another device stays (composer submit returns it as `draft`) and the composer shows it. Composer submit now also accepts `expectedDraftRevision: 0`, meaning the sender saw no saved draft. Draft saves keep their revision checks.

  A person's other devices now follow their latest draft live through a private, content-free hint on the workspace live stream (`workspace.drafts.changed`), and typing over another device's edit saves on top of it instead of asking which draft to keep. Mobile new chats now clear the saved draft they were sent from. Against a server from before this change, a mobile new chat that the server refuses over its draft is retried once without the draft, as such servers always accepted.

- bee1e4c: With `busySend: "steer"`, a message sent while a turn runs now always reaches that turn, even when the client's copy of the session is a few seconds behind. The composer used to pick Steer or Send from its own view of the session, so a Send right after a turn started could be queued and answered only after the turn finished. It now submits the new `delivery: "steer_or_send"` (accepted by `steerMessage` and draft submits), and the server resolves it under the same locks that start and settle turns: it steers a running or just-starting turn, starts a turn when the session is idle, and queues without resuming when it is paused. Only the resolved `steer` or `send` is recorded, so nothing the model sees changes. Exact retries replay the first decision. Plain `send` and explicit Queue are unchanged, and the composer falls back to its own choice against a server without `steer_or_send`.
- 94360cf: Deleting a turn that delivered a system update no longer fails. The update's link to that turn was a foreign key that, on delete, also tried to clear its workspace column. Migrations 1341 and 1342 make it clear only the link, and a catalog test now rejects any foreign key that would clear a required column on delete.
- 00dd24b: Choosing Ultrafast now works. The database accepted only Standard, Priority and Fast, so with Ultrafast selected every draft save, new chat and message failed with a server error. Migrations 1302-1310 widen the latency-mode checks on chats, turns and both kinds of drafts (added NOT VALID, then validated separately, so no table is locked for long), and scheduled runs into an Ultrafast chat are admitted. Compaction turns, goal continuations and scheduled runs keep a chat's Ultrafast setting instead of dropping to its default. The built-in provider offers Ultrafast only on the direct OpenAI API, where OpenAI serves it, not on Azure OpenAI or another base URL; turns already accepted there keep running. Agents can start Ultrafast workers with `session_create`.
- 1445841: Pausing the whole workspace now stops turns waiting for subscription capacity, as a chat's Pause already did: the wait is released, the "continues by itself" notification is withdrawn, and Resume continues the turn, announcing the wait again if capacity is still missing.
- Updated dependencies [64fd53f]
- Updated dependencies [831f2ef]
- Updated dependencies [281af3a]
- Updated dependencies [af5b686]
- Updated dependencies [e9222e0]
- Updated dependencies [f817cf5]
- Updated dependencies [8cc1ddd]
- Updated dependencies [a64e6e4]
- Updated dependencies [98938f0]
- Updated dependencies [3929153]
- Updated dependencies [2e1e9c6]
- Updated dependencies [2e749ad]
- Updated dependencies [fcdf7de]
- Updated dependencies [bee1e4c]
- Updated dependencies [913e2b4]
- Updated dependencies [c0b9f88]
- Updated dependencies [00dd24b]
  - @opengeni/config@6.12.0
  - @opengeni/contracts@6.12.0
  - @opengeni/subscriptions@6.12.0
  - @opengeni/observability@6.12.0
  - @opengeni/network@6.12.0
  - @opengeni/codemode@6.12.0
  - @opengeni/codex@6.12.0
  - @opengeni/xai-subscription@6.12.0

## 6.11.0

### Minor Changes

- 7e92bda: Agents API: `/v1/workspaces/:workspaceId/agents` lists, reads, creates, changes (with `expectedVersion`) and deletes agents, with revisions, an agent's chats (yours or everyone's; Only me chats and Slack DMs only for their owner) and Slack availability per installation (turn on or off, open, channels, intro). Every Instructions or First message change is a new revision recording who made it. Writes keep the legacy `bot_templates` and `slack_agents` rows in sync for older releases. `CreateSessionRequest.agentId` starts a chat bound to the agent and its current revision (`Session.agentId`; an Only me agent's chat is Only me and cannot be shared later; a shared chat never reads an Only me agent's Instructions); Slack agent chats are bound the same way and no longer copy the agent's Instructions into the chat's instructions. Bot templates (listing agents with a First message), the Slack agent routes and their MCP tools keep working on top of agents; editing a bot template now needs whoever saved it or a workspace admin. New exports: the agent contracts (`Agent`, `AgentSummary`, `AgentRevision`, `AgentChat`, `AgentSlackAvailability`, request and response schemas, `AGENT_ERROR_CODES`, `agentInitialsAvatar`), the SDK client methods `listAgents`, `getAgent`, `createAgent`, `updateAgent`, `deleteAgent`, `listAgentRevisions`, `listAgentChats`, `listAgentSlackInstalls`, `putAgentSlackAvailability`, `deleteAgentSlackAvailability`, `listAgentSlackChannels` and `postAgentSlackIntro`, and the agents data layer in db.
- ee15e95: Agent Memory rules: one switch. With Memory on, an agent's chats read its collection (including unreviewed entries, labelled as such) and its other shared chats; only chats whose audience matches the collection save to it, so private chats of a shared agent only read, and the Knowledge write tools refuse otherwise (`agent_memory_read_only`), also for collections inside it. An agent's Slack DMs save no Knowledge at all: their session rows are shared, so a save would reach workspace Knowledge (the old DM leak). A chat with an Only me agent other than its owner's Only me chat (one shared later) neither reads nor writes its Memory and lists no other chats. With Memory off, the collection is not read (`agent_memory_off`), nothing is saved into it and `slack_agent_chats` lists nothing. App chats started with an agent get the same Memory guidance and `slack_agent_chats`. `bot_template_save` now makes an agent with standing `instructions` and an optional `firstMessage` (`setupInstructions` still works as the First message) and returns `{ ok, agent }` instead of `{ template }`. New exports: `agentMemoryAccess`, `agentMemoryGuidance`, `agentMemoryReadOnlyMessage`, `agentMemoryUnreadableMessage`, `AGENT_MEMORY_UNREADABLE_MESSAGE` and `AGENT_MEMORY_NOT_THIS_CHAT_MESSAGE` (core) and `getSessionAgentMemoryState` (db).
- d8e2bbc: Add opt-in owner-authorized automatic credit top-up settings, card setup and SDK methods, with durable Stripe PaymentIntent recovery and tax-inclusive UTC monthly caps. Deployment activation is off by default.
- d8e2bbc: Normalize automatic top-up journal grants for legacy/custom migration owners in
  an additive migration, preserving append-only intent before role reprovisioning.

  Run automatic top-up reconciliation through the API lifecycle and atomically enqueue owner notifications in the shared billing outbox, preserving replay snapshots and disabled-mode recovery.

- e10e748: Add configurable organization credit alerts, durable recipient/email receipts,
  unusual-spend detection and billing-authorized notification APIs. Expose settings
  and notices in the SDK without charging money or leaking organization billing
  events into workspace feeds.
- 3f64150: Your GitHub can use **All my repositories** (offered once `OPENGENI_GITHUB_PERSONAL_ALL_REPOSITORIES_ENABLED` is on, after every API and worker runs this release; `allRepositoriesAvailable` on the connection status), read only or read and write, instead of a chosen list: any repository the person can currently reach on GitHub works in chats, the git broker and the `github_personal__*` tools, checked live with GitHub (cached for a minute; renamed repositories are followed). A repository a person removed from a chat stays refused in that chat. The chosen list is kept, so switching back restores it; turning the mode off, or narrowing it, ends work accepted before, even if it is turned back on. Catalog items keep `selectedAccess` as the saved choice and add `effectiveAccess`, the access usable now. Repository search in the chooser and the session picker now asks GitHub, so it finds repositories beyond the first 100 (`query` on the personal repositories list; `allRepositoriesAccess` on the selection state and the replace request). New read tools work without a sandbox: `organizations_list`, `owner_repositories_list`, `workflow_runs_list`, `workflow_run_get` and `workflow_job_logs_get` (bounded, tail first, paged, read with HTTP ranges from the log storage). `organizations_list` comes from the person's repository access, which the connection's `repo` scope allows. One shared check, `checkPersonalGitHubRepositoryAccess` in `@opengeni/core`, decides repository access for every caller, including the `gh` gateway. GitHub REST bridge bodies and commit messages (issues, pull requests, comments, reviews, merges) keep their line breaks and tabs instead of being rejected as invalid.
- 6abf872: Integration Knowledge sync is fully removed. A migration deletes the leftover Knowledge source sync tasks with their runs, sync state and wakes, and any saved `knowledge_source` facets; Automations no longer show "Sync retired" and the integration facets panel no longer shows "Retired" sources. Native Google Drive and Atlassian source connections left from the old sync stay hidden and inert; the generic connection DELETE still revokes them. Schedules only run agent turns. The native Google Drive and Atlassian source OAuth, callbacks, lifecycle and source routes are gone; Google Drive, OneDrive and Atlassian keep working through their agent-tool connections.

  - Removed internal entry points: `@opengeni/documents/google-drive`, `@opengeni/documents/atlassian` and `@opengeni/contracts/google-drive-native-retirement`. `@opengeni/contracts/knowledge-source-sync-retirement` now exports only `KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE`, and `@opengeni/contracts/atlassian-native-retirement` only the historical tool names.
  - Removed internal `@opengeni/contracts` root exports: `KnowledgeSourceSyncScheduleControl`, `scheduledTaskKnowledgeSource`, `requireScheduledTaskKnowledgeSource` and `knowledgeSourceAgentConfig`.
  - The `OPENGENI_GOOGLE_DRIVE_CLIENT_ID`, `OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET`, `OPENGENI_GOOGLE_DRIVE_SYNC_*`, `OPENGENI_GOOGLE_DRIVE_PROVIDER_*`, `OPENGENI_ATLASSIAN_CLIENT_ID` and `OPENGENI_ATLASSIAN_CLIENT_SECRET` settings are no longer read.
  - Public SDK surface is unchanged until the next major: `browseAtlassianSources`, `saveAtlassianSources`, `setAtlassianLifecycle`, `transitionGoogleDriveLifecycle`, `browseGoogleDriveFacetSource`, `saveGoogleDriveFacetSource`, `disconnectGoogleDriveConnection`, `CreateKnowledgeSourceSyncScheduledTaskRequest`, `agentConfig.knowledgeSource` and `KnowledgeSourceSyncRunSummary` are deprecated. Their routes answer 410, except `disconnectGoogleDriveConnection`, which now revokes through the generic connection DELETE.

### Patch Changes

- 9bb1b56: Chats bound to an agent revision (`sessions.agent_prompt_revision`) get the agent's Instructions as their own system-prompt layer, with a short preamble saying they grant no extra authority, and with `experimentSystemPromptCacheSplit` on and the deployment persona every chat of one agent shares a cached prompt prefix. An edit made during a chat reaches the model as a developer history item before the next turn instead of rewriting the system prompt, and compaction folds the newest revision back into the prompt. A deleted agent leaves a plain chat. Migration 1276 refuses such chats to workers that do not add the layer; the chat waits for a Resume or a new message rather than failing. Chats that are not bound to an agent are unchanged. New exports: `AGENT_INSTRUCTIONS_PREAMBLE` and `agentInstructionsLayerContent` (runtime), the agent instructions context helpers (contracts), `readSessionAgentPrompt` and `ensureSessionAgentInstructions` (db), and the `agent_instructions` model-context layer id (contracts and sdk).
- 10ee575: Connected Machine agent updates now target only a published release and stop waiting forever for open browsers. Unpinned, a deployment followed its source tree's agent version, which is raised when an agent change lands and published later, so machines were asked to install a release that did not exist yet and failed with `manifest_download_failed`. The API now checks that the release's signed manifest exists and otherwise targets the newest published patch release below it; a pinned version is used as set. The install routes (`/agent/latest/<asset>`, `/agent/stable/manifest.json`) and the Machines page name the same release. A retryable failure such as a failed download is retried after 10 minutes, doubling after each further failure for the same release up to 6 hours, instead of hourly. An agent older than 0.1.58 closes its managed browsers when it updates, so its automatic update used to be postponed whenever any browser was open, which on a shared machine could be forever. Now browsers whose sessions have no turn underway (and are not waiting for input within one) do not hold the update. Once browsers in use have held the update for a day, they get a closing time 30 minutes later, every browser observation an agent gets from that machine says when its browser will close, and the update is requested then; a busy refusal keeps that announcement for 30 minutes, after which an update that did not happen ends the announcement and the wait starts over. Migration 1270 adds `enrollments.agent_update_browsers_wait_since`, `agent_update_failed_attempts` and `agent_update_browsers_close_at`.
- 71395d6: Agents in the app: the sidebar's **Agents** page replaces Bot templates and the Slack agents list (All / Yours, New agent, Import, banners for the move and repeated names), with a page per agent (Chat, Export, its chats, Instructions, First message, Memory, who can use it, and Slack availability per installation through a host slot). The new-chat composer has an agent chip and `?agent=<id>` links (`?botTemplateId=` still works) that fill in the agent's First message and start the chat with `agentId`. Send waits while the agent loads and never starts an ordinary chat in its place; an agent that can't be used here shows why on the chip. An untouched First message stays out of the saved draft, so it never reaches another tab or device without its agent. An Only me agent makes the chat Only me while it is chosen. Agent chats show the agent beside the title with a source line, and the chat header's ⋯ menu has **Make this an agent** (prefilled with the chat's name, icon, description and instructions). **Export** saves an agent as an `.agent.json` file with its Instructions, First message, Memory switch and who can use it; Import reads it (an Only me agent stays Only me where Only me chats are available) and older `.bot.json` files. Renames: the chat's Agent tab is Settings, Connected agents is Connected apps, and Automations runs tasks on a schedule.

  For embedding apps: `SessionHeader`'s `onSaveBotTemplate` is now `onMakeAgent`; the create option `bot` (`NewSessionBotProfile`: name, description, avatar) is now `agent` (`NewSessionAgent`: the agent's `id` and the `avatar` the chat shows); `NewSessionBotProfile` is removed. New modules under `app/components/agents/*`, `app/lib/agents`, `app/lib/composer-agent`, `app/lib/agent-avatar` and `app/lib/session-agent`; `app/components/bots/*` and `app/lib/bot-templates` are removed.

  `CreateSessionRequest` in the SDK now types `agentId`. The archive refusal for Keep this chat active points to the chat's Settings tab.

- 80ff42d: An attached Chrome profile id now resolves only to copies announced by the same computer. A profile id is announced by the machine and stored per workspace, so a machine someone else enrolled in a shared workspace could announce the id of your Only me profile and, in that workspace, take its place in your list and receive your new browser and computer sessions. Copies now collapse only when their enrollments share the machine's key, your own personal enrollment is preferred over any shared one, and an id announced by different shared machines is refused unless a session pins its workspace, with each machine's copy listed.
- 276001c: An automation run in a chat now reads as what happened, not as its instructions. A run shows one plain, centered line (the automation's name and what the event that started it says, for example "Ticket assigned to you: T-4907 Refund request from Contoso"), then the agent's answer. The pending and delivered events for a run now carry the automation's name as their summary, plus `automation: {name, eventSummaries, eventCount}` on the member, so the instructions never reach a chat; the agent still reads them in the update as before. Older runs read "Automation run".

  A run with nothing for the person stays out of the chat. New occurrences tell the agent to answer exactly `NO_REPLY` when nothing needs the person, and the web and native timelines then draw neither the run's line, its work nor its answer; the token itself is never drawn anywhere, even while it streams. `NO_REPLY_SENTINEL`, `isNoReplyText` and `mayBecomeNoReplyText` come from `@opengeni/contracts/no-reply`, shared with Slack replies.

  `agentSignals={false}` on `SessionConversation`, `MessageTimeline`, `NativeSessionScreen` and the native `MessageTimeline` now also keeps turn rows to their status (no step preview or host `turnSummary` facets) and shows an automation run as only its line and answer: no work row, nothing while it works, and nothing for a failure only an operator can fix. `automationRunOutcomesOnly`, `automationRunLine`, `isAutomationRunBatch` and `readableWorkIsEmpty` are exported for hosts that build their own timeline.

- 336970a: A queued turn no longer waits two minutes when the session's pre-turn peek attempt is lost. Every session run peeks at durable session state on the control queue before it dispatches a turn; that activity used the general two-minute control timeout, so a lost or stuck attempt was retried only after two minutes while the turn queue showed no backlog. The peek now has its own 15-second attempt bound with the same unbounded retry.

  Migration 1274 grants the runtime role EXECUTE on the queued-turn hold summary that 0988 withheld, and readiness now requires it. The control worker therefore publishes `opengeni_turns_queued_by_hold{hold}` and `opengeni_turns_queued_oldest_age_seconds{hold}`; the `ready` class shows prompts waiting for dispatch wherever they wait, including before a turn-queue task exists. The startup-queue alert, launch runbook and worker-fleet dashboard now point at it next to the eligible turn backlog. The turn-slot gauge help explains that an idle worker's reserved slots are its open polls, which take turns as they arrive.

- f12070a: A turn that waits a long time for subscription capacity is no longer silent, and switching the chat's model or pausing it now releases the waiting turn.

  A wait is long when its reset is at least 15 minutes away, unknown, or needs a person. When one starts, a worker's parent gets a `child_waiting_capacity` notice right away: it now carries `resetsAt`, names the provider correctly, says how to continue sooner (switch the worker's model with `session_set_model`), wakes the parent instead of waiting for its next turn, and the worker delivers it as soon as the wait is armed. A top-level chat's person gets an inbox notification with the reset time, withdrawn when the wait ends. Short waits stay quiet. `OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED` now defaults to on; every image since August 2026 understands these notices.

  Switching a chat's model moves a turn that is waiting for capacity onto the new model in the same commit, and the turn continues there now (the `session_set_model` receipt reports `capacityWaitingTurnContinuesNow`). Pausing a chat stops its capacity-waiting turn: the wait is removed and the turn waits for Resume, or for a model switch, like a paused running turn. A workspace pause still keeps the wait for Resume.

- 2a02889: A meeting's audio is now kept as one compact file per track: Opus at 16 kbit/s mono in MP4, about 7 MB an hour. Before, a meeting kept both its uploaded one-second pieces and a full prepared copy at 30 to 66 kbit/s. Once the compact file is stored, the worker deletes the track's uploaded pieces, and re-runs and speaker matching read the compact file. Models that name no audio formats get the same Opus in WebM. Existing meetings are converted by the retention sweep once a later release grants its new inventory (migration 1240 withholds it for one release). Dictations are unchanged.
- f21e253: A compaction-only turn, such as the idle compaction checkpoint after a person's turn or an idle `/compact`, now runs with that person's current connection accounts, resolved the same way as other work that continues the turn. The compaction request normally carries the same account-routed connector and personal tools (such as personal GitHub) as the turn before it, so it reuses that turn's cached prompt prefix instead of missing the cache. A picked account that can no longer be used leaves its connector out. A private chat lends only its owner's accounts, and a turn from an external link or under a credential restriction lends none. If the accounts can't be resolved at all, the compaction still runs with only the session's shared tools and the worker logs a warning.
- a505ce8: OpenAI-compatible endpoint models can now reason at the levels they support. When a model is connected, Opengeni reads its levels and default from the endpoint's own `/models` listing (`supported_reasoning_efforts`, with the default in `default_reasoning_effort` or `reasoning_effort`), and an organization administrator can set or re-read them from each model's **Reasoning levels** button. The model picker then offers exactly those levels, and each request sends the chosen one as `reasoning_effort` (a level the model doesn't declare is sent as the nearest declared one below it); a model without levels gets no reasoning parameter, where before compatible requests carried whatever level the turn had, without any way to choose it. The reasoning text and cached input tokens these endpoints return are read back as on other Chat Completions routes. Organization endpoint models carry `reasoning` (`OrganizationCompatibleEndpointModel`); connecting an endpoint or adding a model accepts an optional `reasoning`; a new `PUT …/endpoints/:connectionId/models/:customModelId/reasoning` route and the SDK's `setOrganizationCompatibleEndpointModelReasoning` change them; and a workspace compatible connection's `directModelProvider` accepts an optional `reasoning`.
- 9b96f0e: Fresh compute sandboxes can now start with a Sandbox Environment's setup already done. Verification captures the set-up sandbox as a compute template, proves it with a separate cold boot, and new sandboxes start from it. Previously, every fresh compute sandbox ran the whole setup script again. Only environments with a setup script get a template. A template is tied to the compute image name and the deployment revision, so each release builds a new one. On compute, a version with setup that has no template, a failed or stopped build from an earlier release, and a build abandoned mid-way each ask once for a background build; a failed build of the current content waits for the next release. A build deletes only a template it created and no other build now owns. A capture is requested once and, if its answer is lost, found by name. A turn looks up the compute team once with a short timeout and remembers a failure briefly; a build never reuses a turn's failed lookup. A template deleted after it was chosen falls back to the plain image and the ordinary setup.
- 1ee6ee2: A compute sandbox whose guest agent stops answering is restarted where it is: its host ends its VM, forgets any saved memory image and boots it again from its files on the same host, without first archiving it (memory included) to object storage. Before, a restart was a hand-off of the whole sandbox, and on a slow store that archive could take hours while the host refused every wake, so every command failed with "sandbox was not ready". A hand-off that is still storing after two minutes now gives way to a wake: the wake cancels it and the sandbox runs on from its local copy, which stays the newest copy. Hosts also tell the server through the agent link while they hand a sandbox off; the server then no longer restarts that sandbox as unresponsive (the agent sees a plain "being moved or saved by its host" status instead of a restart loop) and `sandboxes_list` shows it as recovering, with `hostBusy: "handing_off"`, instead of ready. An older host without in-place restarts still gets the hand-off restart.
- a2abf51: Drain save fallback follow-ups. A save that lands just before (or right after) the drain stops a box whose saves kept failing is now an ordinary saved teardown: the drain waits briefly for it after the stop, and the cold commit re-checks the claim's publication under its lock, so the chat no longer shows "Files changed after {time} couldn't be saved" next to a fresh save. A reduced save whose hard bound expired keeps the lease's only capture slot until its tar has actually returned, so a retry never starts a second tar beside it; past the hour of failures (or in the save window) the next drain stops the box instead. The "restored from an older save" notice is now pending on the lease until it is written and is retried at the next turn start, so a failed write is delivered exactly once instead of being lost. Compute and OpenSandbox workspace tars use the same anchored, glob-escaped exclusions as the workspace fingerprint (`workspaceTarExcludeArgs`), so a nested folder with an ephemeral path's name, or a path containing `*`, `?` or `[`, no longer makes a restore unverifiable.
- 06606ef: A Modal sandbox whose drain snapshots keep failing no longer drains until the provider kills it. After three failed snapshots over at least 15 minutes (or one inside the pre-deadline save window) the drain saves the workspace without rebuildable folders such as `node_modules`, `.next`, `.venv` and caches (`omittedPaths` on the archive descriptor); the chat shows which folders were left out and the next turns' model input carries a note to rebuild them. The drain stops the box itself when that save fails or cannot be stored after an hour of failures or near the box's lifetime limit, or when near that limit it is still running at the end of the wait or cannot be tried at all; the chat then shows "Files changed after {time} couldn't be saved before this chat's workspace machine shut down." A re-armed box's drain failures no longer carry over to its next drain. New counter `opengeni_sandbox_drain_capture_fallback_total{backend,outcome}`.
- 8b01834: Drop the tables of the retired automation intake and PR-review pack, with any rows those removed features left behind, after the readiness-compatible predecessor release. Current event sources, schedules, and automation templates are unchanged. An unexpected dependency still stops the migration instead of cascading into live objects.
- d7252be: Retire the removed provider pools' capacity-waiter, credential, lease and settings tables, the per-account provider switch table, the old Variable Set tables and the retired resumable-transcription tables after the compatible predecessor release. Remove their obsolete routines and subscription session columns, preserving current subscription connections, shared capacity waits, Rig and Connected Machine authority, current recordings, accepted execution records, retention obligations and historical lifecycle-backfill inputs. The subscription-core gates that read the switch table now check only the provider registry, and new organizations keep their seeded subscription settings. Personal Variable Sets retire as their owner's revoke did: their authority and still-active grants are revoked, and grant history stays. Refuse contraction while any old secret values, live legacy leases, organizations without every provider switched on, transcription processing or unconfirmed audio-object deletions remain.
- b271f6d: An MCP event source whose provider's sign-in service is temporarily down no longer tells people to reconnect. The token resolver now reports a refresh that failed for a passing reason (token endpoint unreachable, 5xx, 408 or 429) through a new `onTransientRefreshFailure` option, and such a failure is retried like any outage and, if it lasts, reported as the service not answering. A rejected grant, or an access token the provider refuses when there is nothing to refresh it with, still asks to reconnect.
- b631728: An expired connector account is no longer invisible. When a refresh token is rejected and a connection moves to `needs_reauth`, the turn that hit it posts one inbox notice to the person who started that turn ("Gmail needs reconnecting", naming the account), deduplicated per connection. The turn notice for unavailable connectors now lists the accounts that need reconnecting with the day they stopped working, and `capability_catalog_search` says the same in the item's setup text and a new `setup.reconnect` list. `capability_authorization_request` takes an optional `connectionId` (picked automatically when exactly one account can be reconnected) and posts a card that reconnects that same account, instead of a fresh Connect card that could not finish because the account was already connected. The web and native cards show "Reconnect <service>" and skip the ownership choice.
- 217bd09: A session's full access now applies only to turns the person who gave it caused: their own messages, and continuations (goals, schedules, child results, inbox deliveries) whose recorded causal person is them. In a turn another workspace member caused in the same shared chat, `resolveSessionAppActionAuthority` resolves exactly as it would without full access, to that member's own confirm or read-only app actions, and the session tools refuse chats in the granter's other workspaces. The tool listing still follows the session's grant, so it doesn't change between turns.
- 8a8864c: `gh` in a managed sandbox acts as the person on repositories mounted through Your GitHub, as on their own computer: `gh repo`, `gh pr`, `gh run`, `gh workflow`, `gh issue`, `gh release` and `gh api` all work. A new personal GitHub gateway on the API (`/v1/github/personal/gateway/{api,uploads,git}/...`) adds the person's token per request after checking the session's short-lived broker pass, the connection, the repository allowlist and repositories removed from the chat; the token never enters the sandbox. The sandbox `gh` wrapper runs `gh` against the gateway through a per-command local proxy, and `gh repo clone` clones through it. Each request maps to the existing GitHub action policy, so one Allow/Ask/Block setting covers the `github_personal__*` tools and `gh`: reads pass, ordinary writes follow the policy, and destructive or unrecognised requests always ask. A request waiting for approval fails with a clear message and the normal approval card, and the exact same request runs once when sent again after approval. Git pushes as the person that delete a ref or force-push now ask. Sessions without a repository mounted as the person, Opengeni app repositories and Connected Machines are unchanged. The agent prompt tells the agent that `gh` acts as the person there.
- b05587f: A workspace's GitHub App repositories now follow GitHub. A repository added to a bound installation, including a new repository of an "All repositories" installation, appears for the whole workspace without reconnecting, and one removed from it stops being usable at once. The App's `installation_repositories`, `installation` and `repository` webhooks update every bound workspace (even with event triggers off), and every repository listing applies the list GitHub just returned, so a missed webhook repairs itself. Opening the new-chat repository menu re-reads the list. Bindings still need the original owner proof; following GitHub's later selection is the delegated behaviour, documented in `docs/github-app.md`. New Apps also subscribe to `repository` events.
- 3345899: HEIC/HEIF photos (the iPhone camera format) now reach the model as an image. No model provider accepts HEIC, so an attached iPhone photo used to arrive as a file reference only and the agent had to convert it in its sandbox before it could look at it. The worker now decodes HEIC/HEIF attachments with libheif (WebAssembly) and shows them to the model as a JPEG, downscaled to the message's image bound like any other photo, with a note that the file itself is the original HEIC. This works for every upload path, including untyped `.heic` uploads, which qualify by their bytes. Messages are stamped with the converted formats when they are accepted, so images in earlier requests never change; older messages keep their reference-only receipt. `view_image` in the sandbox now converts HEIC/HEIF files the same way instead of answering that they are not a supported image.
- b5d8da2: Repeating an organization invitation accept with the same operation id now returns the stored result without granting the invitation's initial shared workspaces again, so a member an administrator removed from one of those workspaces stays removed. Only the call that performs the acceptance grants them.
- ca69414: An MCP event subscription that polls now moves to webhook delivery once it can. Before, a subscription stayed on polling forever once it polled, so one created while its server offered only polling never moved to webhook after the server added it. Each subscription now records why it polls: `not_offered` (no webhook delivery on offer when last checked) or `callback_failed` (a webhook subscription failed), with the time (migration 1296 adds `poll_reason` and `poll_reason_at`). A polling subscription moves to webhook when its event type offers webhook and the deployment has a webhook address, unless its webhook failed less than a day ago; then it keeps polling and tries again after the day. The move subscribes with the last poll cursor, so the server replays what came after it and events are deduplicated by event id as before: nothing is lost or delivered twice. It stops polling only once the subscribe succeeds; if the attempt fails for any reason other than a sign-in or a refusal a person has to fix, the step polls instead and records `callback_failed`. A kept MCP session now reads the server's event types again at least hourly, so a newly offered delivery mode is noticed. Rows an older release moved to polling have no reason and are treated as `not_offered`.
- 9ea4868: A Modal sandbox whose `/bin/sh` is gone now recovers by itself. Modal runs every command through `/bin/sh`, so once the agent deleted it, every command failed with Modal's raw exec error, which repeats the whole command. The box stayed broken until it had been idle long enough to drain, and an open viewer could keep it alive. Now, when platform setup finds that the box cannot start programs, the worker checks that a trivial command also fails. It then asks the lease to replace that exact box, at most once per turn. New turns wait instead of reusing the box. The reaper saves `/workspace` with Modal's own snapshot, which needs no command in the box, and ends the box. The same turn then continues on a fresh box restored from that snapshot, shown as "Workspace machine restarted". If the fresh box still cannot start programs, or the replacement cannot be requested, the turn stops with the existing short message. If the box's save fails, the turns waiting on the replacement do not wait for it: they stop with "The workspace machine can't start programs and its files couldn't be saved yet. Opengeni will replace it once they're saved; retry then." A retry before the box is saved stops the same way. The box stays fenced, so no turn reuses it, and the existing capture policy keeps retrying the save. A command the model runs on such a box now returns a short explanation instead of Modal's command dump.
- bb33f35: Releasing the turns that wait on a Modal box whose save failed no longer deadlocks with ordinary session writers. The release locked each waiting turn first, then its session: clearing the wait fires the turn's archive guard, which locks the session. Every other writer locks the session first, then its turns, so a writer such as turn recovery that held a session and then asked for its turn deadlocked with the release, and PostgreSQL aborted one of them. The release now finds the waiters without locking, locks their sessions and then their turns in id order through the shared event-write lock helper, checks again that each turn is still waiting, and wakes the sessions in id order.
- a31cd5d: Model usage is now charged its full price after use. Agent turns and single model calls used to settle through `applyCreditDebitUpToBalance`, which debited at most the eligible balance left at settlement, so parallel or long calls that cost more than what remained were recorded as usage but never fully charged. They now settle through `applyCreditDebitAfterUse`, like voice input, Knowledge search, web search and Sites: covering promotional and plan credit pays first where it is eligible (with the credit policy revision the call was admitted under), API-origin use is still paid from credits only, and any shortfall takes general credit below zero, which later grants and top-ups net against. Admission is unchanged. A retry never charges a settled response again, including a zero-cost or capped receipt written by an earlier release. `applyCreditDebitAfterUse` accepts `creditPolicyRevision` and returns `grantDebitedMicros`; the unused `applyCreditDebitUpToBalance` and `planCreditDebit` are removed.
- 432bccf: When a session no person owns posts a notification and a workspace or organization webhook receives it, notify_user now tells the agent it was handed to that integration instead of reporting it as undelivered.
- 7ab60df: Connecting a model provider is now the same on the organization's Models page and on a workspace's: Connect provider lists the same providers in the same order (Codex, Claude subscription, SuperGrok, Azure OpenAI, OpenAI API, Anthropic API, OpenRouter, Vercel AI Gateway, Opper and Custom endpoint), each opening the same connect step. Only where the connection lives differs: organization owners and admins connect an organization account and choose its Available in; a shared workspace's admins connect Azure OpenAI, OpenAI and custom endpoints as that workspace's own keys from the same steps (they used to get a shorter list and a separate form lower on the page); anyone else sees API-key providers listed but disabled, with who can add them. The separate "OpenAI, Azure OpenAI and compatible endpoints" section is gone; a workspace's own keys are listed with its other accounts and disconnect from their row.

  Azure OpenAI is one step: endpoint, deployment name and key, checked together with a short test message before anything is saved, so it ends with a working model. Pasting any address Azure shows for the resource (Cognitive Services or Foundry endpoint, or a deployment's Target URI) reads as its `https://RESOURCE.openai.azure.com` endpoint, and a Target URI fills in the deployment name. OpenAI asks for its first model the same way.

  API: `PUT /v1/organizations/:id/model-providers/openai|azure_openai` accepts an optional `models` array (up to 16 model IDs or deployment names). Each is checked with the key (or Entra sign-in) in the request before saving, and they are saved with the connection in one transaction; other provider kinds refuse it with 422. Requests without `models` are unchanged.

- 1b8dc89: Migration 1272 grants the runtime role EXECUTE on the organization vault list (1218) and the organization machine and rig list (1224), which both withheld it for one release. Readiness and provisioning now require them, and `GET .../organization-vaults`, `GET .../organization-machines` and `GET .../organization-rigs` always list every organization one wherever it works. Their `complete` field is always `true`; servers before 1272 could list only the ones that work in the requested workspace and sent `false`.
- 7d86f8b: An organization can connect its own OpenAI-compatible endpoints (a public HTTPS base URL, an API key and model IDs) as organization model accounts, from the same Connect provider list as its OpenAI, Azure OpenAI, OpenRouter, Opper and Vercel accounts, with the same "Available in" step, and it can connect several. Their models reach workspaces like the other organization accounts, billed by the provider with no Opengeni credits, and every request to them stays DNS-pinned to public addresses without redirects. New routes under `/v1/organizations/:id/model-providers/openai_compatible/endpoints` list, connect, re-key and disconnect endpoints and add or remove their models; the SDK adds `listOrganizationCompatibleEndpoints`, `createOrganizationCompatibleEndpoint`, `replaceOrganizationCompatibleEndpointKey`, `revokeOrganizationCompatibleEndpoint`, `createOrganizationCompatibleEndpointModel` and `deleteOrganizationCompatibleEndpointModel`, and model connection access accepts `openai_compatible`. The first sign-in model step offers it too. Workspace-only compatible connections made before keep working and stay listed on their workspace; new ones are connected for the organization.
- c663db0: A recovering session whose interrupted attempt lost its quiescence receipt is now re-woken by the workflow-wake reaper two minutes after its last delivered wake instead of ten (migration 1260), so it recovers about four minutes after the close. The ten-minute wait coincided with `OpenGeniSessionRecoveryBacklogStale` (ten minutes past due), so a normal self-repair paged. The windows are exported as `QUIESCENCE_REPAIR_CLOSE_GRACE_SECONDS` and `QUIESCENCE_REPAIR_WAKE_QUIET_SECONDS`, and a test keeps the alert clearly longer than the worst-case repair.
- c8c10a8: A run with nothing for the person now leaves no trace for them. When a turn's answer is exactly `NO_REPLY` (for example an automation run that found nothing to do), the chat is not marked unread, no inbox reply item opens and no phone notification is sent. The run stays in the session's history. Migration 1289 changes the event cursor, inbox and push triggers; the web and native read-acknowledgement predicate follows the same rule.

  A finished turn's phone notification now carries its answer, the same text the chat shows, instead of "The agent replied."; a turn with no answer sends none. Events that arrive close together already start one run, so they give one answer and one notification.

  Internal IDs hidden from displayed system text no longer leave broken text behind. An ID now goes with what only named it: its label ("Organisation: <id>"), or a parenthetical that held only it ("(run <id>)"), and the punctuation around it is tidied, so "Connected. Organisation: <id>." reads "Connected." This applies to update summaries and to what an automation run's event says, on web and native.

- 386586f: Live-voice minutes now count against the usage allowance of the member who started the call, as voice input already does. Previously a live-voice debit moved only the workspace counter, so a member allowance never filled from live voice and its heartbeat stop and admission refusal never applied. The usage-event trigger now records an attribution receipt for each live-voice cost event, and the debit trigger reads it for the matching debit (same source, key, amount and debit type); debit metadata alone is still not trusted. Live-voice minutes billed before this release are not recounted.
- 9420c9b: Existing meetings' audio is now converted to the compact kept format too. The recording retention sweep converts a few tracks per run to one Opus file per track and deletes their uploaded pieces, as new meetings already are.
- 99e117e: Deleting a recording now takes its speakers' voices back out of the workspace voiceprints they taught, as renaming a speaker already did. `markRecordingDeleting` subtracts every learned voice and drops the recording's stored speaker voices in the same transaction that hides the recording. A person whose only samples came from deleted recordings is no longer remembered or suggested in other meetings. A retried deletion subtracts nothing more, and it releases the voices of a recording that was already marked as deleting.
- ba482ea: Archiving a chat no longer silently stops sub-chats that are still in use, and archived chats can be restored. Archive is refused (409 `session_archive_blocked`, blockers of kind `active_sub_chat`) while a sub-chat is running, waiting for input, working on a goal or was messaged by a person in the last 14 days; the refusal names each one with how many, and repeating the request with `confirmActiveSubChats` listing them archives them too. In the web app a notice names them and offers "Archive all". `{ "archived": false }` now restores a chat at any time: within the undo window it is the exact undo, and later the chat and the sub-chats archived with it come back, with content already in long-term storage put back from the verified bundle in the background (`retention.archive.restoring` until done). A restored chat whose running work the Archive stopped is put back to idle and resumed, so it takes new messages again; the turn the Archive cut off reads as interrupted. Archived chats show a "Restore chat" button.
- b1b8f58: A scheduled task created over the API can now choose the Opengeni tools and permissions of the chats it starts, as on session create: `agentConfig.firstPartyMcpTools` and `agentConfig.firstPartyMcpPermissions` (tools within the deployment's allowed set, permissions the creating credential holds). They are stored as the task's creator selection, set once at creation (an update that names them is refused) and never on an existing-chat task. Before, these fields were dropped and every run got the full default tool list. Tasks that don't name them keep following the defaults. The schedule tools agents use are unchanged: an agent's task keeps its own chat's selection. A run of an ownerless task (created by a key or service, not as a person) is no longer offered `notify_user`, `notification_withdraw`, `inbox_tidy` or `call_user`, since nobody could receive them, and its chat keeps that exact tool list. Owned tasks' runs still notify their owner.
- 9c65c34: A session no longer stays stuck when its turn worker goes away in the middle of a tool call. Before, only owned-box setup that a shutting-down worker left open was settled, so a file write, editor change, command or stdin request cut off by a worker restart kept `reconcileSessionAttemptQuiescence` answering `pending` on every wake, and neither the interrupted turn nor queued messages ever ran. Once Temporal proves the attempt's activity settled and the turn worker's process-exit deadline has passed since its `worker_shutdown` closure or its worker-death closure (`lease_lost_recoverable`, or `failed` after the redispatch limit), every one of the attempt's own requests that has no holder and no retained process is settled `rejected` (never replayed), and the session is woken so the interrupted turn resumes or the next input runs. Pause, Steer, cancellation, other closures, retained commands and setup with a recorded-unknown start keep their gate.
- 57748cf: Opening a Slack identity link no longer links the Slack account on its own, for anyone. Preparing a link (`POST …/integrations/slack/user-link-intents`) now always returns the prepared request with `slackAccountLabel`, naming the Slack account, and `canLink`; the link completes only when the person confirms it with `POST …/user-link-intents/:requestId/link` (`linkSlackUserAsOrganizationMember` in the SDK) at the request's `version`. This applies to people who can already use the workspace as well as to organization members without workspace access, and the web app now asks them to confirm which Slack account they are linking. `organizationMemberLink` is deprecated in favour of `canLink` and `slackAccountLabel`. The unused `POST …/integrations/slack/user-links` route, which linked on first use, is removed.
- 54e9620: Files from a private Slack session now belong only to the person it belongs to. A bot DM or private handoff session was already visible only to its owner, but the images they attached to it and the files and screenshots its agent produced were ordinary workspace files that other members could list and download. Images imported from a private Slack interaction and files produced by agents in a session whose root a private Slack interaction owns now get that person as their private owner, as in an Only-me session; the Knowledge learning destination is unchanged. The session screenshot routes (`/sessions/:sessionId/artifacts/:artifactId` and its `/content`) now apply session read authorization to every caller, not only agent attempts, and answer a session the caller may not read like a missing artifact. Files created before this change keep their existing audience.
- 04d36ce: A configured agent is sent `goal_resume` and its prompt sentence only once its session has a goal (in any state, so pausing or resuming never changes the tool list); the effective-tools projection follows the same rule. The "Images and video" guidance is left out when no image or video tool is attached, and the blocked-tool sentence mentions a setup card only when the agent has a capability that can show one.
- 1a207de: The Microsoft Teams bot now has a first-run, help and AI experience. Adding it in personal scope sends one welcome that says what Opengeni does, that replies are AI-generated, that an Opengeni account is needed, its main limitations and how to get help. `help` is answered with fixed text in Teams, for linked and unlinked people, without starting agent work, `link` asks for a fresh account link, and `unlink` (with a confirmation button) removes your Teams link from inside Teams. Teams shows a typing indicator while a reply is being produced. Replies are sent as Markdown, with tables, deep headings, images, rules and tag-like text rewritten into what Teams text messages can show. Agent replies carry Teams' AI generated label and thumbs up/down feedback buttons, and feedback is recorded as ordinary Opengeni feedback on the chat and turn.
- 3ef0bd4: When the Teams bot is @mentioned in a group chat or channel thread, the agent now sees the recent messages it was not mentioned in, as Slack already does. A package built with `OPENGENI_TEAMS_APP_CONVERSATION_CONTEXT=true` asks for the `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` resource-specific permissions, so Teams delivers every message in a conversation where the app is installed; Opengeni keeps a bounded recent window, follows Teams edits and deletions, and attaches it to the mention. Only a fresh @mention still triggers a reply. A follow-up mention in the same channel thread now continues that thread's chat instead of opening a new one. Team-scope packages now declare `supportsChannelFeatures: "tier1"`, which the Teams admin center requires for manifest 1.25 uploads.
- 84647c6: Every 1:1 message and install in Microsoft Teams now gets a reply with a way forward. In an organization that hasn't connected Opengeni, `help` and `unlink` carry the Connect your organization button (or tell non-admins to ask their admin), and once a person's or tenant's cards are used up, a short reminder to send `help` answers instead of silence. A personal Microsoft account is told that Opengeni needs a work or school account. A linked person who can't start chats in the connected workspace is told why and to ask a workspace admin for access, and `unlink` from someone who isn't linked offers linking. The not-available notice names `OPENGENI_SUPPORT_EMAIL` when it is set, and help and the welcome name it when there's no self-serve setup. A 1:1 message with only a file, an image or no text is told to send the request as text. Short reminders no longer have a per-person cooldown (they stay capped per person, tenant and deployment). Mentions in a group chat or channel that isn't turned on, or in an organization that isn't connected, get a short reply, at most one per person a minute, and a person who can't start chats is pointed to their 1:1 chat there. Onboarding reply limits are now counted in the database across API replicas (migration `1300_teams_bot_onboarding_limits.sql`) instead of per replica, falling back to memory when the database can't be reached. A reply Teams refuses is given back to the person's and tenant's counts only, so the deployment-wide hourly cap still bounds retries; a throttled reply keeps every count, so one person flooding their own chat can't use up other tenants' replies.
- 0b91aac: Replies the Microsoft Teams bot sends itself (help, link, unlink, the link card, onboarding replies, reminders and notices) now go out once per message across API replicas and redeliveries. Teams redelivers a message after a slow or failed response; each reply is claimed in the database just before it is sent (migration `1301_teams_bot_reply_claims.sql`), so messages that get no reply write nothing, and the claim is given back only when nothing reached the person and Teams clearly refused the reply, so the redelivery can answer. Notice cards such as "Started" now carry a plain-text summary and card fallback text for clients that can't show cards.
- a531446: Opengeni's replies in Microsoft Teams render cleanly. A Markdown table becomes one list item per row, led by its first cell, with every other cell on its own nested line, instead of one line of cells joined by semicolons that ran together. Teams leaves no gap between paragraphs, so a heading or a bold heading line after a paragraph now gets a blank line before it and stays on its own line; the help and welcome text follow the same rules. Notices about a chat's session (Started, needs your input or approval, could not finish) and the refusal notices are now a card with an "Open in Opengeni" style button instead of a bare URL. In a channel thread the agent's answer after the Started card now gets its own message header with the AI label, instead of being grouped under the notice.
- de1210c: Installing the Microsoft Teams app for yourself sends one welcome (or one Connect your organization card) again. Teams may accept a message that carries a card with an empty response and no message id; the bot treated that as a failed send, answered the install with an error after the welcome had arrived, and Teams redelivered it to another API replica, which welcomed the person again. A message Teams accepts without an id now counts as delivered, and each chat's welcome is claimed once in the database across replicas and redeliveries (migration `1294_teams_bot_welcomes.sql`), replacing the per-process memory. An install no longer fails once its welcome may have arrived; Teams is asked to redeliver it only when Teams throttled or never received the send. The same fix stops card replies to messages (the account-link card, the unlink confirmation) from failing and being answered twice.
- 60a67e6: A command waiting for a workspace machine that is being saved, replaced or moved now settles as not started instead of "side-effect outcome unknown". This covers, for example, a Modal box replaced because it could not start programs. The model and the person both see "The command was not started because the workspace machine was not ready. Nothing ran, so it is safe to run it again." A command that had already reached the machine keeps the unknown-outcome receipt. The command row in the timeline now shows such a receipt as its sentence instead of raw JSON.
- Updated dependencies [9bb1b56]
- Updated dependencies [c69598a]
- Updated dependencies [7e92bda]
- Updated dependencies [8d1edfc]
- Updated dependencies [88de211]
- Updated dependencies [5dabaa2]
- Updated dependencies [d8e2bbc]
- Updated dependencies [276001c]
- Updated dependencies [0e8b3b2]
- Updated dependencies [90b961f]
- Updated dependencies [f12070a]
- Updated dependencies [56801f4]
- Updated dependencies [a505ce8]
- Updated dependencies [9b96f0e]
- Updated dependencies [06606ef]
- Updated dependencies [8a8864c]
- Updated dependencies [b05587f]
- Updated dependencies [3345899]
- Updated dependencies [11550b6]
- Updated dependencies [aa5b122]
- Updated dependencies [5853742]
- Updated dependencies [d96bc4d]
- Updated dependencies [650e54a]
- Updated dependencies [7ab60df]
- Updated dependencies [a0b081b]
- Updated dependencies [e10e748]
- Updated dependencies [1b8dc89]
- Updated dependencies [7d86f8b]
- Updated dependencies [3f64150]
- Updated dependencies [486e0bf]
- Updated dependencies [ba482ea]
- Updated dependencies [6abf872]
- Updated dependencies [b1b8f58]
- Updated dependencies [57748cf]
- Updated dependencies [04d36ce]
- Updated dependencies [3b81d9b]
- Updated dependencies [2495d3e]
- Updated dependencies [b1e049b]
  - @opengeni/contracts@6.11.0
  - @opengeni/codemode@6.11.0
  - @opengeni/config@6.11.0
  - @opengeni/codex@6.11.0
  - @opengeni/observability@6.11.0
  - @opengeni/xai-subscription@6.11.0
  - @opengeni/network@6.11.0
  - @opengeni/subscriptions@6.11.0

## 6.10.0

### Minor Changes

- c9e5547: Add opt-in owner-authorized automatic credit top-up settings, card setup and SDK methods, with durable Stripe PaymentIntent recovery and tax-inclusive UTC monthly caps. Deployment activation is off by default.
- e551a50: Open Slack agents take only linked members of the organization: `SLACK_AGENT_OPEN_LABEL` and `slackAgentOpenDisclosure` describe the narrowed access, and the new `SLACK_AGENT_OPEN_NARROWED_NOTICE` is shown next to an open agent's switch. An active organization member can link their Slack account without workspace access after confirming it: `SlackUserLinkAccessRequest.organizationMemberLink` offers it, and `linkSlackUserAsOrganizationMember` (`POST …/user-link-intents/:requestId/link`) completes it. `@opengeni/db` adds `namedSubjectIsActiveOrganizationMember` and `slackUserLinkOrganizationMemberMayLink`.

### Patch Changes

- 2caf31f: Adds the `agents`, `agent_revisions` and `agent_slack_installs` tables and the `sessions.agent_id` and `agent_prompt_revision` columns. Existing Slack agents and bot templates are copied into them and kept in sync by triggers. Nothing reads the new tables yet, so behaviour is unchanged.
- 25a0452: A stored model-context snapshot now reads back exactly as written when a stored string is itself JSON, such as a request body short enough to be stored as one chunk. Before, the model-context endpoint could return such a body as `"[object Object]"`.
- b032ab0: Drain snapshot failures are now visible. The worker records each settled drain snapshot failure with the lease's consecutive failure count (`opengeni_sandbox_drain_capture_failures_total`, `opengeni_sandbox_drain_capture_consecutive_failures`) and the `/workspace` file count and bytes when a drain snapshot settles (`opengeni_sandbox_workspace_snapshot_files`, `opengeni_sandbox_workspace_snapshot_bytes`; from the archive itself, or one bounded walk after a failed provider snapshot). New alerts fire when one lease's drain snapshot fails a fourth time in a row (`OpenGeniSandboxDrainSnapshotFailing`) and when a sandbox has been stuck draining for over an hour (`OpenGeniSandboxDrainExpiredLong`, critical). When a lost sandbox is restored from an older verified save, every chat sharing it now shows a notice with the save's time; the model's existing discontinuity instruction is unchanged.
- 2e02796: A chat computer whose workspace snapshot takes longer than the drain wait now finishes saving and shuts down, instead of retrying the same snapshot until Modal ends the box after 24 hours. The drain wait (`OPENGENI_SANDBOX_DRAIN_SNAPSHOT_TIMEOUT_MS`, or `OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS`) no longer doubles as Modal's own snapshot deadline: a drain gives the provider `OPENGENI_SANDBOX_DRAIN_PROVIDER_SNAPSHOT_TIMEOUT_MS` (default 10 minutes, and at least twice the wait), and a snapshot still running when the wait ends publishes late under its claim. After a snapshot fails, the next full attempt for the same box waits 30 seconds, doubling up to 10 minutes, and never past the start of the final save window before the provider deadline. Migration 1253 adds the per-lease count of drain snapshot failures since the last successful save that drives this backoff.
- b5a7db4: Insights usage no longer fails for every request after a chat's usage rows are deleted out of order. Deleting model call facts whose hourly rollup row was already gone used to store their amounts as a negative rollup row, which made every Insights usage read covering that hour return 500. A delete now subtracts only amounts the group holds; otherwise the group is rebuilt from its facts at commit. Migration 1252 rebuilds every hour that already holds a negative rollup row.

  An unexpected API 500 now logs its cause's message (scrubbed of credentials and bounded to 1 KiB) as `causeMessage` in the server log, so the log says why it failed. Responses are unchanged.

- fb37d99: A configured agent now pays only for what it can use on every model call. Under `capabilities: "none"` it gets a neutral introduction unless it shares a workspace, and no tool search when nothing is deferred. A configured session that cannot install the tool router (lazy tool search off for the deployment) no longer gets the Tool discovery guidance. It gets `wait_for_input` and its waiting guidance only when something can resume it (compute, children, goals, schedules, a browser, media, or a person who can answer). It gets no Skill index when it has no Skills. `request_human_input` offers the secret question only with `secrets`, Skill reviews only with Skill management, and parent-agent guidance only in child sessions. Prompt sections about web search, learning, monitoring, design choices with workspace tools and goal audits appear only with their capability. Two new capabilities, `notifications` (notify, withdraw, inbox tidy and call) and `privacyFacts` (`privacy_facts` and its prompt rule), are on under `"all"` and off under `"none"` for a session create request. Sessions stored before keep the tools they had, and saved workspace defaults and schedules that start from `"none"` keep both. The built-in meeting-summary and Site chats turn `privacyFacts` on and, with nothing that could wake them, no longer get `wait_for_input`. Sessions that have a feature get the same prompt as before; outside child sessions `request_human_input` no longer carries its parent-agent guidance. The model-context snapshot for the native Anthropic route now fills its instructions, layers and tools.
- b089060: Opengeni no longer rewrites what an agent sees to hide secrets. Tool results, model input and stored history are no longer masked for known secret values or secret-shaped text, and shaped values are no longer captured into the Task vault. Text already sent to a model is never rewritten later, so the prompt cache stays stable (each active chat takes about one cache miss after the upgrade). Secrets still flow by secret reference and resolve only where a tool runs; `secret_get`, approvals and the explicit operator scrub are unchanged. Browser page reads still leave out the values of fields that standard markup marks private (password, `one-time-code`, `cc-*` autocomplete, `data-private`), but nothing is remembered or guessed, and screenshots, recordings and clipboard copies are never refused. Tool names a provider would reject (a dotted `server.tool` call) are given a valid name once, when the call is received; run `bun run db:repair-invalid-tool-names --apply` once after upgrading to fix names stored by earlier releases.
- 6674146: A sandbox that can no longer start programs now gets a short, actionable message instead of a raw script. Before, when a machine's `/dev/null` had been removed (for example by a command that ran `rm -rf /dev/null` as root), every command failed with "not found: spawn or apply execution containment for …" followed by the whole command text, such as the Codemode client install script, and the chat stopped with that text as its error. Now the error names only the program that was started (the machine agent quotes it), never the command text, and tool output says the machine could not start the program and what to try. When the machine itself can't start programs (its `/dev/null` is gone), a compute sandbox is restarted from its disk once per turn (files are kept, running programs stop). The restarted turn continues, shown as "Workspace machine restarted". The box is checked first: unless a trivial program also fails to start, it is not restarted (another session sharing it may have restarted it already), and the turn retries as an ordinary sandbox wait; one missing program, or brief memory or process pressure on a machine other sessions may share, never restarts anything; if it still cannot start programs, or on a Connected Machine, the turn stops with a message that says what to do. The machine agent also keeps starting programs when `/dev/null` is gone: it keeps the null device open from startup and, running as root on Linux, puts a missing or replaced `/dev/null` back. Compute's control service gains `POST /v1/sandboxes/{id}/restart`, which boots a sandbox afresh from its disk keeping its files and shape.
- 116acad: Workspace Slack bot tools are listed only when the workspace has a Slack bot available, so a Slack request in a workspace without one reaches the Slack connect offer. Where a person can answer, sending a prepared bot message follows the person's own Slack send permission: Ask first asks for approval and Block blocks it.
- f45ab2f: Subscription accounts (Claude, ChatGPT and SuperGrok) now read the same everywhere they are listed. The "Use for next turn" account menu is wider and shows each account's full name and email, the plan once when every account shares it (or on each row when they differ), which account runs the next turn, and every usage window the provider reports with its short label ("5h", "Week", "Fable week", "Credits", "Extra usage"), the share left and when it resets. Nothing is assumed: a Claude Ultra or ChatGPT Pro account without a 5-hour limit shows none. Plans use the provider's current names ("Claude Max", "Claude Ultra", "ChatGPT Plus", "SuperGrok Heavy"), and a Claude Max account whose tier isn't known yet reads "Max or Ultra".

  Claude usage also follows the October 2026 plan changes: the usage endpoint's explicit `null` for a limit the plan doesn't have (a verified Ultra plan has no five-hour limit) no longer stops an early weekly reset from ending a refusal, while an omitted or `null` window still never clears a limit that refused; the separate weekly Fable limit (`seven_day_fable`) is read and cools only Fable models; and a renewed sign-in reads the plan and Max tier from the Claude profile.

- Updated dependencies [c9e5547]
- Updated dependencies [232e713]
- Updated dependencies [2a27f11]
- Updated dependencies [681bbac]
- Updated dependencies [2e02796]
- Updated dependencies [b5a7db4]
- Updated dependencies [a143aaf]
- Updated dependencies [fb37d99]
- Updated dependencies [4fc9529]
- Updated dependencies [7fb4b0d]
- Updated dependencies [b5201d5]
- Updated dependencies [b089060]
- Updated dependencies [116acad]
- Updated dependencies [e551a50]
- Updated dependencies [3b162f4]
- Updated dependencies [f45ab2f]
- Updated dependencies [9cf9b58]
- Updated dependencies [f0d27b2]
- Updated dependencies [d717b72]
  - @opengeni/contracts@6.10.0
  - @opengeni/config@6.10.0
  - @opengeni/codex@6.10.0
  - @opengeni/observability@6.10.0
  - @opengeni/codemode@6.10.0
  - @opengeni/network@6.10.0
  - @opengeni/xai-subscription@6.10.0
  - @opengeni/subscriptions@6.10.0

## 6.9.0

### Patch Changes

- ff8b164: Grant the agent-call and native push v2 routines withheld by migration 1107. Readiness now requires these grants, phones retain opted-in call rules, and calls use the VoIP-aware push functions without probing privileges or falling back to v1. Existing v1 SQL routines remain available during rolling deployments.
- 54bf495: A paused chat no longer says it is working. Its turn row reads "Paused" with the clock stopped where the pause began, and switches back to working on Resume; paused time is not counted as work. This covers a chat's own Pause, a parent's and the workspace's. Sidebar rows mark paused work with a pause icon instead of the spinner, including a parent whose workers are paused, through the new `treeStats.pausedWorkDescendants` count. A sub-chat's descendant counts now also respect its ancestors' pauses. `MessageTimeline` in both `@opengeni/react` and `@opengeni/react-native` takes the live pause through its new `pause` prop (`timelineLivePause(session.effectiveControl)`); custom timelines can use `useTimelinePauses`.
- Updated dependencies [8572155]
- Updated dependencies [54bf495]
  - @opengeni/contracts@6.9.0
  - @opengeni/codemode@6.9.0
  - @opengeni/codex@6.9.0
  - @opengeni/config@6.9.0
  - @opengeni/observability@6.9.0
  - @opengeni/network@6.9.0
  - @opengeni/subscriptions@6.9.0
  - @opengeni/xai-subscription@6.9.0

## 6.8.0

### Patch Changes

- fbb70bc: The chat now stays at the bottom while you work through approvals. Clicking a button, such as Create draft, no longer unpins the view, so the next approval card and any later growth stay in sight. Scrolling up, selecting text or opening an in-place disclosure still lets you read without being pulled down, and finishing a connect card no longer pulls a reader who scrolled up back to the bottom. Each waiting approval also keeps its Decline and approve buttons while the turn resumes, and a card that can't be decided yet says so and retries instead of showing an empty footer.
- Updated dependencies [58b04d1]
- Updated dependencies [feaecf8]
  - @opengeni/contracts@6.8.0
  - @opengeni/codex@6.8.0
  - @opengeni/codemode@6.8.0
  - @opengeni/config@6.8.0
  - @opengeni/observability@6.8.0
  - @opengeni/network@6.8.0
  - @opengeni/subscriptions@6.8.0
  - @opengeni/xai-subscription@6.8.0

## 6.7.0

### Patch Changes

- c08233e: Background commands that finish while the agent is working now report themselves. Their exit status and the start and end of their output follow the agent's next plain-text tool result (including `apply_patch` edits), and are recorded as read exactly like a terminal `command_read`, so the same result is never delivered again. The agent no longer spends a `command_read` only to learn that a command finished. The `background_command_result` input that wakes a waiting session, or reaches its next turn, now carries the same bounded output, so that turn needs no extra read either. Earlier history never changes, JSON and image tool results are left as they were, and results not delivered during a turn still arrive as ordinary input. The timeline keeps showing each tool's own output. Results only use the room a tool's own output leaves in the model's tool-output budget, and are masked for known secret values. `OPENGENI_EXPERIMENT_CUT_POLLING=false` turns the in-turn delivery off, along with the prompt sentence that tells the agent not to poll.
- e764a94: A command running on a session's own sandbox no longer has its output rejected, and its turn failed, when the session switches to another machine while the command runs. Settlement now checks the command against the route epoch it was admitted on instead of the session's current one.
- b0736b7: Opening a chat no longer waits for a slow subscription provider's model list. When a shared ChatGPT subscription's list is more than a minute old, the client config and model picker waited for a live refresh (token renewal plus the provider's model list, up to its 5 second timeout). They now wait at most 300 ms, then use the last list observed under the same credentials (or treat the account as unknown, never unavailable) while the refresh finishes in the background and records its result. The step now has its own trace span with its outcome.
- 57237db: Your GitHub keeps working past its token's 8-hour lifetime. Opengeni now asks GitHub for a JSON reply when it renews the token. Without that, GitHub answered form-encoded and every renewal failed silently. The connection still showed as connected, while Git and the `github_personal__*` tools failed with "authorization is no longer current" or "credential is unavailable".

  When GitHub refuses a renewal, which it reports as a successful response carrying an error, the connection is now marked as needing a reconnect instead of staying "connected". Temporary GitHub errors, such as `slow_down` or a server error, leave the connection connected and Git and the tools say GitHub is temporarily unavailable. The GitHub settings page shows "needs to reconnect" with a Reconnect button. A Reconnect toast stays until the person acts on it or closes it, and appears once per stale connection. Git and the GitHub tools say the person must reconnect. A repository list that couldn't load no longer reads "0 repos", and a background read that needs nothing from the person no longer shows a toast.

  Disconnecting Your GitHub always works for its owner. If the connection changed while the dialog was open, for example after a reconnect, Opengeni reads it again and disconnects the current one instead of asking the person to refresh.

- cf35731: Only the owner of a personal (Only me) login can approve an action that runs on it. An approval runs on the accounts its message froze, so before this any member, workspace API key or Slack click by someone else could make an action happen as another person. The owner's personal API key and `asUser` tokens count as the owner. Approving such an action as anyone else now answers 403 with `details.code: "APPROVAL_REQUIRES_ACCOUNT_OWNER"` and a message naming who can approve (the SDK adds `isApprovalRequiresAccountOwnerError` and `APPROVAL_REQUIRES_ACCOUNT_OWNER_CODE`); declining stays open to anyone who can control the chat, and actions on workspace logins keep their ordinary rules. A tool review adds the optional `approvedBy` ("you" or "account_owner") and `accountOwnerLabel` fields, and the review card says who can approve, or tells the owner in a shared chat that the decision is theirs. Slack cards for anyone else offer only Decline, and the desktop and mobile apps show or route a refused approval instead of failing.
- af08d2a: Editing someone else's queued message now makes it the editor's own message. Before, resubmitting the edit copied the original sender's identity, own (Only me) logins, account choices and model allowance, so another member could run their own words through the sender's personal accounts, and a workspace API key's edit failed with a server error. The edit now runs as the editor, with the editor's own logins and allowance; the sender's own edits are unchanged.
- d7a740f: An agent in a scheduled run with no human owner can now create, publish, roll back, archive and restore Sites in its own workspace. The exact live attempt, the selected artifact tool and `artifacts:publish` still gate every change, and such artifacts are shared with the workspace with no Only me owner.
- Updated dependencies [c08233e]
- Updated dependencies [b0736b7]
- Updated dependencies [57237db]
- Updated dependencies [cf35731]
- Updated dependencies [4a7da4c]
  - @opengeni/contracts@6.7.0
  - @opengeni/subscriptions@6.7.0
  - @opengeni/codemode@6.7.0
  - @opengeni/codex@6.7.0
  - @opengeni/config@6.7.0
  - @opengeni/observability@6.7.0
  - @opengeni/network@6.7.0
  - @opengeni/xai-subscription@6.7.0

## 6.6.0

### Patch Changes

- fb49abf: Connecting a built-in integration such as SharePoint, Outlook or OneDrive now finishes as soon as the person signs in: the provider's callback saves the account and adds every reviewed tool in one step, so nobody waits on "Finishing setup…" and closing the dialog, reloading or quitting the desktop app during the hand-back can no longer leave the account connected without tools. The Connect dialog closes itself and the Capabilities page says "SharePoint connected". The callback reads the reviewed tools before its short commit and finishes only what the person who started the setup could have installed themselves, with the same permission and member policy checks.

  If the callback cannot read the reviewed tools in time, the server keeps trying in the background. A setup still left with a saved account and no tools finishes the next time the person opens Capabilities or an in-chat setup card for it is shown, through the new `POST /v1/workspaces/:workspaceId/connect/attempts/finish` (`connectTransport().finishUnfinished`, `finishUnfinishedConnectSetups`); in chat, its tools then join that chat and the agent continues. This covers setups from before this release too, for 7 days after they started and even once their attempt has expired (it then moves from `expired` to `complete`; the transition report carries the previous state). Finishing applies the same rollout, permission and member policy checks as installing by hand, finishes one setup per account at a time, and never finishes a setup that a later setup of the same account replaced, so tools the person removed stay removed. Neither Capabilities nor the chat card waits for it. Closing the Connect dialog after signing in also lets the remaining setup carry on in the background (`continueConnectSetup`); `NativeConnectSetup`'s `onComplete` can therefore fire after `onClose`.

- 80eb21d: Forking a chat at an agent reply that was sent through `wait_for_input`'s `reply` now works: the fork ends at that wait call and its result. Such replies were refused as "from before the conversation was compacted"; the remaining refusal for a message with no matching history point now says so plainly.
- 09bc485: An agent can now finish a goal and answer in one step: `goal_complete` takes an optional `reply`, and once the completion succeeds that reply ends the turn as its final answer, shown exactly as written. A session created through the API with `unattended: true` and a first message now gets a goal to complete that message unless the request names a goal. Like any goal, it makes the run continue when the agent stops without completing or pausing it, within the deployment's continuation and budget limits, so such runs can take more turns than before; pass `goal: null` to create one without a goal, as before. A keyed retry of such an unattended create now returns the original session instead of a conflict. A task that seems infeasible, missing data or a result the agent cannot verify is no longer by itself a reason to pause a goal: the agent tries the plausible alternatives first and, if it still pauses, names them in the rationale. The goal tools' and `wait_for_input`'s descriptions are shorter.
- 3cb05f9: Slack agents are now shown one way everywhere: `@Opengeni Data team`, with the name as the admin wrote it (`+name` still works). In a thread, a bare name switches agents only when it is the whole message or is followed by "," or ":", and a bare name stays in the request. New names need two letters and can't be sentence starters such as "Hi" or "Test"; one-word names get a warning. Chats hand off only when the person asks for the agent by name, and otherwise answer and may show "<Agent> handles questions like this." with an Ask button. Admins can pick an announcement channel for new agents, the intro page shows a live Slack preview, sorts and searches channels, and reports channels where Slack limits posting. Chats started from a Slack mention show the request without the mention of Opengeni, with other people shown by name.
- Updated dependencies [3d82830]
- Updated dependencies [2c76a2a]
- Updated dependencies [09bc485]
- Updated dependencies [2e72a00]
- Updated dependencies [029497c]
- Updated dependencies [3cb05f9]
- Updated dependencies [c0ba1cc]
  - @opengeni/config@6.6.0
  - @opengeni/contracts@6.6.0
  - @opengeni/codemode@6.6.0
  - @opengeni/codex@6.6.0
  - @opengeni/observability@6.6.0
  - @opengeni/network@6.6.0
  - @opengeni/subscriptions@6.6.0
  - @opengeni/xai-subscription@6.6.0

## 6.5.1

### Minor Changes

- 7a9c492: Organization Knowledge works in the workspaces its organization picks (every shared workspace or listed ones, plus a switch for members' Personal workspaces), and new personal Knowledge works where it was added, in its owner's Personal workspace and where the owner turns it on. Existing entries keep working everywhere. Adds `getKnowledgeEntryReach` and `updateKnowledgeEntryReach`.
- e4484f1: A member of a shared workspace (`connections:write`) now removes only the plugins, API integration accounts and integration sources they added themselves. Anything an admin, another person or no recorded installer added (every row from before members could add integrations included) is removed only by integration admins (`capabilities:manage`), who still remove anything; a member's other removal is refused with the usual `capabilities:manage` 403, decided inside the removal transaction. The installer is the existing `capability_plugin_installations.installed_by_subject_id` (an update hands it to whoever updated) and `integration_facet_bindings.created_by_subject_id` (adding a removed account or source back hands it to whoever adds it), so there is no migration. `GET …/plugins`, `GET …/integrations` and `GET …/integrations/:capabilityId/instances/:instanceKey/facets` now return `canRemove` for the caller on each plugin, account and configured source (always `false` on an API integration the organization serves here, which its settings manage), and the web app offers Remove from it, including on the plugin page for a member's own plugin when the organization keeps adding plugins for admins. New exports: `canRemoveIntegration` (core) and the `memberRemoval` option on `uninstallPluginPackage`, `uninstallApiIntegration` and `removeIntegrationFacet` (db).
- 7f3d037: A member of a shared workspace (`connections:write`) now removes the custom MCP servers they added themselves, with the new `DELETE /v1/workspaces/:workspaceId/capabilities/:capabilityId/installation` (SDK `removeCapabilityInstallation`). It removes the server's installation from the workspace; its catalog entry, connected accounts and any admin tool rules stay, and whoever adds it back becomes its installer. A server an admin or another person turned on, one with no recorded installer (every server from before this change) and one an admin turned off are removed only by integration admins (`capabilities:manage`), who remove any custom server; a member's other removal is refused with the usual `capabilities:manage` 403, decided on the locked row inside the removal transaction. The installer is recorded in the new `capability_installations.installed_by_subject_id` column (migration 1228, nullable, existing rows left empty). `GET …/capabilities` now returns `canRemove` for the caller on each catalog item, and the web app's connector page offers members "Remove from this workspace" from it; admins keep "Turn off for this workspace". Servers a plugin brings are removed with their plugin, a server the organization serves here is turned off here instead (`canRemove: false`, even once turned off), and servers configured in settings are not removable.
- f4f82c0: **My things** lists every one of a person's own logins, model subscriptions and machines in the organization in one place, grouped by kind, each with where it works. Opening one shows the same **Where it works** switches its own page has. It opens from the account menu and from Settings under Your account. Before, a person had to visit each connector, plan and machine to see which workspaces it worked in.

  `GET /v1/workspaces/:workspaceId/own-resources` returns the caller's own logins, then plans, then machines, each with its account or name, provider, reported plan and the same workspace list the reach endpoint returns. Only the caller's own things appear, and only kinds they may list. The SDK adds `listOwnResources`, and `@opengeni/react` adds `MyThings`; `useOwnResourceReach` accepts `initialWorkspaces` so a list can seed each row without reading it again.

- b18bd6c: Organizations can add an API integration once and choose where it works, the same way as an organization connector. An organization owner or admin checks an OpenAPI or GraphQL address, picks how turns sign in to it (each person with their own key or token, one organization key, or none) and which workspaces it reaches. The reviewed definition is stored with it, so every workspace it reaches runs exactly what the admin checked, and a change at the source needs a new check. In those workspaces it works like the workspace's own API integration and is listed under Custom APIs as **From your organization**. A workspace's own setup of the same API wins. A workspace manager turns it off there and back on, and a member adds their own key or token where it asks for one. New: `POST /v1/organizations/:organizationId/connectors/api-integrations/preview` (the SDK's `previewOrganizationApiIntegration`), `apiIntegration` and `apiKey` on `POST /v1/organizations/:organizationId/connectors`, `apiKey` on its `PATCH`, `kind` and `apiIntegration` on each organization connector, and `PUT /v1/workspaces/:workspaceId/integrations/:capabilityId/organization` (the SDK's `setOrganizationApiIntegrationHere`) to turn one off or on in a workspace. `ApiIntegrationInstallationSummary.organizationConnector` says when an installation comes from the organization. Migrations `1199_organization_api_integrations.sql` and `1200_validate_organization_connector_kind.sql` add `organization_connectors.kind` and validate its check.
- 83ccc2b: Organization machines and sandbox environments work in the workspaces the organization's owner or an admin picks: every shared workspace or chosen ones, plus a switch for members' Personal workspaces, with the same "Available in" picker as the organization's model keys and connectors. The workspace a machine was connected from, or a sandbox environment was made in, always has it, and existing ones keep working everywhere they did. New `PUT .../machines/:enrollmentId/reach` and `PUT .../rigs/:rigId/reach` routes, `updateMachineReach` and `updateRigReach` in the SDK, and `reach` on organization machines and sandbox environments.

  Fixes organization sandbox environments failing in chats outside the workspace they were made in ("query returned no rows" when a turn started).

  A sandbox environment's page offers changes to an organization sandbox environment only to the organization's owner or an admin, as the API requires. Before, members who manage sandbox environments saw actions there that were then refused.

- 0f7f559: A person's own (Only me) logins work for their messages where they turned them on. In their Personal workspace every own login works; in a shared workspace a login works once its owner turns it on there. A login starts on in the workspace it was added from, and connecting or reconnecting the same account from another shared workspace turns it on there too. Logins that existed before start on in every shared workspace their owner belongs to, so nothing that worked stops working.

  When a chat asks for a connector whose login the person added in another workspace, the Connect card offers it with one click ("Use it here") instead of a new sign-in. Each own login on a connector's Capabilities page has a "Use for my messages here" switch. In a chat shared with the workspace, the owner sees a one-line note that their logins work for their messages there and that people in the workspace see what the agent does with them, with "Stop using it here"; it never blocks a turn.

  Being turned on is a standing personal-resource grant: user-resource kind `connection` with action `connection.use`, issued with mode `always` and context `workspace_shared` and revoked like any other grant; other modes are refused for logins. `ConnectionMetadata` gains `turnedOnHere` and `turnedOnHereGrantId` on a person's own accounts. Logins that are off in a workspace are not attached to turns there. Personal GitHub keeps its own per-chat repository choice.

- 0f7f559: A turn uses its person's own Codex, Claude or SuperGrok subscription first, where they turned it on. In their Personal workspace it is always on; in any other workspace each person turns their own account on for the messages they send there, in shared and Only me chats alike, and it then pays before the organization's accounts. Other people's turns never use it, and turns without a signed-in person (scheduled and service turns) don't either. An account added from a shared workspace starts turned on there, and each account's page has a "Use for my messages in …" switch per workspace.

  Being turned on is a standing personal-resource grant: user-resource kind `subscription_connection` with action `subscription_connection.use`, issued with mode `always` and context `workspace_shared` in that workspace and revoked like any other grant. Acceptance freezes the account into the turn as consent restricted to that session and connection, and in shared chats the database refuses an automatic binding to a personal account without it. `issueUserResourceGrant` moves to the base and browser clients, beside `listUserResourceAuthorities` and `revokeUserResourceGrant`.

  The per-person personal-fallback opt-in and the organization's "personal fallback allowed" setting are retired: both are still stored and returned, but no longer change which account pays, and the settings page no longer shows them. Existing opt-ins are not converted, because that would widen where an account is used.

- 4682263: Organization settings › Shared says where each organization machine, sandbox environment, Skill and Knowledge works, instead of saying they work in every workspace. Since an organization picks where each works, organization owners and admins now see every organization machine and sandbox environment wherever it works, including ones that don't work in the workspace the page is opened from, each with where it works and a workspace to open it in. The Skills row says how many of the organization's Skills don't work here. Organization owners and admins manage them, and the page now says admins too. Available here and Shared call rigs "Sandbox environment", as the rest of the app does.

  New: `GET /v1/workspaces/:workspaceId/organization-machines` (`enrollments:read`) and `GET /v1/workspaces/:workspaceId/organization-rigs` (`rigs:use`) list every organization machine or sandbox environment wherever it works, for an organization owner or admin, with its reach, and `complete: false` while the server can list only the ones that work in the requested workspace; the SDK's `listOrganizationMachines` and `listOrganizationRigs`. Migration 1224 creates their routine with the runtime grant withheld for one release.

- 0f7f559: A workspace's own Codex, SuperGrok or Claude subscription can now serve other shared workspaces and stays that workspace's. Its workspace's admins can add workspaces they also administer and remove any, from the account's "Where it can be used" page; an admin of a workspace it serves sees it as "Shared by" its workspace and can remove it there (new `DELETE /v1/workspaces/:scopeId/model-connections/:kind/:connectionId/access`). Organization admins can choose any shared workspaces for it and it keeps its owner; choosing every shared workspace, Personal workspaces or people now needs an explicit `moveToOrganization: true`, which the organization page confirms as "Move and save". Account summaries gain `ownerWorkspaceId`.

### Patch Changes

- 4e4f77e: Archived chats that still had something pending are now stopped and stored by the archive pass instead of waiting forever. Cancelling an archived chat no longer fails when one of its sub-chats is already stored, a sub-chat archived under a chat that is already stored now stops its own work, and undelivered updates, unanswered questions or input waits in an archived chat now count as work to cancel.
- e797d94: A chat is only stored in the long-term archive once every wake queued for its workflow has been delivered, so an archived chat can no longer block wake delivery for other chats.
- 4b67778: Cancelling a chat whose stopped turn still has an unanswered tool call no longer fails when the chat also has undelivered updates (or is the cancelled chat itself): the tool calls are closed before the other cancellation events are written, so every event continues the chat's event cursor in order. Cancelling also ends the chat's input wait, which nothing would settle afterwards; migration 1229 clears the waits of chats cancelled before. Both kept archived chats from ever being stored.
- 7de2adf: Connector cards show a well-known service's own name and logo instead of its raw hostname and a letter, for example "Google Search Console" with its mark and a "Connect Google Search Console" button. The catalog overlay gains `identities` (name, logo and homepage only) for 164 services including every Google API row, and generated letter placeholders from integrations.sh are screened out so the product's own monogram shows instead. `validateLogoAsset` rejects such placeholders when called with `rejectGeneratedPlaceholder` (the catalog import and vendoring paths); a custom MCP server's own declared icon is accepted as before. A re-import clears a stored catalog logo once its row has no logo by policy (`RegistryCapabilityCatalogItemInput.clearLogoAsset`). The setup card no longer repeats a subtitle identical to its title. The SharePoint and OneDrive setup cards show their Microsoft marks instead of a letter, like Teams and Outlook already did.
- 89eabf0: Allow background-command backlog reads to evaluate visible sessions once while retaining indexed visibility checks for individual commands. Tenant, private-session, capability and write authorization remain unchanged.
- f1998df: Background-command reads take fewer calls and fewer tokens. `command_read` now waits for a running command to finish (30 seconds by default; pass `waitSeconds: 0` to read at once), and both `command_read` and `command_wait` return when the command finishes or the wait ends, not on each new line of output. `command_wait` can wait on up to eight commands at once with `commandIds` and `waitFor: "all"` or `"any"`. A read without a cursor whose output is larger than the byte budget now returns its start and its end, with the approximate size of the omitted middle and a cursor to read it, instead of only the first page; a read with a cursor pages on from there, so `nextCursor` still pages through every byte, and the new `endCursor` reads only newer output. The model sees these results as plain text (state, exit code and output); Codemode and other programmatic callers keep the structured result.
- 89eabf0: Bound concurrent per-file Git capture reads and stop queued reads after failure or cancellation. Avoid recounting the background-command backlog during each command settlement, keeping large backlogs from blocking session control.
- 02e68d1: Signed-out guests of a public Site can now open the Site's shared files. Before, every guest file request was refused, so a public Site that kept its images or video in Site files showed without them to signed-out visitors. Guests now list and open files with scope `shared` only: private files stay hidden (opening one returns not found), and uploading, deleting and the quota check stay refused for guests. Existing per-visitor and per-address limits still apply. Signed-in viewers still see shared files plus their own, and managers see every file. The Site runtime API docs, the Sites skill and the `site_files_upload` tool description now say the same.
- ebfd447: A value that JSON cannot carry (a symbol key, a function, a bigint, a cycle, a class instance such as a Response, Headers, AbortSignal or Error) no longer fails a turn where it is stored or sent. Every protocol JSON boundary (history, tool receipts, run events, approvals, MCP results and custom data, the sandbox envelope) and the database's canonical JSON encoder now convert or drop such a value as `JSON.stringify` would and log the paths and kinds they changed, never the values. A `JSON.stringify` refusal from any other serializer ends the turn with the same clear, recoverable failure instead of stopping the chat.
- d5ce7de: Transcribing a meeting again also writes its notes again when nobody has touched them. Before, the built-in summary only ever wrote a meeting's first notes, so after a re-run the notes still described the transcript the re-run replaced, for example claiming one speaker after the new transcript found two. Now a re-run starts the built-in summary when the notes were last saved by an earlier summary chat of the same meeting in which every turn was the service's; `meetingSummaryCandidate` returns their revision as `replacesRevision`, and `meetingSummaryPrompt` takes it, telling the chat to save over exactly that revision and to keep anyone else's notes. Notes a person edited, an automation wrote, or someone talked to the notes chat about are never replaced. A first summary's message is unchanged. The Transcribe again description says so, under new message keys (`meetings.detailPage.makesANewTranscriptNotesToo`, `native.meetings.meetingView.aNewTranscriptAndNotesToo`) so hosts translate it again.
- c649c2e: A person's duplicate logins to the same account are merged into one. Before connecting reused an existing login, turning a connector on in a second workspace could save a second login to the same account, with tool choices split between the two. Where the service verified the account identity (Slack, Gmail, Google Calendar, Google Drive, Atlassian), migration 1226 keeps one login (a working one with the most scopes), moves the others' tool choices (strictest wins), workspace turn-ons, schedule pins and connector references to it, and revokes them. Logins with unknown identity, fewer covered scopes, or something depending on them (event triggers, vaults, Knowledge syncs, Site tool allowances, API Integrations) are left as they are.
- 033cd63: Organization admins, like the owner, now manage the organization's webhooks and credential provider, and see and revoke everyone's personal API keys and connected agents in their organization, except the owner's: only an owner revokes an owner's keys or disconnects an owner's agents. Listed personal keys carry `canRevoke` and listed connected agents `canDisconnect`, and the Developer and Connected agents pages offer Revoke and Disconnect exactly where they apply. The rule is the organization's owner or an admin signed in as themselves (or a verified agent acting as them with `account:admin` in its access); being an admin of one organization grants nothing in another. Organization settings show the Developer page and its integrations to admins exactly when the server allows them.

  Organization admins also manage the organization's API keys and service accounts at member level: they see all of them, and create, change or revoke only keys that can't manage people, keys or billing and aren't held by an admin service account, and change or delete only member service accounts. Only the owner makes a service account an admin or manages owner-level keys. The Create API key page offers admins Read only and Custom (without administration permissions) and only member service accounts, and hides Revoke and editing where the server would refuse. `@opengeni/db` exports `effectiveKeyPermissions`.

  The Shared overview, the Available here lists and the vault forms now say that organization owners and admins manage what the organization shares.

- da9b7e5: Members of an organization can now see who else is in it, by name. `GET /v1/organizations/:organizationId/member-names` (SDK `listOrganizationMemberNames`) returns `{ available, members }`, where each member has only a membership `id`, a display `name` (or `null`) and `you`. Any active owner, admin or member acting as themselves can call it; outsiders, suspended and offboarded people get `403`. Product users (`external_user:`), services and keys are never listed, and emails, roles, status, invitations, workspace access and usage stay with the owner and admin directory (`/members`), which is unchanged. In the console, a member's People settings page now lists everyone by name with a search. Migration 1211 creates the `list_organization_member_names_v1` database function without granting it to the runtime yet, as the two-release rule requires; until a later migration grants it, the route answers `available: false` and the People page says only owners and admins can see who is in the organization.
- de8fc61: Own subscriptions (Claude, Codex/ChatGPT, SuperGrok and any other connected subscription) no longer pay the 5% platform fee; own API keys (provider, gateway or custom endpoint keys) still pay it from paid credit as before. With Stripe billing and subscription plans enabled, using an own subscription needs a paid plan of at least $20 a month (Pro, Max or a custom plan, active or trialing), which then allows unlimited subscription use alongside the plan's normal credits. On the Free plan, without a plan, or on a past-due or canceled plan, an own-subscription call is refused before it runs with `402 subscription_plan_required`, "Upgrade to Pro to use your own subscription." and one Upgrade to Pro action; existing connections stay connected, are not picked as the default model for new chats or scheduled tasks while the plan does not allow them, and work again after upgrading. During a rolling deploy, workers still on the previous release may charge the fee on a subscription turn until they are replaced. Scheduled runs skip the occurrence and goals pause on credits. Internal accounts on legacy billing terms stay exempt. New exports: `ownModelFunding`, `ownSubscriptionPlanAllows`, `planAllowsOwnSubscriptions`, `ownSubscriptionPlanRequired` and `checkOwnSubscriptionPlan` in core, `getOrganizationPlanStanding` in db, and `SUBSCRIPTION_PLAN_REQUIRED_CODE`, `SUBSCRIPTION_PLAN_REQUIRED_MESSAGE`, `OWN_SUBSCRIPTION_MIN_PLAN_PRICE_MICROS` and `planIncludesOwnSubscriptions` in contracts. The web app shows the refusal with one Upgrade to Pro action (React gains the `subscription_upgrade_required` refusal kind and `isUpgradeRefusal`), Pro and higher plan cards say "Your own AI subscriptions, no fee", and the billing page's fee line reads "Platform fee on your own API keys". See `docs/billing-origin.md`.
- a8d1310: The owner of a Personal workspace now has a real member row in it. The row is created with the Personal workspace, removed when the owner's organization membership is suspended, revoked or ended, and restored when it becomes active again. A batched backfill gives existing Personal workspaces their row and normalizes legacy owner rows. The row carries the fixed Personal permissions (workspace admin minus member management, workspace API keys and usage-allowance management), and the database still refuses every other member, moved rows and widened permissions. Access is unchanged: the verified owner still reaches Personal through the organization membership, nobody else can, and the tenancy checks now expect exactly this one row.
- 7b0f510: The verified owner of a Personal workspace, acting as themselves, can now change the model account settings their organization has not locked (rotation, fallback, switching models and a provider's source), as a shared workspace's admins can. Locked settings still win. The database admits the change only for the owner's own row with an owner declaration the API sets after verifying the owner, so colleagues, organization admins and delegated tokens are still refused in someone else's Personal workspace. The web app shows these controls in Personal exactly when the server allows them, and the organization's settings say that unlocked rules can also be changed in Personal workspaces.
- c314c95: A meeting transcript retried after its worker was lost no longer pays the provider again for audio it already transcribed. Each piece of a track is kept with its version as soon as the provider answers (before a text-only model's words are placed), keyed by the model, options, piece and a hash of the audio, and a retry reuses it. Kept pieces are removed when the version completes or fails (migration 1227).
- 27ac6cd: A scheduled task that starts its own chats and sets `agentConfig.bundledSkillIds` (including an empty list) now runs. Before, every run of such a task, scheduled or started with Run now, failed with `scheduled_run_authority_proof_rejected`: the chat stores the task's bundled Skill selection, and the database check that compares each generated chat with its accepted run did not expect it. That check now requires exactly the task's selection. Tasks without a selection are unchanged.
- f866a11: Schedules that start a new chat per run and were saved before the secret permission names were unified run again. Every run of such a schedule was refused with `scheduled_run_authority_proof_rejected`, because its chat stored the current permission names while the run still named the retired ones. A run now names the same canonical permissions as the chat it creates.
- Updated dependencies [f1998df]
- Updated dependencies [564efe9]
- Updated dependencies [6bdd4d0]
- Updated dependencies [3f9ef93]
- Updated dependencies [ebfd447]
- Updated dependencies [7a9c492]
- Updated dependencies [468e8c3]
- Updated dependencies [e4484f1]
- Updated dependencies [7f3d037]
- Updated dependencies [f4f82c0]
- Updated dependencies [317fb4d]
- Updated dependencies [033cd63]
- Updated dependencies [b18bd6c]
- Updated dependencies [83ccc2b]
- Updated dependencies [da9b7e5]
- Updated dependencies [0f7f559]
- Updated dependencies [0f7f559]
- Updated dependencies [de8fc61]
- Updated dependencies [dd7759c]
- Updated dependencies [70c726c]
- Updated dependencies [707c444]
- Updated dependencies [4682263]
- Updated dependencies [52c8c3b]
- Updated dependencies [52c8c3b]
- Updated dependencies [52c8c3b]
- Updated dependencies [abb4af1]
- Updated dependencies [86e35f1]
- Updated dependencies [0f7f559]
  - @opengeni/contracts@6.5.0
  - @opengeni/config@6.5.0
  - @opengeni/subscriptions@6.5.0
  - @opengeni/codemode@6.5.0
  - @opengeni/codex@6.5.0
  - @opengeni/observability@6.5.0
  - @opengeni/network@6.5.0
  - @opengeni/xai-subscription@6.5.0

## 6.4.0

### Minor Changes

- 000c023: Calls on a person's own provider key or subscription pay a platform fee (`OPENGENI_BYOK_PLATFORM_FEE_BPS`, default 500 = 5% of the list-price equivalent; custom endpoints with no list price use $1.25/$10 per million input/output tokens) while credit billing is active. The fee is payable only from paid credit: a paid plan's credit for app use, then topped-up or operator-granted credits that ordinary spending has not used (it draws promotional credits first). Free, signup and promotional credit never pay it; without paid credit the call is refused with `402 byok_paid_credit_required` and one action: Upgrade to Pro on the Free plan in the app, otherwise Add credits. Paid credit counts a coupon top-up net of its discount, and a past-due plan or leftover Free period never pays the fee; each fee and each top-up, grant or refund records on its row what it did to paid credit, and each receipt carries running totals, so the balance read takes paid credit and fee debt from the latest receipt (through the new partial index `credit_ledger_receipt_rows_idx`): it does not grow with the number of fees, and accounts with or without fees read their balance as fast as before. Fee debt is never repaid by plan or promotional credit; the next top-up repays it first. Migration 1129 (rolling) makes `plan_period_usage` count only the plan-paid part of a fee and lets `plan_app_general_balance` keep API debt and unpaid fee debt (not fees paid in full) out of plan credit, matching the app's balance; migration 1130 builds the index concurrently. The web app shows these refusals as credit stops. See `docs/billing-origin.md`.
- ace882b: Members of a shared workspace (`connections:write`) can now add integrations: install and remove plugins and API integrations, add custom MCP servers, turn on any catalog integration that is not on yet, configure integration sources, finish an agent-prepared MCP key setup, and connect a workspace-owned OAuth MCP account from the chat card. Integration admins (`capabilities:manage`) still own tool approval rules (Allow/Ask/Block), auto-approval (`autoApprovedTools`, an explicit `requireApproval` other than `true`), changing an integration that is already on, and turning one off for everyone. A member's add is create-only, checked inside the install transaction: it never updates a plugin, an API integration instance or its revision, never rebinds or reconnects a shared account, and never rewrites or turns back on a server an admin set up or turned off (a plugin that would is refused with 403; retrying or resuming one's own install still works). Members can remove what an admin added. The organization integration allowlist still applies, and an organization that sets `personalIntegrationSetup: "admins"` keeps turning integrations on for admins; the workspace catalog now returns that setting as `memberIntegrationSetup`, and the web app, chat cards and the agent's setup check offer members only what the API accepts. New exports: `INTEGRATION_SETUP_PERMISSION` and `canAddIntegrations` (contracts), `requireIntegrationSetupAuthorization`, `hasIntegrationSetupPermission` and `hasIntegrationAdminPermission` (core), `MemberIntegrationSetup` (contracts), `canAddWorkspaceIntegrations`, `canManageWorkspaceIntegrations`, `canChangeWorkspaceIntegrations` and `canConnectWorkspaceMcpFromChat` (react), and `CreateCapabilityCatalogItemInput.createOnly`, `InstallApiIntegrationInput.memberCreate` and `IntegrationChangeRequiresAdminError` (db).
- dcb2352: An organization's owners and admins can now choose whether members connect machines of their own. Organization settings → Security & data has a "Members connect their own machines" switch, on by default. Through the API it is `membersConnectOwnMachines` on `GET`/`PATCH /v1/organizations/:organizationId/privacy-settings`, changed by the same owners, admins and administration-capable organization keys as the other privacy choices.

  Off, only the organization's owners and admins connect a new Only me machine, or any machine in a Personal workspace. Workspace permissions don't lift it. Minting a connect command and approving a pairing code answer `403` with a plain sentence; declining a code still works. Shared-workspace and organization machines keep their existing rules, and machines already connected keep working and stay their owners' to change or remove.

  `GET /v1/workspaces/:workspaceId/machines` now reports `canConnectOwnMachine` for a person (omitted for an agent listing its own chat and by older servers), and `useWorkspaceMachines` exposes it. `ConnectMachineDialog` takes a `canConnectOwnMachine` prop: false disables Only me (and This workspace in a Personal workspace), skips the this-computer path, and explains who can connect when nothing is left.

- f3e6835: Documents, spreadsheets and presentations can be Only me, like chats, Sites and files. One made by an agent in an Only me chat, or imported from an Only me file, starts Only me; everything else, including every existing one, stays shared with the workspace. An Only me one opens only for its owner and for agent turns acting for them or running in their own Only me chat; colleagues, workspace administrators, keys and services cannot read, edit, export or open it live, and the artifact library does not list it for them. A file an agent exports from it is Only me for its owner, even from a shared chat. Only the owner changes the audience, from the app: `PUT /v1/workspaces/:workspaceId/editable-artifacts/:artifactId/visibility`, the SDK's `updateEditableArtifactVisibility`, or the document's Artifacts menu. Create and import accept an optional `visibility`; editable artifact responses and catalog items carry `visibility` and `ownedByViewer`. A Site made in an Only me chat by a run without a person, such as a meeting summary, now stays Only me under the chat's owner. Rolling migration `1160_editable_artifact_audience.sql`.
- b098518: Projects can be Only me, like chats. `Channel.visibility` is `workspace` (seen by everyone in the workspace, as every project was before) or `private`: seen only by its owner and agent turns acting for them, holding only that owner's own Only me chats and Sites, with a name that is unique only among their Only me projects. `CreateChannelRequest.visibility` chooses it; omitted, a person's project is shared and an agent's `project_create` follows its chat, Only me when made in an Only me chat. Its owner shares it with `UpdateChannelRequest.visibility: "workspace"`, from a signed-in person only; nothing makes a shared project Only me. Filing another kind of chat or Site in an Only me project is refused with 422, and a chat or Site that later becomes shared leaves it. In the app, New project offers "Who can see it" where Only me chats are allowed, the sidebar marks Only me projects with a lock and offers "Share with workspace…", and choosing an Only me project for a new chat makes that chat Only me. Rolling migration 1161.
- a853c7a: Organization admins now manage the organization's Knowledge, documents and their backfills, organization Skills and the preference registry, the company profile and its agent policy, and can list the organization's sessions, as the owner does. Admins can also choose organization documents as the destination for connector syncs (Atlassian, Google Drive, Slack). The rule is "owner or admin of this organization", proven by the signed-in human session; admins don't get `account:admin`, so billing, roles, ownership and deleting the organization stay owner-only, and admin rights in one organization never apply to another. Agent turns started by an admin can propose and confirm company-profile changes (migration 1096). The web app shows these controls to admins exactly when the server allows them. New `@opengeni/core` helpers: `holdsOrganizationAdministration`, `authorizationHoldsOrganizationAdministration` and `requireOrganizationAdministrationStamp`.
- a99a7d6: Organizations can add a connector once and choose where it works. An organization owner or admin adds a catalog connector or a custom remote MCP server with how turns sign in to it (each person with their own account, an organization key, or none) and which workspaces it reaches: every shared workspace or chosen ones, with a separate switch for members' Personal workspaces. In those workspaces it works like an enabled connector of the workspace's own, listed once as **From your organization** (`lifecycle.managedBy: "organization"`, `metadata.organizationConnector`), with the same server ID a workspace setup would give. The workspace's own setup of the same connector, on or off, wins: a workspace manager turns it off there with the ordinary disable action and back on with an empty enable, while a member's personal setup never replaces it. New: `GET`/`POST /v1/organizations/:organizationId/connectors` and `PATCH`/`DELETE .../connectors/:connectorId`, the SDK's `listOrganizationConnectors`, `createOrganizationConnector`, `updateOrganizationConnector` and `deleteOrganizationConnector`, and migration `1175_organization_connectors.sql`. Only signed-in organization owners and admins (and agents acting for one) manage them; organization API keys are refused.
- c2f978b: An organization's credential provider and webhooks can work in chosen shared workspaces only (`allowedWorkspaceIds`), on top of the workspace filter. Existing ones keep working in every shared workspace; a provider PUT or webhook PATCH that leaves the list out keeps it.
- c59d7f8: An organization Skill works in the workspaces its organization picks: every shared workspace or chosen ones, plus a switch for members' Personal workspaces. Existing Skills keep working everywhere. Agents in a workspace it doesn't work in stop seeing it from their next turn; people who can change it still find it there, marked "Not used here". New `PUT /v1/workspaces/:workspaceId/skills/content/:skillId/reach` and SDK `updateSkillReach`; Skill records carry `reach` and `availableHere`.
- 237329e: A person's own connected machine now runs that person's own turns in every workspace where they have it on, in private and shared chats alike, without asking again each chat. A machine is on in the owner's Personal workspace, in the workspace it was connected from (until the owner turns it off there), and in any workspace where the owner allowed it with standing permission. The first use where it is on by default records that standing permission, so the owner can turn it off later. Another person's turns still never run on someone else's personal machine; they keep waiting for the owner, unchanged.

  Allowing your own machine from a chat's machine card, or moving a chat to it, now turns it on in that workspace from then on, and the card says so; in a shared chat it also notes that people in the workspace see what the agent does there. `disallowAgentsOnComputer` in the SDK now turns the computer off in a workspace even where it was on by default. The refusal reason and setup blocker for a personal machine say that its owner has not turned it on in this workspace.

- 1efa378: Organization settings has a Shared page for owners and admins: everything the organization shares with its workspaces and where each works. Models and their payers link to Models; the organization's machines, rigs, Skills and Knowledge are listed as working in every workspace, Personal workspaces included; each organization vault says where it works and opens in a workspace the viewer can reach. New: `GET /v1/workspaces/:workspaceId/organization-vaults` (`account:admin` and `secrets:list`) lists every organization vault wherever it works, with `complete: false` while the server can list only the ones that work in the requested workspace, and the SDK's `listOrganizationVaults`. Migration 1218 creates its routine with the runtime grant withheld for one release. `OrganizationAdminSection` gains `"shared"`.
- 237329e: A schedule runs as its owner, so its owner's own (personal) Connected Machine can now run it whoever can see it: Workspace schedules included, not only Only me ones. Picking the machine on the schedule is the consent; following a workspace default that is a personal machine is still refused. Each run's chat gets the schedule's audience and a grant for that chat alone, and other people's messages in a shared run chat wait for the owner, as in any chat on a personal machine. Nobody else's schedule can use the machine.

  Create and update no longer refuse a Workspace schedule on the owner's machine, and widening such a schedule to Workspace is allowed. The schedule form offers your own machines whatever the schedule's audience. When a machine becomes someone's Only me machine, that person's schedules on it keep running unchanged; before, their Workspace schedules there became Only me or paused. Everyone else's still pause. The audience preview no longer produces the `make_only_me` action, and `summary.schedulesMadeOnlyMe` is always 0.

- ed0ba73: A short personal Skill, such as a saved standing preference ("always answer in Norwegian"), now applies without an extra model round trip. The Skill index shows the complete instructions of a single-file personal Skill whose body renders in at most 1,024 bytes (counted as JSON-escaped in the index), up to 4,096 bytes in total, in an `instructions` field on its entry, and its descriptor notice line then also explains that field. Larger, multi-file, workspace and organization Skills, and Skills whose frontmatter has no closing line, stay descriptors that the agent reads on demand, and an index without such Skills renders byte for byte as before.

  `SkillCatalogDescriptor` gains an optional `instructions` field, `formatSkillCatalog` applies the per-entry and total bounds and lists shown-in-full entries first, and `skillInstructionsBody` returns a SKILL.md body without its frontmatter, with line endings normalised. `listSkillDescriptors` takes an optional `personalSkillMarkdownMaxBytes` that also returns `personalSkillMarkdown` for small single-file personal Skills.

- e9e5640: An account administrator without an organization membership (a configured access key, an account-scoped key or a signed delegation with `account:admin`) now administers the organization's subscription accounts: rolling migration 1149 grants the runtime role the account-administrator grant that 1103 withheld for one release, and readiness now requires it.
- af8a173: Webhooks can carry `turn.superseded`, sent when a new message (a Steer) takes over a turn before it finishes. Until now that turn settled without any terminal webhook, so a host listening for `turn.completed`, `turn.failed` and `turn.cancelled` only learned about it by polling. Workspace and organization endpoints can subscribe to it; it carries `initiatingHuman` like the other turn types, and existing registrations are unchanged until they add it. Subscribe to all four turn types to get exactly one terminal webhook for every turn.

### Patch Changes

- 106652b: A member's share of a workspace usage allowance (`equal_share` or `{ share }`) is now a share of the period's whole pool, the same amount as the workspace limit: included credits plus grant credits spent this period plus those left. Before, it was a share of included credits plus the grant credits still left. So every credit anyone spent from a grant lowered every member's limit (for example 19,998 became 19,997), and in a workspace funded only by grants, an equal share of two ran out at about a third of the credits. Usage reads, admission, threshold and exhaustion notifications and `UsageMemberList`'s percentages now agree. A member's share stays steady through the period, rises when credits are bought and starts again from what is left in a new period.
- f13df88: Requests that an organization key makes for its external users no longer authenticate one at a time. Authentication held an organization-wide lock exclusively, so a page that loads many chats in parallel waited for each request in turn (dozens of reads could take over ten seconds). A known user is now read under that lock held shared, which still waits for membership changes and revocations; only a user's first request provisions it under the exclusive lock.
- 7a9dc90: Migration 1210 grants the runtime role EXECUTE on the EU-only inference change function that 1060 withheld for one release. Readiness and provisioning now require it, so owners and admins can change the setting.
- b3cc70d: An organization vault limited to selected workspaces can also serve members' Personal workspaces, as its "Include personal workspaces" switch says. Before, a vault with a workspace list never reached a Personal workspace whatever the switch said. The switch alone now decides Personal workspaces, as it does for organization model keys. Migration 1171 turns the switch off on existing vaults with a list, so no vault reaches more than it did; an organization owner turns it on to serve Personal workspaces.
- 53f851d: Organization webhooks can subscribe to `session.agentCall.ringing` and `session.agentCall.settled`, as workspace webhooks already could. The API accepted these types for organization endpoints, but the database refused them and the request failed with an internal error, so a product serving many workspaces from one organization endpoint never heard a call ring. Existing registrations are unchanged until they add the types.
- 8a7d1c8: Provider-hosted web search and OpenAI hosted image generation now cost credit on turns whose model Opengeni pays for while credit billing is active (one check point, `paidHostedToolsChargeCredits`). Such a turn gets Opengeni's billed `web_search`/`web_fetch` tools instead of hosted search whenever a search provider is configured. Without one, the hosted searches each response reports (Claude's count, and now OpenAI `web_search_call` items) are charged at $10 per 1,000 plus the 5% web-search margin, as a separate, idempotent web-search debit per response, including a response that reported no token usage. Gateway-reported costs already include search and are not charged again. OpenAI hosted image generation on the deployment's own key is no longer offered on those turns. They use the priced Gateway image tool, so they have no image tool unless the managed Gateway image credential or a workspace Gateway key is configured.

  Paid tools on those turns are paid like other app tools: plan credit first (the Free plan's monthly credit included, whatever models its scope lists), then grants that list the turn's model, then general credit. The new tool credit usage (`toolCreditUsage`) applies to Gateway images too, so Free plan credit now pays for them on any model. These debits keep the turn's billing origin, so API work pays from credits only. Turns on the user's own keys or subscriptions, free models, billing-off deployments and legacy billing accounts (`OPENGENI_BILLING_LEGACY_ACCOUNT_IDS`, CloudGeni's host account by default) are unchanged. `OPENGENI_PAID_HOSTED_TOOLS_CREDIT_BILLING=false` (default `true`) turns the new charges off and restores free hosted search and images on every turn.

- bf3cf84: Live transcripts on a model the deployment pays for now cost credits while credit billing is active: the payer is admitted before the live secret is minted (402 without credits, 403 `policy_blocked` when credits are turned off or the payer can't be identified), and each save charges the track's audio from its charged mark (`recording_tracks.live_charged_milliseconds`, migration 1131) to its streamed total at the model's voice price. The charge's usage receipt is recorded and the mark moved in the save's own transaction, so overlapping saves and retries charge each range once and a failed receipt fails the save for the recorder to retry; the debit follows the commit, and a failed one is applied from its receipt when the meeting is finalized or by the next voice admission. The duration is the recorder's report, recorded with basis `client_reported_duration`. The SDK reports a track's streamed total about every minute while streaming (silence too), on pause and resume, and before asking for another session; a track charged in credits gets no more live sessions once the time between those reports (counted for the track only up to a report of more audio, at most that audio plus a minute and 3 minutes each, so pauses never count) runs more than 10 minutes plus a quarter ahead of what it reported, once 4 sessions went unreported, or after 20 sessions plus one per 5 minutes reported (at most 100), or when the new session's hour would take the person's time no reported audio accounts for (pauses, unreported sessions, and time beyond the audio reported, without the track's minute of slack, so a trickle of audio doesn't cover it) in the last 24 hours in that workspace past 4 hours plus six times the live audio charged in credits (`LIVE_UNBACKED_PER_CHARGED`, so meetings of about 9 minutes or longer never use the day up and free provider time stays at most 4 hours plus six times what was paid), counted only within an hour of each session's start since a provider session runs at most an hour, with each session's whole hour counted up front and swapped at each report for what it actually left unaccounted plus what it could still run (so an abandoned session costs its hour, and one the provider never started gives it back), and stored per person and hour for tracks charged in credits only (`recording_live_unbacked_hours`, migration 1131; every API key of a workspace shares one bound, as keys record no person, while personal keys and delegated sessions count as their person; session requests of one bound, and saves on a session a previous release started, are serialized by an advisory lock, so a burst can't run over it; a session's time stays in the hour it began in, and hour rows are locked oldest first so concurrent requests can't deadlock) (409 `live_grant_limit` / `live_streamed_behind`); an honest recorder isn't refused for silence, long pauses, or quick pause and resume cycles (only a day with more pauses shorter than a session than the bound allows, or many live meetings under about 9 minutes, loses the live preview), the SDK asks for no new live session while paused, and the React Native recorder now reports its pauses, resumes and interruptions to the live transcript. `live.costUsd` stays the list price of everything streamed, and usage allowances that price unbilled use count only audio not charged in credits (`live_charged_cost_usd_micros`, and a same-signature `count_unbilled_model_allowance_debit()`), so charged audio never counts twice, also after a switch to an uncharged model (audio saved through a previous-release pod during the rollout is the exception, documented). Live-transcript refusals have their own wording. A live model with no credit price isn't served then (503 `model_unavailable`, `retryable: false`). The deployment's Azure Speech account without a voice input MAI price (OPENGENI_VOICE_INPUT_MAI_PRICING_JSON) doesn't transcribe meetings while credits are billed: the default and automatic choice move to a model that can run (a priced deployment model, a subscription or the workspace's key), `GET …/recording-models` lists it `available: false` with `unavailableReason: "unpriced"`, and a meeting that names it fails with `model_unavailable`, which the app explains and offers another model for. Credit admission's own policy refusal (credits off, unidentified payer) is now a 403 `policy_blocked` on meeting transcripts too, not a 500. The SDK's live transcriber treats 402, 429 and any `retryable: false` refusal as final instead of reconnecting all meeting, and retries its last save when recording stops. Legacy billing accounts (OPENGENI_BILLING_LEGACY_ACCOUNT_IDS, CloudGeni) keep today's behaviour: no admission, no charge, no price shown on live-only models, and unpriced models still served.
- 3c16116: Deciding several parallel tool approvals now just works. A decision for an approval that is still undecided is accepted while the turn resumes from a sibling decision, instead of failing with "no unhandled approval is pending". One resume applies every decision made before it, so each decision no longer restarts the turn and asks the rest again, and an already decided approval is never asked again. Deciding the same approval twice is accepted once, and a real conflict says why: already approved or declined, already finished, or the turn ended. The chat, the sub-session card, the phone app and the embedded chat keep the undecided approvals up and decidable while the turn resumes. `approvalsDecidable(status)` is exported from `@opengeni/react` and `@opengeni/react/session`.
- 5ebed12: A Personal workspace now has exactly one possible member, its owner, enforced by the database (migration 1159). Nobody else's membership row can be added or moved into it, the owner's row can never manage members, workspace API keys or usage allowances, and a Personal workspace keeps its identity. Creating a workspace with the Personal external source now returns 422. Membership readers ignore a row in a Personal workspace, so the owner still reaches it only as the verified owning user. This prepares for giving the owner a real membership row in a later release.
- 4a48589: Pinning an archived chat restores it, so it shows under Pinned. A chat opened from search could be pinned from its header while archived: it was marked pinned but never appeared under Pinned, which lists active chats only. Pinning now restores the chat in the same transaction (archiving still unpins), the open chat's header reflects the restore at once, and a migration repairs chats already saved as both pinned and archived.
- 1e98c19: A repository picked "As you" stays an As-you selection in the next new-chat draft instead of coming back as a manual URL, and a manual URL row for a repository already selected "As you" at the same branch folds into that selection instead of blocking Send with a duplicate mount path.
- cfce969: Integration Knowledge sync is retired. Integrations give agents tools and access; for recurring work, create an ordinary agent schedule that uses the integration's tools.

  - Google Drive and OneDrive no longer offer a "Knowledge source" (`drive-content`) facet. Configuring a `knowledge_source` facet, or browsing or saving a source, returns 410.
  - Creating a schedule with `agentConfig.knowledgeSource`, or changing a saved task's source, returns 410.
  - Saved source tasks (a `knowledge_source_sync` action or `agentConfig.knowledgeSource`) for any provider now read as retired. Fires, manual runs and resume are refused, and queued runs fail with `knowledge_source_sync_retired`. Google Drive and Atlassian tasks keep their existing retirement reasons. You can still read and delete these tasks.
  - The worker no longer contains the source sync workflow, its activities, or the `knowledge_source_fetch` and `knowledge_source_read` attempt tools.
  - New in `@opengeni/contracts/knowledge-source-sync-retirement`: `retiredKnowledgeSourceSyncTask`, `isRetiredKnowledgeSourceSyncTask` and the shared retirement reasons. `isRetiredNativeGoogleDriveTask` and `isRetiredNativeAtlassianTask` are deprecated.
  - Imported Documents, Knowledge entries, source provenance and run history stay readable. Public schemas and SDK types are unchanged, and no data or tables are removed.

- 4bd54f1: A seat-limit refusal names its one fix. The API's `402 seat_limit_reached` message is "Upgrade to Pro to add more people." or "Upgrade to Max to add more people." (whichever plan has room), or "Talk to us about Enterprise to add more people.", and its details add `seatLimit`, `seatsUsed`, `upgradePlan` and `upgradePlanLabel`. `formatErrorMessage` uses the named plan. The invite page shows it as soon as the plan is full, with one Upgrade button for people who manage billing, and tells everyone else to ask an organization owner. New: `seatUpgradePlan` in `@opengeni/contracts/seat-upgrade`, and `planSeatsFull`, `seatUpgradeFor` and `seatUpgradeFromError` in the React subscription-plan helpers.
- 67f4f3e: Full session list pages (`listSessionsForSubject`, behind `GET /v1/workspaces/{id}/sessions` without the compact projection) now name each row's model the way compact pages already do: two fixed index probes per row (its latest started turn and its latest model settings change). Before, they ran the effective-policy walk, which scans back over every turn started since the last settings change. On long sessions with many automated turns that took several seconds in Postgres and slowed every list load. A list row now shows the latest started turn's model unless the settings were changed after it. Opening a single session still reports the exact effective policy.
- 3b9a997: Add `POST /v1/workspaces/:workspaceId/sessions/:sessionId/resources/remove` and SDK `removeSessionResources` to remove repositories from a running session and its child sessions, recorded as `session.resources.removed` events. Access through Opengeni-brokered paths and new credential mints ends on the next call: the personal Git broker, the GitHub tools and Git token minting refuse a removed repository, including for running turns, children and goal continuations. Tokens already in a sandbox stay valid until they expire, except that a dedicated token Opengeni's own GitHub App minted is best-effort revoked. The next managed-sandbox turn removes the repository folder and credential binding.

  `Session` gains an optional `removedRepositories` list (migration 1140). A removal lasts until a person attaches the repository again: an agent cannot re-attach it (with a message or a child session, which now returns 403), turns queued earlier leave it out, and child sessions inherit it. Only a person or an API caller can remove repositories. `SessionAuthorizationOperation` gains `"session.resources.write"`; hosts with an exhaustive switch over it must handle the new value.

  In the chat composer, a mounted repository can now be switched off in the repository picker. A confirmation names the repository and warns when its folder has uncommitted or unpushed changes. The SDK `Session` type gains the optional `removedRepositories` field and the `SessionRemovedRepository` type.

- Updated dependencies [1f918a4]
- Updated dependencies [21d0e30]
- Updated dependencies [000c023]
- Updated dependencies [bc5c6d5]
- Updated dependencies [06adef4]
- Updated dependencies [ace882b]
- Updated dependencies [dcb2352]
- Updated dependencies [894121c]
- Updated dependencies [f3e6835]
- Updated dependencies [0b19c29]
- Updated dependencies [b098518]
- Updated dependencies [a99a7d6]
- Updated dependencies [c2f978b]
- Updated dependencies [c59d7f8]
- Updated dependencies [237329e]
- Updated dependencies [8a7d1c8]
- Updated dependencies [bf3cf84]
- Updated dependencies [cdb9d27]
- Updated dependencies [cfce969]
- Updated dependencies [df44bd8]
- Updated dependencies [4bd54f1]
- Updated dependencies [3b9a997]
- Updated dependencies [1efa378]
- Updated dependencies [237329e]
- Updated dependencies [af8a173]
  - @opengeni/contracts@6.4.0
  - @opengeni/observability@6.4.0
  - @opengeni/config@6.4.0
  - @opengeni/codemode@6.4.0
  - @opengeni/codex@6.4.0
  - @opengeni/network@6.4.0
  - @opengeni/subscriptions@6.4.0
  - @opengeni/xai-subscription@6.4.0

## 6.3.1

### Minor Changes

- d5db2de: Products embedding Opengeni can let agents call their users: the backend, acting as the person, states how many of their phones it rings (`setAgentCallHostPhones`, `PUT /v1/workspaces/:ws/agent-call-phones`), and agents count those phones alongside the Opengeni app's. The product rings its own app from the `session.agentCall.ringing` webhook.
- d91058a: Agents can call a person. The new `call_user` tool rings the person's phones with the system's incoming-call screen (CallKit on iOS, through a PushKit VoIP push) when something cannot wait, waits up to 40 seconds while it rings, and returns `answered`, `declined`, `missed` or `cancelled`. Answering opens the chat's voice call, which starts by saying why the agent called. Nothing rings until the person turns on "Let agents call this iPhone" on that phone (native push rule `call`); "Teammates' agents too" (`call_members`) lets agents of other workspace members call them. One call rings a person at a time, a chat calls at most three times an hour, and after a decline it cannot call again for 15 minutes. A missed call leaves a "Missed call" notification. New: `session.agentCall.ringing` and `session.agentCall.settled` events (also subscribable by workspace webhooks, so a product can ring its own app with its own push credentials), `GET /v1/workspaces/:workspaceId/agent-calls/:callId` with `/answer` and `/decline`, the SDK's `getAgentCall`, `answerAgentCall` and `declineAgentCall`, the native push device's `voipToken`, and in `@opengeni/react-native` `useIncomingAgentCalls` and `useNativeVoipToken`.
- b5c112c: Approval cards for app actions name what they change. The server reads each id the action takes, as the person the chat acts for, and the question names the target in its own words, for example "Remove the Gmail connection for anna@example.com?", with a few facts beneath it (who can use it, when it was added). Arguments the agent wrote never write the question or the facts; in Details they sit under "Sent by the agent". A target the person can't see, or one that can't be read, keeps the plain wording. Answered approvals say what was decided for each action, one line each in a batch, instead of "You responded to this approval." Slack's private review shows the same question and facts. `@opengeni/db/app-action-targets` is a new subpath.
- 32bc3e9: App use is paid from monthly plan credit; API use (organization and personal API keys, products on the SDK, outside agents over MCP) is paid from credits only. Each turn freezes its funding origin, sub-agents and tools inherit their chat's, and API work with no credits is refused with `402 api_credits_required` and an Add credits action (`1128_billing_usage_origin`, rolling; it adds `billing_origin` to the scheduled-task execution exclusion lists in place, keeping 1115's `creator_locked`). See `docs/billing-origin.md`. A schedule an API caller edits or runs by hand, or an automation an API caller's test event or replay fires, is API use from then on, and so is an automation fired by a webhook whose signing secret or custom format an API caller set or received (`event_sources.secret_billing_origin`), and so is an automation fired by a workspace MCP source an API caller pointed at a server's URL. The agent tools that create and change webhook sources mark them the same way for an outside agent or an agent in an API chat. A custom webhook format can no longer read its event type or ids from the header its signature is in, so a shared token is never stored in events or the delivery log; one stored before reads that header as absent. Intake also drops any header that contains the source's secret and replaces copies of it in the kept body with `[secret]`, so a `url_token` secret echoed by the app or a proxy is never kept. The web app shows an API turn refused for lack of credits as a credit stop. Paid tools in the app are paid from plan credit too, the Free plan's included. Internal accounts (CloudGeni's host account and our own team's organizations) keep today's billing through `OPENGENI_BILLING_LEGACY_ACCOUNT_IDS` (listed by default). The SDK keeps the `add_credits` and `upgrade_plan` refusal actions and names the fix in its messages.
- d872b12: Feedback reports carry what is needed to debug them, not just a screenshot. A report's `context` can now name the chat in view (`sessionId`) and carry the app's latest API requests (`recentRequests`: method, path without its query, status, duration and the server's correlation id, which finds the request's logs), errors nobody caught and files that failed to load (`recentExceptions`, with stacks), and the steps before it (`breadcrumbs`: screens opened, the app hidden or shown, the network lost or back). The web and desktop console and the phone app record these in memory and send them only with a report; the forms say what is sent. The server also stores, with each report and never shown to clients, its own version and deployment revision and, when the author can read the chat in view, that chat's status, last event sequence and latest turn (status, model, reasoning effort and times) in the new `feedback_submissions.diagnostics` column. `OPENGENI_CORRELATION_HEADER` is exported from `@opengeni/sdk/browser`. The phone app resends a report without the new fields when a server older than the app refuses them.
- c35704f: Meetings name themselves. Nobody has to type a name: a meeting started without one is named after the event on its owner's connected Google or Outlook calendar at the time it started, or else, once its notes are written, from what was said (the built-in summary passes a short name to `meeting_notes_save` as the new `title`). A name someone types, at start or by renaming, always wins and is never replaced. Recordings carry `titleSource` (`person`, `calendar`, `conversation`, `app` or `default`; migration 1132 adds it, and existing recordings are `person`), and create requests may pass `titleSource: "app"` for a title the app only guessed, such as the desktop app's "Zoom meeting". The web and phone recorders no longer send a made-up date name, the recorder shows the calendar name once the server has it (`serverTitle` in the upload status), and the meeting page shows the new name when the notes arrive. Private, declined, cancelled and all-day events are never used, and the calendar lookup never holds up capture.
- f4ad926: New organizations start with "Switch models when subscriptions run out" on: when a chat's subscriptions run out, it continues on a subscription model of the same tier from another provider instead of waiting, and never falls back to Opengeni credits. Existing organizations keep their stored value. Rolling migration 1144 changes only the value the new-organization seed writes. Switching still takes effect only where the deployment turns it on (`OPENGENI_SUBSCRIPTION_CROSS_PROVIDER_FAILOVER_ENABLED`, off by default). Organization and workspace model-account settings now report `crossProviderFailoverAvailable`, and the settings pages hide the switch and its fallback order while the deployment doesn't switch models, instead of showing a setting that does nothing.
- e53c5ad: An organization's credential provider can now also serve its members' Personal workspaces. Organization settings → Developer → credential provider has a "Personal workspaces" checkbox, off by default, so existing providers keep their current reach. Through the API it is `allowPersonalWorkspaces` on `PUT /v1/organizations/:organizationId/credential-provider`; like every field there it is replaced on each PUT, so leaving it out turns it off.

  The workspace filter still selects shared workspaces only, and the checkbox alone decides Personal workspaces. A Personal workspace's own provider still wins over the organization's. Requests from a Personal workspace carry its workspace ID and, for turns, the member as `initiatingHuman`. Organization webhooks still never cover Personal workspaces, because they would send a member's private chat activity to the organization's endpoint.

- 83520e5: A personal (Only me) login's tool choices (Allow, Ask first, Block) now belong to the login and follow it between workspaces. They are kept once, in the workspace the login was connected from: saving them from any workspace stores them there, and a turn in another workspace that uses the login starts with them (`connectorActionPolicySnapshotForTurn`). Before, each workspace kept its own copy, so the same login asked again in every new workspace. Rolling migration 1145 merges existing copies into the login's own workspace, where the strictest choice wins (Block, then Ask, then Allow) and ties go to the most recent. Workspace logins and credential-free servers keep their workspace's choices.
- a550481: An organization can now limit what each person spends from its credits in their own Personal workspace each month. Organization settings → Billing has a "Personal workspaces" section with a monthly limit per person, off by default. Through the API it is `personalWorkspaceMonthlyCredits` (USD micros, `null` for no limit) on `GET`/`PATCH /v1/organizations/:organizationId/privacy-settings`, next to the existing Personal workspaces switch, and the same owners, admins and administration-capable organization keys change it. Agents can't, even with full access, as with workspace budgets. Setting a limit needs `OPENGENI_USAGE_ALLOWANCES_ENABLED`; removing one doesn't.

  The limit acts as the monthly budget of every Personal workspace that has no budget of its own: usage reads report it with `resetsAt` at the next calendar month (UTC), and work stops with the usual `allowance_exhausted` refusal once it is spent. It counts the month's spending so far, including before it was set. Work paid by the person's own model plans or keys spends no credits and never counts. The person sees the limit on their Usage page.

- 1afdda0: An organization's Allowed models list is now a ceiling for every workspace in it. A workspace's own list only narrows it: a model runs only when both lists allow its provider and both allow the model, so a workspace that allows every model allows exactly what its organization allows, and listing a model the organization doesn't allow never lets it run. Before, a workspace's own list replaced the organization's. The combined policy applies at the API edges, the omitted-model default, goal admission, subscription placement and failover, and the worker's model gate. The workspace model catalog adds `organizationAllowed` (false when the organization's list rules a model out, omitted when it allows every model), and the Allowed models form shows those models locked. `GET /v1/workspaces/:workspaceId/model-policy` still returns the workspace's own lists as saved, next to the `organization` lists.

### Patch Changes

- c2e0db6: Store a pending tool call's replay output within the same 256 KiB bound as its `agent.toolCall.output` event. A tool that returned more than PostgreSQL can hold in one JSONB string (256 MiB) used to fail the whole turn with SQLSTATE 54000; the stored copy now keeps a head and tail preview with a `truncation` marker, and recovery replays that marker on the event.
- e104fbb: Issue canonical secret permissions in default workspace grants, managed personal-workspace projections, new chat and schedule settings and new MCP OAuth grants instead of the retired Variable Set aliases. OAuth exchanges and refresh rotation canonicalize successor tokens, and live permission intersections compare equivalent names. Personal-resource discovery and grant gates require canonical secret permissions, retaining support for equivalent historical grants without rewriting them. Effective secret access is unchanged; explicit empty lists stay empty. Existing accepted turn, schedule and token snapshots retain their original authority and bytes.
- 40b79c9: Claude subscription models no longer disappear from a workspace when the Claude accounts serving it are not managed by that workspace. The catalog, model admission and cross-provider failover now count every Claude account that serves the workspace, the same accounts placement already used, for both the `workspace-claude-subscription/` and `organization-claude-subscription/` model ids. Readers also accept the upcoming canonical `claude/<model>` ids (provider `claude-subscription`), which a later release starts writing; the two legacy ids stay accepted as aliases.
- 64beb77: Add an owner-only Free credit signup cutoff (rolling migration 1119). `opengeni_private.set_free_credit_signup_cutoff(not_before, operator, reason, expected_revision)` writes an audited, revision-fenced setting; while it is set, new Free monthly periods go only to organizations whose signup-receipt owner was created at or after the cutoff. No cutoff (the default) changes nothing, and issued periods stay untouched and spendable. `scripts/operator/promotion-decisions.ts` gains `--free-credit-cutoff <timestamp|none>` and `--free-credit-cutoff-history`.
- 98542ad: A meeting's notes keep naming the right people after its transcript is run again. Speaker links in the notes (`[Name](speaker:speaker_0)`) name the labels of the version they were written about, and a new version numbers its voices afresh, so a link could show no one or a different voice. When another version becomes the shown one, each link now moves to the label whose speech overlaps most of its own (a track label stays itself), and a link with no counterpart becomes its plain text. The rewrite is a new notes revision and a `recording.notes.updated` event, and keeps who wrote the notes and when.
- 278ad58: Allow explicitly retired feature tables to be removed in a later release while preserving exact owner, privilege, row-level-security and protocol-receipt checks for every table still present.
- 59d708c: Remove unused declarations and column projections for retired features, preserving current subscription account projections and safe cleanup of historical workspace attachments.
- 79605f2: Remove retired per-account subscription cutover switches from current SQL authorization, accepted-authority and connection-health callers. Existing provider protocol receipts and all live membership, connection, generation and accepted-turn fences remain enforced. The migration refuses an incomplete predecessor cutover instead of changing its behavior silently.
- af8fb16: `sandbox_file_publish` called through Codemode from code that a `run_on` exec runs on another machine now publishes the file from that machine, where the code made it, instead of looking for the same path on the chat's active sandbox. The exec's Codemode token names the machine it runs on, the Codemode call records it, and publishing checks access to that machine exactly as `run_on` does. When the machine can no longer be reached, the call fails with `run_on`'s own reason rather than publishing a different file. Model calls and code on the active sandbox resolve paths as before.
- bb16142: Hosted web-search results reach the model as a labelled search record in the user role instead of as the assistant's own message, so models stop imitating them and writing raw search JSON into the chat. The form belongs to the session: new sessions use the record from their first turn, and an existing session switches only once its history no longer holds a search (after compaction or clearing), so no text an earlier request sent changes and prompt caches stay intact. A record never separates a tool call from its result. In every session, a model-written copy is not shown while it streams, and a reply that is only a copy gets the usual nudge for a real final answer.
- 94ba6a2: Seat limits no longer refuse writes that take no new seat. Signing in with a pending invitation to an organization that is over its seat limit (after a downgrade or a lower plan limit) binds the invitation instead of failing the sign-in and locking the person out of every organization, and repeated membership-anchor inserts for an existing member are no longer counted. New invitations and new members are still refused over the limit, and the refusal's details now include the organization's `planKey`. Sign-in binding now handles each organization separately: if one organization's binding fails for any reason, its invitations stay pending for the next sign-in, a WARNING "organization invitation binding skipped" is logged, and the person keeps their other organizations.
- 3a47d0b: A new turn in a long chat no longer reads the chat's whole history to find the billing origin it inherits. `1142_session_turn_origin_lookup_index` (rolling, built concurrently) adds a partial index on a chat's turns that have an origin, newest first, which the inherit trigger from `1128_billing_usage_origin` probes for its chat and parent chat. Before, a chat whose earlier turns had no origin made every new turn read all of them, so inserting turns grew quadratically with the chat's length.
- Updated dependencies [d5db2de]
- Updated dependencies [d91058a]
- Updated dependencies [b5c112c]
- Updated dependencies [32bc3e9]
- Updated dependencies [923c161]
- Updated dependencies [ced76d5]
- Updated dependencies [40b79c9]
- Updated dependencies [d872b12]
- Updated dependencies [c35704f]
- Updated dependencies [008d073]
- Updated dependencies [d0295f8]
- Updated dependencies [e8b24d1]
- Updated dependencies [99159e9]
- Updated dependencies [f4ad926]
- Updated dependencies [e53c5ad]
- Updated dependencies [a550481]
- Updated dependencies [af8fb16]
- Updated dependencies [139a2be]
- Updated dependencies [1afdda0]
  - @opengeni/contracts@6.3.0
  - @opengeni/config@6.3.0
  - @opengeni/subscriptions@6.3.0
  - @opengeni/codemode@6.3.0
  - @opengeni/codex@6.3.0
  - @opengeni/observability@6.3.0
  - @opengeni/network@6.3.0
  - @opengeni/xai-subscription@6.3.0

## 6.2.1

### Minor Changes

- 7c94b6e: Find in a chat (Cmd/Ctrl+F) now covers the whole chat and starts at the newest match. It counts matches in the background, so the bar reads "3 / 120" instead of "1 / 50+"; in a chat with thousands of matches it shows how many it has found so far. Previous from the first match goes to the newest, Next from the newest goes straight to the first, and Enter, Shift+Enter, the arrows and Cmd/Ctrl+G all step through matches. Closing and reopening the bar starts again at the newest match. Session message search accepts `order: "newest"` to walk messages newest first; the default stays `oldest`, and `groupBy: "session"` only supports `oldest`.

### Patch Changes

- cbfd911: Insights can show the last hour, the last 3 hours and the last 24 hours, and a custom range now takes a start and end time to the minute. Usage requests accept `range` values `1h`, `3h` and `24h`, and custom `from`/`to` as UTC instants (`YYYY-MM-DDTHH:MMZ`, end exclusive) as well as UTC days (end inclusive). Buckets follow the window length: 5 minutes up to 3 hours, hourly up to 2 days, then daily, so `bucket` can now be `five_minutes`. The prior window is always the same length immediately before. Usage responses list `availableRanges`, the ranges that server serves.
- 7af3643: A workspace can connect its own OpenAI-compatible model API: Settings → Models → "Connect an OpenAI-compatible endpoint" asks for an HTTPS base URL, an API key, a model ID, the API format (Chat Completions or Responses) and an optional name. The model then appears in that workspace's picker like any other direct model, billed to the workspace's own key, which never leaves that workspace. The same works through `POST /connections` with `metadata.credentialRole: "direct_openai_compatible"` and `metadata.directModelProvider: { provider: "openai_compatible", baseUrl, model, api?, label? }`.

  Only public HTTPS hosts are accepted, and every request resolves the host once and refuses private addresses and redirects. These endpoints report an unknown data location, so residency policies that require a known region leave them out. A model check that cannot reach any direct provider now answers 422 with the reason instead of a generic "temporarily unavailable".

- Updated dependencies [cbfd911]
- Updated dependencies [7c94b6e]
- Updated dependencies [7af3643]
  - @opengeni/contracts@6.2.0
  - @opengeni/config@6.2.0
  - @opengeni/codemode@6.2.0
  - @opengeni/codex@6.2.0
  - @opengeni/observability@6.2.0
  - @opengeni/network@6.2.0
  - @opengeni/subscriptions@6.2.0
  - @opengeni/xai-subscription@6.2.0

## 6.1.1

### Minor Changes

- 6573dc7: The system instructions and tool list follow how a chat started and never change mid-chat, so earlier requests stay cacheable. A chat that a scheduled task or event trigger starts unattended is told so from its first turn, like a session created with `unattended: true`. When the switch, or a person writing in an automation's chat, makes a turn's attendance differ from how the chat started, that turn's input carries a short note saying so (the unattended guidance, or that a person is now present and can answer). In a chat switched to unattended after it started, a question or hand-off to a person returns at once with a result saying no one will answer.

  Unattended sessions no longer wait on a person anywhere. A call that needs someone's approval under the workspace's tool permissions is refused at once with an error result saying nobody can approve it in an unattended session, in model tool calls and in Codemode, so the agent works around it and lists it as a step left for a person. Nothing is approved and no approval request is opened; permissions stay exactly as configured. Chats that scheduled tasks and event triggers start are unattended by default; a task chooses with `agentConfig.unattended`, and a task that sets `approvalTimeoutSeconds` without it stays attended. A new **Work without me** switch in a chat's Agent tab turns unattended mode on or off from the next turn, through `PUT /v1/workspaces/:workspaceId/sessions/:id/unattended` (SDK `updateSessionUnattended`); session reads include `unattended`. Explicit choices (the switch, the create option, a task's `agentConfig.unattended`) stay; only the automatic default of a scheduled or event-triggered chat ends when a person writes in it from the web app, Slack or a voice call. Interactive sessions are unchanged.

- 9cf4bc0: Sessions can be created unattended. `unattended: true` on session create says no person will see or answer questions until the task ends, as in an API automation or another headless run. Until now the agent could not tell, so it ended such runs with a question nobody would read. An unattended session's instructions say a question ends the work unanswered: settle open choices with the most conventional option, finish the reversible work inside the workspace, never take or stand in for a step only a person can take, leave that and anything destructive, external or unauthorised undone, and end with the result, the assumptions made and the steps left for a person. Tools that wait for a person (`request_human_input`, `interaction_request_human`) are not offered. The setting is frozen at create under a reserved metadata key that caller metadata never sets, is not inherited by child sessions, a fork reads as attended, and a keyed retry that changes it conflicts. Interactive sessions are unchanged byte for byte.

### Patch Changes

- 0422c7b: Connecting Gmail now asks Google only to read mail. When an agent later needs to draft, send or organize mail, the chat shows "Give Gmail more access" with an Allow button, which reconnects the same account and asks only for the missing permission; everything already allowed stays. Once the account holds that access, the agent carries on by itself, the same way it does after a first connection. Every Gmail tool stays in the agent's tool list; a tool the account cannot use yet stops before anything runs and before any approval card. Accounts connected earlier keep their access.

  Connect begin requests accept an optional `requestedScopes` list for a reconnect (`reconnectAccountId` is required with it), and OAuth provider profiles can declare `incrementalScopes` that are asked for only when requested or already granted. The connection token resolver now returns `grantedScopes` for every OAuth credential. The capability continuation request also accepts `{ connectionId }`: after a reconnect from an account's own card, the chat continues once that account is active and holds the scopes the card asked for.

- Updated dependencies [0422c7b]
- Updated dependencies [9f02c05]
- Updated dependencies [6573dc7]
- Updated dependencies [9cf4bc0]
  - @opengeni/contracts@6.1.0
  - @opengeni/codemode@6.1.0
  - @opengeni/codex@6.1.0
  - @opengeni/config@6.1.0
  - @opengeni/observability@6.1.0
  - @opengeni/network@6.1.0
  - @opengeni/subscriptions@6.1.0
  - @opengeni/xai-subscription@6.1.0

## 6.0.2

### Minor Changes

- 83ed5c0: An automation whose chat is parked waiting for a model account (for example a Codex plan with no usage left or none connected) now says so. Its skipped runs record `scheduled_session_waiting_capacity` instead of `scheduled_session_not_idle`, and they read "Skipped because the chat is waiting for a model account. Pick another model in the chat." The schedule's notice names the same fix. A scheduled update refused by such a chat returns the new reason `session_waiting_capacity`. The new message key is `automations.run.error.chatWaitingForAccount`.
- 44ba53b: Bots, finished. Bot templates now have a visibility: `workspace` (everyone who can open the workspace) or `private` (only the person who saved it). The template dialog has a "Who can use it" choice and private templates show an "Only me" chip. When an agent in an Only me chat saves itself with `bot_template_save`, the template is private; a run with no person behind it cannot save from an Only me chat. A `sourceSessionId` sent to `POST /bot-templates` must be a chat in the same workspace that the caller can open.

  Marketplace plugins are listed in the integration catalogue (`kind: "plugin"`), so an agent can find one with `capability_catalog_search` and offer it through the same in-chat card it uses for connectors. The card shows the agent's reason, who made the plugin and what it adds, and the person reviews and installs it from there. Someone without permission to manage the workspace's plugins sees that a workspace admin has to install it, and the agent is told the same. `PluginDetails` takes `showIdentity={false}` for hosts that already show the plugin's name and logo.

  In Slack, a bot chat with an avatar can post its replies under its own name and avatar. This uses the optional `chat:write.customize` scope, so a Slack admin must reinstall the app to grant it; without it, posts stay under the app's name. The avatar image comes from a new signed public route, `GET /v1/public/session-avatars/{token}.png`. The API image now includes an emoji font so emoji avatars render in that image.

- f385091: A person can share a chat with a read-only link. The link opens a snapshot of the conversation exactly as the chat shows it (each person's messages under the name the chat shows for them, never an email, and the replies; queued messages that were deleted, edited or cancelled before they ran, images and links to the chat's own files left out) without signing in, and only while the person who shared it can still read the chat. The share page loads no third-party analytics that record its address and is never indexed. The person who started the chat creates, refreshes or stops it from the chat's Share… menu item or by asking the agent, which runs `createSessionShareLink` after one confirmation; `listSessionShareLinks` lists their links. `OPENGENI_PRIVACY_CHAT_SHARE_LINKS_ALLOWED=false` turns links off and stops existing ones opening. Member changes on a personal workspace now say that personal workspaces are private to their owner and point to a share link when that person can create one, instead of "missing permission: members:manage".
- d8a1b83: A Codex chat can now switch to any other model in the same chat. Chats that use ChatGPT's own memory of long conversations (remote compaction) used to be locked to Codex models, so a used-up Codex plan left them stuck. Now picking another model just works: before its first reply, the chat's earlier messages are summarized again from Opengeni's stored history, so the new model can read them, and the chat keeps a shared summary from then on. The transcript shows one short note, "Earlier messages summarized for the new model". If Codex already compacted the chat, choosing another model shows one line saying earlier messages will be re-summarized, so it may remember less detail. When a Codex usage limit stops a chat, one line says when it resets, with a "Continue at reset" switch. It is on by default: the chat waits and continues on its own at the reset. Turning it off pauses the chat until the person continues it. Picking another model in the picker continues the chat with that model right away. The usage-limit failure now records `resetsAt` when the reset is known. The "Keep Codex chats portable" workspace setting is gone because switching always works; the `codexCompactionDefault` API field is still accepted. The `codex_compaction_v2_provider_locked` error code stays in the contracts for older clients but is no longer returned.
- aa6b340: When the agent changes a chat's model (for example with `session_set_model`), the composer now shows the new model and the person's next message runs on it, instead of silently switching the chat back to the model the composer had loaded. A composer draft either holds the person's own pick or follows the chat's settings: `ComposerDraft.policyFollowsSession` says which, and while it is true the draft's `model`, `reasoningEffort` and `latencyMode` are the chat's current ones. `saveComposerDraft` and `submitComposerDraft` take those three fields together or not at all; without them the draft follows the chat and the message runs on its current settings. Picking a model, effort or speed in the composer still makes it the chat's setting when the message is sent, after which the composer follows the chat again. Composers on web, phone and embeds (`useComposer`) refresh on `session.model_settings.updated`, and `useComposer` exposes `sendPolicy`: the person's pick, or null while following. Clients that always send a model keep today's behaviour.
- e8bc121: EU-only content stays in EU-only workspaces. A session reaching another workspace (session tools given a `workspaceId`, or `admin_action_call` naming one by id or by external identity) is refused when it would bring an EU-only workspace's content into a workspace that isn't EU-only, or carry an EU-only session's messages or changes there; nothing runs when the setting can't be read. API routes answer such a refusal with the new error code `region_restricted` (HTTP 422). New `@opengeni/db` exports: `assertWorkspaceContentFlowAllowed`, `assertWorkspaceContentExchangeAllowed`, `assertOrganizationContentFlowAllowed`, `assertOrganizationContentExchangeAllowed`, `workspaceContentFlowEnd` and `WorkspaceContentFlowRefusedError`.

  Opengeni's own MCP endpoints added to a workspace as a remote MCP server get the calling workspace in an opaque, encrypted `x-opengeni-calling-workspace` header, sent for Opengeni's own host however it is spelled and for any request carrying an Opengeni API key or MCP OAuth token. Each MCP endpoint refuses a call beyond the handshake before it runs unless content may go both ways between the calling workspace and what it reached, and one middleware on `/v1/mcp` and every `/v1/workspaces/:workspaceId/mcp` endpoint fails closed when an endpoint skipped that check. MCP OAuth consent for Opengeni's own client, and saving an Opengeni API key as an MCP credential, are checked both ways too. New `@opengeni/contracts` exports: `OPENGENI_CALLING_WORKSPACE_HEADER`, `signCallingWorkspaceProof` and `verifyCallingWorkspaceProof`; new `@opengeni/runtime/calling-workspace` entry point; new `@opengeni/core` export `assertMcpCredentialContentFlowAllowed`.

- f6c6c0f: EU-only inference covers side features. Web search, image and video
  generation, live voice, transcription, Knowledge embeddings and decision
  models each have residency records; under EU only routes with an EU record
  run, nothing falls back outside the EU, and switched-off features report
  `region_restricted` (shown as "Not supported in EU"). Operators declare EU
  routes with `OPENGENI_SIDE_FEATURE_RESIDENCY_JSON`, each for the one endpoint
  (and, for Azure voice and transcription, the one deployment) it describes; a
  declaration missing that deployment leaves the route unknown with a warning
  rather than failing boot. Usage events record where each call ran. Under EU
  the model transport admits only tools Opengeni executes itself.
- 09972b5: One mechanism reads every app's webhooks. Linear and Sentry are now presets of the custom webhook, like Tailscale, and their own adapters are gone: `WEBHOOK_FORMAT_PRESETS` has `linear`, `sentry` and `tailscale`, and sources stored with the `linear` or `sentry` adapter read as `custom` with that preset (`currentWebhookAdapter`, `webhookPresetOf`). Creating one with the older adapter still works and stores it as `custom`. A format can now say more:

  - `signedContent` on `hmac_sha256` for apps that sign more than the body, such as `v0:{header:X-Request-Timestamp}:{body}`.
  - An `ed25519` scheme, whose secret is the app's public key.
  - A `url_token` scheme for apps that can't sign: the secret is part of the address, at least 24 URL-safe characters.
  - `freshness`, which refuses deliveries whose send time is too old.
  - A `type` joined from `parts`, lists of fallback paths for the text fields, and `actorKind` to tell people from bots.

  Agents with `scheduled_tasks:manage` can add webhook sources themselves. `event_sources_create_webhook` takes a preset or a format and a signing secret, which can be a secret reference, and returns the address to give the app. `event_sources_update` and `event_sources_delete` change and remove sources. For a webhook source, `event_sources_list` with its `sourceId` now shows its format and last five deliveries. The event-triggers Skill explains how to write a format from an app's webhook docs.

  A secret reference in those tools' `signingSecret` resolves to its value, and only there: the source keeps the secret encrypted, and a name or format next to it stays reference text. A reference that could not resolve is refused rather than stored.

- 28a87b9: Passkey sign-in turns on: rolling migration 1110 grants the runtime role the passkey store that 0998 withheld for one release, and readiness now requires it.
- 449bcae: An MCP server can now ask the person a question in the middle of a tool call (MCP form elicitation, revision 2026-07-28, multi round-trip): a confirmation or a form to fill in. Model calls to third-party MCP servers declare that they can answer forms (form mode only; URL mode is not offered, and a server that asks for a page anyway ends the call with an error result). When the server answers `input_required`, the call pauses as an approval of the same call, the person answers in the approval card (possibly hours later, including in unattended runs), and the call is retried with the answer and the server's byte-exact `requestState`. Declining is sent to the server too (`action: "decline"`), so it can release what it was holding and finish the call its own way; the model then sees the server's result followed by a short note that the person declined. The model never sees the question or the answers. `session.requiresAction` approvals carry a new `elicitation` field (`{ server, round, requests }`); `user.approvalDecision` takes `content` and `elicitationRound`. Approving an approval with `elicitation` requires `elicitationRound` to be the current question's round, and the API checks `content` against the server's form (422 with the reason otherwise), so a stale card or a surface that never showed the question cannot answer a newer one. The question shows on every approval surface: the session card (web and native), the inbox (the question as the title; Allow for a short confirmation, Answer for a form), phone push ("<server> asks: …", opening the app, with no lock-screen actions) and private Slack cards (Allow for a confirmation, a link to answer a form in Opengeni). Connector action records gain `input_round`, so a tool with an Ask policy or saved rule can be asked more than once and answered in a later worker attempt. New exports: the `McpElicitation*` schemas, `MCP_ELICITATION_MAX_ROUNDS` and helpers in `@opengeni/contracts` (also at `@opengeni/contracts/mcp-elicitation`), and their types including `McpElicitationAnswer` in `@opengeni/sdk`; `InboxItem.serverQuestion` (`{ server, kind, round }`); `sendApprovalDecision` accepts `content` and `elicitationRound`; React `ApprovalSurface` renders the question and passes `{ content, elicitationRound }` to `onApprove` as its second argument, and `McpElicitationRequest` is exported from `@opengeni/react/session-ui`; React Native `ApprovalStrip`'s `onDecide` receives the same answer as its third argument; `@opengeni/testing/mcp-elicitation-server` is a fake server for client tests. See `docs/mcp-elicitation.md`.
- 6e33a98: A meeting recorded with computer or tab audio now tells apart the people in the room with the person recording. Before, its microphone was never diarized and every word on it was named after the owner, so someone sitting next to them disappeared into the owner's speaker. Now every track is diarized. One voice on the microphone is still the owner. With several, the owner's voice is the one matching their remembered voice when the workspace recognizes voices, else the one that spoke the most, and the others become `Speaker 1`, `Speaker 2`…. Echo removal runs first, so the call's echo never counts as the owner. The owner's voice vector is now kept under `track-N` too. Diarized labels are numbered across the whole recording (`speaker_0`, `speaker_1`, …) instead of per track with a `t1_` prefix, so two tracks no longer both show a "Speaker 1". `RecordingTrackPlan` now has `recorderLabel` instead of `fixedLabel` and `diarize`, `RecordingTrackWords` has `recorder` instead of `fixedLabel`, and `withRecorderVoice` (core) plus `memberVoiceprints`, `voiceMatchingVoiceprints` and the `KnownVoice` type (db) are new exports. Re-run a transcript to apply this to an earlier meeting.
- d9df3db: The built-in meeting notes no longer step aside when the meeting's owner has an automation on `recording.transcript.ready`. That check was a guess: it ignored the automation's filters and could not tell whether the automation writes notes at all, so an automation that only posted somewhere else still stopped the notes. The notes now start whenever the workspace's switch is on and the meeting has none. Nothing is overwritten: the built-in notes and the "Meeting notes" template both save only the first notes. `meetingSummaryCandidate` no longer takes `eventTriggersEnabled`, and its `own_automation` reason is gone.
- a02dca4: Record where each agent-session model call that writes a model-call fact
  (turns, compaction and session titles) was processed. Each fact and its durable
  `agent.model.usage` event carry the serving route's residency claim
  (geography, deployment type and regions, never evidence), facts rebuilt from
  usage events keep it, and Insights calls expose each call's
  `processingGeography` (undefined from servers older than this release). Calls
  recorded before this change read as null; a new call whose route is not known
  is recorded as unknown, and a stored eu claim that breaks the eu rules reads as
  unknown.
- 177de8d: Add the organization EU-only inference setting. Any member can read it; owners
  and admins (or an administering organization key or agent) can turn it on, and
  only an owner or admin in the app in a browser, signed in within the last five
  minutes, can turn it off. The database
  makes every change through one function that checks these rules and records it.
  Changing it becomes available once a later release grants that function.
  `isWorkspaceEuOnly` answers whether a workspace's model calls must stay in the
  EU and throws when it cannot tell; enforcement follows in later changes.
- 047bf8c: A Personal workspace now learns and keeps files like a shared workspace. Its workspace chats, scheduled tasks and Site guest chats save Knowledge, Skills and instructions to the Personal workspace's own Workspace layer under its modes, and its files and Sites follow the chat's audience. Only me chats still learn for their person. Nobody but the owner can be in a Personal workspace, so its Workspace layer stays private to them; organization admins, other members and other workspaces still cannot reach it. As in a shared workspace, a workspace chat there doesn't read the owner's Personal Knowledge or Only me files, and the files it makes are Workspace files; existing workspace chats and schedules there no longer read the owner's earlier Personal Knowledge or Only me files, and a schedule there takes Only me files only for an Only me target chat. Migration 1095 copies the owner's Personal learning modes, and their chat and task overrides from that workspace, to its Workspace layer when it has none, and existing personal data is unchanged: the owner and their Only me chats keep it. The Agent learning page in a Personal workspace shows its Workspace layer beside "Your private chats". Publishing an Only me Site no longer silently shares it; share it first, as in any workspace.
- 6c5a6b5: Projects get a profile like a chat's: a description and an avatar (an emoji, icon or letters on a colour, or a workspace image). The avatar replaces the folder icon in the sidebar, the new-chat project picker and the Move to project lists, and pointing at a project shows its description. **Edit project…** in the project's menu replaces **Rename project** and opens the same dialog as a chat's **Edit profile…**. `Channel` gains `avatar`, `POST`/`PATCH /v1/workspaces/:workspaceId/channels` accept it, and agents set it with `project_create` and `project_update`. Changing it needs the same permission as a rename, and an image avatar must be shared with the workspace.
- 71bcf11: A saved message that was sent for one of the person's machines no longer leaves the chat at a dead end after the chat moves to another of their machines. The chat now names the machine the message was sent for, offers "Run it on …" (move back, then one recheck), and explains how to send it again on the current machine instead of offering a recheck that can't pass. `SessionMachineAccess` gains `queuedTurnNotApprovedHere` and `queuedTurnApprovedMachines` (machine names only for the message's sender), and `@opengeni/react/session` exports the shared model. The generic "not approved for this chat" wording no longer tells the owner to ask the owner.
- 942fcc1: Workspace owners and admins can remove a secret from stored session history with `POST /v1/workspaces/:workspaceId/secret-redactions`. Choose sessions (optionally with their descendants) and match either a vault reference, whose value is read in memory only and never returned, logged or audited (this also needs `secrets:use` on the item), or built-in patterns: URL passwords, optionally for named hosts only, and GitHub tokens. Every stored copy, including archived sessions' long-term storage, is replaced by `[redacted: <reference or kind>]`. `dryRun` counts without changing anything, a second run is a no-op, and the response and audit event carry counts only. New contract exports: `SecretRedactionRequest`, `SecretRedactionResponse`, `SecretRedactionMatch`, `SecretRedactionPattern` and `SecretRedactionCounts`. `@opengeni/storage` now exports `writeCompressedJsonLines`, `readCompressedJsonLines` and the `WorkspaceArchiveSpool` type.
- a744c56: Bots. Any chat can now have a one-line description and an avatar (an emoji, an icon, letters, or an image from the workspace) next to its title, which is its name. People set them from the chat header and the sidebar menu; the agent sets them with `set_session_title` and `set_other_session_title`. They are display-only and never sent to the model. `PATCH /sessions/{id}` accepts `description` and `avatar`, and `createSession` accepts `profile`.

  Bot templates (`/bot-templates`) hold a name, description, avatar and setup instructions. Starting a bot from one opens a kept-live chat with the instructions as its first message, and the agent sets itself up from there. The agent can save itself as a template with the new `bot_template_save` tool, and templates export and import as `opengeni.bot-template` files. See `docs/bots.md`.

- 3aaf6ed: Site rows in sidebar projects move like chat rows. Their menu has the same "Move to project" list (Default takes the Site out of every project), and a Site row can be dragged onto a project. The move is shared, like a chat's project: the Site and its conversations in that project go to the new one, and the Site stays published and in Artifacts. New `PUT /v1/workspaces/:workspaceId/published-artifacts/:artifactId/channel` (`updateSiteProject` in the SDK) needs `sessions:control` and control of every conversation that moves.
- a1e75dc: An organization key acting as an external user can now state that user's workspace membership on each request: `asUser(id, { source, membership: { permissions } })`, or `membership` in the `x-opengeni-external-actor` value. Opengeni makes the stored grant in the request's shared workspace exactly those permissions before authorizing the request. It creates a missing member, writes only when the grant differs, and applies the external-members ceiling and last-administrator rules with their errors. Removing the member wins over requests already in flight. Without `membership`, the stored grant applies as before.
- ac2e841: A Microsoft Teams 1:1 chat with the bot now lands in the sender's own Personal workspace, as a Slack bot DM already does, while Personal workspaces are on and they can start chats there. Otherwise it stays in the installation's shared workspace. The Personal workspace comes from the sender's active organization membership, never from Teams. Channels and group chats stay in the shared workspace. An existing 1:1 chat stays where it is; the next message starts a fresh chat in the Personal workspace, and turning Personal workspaces off returns to the earlier one. The bot's installation and the person's Teams link stay in the shared workspace, so losing access there still stops the chat. Migration 1097 adds `teams_bot_routes.session_workspace_id`.

### Patch Changes

- b1cffc3: Record an audit event for every successful model subscription and connector disconnect, naming who disconnected it, what, where, and whether it came from the app, an API key or an agent.
- 073127d: A session parked in `wait_for_input` now resumes as soon as its background command's result is settled, instead of on the wake dispatcher's next 10-second sweep. Terminal background-command settlement returns the wake it commits. Its callers signal the session workflow after commit, concurrently and for at most 5 seconds: a Connected Machine's pushed completion, in-turn, API and reaper retained-process settlement, the selfhosted reaper, and lost or contained sandbox boxes. The dispatcher still delivers any wake a caller could not signal. Local Temporal (`docker compose` and the native dev stack) now serves each task queue from one partition, so queued turns start in the order they were queued. Start an existing local stack with no queued work, or reset its Temporal state, so no backlog is left in the removed partitions.
- 9a450e3: Reduce repeated database reads during prompt admission and input-wait evaluation, and batch session artifact metadata reads while preserving live per-item authorization and bounded concurrency.
- 202e3fd: The subscription usage pools read no longer fails for heavily used organizations. It returned every usage reading and call of the last 14 days as one value, which passes Postgres's 256 MB limit at around a million of them. It now returns each window's changes, its first reading in every five-minute slot, and call totals between readings, so its size follows how often usage changes rather than how many calls ran. The forecast samples usage on five-minute slot boundaries, so it is the same from this read as from every row, apart from how a total's calls are capped when damping call-size outliers.
- c7e16f0: Grant the runtime `EXECUTE` on `list_agent_held_browser_sessions`, which migration `1002_browser_wait_hold` created withheld (`1093_browser_hold_runtime_grant`). Readiness now requires it, and the API renews controller holds on browsers an agent session keeps while it works or waits.
- 7a5395e: Workspace instructions can now be cleared. Saving empty text in Knowledge > Instructions (or creating and activating an instruction policy draft with empty content through the API or SDK) clears the policy: agents get no workspace instructions, the earlier versions stay in History, and any of them can be restored. Clearing also removes an instruction override saved in earlier workspace settings, so nothing applies again by surprise.
- df7dd0d: Rolling migration 1101 grants the runtime role EXECUTE on the connected-command re-arm that 0984 created withheld, and readiness now requires it. A Connected Machine runner that reports its inventory again makes the running commands it never answered for due right away, so they settle on the next reconciler pass instead of waiting for a repair. The caller no longer checks the grant first.
- 7bb4ea9: Use the existing exact ownership index when finding the latest attempt for recovery inventory, avoiding scans of a session's unrelated historical attempts without changing recovery eligibility or polling.
- ad1dc82: First-use admission of an external user now respects workspace member removals the same way a stated membership does: a request that authenticated before the user was removed no longer re-creates the membership, even when it states no membership. A request that authenticates after the removal still admits the user.
- a6004c8: Compact a session's context right after a person's own turn leaves a root session at its automatic compaction threshold, instead of making the next message wait for the checkpoint. The idle request reuses the existing `/compact` maintenance execution, is labeled `proactive` (new `sessions.compact_request_trigger`, migration 1102), skips sessions with an active goal, a held `wait_for_input` or a pending delayed wake, is dropped (with a `capacity_unavailable` skipped landmark) when no subscription capacity is available, and can be turned off with `OPENGENI_IDLE_CONTEXT_COMPACTION_ENABLED=false`. API turns are not included. While it runs the session counts as running, as during a manual `/compact`.
- cebc433: Question cards offer "Let the agent decide". On every ordinary question (never a secret, a Skill review or a secret approval; tool approvals stay human-only) one secondary action replaces Skip and settles the request as `{ outcome: "skipped", agentDecides: true }`, accepted even when the request does not allow an ordinary skip. The agent's tool result carries a note to make its own best choice and say in one sentence what it chose, and the settled card reads "You let the agent decide". On a sub-session's question shown in a parent chat, the action instead sends the parent's own agent a message naming the exact request; the card says "Your agent is deciding" and stays answerable, and the message shows what the agent decided once the sub-session's request settles. `HumanInputForm` takes `onLetAgentDecide` and `agentDeciding`, `HumanInputSurface` forwards them, and `humanInputAgentMayDecide` tells which requests qualify.

  A sub-session's blocking question now also wakes a parent whose goal is completed (the goal is not reopened), so the parent agent can answer it before the person has to. Before, such a parent kept the notice unread and the person was the only one asked. Agents are told to answer a child's question from their task context before the person has to, and to do the agent work it asks for (such as starting a reviewer) and then answer. The `request_human_input` description tells a sub-session to message its parent agent, rather than ask the person, when what it needs is agent work.

- ac9aeba: Reuse a root session's already locked control fields during attempt write admission instead of repeating its ancestry query. Child sessions and KEY SHARE writers retain fresh ancestry reads; pause, authority and interruption fences are unchanged.
- 37538aa: Meetings get their notes written automatically. When a meeting's transcript is ready, Opengeni starts one chat for the meeting's owner (Only me for an Only me meeting, a workspace chat for a shared one) that writes the notes: an overview, topics, decisions and action items, with speakers and people linked as `speaker:` and `person:` mentions. The chat can only read that one meeting and save its notes, and nobody can widen it later. It runs on the workspace's shared Codex or Claude subscription accounts like other background work, and doesn't start when no subscription account can serve it, so it never spends credits or an API key. It never writes over saved notes and steps aside when the owner has their own automation for ready transcripts. Admins can turn it off with "Write notes after each meeting" in the meeting settings (`settings.recordings.autoSummary: false`). `meeting_read` now gives each speaker's label, and the "Meeting notes" template asks for the same format.
- 5a3ed41: Each person can now choose their own default machine in a shared workspace ("Your default machine" in workspace settings). The chats they start begin there, ahead of the workspace default, and any active machine they can use qualifies, including their own Only me machine. Nobody else sees the choice. Automations and agent-created chats keep following the workspace default, and when the chosen machine is removed or no longer available, the person's new chats fall back to the workspace default until they choose again. `GET`/`PUT /v1/workspaces/:workspaceId/my-default-execution-target` reads and saves it (`null` clears it), the new-session draft returns it as `memberDefaultExecutionTarget`, and the SDK adds `getMyDefaultExecutionTarget` and `setMyDefaultExecutionTarget`.
- 8e0b7e2: Organization model API keys (Vercel AI Gateway, OpenRouter, Opper, OpenAI, Azure OpenAI, Anthropic, and ElevenLabs for voice) now reach Personal workspaces like the organization's subscriptions do. A key available in every workspace serves everyone's Personal workspace too, and "Only selected workspaces" has the same Personal workspaces switch; the model access response reports `personalWorkspacesSupported: true` for every organization connection. Keys never reach another organization's workspaces, and each workspace's Allowed models still apply. Rolling migration `1094_organization_model_keys_reach_personal.sql` widens the organization provider scope to Personal workspaces of the same organization and keeps the previous reach of keys limited to selected workspaces (their Personal switch is stored off).

  Billing note: when the organization's default model runs on an organization key, Personal chats and schedules with no saved default model of their own now use it too, so they bill that organization provider account instead of credits or a subscription.

- 840d3fc: The owner of a Personal workspace can now save its model settings, connect and disconnect its own social accounts and send connector Knowledge to it, like a workspace admin of a shared workspace. Organization-wide settings (Slack and Teams bots, the subscription pool, sharing policies) stay admin-only. API callers who lack a permission now get a plain sentence such as "You don't have permission to manage this workspace's tools and integrations." instead of "missing permission: capabilities:manage"; the permission stays available in the error details, and refusal metrics classify these refusals by permission.
- f74d748: Work the owner starts in their own Personal workspace (their chats and scheduled tasks) can now remove that workspace's Skills, as it can already save and edit them. Removal follows the chat's Skills mode: Automatic removes, Review first leaves a deletion proposal for the owner, Off refuses. In shared workspaces a private chat still removes only the person's own Skills, another person's personal Skill stays out of reach, and an agent removal that names a scope is refused. When a removal is refused, the agent now points to the Skills page for workspace Skills and the person's own Skills.
- 66d1e08: Approvals waiting in the inbox and in phone and desktop notifications now say what the action does and where it runs ("Move 3 messages to Trash", Gmail) instead of the raw tool name ("batch_modify_messages"). A pending approval's `display.title` is set to the same title its review card shows, an inbox approval's `body` names the integration (and the account when there are several), and the push reads "Needs your approval: … (Gmail)". The inbox shows that integration in the row's details line instead of a code chip.
- a133a9d: Avoid repeated expansion of identical routine ACLs during live database readiness checks, while preserving the catalog snapshot and every existing posture check.
- 676426c: Connected machines can renew their credentials again. Recording a machine's promotion proof decoded its install key with PostgreSQL's strict base64 decoder, but agents send that key as unpadded base64 (43 characters), which PostgreSQL rejects, so every `POST /v1/enrollments/renew` failed with a 500. Machines whose credentials had expired stayed offline, and connecting a new machine failed at its first proof. The key is now padded (and URL-safe characters translated) before it is hashed, giving the same hash as before for padded keys.
- 21856c5: An agent can now ask a person to act on a browser tab or computer target it has just observed without passing the target's internal generation values. `interaction_request_human` with `operation: "request"` no longer requires `expectedControllerGeneration`, `expectedTargetGeneration` or `expectedDocumentGeneration`.

  When the turn pauses, every request without an `authRunId` reads its target as it is then. Generations left out are taken from that reading; generations given must equal it, or the request is refused. If the target cannot be read, a request that gives all three is recorded as given, and one that leaves any out is refused. A request with an `authRunId` takes and checks its generations against that auth run instead. In every case the controller generation is checked against the live browser or computer session.

  A call that cannot be recorded (the session or tab is gone or has changed, a given generation does not match, the target is unreadable, the auth run does not match, another open request already asks a person to act on the same target, including one opened at the same moment, or an `operation: "wait"` for an intervention that is not open or not this turn's) no longer fails the turn. Nothing is written for it, and the call's result says in plain words why and what to do next: observe again and ask again, leave the expected generation fields out, or wait for the request `browser_auth` returned. Each refused call gets its own result. A pause resumes on one answer at a time, so when several calls of one step are refused, the turn resumes on the first refusal and the next is refused when the turn pauses again. Refused requests are not counted as opened in the intervention metric.

- 46f1de4: Answering a secret approval card now resumes the agent in the approver's own receiving context, the same way a finished capability setup does. Before, the resumed run had no initiating person, so a reference to a secret in the approver's personal vault could not resolve and the agent asked for the password again.
- fb41dfd: Known secret values are masked before they are stored or shown to the model. Each agent attempt remembers the values its secret references resolve to, the credentials Opengeni injects (Codemode bearer, git and broker tokens, host run credentials, MCP header values) and, best effort, the hosted vault values the session tree used before. Tool results, tool-call arguments, model input, context compaction, model-context snapshots and stored conversation text (events, history, messages, goals, notes, run state) replace a known value, and its JSON-escaped, percent-encoded and base64 forms, with the reference that resolved it. Values shorter than 8 characters are left alone, and masking never fails a tool call or a turn. The pure matchers (`SecretValueMemory`, `compileSecretValueMasks`, `maskSecretValues`, `maskSecretValuesInText`) are exported from `@opengeni/contracts`.
- 31e07a6: Secret-shaped strings in tool output are masked. High-precision detectors find URL passwords (any scheme), connection-string passwords, Azure account keys, shared access keys and SAS signatures, PEM private keys and well-known token formats (GitHub, OpenAI, Anthropic, Slack, Stripe, npm, GitLab, Google, 1Password, Opengeni bearers, JWTs), and replace only the secret part. Each value is captured into the root session's Task vault under a stable keyed-HMAC item name and replaced by its reference, so the agent can keep using it without seeing it; when capture is not possible a `[masked <kind>]` marker is written and the tool call still succeeds. The detectors (`detectSecretShapes`, `maskSecretShapes`, `maskSecretShapesInText`, `collectSecretShapes`) are exported from `@opengeni/contracts`.
- fd80817: A person's message no longer waits behind a turn parked on a subscription usage limit (or an account that needs reconnecting). Sending a message now replaces the parked turn and starts right away on the model it was sent with, the same way a message replaces a pending decision. A paused chat, a chat held by used-up Opengeni allowance or credits, a queued-prompt edit, and agent or machine input keep ordinary queueing. `@opengeni/react` adds `promptSendDestination`, which web, embedded and native composers use to show such a message in the chat instead of the queue; the console keeps Pause available while a turn is parked.
- 670913f: Sites can have several pages and use links with query parameters. `site.location` gives a Site its own address (`path`, `search`, `hash`, `href` and parsed `params`), `site.navigate(to, { replace })` moves between the Site's own pages without reloading, and `site.onLocationChange` hears Back, Forward and links. On a published Site this is the real address, kept through sign-in including its `#hash`; in the console it is kept in the Site page's `?page=` parameter. Ordinary links to the Site's own pages now move the Site instead of failing inside its frame (`createOpenGeniSiteClient({ links: false })` opts out). Older hosts report no location.

  Site SQL binds two more verified viewer values: `:viewer_access` (`member`, `invited`, `user` or `guest`) and `:viewer_email` (the verified email in lowercase, or NULL). `:viewer_kind` is unchanged.

- e4f699c: The Slack bot starts a turn in a channel or channel thread only when it is mentioned; a bot DM still answers every message. An untagged message in a thread that already has an Opengeni session no longer starts a turn or calls Slack: it is only recorded, and the next mention in that thread continues the same session with the untagged messages since the previous invocation attached as model context (`listSlackThreadMessagesSinceLastInvocation`, rolling migration `1013_slack_inbox_thread_context_index`). The exact reply `stop` still pauses a mapped thread with or without a mention. A turn can now end without posting: a final response of exactly `NO_REPLY` settles the Slack task with no message. The Slack session instructions ask for short replies by default, and channel copy (hint, failure, billing and input prompts, the reaction start line and `info` card) says to mention Opengeni to continue. No setting existed for the previous answer-every-thread-reply behavior, so none is kept.
- 5c4f5b0: Account administrators without an organization membership (a deployment's configured access key, an account-scoped key or a signed delegation with `account:admin`) can administer the organization's subscription accounts again: connect, reconnect, rename, settings, access and disconnect for Codex, SuperGrok and Claude, in the API and on Organization > Models. Migrations 1103 (rolling) and 1104 let the API record its verified `account:admin` proof for one transaction, and the organization-administrator check accepts it for that subject and account only. The recording routine is created without runtime EXECUTE. A follow-up release grants it, as with any new runtime definer, and that is when the database starts honouring the proof. A workspace owner key can also remove its own workspace's account, starting with this release.
- 067d06b: Reduce redundant tool-catalog hashing and persistence reads during turn startup while preserving catalog bytes, exact-attempt checks and replay verification.
- 35387c2: Turning video on from a chat asks the person once. Where each change waits for a confirmation card, the video tools tell the agent to run the turn-on action instead of asking first, and the card reads "Let every chat in this workspace make videos? A 5-second 480p clip costs … in Opengeni credits." with "Paid with: Opengeni credits" underneath, instead of "Update video generation policy in this workspace?" and the raw funding code. Full-access chats still ask in the chat first, since nothing else would.

  A video whose start the provider refuses now says which side refused and that nothing was charged: the service's own video account ("Video isn't working on this service right now … Trying again won't help until the service is fixed."), the workspace's own gateway or SuperGrok account (a workspace admin can fix it in Settings), or the description itself ("Rewording it may help."). Other failures of credit-paid videos add "Nothing was charged.", since their credits are always refunded.

- af0437b: A voice session's handoff now answers in the language the user spoke: the note that carries the remaining transcript to the agent asks it to reply in the transcript's language rather than the note's English. The timeline shows the handoff notice ("Voice session ended…") and the console's "Voice handoff" and "Voice request" labels through the host's messages, so they read in the reader's language.
- Updated dependencies [e1ebd25]
- Updated dependencies [44ba53b]
- Updated dependencies [202e3fd]
- Updated dependencies [d4fd76d]
- Updated dependencies [f385091]
- Updated dependencies [7a5395e]
- Updated dependencies [aa6b340]
- Updated dependencies [12b773f]
- Updated dependencies [050ca2f]
- Updated dependencies [86c3295]
- Updated dependencies [7f627c9]
- Updated dependencies [3742a21]
- Updated dependencies [e8bc121]
- Updated dependencies [ecc876a]
- Updated dependencies [f6c6c0f]
- Updated dependencies [dfc7190]
- Updated dependencies [09972b5]
- Updated dependencies [54f07b1]
- Updated dependencies [f249828]
- Updated dependencies [a6004c8]
- Updated dependencies [cebc433]
- Updated dependencies [0ba40f0]
- Updated dependencies [449bcae]
- Updated dependencies [37538aa]
- Updated dependencies [c6ba725]
- Updated dependencies [5a3ed41]
- Updated dependencies [a02dca4]
- Updated dependencies [a1a060b]
- Updated dependencies [60c6c56]
- Updated dependencies [177de8d]
- Updated dependencies [d166d88]
- Updated dependencies [66d1e08]
- Updated dependencies [6c5a6b5]
- Updated dependencies [21856c5]
- Updated dependencies [4b0dd0b]
- Updated dependencies [3c0113c]
- Updated dependencies [71bcf11]
- Updated dependencies [942fcc1]
- Updated dependencies [fb41dfd]
- Updated dependencies [31e07a6]
- Updated dependencies [a744c56]
- Updated dependencies [a895f0b]
- Updated dependencies [b0f7062]
- Updated dependencies [670913f]
- Updated dependencies [3aaf6ed]
- Updated dependencies [0f77b2d]
- Updated dependencies [77f483f]
- Updated dependencies [a1e75dc]
- Updated dependencies [067d06b]
- Updated dependencies [5cab358]
- Updated dependencies [35387c2]
- Updated dependencies [149a15c]
  - @opengeni/contracts@6.0.0
  - @opengeni/subscriptions@6.0.0
  - @opengeni/codemode@6.0.0
  - @opengeni/config@6.0.0
  - @opengeni/observability@6.0.0
  - @opengeni/codex@6.0.0
  - @opengeni/network@6.0.0
  - @opengeni/xai-subscription@6.0.0

## 5.5.1

### Patch Changes

- 1600e2d: A managed browser, or an attached Chrome's debugger connection, is no longer stopped as idle while the agent session that created or is using it is still working (a turn queued, running, recovering, waiting for capacity or waiting on a person) or deliberately waits (`wait_for_input`). Every two minutes the API lists the browsers held this way (`listAgentHeldBrowserSessions`, migration `1002_browser_wait_hold`) and renews a short hold on each running browser's controller (`POST /v1/browser-sessions/:id/wait-hold`, `BrowserControlClient.holdForWait`): keep it at least five more minutes. A hold only ever extends, so overlapping renewals from several API processes are harmless and nothing needs to end one; once the session neither works nor waits the renewals stop, the hold lapses and the normal idle time counts from its end. The idle release keeps the browser, tabs and page state, but never longer than `BROWSER_WAIT_HOLD_MAX_MS` (60 minutes) after the browser's last use, so a long turn or repeated waits cannot keep a browser nobody uses. Renewals reach a Connected Machine or attached Chrome as the person who most recently started a turn of the holding session, through the explicit `browser.hold` operation with no request grant; a browser held only by sessions no person started is renewed only through a sandbox's cached controller endpoint. A browser held at controller shutdown is handed off and kept by the successor, and a renewal after a restart keeps a handed-off browser the new controller has not adopted yet. A sandbox box holding such a browser is not released as idle under the same rule. A renewal never launches, recovers or counts as a use of a browser and never starts a sandbox; a controller that predates it keeps its plain idle release. Browsers that only observed, and browsers no working or waiting session holds, are released as before.

  `list_agent_held_browser_sessions` ships with its runtime `EXECUTE` withheld for one release (`DEFERRED_RUNTIME_PRIVATE_ROUTINES`), because the previous release's readiness rejects a runtime grant on a SECURITY DEFINER routine it does not know. Until a later migration grants it, the API lists nothing and renews no controller holds; the sandbox box release applies the rule from this release on.

- 093b9e2: Rotating the runtime database password no longer fails operations when many connections log in at the moment a pool switches passwords. Each refused login (SQLSTATE `28P01`) is now attributed to the password that login actually used, captured when it asked for its password, instead of to the password the operation saw when it started. A refusal of a password the pool has already replaced (a stale refusal) never moves the pool. An operation is retried whenever the pool then selects another password than the refused login used (a stale refusal, or a fresh one that moved the pool on, including back to a password a rollback made valid again), under a hard cap of five attempts; a single configured password still fails fast. The five-second straggler grace is removed, so a pool switches back at once when the password it switched to is refused (for example during a rollback); `DATABASE_CREDENTIAL_STALE_FAILURE_GRACE_MS` (now 0) and the `staleFailureGraceMs`/`now` options remain only as ignored, deprecated compatibility shims. `RotatingDatabasePassword.password(login)` records the position per login, `reportAuthenticationFailure` returns whether the refusal was stale, the `candidate_refused` event gains a `stale` flag and `candidates_exhausted` a `reason` (`every_candidate_refused` or `attempt_cap`). The session-list LISTEN connection retries a newly selected password at once at most four times until it listens again or the files change.

  Credential events now reach structured logs with their pool and facts: they are logged under the reviewed public fields `databasePool`, `credentialIndex`, `credentialFromIndex`, `credentialToIndex`, `credentialCandidates`, `credentialStale`, `credentialFile`, `credentialFileErrorCode` and `reason` (previously the public log projection dropped `pool` and the index fields). Refusals are logged too; repeated refusal, switch and exhaustion lines of one pool are rate-limited (once per 10 seconds per kind, with `suppressedCount`). The exhaustion message is now "database credential retries exhausted". New Prometheus counters, labelled by `pool`: `opengeni_database_credential_refusals_total` (`index`, `refusal` = `stale`|`fresh`), `opengeni_database_credential_switches_total` (`from_index`, `to_index`), `opengeni_database_credential_exhaustions_total` (`index`, `reason`) and `opengeni_database_credential_reloads_total` (`candidates`). `observeDatabaseCredentialEvents(pool, observability)` wires both; `databaseCredentialEventAttributes` and `DATABASE_CREDENTIAL_METRICS` are exported.

- a4b57e6: In-chat connection requests now read the same to the person and to the agent, and the sign-in window ends cleanly in embedded chats. When the person in the chat can't connect the requested integration from the card (their access doesn't allow it), `capability_authorization_request` now tells the agent so, instead of the generic "posted for confirmation" message, so it no longer asks them to use a card that can't help them. Results for people who can connect are unchanged. The card and the server share one rule for this decision (`inChatCapabilitySetup` in contracts), and the server applies it to the same access the person's chat has: what their sign-in could do when they sent the turn's message, or their latest message in that chat for a turn the platform started for them, such as a wake-up, a child's result or a goal continuation (an embed token narrows it, and their own workspace counts without a membership). Without such a message it falls back to their membership (`readTurnSenderAccess` in db). The console's chat card uses the same rule, so it no longer offers Connect to a member the agent was told can't connect.

  In-chat connect cards also start sign-in with a new optional `finishInPopup: true` flag on `POST /v1/workspaces/:workspaceId/connect/attempts`. The provider's callback then lands on a small server page that closes the sign-in window (or tells the person they can close it) instead of loading a second copy of the host page in the popup. Without the flag the return URL behaves as before. Against an older server that rejects the unknown field, `ConnectController.begin` starts again without it, so sign-in keeps working and returns to the host page as before. Browser cards set it, because they sign in through a popup. Phone cards don't, because the system sign-in browser returns to the app.

  Reviewed catalog integrations no longer carry an "MCP server" label on their connection cards and dialogs, on the web and on the phone. They read as the service itself, with its name and provider. Servers someone added by hand, and registry entries nobody reviewed, keep the label (`showsMcpServerLabel` in `@opengeni/react/in-chat-connect-model`).

- d569481: `OnboardingUseCase` gains `everyday`, with `isOnboardingUseCase`. The self-service organization setup request accepts `useCase: "everyday"`, and migration 1006 lets the organization keep that answer as itself (the first answer still wins). In the web app, "How do you want to use Opengeni?" now leads with "Get help with everyday things", which creates an organization named after the person and goes straight to the model step and their first chat; the two existing choices are unchanged.
- 9e8fb2f: A message sent with personal resources (a connected machine, rig or variable set) just after the chat's access changed, for example right after it was made private, now gets a 409 that says the chat's access changed and asks to check the attached resources and send it again. It used to fail with a generic 500. The same refusals for an invalid, unauthorized or conflicting attachment now reach the client as the 422, 403 and 409 they were meant to be, instead of being reported as database persistence failures.
- 83bd1e4: Closes several trust-boundary gaps reported by Vasu Bansal (#2664). The stream relay now enforces the viewer token's mode: a watch-only token can no longer type into or close a terminal, or send desktop input, and every input or close must name the viewer's own stream. Dropped messages are counted in `opengeni_relay_unauthorized_drops_total`. A connection replaced by a reconnect can no longer act on its successor. Terminal tokens for viewers with terminal access carry input authority, independent of desktop control. Approving a tool call that needs a person's approval now requires a person: an organization API key acting as itself gets 403 and must approve on behalf of a verified external actor (`x-opengeni-external-actor`), after the host shows its own approval UI. Managed sign-in no longer fails when the API host's clock runs ahead of the database, and the device-enrollment rate limiter no longer grows without bound.
- fbcc3cd: Modal commands now use only the byte-offset task-router locator. The batch-index `modal-control-v1` reader, its `ModalLegacyProviderCommand` schema and the append-then-acknowledge output path that only it used are removed.
- b56bf3f: Internal cleanup with no behaviour change. `@opengeni/contracts/values` holds the shared `isRecord`, `errorMessage` and `sha256Hex` helpers that packages had each copied, the database package walks nested driver errors with one shared generator, and the SDK's three workspace streams share one reconnecting stream loop.
- 031e173: The person's current answer to "How do you want to use Opengeni?" is kept on the server per organization (migration 1007). `GET /v1/organization-memberships` returns it as an optional `signupUseCase`, and the new `PUT /v1/auth/organization-onboarding/use-case` changes it for an organization the person belongs to. In the web app, going Back and choosing again updates it, and the new-chat suggestions follow the account to any browser; the first answer is still recorded as before.
- d450fe5: A published Site in a personal workspace now accepts follow-up messages from guests and signed-in visitors outside the workspace. Prompt admission refused every human-less prompt in a personal workspace with `PERSONAL_SESSION_OWNER_REQUIRED`, while the turn itself already starts there in the Workspace destination with learning off (migration 0868), so a visitor's first turn worked and every later message failed. Admission now treats only private and user-memory sessions as personal memory, matching the turn's own guard.
- Updated dependencies [fa7516a]
- Updated dependencies [23fb6ef]
- Updated dependencies [f23588a]
- Updated dependencies [1600e2d]
- Updated dependencies [e555018]
- Updated dependencies [22b129b]
- Updated dependencies [093b9e2]
- Updated dependencies [a4b57e6]
- Updated dependencies [b2e3119]
- Updated dependencies [c09ae08]
- Updated dependencies [729329e]
- Updated dependencies [e473f84]
- Updated dependencies [4a86d4d]
- Updated dependencies [220c431]
- Updated dependencies [d569481]
- Updated dependencies [8382bdb]
- Updated dependencies [fbcc3cd]
- Updated dependencies [18c7cfa]
- Updated dependencies [b1673ab]
- Updated dependencies [b56bf3f]
- Updated dependencies [031e173]
- Updated dependencies [81502bb]
- Updated dependencies [f980186]
- Updated dependencies [9c8a5d5]
  - @opengeni/codemode@5.5.0
  - @opengeni/contracts@5.5.0
  - @opengeni/observability@5.5.0
  - @opengeni/config@5.5.0
  - @opengeni/codex@5.5.0
  - @opengeni/network@5.5.0
  - @opengeni/subscriptions@5.5.0
  - @opengeni/xai-subscription@5.5.0

## 5.4.2

### Minor Changes

- 5aa883b: Automations have a new overlap choice, `overlapPolicy: "steer"`, and it is the default for new automations. When an automation that continues a chat gets its next run while its own earlier run is still working there, the run reaches that turn at its next model step, the way a person's Steer does: the step's tool calls finish, and the agent then reads the new run together with the work so far instead of waiting for the whole turn. A turn anyone else started (a person, a goal continuation, another automation) still finishes first, and the run follows it; a run waiting on a person's approval keeps waiting. Runs that each start a new chat never overlap, so the choice changes nothing for them.

  Creating an automation without `overlapPolicy` now gives `steer` (previously `allow_concurrent`, or `buffer_one` for a message scheduled into a chat). Existing automations keep their stored choice. Pass `buffer_one` to keep waiting for the whole turn. The automation form offers Steer, Queue and Skip, starting on Steer; the reusable automation panel creates chat automations with the default; and the agent tools now explain every overlap choice, including that `allow_concurrent` and `buffer_one` both wait in a chat.

  A turn whose steer watch had noticed a waiting Steer that was then withdrawn (or whose automation was paused) no longer has every later model request cut short; it listens again and keeps working.

- 801743c: A connected MCP server's own icon now shows as its connector logo. When a workspace connects or enables its own (custom) MCP server, Opengeni reads the `icons` the server lists in its `initialize` reply (`serverInfo.icons`, MCP 2025-11-25), picks the best one for a single tile (theme-neutral before light or dark, vector before a large raster, favicons last), and stores it as the item's logo. Icons go through the same checks as vendored catalog logos (an image type the asset route serves, at most 512 KB, no scripts or external references in SVGs), are fetched through the deployment's outbound network policy with a timeout and at most three redirects, and are served from `/v1/catalog-assets/...`, so the browser never loads them from the server's host. A server without a usable icon keeps its monogram and connects as before. Tool steps from such a server also find the logo by the server's host. Editing a custom catalog item no longer clears its logo. New `@opengeni/capabilities` exports: `mcpServerIcons`, `rankMcpServerIcons`, `decodeDataUriIcon`, `validateLogoAsset`, `catalogAssetObjectKey` and the other logo-asset checks previously private to the catalog scripts; new `@opengeni/db` export `setWorkspaceCapabilityCatalogItemLogo`.
- 01188c9: Automations can listen to any app's webhooks. A new `custom` webhook adapter reads deliveries as the source's `format` describes: how they are signed (`standard_webhooks`, `hmac_sha256` of the body in a header, `timestamped_hmac_sha256` as Stripe and Tailscale send, or a shared `token` header), whether one delivery holds a list of events, and where each event's type, id, time, summary, subject, link and actor are (JSON paths or headers). The whole event is the event's data, so trigger conditions can filter on any field. The secret is the one the app shows or the one a person set there; the source waits, blocked, until it is pasted. `WEBHOOK_FORMAT_PRESETS` ships Tailscale's format: "Add a source" offers Tailscale by name, and its event-type catalog lists Tailscale's documented types.
- 659f5a4: Managed accounts can sign in with a passkey. Anyone signed in adds passkeys under their sign-in methods and can then sign in with one instead of a password. With `OPENGENI_MANAGED_AUTH_PASSKEY_SIGNUP_ENABLED=true`, a new person can also create an account with only a name and a passkey, with no email address or password, while new sign-ups are open and no email allowlist is set. Passkeys are offered on trusted HTTPS or `localhost` origins in the legacy session-set mode. Rolling migration 0998 adds the passkey store but withholds it from the runtime role, so passkeys stay off until a later release grants it.
- 5b9feb9: A meeting recorded with computer or tab audio now names its microphone after the person recording. Each new transcript version gives the microphone speaker the owner's person in the speaker directory, added for them if they have none, as "It's me" does, with `source: "track"` and no confidence, so it doesn't read as a voice suggestion. A name someone gave that speaker carries over through every later version instead (before, one that had already carried over once could be replaced), and a microphone alone stays diarized as Speaker 1, 2…. The naming enrolls nobody's voice: it gives no agreement, and an unconfirmed `track` speaker never teaches a voiceprint. Starting such a recording adds the owner to the directory, so the live preview shows the microphone under the owner's name to everyone watching (the person recording sees their own) and the computer or tab audio as "Others". New exports: `recordingMicrophoneIsOwner` (contracts), `ownerLiveLaneName` (react), `workspaceMemberDisplayName` and the `TrackSpeaker` type (db); `MeetingsListPage` and `RecorderPanel` take an optional `viewerName`, and `createRecording` an optional `ownerName`.
- 3cd4985: Passkeys kept in a connected password manager now work for agents. A Bitwarden or Vaultwarden login with a passkey, a Keeper login record with a passkey, or a Proton Pass login with a passkey shows `hasPasskey`, matches a `passkey` search, and signs in through the agent's managed browser like a hosted passkey. Only which items hold a passkey is mirrored (credential id, site, account name); the private key is read live from the provider when a browser needs it and is never stored. After a sign-in the signature counter is written back to Bitwarden and Keeper unless the vault is linked read-only; for Proton Pass, whose CLI cannot edit items, Opengeni keeps the count itself. Providers implement the new optional `readPasskeys` and `updatePasskeySignCount`, and `capabilities().passkeys` becomes a boolean. 1Password's SDK does not expose passkeys, so 1Password passkeys stay unusable. Items that need approval for each use are no longer loaded into a browser, hosted passkeys included.
- fd43805: The control worker now reports why durable queued turns are not running. `opengeni_turns_queued_by_hold{hold}` splits the existing `opengeni_turns_queued` total into `ready` (waiting for dispatch), `behind_active_turn`, `paused` (own, ancestor or workspace Pause), `failed` (resumes on the next message), `requires_action`, `waiting_capacity` and `cancelled`, and `opengeni_turns_queued_oldest_age_seconds{hold}` gives the oldest queued age in each class. Only `ready` prompts wait for a worker, so an old `ready` prompt is a stranded queue. Migration 0988 adds the content-free `opengeni_private.summarize_queued_turns_by_hold()` function and `@opengeni/db` exports `summarizeQueuedTurnsByHold` and `QUEUED_TURN_HOLDS`. The runtime grant is deferred for one release, so these series appear only after a later migration grants it; until then the worker publishes only the total. Prompts from a non-owner on a personal-machine chat that wait for the machine owner are not yet a separate class and count as `ready`.
- e4eaded: The runtime database password can now be rotated without restarting pods or failing requests and turns. New optional settings `OPENGENI_DATABASE_PASSWORD_FILE` and `OPENGENI_DATABASE_PREVIOUS_PASSWORD_FILE` name files with the runtime login's current and previous password. Every pool that logs in as the runtime role (the API and worker pools, the session-list LISTEN connection, the managed-auth pool and the runtime CLIs) re-reads them on each new connection, starts on the previous password and switches to the current one after a single refused login (SQLSTATE `28P01`). A pool query or transaction start refused with `28P01` is retried on the newly selected password, only while another distinct password exists and at most once per password. With a single password a refused login still fails fast, and unset or missing files keep today's behavior: the password in `OPENGENI_DATABASE_URL`. `createDb` accepts the same files as `passwordFiles` (with `databasePasswordFileOptions(settings)`) and reports content-free `onCredentialEvent` events; embedders that do not pass them are unaffected. The Helm chart's new `runtimeDatabasePasswordFiles.enabled` mounts the optional runtime Secret keys `OPENGENI_DATABASE_PASSWORD` and `OPENGENI_DATABASE_PREVIOUS_PASSWORD` as files into the api, worker-control and worker-turns pods. See docs/deployment.md, "Rotating the runtime database password".
- 936d9e0: Add optional Turnstile signup verification, reversible promotional-credit holds, and signature-backed repeated free-credit claim detection. Keep purchased credit and incurred usage settlement intact, with tenant-safe balance projections and owner-only audited review controls. All enforcement defaults off and requires explicit deployment configuration after every funding reader is upgraded.

### Patch Changes

- d649005: An open chat's artifact list no longer reads the catalog once per sub-session. `GET /v1/workspaces/:workspaceId/artifact-catalog` takes `includeSubSessions=true` with `sourceSessionId`. The server then lists that chat and the sub-sessions its lineage lists (depth 5, 200 at most) in one keyset-paged query. It authorizes those sessions in one batch and skips any the caller may not read, and each item keeps its own `sourceSessionId`. The session dock now makes two paged reads per refresh (active, then archived) however many sub-agents the chat started, with no lineage read or per-sub-session cache. It keeps at most one refresh in flight and runs one more afterwards if new tool output arrived meanwhile. Before, a chat with about 50 running sub-agents re-read up to about 100 catalog pages on every turn end and overlapped those reads on a busy chat. Rolling migration 0991 lets the published-file listing routine accept a bounded `sourceSessionIds` list. The previous release's single `sourceSessionId` keeps its meaning.
- 8a13aa9: Keep historical identity maintenance frontier reads ordered by native UUID so they use the primary-key index rather than sorting cast text, and apply configured job timeouts to startup inspection.
- 2408444: Stopping a browser recording no longer fails when object storage shows the freshly made video or action log a few seconds late, as storage that replicates in the background can. The save reads both back with the usual short visibility retry, keeps answering 202 so the client asks again for up to a minute after the video was made, and only then fails with a 503 `upstream_unavailable` whose message says the video was made but could not be read back, nothing was saved, and stopping again before the browser session ends saves it, with `details.code` `browser_recording_output_unreadable`. The minute is measured on the database's clock (`getBrowserRecordingVideo` now returns `readyForMilliseconds`) plus the API's monotonic clock for its own retries, so clock skew between them does not matter. Before, a single missed read answered a 503 with the generic "temporarily unavailable" text and ended the save.
- 4024f23: After history is compacted, a request the agent already answered keeps a short copy of that answer, so the agent no longer mistakes it for a pending request and answers it again. Answers are matched by the turn that wrote them, so a request in the turn still running stays open, and repeated compactions keep each request with its own answer.
- 0b76a0a: A background command on a Connected Machine no longer stays "running" forever after the machine was offline. When the reconciler could not reach the machine, it left the command to the machine's own reports, but the machine reports only operations it knows, so a command whose start never reached it was never settled. Now the machine's next inventory report makes those commands due again; the reconciler asks the machine, and one it does not know settles lost (never as a success), while one it runs continues as before. Migration 0984 adds the private function behind this, with its runtime grant withheld for one release so the previous release stays ready, and makes commands already stuck this way due once. Until a later migration grants it, a report skips the re-arm. Compute sandboxes are unaffected: their running commands are still never polled.
- 7ba1be6: A Browser, Computer, Terminal or Files request that arrives while a chat's sandbox is still starting now waits for that start, as a turn does, instead of failing with "sandbox lease is not attachable". A fresh chat's first Browser or Computer open no longer needs a retry. The API and the worker share one wait for a starting sandbox.
- 995c16f: App actions in a chat driven by someone who uses Opengeni through another product (an external user, such as a person in an embedded chat) now work. Every call used to fail with 403 `invalid delegated human authorization`, because the person proof accepted only native accounts. These calls now run as that person in the chat's workspace only, with their live access there capped by the access frozen with their message, and no organization-level authority, so reads such as `getMyUsage` answer at once. Action search offers such a person only actions that can succeed for them: that workspace's actions, only reads unless their message allows changes, nothing that carries a secret, and only actions whose first access check their access passes (each catalog entry now records that permission as `permission` when its handler shows one). With full access, such a person can do everything they can in that one workspace, and every path (search, a call, a session tool reaching another workspace) gives the same answer. A call outside that workspace is refused before anything runs, with a plain message that names the one workspace they can use. Refusals and 403 hints for them no longer point to Opengeni app pages. The exact-workspace person proof used by published Sites is now also exported as `stampWorkspacePersonAuthorization`, and it also covers an external person's own workspace, as their active organization membership names it (`externalPersonPersonalWorkspaceId`).
- f721495: Long screenshot-heavy sessions no longer die with `active_history_too_large`. Automatic compaction now also runs when the stored active history reaches 60% of its materialization guard, or when a request reaches 60% of the provider's per-request image limit. A session that is already over the guard compacts from a bounded view, built in PostgreSQL with the oldest inline images left out, and continues. The remaining error, for an item too large even for that view, now says to clear the context or start a new session. New exports: `readActiveSessionHistory`, footprint and pressure helpers, `providerRequestImageLimit` and `countModelInputImages`.
- 96502c5: A message someone else sends to a chat that runs on another member's personal machine no longer blocks the chat. It waits for the machine's owner instead: it never starts or interrupts the owner's turns, the owner's next message brings it to the agent as context, and it runs on its own once the chat moves to a machine the sender may use. Steering a waiting message, and an agent steering such a chat on behalf of somebody else, are refused with a clear reason. Send results report `waitsForMachineOwner`, and the chat's machine explanation lists whose messages wait (`waitingMessages`). This takes effect once a later release grants the runtime the new machine-owner lookup; until then chats behave as before.
- 51915c3: Organization Codex accounts show their usage again on the Models page and the account page. Since API request tracing wraps the global `fetch`, every organization Codex live usage check refused to run, and each account row said "Usage unavailable" even though the account had a saved reading. Usage reads now accept the native `fetch` behind request tracing (`tracedFetchTarget` in `@opengeni/observability` unwraps it), and they still refuse a custom transport that cannot be awaited after an abort. When a live check does fail, the list row now shows the last saved reading, as the account page does, and says "Usage unavailable" only for an account that has never been read.
- 5f332c1: Fewer prompt-cache misses. Claude portable checkpoints and Codex remote compaction now send the exact ordinary request withheld at the compaction boundary, so they extend the cached request instead of re-projecting history that diverged at the first tool disclosure. Workspace governance moves from the system prompt to a durable history item written before the turn that first sees a new value, and Codex cache affinity is keyed by the session scope subject, so recovery attempts, steers and turns by other people no longer rewrite the start of every request. Each model call fact now records a request fingerprint, Claude's dropped-thinking counts and a warm-miss class in `prompt_cache_diagnostics`, with matching worker metrics.
- bd71666: Count concurrent fills of the same verified tool catalog once in the cache's byte budget, avoiding unnecessary eviction and repeated hydration. Every read still checks the durable row under its existing access scope.
- ba4c9dc: Document and provide an explicit resumable operator job to populate historical tool-event identity projections online without rewriting payloads or stopping services.
- 50989e2: Avoid unused presentation reads during message admission while retaining fresh session model policy, scoped visibility, and cursor/control validation.
- 4651b0d: A Site's sidebar row now moves only when the Site gets a new published version (creation is the first). Messages and turns in its conversations, including a side chat used to edit it, and activity in the chat that created or published it no longer lift it; a publish from any of them still does. Opening a Site, archiving, restoring and the version chip's Undo (a rollback, which adds no version) don't move it either. Opened Sites and Sites with conversations keep their rows in their own project, and session rows are unchanged. `SiteConversationGroup.updatedAt` is now the Site's newest publish. When there are more than 200 Site rows, the limit keeps pinned rows first and then Sites with recent publishes or conversation activity, so a Site whose conversation needs you stays in the sidebar.
- f5b8289: An image provider that is out of credit, rate limited, refusing or down no longer fails the turn as if the chat model were out of credits. `generate_image` returns its own short error and the turn continues, so the agent can tell the person and offer something else. Nothing is charged and held credits are released at once. Operators get the `opengeni_image_generation_provider_failures_total` metric and an `image generation provider failed` warning with the provider's detail; the agent and the person never see provider account text or billing links. Any other tool error that carries a provider 402 or 429 now stops the turn as `tool_provider_refused` instead of `provider_quota_exhausted` or a chat-model rate limit.
- Updated dependencies [931325b]
- Updated dependencies [23e7e1e]
- Updated dependencies [d649005]
- Updated dependencies [5aa883b]
- Updated dependencies [f884a9b]
- Updated dependencies [a57cfa8]
- Updated dependencies [9db3491]
- Updated dependencies [4488c59]
- Updated dependencies [5a48fe7]
- Updated dependencies [3ee89da]
- Updated dependencies [f6298be]
- Updated dependencies [58d272f]
- Updated dependencies [01188c9]
- Updated dependencies [995c16f]
- Updated dependencies [53e1fe5]
- Updated dependencies [d30a243]
- Updated dependencies [659f5a4]
- Updated dependencies [5b9feb9]
- Updated dependencies [de7087a]
- Updated dependencies [cb15454]
- Updated dependencies [a8b429e]
- Updated dependencies [57cfc37]
- Updated dependencies [f20b8fb]
- Updated dependencies [96502c5]
- Updated dependencies [51915c3]
- Updated dependencies [5f332c1]
- Updated dependencies [e4eaded]
- Updated dependencies [24b71c6]
- Updated dependencies [54c2f9e]
- Updated dependencies [936d9e0]
- Updated dependencies [4651b0d]
- Updated dependencies [7a02989]
- Updated dependencies [30b9cd2]
  - @opengeni/contracts@5.4.0
  - @opengeni/config@5.4.0
  - @opengeni/network@5.4.0
  - @opengeni/codemode@5.4.0
  - @opengeni/observability@5.4.0
  - @opengeni/codex@5.4.0
  - @opengeni/xai-subscription@5.4.0
  - @opengeni/subscriptions@5.4.0

## 5.3.1

### Minor Changes

- 1988e97: A person can now have the agent do in the chat what they would otherwise do in settings: switch this chat's model, invite someone or share the chat, check their plan, credits and usage, or change a workspace preference. In a chat a person started, `admin_actions_search`, `admin_action_describe` and `admin_action_call` are listed by default and run as the person who sent the message, never with more than that message itself could do: what it may do is frozen with its turn when it is accepted, capped to the chat's workspace. Reads run at once; every change first shows that person a plain confirmation card in the chat ("Invite anna@example.com to your organization as an admin?", one line of the key values, Allow and Cancel, the raw call behind Details), and the API refuses a change that person did not confirm. Only someone signed in to the app itself can confirm changes; with any delegated sign-in (an embed's host-issued token, an external user, another integration's person token) the route only reads unless the deployment sets `OPENGENI_DELEGATED_SIGN_IN_APP_ACTION_CHANGES=true`, which applies to all of them. An Allow given through an API key, a Slack button or a delegated sign-in that isn't turned on never confirms: approvals now record who decided (`decision_by_kind`) and whether they were signed in to the app (`decision_by_signed_in_person`), both fixed with the decision. Calls that create, show, copy or rotate keys, passwords, tokens or other secrets, or carry one in their body, are left to the app unless the session has full access. Contract schemas mark secret fields with the new `secretValue(...)` helper (registry `secretValues`); the catalog generator records them, plus secret-sounding field names, as `secretFields` on catalog entries. Codex and SuperGrok device sign-in starts now have a response schema (`SubscriptionDeviceSignInStart`). A session with full access behaves as before. Scheduled, goal and other unattended turns, API-key and service turns, child sessions and service sessions gain nothing.

  This is on by default for every organization, including existing ones: migration `0971` adds `chatActionsAllowed` (default true) to the agent admin-access setting. Owners and admins turn it off under Security & data > Agents, or with `PATCH /v1/organizations/:organizationId/agent-admin-access` (which now accepts either field). Embedding hosts that draw approvals with `ApprovalSurface` get the same card, with `approvalSurface.allow` and `approvalSurface.cancel` messages to translate; a host can leave the route off by not selecting these tools. The app-action catalog moved to `@opengeni/contracts/app-actions`. `SESSION_ADMIN_ACCESS_TOOL_NAMES` and `SESSION_ADMIN_ACCESS_TOOL_NAME_SET` are deprecated aliases of `SESSION_APP_ACTION_TOOL_NAMES` and `SESSION_APP_ACTION_TOOL_NAME_SET`. `toolReviewFields` takes an optional tool name.

- e3782bb: Automation templates and a "This workspace" event source.

  - **Templates.** A template is where a new automation starts: its message, a schedule without a time zone, and event triggers that name a kind of source. Using one opens the ordinary form filled in; nothing is created until the person saves. `@opengeni/react/automations` ships built-in templates (`builtinAutomationTemplates(t)`, including "Meeting notes"), and `AutomationsPanel` takes `templates` (the host's own), `workspaceTemplates` (offer and save the workspace's saved templates, on by default) and `workspaceEvents` (offer this workspace's own events as a source, off by default). The new-automation view offers "Start from scratch", the host's templates and the saved ones; an automation's menu has "Save as template". `useEventSourceStandIns`, `AutomationTemplateList`, `AutomationTemplateTile` and `AutomationTemplateDialog` are exported for hosts that build their own.
  - **Saved templates.** Workspaces keep the templates their people save: `GET`/`POST /v1/workspaces/:workspaceId/automation-templates` and `PATCH`/`DELETE …/:templateId`, with `listAutomationTemplates`, `createAutomationTemplate`, `updateAutomationTemplate` and `deleteAutomationTemplate` in the SDK. Reading needs `scheduled_tasks:run`, saving needs `scheduled_tasks:manage`; whoever saved a template and workspace admins can rename or delete it (`viewerAccess`). A workspace keeps up to 200; saving more returns 409.
  - **"This workspace" source.** `createEventSource({ kind: "workspace" })` creates the caller's own source for the workspace's recording events (`recording.started`, `recording.finished`, `recording.transcript.ready` and the rest). It reads under the owner's row security, so a trigger only sees the meetings its owner may open.

- 31bca3c: Composer dictation is now a recording with `purpose: "dictation"`, recorded, uploaded and kept by the same local-first pipeline as meetings, so a closed tab, a killed phone app, a dropped connection or a failed transcription never loses what was said. A dictation has one microphone track, is always private, is transcribed and billed as voice input, sends no webhook events, never appears with meetings, and is deleted a day after it is heard. `GET …/recordings?purpose=dictation` (and `listRecordings({ purpose })`) lists the caller's own kept dictations, so the next composer offers text an earlier page left behind.

  `useVoiceInput` records through the recordings API when the client can and the deployment advertises `voiceInput.resumable`, inserts the text once (taking it deletes the dictation first, so two tabs never insert it twice), keeps anything longer than three seconds on Cancel or Escape, and hears a failed dictation again on Retry. It is also exported from `@opengeni/react/recordings`, and `useNativeDictation` in `@opengeni/react-native/recordings` brings the same dictation to phones on the native recorder. A client with only `transcribeAudio` records in memory and sends one request, as before. `ComposerTranscriptionControl` accepts `recordings` and `platform`; `createRecordingStore` and `createOwnerId` are deprecated and ignored.

  The `transcription-recordings` routes and their SDK methods are deprecated, answer with `Deprecation` and `Sunset` headers, and are kept until January 26, 2027. See https://docs.opengeni.ai/integrate/meetings#moving-from-transcription-recordings.

- 6acfbd3: Event sources and triggers now say why they are blocked or off as a code clients can word in their own language. `EventSource` and `EventTrigger` gain `statusReasonCode` and `statusReasonDetail`, and `EventTypeDescriptor` gains `unavailableReasonCode` and `unavailableReasonDetail`, next to the existing English sentence (codes are listed in `EVENT_STATUS_REASON_CODES`). `@opengeni/react/automations` adds `eventStatusReasonText`, which words a known code from the host's message catalog (`automations.statusReason.*`) and shows the server's sentence for a code it doesn't know; source and trigger badges, the event source picker and the event type picker use it.
- 21e7ecf: Feedback can now carry where it came from and what the person saw. `createFeedback` accepts an optional `context` (source, how it was opened, app version and build, OS, device model, the screen in view, locale, time zone and up to ten recent errors) and up to three JPEG or PNG `screenshots` of at most 3 MiB each. Screenshots are stored in object storage under create-only, content-addressed keys, so an identical retry stores nothing new, and returned feedback lists each one's index, type, size and SHA-256. The author can read an image with `GET /v1/workspaces/:workspaceId/feedback/:feedbackId/screenshots/:index`. In the phone app, shaking the phone opens Send feedback with a screenshot of the current screen (removable before sending); reports wait on the phone and retry until the server accepts them, and Settings has a Send feedback row and a Shake to send feedback toggle.
- cc319f3: Meetings get notes. Each recording now has a `notepad` (what people jot down while it is recorded) and `notes` (the written-up summary, decisions and action items, by a person or an agent afterwards), both Markdown. `GET /v1/workspaces/:workspaceId/recordings/:recordingId/notes` reads them and `PUT …/notes/:kind` replaces one, with an optional `expectedRevision` that turns a lost update into a 409 `notes_changed`. Anyone who can see the meeting can read and save them, and they are deleted with it. Saving the notes sends the new `recording.notes.updated` webhook event, which carries the revision and the chat whose agent saved them but never the text. The SDK adds `listRecordingNotes` and `saveRecordingNote`.
- a9809ee: A blocked "ask before each use" secret use now reaches the person through Opengeni itself instead of depending on the agent to relay a card. The resolver posts Opengeni's own approval card as a human-input request with the new `origin: "secret_use_approval"`, so it appears in the chat, the inbox, a phone notification (without an inline answer) and the Slack thread; an identical blocked use while the request is pending reuses it and never notifies again. The card outlives the turn that hit it. When the signed-in person answers, the grant or denial is recorded and the agent receives the new immediate `secret_use_approval_decided` update telling it to retry the call, or not to, which wakes an idle chat. `SessionHumanInputRequest` gains optional `origin`, `SessionSystemUpdateKind` gains `secret_use_approval_decided`, and `SecretReferenceError` carries `approval: { approvalId, asked }` instead of `approvalCard`; the `approval_required` tool output no longer includes a card and its hint says the person was asked. `request_human_input` refuses `secret-approval:` questions, and agent-relayed approval questions no longer carry authority. Migration 0961 (rolling) adds the request `origin` column and the new update kind, and keeps pending approval cards open in the inbox when a turn ends.
- f3d19a2: Vault items, or single fields of them, can be marked "ask me each time". Agents still see and reference a marked item, but a use that no approval covers stops before any value is read and fails with the new `approval_required` code, and Opengeni asks the person with its own card describing the blocked use (item and field, surface, tool and destination). Only the person the run acts for can answer it, and the answer becomes a grant: allow once, allow in this chat, allow for an hour across the person's chats in the workspace, or deny. The check runs in the shared resolver, so hosted and connected vaults and every surface behave the same. New routes `GET`/`PUT /v1/workspaces/:workspaceId/vaults/:vaultId/items/:itemId/approval` and `POST …/approval/grants/:grantId/revoke` (people only for changes), SDK methods `getItemApproval`, `setItemApproval` and `revokeItemGrant`, an "Ask before each use" section on the item page, and migration 0952 (rolling) adding the `secret_approval_rules` and `secret_use_approvals` tables. `SecretUseContext` gains optional `destination` and `lookupDestination`, and secret-use audit rows list the approvals a use relied on.
- e509f04: Show Pin and Archive on every sidebar row, including spawned chats and Site rows, on hover or keyboard focus with tooltips, and in the right-click and touch menus. Site rows can be pinned and archived as personal sidebar state (`updateSiteSidebarState`); archiving a Site only hides it from your own sidebar and never unpublishes it. Archive on a spawned chat archives its workstream.

  Session lists for a signed-in person that include or group Site conversations (`siteConversations: "include"` or `"group"`) now leave out conversations of Sites that person archived; a Site's own conversation list is unchanged.

- 119f33d: Add independently gated Microsoft Teams agent tools and linked Teams conversations, with durable admission and delivery, private-message authority checks, and workspace setup APIs. Both integrations remain disabled by default.

### Patch Changes

- de7e142: A Connected Machine whose agent process serves several workspaces no longer shows a failed agent update in the workspaces that did not start it. While one workspace's update runs, the others record a postponement (`update_busy_updating`, retried on the busy backoff and shown as waiting) instead of a failure, and once the restarted agent proves through its update receipt that it runs exactly the target build, every workspace's pending, postponed or failed update for that build is marked succeeded.
- e0b3ccf: API request traces can now be followed across service boundaries and show where a request spends its time. A request's W3C `traceparent` header is no longer ignored: by default the request span keeps its own trace and links to the caller's span, and a deployment whose callers are all trusted can set `OPENGENI_OBSERVABILITY_TRUST_INCOMING_TRACE_CONTEXT=true` to make the request span a child in the caller's trace. Request spans are now SERVER spans with child spans for each database statement and transaction, each outbound HTTP call, and each object storage and workflow client call, within a budget of 256 per request. Span attributes carry only the statement's operation and table or routine name, row counts, SQLSTATE codes, HTTP methods and statuses: never SQL text, parameters, URLs or messages. Telemetry export no longer runs inside the trace it exports. New observability exports: `startChildSpan`, `childSpanRecordingActive`, `withoutTraceContext`, `traceFetch` and `traceClientCalls`, plus `kind` and `childSpanLimit` options on `startSpan`.
- 0676499: Archiving a chat with Pause now removes the one-time waits that continue it or its sub-chats: a run-once event automation that has not run yet, and a one-time scheduled run still ahead. They go in the same transaction as the pause, so an archived chat is never woken by a "wake me when" it was waiting on, and Restore does not bring them back. Repeating automations stay, and Hide for me changes nothing. The archive confirmation says so.
- e7f5d38: A new chat that starts with a file attached now reuses the cached prompt of a chat without one. Before, a turn with a file added an "Attached files" section to the system instructions and the sandbox's mount policy and filesystem layout listed the file, so the whole request missed the provider's prompt cache. The instructions no longer depend on the turn's files; that guidance now ends the turn's attachment notice, after history. Uploads completed without a client sha256 now get one computed from the stored bytes (files up to 20 MiB), so an image uploaded through the plain REST flow reaches the model inline like an SDK upload instead of only as a mounted file.
- e1838ff: A chat's "waiting on" status names every app its automations wait on, not only the first. `SessionAutomationWaitSummary` gains `events`: one entry per source with all the event types its active triggers wait for, in the order the automations were made. The header chip reads "Waiting on GitHub and Gmail" (two names, then "and 2 more"), and its tooltip, the sidebar mark and the hover card list each source's events. With servers that only send `event`, the words are as before.
- 4c6bf32: An organization's Azure OpenAI connection can now sign in with Microsoft Entra ID instead of an API key, so Azure resources that turn key authentication off can run agent turns. Admins choose the sign-in method when connecting: an API key (unchanged), the organization's own Entra app registration with a client secret, or, when the operator sets `OPENGENI_AZURE_OPENAI_DEPLOYMENT_IDENTITY_ENABLED=true` and configures the standard `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_FEDERATED_TOKEN_FILE` or `AZURE_CLIENT_SECRET` variables, the deployment's own workload identity. Tokens for the `https://cognitiveservices.azure.com/.default` scope are cached per credential and renewed before they expire. The upsert request accepts `authentication` in place of `apiKey`, connection responses report `authMethod`, and the client config reports `azureOpenAIDeploymentIdentity`. `@opengeni/network/azure-entra` exports the shared token source.
- 2dc5e41: An agent's browser recording is now a recording, so it is stored, owned, shared and deleted like any other. Saving one makes a recording whose purpose is `browser`, with one video track from the browser tab whose chunk is the frame bundle the browser host uploads. The worker encodes the MP4 and its action log in the background instead of the API encoding it inside the save request, then the save copies both into the chat's files and publishes the video as before. While the video is being made, the save answers 202 with `state: "encoding"`, and the SDK keeps repeating it as it does while uploading. The recording follows the chat: a private chat's recording is its owner's and private; a shared chat's belongs to the person the agent acts for. Meeting lists show meetings only, and browser recordings have no transcripts. A recording's tracks now say their `kind` (`audio` or `video`) and, for a video, its size and frame count; a recording says its `purpose` and, if its video failed, an `errorCode`. Migration 0945 adds the columns.
- 6f6c356: A chat that an automation will post into now says what it is waiting for. Sessions and session list entries carry `automationWait` (`nextRunAt`, the `event` with its `source` and `eventTypes`, and how many `automations` wait), and the lineage read carries `sessionAutomationWait`, for readers who may see schedules. Only automations the reader can see count, and a source that is private to someone else stays unnamed. `sessionAutomationWaitWords(t, session, { now })` from `@opengeni/react/automations` turns it into a sentence ("Waiting for deploy.finished from Deploys. Next run: Tomorrow, 09:00") and a chip label ("Waiting on Deploys"), and falls back to the plain "Waiting for an event" or "On a schedule" for servers without the details. The sidebar mark, hover card, command menu and chat header use it.
- 226bb1d: A turn whose history holds retained screenshots starts faster: the session's screenshot rows load in one query and the images are read from storage concurrently, each once, so one slow read no longer holds up every image after it. `getSessionRetainedScreenshotArtifacts` returns a session's own retained screenshots for a set of ids.
- 3fa5c6e: Show connected-vault usernames in secret search and vault summaries using an
  optional, bounded provider display hint. Encrypt the hint separately from
  provider-resolved fields without fetching additional secret values. Existing
  mirrors receive the hint on their next item sync; force a refresh to populate
  unchanged inventories immediately.
- d6c7c4a: The agent now continues on its own after a person finishes setting up a capability from the agent's connect or add-credentials card, instead of waiting for them to say they are done. After setup is verified, the shared chat cards (and the OAuth return handlers) call the new `POST /v1/workspaces/:workspaceId/sessions/:sessionId/capability-continuations` endpoint (`client.continueAfterCapabilitySetup`). The API records one immediate `capability_setup_completed` internal update per card, and only when the capability is now usable in that chat, nobody has written since the card, and the caller is the person whose request it was. The agent sees one short internal update saying the setup is finished and its tools are available. Failed or cancelled setup sends nothing.

  `SessionConversation` and `OpenGeniChat` now render the shared connect card for the agent's OAuth capability requests with no host code, when the person's grant allows every setup step; otherwise the card says the integration can't be connected from here instead of showing a dead end. The session proxy reports a new `chatConnections` client-config field (`false` when its `createSession` hook owns chat tools), and `timelineProps.renderAuthNeeded` still takes precedence.

- bbc8f6d: Turns funded by Opengeni credits can now generate and edit images. When no turn-native, subscription or workspace Gateway route applies, the agent gets `generate_image` through the deployment's Vercel AI Gateway key and `imageGenerationModel`, priced per image (`OPENGENI_IMAGE_GENERATION_CREDIT_MICROS_PER_IMAGE`, or the built-in price for `openai/gpt-image-2`). It is on by default once the key and a price exist; `OPENGENI_IMAGE_GENERATION_OPENGENI_CREDITS_ENABLED=false` turns it off, and workspaces with Opengeni credits turned off are not offered it.

  Before any provider request, each image must fit the workspace and member allowance and the spendable balance, which includes plan and trial grants covering the turn's chat model, minus images of the workspace still in flight. A refusal is returned to the agent as a plain rejected result instead of failing the turn. The image is debited once, in the same transaction that makes it ready. Migrations 0968 to 0970 (rolling) add the price, credit state and usage model to `image_generation_operations`, plus an index for in-flight images. The workspace Gateway image route now finds the workspace key by provider id.

- f6f3ed1: Keep a rolling release safe for the previous binary: migration 0937 withholds the runtime role's EXECUTE on the new event trigger, recording recovery, MCP Events and event source feed `SECURITY DEFINER` routines, and its DML on `event_ingress_routes`, until a later release grants them. Readiness knows all five routines with their own checks and accepts the grants withheld or made. Stalled-recording recovery and event intake retention skip their pass while EXECUTE is withheld: until then, a recording stuck in transcription or deletion is not restarted, and a stuck deletion keeps its audio longer.
- 41bff65: Event source routing keeps no provider identity. The route table has no tenant RLS, so a GitHub route is now keyed by an HMAC of the installation under a secret derived from the deployment's encryption key, and Slack and Gmail sources need no route at all: Slack callbacks already arrive resolved to their workspace and Gmail is read, not delivered. Migration 0941 removes the old plain routes; adding a GitHub source again recomputes its routes. The GitHub binding writers take the route secret as `eventRouteSecret` (`eventRouteSecret(settings)` from `@opengeni/core`). A deployment without `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` can't add a GitHub source.
- 627b2f1: Google Calendar can now be connected from the chat or the Capabilities page, like Gmail: each person connects their own calendar with the deployment's existing Google sign-in app, and the agent can list events in a time range, read one event, check free/busy times, and create, move or delete events. Changes ask first by default, guests are emailed only when asked, and every answer uses the calendar's own time zone. Operators enable it with `OPENGENI_GOOGLE_CALENDAR_ENABLED=true` after enabling the Google Calendar API and adding the `calendar.calendarlist.readonly`, `calendar.events` and `calendar.freebusy` scopes to their Google consent screen.
- 0854838: Migration 0947 grants the runtime role EXECUTE on the event trigger, recording recovery, MCP Events and event source feed `SECURITY DEFINER` routines, and DML on `event_ingress_routes`, which 0937 withheld for one release. Readiness and provisioning now require them, so stalled-recording recovery and event intake retention run again instead of being denied. The recording retention inventory from 0946 stays withheld until its own follow-up release.
- 2c34440: Migration 0950 grants the runtime role EXECUTE on the recording retention inventory that 0946 withheld for one release. Readiness and provisioning now require it, so workspaces' recording retention periods are applied instead of the sweep skipping its pass.
- 826b002: Agents can find and read recorded meetings with two new first-party tools. `meetings_search` finds the meetings the person can see by words said or in the title, a named speaker, a start-time range or a product's reference, newest first, with each meeting's speakers and the transcript lines that matched. `meeting_read` reads one meeting's details and its transcript as speaker-named, timestamped lines with names and corrections applied, in parts or for a stretch such as 12:00 to 15:00, and reads the live preview while a meeting is still being recorded. Both are searchable (deferred) tools in the knowledge group and need `sessions:read`. The recordings list in the API and SDK also gains `person`, `startedFrom` and `startedTo` filters.
- baf128f: Searching meetings (`query` on the recordings list) now finds transcript words while they're still being typed: every word of the query matches as the start of a word, in any order, so "onboard" finds "onboarding". A corrected segment is found by its corrected words and no longer by the ones it replaced. Titles still match any part of the title.
- 1ac6e9d: Pipeline independent event-fence reads in their existing transaction order, reducing sequential network waits while retaining separate SQL statements and cursor validation barriers.
- d6c7c4a: New `connections:personal` permission: connect your own accounts and use them in your own chats without administering the workspace. It allows creating, listing and removing only the caller's own (personal) connections, signing in to one's own account through Connect, and turning a reviewed catalog OAuth integration on for personal accounts when it is not on yet (create-only, subject-scoped, no credentials or config, within the organization integration policy). It never covers custom MCP servers, shared or workspace connections, other people's connections, or disabling or reconfiguring integrations. `connections:write` includes it, so existing roles, keys and organization key policies keep their meaning, and workspace Members can now turn such an integration on for their own accounts. Once on, the integration is visible to the workspace's other members as optional; each must connect their own account.

  Organizations can reserve this for admins with the new `personalIntegrationSetup` integration policy setting (`members` by default, `admins`), also in Organization settings → Integrations (migration 0974).

  Embeds: per-user workspaces now get `connections:personal` by default, and the new `identities` option (`"per_user"` or `"shared"`) on the `Opengeni` facade and `createWorkspaceIdResolver` decides it for tenant workspaces: `per_user` adds signed-in tenant users with it, `shared` keeps it off everywhere. `memberPermissions` still overrides both. The shared connect card and the stock conversation's in-chat connect decision use the new `personalIntegrationSetupAccess` helper from `@opengeni/contracts/personal-integration-setup`, offering only a personal connection when that is all the person may do.

- fa00bb2: Migration 0948 lets a turn that an agent moved to another of its owner's personal machines continue in a replacement attempt. The new attempt re-proves the same turn's earlier machine authorization against the current owner, machine and grant, instead of failing admission on a missing snapshot row. A machine the turn was never authorized for, or whose grant was revoked, now refuses with the typed grant-required cause instead of an unmapped database error.
- a42a3b5: Meeting transcripts and live previews now count toward usage allowances that opt into `unbilledUsage: "list_price"`, like model calls that spend no credits. Each completed transcript version counts its recorded provider cost once against the workspace and the person who asked for it, and a live preview counts its cost against the recording's owner as it grows. When the allowance is used up, creating a recording, re-running a transcript and starting a live preview are refused with `402 allowance_exhausted`. Dictations are not counted twice: they are paid for with credits, and that debit already counts.
- 3b1d8c1: A workspace can now say how long it keeps meetings. `settings.recordings.retention` takes `transcriptDays`, after which a meeting is deleted with its audio and transcript, and `audioDays`, after which only its audio is deleted (0 deletes it as soon as the transcript is ready). Both count from when the meeting was recorded and apply to meetings recorded earlier too; audio can't be kept longer than the meeting. The worker applies them every few minutes. A meeting whose audio was deleted says when in `audioDeletedAt`, keeps its transcript and speakers, and can't be played or transcribed again (409 `audio_deleted`). The web settings have Keep meetings and Keep audio, with a confirmation before a change deletes anything sooner. Migration 0946 adds the column and the sweep's inventory, whose runtime EXECUTE grant follows in a later release.
- 83682c3: Meetings can recognize people by voice. It is off by default. When a workspace turns on `settings.recordings.voiceprints`, each diarized speaker's voice vector is kept with the transcript. People who agreed to be remembered get a voiceprint learned from the speakers named as them, and new transcripts suggest them by name with a confidence. The new routes are `PUT` and `DELETE /v1/workspaces/:workspaceId/recording-people/:personId/voice`. A member agrees with `self` consent, and someone from outside the workspace with `attested` consent. Turning the setting off forgets every voice. `PATCH …/speakers` takes `rejectSuggestions` to turn a suggestion down. The SDK adds `rememberRecordingPersonVoice` and `forgetRecordingPersonVoice`, `useRecordingPeople` adds `rememberVoice` and `forgetVoice`, and `useTranscript` adds `rejectSuggestion`.
- efd5e62: Repeating event triggers keep an automation running after its schedule's last run: a spent one-time date or an ended interval no longer pauses an automation that still listens for events (migration 0951). A blocked run's owner notice now says whether more runs follow from the automation's triggers too, so a finished run-once automation no longer claims it keeps trying. Blocker review facts carry the automation's event policy as `task.events`.
- 2b72f7c: Reuse preparation of the recursive Knowledge visibility statement while preserving the original per-member checks, query structure, and fresh authority evaluation.
- a5e68e4: Use scoped projected and legacy-fallback indexes for exact tool-call event pages, preserving existing ID equality, type filters and page boundaries without loading unrelated event payloads.
- eafdd84: Migration 0953 (rolling) adds the restrictive session visibility policy to `secret_use_approvals`, so an approval request is readable only by someone who can see the chat it came from, like every other chat-linked row. Grants still cover the acting person's own chats.
- 34f54fe: Opening a Site no longer moves its sidebar row, just as opening a chat doesn't. A Site row's time is the latest of its conversations, its newest published version, and the chats that published it (the one that created it and any used to edit it), as far as you can see them. Opening a Site still lists it in your sidebar.
- 7c9904b: Read only the control fields needed by session-work observations, avoiding unused frozen prompts and configuration payloads without changing query order or admission decisions.
- 19d9791: Avoid sizing payloads beyond a full event page's byte/count prefix while preserving page contents, continuation cursors, and separate payload reads.
- c665cd4: Index exact tool-name event pages while preserving legacy and oversized names, database collation, filtering and pagination.
- 0383280: User messages can now carry the sender's IANA time zone (`timeZone`) on `user.message` events, steer requests, composer submits and the initial message of a new session. The server validates the name, freezes it with the accepted turn, and the agent sees the sender's local time first, for example `[Message sent Sunday 2026-10-25 09:08 Europe/Oslo (08:08 UTC) by Ada]`. Messages without a zone render exactly as before. The zone is not part of a message's idempotency identity, so a retry that names another zone (or none) replays the original message. Published Sites forward their viewer's zone the same way.

  The SDK client fills the zone automatically on a person's device (browser, desktop app, React Native) from `Intl.DateTimeFormat().resolvedOptions().timeZone` when the caller did not pass one. Server-side callers never attach their own zone. Pass `messageTimeZone: false` in the client options to opt out. When an older server rejects the field, the client retries the message once without it.

  Schedules an agent creates or edits without a `timeZone` now use the zone of the message that asked for them instead of UTC (or, in a turn no person's message started, the chat's latest message that had a zone); an edited schedule keeps its current zone, and UTC applies only when there is neither. The create and update receipts report the zone that was used (`facts.scheduleTimeZone`). Requests from people and schedules that name a zone are unchanged.

- Updated dependencies [c8ddf55]
- Updated dependencies [e0b3ccf]
- Updated dependencies [1988e97]
- Updated dependencies [e7f5d38]
- Updated dependencies [e3782bb]
- Updated dependencies [e1838ff]
- Updated dependencies [ce72530]
- Updated dependencies [4c6bf32]
- Updated dependencies [f3d19a2]
- Updated dependencies [f6f112a]
- Updated dependencies [2dc5e41]
- Updated dependencies [9f6cab2]
- Updated dependencies [6f6c356]
- Updated dependencies [d502ba3]
- Updated dependencies [cccd692]
- Updated dependencies [3fa5c6e]
- Updated dependencies [d6c7c4a]
- Updated dependencies [bbc8f6d]
- Updated dependencies [392db50]
- Updated dependencies [31bca3c]
- Updated dependencies [6acfbd3]
- Updated dependencies [21e7ecf]
- Updated dependencies [627b2f1]
- Updated dependencies [c307566]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [4695d41]
- Updated dependencies [d6c7c4a]
- Updated dependencies [f9f0607]
- Updated dependencies [cc319f3]
- Updated dependencies [3b1d8c1]
- Updated dependencies [3c486ea]
- Updated dependencies [7d419e2]
- Updated dependencies [e5446f1]
- Updated dependencies [83682c3]
- Updated dependencies [a9809ee]
- Updated dependencies [acac580]
- Updated dependencies [f3d19a2]
- Updated dependencies [31c3308]
- Updated dependencies [e509f04]
- Updated dependencies [34f54fe]
- Updated dependencies [4e44f04]
- Updated dependencies [119f33d]
- Updated dependencies [c194abb]
- Updated dependencies [0383280]
- Updated dependencies [286058a]
- Updated dependencies [7c02dbd]
  - @opengeni/contracts@5.3.0
  - @opengeni/observability@5.3.0
  - @opengeni/config@5.3.0
  - @opengeni/network@5.3.0
  - @opengeni/codemode@5.3.0
  - @opengeni/codex@5.3.0
  - @opengeni/xai-subscription@5.3.0
  - @opengeni/subscriptions@5.3.0

## 5.2.1

### Minor Changes

- fb72b9d: Any member can now give a session they started their own access, not only organization owners and admins. The app calls it full access. Its agent can do exactly what that person can do in the app and nothing more, and the access ends when the person leaves the session's workspace. The organization's on/off switch is unchanged.

### Patch Changes

- 9413acc: Read a scoped Skill-presence boolean for session effective-tool metadata instead of loading every active Skill descriptor. Preserve live visibility and activation rules; full Skill catalog reads remain unchanged.
- Updated dependencies [e1126c2]
- Updated dependencies [fb72b9d]
  - @opengeni/codex@5.2.0
  - @opengeni/contracts@5.2.0
  - @opengeni/config@5.2.0
  - @opengeni/codemode@5.2.0
  - @opengeni/observability@5.2.0
  - @opengeni/network@5.2.0
  - @opengeni/subscriptions@5.2.0
  - @opengeni/xai-subscription@5.2.0

## 5.1.2

### Patch Changes

- 4e1a73f: Read workspace control state and kind within one fresh scoped transaction, preserving hidden-workspace handling and nested scope restoration.
  - @opengeni/codemode@5.1.0
  - @opengeni/codex@5.1.0
  - @opengeni/config@5.1.0
  - @opengeni/contracts@5.1.0
  - @opengeni/network@5.1.0
  - @opengeni/observability@5.1.0
  - @opengeni/subscriptions@5.1.0
  - @opengeni/xai-subscription@5.1.0

## 5.0.2

### Minor Changes

- 487bd43: External users have an inbox. A product's own users (external actors resolved through its organization key) now receive their sessions' questions, approvals, paused goals and agent notifications in an Opengeni inbox, as members do, and `notify_user` delivers to them instead of reporting `no_human_recipient`. `createSessionProxyHandler` relays the user's own inbox: `GET /v1/inbox` and `PATCH /v1/inbox/items/{id}` limited to the resolved workspace, and `GET`/`PUT /v1/inbox/settings`, so the stock app shows it behind a product's sign-in. `PATCH /v1/inbox/items/{id}` accepts `workspaceId` to act only on an item in that workspace. Phone pushes still need an Opengeni native-app sign-in.

### Patch Changes

- 93bd89d: Chrome profiles on a personal or organization-wide Connected Machine now appear and open in every workspace where that machine can be used, not only the workspace it was enrolled in. Browser and computer sessions record which workspace their profile is stored in, keep using that exact profile, and end when its Chrome restarts. Deleting the workspace a profile is stored in is never blocked by sessions elsewhere that used it. Ending a browser or computer session in a Chrome profile always succeeds: when the profile is disconnected, has restarted, is gone or can no longer be reached from the session's workspace, the end completes in the control plane instead of failing with not found.
- 3f6fd05: Fix a database deadlock between an external user's request and a turn starting in one of their chats. Resolving an external identity, changing a chat's visibility and forking a chat no longer take a lock on the person's organization membership that blocks foreign-key checks, so a turn that updates its chat twice can no longer deadlock with them. Lifecycle changes to the membership are still excluded until those requests commit.
- a9d20b3: Pause chat work atomically before personal archiving, require confirmation for active shared work, and retain explicit hide-only behavior for read-only and embedded proxy clients. Restore does not resume work. Keep sidebar survivors stable across archive completion and overlap independent session response reads without changing transaction or authorization boundaries.
- 2ffad67: Read the Personal workspaces setting inside the managed access projection read instead of a separate query.
- Updated dependencies [487bd43]
- Updated dependencies [a9d20b3]
- Updated dependencies [6d29c01]
- Updated dependencies [217ed52]
  - @opengeni/contracts@5.0.0
  - @opengeni/codemode@5.0.0
  - @opengeni/codex@5.0.0
  - @opengeni/config@5.0.0
  - @opengeni/observability@5.0.0
  - @opengeni/network@5.0.0
  - @opengeni/subscriptions@5.0.0
  - @opengeni/xai-subscription@5.0.0

## 4.8.0

### Patch Changes

- b0d752d: Batch artifact-list source-session authorization reads within existing response windows, while preserving per-source host authorization and a separate post-host visibility check.
- e4712be: Add a scope-aligned ordered history index so prepared receipt-page reads avoid intersecting a full-session index with the current turn. History, authorization and cursor behavior are unchanged.
- 238c599: A Site stays in its chat's project when people use it. New Site conversations started from the console are now filed in the Site's project: the API's "no project" (`null`) used to skip that rule and file them in Default. And a Site keeps its row in its own project even when its conversations sit in another one.
- Updated dependencies [85fb89e]
  - @opengeni/contracts@4.8.0
  - @opengeni/codemode@4.8.0
  - @opengeni/codex@4.8.0
  - @opengeni/config@4.8.0
  - @opengeni/observability@4.8.0
  - @opengeni/network@4.8.0
  - @opengeni/subscriptions@4.8.0
  - @opengeni/xai-subscription@4.8.0

## 4.7.2

### Patch Changes

- c6499fc: An agent asked to use the person's own Chrome without naming a profile now opens a connected profile on the computer the agent's session runs on, when there is one, instead of the most recently active profile on any computer. The opened profile and the other connected profiles now say which computer each is on, and mark the one the session runs on, so an agent can tell when it landed on another machine and pick a different profile. Discovering attached Chrome profiles shows the same. The attached-browser list gives each bridge's `sandboxId` and `machineName`.
- 106b430: Avoid cloning retained Knowledge content and checking unused relationships when projecting collection IDs. Full entry projection, collection visibility, ranking and pagination are unchanged.
- 8301382: A sub-session's question can now be answered by the person or by the parent agent, and the first answer wins. The parent's `child_requires_action` notice now carries each question's id, kind, prompt and option ids and labels (never secret specs), so the parent can answer with `session_human_input_respond` without reading the sub-session's history. The notice now also wakes an idle parent that has no goal. An agent whose answer arrives after someone else's gets `outcome: "unchanged"` with `alreadyAnswered: true`, who answered, and a warning not to answer again; before, it got a success-looking `replayed` result. The `user.humanInputResponse` event records whether a person, API key, agent or the system answered. The agent instructions and the `request_human_input` and `session_human_input_respond` descriptions now say that a parent answers when it can from its task context, leaves questions only a person can answer (decisions, preferences, credentials, approvals) to the person, and never answers on the person's behalf. The conversation now says "Agent answered" instead of "You answered" when an agent gave the answer.
- 61ec823: Read public workspace model metadata in one short tenant scope instead of three.
  Keep default selection, fresh admission, subscription discovery and execution
  credential resolution separate; no catalog or authorization cache is introduced.
- b3fc68b: Site rows in the sidebar sort only by real activity: their conversations, a new published version, and your own opens. Archiving, restoring or rolling back a Site no longer lifts it for everyone. The console records one open per page that shows a Site: not again when its client is replaced, and not again when a reload, restored tab or Back shows a page where it was already recorded. A page that loads hidden counts once it is shown.
- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
- Updated dependencies [8301382]
  - @opengeni/contracts@4.7.2
  - @opengeni/codemode@4.7.2
  - @opengeni/codex@4.7.2
  - @opengeni/config@4.7.2
  - @opengeni/observability@4.7.2
  - @opengeni/network@4.7.2
  - @opengeni/subscriptions@4.7.2
  - @opengeni/xai-subscription@4.7.2

## 4.7.1

### Patch Changes

- 2138bba: Renew sandbox agent links in one locked SQL statement instead of separate row, clock and update queries. Preserve the database-clock lease, refusal precedence and longer heartbeat extensions while removing two database round trips per successful renewal.
  - @opengeni/codemode@4.7.1
  - @opengeni/codex@4.7.1
  - @opengeni/config@4.7.1
  - @opengeni/contracts@4.7.1
  - @opengeni/network@4.7.1
  - @opengeni/observability@4.7.1
  - @opengeni/subscriptions@4.7.1
  - @opengeni/xai-subscription@4.7.1

## 4.7.0

### Patch Changes

- 31ef5b7: Database pools close idle connections after 30 seconds again, instead of five minutes, and recycle every connection after at most ten minutes (450 to 600 seconds, jittered per connection). Each PostgreSQL backend keeps its catalog cache and prepared plans until its connection closes, so long-lived idle and busy connections grew to 65-95 MB each and ran a 32 GiB staging server out of memory. Set `OPENGENI_DATABASE_POOL_IDLE_TIMEOUT_SECONDS` and `OPENGENI_DATABASE_POOL_MAX_LIFETIME_SECONDS` to tune this for the API, worker and editable-artifact service pools; `0` turns a timer off, and values above 2,147,483 seconds are rejected. `createDb` takes the same values as `idleTimeoutSeconds` and `maxLifetimeSeconds`.
- 5e3fb3c: Avoid reading skipped tool arguments and outputs during exact call-ID event filtering. A rolling migration extends the existing tool metadata trigger; historical rows retain the payload fallback, with unchanged authorization, codec handling, and pagination.
- afb32f5: Session message search no longer fails on large histories. One database statement used to check every remaining message, so on a large real workspace it ran past the request's 5 second statement timeout and the search failed. Each statement now reads at most 2,000 messages in order, and a request keeps reading further windows for up to about 1.5 seconds before returning a cursor. Measured on a production workspace with about 240,000 messages, one window takes about 25 ms. A search with no hits still covers the whole history across a few requests, and common terms return at once. Matching, ordering, offsets, snippets, grouping and cursors are unchanged.
- 1ea2039: Session message search now uses a trigram index, so a search reads only the messages that can contain the text instead of walking the whole history. Row-level security used to stop PostgreSQL from using any text index for this search. Message text now also lives in a separate table whose row-security policy is the search pattern, which lets the index serve it under the same workspace and visibility rules. A trigger fills it for new messages with the writer's own rights (no new SECURITY DEFINER routine, so the previous release keeps passing its database posture check during a rolling deploy), and a batched migration copies existing history. On a copy of a 234,000-message workspace, one window takes about 2 ms for a rare word and 15 to 50 ms for common ones. `scannedMessages` now counts only the candidate messages read. Migrations install the `pg_trgm` and `btree_gin` extensions; managed PostgreSQL services with an extension allowlist (such as Azure's `azure.extensions`) must allow them first.
- b8452ee: Listing workspaces inside an existing transaction no longer fails when the caller has several workspaces. Each workspace's details are read in its own row-security scope, and inside a transaction those scopes were opened concurrently on one connection, where they overwrote each other's tenant settings. External actors calling `GET /v1/workspaces` hit this as a 500 with `SAVEPOINT can only be used in transaction blocks` in the database log. The scopes now run one after another inside a transaction and stay concurrent otherwise.
- Updated dependencies [31ef5b7]
- Updated dependencies [31095f1]
- Updated dependencies [7308de5]
  - @opengeni/config@4.7.0
  - @opengeni/contracts@4.7.0
  - @opengeni/codemode@4.7.0
  - @opengeni/codex@4.7.0
  - @opengeni/observability@4.7.0
  - @opengeni/network@4.7.0
  - @opengeni/subscriptions@4.7.0
  - @opengeni/xai-subscription@4.7.0

## 4.6.1

### Patch Changes

- d0eb91c: A session's sub-agents now come back newest first at each level, and the 200-agent cap keeps direct agents and newer ones before deeper or older ones (it used to keep an arbitrary subset ordered by id). `sessionAgentAttention` and `formatWaitingSince` in `@opengeni/react/session-agents-model` give the word a manager must act on (Needs you · 10h, Failed, Stuck, Paused) for web and native. The phone's agents sheet shows that word in place of the time, and folds each agent's own agents behind a count.
  - @opengeni/codemode@4.6.0
  - @opengeni/codex@4.6.0
  - @opengeni/config@4.6.0
  - @opengeni/contracts@4.6.0
  - @opengeni/network@4.6.0
  - @opengeni/observability@4.6.0
  - @opengeni/subscriptions@4.6.0
  - @opengeni/xai-subscription@4.6.0

## 4.5.0

### Patch Changes

- cfefee3: Let organization administrators inspect usage on independent subscription connections concurrently. Keep the organization membership fence shared for these reads, while lifecycle writers and each connection's credential custody retain their exclusive locks. Demotion still waits for in-flight provider reads and prevents subsequent reads and quota recording.
- 1b8ca50: Read only tool identity fields when proving durable call/result pairs, instead of transferring full history payloads. Preserve row order, codec handling, identity precedence, authorization, and canonical model history.
- acbf24e: Withhold pooled subscription capacity while an account's other main limit is exhausted, and report the next usable reset when the pool is already exhausted.
- bce44cc: Session message search checks message text in the database. A search over a large workspace used to read about 33 messages per request, and once the database step took longer than the request's time budget it advanced by a single message per request, so searching a long history never finished. One request now checks every remaining message and reads only the ones that contain the text, so a search with no hits over about 240,000 messages finishes in one request of about 1.5 seconds. Grouped (per-chat) search returns up to a full batch of chats per request instead of one. Matching is unchanged: literal, Unicode case-insensitive, with the same offsets, snippets and cursors.
- 51d84b7: Migration 0907 (one owner per subscription account) now finishes in seconds on large databases instead of timing out, and is now a maintenance migration: releases park database clients while it runs, because it locks the subscription tables for the whole fold (about six seconds at 30,000 accounts and 100,000 workspaces). It waits at most five seconds to take each set of locks; that bounds only the wait, not how long it then holds them. A disconnected account that a workspace still managed while it reached other workspaces no longer stops the migration; it becomes the organization's. The end state is otherwise unchanged.
- Updated dependencies [6c7b552]
- Updated dependencies [f838cb7]
- Updated dependencies [acbf24e]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
- Updated dependencies [60e9756]
  - @opengeni/codemode@4.5.0
  - @opengeni/config@4.5.0
  - @opengeni/contracts@4.5.0
  - @opengeni/subscriptions@4.5.0
  - @opengeni/codex@4.5.0
  - @opengeni/observability@4.5.0
  - @opengeni/network@4.5.0
  - @opengeni/xai-subscription@4.5.0

## 4.4.1

### Minor Changes

- 81a516c: Organizations and workspaces can choose the default voice model. Organization → Models → Voice and a workspace's Voice settings gain a "Default voice model" choice: the model a new voice conversation starts with. A workspace follows its organization's choice unless it picks its own, and "Automatic" keeps the previous behaviour (GPT Realtime when available, otherwise the first available model). People can still pick another model when they talk, and a model someone already picked on their device stays their choice while it remains available.

  API: `OrganizationModelDefaults.realtimeDefaultModel` and `UpdateWorkspaceSettingsRequest.realtimeDefaultModel` (a voice model id, or null for automatic or to follow the organization), and the realtime model catalog marks `workspaceDefault` and `organizationDefault`. The packaged voice control starts with the person's own usable pick, then the workspace default, then the organization default. Rolling migration 0903 adds one nullable column.

- 84b1a18: Every subscription account now has exactly one owner: the organization, one workspace, or one person, and it is used wherever it reaches and nowhere else. The per-workspace split between a workspace's own copy of an account and the organization's copy, the preference that chose between them, and "Set aside" are gone; each account has one on/off switch. A migration keeps everyone's access exactly as it was.

  The organization's account lists now include `reach` (who each account reaches), and the organization's Models page lists every account once, grouped by provider, with its owner and a summary of how many are on and how many need reconnecting. Accounts that are turned off fold away when a provider has several, and the page no longer reads every workspace's accounts or each account's access one by one.

### Patch Changes

- 2677b14: Read router-history presence for session response pages in one scoped transaction instead of one transaction per session. Preserve the indexed history predicate and existing effective-tool response fields.
- 032d671: Batch Knowledge evidence visibility checks within each read and exclude keyword nonmatches before traversing their evidence graphs. Search ordering, pagination, access predicates and agent-attempt locks remain unchanged; no authority decisions are cached between reads.
- d705817: Read managed human workspace grants, organization names and the legacy default workspace together instead of issuing serial queries for each organization. Every request still resolves live memberships and permissions; provisioning, default selection and personal-workspace access are unchanged.
- 9ba6486: When a turn fails because one of Opengeni's own database checks refused it, the failure now records which check refused it: the database function names and line numbers on the call chain, for example `admit_turn_resources:31`. Before, the record kept only the error code. The refusal message and SQL text are still never copied. A one-off permission refusal can now be traced after the fact without server logs.
- eec0cab: Export `SubscriptionCoreConnectionReach` so packages that return account reach can emit their declarations.
- 25d1500: Infrastructure-only session events, such as the idle sandbox reaper terminating a shared box, no longer move a session's `updatedAt`, so stopped sessions keep their real last-activity time in the sidebar and session lists (migration 0904). Sessions and session list entries now carry `hasUpcomingSchedules`, and the sidebar schedule icon only appears for schedules that can still fire. A session whose schedules are all paused or expired keeps a distinct "No upcoming runs" schedule button in its header. Editing only a schedule's timing now refreshes open session lists (migration 0905).
- 9a3df31: Use keyed personal-state reads for session-list totals, with a concurrent session-first index. Generic prepared plans no longer repeatedly scan a large workspace's personal-state range when most other workspaces are small. List contents, permissions and transaction behavior are unchanged.
- 73a4ad9: Reduce repeated database-readiness catalog work by inspecting table and routine namespaces together, aggregating policy facts once, and reading activation-presence facts with connection identity. Every readiness check still reads and validates current catalog state in one read-only repeatable-read transaction.
- ec6a821: Restore the migration connection's inherited statement and lock timeouts after each batched backfill, including failure or query cancellation, instead of resetting them to zero. Later migrations, including concurrent index builds, retain the operator-configured statement deadline. Historical migration SQL and per-batch timeout directives remain unchanged; no new production timeout is introduced.
- 9c0c6d1: Keep the public sandbox recovery response compatible now that every managed backend recovers a lost sandbox. `SandboxRecoverySelection.artifactId` is a required native checkpoint id again, as it was before, so existing SDK readers never receive null there. A portable checkpoint that an automatic Retry restores is named by the new optional `SandboxRecoveryProjection.automaticCheckpoint` (`SandboxCheckpointSelection`, whose `artifactId` is null for a portable archive); `checkpoint` is set as well only when that checkpoint is native. The packaged recovery actions read `automaticCheckpoint` first. Older clients still recover these sessions when the next message is sent; they only lack the Retry shortcut for a portable checkpoint.
- 6282659: Keep each response-page router-history probe on its early-stopping index scan, so a long-running session's router items are not all collected before the first match.
- a75f55e: A lost sandbox now recovers by itself on every managed backend, not only Modal. Docker, compute and the other hosted providers restore their latest verified checkpoint automatically, with the same "files may be older" warning Modal already gives. A session continues on an empty workspace only with proof that the lost sandbox is really gone: the compute control plane's own answer, a Docker workspace directory that the same daemon shows deleted, or a provider lifetime that has run out. A single transient or false "not found" (for example during host memory pressure) can therefore at most restore a checkpoint and never empties a workspace by itself. A failed rebuild after a loss keeps that loss on record instead of silently starting the session on an empty workspace, so the person who controls the chat can still choose Retry or an empty workspace without any database repair. `SandboxRecoverySelection.artifactId` is now nullable, because a portable checkpoint has no native artifact.
- f4508d6: Allow scheduled runs to use the selected organization-shared Slack bot while preserving installation versions, sharing generations, workspace restrictions and live revocation checks.
- f0c2065: Exclude child trees outside the selected root scope before aggregating session-list totals. Preserve child visibility, archive, pin, attention and control-state semantics while avoiding unrelated descendant reads.
- aa280c9: Use the existing event tool-name projection for named tool-history reads, avoiding decompression of excluded calls' arguments. Legacy rows and losslessly encoded identities retain their existing fallback and output behavior.
- Updated dependencies [e697879]
- Updated dependencies [11e56da]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [d295544]
- Updated dependencies [81a516c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [a75f55e]
- Updated dependencies [84b1a18]
  - @opengeni/contracts@4.4.0
  - @opengeni/config@4.4.0
  - @opengeni/subscriptions@4.4.0
  - @opengeni/codemode@4.4.0
  - @opengeni/codex@4.4.0
  - @opengeni/observability@4.4.0
  - @opengeni/network@4.4.0
  - @opengeni/xai-subscription@4.4.0

## 4.3.1

### Minor Changes

- b1a5fad: Make model-call-fact reconciliation resumable and bounded by input pages instead
  of a full-history join. Preserve existing facts and billing ledgers, persist
  progress atomically, and join database work to the maintenance caller's existing
  deadline and cancellation. Preserve shorter configured statement timeouts.
  After the initial historical sweep, process commit-coupled arrivals instead of
  repeatedly rescanning the lookback window. Delayed events reopen unresolved keys.

  Apply rolling migrations 0890–0894 before starting the new worker. Direct callers
  of `reconcileModelCallFacts` must continue while `truncated` is true: counts are
  per-page resolved gaps, and a page can have more work with zero gaps. Maintenance
  cancellation requires the `createDb` postgres.js adapter; unsupported injected
  drivers fail explicitly rather than leaving detached database work running.

- 03947ed: Keep idle session sidebars quiet using authorized commit-level invalidations on
  the existing workspace live stream. Web and desktop refresh dirty loaded scopes
  within the existing 15-second cadence and reconcile on reconnect/focus. Private
  session IDs are filtered with the same RLS and membership fence as list reads.

  Database hosts using a transaction pooler may configure a separate direct/session
  notification URL. Older servers, external host ACLs, injected database handles
  without a listener, and finite HTTP/1 streams keep their polling fallback. The new
  SDK workspace event is transient and does not advance either durable stream cursor.

- 579239a: Sites can be duplicated: `POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/duplicate` (SDK `duplicateWorkspaceArtifact`) copies a Site's current version (HTML, source and requested tools) into a new Site owned by the caller, with the original's visibility. The copy is titled "… (copy)" unless a title is given; its publication, Site Data and history stay with the original. The copy references the original's immutable stored content instead of copying bytes, and a retry with the same key replays only a copy of the same Site.
- 559eaa8: Remove unused Drizzle relational-schema registration from `createDb`, avoiding hundreds of query-builder allocations on every transaction. SQL, row-level security, and commit boundaries are unchanged.

  Breaking: the exported `Database` port and its transaction callbacks no longer expose `db.query.<table>`. Use explicit-table queries instead, for example `db.select().from(schema.sessions).where(eq(schema.sessions.id, id))`. Hosts may still inject their own schema-configured Drizzle handles and use relational queries through their original handle; Opengeni's structural port only needs explicit-table builders.

- d8289f0: Avoid transferring unused frozen session, turn and attempt data for tool receipt and operation checkpoints. Mutation callers can explicitly request the existing narrow event-fence projection; plain callbacks still receive full rows. Lock order, authority decisions, atomic receipt/event persistence and replayed model history are unchanged.
- 6f150d1: Organizations can set up realtime voice once for every workspace. An organization ElevenLabs key (`elevenlabs` organization provider connection) is used by every workspace without its own key, and organization model defaults gain `realtimeVoice`: per-model voice, language and turn-taking defaults that a workspace uses for a model until it saves its own. The realtime model catalog reports the inherited settings as `organizationVoiceSettings`. Organization custom models stay limited to the model-catalog provider kinds (`OrganizationModelCatalogProviderKind`).
- 9976132: Add pooled weekly subscription utilization, estimated plan-size weighting and reset-aware forecasts with one total remaining bar. Retain observed limit history; organization pools cover organization accounts and workspace pools cover all visible accounts available to that workspace, using each account's total usage. Show five-hour limits only when blocking an account; keep individual account details in the account list.

### Patch Changes

- 2d1350b: Commit tool receipts with their timeline events and retire completed receipts with stable conversation history, removing duplicate attempt fences without changing model-visible history or parallel-result durability.
- cca885b: A Send or Steer that automatically resumes a paused branch now wakes the branch's waiting sub-sessions, as an explicit Resume does. Before, only the steered session got a wake, so a paused sub-session waiting on capacity, a parked recovery, an active goal, pending updates or a decided approval stayed stuck after the branch was resumed.
- 29a1d94: Add a workspace-scoped batch read for generated image artifact metadata so artifact catalogs can reduce database round trips while retaining separate file authorization.
- 31c6406: Batch editable artifact catalog metadata reads while preserving per-artifact live authorization and revision fences. Custom application and storage adapters retain their existing single-read fallback.
- 1b1805f: Batch current collection reads during Knowledge save preparation while retaining per-entry authorization, current-view checks, ordering, and cursor behavior.
- a363a8c: Avoid rewriting and locking unchanged attached-browser profiles on each inventory heartbeat. Store liveness once per enrollment while preserving per-profile last-seen timestamps and serialized material changes.
- 29a1d94: Reduce idle checkpoint cleanup query work while preserving snapshot references, capture fences, and concurrent claim safety.
- 0e135b2: Add a command menu and keyboard shortcuts. ⌘K (Ctrl+K on Windows and Linux) opens one list of chats and actions: recent chats, actions for the open chat (copy link, pin, rename, mark unread, archive) and general actions, with "Search messages" handing the query to full-history search. ⌘/ opens a cheat sheet of every shortcut. One action registry feeds the menu, the chat row and header menus, tooltips and the desktop menu bar, so a key or label is defined once. `@opengeni/react/ui/context-menu` exports `ContextMenuShortcut`, and the prebuilt `@opengeni/react/compiled.css` includes the new menu's styles.

  The SDK's desktop bridge adds the `menuActions` capability with `DesktopMenuAction` and `DesktopMenuSection`, so the desktop app builds its menu bar from the actions the page reports; older desktop builds keep their static menu. Chat title search matches every word of the query in any order, in the title or first message, instead of one literal substring.

- cd3fdb2: Read only admission and projection fields when fencing event-only appends, avoiding repeated transfer of frozen prompts and configuration. Preserve the full-row mutation callback contract, transaction-scoped control checks, and raw-lane cursor reread.
- 74f6ab1: Persist submitted composer model, reasoning and latency choices as the chat's defaults, including for subsequent scheduled and automatic turns. Apply the choice atomically with Send or Steer without changing already accepted turns or reapplying old choices on retry.
- b7ee3dc: Read session-list attention cursors only for nodes contributing to the requested totals, avoiding visibility probes for discarded archived and pinned trees while retaining row-level security.
- f47e3b2: Database pool connections now stay open for five minutes of idleness instead of 30 seconds, so workers stop paying a fresh connection handshake on roughly one request a second between bursts.
- b8aaefa: The published package now builds the `@opengeni/db/provider-recovery-clock` entry point, so importing it from the published package works.
- c2cbeae: An idle sandbox now drains even when an API request (Files, Terminal, Browser and similar) died mid-operation and left its request open. Before, the holder reaper removed the dead request's holder but kept its request, and that request refused every capture of the box: Modal boxes ran until the provider deadline, and Docker boxes stayed draining forever. Docker drains also capture requests left by a crashed turn worker now: the drain removes the exact container before it reads the host workspace, so the capture is a point-in-time image, as Modal snapshots already are.
- 1ce8ea5: A Docker sandbox whose container is reported missing during an idle drain no longer loses its chat. The drain used to commit the lease as archive-only and drop the provider state, so the workspace was declared unrecoverable even though its host directory was still on disk, and every later turn in that chat was blocked (this also happened when the daemon briefly reported NotFound while the host was under memory pressure). The cold commit now keeps the same Docker continuity receipt a lost warm instance keeps, and the next turn restarts a container on the same host directory, or reattaches the one a false NotFound missed. Separately, sandbox recovery consent can now be given through the API by an organization key acting as one verified external user on that user's own behalf (asUser), not only from the browser cookie session. Agents, bare API keys, service initiators and delegated bearers still cannot consent.
- b20c9b2: Retain bounded agent-update blocker categories/counts and show their report age
  and elapsed holds in Machines and fleet, without disclosing private session IDs. Distinguish controller work
  from native request admission without changing update safety, killing work or
  adding command deadlines. Older agents that cannot identify a blocker remain
  explicitly unspecified. These diagnostics do not establish the cause of an earlier
  hold whose admission snapshot was not retained.
- 70f0522: A chat whose sandbox workspace cannot be restored is no longer stranded: the current archive can be retried on a new attempt, a cold workspace follows the session's selected sandbox backend, and a person can explicitly continue with an empty workspace. The agent then sees a filesystem-discontinuity notice on every later turn, appended at the end of its history.
- dc9a23b: Read repairable usage-event keys once per missing turn instead of repeatedly scanning event history under row-level security. Let concurrent index migrations finish their safe wait for older snapshots without the ordinary DDL lock timeout.
- a252bf9: Keep older Opengeni binaries ready after securely shaped, additive database objects arrive, without relaxing known table or routine contracts. Add pinned previous-binary readiness CI over the fully migrated schema and restricted runtime role.
- 18030c8: AI chats from "Anyone with the link" visitors on a Site published from a personal workspace work again. They used to fail with a database permission error as soon as the turn started, before the model was called, because learning for a personal workspace assumed a signed-in person. Work with no initiating person in a personal workspace now uses the workspace learning destination, as it already does in shared workspaces, never reaches the owner's personal layer, and saves no Knowledge, Skills or instructions there.
- 23fed2a: Chat history no longer depends on the server and `@opengeni/react` being released in a particular order. The events API now says when it applies the conversation filter (`X-OpenGeni-Conversation-Filter: 2`, read as `SessionEventPage.conversationFilter`). When a server does not say so, the React history reads keep tool calls in and drop the ones that are not presented in the browser, so an older server that ignores `presentedToolCalls` no longer makes images, published files or Skill cards vanish from history.

  A long turn's model bookkeeping also stops filling the history window: each model call's `agent.model.request` and `agent.model.usage` rows load with the turn's steps. The server keeps the request rows up to a turn's first model response, which draw its startup phase, and every bookkeeping row of a turn that has no other steps, so what the conversation shows is unchanged. `createEmbeddedSessionClient` now keeps `listEventPage` when the base client has it.

- 29a1d94: Index non-null session-event attempt references so deleting a settled chat no longer scans unrelated workspace events for every historical attempt. The existing restrictive foreign key and tenant boundaries stay unchanged; the index builds concurrently.
- 95c5219: Session-wide pending-writer and quiescence checks now evaluate only the attempts that can still hold a writer or await quiescence, instead of every attempt in the session's history. Long-lived sessions no longer pay per-attempt correlated subqueries on every queue peek, claim and recovery check.
- eeab39f: Keep accepted turns recovering while required first-party MCP setup cannot reach the internal API, instead of failing after five attempts during a deployment outage.
- 8f66667: Opening an organization invitation no longer locks the invitee out. Signing in links pending invitations to the verified account. The organization seat-limit check used to depend on the signed-in person's own organization context. As a result, people with an existing account were denied access to every organization, and in restricted database setups the seat limit could be skipped. The check now always evaluates the inviting organization and leaves the caller's context unchanged.
- ebdd6dc: Keep recursive Knowledge visibility checks on indexed dependency identities instead of scanning all account entries and evidence links for each result. Preserve evidence-cycle handling, revision/source access checks, discovery filtering, search ranking and pagination.
- f83cd2a: Keep the session list's Mine filter on indexed existence probes instead of reading the person's complete prompt history for each list query. Preserve workstream matching, human-prompt rules, visibility checks and pagination.
- 4a2e10f: Evaluate the existing Knowledge scope predicate as a cached PL/pgSQL expression instead of a separate SQL query for every candidate and evidence identity. Keep all tenant, personal, temporal and legacy-scope checks, security metadata and response semantics unchanged.
- 00a0865: Reuse the caller's tenant transaction when checking a turn's linked identity during connection authorization. Keep live revocation and permission checks while removing redundant savepoint and RLS setup statements.
- 1d62cf3: When an agent tries to use someone's personal (Only me) computer that they have not yet allowed in the chat, the chat now shows them the card to allow it right away. The agent is told the card is posted in the chat and gets the chat link, so it tells the person in one sentence (or gives the link when they are reading in Slack or a worker chat) instead of waiting or retrying the same command. Cards for other connections, such as Slack and GitHub together, are not limited; only a repeated computer refusal in the same turn reuses that turn's computer card, even when several are refused at once.
- 6794bf2: Removing a workspace member or offboarding an organization member now works when that person's sessions selected their own connected account. Previously two session fences rejected the revocation and the removal failed with a generic "not available". External membership errors now also name the database check that refused them.
- 1e63001: Make the named shared-workspace Member role a full teammate. Members can now take over a session's desktop and terminal, edit a session's files, connect their own accounts and model subscriptions, attach session MCP servers, create Sandbox Environments, see and pick Connected Machines, manage any Site they can see (Site Data, Site SQL, publication, takedown and restore), and author, install and review workspace Skills. Rolling migrations 0865-0867 update the preset, lift older named Member sets written by overlapping binaries, and backfill exact-match memberships in batches; custom and external memberships are unchanged. Settings-class powers (workspace settings, members, API keys, the GitHub App, integration and plugin install, machine enrollment, workspace provider keys, the Slack bot and the default Sandbox Environment) stay Admin-only. Personal-workspace owners also gain `rigs:manage`. A Personal-workspace owner now administers their own Sites (limits, the outside-visitor agent switch and extra Site agent tools). Members can also replace or disconnect workspace-shared integration credentials that someone else connected, and as Site managers they read every record in per-viewer and append-only Site Data collections. Person-less API keys with `rigs:manage` still set the default Sandbox Environment. Installing the workspace Slack bot, through either its install route or the shared Connect flow, now requires `capabilities:manage`; embedding or API keys that hold `connections:write` without `capabilities:manage` can no longer set up the Slack bot.

  Release note: the migrations run before every API instance has the new settings checks, so for the few minutes of a rolling deploy an old instance could let a Member change a workspace provider key, install the Slack bot or set the default Sandbox Environment. This short window is accepted; an admin can revert any such change.

- dc1dd93: Avoid fetching frozen prompts, tool catalogs and session configuration when generic event appends and identity-only attempt mutations only need their existing narrow write fence. Locks, transaction boundaries, event payloads and authorization checks are unchanged; full-row callback contracts remain available.
- a00e4bb: Avoid loading full session presentations when API routes need only existence and the canonical event sequence. Preserve RLS and cursor integrity checks while removing unrelated metadata, model, and workflow reads.
- 0432630: Voice, transcription and media calls on a subscription account now use the same accounts as the workspace's chat turns. Under the automatic source, a workspace whose own pool cannot serve falls back to the organization pool instead of showing "Connect Codex" while chat keeps working.
- 27a5a89: Add an online ordered turn-history index so durable tool receipt checks can fetch the newest page without sorting the turn or scanning unrelated session history. History contents, ordering, access checks and receipt semantics are unchanged.
- 7517fbc: Organization owners and admins can now connect OpenAI and Azure OpenAI once for the whole organization in Organization settings → Models, next to the other organization providers. OpenAI stores an encrypted API key; Azure OpenAI stores an encrypted key plus the Azure resource endpoint. Admins add the organization's OpenAI model IDs or Azure deployments as its models, and each is checked with the organization's key (and Azure endpoint) before it is saved. The models (`organization-openai/<model>` and `organization-azure-openai/<deployment>`) inherit into the organization's current and future shared workspaces (Personal workspaces stay local), work for sessions created through the web app and the public API, and are billed to the organization's own provider account with no Opengeni credits. `OrganizationModelProviderKind` and `ModelConnectionAccessKind` gain `openai` and `azure_openai`; organization provider connection requests and responses gain an optional `endpoint` (Azure only). A missing or revoked connection fails closed and never falls back to deployment credentials. Host `OPENGENI_MODEL_PROVIDERS_JSON` can no longer use the reserved `organization-openai` or `organization-azure-openai` provider ids. Rolling migration `0898_organization_direct_openai_model_providers.sql` widens the provider-kind, lifecycle-fact and analytics allow-lists and adds the nullable endpoint columns.

  An organization ElevenLabs key no longer counts as an OpenRouter access policy when a workspace's model restrictions are read.

- 18030c8: Sites and documents work in Personal workspaces. The owner can now create, open and edit documents, spreadsheets and presentations there; they used to be refused because a Personal workspace has no membership row. Publishing an Only me Site from a Personal workspace (every Site an agent makes there) now shares it with that one-person workspace as it publishes, instead of stopping at a "Share this Site with the workspace first" notice with no way to share. On their published Site the owner is a member again: they can open members-only and invited Sites, and their Site AI chats run as themselves rather than as an outside visitor.

  Workspace Viewers can use a Site's assistant wherever people outside the workspace can (invited or anyone-with-the-link Sites), as an outside visitor would; they used to get "missing permission: sessions:create" while anonymous guests could chat. On members-only Sites the page is now told the assistant is unavailable to them instead of offering it.

- 59a90e2: Add cumulative pre, maintenance and post migration phases, read-only phase plans,
  and a versioned completion receipt. Limit pre to posture-inert rolling work so
  the old fleet's continuous readiness checks remain valid. Defer the eligible rolling suffix until after
  traffic returns, with validated post-release markers for unique concurrent
  indexes and batched backfills and a pre-release index opt-out. The default runner
  continues applying every pending migration.
- b45d380: Claim compatible waiting Steer messages together, preserving each message while avoiding empty replacement attempts and response rows.
- 0cc6b93: Stop the recovery wake reaper from rediscovering paused-mid-turn sessions forever. Discovery now omits quiesced recovering turns parked behind Pause, an admission block or a sandbox setup marker, whose own unblocking action commits a wake, and the repair now parks a paused session whose projection was left at `recovering`.
- 724b529: Session list totals now report an optional `waiting` count of idle sessions parked until they are woken by input or a timer. These sessions remain included in `active` for compatibility. The web console uses the count to show a still clock instead of the working spinner for sessions that are only waiting.
- bc64dbb: Index realtime history references so archiving conversation history does not scan the entire realtime ledger for every deleted item. The additive index builds online and preserves foreign-key behavior.
- 29a1d94: Remove two duplicate session and turn identity indexes after verifying that their original unique indexes retain the same definitions and all foreign-key dependencies. This reduces index maintenance on session writes without changing tenant constraints or query behavior.
- 390562e: Resume now wakes sessions waiting on shared subscription capacity. Session and workspace Resume registered a wake only for legacy Codex waiters, so a session paused while waiting on capacity stayed `waiting_capacity` after Resume until an unrelated capacity change happened to wake it. Paused waiters also no longer start a workflow run on every capacity change, and a rolling migration wakes unblocked waits that were already resumed without a wake.
- a1265ca: A browser or desktop whose sandbox instance is gone no longer keeps the sandbox warm. When a sandbox lost, drained or replaced the instance a browser or desktop controller ran in, the resource stayed `active` forever and its holder kept every later box of that sandbox warm on every provider, so it never idle-drained. The interaction reaper now marks such a resource `lost` (`placement_instance_lost`), settles its pending operations and releases its holder, and the sandbox drains normally. Resources on the current instance are untouched.
- 7b1da5b: Reuse public workspace connection metadata within each model catalog or admission-input load to avoid a second direct-provider query. Preserve per-request scope, private connection filtering, fresh admission boundaries, and standalone or transaction-scoped fallback reads.
- d21ada4: Looking up a sandbox by something that is not a sandbox id, such as a machine's display name passed to `sandbox_swap`, now returns "not found" instead of surfacing a raw database cast error to the agent.
- a78e908: Every scheduled run now either runs or tells the schedule's owner. An occurrence aimed at a paused chat is skipped under every overlap policy, so the schedule pauses itself and says so instead of queueing runs that never settle; a paused workspace skips runs with its own reason and keeps the schedule. A daily, weekly or one-time schedule tells its owner on its first failed run, only schedules running at least hourly wait for three in a row, and a schedule's failed last run is reported before the schedule retires.
- 6e61993: Conversation-first history reads no longer slow down with large tool arguments. Tool-call rows now carry a trigger-filled `tool_name` column, and the presented-tool filter reads it instead of the payload name, so skipped calls are no longer detoasted. Rows written before the migration fall back to the payload name and are classified exactly as before.
- 1bc6fe5: Reduce session-list totals work by joining each node's static personal state before the recursive walk and carrying it through aggregation. Preserve visibility, pinned paths, unread state and attention counts while avoiding repeated joins and unnecessary duplicate elimination.
- d0c8261: Distribute machine state ingestion across API replicas instead of repeating every heartbeat and Hello write in every replica. Renew the exact runner lease and return its accepted metadata in one database statement, preserving independent optional inventory and metrics processing.
- a82b6a4: A chat shared with the workspace whose parent chat is still private can now be prompted by other members. Their turns used to fail before the model ran ("A database error occurred.") because the turn-start Company Brain context selection required the whole task tree, private parent included, to be visible to them. The selection now needs only the exact current turn and attempt and the addressed chat to be visible (migration 0896). Task notes still cover the whole tree, so they stay closed to a member who cannot see the private parent.
- a5d6f8a: Allow independent connection validations to share lifecycle read locks while preserving cancellation, revocation and audit replay fences.
- 06b8b74: Project semantic event sequence and activity in one session-row write instead of two. Preserve raw-stream isolation and rolling writer compatibility.
- b95784c: Support multiple personal Slack identities with exact-account reconnect, selected-workspace bot availability, and the same bot posting capabilities in scheduled and interactive work. Preserve existing schedule destinations as defaults without adding excluded tools.

  Keep role provisioning compatible with database schemas that predate selected-workspace bot access.

  Add workspace default machines for new chats and schedules that follow the workspace. Preserve accepted execution placement across retries and report unavailable machines without silently choosing another computer.

- d6a83bc: A subscription connection quarantined after a 403 is available again as soon as its quarantine ends. Before, only a turn could clear it, so until some turn on that account happened to run, new sessions on its models were refused with "model is not available", the account picker listed it as inactive, and a person whose only personal connection was quarantined could not start the turn that would recover it. Admission, the model catalog and the account lists now read an ended quarantine as active; turns still recover the stored row before they place.
- e6b2285: Restrict the workspace administrator predicate to the application roles so dedicated capability-only roles keep their exact function sets.
- 1b76e0d: A workspace membership with role owner, or with the workspace:admin permission, now administers the workspace's subscription accounts and settings in the database, matching the API's workspace:admin check. Before, the database accepted only role admin, so such a subject passed the API check and was then refused when it connected or managed an account.
- Updated dependencies [e907c46]
- Updated dependencies [3d83bfd]
- Updated dependencies [03947ed]
- Updated dependencies [5e32e0f]
- Updated dependencies [f1fd83b]
- Updated dependencies [659c01a]
- Updated dependencies [d1de8b4]
- Updated dependencies [2acb52c]
- Updated dependencies [2963eca]
- Updated dependencies [374dd81]
- Updated dependencies [91329fc]
- Updated dependencies [46a2ef3]
- Updated dependencies [579239a]
- Updated dependencies [ffe09c2]
- Updated dependencies [1b57d74]
- Updated dependencies [277c99c]
- Updated dependencies [b20c9b2]
- Updated dependencies [70f0522]
- Updated dependencies [23fed2a]
- Updated dependencies [e4915c1]
- Updated dependencies [16781e5]
- Updated dependencies [7517fbc]
- Updated dependencies [6f150d1]
- Updated dependencies [9976132]
- Updated dependencies [724b529]
- Updated dependencies [3915617]
- Updated dependencies [4fadd37]
- Updated dependencies [9508318]
- Updated dependencies [017121f]
- Updated dependencies [b95784c]
- Updated dependencies [b603f10]
- Updated dependencies [67262de]
  - @opengeni/observability@4.3.0
  - @opengeni/config@4.3.0
  - @opengeni/contracts@4.3.0
  - @opengeni/network@4.3.0
  - @opengeni/codex@4.3.0
  - @opengeni/subscriptions@4.3.0
  - @opengeni/codemode@4.3.0
  - @opengeni/xai-subscription@4.3.0

## 4.2.0

### Minor Changes

- 641e179: Add an opt-in `compute` sandbox backend for Opengeni compute. Each compute sandbox runs the Opengeni machine agent with no credential; its host carries the agent's traffic over one link to a new agent gateway in the API, so the sandbox gets the same session as a Connected Machine and a message to a sleeping sandbox wakes it. Opengeni creates the sandbox's enrollment itself (kind `sandbox`, bound to its sandbox group, never listed or attachable as a Connected Machine), treats the sandbox as a managed sandbox, and deletes it and revokes the enrollment when its group ends. Configure it with `OPENGENI_COMPUTE_API_URL`, `OPENGENI_COMPUTE_API_KEY`, `OPENGENI_COMPUTE_LINK_URL` and `OPENGENI_COMPUTE_IMAGE`; the default backend is unchanged.
- 641e179: A finished command's stored output is now released on its runner in one answered exchange, for foreground and background commands alike. The agent serves a new `OpRelease` request (advertised as `capabilities.op_release`): it drops the operation at once and confirms the release in its answer, so the release settles right where the output is stored, while the agent is live from the command, and nothing about the command is left for a later maintenance pass. When the storing process dies first, the agent's own operation inventory recovers the release, so maintenance never sends such an agent anything to release output. Every request Opengeni sends on its own behalf carries `Opengeni-No-Wake`, which a compute host answers itself instead of waking a sleeping sandbox; an unanswered one records nothing and is left to the agent's next inventory. The agent remembers every operation it has started for longer than Opengeni may resend a start for it, independent of output retention and across an in-place update, so a released operation never runs again. Connected Machine agents without the capability keep the existing final acknowledgement and later observation; a compute sandbox whose agent lacks it is refused as an image built with an older agent.
- 641e179: The agent now reports the operations it still runs or retains (a new `operation_inventory` agent event), on every connection and again while it holds completed output nobody released, and the API answers each page in that same exchange with the operations to end. Every OpStart carries the connection generation it was dispatched under, which the agent stores with the operation. A command decides by its custody: output Opengeni has not stored is never ended but collected while the agent is talking, and stored output is ended and its release recorded. Work without a command, such as a command deleted with its chat, is ended when it started under an earlier connection generation and is otherwise kept, never ended for its age. So a runner process that comes back after another process took its connection no longer keeps running commands Opengeni already settled, and output whose storing process died is recovered by the agent itself. The agent starts every such exchange, so a sleeping compute sandbox is never woken for it. Agents that do not send the event keep the earlier behaviour.

### Patch Changes

- 641e179: Stopping a background command on a Connected Machine or compute sandbox now sends
  the cancellation to the runner at once instead of waiting for the next maintenance
  pass, so the process ends within moments of Stop. Stop answers within its five-second
  budget; the reconciler still delivers the cancellation when that attempt fails, and
  the runner's pushed exit settles the command. A stop to a compute sandbox that no
  host currently serves wakes the sandbox, as any other request to it does.
- 7dcb1d5: Making room on a full browser controller is now safer. A browser is saved to make room only if it is still idle, active on the same controller and free of other operations at the moment it is claimed, and a browser another request already saved no longer counts as room made. A failure while preparing the save returns the browser to active instead of leaving it stuck suspending. Downloads kept when any browser is saved stay private to the owner of a private chat instead of becoming workspace files, even when another person's request made the room, and are read back as that owner once the request is authorized for the chat. Keeping downloads no longer risks the save expiring before capture. The memory-based browser limit now honours memory limits on the controller's own nested cgroup and its ancestors, wherever the cgroup hierarchy is mounted.
- 93e20fe: Redeeming a Codex rate-limit reset credit now restarts chats waiting for that account within seconds. The stored usage windows read before the reset are invalidated along with the stored exhaustion deadline, so a woken waiter places on the account instead of waiting again until the old weekly reset; it no longer depends on a later live usage read.
- 507caf7: Deleting a workspace that holds a connection no longer fails with "connection owner authority is immutable" on databases where PostgreSQL happens to fire the connection's origin foreign key action before the workspace cascade. The origin foreign key now cascades like the workspace one, and a connection's owner authority and origin stay immutable.
- b8d5b64: A machine's browser limit now follows its memory instead of a flat 64: half of the machine's memory (or its container's limit) at 300 MiB per browser, never under 8, so a 48 GiB machine runs 81 browsers and an 86 GiB one 147. `OPENGENI_BROWSERD_MAX_SESSIONS` still overrides it. When a new browser would exceed the limit, the least recently used browser that has been idle for at least five minutes is saved and stopped to make room; it resumes from its saved working copy the next time it is opened. Nothing changes below the limit.
- a336e51: Keep session title generation independent of conversation handover. Steer and cancellation no longer wait for a title or cancel it; a durable metadata operation retains the accepted provider account, request custody, usage accounting and human-title precedence across recovery.
- 523bac6: Clear a Connected Machine session's saved working directory when it is the filesystem root `/` or a Windows `System32` service launch directory left by older agents, so attachments, tool results and generated images work again in those chats. A filesystem or drive root, or anything inside the Windows directory, is never used as a working directory; the machine's reported root applies instead. The agent also moves out of the Windows system directory into the user's home, as it already did for a filesystem root.
- 47eeb80: Site and console chat turns now use the same native authority, tools and execution settings. Remove automatic Site-agent restrictions and forced member profiles; retain normal access checks, approvals and outside-workspace visitor identities. Existing saved member settings and accepted turns are not rewritten. Site authors can explicitly choose narrower ordinary chat settings.
- 78bd3fd: Acquire canonical lifecycle parent locks before reserving image operations and artifacts, preventing foreign-key lock-order deadlocks with turn settlement regardless of catalog trigger order.
- 32c356f: Avoid capability-row writes for subscription administration checks, allowance state reads, and existing task-budget reads. Coalesce API-key last-use telemetry without caching authorization, and schedule allowance maintenance from actual deadlines and membership changes instead of repeatedly rewriting idle workspaces. Preserve live revocation, usage accounting, and mutation fences.
- 184167c: A forked chat is now the same agent as the one it was forked from. Forks keep the source's connector and built-in tool selection and tool policy, agent configuration, model and execution settings, instructions, provider account authority, code search, Memory and agent access settings and session MCP servers, instead of starting with no tools and default settings. Only the fork's identity, owner, audience, history and runtime state are its own; when someone else forks a chat, it binds to them and leaves out the MCP server credentials the original creator supplied.
- 6c603cb: A forked chat runs on the same Connected Machine and working directory as the chat it was forked from, when the person forking may use that machine, so its first message no longer fails with an internal sandbox error. Someone else's personal machine is never carried over, and a personal machine still asks its owner for approval in the fork just as it does in any other chat. A chat that runs on Connected Machines but has no machine selected, on a deployment without a managed sandbox, now says so and asks for a machine instead of failing with "no agentId bound".
- fd7e63f: A forked chat now gets its own workflow identity, the same as every newly created chat, so its agent can wait for input and be woken on schedule instead of failing with "has no Temporal workflow identity". Existing forks without one are repaired by the migration.
- ac63730: Settle an interrupted agent update when a replacement process starts without an updater receipt, including manual installations. Preserve the distinction between the installed version and a proven successful automatic update.
- daec93b: Restore background maintenance when the migration owner cannot bypass FORCE RLS.
  Keep due checks read-only using transactionally maintained private predicate
  indexes, and admit fixed claim/reaper bodies with narrowly scoped private
  capabilities. Exercise real PostgreSQL maintenance lifecycles with a
  NOSUPERUSER/NOBYPASSRLS migration owner. Migrations 0848–0849 require a maintenance
  rollout because the runtime helper/grant posture contract changes.
- Updated dependencies [c27cffc]
- Updated dependencies [93e20fe]
- Updated dependencies [641e179]
- Updated dependencies [e018445]
- Updated dependencies [5715a3e]
- Updated dependencies [47eeb80]
- Updated dependencies [25c316a]
  - @opengeni/codemode@4.2.0
  - @opengeni/subscriptions@4.2.0
  - @opengeni/contracts@4.2.0
  - @opengeni/config@4.2.0
  - @opengeni/observability@4.2.0
  - @opengeni/codex@4.2.0
  - @opengeni/network@4.2.0
  - @opengeni/xai-subscription@4.2.0

## 4.1.3

### Patch Changes

- 175f595: Treat enrollment lookups in deleted workspaces as missing grants so credential renewal returns the existing reconnect-required response instead of an internal error. Preserve genuine database and tenant-scope failures.
  - @opengeni/codemode@4.1.2
  - @opengeni/codex@4.1.2
  - @opengeni/config@4.1.2
  - @opengeni/contracts@4.1.2
  - @opengeni/network@4.1.2
  - @opengeni/observability@4.1.2
  - @opengeni/subscriptions@4.1.2
  - @opengeni/xai-subscription@4.1.2

## 4.1.1

### Patch Changes

- a254a76: Read execution-time provider catalog inputs in one scoped transaction instead of repeating serial catalog and connection-list queries. Turn startup and stateless model calls share the same settings-building path. Catalog ordering, retained-model handling, live workspace credential checks and selected model policy remain unchanged; no data is cached across executions.
- 7837e4f: Use indexed turn lookups when checking the provenance of delivered session updates, preserving exact UUID matching and all existing authority checks.
- 57e3a3e: Expose actionable Connected Machine credential-expiration diagnostics without overriding live runner authority. The matching native agent pauses refused transport credentials, renews recoverable grants, and persists reconnect-required state only after an explicit permanent renewal denial. Deploy the API and release the updated agent for the complete recovery behavior.
- f20f60c: Retry transient database connection admission with bounded jittered backoff and
  recover running turns after PostgreSQL refuses connections with SQLSTATE 53300.
  Never replay entered callbacks or uncertain commits, and keep permanent data and
  authentication errors non-retryable. Existing error messages remain unchanged.
- 9be9a82: Steer reaches the agent within seconds and no longer kills work in progress. A model request still generating when a Steer arrives is cut short: assistant messages the provider had completed stay in history, unfinished text and unstarted tool calls are dropped, and the next request carries the Steer on the unchanged history. Short tool calls finish; long `exec_command`/`write_stdin`, `command_wait`/`command_read` and `session_wait` waits return early with their handle while the work keeps running (`session_wait` reports kind `steer`). The turn then hands over (`turn.superseded` with reason `steer`, `atModelStep: true` and, for a cut-off answer, `cutOffText`) and the Steer runs next. Several Steers are read together, in the order they were sent. Agent Steer (`session_steer`) behaves the same way. Queue (an ordinary Send) is unchanged and still runs after the whole turn. Custom model transports can honour preemption with the exported `isModelPreempted` and `preemptedResponseDone`.

  The web and React Native session screens show a Steer only as the person's message: no status row, chip or "Send now". API callers can still stop the running attempt with `interrupt: true` on `steerQueueItem` on the turn that `steerMessage` returned. A new workspace setting `busySend` (`queue` by default, or `steer`) and a matching `busySend` option on `useComposer`, `SessionConversation` composer options and `useOpenGeniNativeSession` let a product make a normal Send act as Steer while the agent is busy; Cmd/Ctrl+Enter then does the other one.

- Updated dependencies [afff3f9]
- Updated dependencies [84688e2]
- Updated dependencies [cf899f4]
- Updated dependencies [e4e30b8]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/contracts@4.1.0
  - @opengeni/codex@4.1.0
  - @opengeni/config@4.1.0
  - @opengeni/codemode@4.1.0
  - @opengeni/observability@4.1.0
  - @opengeni/network@4.1.0
  - @opengeni/subscriptions@4.1.0
  - @opengeni/xai-subscription@4.1.0

## 4.0.4

### Patch Changes

- fb0a25f: Materialize RLS-authorized child metadata once for session list totals so deep trees do not rescan the sessions table at each recursive step. Preserve exact-target scope, private visibility and existing scan budgets.
- b5fe653: A browser that was marked lost because its suspension found the controller had restarted can now be resumed from its preserved working copy. The resume continues the same browser and profile on the generation that owns that copy, instead of refusing the browser forever. If the copy can't be continued, resume says so plainly and leaves the browser lost; it never silently rolls back to an older checkpoint.
- 1e2ebb6: A browser resume that fails before its controller is dispatched (for example because the browser's machine is offline or the task moved to another machine) now returns the browser to suspended. Previously the browser stayed in restoring indefinitely and every later resume was refused.
- e428801: Completed browser downloads stay saveable after the browser is suspended. Suspension removes the browser's working directory, so before an explicit suspend or an automatic idle or deadline save, each completed download is now kept as a workspace file. Listing, reading and saving a download then work while the browser is suspended, after it resumes on a new controller, and after the task moves to another machine, which imports the file from storage. A download that cannot be kept is logged and never blocks the suspension.
- 327d53a: Writes to sessions, turns and their update carriers run less trigger work. The MCP account binding fence no longer converts both row versions to JSON and re-validates unchanged bindings on every update: a trigger condition now runs it only when bindings, delegations or session visibility change, and inserts keep the unconditional check. The session tenancy fence reads the row's workspace column directly instead of converting the whole row to JSON. Behaviour and error messages are unchanged.
- 9482fe0: Report observed command-scope cleanup of background child processes with an
  append-only result notice, preserving structured output and process containment.
- 2708a32: Settle Connected Machine background commands promptly from authenticated runner
  completion events after verified output capture, with retained notification replay
  across reconnects, independent liveness capacity, shared race-safe settlement,
  reconciliation as fallback and independently retryable output release. Delivery-only
  receipts stop redundant notifications without releasing output; failed collection
  retains reconciliation backoff rather than replaying on every notification.
- f2d5d8b: Session list, policy, wait, tree-stats, control-plane and content-blob reads now bind their variable id lists as one array parameter (`= any($n::uuid[])`) instead of one parameter per id. Each list length used to be a distinct statement text that every database connection planned from scratch, which made planning a large share of database CPU; one statement per query now keeps a single reusable plan for any list length.
- 903a3f5: Id-list reads that receive exactly one id now compare it as a single value (`= $n`) instead of a one-element array. PostgreSQL costs the reusable plan of an array comparison for a several-element list, so for one id it kept choosing a fresh custom plan on every execution: the session lock reads on every event append were re-planned on 99% of calls. The single-value form gets an exact one-row reusable plan. Lists of any other length still bind as one array parameter.
- aeea237: Prepared statements on direct database connections now use Postgres's default plan cache mode instead of forcing a fresh plan on every execution. Planning a short statement under row-level security often costs far more than running it; repeated statements, and the statements inside database routines and triggers, now reuse a generic plan once Postgres finds it no costlier, which cuts database CPU substantially under load.
- 605af85: Database pools now hand each query to the connection that became idle most recently instead of the one idle longest. Rotating through every slot kept each pool at its maximum size forever, so every backend paid its own catalog and plan-cache warmup for every statement and held its own cache memory, even when only one or two queries were running. Work now stays on a small warm set of connections and the surplus closes after the existing idle timeout.
- d5b0003: Close session workflows after a verified worker-scoped deletion instead of polling forever. Preserve unavailable/RLS-hidden observations and legacy Temporal replay, and let idle/failure settlement, late dispatch recovery and input-wait settlement finish harmlessly when their session was deleted.
- 9cc3e18: Reading a session's effective model policy stays a single newest-first index probe under a generic prepared-statement plan. The started-turn check is now a scalar subquery the planner cannot flatten into a join; before, a generic plan could scan and sort every turn of the session, which took tens of milliseconds to seconds on a long session and slowed every session read.
- 4098e67: An agent now saves learning to the destination it explicitly chooses, in both directions: a shared chat can save the initiating person's own personal Skill, and a private chat can correct or add workspace Knowledge. Each change follows the stricter of the chat's and the destination's Agent learning mode, so Review first leaves a pending proposal and Off refuses it. Another person's Skill, a chat with no person to save for, and removing a Skill outside the chat's own learning scope stay refused.
- 62a3815: An agent in a private chat, or a chat using personal memory, can now save to the workspace when it explicitly chooses to: it can change an existing workspace Skill, create a Skill with scope `workspace`, or propose a workspace instruction. Previously both were refused, so a person's request to remember a workspace rule from a private chat was lost. Other learning from such a chat still saves only for that person.

  A workspace change from a personal chat follows the stricter of the chat's own Agent learning mode and the workspace's mode for that category, as of when the work was accepted. Off refuses it, and Review first leaves a pending proposal in workspace review. Permanently deleting a workspace Skill still needs a shared chat or a person. A shared chat still cannot choose a personal destination or change someone's personal Skill.

- 85889a5: Maintain hourly model-usage aggregates transactionally and backfill historical hours in independently committed batches. Insights usage reads aggregate complete hours and scan only ragged edges, preserving billing, visibility, filters and response semantics.
- eeab688: Preserve an accepted turn's Personal Knowledge scope when its chat is shared, including subscription failover and Retry. Keep its existing snapshot and owner authority, apply current settings to new turns, and explain genuinely incompatible scope changes without reopening the same failed turn.
- bf7a8f7: The sessions and session event cursor tables refresh their planner statistics after 50,000 changed rows instead of after a tenth of the table. On a busy deployment they were re-analyzed every few minutes, and each refresh made every connection re-plan its cached session queries. Vacuum cadence is unchanged.
- 0f1ea90: Insights usage and calls responses are cached again. The cache fence had switched to the database-wide visibility snapshot, which changes whenever any transaction anywhere commits, so repeated reads always recomputed. The fence now fingerprints the workspace's committed session activity, so it changes only when a session in that workspace is created, written or deleted.
- f010292: When an agent's Skill, workspace instruction or Knowledge save is refused, the chat now tells the person. A "Not saved to Skills" (or workspace instructions, or Knowledge) row appears beside the agent's reply and stays visible when the turn folds. It appears only for genuine refusals: Agent learning is off where the change would be saved, the chat isn't allowed to make the change, or the agent was started from a Site page. It says why in plain words and links to Agent learning settings or the item. Mistakes the agent can correct and retry itself, such as citing evidence the destination's readers can't see, show no row. Previously a refusal was visible only inside the folded tool call, so a request to remember something could be lost silently.

  The refusal travels as a content-free `_meta["opengeni/learningRefusal"]` fact on the tool result (destination, reason and the targeted Skill ID only), which the model never sees. New exports: `learningRefusalFromToolOutput` and the `LearningRefusal` type from `@opengeni/sdk/learning-refusal`; the full fact from `@opengeni/contracts/learning-refusal`; and `LearningRefusalActionsProvider` and `LearningRefusalPlace` from `@opengeni/react`, which let a host open the right page. `NoticeItem` gains an optional `learningRefusal`.

- c378f15: The background job that repairs missing per-call usage facts no longer runs for seconds per workspace and loads the database. Its lookup of existing facts now uses the full unique index under row-level security, about 50 times faster on a busy workspace.
- 47584d8: Each streamed model call now records how long it took: Opengeni's own work before dispatch, time to first token, time to first answer text and total duration, in milliseconds. The worker stores them on the call's usage event and its Insights fact (four nullable integer columns added without a table rewrite), so model speed and output tokens per second can be analysed per call later. Older calls and calls the worker did not stream stay unknown.
- 0eab0c8: Idempotent persistence transactions now retry briefly (after 250 ms, then 1 s) when Postgres reports a schema-change error such as an undefined operator or a changed column type. A migration that alters a column used inside a routine could otherwise fail turns that were saving events at that moment; those writes now succeed on the next attempt instead of failing the turn.
- c6be5c7: In-place PostgreSQL major upgrades no longer fail on the session tenancy fence registry, which stored its schema as a `regnamespace` column that `pg_upgrade` refuses. The registry now records the schema by name. The embedded-Postgres Helm upgrade also runs `pg_upgrade --check` against a schema-only copy of the running databases in a pre-upgrade hook, so an incompatible schema fails the release before the server is stopped.
- 7931f9c: Fix Connected Machine audience changes under least-privilege database ownership: keep the outer write capability across enrollment updates and include redacted private chats in the bounded audience preview.
- 79ec9fd: Let a machine owner move a running chat to their personal Connected Machine. Record the click as consent for the current logical turn, retain it across replacement attempts, and recheck ownership and access before each operation without exposing other personal machines or resources. Remove the obsolete busy-chat refusal.
- 40b175f: Stamp session activity with transaction IDs instead of serializing new writers on a workspace counter. Preserve gap-free, at-least-once incremental monitoring with snapshot xmin watermarks, restart legacy cursors conservatively, and retain the old database gate during rolling upgrades.
- 6384b14: Subscription runtime capability rows no longer leak when a database connection closes. Each grant now also removes a few rows left by transactions that have already ended, in any connection, without waiting on other grants. The migration empties the table once, which also releases its accumulated storage; when the table stays busy it deletes the finished rows instead, so a busy database never fails the deploy.
- a34aebb: Responses WebSocket requests continue the previous response on the same connection: when a request extends the last completed response exactly, it sends `previous_response_id` and only the new input items, and falls back to the full request otherwise or when the provider no longer holds that response. The transport now serves the OpenAI API (`/v1/responses`) and Azure OpenAI's v1 API (`/openai/v1/responses`) as well as the Codex subscription, with one connection per conversation (`OPENGENI_OPENAI_RESPONSES_WEBSOCKET_ENABLED`, default on). Other OpenAI-compatible hosts stay on HTTP. Each request's transport label and the model-request phase metrics say whether the input was full or incremental.

  Share lifecycle and failure policy in the network package. Use the JavaScript WebSocket implementation to release sent buffers, retain only continuation fingerprints, coalesce concurrent handshakes, and retire idle connections when credentials change. The existing durable model-step retry budget owns dropped responses; its final retry uses HTTP, with no additional retry budget or timer-based cooldown. HTTP remains selected through turn recovery and subsequent successful steps, but a new turn tries the socket again. Definitive continuation refusal settles and re-admits request custody before a full-input resend. Transport diagnostics distinguish first-request cache behavior and final-prefix startup overlap; no speculative model prewarm is sent.

- ff38f1d: A full workspace image quota no longer drops new images, and claims that keep failing no longer starve expiry. A full batch of failing cleanup claims was reclaimed first on every sweep, so nothing behind it expired. Fresh work is now claimed before failed claims are retried. When the quota is full, the workspace's oldest images are queued for cleanup to make room for the new one. Only an image larger than the whole quota is still refused.
- 5632ffc: Expired screenshots from private chats are reaped again, releasing workspace screenshot quota, and a screenshot that is no longer retained no longer fails every later turn of its session: it reaches the model as the same neutral image receipt used for withheld images.
- 790ac6e: Stop browsers and Desktops a task leaves running on a Connected Machine it moved away from. Retiring a browser now also stops one that an agent restart left running detached (its profile and downloads stay on disk) and every later request that notices the move retries earlier retirements of that task's browsers and Desktops that found the machine offline or refusing.
- 3e061d6: Preserve default-following tool selection in schedules while retaining explicit choices and permission limits. Route ordinary notifications to the human whose authority the calling turn uses, including scheduled turns in an existing chat.
- 9c61ebd: The statistics-cadence migration for the sessions and session event cursor tables now applies to whichever schema the database is installed in. It previously named the public schema, so installs into a dedicated schema failed to migrate.
- cc182c7: Archiving a very long idle session no longer slows down page by page. The export reads under row-level security, where PostgreSQL only uses leakproof comparisons as index conditions. Numeric and row comparisons are not leakproof, and a multi-column cursor only bounds its first column, so every page of model history re-filtered all earlier rows (3.8 seconds per 200 rows at row 40,000 on staging) and the largest sessions ran past the archive activity limit. Tables ordered by several keys or a numeric key now read their ordered row ids once and fetch each page by primary key (about 5 seconds for the id list plus 60 ms per page for a 52,000-item session). Events, machine inputs and content blobs page by a single key on a unique `(workspace_id, session_id, key)` index. No migration is needed.
- a312aaf: Creating a session no longer fails when the accounts it copies from its parent turn include a shared workspace account that was disconnected, needs reauthorization or was reconnected since. The new session runs without that connector, as the parent's own turn already does, and keeps every other account. Previously every agent-spawned session from such a parent was refused until the account was restored.
- 6e15cfe: Two frequent session history reads now cost what they need instead of the whole transcript. Checking whether a session has used the tool router is a lookup in a small partial index instead of parsing every history item of sessions that never used it. Clearing finished tool calls reads the turn newest-first and stops once the just-finished calls are proven durable, instead of loading every item of the turn after each tool batch.
- 2072131: Session list totals and per-root tree stats do less database work per poll. Totals now walk each listed root's descendants through the parent index instead of reading every session in the workspace, and only join the needs-you set when that filter is on. Tree stats read each descendant's personal state once and carry the columns they need through the walk, instead of re-reading the session, its pin row three times and a cycle probe per descendant.
- a2a47b3: Session lists no longer slow down as interruption history grows. The "stopping" summaries for interrupted attempts and stopping background commands now start from the small set of still-open work (a new partial index on interruptions, kept exact by a trigger-maintained quiescence hint) and walk up to the requested sessions, instead of scanning every interruption in the workspace or walking every requested subtree.
- 0c82106: Reads of many rows from one session no longer scan every session in the workspace to check visibility. The session visibility check on session child tables could be planned as a hashed scan of all visible sessions, costing tens of milliseconds per statement on a busy workspace; it now always probes the session by key for the rows actually read.
- e47c979: Reading session events, history items, turns and other per-session rows no longer spends most of its database time on row-level security. Each row's session visibility check used to start a separate function executor and call several security-definer helpers, and private sessions opened a subtransaction per row. The check now runs inline, cheap conditions decide first, and the acting human's private-session memberships are resolved once per statement. Who can see what is unchanged. Reading 3,000 events of a private session dropped from about 470 ms to about 45 ms, and listing 7,000 sessions from about 255 ms to about 35 ms.
- ba9ff31: Browsers and Desktop sessions no longer keep running on a Connected Machine after the task that opened them moves to another machine. When such a session is marked lost, the server now reaches the former machine directly (with the owner's access, as any end does), ends that exact controller generation while keeping its on-disk state, and only then releases the record's controller binding; the session stays `lost`. Ending a lost session also stops it on the former machine first, instead of failing with a placement error and leaving its processes behind. If the machine is offline, nothing is released and the end explains that it can be retried once the machine is back.
- eaf6de4: Subscription authorization costs what one check costs. Policies that let organization administrators manage subscription connections now ask the administrator check once per statement instead of once per row, with the same answers. Turn-scoped subscription capability rows are reclaimed when their backend next grants one, so the capability table no longer grows with every accepted turn; rows left by finished transactions are purged once.
- 7b7b2b5: A recovering turn now honors its retry backoff: the deadline is stored on the turn and armed as a delayed wake, so the session's own wakes no longer cut it short and only new user input ends it early. A required MCP server that answers 503 (for example during a deployment) is waited out for up to ten minutes instead of using up the five quick retries.
- 23fc624: Recording model usage no longer slows down as a turn grows. The duplicate-usage check now reads a plain, trigger-filled `usage_source_key` column through a new partial index instead of a payload expression that row-level security prevented from using its index, so each usage append no longer re-reads every earlier usage event of its turn.
- 9ddadf6: Codemode calls and other reads of a turn's tool catalog no longer reload and re-verify the whole catalog every time. A catalog can be hundreds of tools and megabytes of JSON, and every Codemode call read it twice, once while holding the turn's admission lock. Verified catalogs are now kept in memory per server process, bounded by size, and each read still checks the stored row first, so access rules are unchanged.
- Updated dependencies [e7113e3]
- Updated dependencies [35dcfa0]
- Updated dependencies [26b4c24]
- Updated dependencies [958d157]
- Updated dependencies [b4a3b7f]
- Updated dependencies [88459ff]
- Updated dependencies [2f6b8bd]
- Updated dependencies [9482fe0]
- Updated dependencies [08a7a88]
- Updated dependencies [2a81601]
- Updated dependencies [b1b51e2]
- Updated dependencies [71dfe30]
- Updated dependencies [f010292]
- Updated dependencies [9fb9db3]
- Updated dependencies [6f005fa]
- Updated dependencies [b1c5753]
- Updated dependencies [79ec9fd]
- Updated dependencies [1d24639]
- Updated dependencies [7bac0d9]
- Updated dependencies [a34aebb]
- Updated dependencies [5927aae]
- Updated dependencies [6ab7b55]
- Updated dependencies [3e061d6]
- Updated dependencies [a22ed79]
- Updated dependencies [0ce7609]
- Updated dependencies [9ddadf6]
  - @opengeni/contracts@4.0.0
  - @opengeni/network@4.0.0
  - @opengeni/codemode@4.0.0
  - @opengeni/codex@4.0.0
  - @opengeni/observability@4.0.0
  - @opengeni/config@4.0.0
  - @opengeni/xai-subscription@4.0.0
  - @opengeni/subscriptions@4.0.0

## 3.4.0

### Minor Changes

- c594c1d: The session list can show only your workstreams. `mineOnly=true` (with `view=page`; SDK `listSessionPage`/`listSessionSummaryPage` `mineOnly`, React `useWorkspaceSessions` `mineOnly`) keeps a workstream when any session in its tree was created by you or received a message you sent directly; agent-relayed messages and service turns do not count. Matching roots list their children in full, totals follow the filter, and the response echoes `mineOnly: true`. The web sidebar's view menu adds an "Only mine" option. A new online index (`session_turns_human_prompt_subject_idx`, built concurrently in rolling migration 0799) keeps the probe to one index lookup per tree session.
- 7998676: Add an inert subscription-plan catalog, organization plan state, non-rollover period credit accounting, and database-enforced human seat caps. Expose optional plan funding and seat information in billing balances without enrolling existing organizations.

### Patch Changes

- ceaf911: Browsers: a browser whose working directory was copied or restored (for example after a machine's disk was replaced) can now be continued from that copy instead of staying unavailable. `inspectBrowserSessionWorkingCopy` reports why the copy is refused and, when it can be adopted, the exact digest of its bytes; `adoptBrowserSessionWorkingCopy` adopts exactly those bytes under the browser's existing control authority, and `getBrowserSessionWorkingCopyAdoption` reports an adoption's recorded outcome, without changing it, when a reply was lost; retrying the same adoption settles one that stopped part way and never repeats a step. How recent the copy is stays explicitly unknown. Only controller-owned derived entries are left out of the copy, and inspection lists them. An adopted copy is never replaced by an older checkpoint afterwards, the directory it replaced is kept, and every step is journaled so a crash at any point is finished or reported, never guessed. Supported on Linux machines only for now. When a preserved browser is refused, its error now says why and what to do next.
- acc2718: Preserve the caller's actor scope while building a capability catalog inside a transaction, so prepared MCP setup persists its replay receipt. Roll back completion writes if the receipt cannot be saved instead of reporting success.
- 2f370c3: Direct database connections now use named prepared statements. Before, every parameterized query was sent unprepared, so it cost two round trips (postgres-js waits for a Describe reply before it can bind) and Postgres parsed and planned it again each time. Pools now prepare by default, except when the URL targets port 6432 (PgBouncer, including Azure Flexible Server's built-in pooler). Set `OPENGENI_DATABASE_PREPARED_STATEMENTS=false` for any other transaction-pooling proxy.
- 960fea8: A first-party MCP tool listing reads its tool surface (workspace settings, model catalog, Memory selector and admin access) together and alongside the bound-session check, and an agent attempt's learning policy alongside its liveness check. Authorization still decides before anything is disclosed. The listing now waits on two rounds of database reads instead of nine, and no longer reads the workspace's control state and kind.
- cac0334: Scoped database work makes fewer round trips to PostgreSQL. Each tenant-scoped transaction used to look up the workspace's account, then set the tenant, subject and actor settings, read them back and take its advisory locks in separate statements, about nine sequential round trips for a single read. One statement now resolves the account, applies every setting, takes the locks in the same order and reads the result back, so a standalone scoped read is BEGIN, setup, query and COMMIT. Isolation, lock order, nested-scope restore and the fail-loud checks are unchanged.
- 33bf04d: Migrations now apply to a fresh PostgreSQL 18 database. PostgreSQL 18 records column NOT NULL constraints in `pg_constraint`, which made two historical migrations fail on a new install: 0345's tenancy-fence drift check and 0598's Claude pool table copy. Both now skip those rows; databases that already ran them are unaffected.
- ab48465: Preserve deployed migration hashes while adapting two historical constraint-catalog reads for PostgreSQL 18 in the migration runner.
- 8d93488: Session authorization reads everything it needs in one database round trip. Authorizing an agent's action on its own session used to make five sequential scoped reads (Slack ownership, the session's authority, the full caller session with its event cursor and connector metadata, the live attempt's turn with its goal snapshot, and the target identity), about 37 statements. One scoped statement now returns the target's authority and Slack ownership together with the caller session and its live attempt turn, so the check is BEGIN, setup, read and COMMIT. Every fact comes from the same snapshot and the same RLS visibility, and every denial (missing or hidden target, stale or forged attempt, ended attempt, revoked linked authority, Slack-private ownership, private sessions, cross-tree reach and host decisions) is decided exactly as before.
- 7998676: Bind subscription upgrade, downgrade and cancellation requests to durable organization-scoped intent and result receipts before Stripe mutations. Preserve original targets across database rollback, replacement subscriptions and provider idempotency-key expiry. Refund duplicate subscription funding according to payment timestamps rather than invoice creation time.
- 8053c9b: A Connected Machine that stops answering in the middle of a command now fails only that command. Previously the turn could not finish: it kept trying to cancel the command on the unreachable machine until the worker's quiescence watchdog drained the whole worker, ending the turn and every other turn on it. The command is now recorded in the session's command ledger with a stop request, the turn finishes normally, and the reconciler stops or settles the command when the machine returns or its runner is retired. The error the model sees is unchanged, and the later stop adds no model input. If the ledger cannot record the command, the turn keeps ownership as before.
- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
- Updated dependencies [42caae1]
- Updated dependencies [2f370c3]
- Updated dependencies [c594c1d]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/contracts@3.4.0
  - @opengeni/codex@3.4.0
  - @opengeni/config@3.4.0
  - @opengeni/codemode@3.4.0
  - @opengeni/observability@3.4.0
  - @opengeni/network@3.4.0
  - @opengeni/subscriptions@3.4.0
  - @opengeni/xai-subscription@3.4.0

## 3.3.0

### Patch Changes

- 38ac98e: Run Site AI privately per viewer through native sessions, with optional headless
  inline results and app-defined prompts. Keep app work out of ordinary workspace
  discovery, preserve native permissions and accounting, and expose private-safe
  per-Site AI costs and separate platform metrics in Insights. Usage retains limits.
- Updated dependencies [38ac98e]
  - @opengeni/contracts@3.3.0
  - @opengeni/codemode@3.3.0
  - @opengeni/codex@3.3.0
  - @opengeni/config@3.3.0
  - @opengeni/observability@3.3.0
  - @opengeni/network@3.3.0
  - @opengeni/subscriptions@3.3.0
  - @opengeni/xai-subscription@3.3.0

## 3.2.2

### Minor Changes

- a0c35a1: Linked vaults accept the external, Proton Pass, Keeper and Bitwarden sources (migration 0789). Linking checks the connection's provider identity, active and verified status and ownership in the database: a personal connection backs only its owner's Only-me vaults, and a shared connection only vaults of its own ownership. Vaults record the provider's effective operations, its own freshness observation and a durable cache epoch that every complete mirror replacement advances.

  A mirror is replaced only by a complete inventory of at most 2,000 items; otherwise the previous mirror is kept and the failure recorded. Refreshes never bypass an active provider rate limit, even when forced, and record operations and freshness even when nothing changed. `secret_search` accepts `refresh` (first page only) and reports `complete` and the checked `sources` on every page, so an unavailable provider is never shown as an empty healthy vault. A reference that misses while a relevant connected vault could not be checked fails with that provider's error instead of a missing-secret ask card; explicitly named healthy or hosted vaults are unaffected. Vault summaries include `providerOperations` and `freshness`.

  Connected-vault writes check the vault's effective operations (item type, field removal, one-time passwords, files, archive) before any value is resolved or generated. Permanent deletion, restore and field-history restore are refused for connected items. A move out of a connected vault needs a recoverable archive and archives the original only after the target confirmed the write. An unconfirmed provider write is reported as `provider_outcome_unknown` and never retried; a confirmed write that cannot be listed yet is reported as saved (`provider_inventory_incomplete` with `details.saved`).

### Patch Changes

- 5af5889: Sandbox: on Modal, a chat whose sandbox setup was cut off mid-start no longer keeps an unused sandbox running for up to a day. After the idle grace the workspace is saved, the sandbox is stopped, and the chat resumes on the saved workspace. A sandbox that was already shutting down is now also saved before its provider deadline instead of being stopped without a save, which previously made the resumed chat fail.
- a0c35a1: Overlapping syncs of one connected vault now replace its mirror one at a time. The mirror replacement takes the vault row lock before it reads the mirror, so an older listing can no longer re-add an item that a newer one removed while the newer content version is recorded, which also stopped later unchanged syncs from repairing it.

  A reference that finds nothing now refreshes every connected vault that could change the answer: those at or above the priority tier that matched. A hosted workspace item without a one-time password no longer stops a stale Only-me connected vault from being refreshed, so `Item/otp` resolves once that provider has the one-time password, or reports the provider as unavailable, rate limited or needing reconnection instead of asking for the secret. A lower-priority connected vault that is down no longer turns a miss decided by a higher tier into an unchecked one.

- a0c35a1: Settle connected-vault inventory and status together against the cache epoch read before provider I/O. A late overlapping refresh cannot overwrite another completed check, including unchanged checks and failures. Superseded refreshes are not replayed; reference resolution rereads the settled inventory.

  Preflight managed 1Password creation through the exact local link checks, rolling back all local trial effects before provider I/O. Predictable name, quota and authority refusals create nothing upstream. If a race or a later step fails after confirmed creation, return the existing provider vault identity and link/refresh recovery guidance instead of inviting another create. Failed group grants retain the created identity and still link the vault; unknown creates are never automatically retried. No destructive compensation or exactly-once guarantee is introduced.

- Updated dependencies [7e50b4a]
- Updated dependencies [a0c35a1]
  - @opengeni/config@3.2.0
  - @opengeni/contracts@3.2.0
  - @opengeni/codemode@3.2.0
  - @opengeni/codex@3.2.0
  - @opengeni/observability@3.2.0
  - @opengeni/network@3.2.0
  - @opengeni/subscriptions@3.2.0
  - @opengeni/xai-subscription@3.2.0

## 3.1.2

### Patch Changes

- 17d61c6: Schedules no longer stay stuck without anyone knowing. When no later run can start until a person acts (its chat is paused or gone, a pinned account or machine is unavailable, or the run is refused for good), the schedule pauses itself and its owner gets one inbox notice saying why and what would unblock it. When runs keep failing or being skipped for a reason that may clear by itself, the owner is told once after three in a row. The notice goes away when a run succeeds or the schedule is resumed, paused or deleted, and the schedule page and API show the current blocker.
- 2bdc71f: Resuming a browser whose earlier resume expired now continues it from its retained working copy instead of failing with an internal error. The continuation kept its controller authority alive by checking an operation that is only recorded after the controller adopts the working copy, so every such resume stopped before reaching the controller. It now checks the expired resume itself: the browser must still be lost from that resume and still be bound to the same controller generation.
- 0bdb953: Photo-heavy chats no longer compact over and over. After compaction only the newest user message that has attachments keeps its images inline; photos of older retained messages move to the dated attachment catalog, where the agent can reopen them, and those messages are charged only for their text. Newly sent photos are shown to every model at most 2000 px on the longest side (the file itself stays full resolution, and the receipt says so); photos sent before this change keep their original projection, so requests already sent are unchanged. The local image token estimate now prices images by the patches they cover at the sent resolution, so a full-resolution phone photo counts as about 15k tokens instead of 765.
- 86df483: Streamed text deltas are now merged when they are written instead of folded afterwards. The turn writer flushes model fragments at most 100 ms apart, sends the first fragment of each item at once, and stores each flush's adjacent plain text fragments as one `session_events` row, so a stream writes about a fifth of the rows it used to and nothing is deleted later. The settled-turn folding pass and its `foldSessionTurnDeltas`, `listSessionDeltaFoldCandidates` and `unfoldSessionEventDeltas` helpers are removed; rows folded by earlier versions stay readable through `coalescedUntil`.

  Reasoning summary parts keep their paragraph breaks wherever fragments are merged: `@opengeni/events` exports `reasoningDeltaSeparator`, and the read-side coalescer now uses it, so consecutive bold headings no longer render glued together after a reload.

- Updated dependencies [17d61c6]
- Updated dependencies [0b164a9]
- Updated dependencies [99d545d]
- Updated dependencies [1e67711]
- Updated dependencies [0bdb953]
- Updated dependencies [79af429]
- Updated dependencies [877c70d]
  - @opengeni/contracts@3.1.0
  - @opengeni/observability@3.1.0
  - @opengeni/codemode@3.1.0
  - @opengeni/codex@3.1.0
  - @opengeni/config@3.1.0
  - @opengeni/network@3.1.0
  - @opengeni/subscriptions@3.1.0
  - @opengeni/xai-subscription@3.1.0

## 3.0.0

### Minor Changes

- 03ff7a1: Forking a chat at a message from before a later compaction or context clear now works. The fork gets the history the model had when that message was written, instead of being refused. Every context reset deactivates all rows and appends its new segment after them, so the live history at a message is the latest segment starting at or before it, through the message. Superseded rows stay retained and are copied back as live rows. Rolling migration 0778 rewrites `fork_session_content` to find that segment:

  - for a clear, from its marker position;
  - for a compaction, from its new `replacementFromPosition` receipt field, which compaction now records;
  - for older compaction receipts, from the replacement rows written in the summary's own transaction.

  A user message's boundary is its turn's first user row, never a later user row or summary from the same turn. The fork fails closed whenever the retained rows can't prove that history.

- db3efc5: Sites can now be published to the web. A Site's owner or a workspace admin can give it its own address under the deployment's Sites domain (for example `team-crm-4k9x.opengeni.site`) and choose who can open it: workspace members, invited people who sign in with their email, or anyone, with anonymous visitors as guests. Published Sites keep their Site Data and embedded agent, but their direct tool calls return 403 (tools need a person's session in the console), and only a workspace admin can give the embedded agent workspace tools (guests get them only with `agent.guestTools`). Site code reads the viewer with `site.viewer` and starts sign-in with `site.auth.signIn()`, and no Opengeni credential reaches the Site. Collections gain a guest rule (`none`, `read`, `append`, `own`). Embedded agent use is paid by the organization under a limit profile (free, credits, unlimited or custom) per workspace and per Site. Visitors can report a Site, and managers can take it down and restore it. Breaking: Site HTTP is limited to an explicit operation allowlist (`SITE_OPERATIONS`) in every host, so a console Site that called other API routes through the bridge is now refused; an agent started from a Site page may send workspace API writes only to its tools, its conversations, files and content, and other writes return 403. The SDK adds `getSitePublication`, `updateSitePublication`, `unpublishSite`, `checkSiteHostname`, `takeDownSite`, `restoreSite`, `listSiteAbuseReports`, `updateSiteAbuseReport`, `getSiteLimitProfile`, `updateSiteLimitProfile` and `authorizeSiteViewer`; `ArtifactSandbox` and `SiteView` accept a `viewer`; agents get `site_publication_get`, `site_publication_update` and `site_hostname_check`. Publishing is off until `OPENGENI_SITES_DOMAIN` is set.
- 957f6ee: Sites can have their own SQL database. Where a deployment turns on Cloudflare storage (`OPENGENI_SITES_CLOUDFLARE_STORAGE_ENABLED`, `OPENGENI_SITES_GATEWAY_INTERNAL_ORIGIN` and the gateway secret), a Site's owner can enable a per-Site SQLite database, one Durable Object per Site in the Sites gateway, next to Site Data. Agents define schema migrations and named queries with the new `site_sql_*` tools (`site_sql_inspect`, `site_sql_enable`, `site_sql_migrate`, `site_sql_define_query`, `site_sql_query`, `site_sql_run`, `site_sql_execute`, `site_sql_export`, `site_sql_import`, `site_sql_reset`), and Site code runs those queries with `site.sql.run(name, params)` from `@opengeni/sdk/site`. Sites never send SQL; each query has an audience (`everyone`, `signed_in` or `managers`), and `:viewer` is bound from the verified viewer. Statements are checked against an allowlist (one statement per named query; no ATTACH, VACUUM, extensions or PRAGMA writes; no recursion in named queries; no reserved `_cf_`/`_og_` names, even as string literals; schema changes only through migrations), results are bounded, unique and primary-key violations return `conflict`, and rows read, rows written and storage are metered in `usage_only` mode under the Site's limit profile (`OPENGENI_SITES_SQL_*` settings). Data can always be exported as SQL, CSV or JSON, in pieces with a cursor for large databases (`exportSiteSql` takes `cursor` and `maxBytes` and returns `nextCursor`); export, inspect and dropping a database keep working after the flag is turned off while the gateway stays configured. `signed_in` queries need a viewer signed in as a person, guests' write queries count against the Site's guest write limit, and only Site page calls count toward the monthly caps. An agent started from a Site page gets the page's reach: it cannot manage Site SQL and `site_sql_run` runs only the named queries the page itself could run. Postgres keeps the settings, migrations and queries in new FORCE-RLS `site_sql_*` tables so a database can be rebuilt. The SDK client adds `getSiteSql`, `updateSiteSqlSettings`, `migrateSiteSql`, `defineSiteSqlQuery`, `deleteSiteSqlQuery`, `runSiteSqlQuery`, `querySiteSql`, `executeSiteSql`, `inspectSiteSql`, `exportSiteSql`, `importSiteSql` and `resetSiteSql`. Without the settings nothing changes.
- 6339cec: Published Site limits now follow the viewer. Workspace members have no Site caps, only the flood brakes, and keep the embedded agent even when it is off for everyone else. Invited and signed-in people share one Site spend limit ($10 a month by default, or a daily limit) with an optional per-person limit; guests also meet the bot guards (20 conversations per visitor per day, 500 per Site per day, 50 turns and $1 per conversation). Workspace tools reach only members who may use connections, and outsiders never get a subscription-billed model: they use the workspace's credit-billed default or are refused. Sites also meter platform usage (gateway requests, Site SQL rows read and written, stored bytes) against a monthly workspace allowance with overage prices, in `usage_only`, `shadow` or `credits` billing mode, and a deployment-wide monthly spend brake an operator can lift with `scripts/operator/site-platform-brake.ts`. Managers see what each audience can use, readiness warnings with one-click fixes and a View as visitor preview; Site code reads `site.capabilities`. The SDK adds `applySitePublicationFix` and `getSitePlatformUsage`, and agents get `site_publication_apply_fix`.

  Breaking: `agent.guestTools` is accepted but ignored. On published hosts, `not_available_for_viewer` (with the feature name) replaces `site_agents_unavailable`, `site_tools_unavailable` and audience-only Site Data and Site SQL forbidden errors. `details.legacyCode` retains the earlier code for migration; clients must explicitly adopt the new code or read that alias. Ownership refusals keep their own code. `effectiveLimits` now describes non-member limits, never a member's budget. The `free` profile is now `standard` (`free` remains an accepted alias). Limits follow the viewer. These immediate user-directed semantic changes are recorded in the API compatibility exception log, not claimed as a 90-day transition or security exception.

  Migration 0790 adds platform metering, spend windows and verified conversation viewer emails. Migration 0791 is a no-write compatibility checkpoint: legacy stored kinds and overrides stay readable by old releases, with no locked backfill. New writers store standard as free. Request-time normalization ignores old-free defaults in unmarked custom overrides and preserves other owner values; new explicit overrides carry an internal version marker so intentional old-default values are preserved. Existing Sites and old-pod writes pick up the new defaults without republishing. See `docs/published-sites.md` for the exact values and compatibility mapping.

  Members receive no Site budget or session usage-limit stamp. Every published-host conversation gets its own Site Data tools, viewer-bound Site SQL named queries when enabled, and member-only read-only SQL, never management tools. Site agents have no sandbox; publication settings expose no sandbox opt-in. Console-frame tools are narrowed per tool name. Non-member models are explicit and existing subscription conversations are refused. A configurable $0.25 per-turn reservation avoids consuming entire conversation caps; reservation contention returns retryable 429 `site_budget_busy`. React renders audience, budget and platform-brake refusals inline.

  Migration 0790 also adds nullable pending-admission tokens. Funding stays reserved across dispatch, and enqueue transactions verify the token. Crash/unknown-outcome recovery revokes delayed requests and reconciles the locked canonical queue before refunding; neither an idle label nor a timeout can double-allocate funds.

  Keyed Site Start retries also repair sessions whose shell committed but whose first turn did not. Repair reuses the original prompt/model, acquires fresh funding without duplicating conversation or turn counts, and invokes the existing core initialization path.

  Platform usage excludes model spend and defaults to metering only. Site SQL has no monthly row quotas by default and 5 GiB storage per Site. Publishing can return 402 `site_platform_quota_exhausted` only in credits mode and 503 `site_platform_brake_engaged` while the global brake is engaged. The `OPENGENI_SITES_FREE_*` agent settings are deprecated fallbacks for `OPENGENI_SITES_AGENT_*` and `OPENGENI_SITES_GUEST_*` settings.

### Patch Changes

- 99ab991: Distinguish scheduled runs skipped because their chat is paused from busy-chat overlap, and show the reason and recovery action on the schedule. Explain explicit model-account pins that are turned off for allocation instead of presenting them as temporary quota waits. Reclassification of an existing capacity waiter appends a new, deduplicated status event without changing earlier context, resuming paused work, or replacing an account pin.
- 2fef158: Resolving a session's effective model, reasoning effort and latency mode no longer reads the session's whole history. Every session read joined all `turn.started` events to all turns and sorted them, so a long session cost thousands of buffer reads per read, and after a model-settings change the read walked every older start looking for an eligible turn. The lookup now walks start events newest-first, probes each turn by primary key, stops at the first eligible turn and never walks past the latest settings change, also under row-level security. Results are unchanged (verified against every session of a production-sized database).
- b5a790a: A turn waiting for Claude subscription capacity resumes when Anthropic resets a limit early: the waiter re-reads the account's usage on a bounded schedule (at most every 30 minutes per connection) instead of sleeping until the stored reset. It resumes only when the reading reports every limit the refusal's own headers named below the limit; a refusal with an unrecognized or missing limit, or without usage headers, still waits for its stored reset.
- 1e4bed2: Reading a background command's output no longer walks every output chunk the session ever produced. Under row-level security the existing page index could not use its JSON `commandId` key (the `->>` operator is not leakproof, so policies demote it to a per-row filter), so each `command_read`/`command_wait` in a long session scanned the whole session's command output: tens of thousands of rows and seconds per read on a busy deployment. A new online index (`session_events_command_output_client_idx`, built concurrently in rolling migration 0788) keys output by its client event id in byte order, and the read bounds its scan to the command's id prefix and the cursor. Results are unchanged.
- b0f5351: Resuming a browser whose earlier resume timed out no longer gets stuck. Before, the resume first tried to end that interrupted attempt, and when the machine still held the attempt's working copy it refused in order to protect it, so the browser could neither be continued nor resumed.

  Now, when the attempt's browser launch completed (still running, or launched and then the machine restarted), the resume asks the machine to re-adopt that exact attempt from its own profile directory, on the same machine instance and under the same controller generation, and marks the browser active again under the same record and history. Nothing is restored over the working copy and nothing is discarded.

  When the launch never recorded completion (for example the machine went down mid-launch), the attempt can't be adopted. If a complete process scan proves no browser is running its profile (Linux), the machine moves the attempt's whole session directory aside intact, under `set-aside/<browser>/<generation>` in its browser state directory, and the browser resumes from its saved checkpoint under the same record. A launch that completed, or whose profile may still be in use (including any platform without that proof), keeps refusing and stays preserved. Machines on agents without this option keep their original refusal.

  Set-aside directories are kept until an operator removes them; nothing deletes or restores them automatically, because they can hold a private signed-in profile.

- dfb3ef7: Services recover on their own after their PostgreSQL server restarts or fails over. Connections that failed while the database was down were never returned to the pool, so once every connection had failed, all queries and readiness checks hung until the process was restarted, even after the database was back. A failed connection now reconnects like any other.
- 5087e5d: Browsers whose runtime or machine is gone can be ended. Previously such a browser could never be closed, so people kept seeing dead browsers:

  - After the agent restarted, ending a managed browser it had launched was refused with "Current browser is unavailable; its browser record and recovery state are preserved". An explicit end of the exact bound controller generation now retires it on the machine: any browser still running that session's private profile is stopped by verified identity (a reused PID is never signalled), the working runtime is retired and the session's local state is removed. Recovery state of any other generation stays preserved.
  - Ending a browser on a removed (revoked) Connected Machine, or a browser in a person's own Chrome whose device is disconnected or whose machine was removed, failed (for example "sandbox not available" or "Attached browser is disconnected"). It now completes in the control plane under the bound controller generation, so that controller stays fenced and the browser's private checkpoint goes to normal retention. Tabs a Chrome browser opened stay with the person as ordinary tabs. A managed browser on a machine that is only offline still waits for the machine, which holds its process and profile.

  `interactionControllerGone` (db) decides this through the viewer's owner-aware machine listing, so a machine hidden from a person is never judged gone.

- 0031661: Reading whether an idle session still holds an agent wait no longer walks the session's whole history. The deciding-turn lookup sorted every finished turn of the session and, for each person turn, scanned all of the session's delivered updates, so a long waiting session cost over a million buffer reads per read on a busy deployment. Two online indexes (`session_turns_finished_order_idx`, `session_system_updates_delivered_turn_idx`, built concurrently in rolling migrations 0786 and 0787) let it stop at the newest finished turn and probe consumed input directly; results are unchanged.
- 664368a: Browser and computer session list requests accept optional `associatedSessionId` and `includeTerminal` filters, applied in the database. Agent `browser_open`, `computer_open` and `interaction_discover` request only live sessions tied to their own chat instead of the whole workspace history, so opening a browser no longer slows down as a workspace accumulates sessions.
- 6339cec: Site-started agents need both declared editing tools and artifact resource scope. Edits and exports are limited to artifacts created within the same Site-clamped session tree, using immutable create/import receipts rather than recent-use associations. Reading an unrelated workspace artifact cannot grant editing access. Parent and child sessions can work on their tree's creations; another conversation on the same Site cannot. HTTP mutation routes and MCP apply/export/export-status enforce the same boundary. No existing-artifact declaration field is introduced.
- 6339cec: Keep old-reader-compatible Site profiles without a locked backfill. Couple non-member session execution to metered spend plus funded reservations, and fund top-ups before further execution. Correct legacy three-window reservation release, revalidate current viewer audience for every Site data-tool call, and retry old member cap removal after transient failures.
- ae3a892: Refresh the organization MCP action catalog to include Site platform usage and publication readiness fixes, including the required fix body schema in action descriptions. Both actions continue through the existing API authorization checks.

  Existing published-host Site chats now acquire the Site's own viewer-bound data tools, matching permissions and artifact capability, and no sandbox before their next admitted message, steer or resume. This retry-safe host normalization does not restore workspace-default tools or change accepted in-flight execution.

- d367818: Agents using a personal Slack connection can now read files people share in Slack. A new `slack_download_file` tool fetches one file by its ID and saves it into the agent's workspace like an attachment, so PDFs, images and documents can be opened with the agent's usual tools. The Slack connection now asks for `files:read`; the tool appears only for connections that granted it, so existing connections are unchanged until they reconnect. The user token is sent only to Slack's private file host, Slack's sign-in page is reported as missing access rather than saved, and file bytes and private URLs never appear in tool results.
- 76c6a73: Spreadsheet edits that send several commands in one batch now commit. The database checked the batch's operation ids as if they had to be alphabetically sorted, but they follow command order, so most multi-command edits failed with a generic commit error.

  The migration grants the new id-list check to the configured application database roles (`OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES`, plus `opengeni_app` when present), so deployments with a custom runtime login keep writing editable artifacts before roles are next provisioned.

- Updated dependencies [99ab991]
- Updated dependencies [b5a790a]
- Updated dependencies [501bb83]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
- Updated dependencies [d367818]
  - @opengeni/subscriptions@3.0.0
  - @opengeni/contracts@3.0.0
  - @opengeni/config@3.0.0
  - @opengeni/codemode@3.0.0
  - @opengeni/codex@3.0.0
  - @opengeni/observability@3.0.0
  - @opengeni/network@3.0.0
  - @opengeni/xai-subscription@3.0.0

## 2.0.1

### Patch Changes

- dfc66e9: Attached browsers follow their machine's audience.

  - A personal (Only me) machine's browsers are listed, read and controlled only for the machine's owner. Before, any workspace member could see them, and the browser and linked-desktop control paths reached the machine without the owner check that normal machine use applies. An agent counts as the person whose turn it runs for; keys and services see no personal machines.
  - A revoked machine's browsers no longer show as connected with their old profiles and tab counts. They read as disconnected (from when the machine was revoked) and leave the default listing.

- a9052e9: Connected 1Password vaults work again and stay current on their own.

  - The API and worker images ship the 1Password SDK as a real package. Bundling it left its WASM core behind, so every 1Password connect, sync and read failed with a generic error.
  - An Only-me vault's personal 1Password token now loads in every workspace the vault reaches, not only the one it was added in. Before, using or syncing it elsewhere marked the vault "expired, reconnect 1Password" for everyone. Organization vaults likewise load their organization connection in every workspace they are available in.
  - Linked vault mirrors refresh themselves: agent secret search refreshes mirrors older than 10 minutes, and a reference that finds nothing refreshes mirrors older than 2 minutes and looks again. Each refresh is one provider call (plus an item listing only when the vault changed), honours provider rate limits, and retries a failing vault at most once per period.

- 2ea5f7b: People choose which of their workspaces each Only-me vault is available in.

  - "Available in" now works for Only-me vaults: every workspace you use, or the ones you pick. Your Personal workspace always has the vault, so you can always find and widen it there.
  - A new Only-me vault, created or linked from 1Password, starts in the workspace it was added from instead of every workspace. Existing Only-me vaults keep working everywhere until you narrow them, and the default Private vault stays available everywhere.
  - Vault summaries report `availability` for Only-me vaults too.

- f2ffb76: Creating many tasks in one database statement no longer slows down quadratically. Per-task usage-limit counters are now seeded once per insert statement instead of once per row, so bulk inserts such as imports cost the same per task as single inserts.
- Updated dependencies [2ea5f7b]
  - @opengeni/contracts@2.0.1
  - @opengeni/codemode@2.0.1
  - @opengeni/codex@2.0.1
  - @opengeni/config@2.0.1
  - @opengeni/observability@2.0.1
  - @opengeni/network@2.0.1
  - @opengeni/subscriptions@2.0.1
  - @opengeni/xai-subscription@2.0.1

## 2.0.0

### Minor Changes

- c2f4153: Record why each attached Chrome profile connection ended. Every connection generation change ends that profile's live browser sessions, but the reason only existed in machine logs, so a Chrome-side port close could not be told apart from a crashed native host. The native host now sends a final closing frame naming why it is shutting down (Chrome closed the port, Chrome sent an unreadable message, writing to Chrome failed); an end without that frame means the native host itself vanished, and a hello or message the agent refuses is reported as rejected. The agent includes its recent connection ends in every inventory snapshot, and the server keeps a bounded per-profile history in `attached_browser_devices.connection_history` (rolling migration `0770`). Generations that ended without a report are still recorded: as `agent_restarted` when the whole bridge was replaced, otherwise `unreported` for agents too old to report.

  The bridge is also harder to disconnect by accident. An oversized tab title is truncated and an oversized tab URL makes that tab uncontrollable, instead of either one tearing down the whole profile connection. Fields a newer extension adds are ignored rather than rejected. Native-host diagnostics now go to stderr, never to the stdout channel Chrome reads frames from.

- 40e2542: Expose optional cached usage snapshots on already-authorized model-account choices. Preserve partial and unknown readings, snapshot timestamps and historical reset times without polling providers or changing account eligibility or visibility.
- 6861501: Goal continuations, wait wake-ups, command and child results now use the person's current connector accounts instead of copying the accounts of the turn they continue. Each accepted turn records its account intent (whose personal accounts it may use and which accounts were explicitly picked), and work that continues it resolves that intent again, exactly as the person's next message would. A reconnected or newly connected account is picked up by long-running work, and a revoked one stops being bound. A picked account that can no longer be used is never swapped for another account: that connector is left out of the continued turn. Child sessions carry their parent turn's intent. Turns accepted before this release keep copying their exact accounts.
- f96605f: Connect a machine from the chat. Agents can post a Connected Machine card (`capability_authorization_request` with `api:connected-machine`, or `sandbox_provision` with `kind: "selfhosted"`) the way they request integrations. The person copies a one-line Mac/Linux or PowerShell command minted in their browser, the card notices when the machine comes online, and **Use in this chat** moves the conversation there. Once a machine is connected, the card links the Opengeni Browser Chrome extension and shows when Chrome is linked. Agents that can already reach a machine install it themselves with `connected_machine_enroll_token`, and their tool guidance now names the extension link and the machine-first requirement.

  Enroll tokens are now single-use: each carries a `jti` that the exchange records (migration 0696), so one token connects one machine. The same machine may repeat the exchange while it is still enrolled; another machine, or a machine removed since, gets `401`. Tokens minted before this release stay multi-use until they expire. The Machines page connect dialog shares the new command component, adds Windows, and no longer calls a multi-use token "one-time".

- 129ead3: Fold streamed text deltas after their turn settles. Session storage maintenance replaces each run of adjacent `agent.message.delta` or `agent.reasoning.delta` rows with its first row carrying the whole text, `coalescedUntil`, and a lossless `folded` record of every original fragment; `unfoldSessionEventDeltas` rebuilds the originals. Delta coalescing honors a stored `coalescedUntil` as coverage. Content compaction now keeps working through its backlog within a pass while it makes progress.
- 445baf4: Default generic native calls to fresh sessions while preserving explicit session entry. Add non-authoritative selected-session context and exact Send/Steer delivery-to-result tracking without transferring the call.
- 334c470: Add an optional idle-session archive. When a deployment enables it (`OPENGENI_SESSION_ARCHIVE_ENABLED`, Helm `sessionArchive.enabled`), sessions with no activity for `OPENGENI_SESSION_ARCHIVE_IDLE_DAYS` (30 by default) move their bulky content to object storage as a verified bundle plus a readable transcript, keep their readable timeline, and become read-only. Sessions expose `retention`, and `keepLive` (on create or via `updateSessionRetention`) exempts a session permanently.
- 96d7167: People can give agents full access to their inbox. A third choice under "What agents can do here" on the Inbox page (and in the app's Settings) lets any agent working for the person see every open item (questions, approvals, paused goals, replies and notifications, needs-you first, with their session) and snooze, unsnooze or dismiss any of them through `inbox_tidy`, so they can ask an agent to catch them up and clear what's done. Agents still never answer a question or decide an approval for the person; dismissing one only clears it from the inbox. The other two choices keep their behavior. SDK: `InboxTidyPolicy` gains `"full_access"`.
- 810d1d9: Add targeted current-human tool resolution and invocation without whole-workspace
  provider discovery. Fence caller, pinned Site and selected live action policy
  after awaited physical credential authorization. Preserve success/unknown
  outcomes through cleanup failures, prevent stale retries on contradictory
  transport flags, and retain Site entry pins through Codemode refresh. Preserve
  live account authority, versioned executable-effect one-shot approval
  bindings, optional full-definition preconditions, and explicit legacy discovery.
  SDK calls use the targeted path by default; older APIs require explicit catalog
  mode. Upgraded Site hosts adapt saved legacy bundles using bounded manifests.
  Raw/local target approvals bind existing executable/configuration authority
  instead of public catalog presentation. Retained catalog clients also veto
  uncertain stale retries; explicit malformed pins are never silently omitted.
  The host also separates executed stale-named provider diagnostics from legacy
  Site retry control without rewriting saved bundles or changing success outputs.
  Deploy rolling migration 0686 before enabling the new API and matched SDK/host.
- 945490f: A connected machine can switch between This workspace and Only me in place, keeping its enrollment, sandbox id, credentials and live connection, so chats, schedules and the installed agent are not registered again. The Machines page gains **Who can use it?**, a dialog that summarizes what one confirmation does, backed by `POST .../machines/:enrollmentId/audience/preview` and `PUT .../machines/:enrollmentId/audience` (`previewMachineAudience` and `changeMachineAudience` in the SDK). Narrowing applies everything in one transaction: the owner's chats stay (shared ones stay shared, usable only by the owner) and their running attempts are re-authorized; other people's chats move off; turns that may no longer use the machine end as cancelled through the terminal `authority_change` interruption; the owner's Workspace schedules on it become Only me (or pause) and other schedules pause; and each affected person gets one inbox notice. Only a second live connection of the same computer blocks the switch. The worker reads the machine's current audience on every operation, so running sessions follow the change without a rebuild and the agent needs no restart or upgrade.
- 8e878ac: Turn screen control on for an already-connected machine, in place, with no reconnect, token or human click. `POST /v1/workspaces/:ws/machines/:enrollmentId/screen-control` (SDK `enableMachineScreenControl`; agent tool `connected_machine_enable_screen_control`) records the consent on the enrollment without a new credential generation. It then sends the live agent the new `credential_renew` control op, and the agent renews its credentials with its install-key proof. The response is `active`, or `pending` with `offline`, `agent_update_required`, `renewal_failed` or `reconnect_required`. Pending consent applies automatically on the machine's next Hello. Each change records a `connected_machine.screen_control.allowed` audit event with the actor.

  Agents advertise `Capabilities.credential_renew`. Mac agents report Screen Recording, Accessibility and Input Monitoring (`MacDesktopPermissions`) on Hello and desktop heartbeats, which surface as `runtime.macPermissions`. `runtime.capabilities.screenControl` says whether the live agent holds the consent. `POST /v1/workspaces/:ws/machines/:enrollmentId/privacy-settings` (SDK `openMachinePrivacySettings`) opens one of those System Settings panes on the Mac. The Connected Machine card shows **Turn on**, then walks the missing Mac permissions from what the machine reports.

- 9701372: Agents can notify another member of their workspace. `notify_user` takes an optional `recipient` (email or member name); it reaches that member only while they allow other members' agents to notify them in that workspace, a per-person setting that is off by default (`GET`/`PUT /v1/workspaces/:workspaceId/inbox/member-notifications`, `getMemberNotifications` and `updateMemberNotifications` in the SDK). Otherwise the agent gets a clear refusal, as it does for non-members and for sessions that work for no person. Inbox items now carry `sender` (who the notification came from) and `sessionAvailable`: another member's private session is never linked, titled or opened from the inbox or the phone notification. Inbox items are kept per recipient, so one key can reach the owner and a teammate separately, and `notification_withdraw` can withdraw one member's copy.
- ab3306a: Organizations can set model-account settings once and lock them for every workspace: rotation, cross-provider failover and its fallback order, whether personal accounts are allowed, and personal fallback. A shared workspace's administrators can override any setting the organization has not locked, and a locked setting cannot be overridden by anyone (enforced in the database; locking clears existing workspace overrides). New routes `GET/PATCH /v1/organizations/:organizationId/model-account-settings`, `GET /v1/organizations/:organizationId/model-account-settings/overview` and `GET/PATCH /v1/workspaces/:workspaceId/model-account-settings` (SDK `getOrganizationModelAccountSettings`, `updateOrganizationModelAccountSettings`, `getModelAccountSettingsOverview`, `getWorkspaceModelAccountSettings`, `updateWorkspaceModelAccountSettings`) report each effective value with its source: the organization, the workspace, or locked by the organization. Migration 0724 is rolling and changes no existing effective setting.

  Models settings now edit exact model fallback order, per-provider rotation and their organization locks, support workspace inheritance resets, and paginate the effective-settings overview with per-entry sources. A separate personal preference requires the person's opt-in; organization permission never opts them in, and they can withdraw a prior opt-in even while use is disallowed.

- 3426850: Personal API keys: an organization member can create a key (`ogp_…`) that acts as them. A script or outside agent using it does what that person can do in the organization right now, capped by the key's access setting, and shows up as them, including on the organization MCP server. A changed role applies on the next request, suspension pauses the key, and leaving the organization revokes it. Keys are created in Organization settings > Developer with a choice of access and an expiry of 30, 90 (the default) or 365 days, or never; the key is shown once. People see and revoke their own keys; owners and admins see and revoke everyone's. Only the person, or an agent or key with their full access, can create one, so a limited key never mints a broader one. New routes `GET|POST /v1/organizations/:id/personal-api-keys` and `DELETE …/:apiKeyId`, with SDK methods `listPersonalApiKeys`, `createPersonalApiKey` and `revokePersonalApiKey`. Migration `0722` is rolling: older API instances read a personal key as having no access.
- 3a4a435: Organization privacy settings: owners and admins choose whether new chats and schedules start as Workspace or Only me, and whether admins see Only me schedule summaries. Deployment settings can turn Only me off, require the Workspace default, or require admin summaries, and organizations cannot widen past them.
- ae01a91: An Only-me session can now share a sandbox or Connected Machine with other sessions. Who can read a conversation and who can use a box are separate: making a session private, or creating one private, no longer requires its own sandbox group, and its conversation, events, command records, terminals and stream access stay scoped to its audience while files on the box stay as shared as the box. Migration 0739 (rolling) drops the singleton-group requirement from visibility transitions and whole-session forks, counts only sandbox access attributed to the session itself as a quiescence blocker, and lets a top-level private create join a group its creator can already see. Effective control now walks the complete ancestry, so a paused private parent still pauses its workspace-visible children, shown to other members only as "An ancestor session". Variable Set changes still require a singleton group, now counted across every member including private ones, and the stream-capabilities shared-exposure flag counts every session on the box while listing only the ids the caller can read.
- 14343e4: Leftover records no longer block making a chat Only me. The private visibility change now settles them in the same transaction: turns stuck `queued`, `recovering` or `waiting_capacity` on an idle chat are cancelled, RunState rows, questions and capacity waiters on finished turns are ignored, a finished background-command result carrying someone else's authority is cancelled, and schedules that can no longer run stop counting (rolling migration 0768). Work the person can see (a running or parked response, queued messages, an active goal) answers a typed `active_work` conflict unless `UpdateSessionVisibilityRequest.stopActiveWork` is sent; with it the change cancels that work, pauses the goal, interrupts a response a worker is executing and then completes, answering a retryable `stopping_active_work` with the same idempotency key if the worker is slow. New owner-only `GET /v1/workspaces/:workspaceId/sessions/:sessionId/visibility/preview?visibility=private` (SDK `previewSessionVisibilityChange`) reports that work and any block stopping it would not clear; the console shows one summary and one "Stop work and limit to me" confirmation. Blocks that protect another person's authority are unchanged.
- 2b8ee21: Nothing in a chat refuses making it Only me any more (rolling migration 0769). Another member's authority is dropped by the change: their pending updates are cancelled, a subscription account choice pointing at their personal connection is removed, and a pending update that later arrives with someone else's authority on a private chat is stored cancelled. A live voice session ends. Schedules, sandbox processes, file operations and viewers no longer count. `SessionVisibilityWork` gains `liveVoice`, `otherPeoplePendingUpdateCount` and `otherPeopleAccountChoiceCount`; any of them, like running work, needs `stopActiveWork` ("make private anyway"). The visibility preview's `blocker` is deprecated and always `null`. The console skips the dialog when nothing is in the way and otherwise shows one short list with a single button.
- a81a567: Schedules can now be Only me, like chats. An Only me schedule is visible only to its owner through the API, the agent's schedule tools and Slack, and each run creates an Only me chat owned by that person after rechecking that they may still create one. A schedule that posts into an Only me chat or saves to personal knowledge is always Only me; existing ones become Only me. Workspace admins see other people's Only me schedules only as a summary (owner, cadence, status, last run and 30-day cost) and can pause them, but never see their name, message or runs. `ScheduledTask.visibility` reports the audience, create and update requests accept `visibility`, and `GET .../scheduled-tasks/private-summaries` and `POST .../scheduled-tasks/private-summaries/:taskId/pause` serve the admin summary. The schedule form asks who can see it, and the Schedules list marks Only me schedules.
- 6861501: Schedules that start their own session now follow the workspace's default connectors at each run, the way a new chat does. A schedule created without choosing tools stores `agentConfig.toolPolicy` (`{ mode: "workspace_default", excludedMcpServerIds }`) instead of a copy of the defaults, so a connector the workspace adds later reaches its next run. Its `tools` list only connectors added on top, and an edit that does not name a policy keeps the existing one. Creating a schedule with an explicit `tools` list and no policy still gives it exactly that list.

  The schedule editor shows what the next run gets and saves defaults a person turns off as exclusions. Agent schedule tools cannot set `toolPolicy`; their reads report where a run's connectors come from (`configuration.connectors`).

  Migration 0754 moves agent- and service-created schedules that start their own session to follow the defaults, keeping their saved tools as additions. A list a person created directly is kept exactly.

- 6861501: Schedules use the owner's current connector accounts on every run instead of a saved snapshot. Saving a schedule no longer stores which accounts were connected at that moment, so a reconnected, renamed or newly added account is picked up by the next run, and an account that was removed is simply no longer used.

  A person can still pin accounts on a schedule that starts its own session, with `pinnedAccounts` on create and update (`[]` unpins everything). A pin narrows only its own connector; every other connector keeps following the owner's current accounts. Agents, API keys and services cannot pin accounts (403). A schedule that posts into an existing chat has no pins: that chat supplies its connectors and the owner's current accounts.

  When a pinned account can no longer be used, the run goes ahead without that connector and never substitutes another account; the run records it in `degradedAccounts`. Set `pinnedAccountsRequired: true` to skip the run instead.

  Migration: `connectionAccounts` and `connectionAccountsFrozen` are removed from schedule requests and `ScheduledTask.agentConfig`, and `attachableAccounts` is removed from `ScheduledTaskPolicyDrift`. Requests that still send `connectionAccounts` for a schedule are rejected; send `pinnedAccounts` only for an account a person chose, or nothing to follow the owner's current accounts. A database migration turns every saved account snapshot into the default behaviour. Session and message `connectionAccounts` are unchanged.

- e8c3557: Admin access for a session now has a time limit. It lasts one hour by default; the person giving it can choose 8 hours, a day or no limit, and can change the limit while it is on. Access ends by itself when the time is up. `PUT .../admin-access` accepts `{ durationHours }` (1 to 720, or null for no limit), and `SessionAdminAccess` reports `expiresAt`.
- 5cdfbaa: Owners and admins can give one of their own sessions admin access. When the organization allows it (Organization settings > Security & data > Agents, off by default), "Give admin access…" in a session's header menu lets its agent find and run every organization action the person can, across all workspaces, through `admin_actions_search`, `admin_action_describe` and `admin_action_call`. A small shield beside the session title shows it is on and turns it off. Access is checked on every call and ends when either switch is turned off or the person stops being an owner or admin. SDK: `getOrganizationAgentAdminAccess`, `updateOrganizationAgentAdminAccess`, `getSessionAdminAccess`, `grantSessionAdminAccess`, `revokeSessionAdminAccess`.
- 11779ba: Add optional per-task usage limits. A root session can carry a limit in USD micros of API-equivalent model usage (the pre-margin provider list-price estimate) shared by all of its child agents. New model requests are refused once recorded usage reaches it; requests already running finish, so usage can go above it. Set it with `usageLimitMicros` on create or `setSessionUsageLimit`, read it with `getSessionUsageLimit`; both verify the server's echo. A reached limit is a typed `session_usage_limit_reached` refusal and a `segmentLimit: "session_usage_limit"` stop, never a credits error. New producers are gated by `OPENGENI_SESSION_USAGE_LIMITS_ENABLED` (default off); persisted limits are always enforced.
- 66b3026: Sites now have an audience, like chats and schedules: **Only me** or **Workspace**. An Only me Site is visible only to its owner, everywhere it can be reached: the Site page, versions, content and downloads, the artifact library, Site tools and Site conversations; admins cannot see it, as with an Only me chat. New Sites start shared unless `visibility` is set when creating one over HTTP; Sites agents publish start shared and are owned by the person the agent acts for. The Site page shows who can see it and gives its owner a "Share with workspace" action (and "Limit to me" while Only me is allowed), each confirmed first. Only the owner changes the audience, through `PUT /v1/workspaces/{workspaceId}/published-artifacts/{artifactId}/visibility` or the SDK's `updateWorkspaceArtifactVisibility`; agents cannot. Sites expose `visibility` and `ownerSubjectId`, and artifact catalog items for Sites include `visibility`. Existing Sites stay shared with the workspace; migration 0737 records their owner.
- 844c089: Sites can now save data. Every published Site gets persistent collections of JSON records and files that survive new versions: Site code uses `site.data` (list, get, insert, put, patch with conflict detection, delete, increment, count, batch) and `site.files` (upload, list, url, delete) from `createOpenGeniSiteClient()`, with no credentials in the Site. Each collection's access mode decides what viewers may do (shared, shared read, per viewer, append only), enforced by the server; the Site page itself always acts as a viewer, and an Only me Site's data stays its owner's. Agents and scheduled tasks manage data with new `site_data_*` and `site_files_*` tools, and the Site page has a Data tab for the people who manage the Site. Quotas, write limits, per-Site and per-workspace limits on schema-checking time, and usage metering (usage only, no charge yet) apply. Hosts opt in by giving `createSiteToolBridge` a pinned Site and `fetchResponse`; older hosts report `site_data_unsupported`.
- a13bf1a: A person can have the phone alerts for their agents' questions and approvals arrive time-sensitive, so they break through Focus on iPhone while the agent waits on them. `InboxSettings` gains `timeSensitiveNeedsYou` (off by default; `GET`/`PUT /v1/inbox/settings`, `getInboxSettings` and `updateInboxSettings` in the SDK). The web Inbox settings and the mobile app's Notifications settings offer it. Replies and failures stay ordinary alerts, and an agent's own notifications keep the urgency the agent gives them.
- e8a5b0a: A shared workspace's administrators can now connect subscription accounts (Codex, Claude, SuperGrok and API keys) for their own workspace without being organization administrators, and remove them again. The account belongs to the organization, serves only that workspace, never reaches Personal workspaces, and stays visible to organization owners and admins, who alone widen its scope. Once an account serves another workspace, only an organization administrator can remove it. Rolling migration 0777 adds the matching insert and read policies and lets the disconnect routine accept the managing workspace's administrator for the workspace's own account. The Models page now offers Codex to workspace administrators and says who the account is for.

### Patch Changes

- d4c17b3: Automatic agent updates no longer close open browsers. Agents before 0.1.58 close every managed browser when they restart, so the automatic updater now leaves such a machine on its current agent while it still has a managed browser that may be open, and looks again on the usual busy backoff. The machine card shows "Update to vX postponed: open browsers would close" and notes that updating by hand closes them; "Update now" still works. Agents from 0.1.58 on keep their browsers across a restart and are updated as before.
- de2d721: Tool-call output events are now bounded when stored. An output up to 256 KB is kept exactly; a larger one (for example a shell command that printed a multi-megabyte line) is stored as a head-and-tail preview with explicit truncation metadata, which the timeline already shows. Model history is unaffected. Full-mode history reads also return any older event larger than 4 MB as an explicit preview built in the database, so opening a chat can no longer load an enormous row into the API.
- 35fb6fd: Add dormant candidate-provider waiter hints, indexed and bounded extra wake fan-out,
  and bounded reconciliation deadlines that preserve the reported capacity reset.
  Failover evaluator and worker integration remain separate.
- 7ae7683: Add the rolling shared subscription-core storage, tenant-scoped authorization policies, effective-settings resolver, and repository declarations without changing production subscription placement.
- 931ac51: Add provider-neutral subscription operation leases and durable capacity-wake persistence behind the provider cutover switch.
- 262e6b5: A managed browser whose restored launch failed before it finished can be resumed again. Previously, if Chrome started from a restored private profile but the launch then threw, cleanup removed the profile but left the launch record "in progress". Every later cleanup or resume of that browser was then refused as "Current browser is unavailable", and the stuck resume eventually marked the browser lost.

  Now the browser service records such a launch as failed, with a short error code, and logs the original error. Cleanup of that exact controller generation succeeds, so the next resume restores again from the saved private checkpoint. Launch records left "in progress" by earlier versions are treated the same way when no process was recorded and the restored profile is gone. A launch that might still be running stays protected as before.

  A browser that was lost because its resume timed out (`controller_transition_expired` after a resume) can now be resumed through the normal resume request. The API first ends the old controller generation, then returns the browser to suspended and restores it from the same checkpoint under a new generation. Browsers lost during create, suspend or end are unchanged.

- 90f297f: Waking subscription capacity waiters no longer deadlocks. A wake now takes each session's lock before its waiter's, the same order a resume uses, so concurrent wakes of one pool and a wake racing a resume no longer abort with deadlock errors.
- cd6bf1d: Sandboxes running a supervised background command now get checkpoints. While a supervised command ran, every save of its box was refused, both the turn's periodic checkpoint and the idle checkpoint between turns. The box's only save was the mandatory one just before the provider deadline, so losing the box unexpectedly lost every change since the last turn. A Modal point-in-time checkpoint now runs around the command, the same way it does for unsupervised commands. The box and the command keep running. The checkpoint is a real restore point, saved one generation behind the workspace so it is never presented as complete. The database guard still refuses drains, containment and teardown of a supervised command without its exit receipt.
- 91c7c0e: Turn claims no longer wait on organization membership changes. The claim takes no organization-membership lock at all, so a member being added, suspended or removed never delays turns starting in that organization; a removal that races a claim is still refused when the turn acts.
- e8a3d83: Bound Claude's final serialized request and inline image bytes. Recover a first
  request-size rejection through one durable checkpoint while preserving the
  latest complete input/tool batch, signed thinking, and original history. Keep
  the recovery allowance across attempt restarts and report content-free size
  diagnostics instead of retrying an unchanged oversized request.
- 69a3f42: Prepare Claude subscription chat turns for the shared subscription core. A Claude turn reads its provider route once: without the Claude cutover it runs exactly as before; during maintenance it fails with typed copy; on the core it is placed, leased and funded like the other subscriptions, every model, web-search continuation and session-title request is reserved and settled before and after it goes out, an unknown outcome is never replayed, and an unauthorized response is retried at most once, on the same account, after one forced refresh. On the core, workspace model policy must allow a workspace-scoped Claude model under both its own and the organization's provider identity. Nothing changes today: no organization has the Claude cutover, so Claude, SuperGrok and Codex behave exactly as before.
- f86c658: Prepare Claude subscription refusals and capacity waits for the shared subscription core. On the core, a Claude sign-in refusal or rate limit is recorded against the account and the same turn moves on within the shared bound, a rate limit rests only the model that hit it, an overloaded response keeps retrying on the same account, a 403 fails the turn without touching the account, usage headers update the account's limits, and a turn with no capacity waits durably with the same events as today. Nothing changes today: no organization has the Claude cutover, so Claude, SuperGrok and Codex behave exactly as before.
- ab1ea00: Connecting a Claude account now adds Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 by default, instead of starting with no models. This only happens where no Claude model of that kind was ever configured, so existing and trimmed lists are kept. Claude Haiku 5.5 is also offered among the Claude models you can add, and a rolling migration adds it where Claude models are already in use and Haiku 5.5 was never added or removed.
- 35fb6fd: Remove the legacy Claude subscription runtime now that Claude runs on the shared subscription core. Claude turns, refusals, waits and readiness use only the shared core; without the Claude cutover a Claude turn fails closed instead of using the old account pool. Organization Claude custom models are offered and admitted only while the shared core serves the model in that workspace (an enabled cutover and a usable shared Claude connection that allows it); otherwise they are refused. Workspace-scoped Claude custom models are not offered for new selections on the shared core, and their admission check follows the same core rule. A single Claude model call (the API model-calls endpoint) fails closed with capacity unavailable in every case, including after the cutover, until the shared core serves it. Until the shared core serves them, the Claude account, usage, sign-in, setup-token and access-policy endpoints keep their permission checks (the strictest workspace check where the old check depended on the account's scope) and then answer 503 instead of reading or writing the old account pool. The no-legacy runtime check now covers Claude.
- 4532435: Codex Apps keeps working when a workspace routes models through its organization's Codex accounts. The workspace's designated Apps account now loads, and its token refreshes persist, through the Apps designation itself instead of the model-routing pool; that authority still reaches only the designated account, owned by this workspace and its current owner. Turning Apps off (`DELETE /v1/workspaces/:workspaceId/codex/apps`) now works in every routing mode, so `apps.canDisable` is accurate.

  Apps no longer posts an authorization card every time it sets up a turn. A card appears only when an Apps tool call needs one, at most once per turn, and an unusable designated account is reported with the new `tool.auth_needed` reason `designated_credential_unavailable` instead of `refresh_failed`. Clients should treat unknown reasons generically, as before.

- 851cbdc: Protect Codex extra credits by default, add revocable per-account spending consent with included-allowance-first rotation, and allow organization accounts to pause without disconnecting. Preserve unknown balances as null in usage responses.
- efb4c0c: Allow an accepted person's turn in an ownerless session to refresh its shared Codex credential under the existing exact-turn, live-lease and one-shot capability fences, without granting personal credential authority.
- 590e42a: Scheduled runs that open a new session per run work again on Codex subscriptions. Such a session has no owner, but its turn records the person it runs for, and the shared subscription core refused that combination. The turn was cancelled before its first model request and then reported as lost worker ownership. These turns now place on shared capacity only, like any ownerless turn, and never use a personal subscription.
- 7e59f42: Codex turns in flight during a rolling deployment, a worker loss or a lost lease now recover instead of failing. Recovery runs the turn again from its checkpoint in a new attempt, but a model request that was streaming when the old attempt stopped stayed unresolved and the replacement's first request was refused, so the turn failed as not retryable. The interrupted attempt can no longer write, so its response is never used; the new attempt's requests now proceed, and the old request keeps its unknown outcome. A capacity or approval resume still cannot send a request while an earlier one is unresolved.
- e112198: Retrying a failed Codex turn works again after a provider error left one request with an unknown outcome. Before, the retry's first model request was refused, so the turn failed again as not retryable. Automatic recovery stays fenced: a replacement attempt after a lost worker, or a resume after an approval or capacity wait, still cannot send a request while an earlier one is unresolved.
- 124bf22: A session whose last turn failed context compaction wakes again for machine input that arrives after the failure, such as an Agent message or a child result, instead of holding every later input until a person writes. The new attempt carries the inputs that were already pending at the failure. Inputs that saw the failed attempt stay held, and the workflow-wake dispatcher no longer re-signals a session that only has held input.
- c9f2c11: A context compaction cut short by its own attempt's cancellation (for example a turn worker draining during a deploy) is no longer reported as a summarization failure. The worker records `session.context.compaction.skipped` with `reason: "interrupted"`, keeps any explicit `/compact` request pending for the recovered attempt, and lets the cancellation recover the same turn as before. The timeline shows "Compaction interrupted" with retry copy instead of "Couldn't compact conversation history".
- 715e812: Remove PUBLIC's EXECUTE grant on the two routines added for turn connection-account intent; the application role keeps the CHECK validator. Align the creator-policy digest and sender-cutover upgrade tests with the current migrations.
- 4943abb: Continuation turns (goal continuations, wake-ups, command and child results) insert again on installs whose tables live in a dedicated schema: migration 0756 replaces 0755's hard-coded `public.session_turns` lookups with the install's own schema. The legacy Codex pin fallback now applies only to shared people-scoped connections of the same provider, so another person can no longer pin someone's personal connection.
- 5b31ec7: A request that a crashed worker left open no longer keeps a sandbox from being saved. When a worker dies mid-command, its turn attempt is closed lease-lost or failed and its lease holder is dropped, but the exec request it had dispatched stays open with an unknown outcome and nothing ever settles it. That request used to refuse every checkpoint, the idle drain, idle command containment and the provider-deadline backstop for the rest of the box's life, so the provider's 24-hour deadline killed the box uncaptured. Containment no longer waits for such a request, and Modal native checkpoints (point-in-time images of the paused box) run around it: a drain right before terminating the box, a warm checkpoint recorded one generation behind the workspace. Tar-style checkpoints still wait, and the drain's cold commit rejects it only after the box was terminated, which is when nothing it started can still run. Its owner then gets a durable wake so the attempt's quiescence receipt can complete. A lease-lost attempt whose holder still exists, and an attempt closed by Pause, Steer or cancellation, keep their open requests as writers.
- 3962da3: Sessions keep one subscription account choice per provider on the shared subscription core, as they did before it. Work on one provider's model never reads, replaces or clears another provider's pinned account, so switching back to the pinned provider's model uses the pinned account again, and a session can hold a pin for each provider. Choosing "automatic" for Codex changes only the Codex choice. A pinned account that was deleted now waits for a new choice instead of silently pinning a different account. Migration 0733 rekeys the bindings table in a rolling-compatible way; a session still holds one binding until the next drained provider cutover.

  The neutral model-account API lists all provider choices in `bindings`. Choosing an account changes only that provider's choice. Returning to automatic accepts an optional `provider` to clear only that choice; omitting it resets all explicit choices, preserving the original whole-session action.

- a90e943: Database clients retry a refused or reset first connection for up to 15 seconds while a process is starting, so a new pod that is briefly refused while its network policy or DNS settles no longer fails a rollout hook (migrations, catalog import) or restarts a worker. Once a client has reached the server, connection failures surface exactly as before.
- e656292: Database clients can opt out of the startup connect grace with `bootConnectGraceMs: 0`, so a refused connection fails immediately where that is the point.
- 4192cb9: A session whose start fails before its first event or turn is now discarded instead of staying visible as a queued session that never runs. A keyed create also releases its idempotency key, so retrying with the same key starts the session normally.
- 4c42f16: Keep uninitialized session shells idle until atomic initial admission, and prevent an empty stale queued projection from suppressing every subsequent skip-overlap schedule occurrence. Extend the existing explicit operator maintenance manifest to repair reviewed uninitialized shells without creating turns, replaying input, waking parents, or changing Pause.

  The same hook can withdraw an exact reviewed queue of never-run prompts and clear its obsolete admission block atomically, without running those messages or releasing unreviewed work.

- bc599cc: Pause exhausted one-shot and bounded interval schedules after accepted runs settle, preserving Temporal catch-up semantics. Repair existing exhausted schedules and durably reconcile their Temporal state against the latest saved task.
- ce7b403: Track built-in tool default inheritance independently of connector selection. New sessions and explicit resets follow current workspace defaults on the next attempt, while explicit lists, exclusions, deployment ceilings, capability restrictions, and frozen catalogs remain authoritative. A rolling migration adopts default intent only for older root sessions whose latest retained policy event proves a full reset and still matches their stored selection; ambiguous legacy selections remain pinned.
- f0244af: Forking a chat at a message that cannot be a fork point now says why, instead of the generic "Invalid session tenancy request". The fork routine's four boundary refusals (not a user or agent message, the message's history was superseded by compaction, the history up to it was compacted, or it splits an unfinished tool exchange) reach `SessionTenancyInvalidRequestError.forkPointRefusal`. The API returns them as 422 `validation_failed` with `details.reason` `fork_point_<reason>`, and the fork dialog explains each one. Other invalid requests keep the generic error.
- 7ae7683: Add rolling storage and RLS foundations for the shared subscription core.
- 9712020: A wait for a person no longer keeps a sandbox box warm. A held `wait_for_input` or a turn waiting for an approval or human input does not block idle command containment: after the normal idle window the workspace is saved, the box is stopped, and it resumes on demand. The notice that the command was stopped does not wake the waiting agent; it arrives with a later turn, normally when the person answers or the wait times out. A background command that printed output inside the window still keeps its box, whether or not anything waits on it. Rolling migration 0687 widens the containment inventory; the containment notice now says the command printed no output in that time.
- 5baab79: Stop Modal boxes that only an unused browser or desktop keeps warm. After the general sandbox idle grace without use (agent tool calls, a person's input, or a visible live view's heartbeat), a saveable browser is checkpointed and suspended, other browsers and desktops are released as `idle_released`, and the box saves `/workspace` and stops. Saved browsers resume on demand, also when the desktop they were shown in has stopped.
- 3e00c37: A sandbox that stays running between turns is now checkpointed at the snapshot interval when it has unsaved changes. Before, a box kept running by an open desktop or terminal tab, a browser or computer session, or a background command (a server, a build, or a command the agent was waiting on) was saved only while a turn was open, so changes could sit unsaved until the provider's 24-hour deadline. The reaper now takes the same warm Modal snapshot a turn would, around those holders, at most once per snapshot interval. Turn checkpoints also no longer skip while a desktop or terminal tab is open, and a tab that was opened and closed again since the last save still counts as an unsaved change. A clean box, or one held by a turn, an open request or a supervised command, is left alone.
- b061e43: An idle deployment no longer starts a Temporal workflow on every tick of the session wake dispatcher (every 10 seconds), Knowledge indexing (every 15 seconds) and site-auth maintenance (every minute). The control worker now runs these cadences itself: each tick is one cheap read-only check of whether the job's claim could find work, and the workflow starts only when it could. Periods and claims are unchanged, and a failed check still starts the workflow. The old per-tick Temporal Schedules are deleted at startup; an older release recreates them, so rollback keeps working. Immediate wake requests now signal-with-start one fixed dispatcher execution, and a request that arrives during a sweep runs exactly one more sweep. New migration 0730 adds the read-only checks with the same owner and grants as the claims they preview. New metrics: `opengeni_maintenance_cadence_ticks_total{job,outcome}` and `opengeni_maintenance_cadence_last_success_timestamp_seconds{job}`. `registerKnowledgeIndexingSchedule`, `registerSiteAuthMaintenanceSchedule` and `registerSessionWorkflowWakeDispatcherSchedule` are replaced by `startInternalMaintenanceCadences`.
- 17374c1: An idle deployment no longer starts five Temporal workflows on every sandbox reaper tick (every 30 seconds by default): the reaper router, the drain inventory, its maintenance pass, the idle checkpoint sweep and the browser checkpoint sweep. The control worker now drives three work-checked cadences on the same reaper period:

  - The lease reaper starts the unchanged drain inventory, which starts its maintenance pass, only when a lease is warming, warm, draining or held, when any reconciliation the pass runs has a due row, or when Modal is configured and its app still runs a sandbox.
  - The idle checkpoint sweep starts only when a warm box may be due at the snapshot interval.
  - The browser checkpoint sweep starts only when a checkpoint-capable browser on a warm box is suspending or facing its provider deadline.

  An idle reaper tick still refreshes the reaper's read-only gauges in the control worker, so inventory freshness alerts keep working. The reaper period and its boot invariants are unchanged, and a failed check still starts the workflow.

  The old `opengeni-sandbox-lease-reaper` Temporal Schedule is deleted at startup, and `registerSandboxReaperSchedule` is removed. The router workflow and activity stay registered so in-flight histories and a rollback still replay. New migration 0732 adds the read-only checks, each with the same owner and grants as the claim it previews.

- 296e862: Keep agent work running when one of its inherited personal accounts lapses. Agent messages, child sessions and goal continuations inherit the exact personal accounts their person accepted. When one of those accounts later needed re-authorization or was revoked, the database refused the whole turn, so a single expired account blocked every child session and agent message that inherited it. The lapsed account now stays recorded on the turn without any authority, so every use of it is denied and it is never revived, matching how a lapsed shared workspace account already behaves. A mismatched owner, provider or kind is still refused.
- 9a84080: Replies during a live voice call no longer land in the inbox or alert the phone. While a session has an active voice call, each finished turn is spoken back in the call, so it doesn't refresh the session's kept reply or send a "replied" push. A reply that finishes after the call has ended still arrives as before.
- 0a743b9: Retain recovery wake debt until a quiesced logical turn is reclaimed, rediscover lost recovery wakes, and support exact operator-authorized terminal retirement without replay.
- c878320: Only a session created without an idempotency key is discarded when its start fails before the first turn. A keyed session stays, so a retry with the same key repairs it with the parameters it was first accepted with.
- 061ae01: Knowledge listing and search accept an optional `createdSince` timestamp to find newly added entries by their original creation date. Rolling migration 0640 applies the filter before ranking and pagination without changing access. The Knowledge Library offers Added filters for the last 24 hours, 7 days, and 30 days.
- 6313dd8: Local installs have an Inbox. A local install's one human (the fixed `dev` subject of the built-in local organization) now gets its agents' questions, approvals, paused goals and notifications in the Inbox and can answer them there, as a signed-in person can. Only that human qualifies: the local bootstrap must have produced the request's access, as a keyless, non-delegated human session. API keys, services, agents, delegated bearers that name `dev`, and `dev` in any other organization still have no inbox. Phone pushes stay for signed-in people, because a push device is registered only by a native-app sign-in that local installs do not have.
- 4d8eb5e: Removing a Connected Machine no longer refuses because a conversation that points at it has a queued, paused or recovering turn. Those conversations are detached like idle ones and their next attempt uses no machine; only a live machine lease or pending lease recovery still blocks removal.
- 757c3d5: Export `MAINTENANCE_WORK_PROBE_ROUTINES`, the read-only maintenance work checks that the runtime posture verifies, so posture fixtures can derive the expected checks instead of pinning a copy that drifts when a check is added.
- c502add: The save before a sandbox's provider deadline is now mandatory. Before, the deadline backstop waited until every background command had received and outlived its stop request, every owner turn had written its quiescence receipt and no sibling session had a recent attempt, and the zero-holder drain waited for every open request. When any of those could not finish, the box died at the provider deadline without being saved. Inside a fixed window before the deadline (the command stop grace, the drain capture budget and two reaper periods, at most the rotation lead) the reaper now saves and stops the box anyway. Only a live turn, viewer, direct request or interaction on the box, or a supervised command, still blocks it. Requests still open on the box are recorded by rolling migration 0676, left out of the saved checkpoint and settled only after the box is stopped. A file being written at that moment can be saved half-written. Enrollment through this path is counted as `opengeni_sandbox_command_containment_total{outcome="forced_deadline_enrolled"}`.
- 0001298: Add provider-neutral subscription lease and placement repository APIs, and tighten source-assignment model eligibility.
- bc40348: Tell the model who sent each person's message. Members of a shared workspace talk to the same agents, and the model previously saw only the message time, so it could mistake one member for another. A claimed human message's metadata part now reads `[Message sent <time> by <sender>]`, using the sender label frozen with the turn at acceptance (normally the member's email). The label is made safe for the one-line part: no brackets or line breaks, at most 200 characters. Agent, service and scheduled turns carry no sender. Realtime voice requests and the end-of-call transcript handoff now carry the caller's own label instead of the generic "Realtime" label when the request has one.
- 4e4507c: Add a read-only migration plan: `bun run db:migrate-plan` (or `bun src/migrate.ts --plan` in `@opengeni/db`, and the exported `planMigrations`) lists the shipped migrations the database has not applied, each with its declared deployment mode, and reports `requiresDrain`. An upgrade whose pending migrations are all `rolling` can run the migration job while the previous release keeps serving, so a deploy only needs to drain API and worker processes when the plan says so.
- 5eb1c32: Choosing a session's model account is now classified internally as the provider-neutral `session.model_account.write` operation, for the neutral `PUT .../model-account` route and the older Codex pin route alike. Hosts receive the older name `session.codex_account.write` by default, preserving existing allow/deny policies. After migrating policy keys, hosts opt in to neutral delivery with `SessionAuthorizationPort.capabilities.modelAccountOperation: true`. Both names remain valid; `canonicalSessionAuthorizationOperation` and `SESSION_AUTHORIZATION_OPERATION_ALIASES` normalize old names, but input normalization alone does not migrate policy keys. Each authorization calls the host once, never retrying a denial under another alias. Turning a person's personal-fallback opt-in on now wakes only that person's own waiting turns instead of every waiting turn in the organization, because no other session can place on their personal accounts.
- da01634: Add a provider-neutral explicit model-account choice for sessions and a person's own personal-fallback opt-in. `GET`/`PUT /v1/workspaces/{workspaceId}/sessions/{sessionId}/model-account` lists the workspace's shared accounts and the caller's own personal accounts with whether each can be chosen, and sets or clears an explicit choice; the database still decides, so a personal account is accepted only for its owner's private session or Personal workspace while personal accounts are allowed. An ownerless session lists every account as not choosable (`session_has_no_owner`). `GET`/`PATCH /v1/organizations/{organizationId}/me/model-account-preferences` reads and changes only the caller's own opt-in; turning it on wakes waiting turns so they can fall back at once. The SDK gains `getSessionModelAccount`, `setSessionModelAccount`, `getModelAccountPreferences` and `updateModelAccountPreferences`. Rolling migration 0729 adds the owner's own access to their preferences row and nothing else. `isCodexAccountEvent` in `@opengeni/react` also matches `model_account.selection.changed`.
- 0152516: Add low-cardinality money and per-model usage metrics: `opengeni_model_responses_total{provider,model,priced}`, `opengeni_model_tokens_total{provider,model,type}` (input, cached input, cache write, output, reasoning), `opengeni_model_provider_cost_micros_total{provider,model,payer,pricing_source}` (estimated upstream cost), `opengeni_model_credits_charged_micros_total{provider,model,funding}` (credits debited, promotional grant vs general credit), and paid credit purchases `opengeni_credit_purchases_total{mode}`, `opengeni_credit_purchased_micros_total{mode}` and `opengeni_credit_purchase_paid_usd_micros_total{mode}`. `model` is the bounded deployment catalog product id; account and user ids are never labels. A raced Stripe checkout delivery no longer double-counts `opengeni_credit_micros_total{kind="topup"}`.
- 560acdd: Sending a new chat with connectors on Customize (following workspace connectors, optionally minus exclusions) no longer fails with a draft conflict. The exact-draft check now treats the saved draft and the create request as the same connector policy, and the web composer no longer shows "Draft not saved" after a Send whose draft did save.
- 259d77e: Tell the model plainly when an `exec_command` call was proven never started
  (the sandbox was not ready before dispatch): its recorded result now says
  nothing ran and it is safe to run again, instead of the generic interrupted,
  outcome-unknown result. Every other interrupted call keeps the existing result.
- eb68b58: Notification webhooks now carry the notification itself. `session.notification.posted` deliveries include its bounded `key`, `title`, `subtitle`, `body`, `facts`, `link`, `urgency`, `replaced`, and member `recipientSubjectId`/`sender`, and `session.notification.withdrawn` includes its `key`, on both workspace and organization lanes. Other event fields are never copied. When Opengeni notified nobody because the session works for no person (an API key or service started it), the event and its webhook carry `undeliveredReason: "no_human_recipient"`, so an integration can deliver it itself.

  Deployment policy no longer narrows an explicit request silently. A resolved agent configuration now reports `unavailableReasons` next to `unavailable`, naming why each capability is off. Updating a session's tool policy with first-party tools the deployment disables now fails with 422, naming every such tool and the allowed set; tools echoed from the session's stored selection or defaults are still filtered as before, so a later policy change never blocks an unrelated edit.

- 6b506e5: Park terminal connected-command output release work while its runner is disconnected. Reconnect makes overdue output eligible again without changing custody receipts, retry dates or retirement settlement.
- 906d3c2: Preserve the exact scheduler authority label and immutable curated Skill artifacts during the branding refresh so scheduled dispatch and pinned library discovery remain compatible.

  Refresh the canonical browser artifact kernels to match the branding-updated Rust source identity.

- 38b1ba1: Use Opengeni in product copy and Slack manifest defaults, add a clearly labeled staging icon, and accept both current and historical Slack installation names without rewriting saved credentials or receipts. Expose the Opengeni chat facade while preserving the existing `OpenGeni` export and public identifiers.
- 6960770: Opper is a first-class model provider with the same three rails as OpenRouter and Vercel AI Gateway. `OPENGENI_OPPER_API_KEY` adds reviewed EU-pinned `opper/vertexai/gemini-3.8-flash-eu` and `opper/aws/claude-sonnet-4-6-eu` routes billed in Opengeni credits at the exact Opper-reported cost +5% (reviewed list price as fallback); workspace admins can connect their own Opper key (`workspace-opper/…`, billed to their Opper account) and add exact custom Opper ids; organization owners can connect Opper once for every shared workspace (`organization-opper/…`). The SDK adds `listWorkspaceOpperCustomModels`, `createWorkspaceOpperCustomModel`, `deleteWorkspaceOpperCustomModel`, `ModelConnectionAccessKind`, and `"opper"` as an organization model provider kind. Opper management keys (`op-mak-…`) are rejected with an explanation. Deployment catalog documents accept a reviewed `opperModels` list. Host `OPENGENI_MODEL_PROVIDERS_JSON` can no longer use the reserved `opper`, `workspace-opper`, or `organization-opper` provider ids; move a hand-written Opper registry entry to `OPENGENI_OPPER_API_KEY`. Rolling migration `0636_opper_model_providers.sql` widens the provider-kind, lifecycle-fact, and analytics allow-lists.
- 9a252af: An organization Claude subscription that is allowed in personal workspaces now offers its models there. Its model rows used the organization API-key scope, which hides everything from personal workspaces, so the model picker showed no Claude models and admission could not resolve one. Claude subscription model rows are now readable from any workspace of the organization; the subscription's own workspace and personal-workspace access still decides where it can be used, and API-key provider models keep the existing rule.
- 7b825ec: Organization administrators can see and redeem Codex usage limit resets for organization-managed subscription accounts on the organization Models account page, including accounts that serve no workspaces. Organization account rows show the reset count. Redemption stays a signed-in human administrator action; agents and non-administrators are refused.
- a4f19c2: Organization owners and admins can now remove their own access to a shared workspace from the organization settings, the same way they already grant or change it, including workspaces an organization API key created for an embedded tenant. They can also list, add, change, and remove members from any shared workspace's own Members page, whether or not they hold a role in that workspace. The organization Workspaces list and each person's Workspace access editor gain a name search for organizations with many shared workspaces.
- 55eb9b0: Personal workspace owners can view and take over their own live sessions. The owner grant now includes `stream:view`, `stream:control`, `stream:acknowledge`, `terminal:attach` and `files:write`, so joining a browser or computer sign-in handoff no longer fails with 403. Delegation permissions stay excluded.
- 63bf721: Prepare a complete personal or workspace MCP connection once, with non-secret headers and protected secret-field mappings. People enter only the missing key in the conversation card; authorized agents that already have credentials use the same native Connect verification and storage lifecycle without another confirmation card.

  Connection, installation and receipt writes are atomic. Exact retries do not repeat verification or create duplicate accounts. The agent path intersects frozen attempt permissions with live ownership, selection, policy and execution fences, and never makes new tools available inside an already accepted attempt. Existing OAuth and explicit account selections remain separate and unchanged.

  Deploy matching API and worker packages before using direct agent setup. Historical attempt catalogs without the frozen permission snapshot do not gain new setup authority.

- bd61cb7: Preserve published migration identities when checking ordinal collisions across
  main and production, and include maintenance probes in historical replay fixtures.
- d060b10: Tests now account for the organization privacy preferences table and for the schedule audience column, which stays outside the execution digest.
- 83af41e: Allow an authorized private-session internal-update attempt to create a same-owner
  private child while preserving service audit attribution and the existing causal
  human, ownership, attempt and interruption checks.

  Rolling migration 0654 binds insert attribution to the capability's recorded
  parent turn instead of requiring a human audit initiator.

- 78c28ca: When a sandbox is gone, all of its background commands now settle at once. The reaper used to settle each retained command only after its own provider probe, at most 20 per 30-second sweep, so a box with 35 commands that Modal had already ended took 11 more minutes to clear while the session waited. The first probe that finds the exact current box missing now retires the whole box in one transaction: every command, open request, terminal and process holder is settled, the lease goes cold, and a turn waiting on the box is woken. Commands lost with their sandbox now tell the agent "`cmd` is no longer running because its sandbox was shut down or lost; whether it finished is unknown. Check its effects before running it again." instead of "result unavailable", and the session's Incoming panel shows several such results as one row with a single dismiss action.
- 9a7c8fe: Sites published from an "Only me" chat are readable by the whole workspace again. The private-chat row policy had also been applied to Site versions and Site history through their source-chat column, so other members saw the Site listed but could not open any version. Versions and history now follow workspace access only; the source chat, turn and attempt stay redacted for anyone who cannot read that chat. A Site with no version the viewer can open now shows a clear message with Retry instead of loading forever.
- 5d42a57: Queue-row Steer now clears a previous admission block just like Send, ordinary Steer and Resume. Repair unchanged historical queue Steer requests that left their old block in place, retaining a durable workflow wake until admission. Paused recoveries and subscription capacity waits remain resumable and are not cancelled based on age.
- a9f5b24: Add provider-neutral inference-source modes for automatic, workspace-only, and
  organization-only account selection. Keep workspace and organization source
  membership and authorization policy separate on a canonical shared connection,
  while retaining the legacy `useOrganizationAccounts` setting as a compatible
  projection. Update the SQL settings resolver so mixed legacy/new settings
  resolve identically in PostgreSQL and TypeScript.
- 7b51a1a: Record the maintenance work-check migration as an appended migration in the release schema contract.
- 10624f7: The retained-process inventory (migration 0637, rolling) now classifies a process durably adopted as a session background command by that command, as the reconciliation claim already did: `background_running` is session-owned live work and never counts toward `opengeni_retained_processes_terminal_owner_backlog`, while `background_stopping` (a stop was requested but no exit/loss proof yet) still does. A server the agent leaves running after its turn no longer fires `OpenGeniRetainedProcessTerminalOwnerBacklog`.
- 2fb5ec6: Record operator-retired child work as a visible, non-actionable parent timeline receipt, without waking the parent or creating pending execution input.
- feb1737: Operators can now see how long live sandboxes have gone without saving their workspace. The reaper publishes `opengeni_sandbox_checkpoint_staleness{kind="dirty"|"stale_4h"|"stale_12h"}` and `opengeni_sandbox_checkpoint_age_max_seconds` for live Modal sandboxes holding a write their last checkpoint did not capture, aged from the first such write (rolling migration 0672 adds the content-free inventory function). The new warning alert `OpenGeniSandboxCheckpointStale` fires when a sandbox has held unsaved changes for over 12 hours, half the default provider lifetime, and the sandbox dashboard gains panels for unsaved changes, the oldest unsaved change and skipped warm checkpoints.
- d2abf63: A schedule that reuses one session with skip-overlap now runs again after an occurrence fails. Before, the failed session never counted as idle, so every later occurrence was skipped as overlapping. Occurrences still skip while the session is running, queued, waiting or awaiting a person.
- 7926f10: The idle-session archive now measures activity by turns only. Bulk maintenance that touches `sessions.updated_at`, and bookkeeping events appended to idle sessions, no longer keep a long-idle session live. One maintenance pass also keeps archiving batches until its time budget ends, so a backlog drains after the archive is first enabled.
- 1041a61: Store per-attempt tool catalogs and model-request snapshots once per session in content-addressed session blobs, and compact existing rows losslessly in the background.
- 8cf9e0a: Compact session list entries (`listSessionSummaryPage`) now include optional `model` and `reasoningEffort`, so navigation surfaces can name the model a session runs on without loading its detail. The value is the latest started turn's model and effort, or the session's stored default when an explicit model change is newer or no turn has started yet; it costs two fixed index probes and one primary-key lookup per row. They are display-only: `getSession` remains authoritative for the composer default. When the SDK projects an older server's full pages, the fields carry each session's effective model.
- 132684f: The durable recovery monitor now reports how long the single oldest recovering session has been past its recorded recovery due time (`summarizeSessionRecoveryBacklog`), and how many recovering sessions are still inside their recorded provider Retry-After or connectivity backoff. `OpenGeniSessionRecoveryBacklogStale` pages only when one session stays more than 10 minutes past due, so sustained provider rate limits that keep some session in backoff no longer page.
- 726bdc1: Add `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/skills` and SDK `updateSessionSkills` to replace the Skills a session carries itself. It uses the session's tool-policy version, applies from the next turn and records a `session.skills.updated` event; an agent can only remove Skills.
- dde17a8: Migration 0737 (Site audiences) lifts FORCE row security with plain `ALTER TABLE ... NO FORCE` statements on the four tables it reads and writes, and checks that every existing Site stays workspace-visible before it restores FORCE, so the check sees every row under the production migration owner.
- 6d97d6a: Pinning a Site checks that the caller can see it with a single lookup (`isWorkspaceArtifactVisible`) instead of loading the Site's full history, and the artifact catalog route tests now cover the Site audience: catalog Sites carry `visibility`, and pinning someone else's Only me Site answers 404 without writing a pin.
- bc1f47f: Read only target session identity during authorization instead of expanding chat content and controls. Preserve the late visibility check, account matching, and request-scoped read reuse.
- 3179009: The checkpoint staleness alert no longer misses unsaved sandbox changes. `opengeni_sandbox_checkpoint_staleness` and `opengeni_sandbox_checkpoint_age_max_seconds` checked only the newest captured write for a settlement after the checkpoint, so a long-running background command that outlived a newer, already-settled write left the box looking clean. Any captured write on the box that settled after the checkpoint now counts, aged from that checkpoint, using a new index on settled writes so the probe stays cheap. An attached desktop or terminal tab, or a browser or computer controller, can change files without being recorded, so it now counts too, including one that was attached and detached again since the last save, aged from the later of the checkpoint and the first attach.
- a9a0395: Add a stateless OpenAI-compatible Chat Completions endpoint for single model calls without tools (`POST /v1/workspaces/:workspaceId/chat/completions`, `GET /v1/workspaces/:workspaceId/models`). Calls route through the workspace model catalog, including Codex, Claude and SuperGrok subscription accounts, admit on a positive credit balance, and settle actual usage once per request. Session titles use the same single-call path and stay on the turn's subscription account (Codex titles with `codex/gpt-6-luna`, Claude with Haiku 5.5).
- 7ce535f: Session reads no longer return model control tokens such as `<|fim_suffix|>` in automatic titles stored before write-time stripping existed. The API, MCP session detail, search, mobile and rename prompts now show the clean title. Human renames are returned unchanged, and the stored row is not rewritten. `cleanStoredSessionTitle` is exported from contracts for clients that read raw titles.
- d7be9e8: Prepare accepted subscription authority for each provider's own cutover. Every carrier of accepted authority (sessions, turns, scheduled tasks and their revisions, system updates and outbox rows) records when it was accepted, and a new owner-only compatibility relation can hold the accepted authority a provider's cutover carries over from its legacy columns, copied in the database from the exact source each path uses and checked at commit. Both personal-authority checks read these records after a provider's cutover. Nothing changes today: no provider has a cutover that uses them, so Codex and every other provider behave exactly as before.
- 2be8529: Scheduled and inbox work now keeps the subscription authority it was accepted with. An internal turn delivered into an earlier turn's context, and a scheduled occurrence, must carry the accepted subscription authority they copy, and scheduled Claude work is checked like SuperGrok's: admission, occurrences, the generated session and the scheduled turn compare the accepted Claude account choice, and a run whose personal Claude account was disconnected fails at claim. Connecting a personal Claude account no longer fails, and disconnecting a personal SuperGrok or Claude account now revokes its access, on databases whose owner is bound by row security; access left behind by earlier disconnects is revoked.
- 340472b: Sessions on the shared subscription core keep their account while the provider's prompt cache is warm. A session moves only when its account can no longer serve it, its model changes or a pin changes, or once it has been idle longer than the cache lifetime the provider's adapter declares. Warmth is no longer carried to an account the session has never used, and parallel placements of one session agree on one account.
- 90561db: Add provider-neutral live usage reads for subscription accounts outside a workspace pool: an organization administrator can read an organization account's usage, and a person can read their own personal account's usage from their Personal workspace, through new owner-only database routines. No provider uses them yet, so behaviour is unchanged.
- 35fb6fd: Once a deployment records the Claude cutover, organization administrators can refresh an organization Claude account's usage live from organization settings, and people can refresh their own personal Claude account's usage live from their Personal workspace, as before the move to the shared subscription core. Nothing changes until that cutover.
- df83216: Let the shared subscription runtime manage API-key connections the same way as subscription connections. Each provider on the shared core now records which kind of connection it uses, and the shared routines, writers and placement read that instead of assuming a subscription, so a future API-key connector (such as OpenRouter or Vercel AI Gateway) needs only its own adapter and registration. A shared settlement step now records an upstream refusal the same way for every provider, with per-provider fallback times when the upstream gives no reset. No provider, table or route is added, and Codex behaves exactly as before. A conformance suite now runs the same placement, lease, request, failover, health and wait tests for Codex and for a test-only API-key connector.
- 35fb6fd: Claude subscriptions move onto the shared subscription core in one drained maintenance migration (0748), on the same receipt, readiness and parity report as the SuperGrok cutover. Every organization, workspace and personal Claude account, OAuth login or setup token, becomes a shared-core connection with one readable secret copy; pins, rotation settings, current usage with its per-model cooldowns, live leases, waiting turns and their pending wakes, each live turn's spent token refresh and the accepted authority of queued, scheduled and inbox work carry over with exact parity, and any mismatch aborts the migration with nothing changed. OAuth logins and setup tokens are never merged. User-scoped accounts become their owner's personal connections, and the six legacy Claude tables, including the usage table, become read-only. A binary that includes 0748 refuses to start until the cutover has committed. The SuperGrok and Claude cutovers run in one maintenance window or separately.
- ab4378c: Claude account routes, setup-token and browser sign-in, and Claude access settings can now run on the shared subscription core once a deployment records the Claude cutover. Until then every Claude, SuperGrok and Codex route answers exactly as before. A reconnect on the core replaces exactly the account and version it names.
- 733f01d: Claude account usage, model readiness and organization custom-model admission can now run on the shared subscription core, the same runtime Codex uses, once a deployment records the Claude cutover. Until then every Claude and Codex route, model listing and admission answers exactly as before. Usage decoding can now receive the models a connection serves.
- 0613dca: Add provider-neutral subscription-core database routines. The shared subscription runtime now passes the provider as data to one set of routines for credential refresh, connection health, accepted authority and personal account management, instead of calling routines named after one provider. Codex behaves exactly as before: the new routines are equivalent, take the same locks in the same order, and the Codex-named routines stay in place for binaries that still use them. A small registry of providers on the shared core supplies the few per-provider facts these routines need, and any provider without a registry entry is refused.
- f7c7eec: Make the shared subscription core's organization reach, auto-assignment, plan-change history, workspace inventory and capacity wakes keyed by provider, and move the cutover planner's rules into a provider-neutral module. A later provider's cutover and runtime use the same rows and routines with the provider as data instead of new provider-named copies. Codex behaves exactly as before: its existing reach, auto-assignment rows and plan output are kept, workspaces and Personal workspaces created later are assigned as before, and the Codex-named routines stay in place for binaries that still call them.
- ce61681: Compare the shared subscription core with the legacy Codex, Claude and SuperGrok
  account selection on every subscription turn. A legacy adapter that issues
  only reads builds the core's placement world from today's tables under the
  turn's own session access, and the worker records content-free metrics: security parity of the
  legacy account, the reference checker's violations of the core's decision,
  would-switch, and the legacy decision inputs. The comparison runs in the
  background (at most two at once per worker), fails open, is bounded by
  `OPENGENI_SUBSCRIPTION_CORE_SHADOW_TIMEOUT_MS` (default 250 ms, at most
  1000 ms), is on by default and can be turned off with
  `OPENGENI_SUBSCRIPTION_CORE_SHADOW_ENABLED=false`. Placement is unchanged; no
  migration is required.
- d94b666: Move subscription account administration onto the shared provider-neutral core. Account pools, primary account, rotation, workspace source, allocator, extra credits, rename, connect, disconnect and catalog readiness now take the provider as data, and Codex keeps its existing functions, shapes and messages as thin wrappers.
- 43f9b03: Run the shared subscription runtime as one provider-neutral implementation. Placement, leases, credential loading and refresh, health, request reservation and waiter cleanup now live in shared modules that take the provider as data, and Codex plugs in through a small adapter. Codex behaves exactly as before and every existing function keeps its name. A check fails if a shared module names a provider or branches on one.
- 347b581: SuperGrok account routes, access settings and connection writers can now run on the shared subscription core, the same runtime Codex uses, once a deployment records the SuperGrok cutover. Until then every SuperGrok and Codex route answers exactly as before. Accepted work also writes the newer authority record for every registered provider and copies its compatibility record on every path that carries authority forward, and a personal connection can record its credential format.
- 35fb6fd: SuperGrok subscriptions move onto the shared subscription core in one drained maintenance migration (0747). Every organization, workspace and personal SuperGrok account becomes a shared-core connection with one readable secret copy; pins, rotation settings, quota, live leases, waiting turns and their pending wakes, in-flight videos and the accepted authority of queued, scheduled and inbox work carry over with exact parity, and any mismatch aborts the migration with nothing changed. User-scoped accounts become their owner's personal connections, and the legacy SuperGrok tables become read-only. A binary that includes 0747 refuses to start until the cutover has committed. Steer and Cancel now end a waiting turn's shared-core wait for every provider.
- 35fb6fd: Remove the legacy SuperGrok subscription runtime now that SuperGrok runs only on the shared subscription core. The old SuperGrok account repository, its waiters, leases, pins, legacy quota refresh, organization surface, API authorization helper, legacy video token envelope and shadow comparison are deleted; a SuperGrok request that does not reach the shared core fails closed, as it does during maintenance. The stateless Chat Completions API (`GET /v1/workspaces/:workspaceId/models`, `POST .../chat/completions`) no longer lists or serves SuperGrok subscription models, because the shared core's single-call operation is Codex-only; a request for one answers `model_not_found`. A SuperGrok video operation whose stored credential is not a shared-core connection reference now ends at its recovery deadline instead of retrying. The legacy tables stay read-only. Claude is unchanged. Rolling change; no migration.
- 35fb6fd: A drained maintenance migration (0751) retires the legacy subscription pool runtime after the SuperGrok and Claude cutovers. It drops the legacy SuperGrok and Claude pool routines, the triggers and row policies that call them, and the Codex-named twins of the shared subscription routines, each by exact name and never by cascade. It refuses with nothing changed unless the application sessions are drained, every provider's cutover receipt is committed and nothing that stays depends on a retired object. The organization reach rows take provider-free names, must name a connection of their own provider and lose their Codex default. Legacy tables, receipts and the read-only restrictions stay. A binary that includes 0751 refuses to start until it has run, and older binaries refuse a retired database.

  The retained Codex session-account endpoint delegates to the shared account-choice transaction, preserving its response and event shape. Automatic resets only Codex, and an unchanged choice acknowledges success without rewriting the binding.

- b6ce509: A personal Codex account is now used in its owner's private sessions and Personal workspace on databases whose owner is bound by row security. Before, new turns and scheduled tasks there were frozen without the owner's personal account, so the work used shared capacity or waited for it. Values frozen earlier are unchanged. A quarantined personal Codex account on such a database also returns to service once its retry time passes; before, health recovery never found it.
- 35fb6fd: Let a personal subscription account's owner, when also an organization administrator,
  explicitly share that account through the existing access editor. The form explains
  consumer-plan limits and requires a chosen workspace reach before sharing. Other
  administrators cannot discover or convert someone else's personal account.

  Migration 0752 adds the owner- and version-fenced transition. The connection identity,
  encrypted credentials, quota, pins and accepted history stay intact. Old personal
  resource authority is revoked, never reinterpreted as shared authority. Conversion
  and the requested reach commit together; stale versions, conflicting upstream
  identities and invalid reach leave the personal account unchanged.

- 1727b17: Keep private-session access when Claude and SuperGrok capacity handling runs
  under the shared pool-worker database subject. The capacity-waiter lookup, the
  workflow's work peek, lease acquisition, session pins and last-account metadata
  now re-establish the acting turn's frozen initiating human, so a `user_private`
  session waits and resumes like a shared one; arming and reconciling a shared
  pool's wait already run without a subject. Previously the workflow peek treated
  a waiting private session as runnable and the capacity workflow could not find
  its waiter. The pool worker still cannot see any other member's private session,
  and an ambient actor is never combined with another member's human. An
  immediate wake-up after a member reconnects an account or changes a shared pool
  now reaches every waiter of that exact pool, including other members' private
  waiters, without giving that member access to them; it previously waited up to
  60 seconds for the periodic recheck. A wait that cannot be armed for a
  non-database reason now fails the turn with the explicit, retryable
  `<provider>_capacity_wait_unavailable` state.

  No database migration or configuration change is required.

- a34d8f5: Agent messages and Agent Steers now run on the receiving session's Claude and SuperGrok pool instead of the sender's. The new turn keeps the sender's causal human for permissions, but its pool comes from the receiver's execution-context turn, else its latest accepted turn, else its initial snapshot. A personal pool is kept only when its owner is that same human; otherwise the receiver uses its organization or workspace pool (a model served only by that personal pool fails closed), so a personal account never funds another person's session. Prompts from service and operator actors (organization API keys, the Slack bridge), sessions created without a human creator, and internal updates without causal authority now resolve the organization or workspace pool instead of always freezing the workspace pool. Already accepted turns, queued updates and child-result outbox rows keep their frozen snapshots. Codex is unaffected because its allocator source is captured from the receiving workspace at first lease. No migration or configuration change is required.
- 35fb6fd: Preserve per-person fallback consent during the Claude and SuperGrok cutovers.
  Existing warm automatic personal bindings survive a fallback opt-out until
  re-selection, while live revocation still takes effect. Cross-provider recovery
  counts refusals and serving changes together and reports a typed exhausted
  failure at the bound. Unknown account catalogs no longer imply an entitlement
  denial based on another account's plan.

  Take the membership lifecycle fence before organization access reads so explicit
  personal-account sharing cannot deadlock against management revocation. Cover
  sharing, refresh and disconnect races without changing existing credentials,
  pins, leases, quota, accepted authority or history.

- fe01a43: Make newly connected personal accounts usable automatically in their owner's Personal workspace while preserving permission and accepted-authority checks. Include unknown quota in normal rotation. Persist generation-fenced Codex model catalogs so allocation, waiter recovery and extra-credit admission use the same account capabilities, including retained accepted models. Correct credit-refusal retry deadlines and extend independent policy verification.
- 35fb6fd: Connect portable subscription serving, candidate-aware durable recovery, and exact shared-session personal consent to the shared core. Preserve accepted models, authority and canonical history while executing an administrator-configured fallback. Add lease-backed, idempotent subscription selection and switch events. Runtime activation remains deployment-gated; remote-compaction conversion is not enabled.
- 9975001: Prepare SuperGrok chat turns for the shared subscription core. A SuperGrok turn reads its provider route once: without the SuperGrok cutover it runs exactly as before; during maintenance it fails with typed copy; on the core it is placed, leased and funded like a Codex turn, every model request is reserved and settled before and after it goes out, and an unknown outcome is never replayed. The SuperGrok transport gains request identity and settlement hooks. Nothing changes today: no organization has the SuperGrok cutover, so SuperGrok and Codex behave exactly as before.
- 35fb6fd: On the shared subscription core (still inactive for SuperGrok), a person whose SuperGrok account is personal now shows as connected in SuperGrok status. Only the signed-in owner (or an agent with their full access) gets a live check of it there. Before the owner's own private turn treats their personal account as still exhausted, its billing is re-checked; no other turn re-checks it.
- 5a4a742: Prepare SuperGrok refusals and capacity waits for the shared subscription core. The shared core's capacity waiter, its wakes and its Steer and Cancel cleanup now serve any provider, with each provider's own session events, and a SuperGrok turn on the core records a refusal against its account, moves to another account within the shared limit or waits durably for capacity. Nothing changes today: no organization has the SuperGrok cutover, and Codex keeps its events, names and metrics exactly.
- 8906166: Targeted tool resolution, invocation, approvals and Site manifests evaluate one live fence per physical provider request instead of re-running nested caller, Site, registry, account and policy checks. The fence reads only the selected rows in a `statement_timeout`-bounded transaction, re-reads an organization key without a lock or write, and reads a pinned Site once per evaluation however many tools it pins. Authority that cannot be read within 2.5 seconds is answered as 503 `upstream_unavailable` with `details.code: "tool_authority_unavailable"` instead of a silently missing tool (404). `Server-Timing` adds `gw-fence`.
- 1382728: Let an idle chat become Only me when its only pending machine updates (finished background commands, child results, agent messages) carry the owner's own authority. Before, any pending update blocked the change with "must be fully quiescent", and idle chats keep those updates until their next turn, so they could never go private. Updates frozen with another person's connections, subscription authority or causal turn still block.
- 2889108: Retire temporary run-state snapshots atomically on every terminal turn transition and repair historical terminal-turn leftovers, preserving nonterminal approval and recovery state.
- 7bf1a02: Add per-workspace, exact-model compaction preferences with atomic independent
  reset, shared effective-limit projection and a discoverable Models settings page.
  Add the verified native Haiku 5.5 profile with a 95k compaction default and tiered
  comparison pricing. Keep request-byte safety independent of token preferences.
- 443ac28: Recover a turn when a managed sandbox command fails to start before dispatch
  inside an `exec_command` call. On every subscription-core route, checkpoint the
  answered model request first so the turn recovers with the existing
  connectivity backoff and limits instead of failing. The provable call is
  settled as not started (replay safe) rather than outcome unknown. Recoveries
  that interrupt a running tool now count toward the same budget until the turn
  makes tool progress, so they cannot loop without bound.

  A retryable failure that cannot recover automatically now says so instead of
  promising a retry. When recovery is exhausted, Retry stays available. Retry
  refusals now separate work that is still settling (`RETRY_EXECUTION_UNRESOLVED`)
  from a permanent unknown tool outcome (`RETRY_TOOL_OUTCOME_UNKNOWN`), and the
  web app tells the person what to do in each case. No migration or configuration
  change is required.

- 4750ce7: Upgrading to vaults no longer changes the execution digest of every existing schedule. Migration 0739 added the schedule `vault_policy` column, and because a schedule's digest hashes its whole row, every stored digest stopped matching, so 0753 refused to run (`0753 cannot reproduce a stored scheduled-task execution digest`) on any database that had schedules. 0739 now leaves the default vault policy out of the digest (a narrowed policy still changes it, like any other execution change) and refuses to complete if any schedule digest that reproduced before it no longer does.
- 4e19def: A chat no longer stops accepting messages when a shared connector account that a voice session or an edited prompt still carries was disconnected or reconnected. The voice handoff (or edit) now runs without that account and records the gap, instead of the turn being refused and the chat being blocked on every later message.
- 4b568b4: Ending a voice session no longer starts or steers an agent turn when the remaining transcript holds only voice-assistant lines. Assistant chatter such as "Still checking." could previously supersede a running turn or wake an idle session; the handoff now requires at least one finalized user transcript after the latest delegation.
- d7b947e: A running background command (a dev server, a long benchmark, a command whose output is still draining) no longer stops workspace checkpoints. Warm checkpoints taken during a turn were refused while a background command held the sandbox, potentially leaving later changes without a recovery point if the provider instance was lost. When the checkpoint is a Modal native snapshot (a point-in-time image of the paused box), it now runs around the exact active, unsupervised retained commands on the same box. A file a command was writing at that instant can be saved half-written; that is the accepted trade-off. Tar-style checkpoints still wait for commands. Such a checkpoint is recorded one generation behind the workspace, so it is never reported complete: periodic checkpoints continue, and a restore after provider loss shows the usual discontinuity warning. Rolling migration 0659 records the claim so a drain, a drain takeover or a late adoption can never publish it as the final workspace. Viewers, sibling turns, in-flight requests and supervised commands still block a checkpoint. The worker exports `opengeni_workspace_capture_skipped_total{backend,reason}` for warm checkpoint attempts that could not start.
- c245c16: Workspace deletion no longer deadlocks with ordinary writers in the same organization (previously a retryable 503 `DATABASE_CONTENTION`): it locks the organization row `FOR NO KEY UPDATE`, takes the target's workspace-control prefix before its workspace row, and locks sibling workspace rows only `FOR KEY SHARE`. A deletion blocked by retained editable documents, spreadsheets, or presentations now names them in its 409 message.
- Updated dependencies [fc57bd2]
- Updated dependencies [04ebc42]
- Updated dependencies [dbb2cb6]
- Updated dependencies [e03f1ff]
- Updated dependencies [c2f4153]
- Updated dependencies [de2d721]
- Updated dependencies [055015d]
- Updated dependencies [1ee99c1]
- Updated dependencies [1756cfe]
- Updated dependencies [40e2542]
- Updated dependencies [6861501]
- Updated dependencies [e8a3d83]
- Updated dependencies [69a3f42]
- Updated dependencies [ab1ea00]
- Updated dependencies [f5ad69f]
- Updated dependencies [bfed4f1]
- Updated dependencies [4532435]
- Updated dependencies [92b6aef]
- Updated dependencies [851cbdc]
- Updated dependencies [d393b9b]
- Updated dependencies [6d5f287]
- Updated dependencies [0eae048]
- Updated dependencies [17b262f]
- Updated dependencies [f96605f]
- Updated dependencies [496ce55]
- Updated dependencies [3822e5f]
- Updated dependencies [3962da3]
- Updated dependencies [c4dd318]
- Updated dependencies [adf96dc]
- Updated dependencies [aeabfec]
- Updated dependencies [ce7b403]
- Updated dependencies [445baf4]
- Updated dependencies [5b4a738]
- Updated dependencies [334c470]
- Updated dependencies [96d7167]
- Updated dependencies [f7d53b2]
- Updated dependencies [c13d080]
- Updated dependencies [061ae01]
- Updated dependencies [810d1d9]
- Updated dependencies [8e7cb8d]
- Updated dependencies [6313dd8]
- Updated dependencies [945490f]
- Updated dependencies [8e878ac]
- Updated dependencies [c502add]
- Updated dependencies [0001298]
- Updated dependencies [72b0312]
- Updated dependencies [9701372]
- Updated dependencies [bc40348]
- Updated dependencies [5eb1c32]
- Updated dependencies [da01634]
- Updated dependencies [ab3306a]
- Updated dependencies [4cb80a9]
- Updated dependencies [9ffe528]
- Updated dependencies [c7f468c]
- Updated dependencies [4435af0]
- Updated dependencies [eb68b58]
- Updated dependencies [945c247]
- Updated dependencies [38b1ba1]
- Updated dependencies [1da17d9]
- Updated dependencies [6960770]
- Updated dependencies [4c73e2e]
- Updated dependencies [3426850]
- Updated dependencies [412671a]
- Updated dependencies [63bf721]
- Updated dependencies [3a4a435]
- Updated dependencies [14343e4]
- Updated dependencies [2b8ee21]
- Updated dependencies [1489689]
- Updated dependencies [71c42bf]
- Updated dependencies [a9f5b24]
- Updated dependencies [a390b9e]
- Updated dependencies [6861501]
- Updated dependencies [a81a567]
- Updated dependencies [6861501]
- Updated dependencies [6861501]
- Updated dependencies [322f26c]
- Updated dependencies [945c247]
- Updated dependencies [e8c3557]
- Updated dependencies [5cdfbaa]
- Updated dependencies [5cb6d71]
- Updated dependencies [732a788]
- Updated dependencies [8cf9e0a]
- Updated dependencies [726bdc1]
- Updated dependencies [11779ba]
- Updated dependencies [66b3026]
- Updated dependencies [844c089]
- Updated dependencies [7ce535f]
- Updated dependencies [340472b]
- Updated dependencies [df83216]
- Updated dependencies [733f01d]
- Updated dependencies [4d5934e]
- Updated dependencies [ce61681]
- Updated dependencies [43f9b03]
- Updated dependencies [41e4795]
- Updated dependencies [35fb6fd]
- Updated dependencies [fe01a43]
- Updated dependencies [35fb6fd]
- Updated dependencies [9975001]
- Updated dependencies [7bf1a02]
- Updated dependencies [a13bf1a]
- Updated dependencies [51c2be9]
- Updated dependencies [aa0f483]
- Updated dependencies [a91718c]
  - @opengeni/contracts@2.0.0
  - @opengeni/config@2.0.0
  - @opengeni/subscriptions@2.0.0
  - @opengeni/observability@2.0.0
  - @opengeni/codex@2.0.0
  - @opengeni/codemode@2.0.0
  - @opengeni/xai-subscription@2.0.0
  - @opengeni/network@2.0.0

## 1.4.4

### Patch Changes

- db21f93: Start first turns promptly under concurrent load in one organization. The turn claim now takes the organization-membership fence in shared mode, so claims no longer serialize each other, while membership mutators still fence them.
- Updated dependencies [6384dbd]
- Updated dependencies [2edfa4c]
  - @opengeni/contracts@1.4.4
  - @opengeni/observability@1.4.4
  - @opengeni/codemode@1.4.4
  - @opengeni/codex@1.4.4
  - @opengeni/config@1.4.4
  - @opengeni/network@1.4.4

## 1.4.3

### Patch Changes

- Updated dependencies [1a05862]
  - @opengeni/config@1.4.3
  - @opengeni/codemode@1.4.3
  - @opengeni/codex@1.4.3
  - @opengeni/contracts@1.4.3
  - @opengeni/network@1.4.3
  - @opengeni/observability@1.4.3

## 1.4.2

### Patch Changes

- @opengeni/codemode@1.4.2
- @opengeni/codex@1.4.2
- @opengeni/config@1.4.2
- @opengeni/contracts@1.4.2
- @opengeni/network@1.4.2
- @opengeni/observability@1.4.2

## 1.4.1

### Patch Changes

- fe1f64d: Codemode terminal settlement takes the session lock prefix before updating its journal row, so it no longer deadlocks against the client's re-notify of the same operation (`POST /codemode/calls` 500s with SQLSTATE 40P01). Submit and claim retry deadlock/serialization victims, an exhausted victim returns a typed retryable 503, and the Codemode client resubmits and re-reads the same operation id after a known-outcome transient 5xx.
- e6d35b9: Sandboxes kept warm only by Browser or Computer sessions are now visible: the reaper publishes `opengeni_sandbox_leases_interaction_only{idle_bucket}` by time since the sessions were last used, and an alert fires when more than five such boxes have been idle for over two hours.
- 55bddfe: A `write_stdin` poll that races the reaper's settlement of an exited background command now returns the durable exit result instead of failing the turn with `sandbox_mutation_output_rejected`. The provider call is still made once and never replayed, and its output stays rejected.
- f290348: Signup credits now pay for dictation and live voice like general credits. Admission counts their remainder, each voice charge is allocated to them first, and balances report `coversVoice` on those grants. Other model-scoped promotional credits still do not cover voice.
- aedc3b9: A worker shutdown during sandbox provisioning no longer makes the session's sandbox unrecoverable or fails the turn. The dying attempt now finishes its own provisioning cleanup before exiting and never terminates a box it already published, so the replacement attempt resumes that same box. If an unpublished box disappears anyway, the session is no longer marked as having lost its workspace.
- Updated dependencies [fe1f64d]
- Updated dependencies [9145bad]
- Updated dependencies [f290348]
  - @opengeni/codemode@1.4.1
  - @opengeni/contracts@1.4.1
  - @opengeni/config@1.4.1
  - @opengeni/codex@1.4.1
  - @opengeni/observability@1.4.1
  - @opengeni/network@1.4.1

## 1.4.0

### Patch Changes

- bd9521c: Approval reviews read as one action: multi-item work no longer shows "batch" in titles, a Block reports its own reason and a `blocked` status, and an older request whose saved arguments cannot be recovered still offers Decline so the session never stays stuck.
- 5451b38: Distinguish an exact committed sandbox mutation receipt from rejection of its output after authority changes. Preserve the non-retryable typed failure through SDK tools and stop later dispatches in the same invocation without hiding uncertain batch items. Missing, mismatched, rolled-back, and caller-owned transaction receipts remain unknown; existing history and recovery authority are unchanged.
- 36ff885: Keep organization Slack bot metadata reads independent of the database root barrel while preserving the existing connection metadata API and subject-scoped access checks.
- Updated dependencies [bd9521c]
- Updated dependencies [664eabf]
- Updated dependencies [08ce841]
- Updated dependencies [673bb53]
- Updated dependencies [2a65d6e]
  - @opengeni/contracts@1.4.0
  - @opengeni/config@1.4.0
  - @opengeni/codemode@1.4.0
  - @opengeni/codex@1.4.0
  - @opengeni/observability@1.4.0
  - @opengeni/network@1.4.0

## 1.3.0

### Minor Changes

- 414d416: Support explicit organization sharing of installed Slack bots and durable bot posting from ordinary chats. Add bot inventory and organization-access SDK methods, preserve person-chosen scheduled destinations, and keep personal Slack identities separate.

### Patch Changes

- 1670f64: Keep the API process alive and answer a retryable 503 (`upstream_unavailable`, `details.code: DATABASE_UNAVAILABLE`) when the database terminates its connections during a deploy drain, failover, or restart, instead of crashing on an unhandled Slack interaction claim rejection or answering an opaque 500.
- 178b5ae: Unify connector Allow, Ask first and Block decisions across tool transports and settings. Add durable programmatic approval handles, exact stored-operation continuation, and shared review facts with portable React presentation and paginated protected details.

  Add lightweight Gmail message selection and bounded pagination/chunk helpers. Preserve exact access checks, uncertain outcomes and existing client compatibility. Deploy matching API, worker and native runtime artifacts through the documented maintenance migration.

- Updated dependencies [178b5ae]
- Updated dependencies [414d416]
  - @opengeni/contracts@1.3.0
  - @opengeni/codemode@1.3.0
  - @opengeni/observability@1.3.0
  - @opengeni/codex@1.3.0
  - @opengeni/config@1.3.0
  - @opengeni/network@1.3.0

## 1.2.0

### Minor Changes

- d870f32: Support model-scoped signup and coupon credits with a shared operator default and
  per-offer overrides. Update coverage at runtime, spend eligible promotions before
  general credits, and preserve allocation and retry accounting. Keep scoped coupon
  redemption separate from paid top-ups. Show credit funding in model selection and
  current coverage on demand in billing. Legacy unrestricted grants stay unrestricted.

### Patch Changes

- 7424e7c: Reject empty coupon IDs and invalid text boundaries in SQL credit policy updates,
  preserving the active policy when an update cannot be read by the application.
- 1033595: Preserve own-client provenance for database transaction admission and settlement failures so running sessions can recover their exact accepted turn after connection loss.
- Updated dependencies [21c8904]
- Updated dependencies [d870f32]
  - @opengeni/config@1.2.0
  - @opengeni/contracts@1.2.0
  - @opengeni/codemode@1.2.0
  - @opengeni/codex@1.2.0
  - @opengeni/observability@1.2.0
  - @opengeni/network@1.2.0

## 1.1.0

### Patch Changes

- c600e3a: Use the full scoped model catalog for goal continuation and validate goal Resume before changing state. Preserve specific admission pause reasons and show the actionable rationale in the existing goal controls.
- f895d19: Give durable worker recovery sole ownership of provider retries, add bounded backoff jitter, preserve nested HTTP error classification, and observe recovery outcomes across response and compaction attempts.
- 4cd01cd: Every organization is now session-tenancy activated (rolling migration 0611): private ("Only me") sessions, visibility changes, forks, and personal-resource grants no longer require a per-organization activation receipt, and the owner/admin Only-me setting defaults to enabled when an organization has never changed it (owners and admins can still turn it off). `OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED` and `Settings.organizationTenancyCanonicalActivationEnabled` are retired (the variable is accepted and ignored with a warning), the runtime posture no longer has an activation startup interlock, and the `db:activate-session-tenancy` operator command is removed.
- Updated dependencies [5fd6c55]
- Updated dependencies [c600e3a]
- Updated dependencies [411b3b5]
- Updated dependencies [208dec1]
- Updated dependencies [4cd01cd]
  - @opengeni/contracts@1.1.0
  - @opengeni/config@1.1.0
  - @opengeni/codemode@1.1.0
  - @opengeni/codex@1.1.0
  - @opengeni/observability@1.1.0
  - @opengeni/network@1.1.0

## 1.0.2

### Patch Changes

- ee6b145: Prioritize release acknowledgements for durably captured command output before replaying older uncaptured results.
- 6fccfa0: Release completed Connected Machine command output once its exact tool result is
  durable, instead of retaining it until a long turn ends. Preserve parallel and
  background output ownership, and allow failed final acknowledgements to retry.
  Persist independent background output custody after verified PostgreSQL capture,
  then reconcile release on its original connection even after worker loss.
- e16aa17: Use the receiving chat's accepted execution context for ordinary same-user agent updates, so different sender account selections do not fragment batches or change the receiving chat's accounts. Preserve explicit authorization for other users and restricted sources, and add factual model-only notes for known tool selection differences.
- cbe4357: Simple embedding path. An organization API key acting as a user (`asUser`) on a
  shared workspace of its own organization now adds that user's missing membership
  once, with conversation permissions, when the key holds `members:manage` plus
  those permissions; existing memberships are never changed. The `@opengeni/sdk/chat`
  `OpenGeni` facade derives `organizationId` from the key, maps `{ user, tenant }`,
  `{ user }` (one workspace per user), or `{ user, workspaceId }` to a workspace
  created on first use, and `og.workspaceId({ tenant } | { user } | { workspaceId })`
  translates your ids. The session proxy reports its resolved workspace in client
  config, so `<OpenGeniChat baseUrl="/api/opengeni" />` and
  `<SessionConversation baseUrl="/api/opengeni" sessionId={id} />` need no provider
  or workspace id. Explicit membership APIs and provider-based usage are unchanged.
- 9925fe2: Reduce raw Insights query overhead and read the current and comparison windows in separate bounded statements so larger default views can finish within the database timeout.
- Updated dependencies [4476ca7]
- Updated dependencies [f9e33b5]
- Updated dependencies [e16aa17]
  - @opengeni/contracts@1.0.1
  - @opengeni/observability@1.0.1
  - @opengeni/codemode@1.0.1
  - @opengeni/codex@1.0.1
  - @opengeni/config@1.0.1
  - @opengeni/network@1.0.1

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

## 6.7.2

### Patch Changes

- 6fee02a: Avoid recursive settlement projections for single leaf-session reads and reuse the same statement's complete root control node instead of recursively walking root ancestry. Child detection and direct summaries share one PostgreSQL statement snapshot; nonleaf summaries, nonroot ancestry and writer fences retain their existing recursive behavior.

## 6.7.1

### Patch Changes

- @opengeni/codemode@0.7.2

## 6.7.0

### Minor Changes

- 2f09c54: Add unified workspace/organization usage and visible-call readers over recorded
  facts without changing debit or access semantics.
  Distinguish deleted retained usage from private amounts and expose the prior
  cache denominator and historical telemetry coverage.
  Bound successful responses to a 60-second, authorization/visibility-fenced server
  cache and return an actionable friendly error for statement timeouts.
- 746464c: Add a launch-load safety switch that pauses new managed account sign-ups without affecting existing users. Rolling migration 0585 adds an append-only, operator-only runtime switch (`set_managed_auth_new_signups_enabled`, read by the API on every sign-up decision, so a flip applies to the next request with no restart), and `OPENGENI_MANAGED_AUTH_NEW_SIGNUPS_ENABLED=false` remains the deployment ceiling. While paused, email sign-up returns `403` with code `NEW_SIGNUPS_PAUSED` and Google/GitHub refuse unknown provider accounts with `error=signup_disabled`; sign-in, sessions, password reset, email verification, and invitation-bound account setup keep working. The managed-session client config gains an additive `newSignupsEnabled` field (absent means `true`), `@opengeni/contracts` exports `MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE`, `@opengeni/db` exports `readManagedAuthNewSignupsSwitch`, and the control worker publishes `opengeni_managed_auth_new_signups_runtime_enabled`.

### Patch Changes

- a0f5728: Keep messages from the same caller attempt together with Agent Steer so older messages do not trigger a later inference. Preserve context-before-Steer ordering when persisting model history with a goal snapshot, while retaining isolation between different callers and access settings.
- 3be5798: Prevent Bun PostgreSQL TLS upgrades from retaining encrypted traffic in the original TCP socket's unread queue. Preserve TLS negotiation, certificate policy, and lossless query results, with regression coverage for both driver entrypoints.
- 6ca71f6: Restore content-free model connection lifecycle facts for canonical Claude subscription accounts without changing account authorization or export privacy boundaries.
- 8ce490f: Support multiple Claude subscription accounts with shared workspace, organization and owning-user account controls, verified browser sign-in profiles, usage windows, exact credential leases and quota-aware rotation. Preserve accepted work during capacity waits and recovery. Upgrade existing encrypted subscription credentials through the documented maintenance migration before starting matching runtime binaries.
- fe2aa8c: Batch ordinary agent messages with compatible pending results when their originating turns have the same human and frozen access settings. Preserve each update's lineage and separate different access, unresolved origins, and Steer commands. Clarify that a child session's final answer is automatically delivered to its parent.
- 3395acc: Automatically reuse the existing send credential hook for approval/human-input responses, with atomic write-only MCP header updates and no integration changes.
- 6fc73e3: Remember the selected new-session visibility for the same user and workspace after creating a session, including when returning from another browser.
- 0fba21e: Schedule messages in existing chats without duplicating execution settings. Default conversational scheduling to the calling chat, add lossless message edits and guarded retargeting, and preserve captured account authority. Improve destination controls, exact prompt retrieval and filtered history paging; remove obsolete deployment guidance.
- 14e95e9: Redeem a Stripe promotion code at checkout: `createBillingCheckout` accepts `promotionCode`, and a fixed-amount USD code sets the credits by itself, so a $100 code buys exactly $100 of credits. Add `getBillingCheckout` to read whether a checkout's credits reached the balance; it also settles a completed checkout whose webhook is late, under the same ledger idempotency key. Organization setup can store the signup answer to "How do you want to use Opengeni?" once per person and organization.
- 8323e90: Run Slack account MCP tools through a reviewed Web API bridge while preserving OAuth, exact account authority, and tool approvals. Add scope-aware discovery and shared app/workspace request quotas for unlisted pilots. Preserve bot reaction and message tasks under throttled optional context, and remove unavailable generic Real-time Search.

  Migration 0597 requires stopped application processes and matching role provisioning before starting this release.

- 8f8629d: Remove an unused query import from the shared subscription-account repository so strict source-contract checks pass without changing account selection behavior.
- Updated dependencies [aa41b15]
- Updated dependencies [af57cf9]
- Updated dependencies [8ce490f]
- Updated dependencies [692a1f5]
- Updated dependencies [a651f55]
- Updated dependencies [e0d4bd4]
- Updated dependencies [c7c09fd]
- Updated dependencies [2f09c54]
- Updated dependencies [303ed6c]
- Updated dependencies [9ca494c]
- Updated dependencies [3cc26b5]
- Updated dependencies [3395acc]
- Updated dependencies [18216d2]
- Updated dependencies [81a5d9d]
- Updated dependencies [746464c]
- Updated dependencies [fa0a9ef]
- Updated dependencies [6cdc0aa]
- Updated dependencies [b32b5f6]
- Updated dependencies [0fba21e]
- Updated dependencies [97d4f07]
- Updated dependencies [14e95e9]
- Updated dependencies [8323e90]
  - @opengeni/contracts@5.8.0
  - @opengeni/config@3.4.0
  - @opengeni/network@0.3.2
  - @opengeni/observability@0.8.39
  - @opengeni/codemode@0.7.1
  - @opengeni/codex@0.2.33

## 6.6.0

### Minor Changes

- 351cd79: Batch workspace model catalog provider reads within each request. Reuse authorized connection metadata and combine custom-model queries while preserving tenant isolation, provider limits, credential readiness and model selection.
- 351cd79: Persist the meaningful attention frontier alongside the durable event cursor and advance both atomically on every accepted event-insert statement. Session and descendant reads reuse this narrow projection instead of probing event payloads repeatedly.

  Migration `0585_session_attention_cursor.sql` requires the declared application roles to be stopped while it backfills the existing meaningful-attention index. Runtime FORCE RLS and existing cursor sequencing checks are preserved; older application writers remain compatible with the updated database trigger.

### Patch Changes

- 12ef019: Use the human workspace instruction size limit for agent writes too, so localized edits can preserve long existing policies. Keep exact-anchor, baseline, authorization and review safeguards unchanged.
- 521ae01: Bound session stream replay pages by bytes before transferring event payloads. Stop interactive page sizing at the byte target and preserve complete oversized events, durable cursors, reconnect replay and tenant isolation.
- 56584f9: Expose additive, defaulted private-chat amount summaries and organization model payer totals. Organization and workspace totals include every usage ledger row, including another member's Only me chats and retained usage for missing or deleted sessions, without changing billing debits.

  Private-chat breakdowns disclose person-level amounts only, never unseen content, titles, session/root identities, or drilldown links; detail and sample lists remain actor-visible. Workspace breakdowns share provider/model filters and are empty for root/session scopes. Organization payer totals use all model facts independently of the capped model list, distinguishing OpenGeni credits, subscriptions, and own-key billing. New lists default to empty for older responses, truncation defaults to false, and unknown cost remains unknown.

  The released v1 cache percentages retain their numeric types and original computation. Nullable cache-contract changes are deferred to a separate follow-up; this release adds no cache deprecation, response-version selector, or breaking-change exception.

- 31e3771: Expose stored Connected Machine command reconciliation diagnostics and unavailable observations through existing session-authorized reads, preserving provider execution and acknowledgement behavior.
- 76ff363: Support workspace OpenAI and Azure OpenAI API keys with provider verification, isolated encrypted credentials, and externally billed model selection. Add the optional model verification flag to connection creation and preserve shell cancellation on macOS local sandboxes.
- c60d38a: Include normalized effective OpenAPI operation destinations and the primary manifest URL in immutable revision identity. URL rotation no longer reuses a document-only revision, while equivalent destinations still deduplicate and existing immutable versions and installation fences remain intact.

  Classify known credential Connection rejection at install-time revalidation separately from internal failures. Missing or inaccessible references return 404, and inactive or incompatible references return 422 without weakening ownership, scope, or optimistic-concurrency checks.

- 4a63d4f: A Modal box kept warm only by legacy background commands (a dev server, a command whose large output is still draining, a stopped command the provider no longer answers for) is no longer held until the provider deadline kills it uncaptured, which left the session unable to restore. Once every session of the sandbox group has been unused for `OPENGENI_SANDBOX_IDLE_COMMAND_CONTAINMENT_MS` (default 30 minutes; above the idle grace, below the rotation lead, and before an explicit Modal idle timeout), the reaper checkpoints the current workspace excluding exactly those commands, stops the box, and settles the commands `lost` with reason `idle_containment`. The next turn restores the saved workspace. "Unused" comes from durable facts only: no open turn or pending approval or human-input request, no pending quiescence, no `wait_for_input` or unclaimed turn-starting input within the window (counted from the wait deadline and the input creation), no other holder or writer, and the newest turn, holder change and write older than the window. A command the agent is waiting on keeps running until the provider-deadline backstop. That backstop now also captures behind a cancelled, failed or superseded owner without a quiescence receipt, instead of letting the box die uncaptured. Rolling migration 0547 stamps holder changes on the lease and adds a health-independent containment inventory, replacing the separate unobservable-command and stopping-with-provider-errors predicates; pre-0547 workers keep their unchanged inventory. Commands settled by containment, by provider-deadline rotation (`provider_deadline_containment`), by provider loss during that drain, by provider loss seen while routing, or by the operator cold-loss reconciliation now get `session.command.finished` and the agent notice in the same transaction, for example "`bun run dev` was stopped because nobody used this session for 30 minutes and nothing was waiting on it; the workspace was saved. Restart it if you still need it." Previously those settlements were silent. Supervised commands keep their own proof gate. The reaper exports `opengeni_sandbox_command_containment_total{outcome}`.
- 7dc8eaf: Park genuine pre-dispatch Modal setup exhaustion without failing or replaying the accepted turn or replenishing its finite recovery budget.
- 3b7496e: Encode and decode tagged JSON strings with native UTF-16LE buffers to reduce CPU and temporary string allocations. Preserve the storage format, all code units, version checks and literal legacy content.
- c755ff4: Reuse persisted command-completion observations when reading retained output. Subsequent reads no longer reacquire session/event write locks; the first acknowledgement, scoped reads and notification semantics remain unchanged.
- e9b9730: Take the canonical session/cursor/turn/attempt lock prefix when acknowledging a consumed child answer, preventing the imported-archive turn guard from deadlocking parallel tool-result writers and lifecycle transactions. Preserve best-effort acknowledgment, exact-attempt checks, and duplicate-read no-ops without replaying tools.
- 1133a8e: Lock sessions before workflow-wake failure updates and global wake claims, avoiding archive-guard deadlocks with turn settlement while preserving revision-scoped delivery and nonblocking dispatcher leases.
- fcaf518: Settle browser and computer creation failures that occur before controller dispatch, while preserving dispatched operations and accepted controller bindings for reconciliation.
- 70af8bb: Fence subscription lease renewal against expired ownership under lock contention. Share account selection and worker lease deadlines between subscription providers. Preserve Claude model-specific quota evidence and exact dispatched-token identity through concurrent responses, refreshes and delayed finalization.
- 103faae: Reuse subscription account lifecycle and table definitions while retaining existing SuperGrok behavior. Bind Claude response observations to the immutable credential receipt prepared with each physical request.
- Updated dependencies [12ef019]
- Updated dependencies [45e1b4f]
- Updated dependencies [da4ba6f]
- Updated dependencies [697263e]
- Updated dependencies [56584f9]
- Updated dependencies [31e3771]
- Updated dependencies [76ff363]
- Updated dependencies [d2fe11d]
- Updated dependencies [4a63d4f]
- Updated dependencies [91cc03e]
- Updated dependencies [131eda2]
- Updated dependencies [cbb3e36]
- Updated dependencies [479ec20]
- Updated dependencies [70af8bb]
- Updated dependencies [3a921bf]
  - @opengeni/contracts@5.7.0
  - @opengeni/codemode@0.7.0
  - @opengeni/config@3.3.0
  - @opengeni/observability@0.8.38
  - @opengeni/codex@0.2.32

## 6.5.0

### Minor Changes

- 3a688de: Expose `getModalCommandStartInvocation`, `withModalCommandStartSignal`, and the `ModalCommandStartInvocation` type through `@opengeni/runtime/sandbox`, alongside the runtime-owned `ProviderCommandStartOutcomeUnknownError`.

  Add the exported `SandboxSetupOutcomeUnknown` database type, an optional recovery-input flag, and optional details on the existing `admission-blocked` work result to park incomplete sandbox setup without replay.

  In repository builds that apply the pinned Modal SDK patch, recover lost command-start acknowledgements through bounded, cancellable observation of the original invocation. Preserve uncertain setup commands as durable locators without replay or fabricated supervision, and keep failed-create cleanup fenced.

  SDK adoption and cancellation depend on that repository patch. Vanilla npm `modal@0.9.0` does not acquire this behavior merely by installing `@opengeni/runtime`; the runtime's optional own-symbol integration does not require patch-only SDK error exports.

### Patch Changes

- 5e1175d: Take the workspace identity lock before Codex lease session and turn locks, preventing allocation deadlocks with queued workspace writers while preserving exact attempt and credential authority.
  - @opengeni/codemode@0.6.8

## 6.4.0

### Minor Changes

- e5b0123: Release the developer-setup API-key preset and SDK mirror with its credential ceiling preserved across sessions, delegated tools, automations and scheduled runs. Include the scheduled setup-policy identity migration and the bundled skills-only developer setup guide.

### Patch Changes

- 4762e1a: Collect product usage analytics server-side, independent of browser analytics consent.

  Record throttled, batched presence for managed browser sessions and publish `opengeni_active_users{window}` from control workers. Add the `user.active`, `credits.granted` (grant class) and `connection.revoked` (provider class) lifecycle facts, live `opengeni_sessions_created_total{surface,created_by_kind,root}` and `opengeni_user_messages_total{surface}` counters, and database-derived `opengeni_credit_grants_total{grant_class}` / `opengeni_credit_granted_micros_total{grant_class}` that include trigger-written trial grants.

  Add an idempotent operator backfill (`bun run db:backfill-lifecycle-facts`) for lifecycle facts captured before the first lifecycle consumer registered.

  Give the logical workspace capture its own `opengeni_workspace_capture_revision_duration_seconds` histogram so it no longer collides with the physical capture histogram's label set in one worker registry.

- Updated dependencies [e5b0123]
- Updated dependencies [4762e1a]
  - @opengeni/contracts@5.6.0
  - @opengeni/codemode@0.6.7
  - @opengeni/codex@0.2.31
  - @opengeni/config@3.2.1
  - @opengeni/observability@0.8.37

## 6.3.0

### Minor Changes

- f874217: Make browser sign-in the default Claude subscription connection flow, with profile access for current usage/reset times and encrypted automatic token renewal. Reuse native workspace/organization connection ownership and access policy, bind one-use PKCE attempts to the human/browser/current generation, and preserve original model-request bindings across token renewal. Keep inference-only setup tokens as a clearly labelled fallback, and send JSON for browser usage-refresh mutations.

### Patch Changes

- e01fc8e: Preserve the exact accepted preference descriptor snapshot across recovery attempts, including after permanent Skill removal or descriptor-rendering changes. Removed content remains unavailable and exact-attempt authorization remains enforced.
- 0bbe2e7: `installApiIntegration` accepts `autoApprovedTools`: selected write or destructive tools of a custom or curated API Integration (a curated definition may forbid specific operations) that run without per-call human approval, so scheduled and other unattended runs no longer wait forever on an approval. It needs `capabilities:manage`, passes organization integration policy again, and is declarative (omit it and every write tool asks again). Connector tool-permission and session approval-policy errors for API Integration ids now point to this setting.
- 55f1cdd: Checkpoint managed browsers before provider expiry through existing encrypted
  suspension receipts. Exact lease and controller claims fence capture, publication
  and cleanup; retries retain one operation and never recapture a committed artifact.
  Share browser authority derivation through leaf exports used by API and worker.
- b45621d: Revalidate live editor source-session authority in the mutation commit transaction, and enforce source-bound socket lease expiry independently of stalled authorization. Publish the session-proxy JavaScript entry and negotiate artifact support without breaking conversation bootstrap against older APIs.
- b45621d: Fix embedded artifact viewing for external users by resolving fresh effective workspace grants, checking exact session associations on every request, and binding live editor tickets to their source session. Keep editor authority and reconnect reads current when clients or sessions change, and allow retrying temporary viewer configuration failures.

  Source-bound editor sockets renew a 15-second lease through the host proxy, rechecking product authorization; existing unbound console sockets are unchanged. Compact authenticated source tickets remain within the existing wire limit.

  Add server-only `@opengeni/sdk/session-proxy` helpers. Stream embedded Site HTML with backpressure and cancellation and enforce a 25 MiB actual-byte ceiling; oversized streams fail with `site_html_too_large`. Preserve the console's existing shared artifact components and list behavior.

  Allow PostgreSQL test fixtures to use an explicitly configured native server while preserving restricted-role and FORCE-RLS verification.

- c7bb6f1: Stop deterministic goal retries for terminal or unavailable-model sessions,
  preserve frozen connector authority through voice delegation and handoff, and
  request advertised OAuth offline access for generic native MCP connections.
  Distinguish MCP teardown warnings from connection failures in safe telemetry.

  Freeze initial-turn connector accounts against executable workspace defaults,
  matching follow-up admission while preserving explicit selections and exclusions.

  Validate scheduled generated sessions against the full accepted agent
  configuration and instruction alias during queued recovery.

- 0bbe2e7: `previewApiIntegration` and `installApiIntegration` accept an inline OpenAPI document: `source: { kind: "openapi_document", sourceKey, document, baseUrl? }` (JSON or YAML, at most 8 MiB). `sourceKey` is the stable installation identity, server URLs must be absolute (or `baseUrl` given), and the preview echoes only the document's SHA-256. Calls still follow the deployment network policy, so a product on a private or loopback address still needs a public tunnel unless the operator enables private targets.
- 46e3a8e: Give the named shared-workspace Member role everything Viewer has plus read-or-own collaborator access: `artifacts:read` (open Sites and agent-made documents, spreadsheets and presentations), `stream:view`, `stream:acknowledge`, `rigs:use`, and `artifacts:publish` (every member can create and publish Sites and editable artifacts; publish, rollback, and archive act on any artifact in the workspace and are reversible). Rolling migrations 0555-0557 update the preset, normalize older named Member sets written by overlapping binaries, and backfill exact-match memberships in batches. Custom permission sets are unchanged, and administrative permissions stay Admin-only.
- 3545ca3: Include exact accepted-turn initiator context in signed credential-provider
  requests, with human/service/agent attribution and bounded causal lineage for
  children, continuations, and coalesced updates. Preserve initiating-human fields
  and authorization; expose the additive context through the SDK verifier.
- 45d1301: Clarify that goal completion records ledger proof, not the user-facing answer, including when late child results arrive after completion.
- 45d1301: Project structured developer/system text into Chat-native history without mutating canonical messages, recognize completed hosted tools for final-reply handoffs across recovery, and keep DB helper imports within the foundation boundary.
- dd6795c: Explain known session-creation refusals for unavailable accepted workspace connections as non-retryable errors. Preserve authorization checks and original driver evidence without returning query text, credentials, or account details.
- 0bbe2e7: `api_key` Connections now must store `{ headers: {...} }` or `{ placements: [...] }`; create and update reject any other shape (such as a bare `{ apiKey }`) with 422 instead of accepting it and failing every tool call later. The SDK types this as `ApiKeyConnectionCredential`. `previewApiIntegration` warns when the selected Connection does not place its credential where the API description declares.
- Updated dependencies [a6ff780]
- Updated dependencies [0bbe2e7]
- Updated dependencies [45d1301]
- Updated dependencies [45d1301]
- Updated dependencies [04640d1]
- Updated dependencies [fd5fb34]
- Updated dependencies [b45621d]
- Updated dependencies [45d1301]
- Updated dependencies [f874217]
- Updated dependencies [45d1301]
- Updated dependencies [0bbe2e7]
- Updated dependencies [3545ca3]
- Updated dependencies [45d1301]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [45d1301]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
  - @opengeni/contracts@5.5.0
  - @opengeni/codex@0.2.30
  - @opengeni/config@3.2.0
  - @opengeni/codemode@0.6.6
  - @opengeni/observability@0.8.36

## 6.2.0

### Minor Changes

- aad6598: Claude subscription setup and replacement require only the setup token. Observe
  provider usage and reset windows from ordinary model responses, including quota
  errors, and expose scoped cached reads and authorized refreshes. Preserve the last
  reading when inference-only tokens cannot use the separate usage endpoint; fence
  cached readings against credential replacement and revocation.
- 3f9c757: An organization service key can change an existing external member's
  permissions in one shared workspace without removing and re-adding them:
  `PATCH /v1/organizations/:organizationId/workspaces/:workspaceId/external-members/:membershipId`
  (`updateExternalWorkspaceMember` in the SDK) with `{ operationId, permissions }`.
  It is keyed and idempotent like a grant, capped by the key's permissions, and
  never cancels or tears down work. Narrowing also advances the member's
  organization authorization revision so frozen authority re-checks on next use.
  Rolling migration 0540 adds the `update` action to the external membership
  operation ledger.
- cabfc5e: Organization usage summaries now list each member's Personal workspace as a
  usage-only row (`personalWorkspaces`, keyed by the owner's organization
  membership, plus `personalWorkspaceCount`). Rows carry amounts only - never the
  Personal workspace id, name, sessions or content - and follow the same
  actor-visible session rule as the period totals, which already counted this
  usage. Rolling migration 0543 replaces the aggregate with the same signature and
  ACL, so older API processes keep working and ignore the new fields, which
  default to empty.
- 8669490: Add per-person product lifecycle facts to the durable host export as a third kind, `lifecycle_fact`. Migration `0532_product_lifecycle_fact_export.sql` (rolling) captures one content-free fact per sign-up, email verification, sign-in, organization setup, model connection, credit top-up, connection, scheduled task, installed catalog Skill, Slack user link, enrolled machine and organization join, in the same transaction as the product change. Nothing is captured until a host registers a `lifecycle_fact` consumer, and a capture failure never fails the product change.

  Every fact is a fixed type with an optional value from a fixed per-type list (`PRODUCT_LIFECYCLE_FACT_ATTRIBUTES`), a subject kind, the opaque `user:`/`api_key:` subject id when there is one, and the organization and workspace UUIDs when the product change has them. Sign-up, verification and sign-in facts carry no organization. `claimHostExportBatch` accepts `kind: "lifecycle_fact"` and returns a `HostLifecycleFactExportBatch`; `createHostExportPump` accepts an optional `lifecycleSink`.

- f986809: Scheduled tasks can post to one Slack channel as the OpenGeni workspace bot. A person chooses the channel in the schedule editor ("Post to Slack" under Advanced), stored as `agentConfig.slackBotChannelId` next to `slackBotConnectionId`. Choosing or changing it needs a signed-in person with `connections:write`, and the bot must be a member of an active channel that is not shared with another organization. Agents, services and API keys cannot set or change it. `listScheduledTaskSlackChannels` in the SDK lists the eligible channels.

  Runs of such a task get two tools, `slack_bot_prepare_message` and `slack_bot_send_prepared_message`, which take no channel. Prepare saves the exact text; send posts it to the task's channel with the saved server-owned id as the Slack post operation id, so a retried send never posts twice. Both re-read the task at every call, so clearing or changing the channel takes effect immediately and never redirects an already prepared message. Rolling migration 0530 adds the private prepared-message table and its two capabilities.

- 1ea4c69: Show when a scheduled task's frozen access is out of date, let its owner refresh it, and tell the owner when a run could not use a connector.

  For the task owner (or, for a task without an owner, people who manage schedules), scheduled task reads include a read-only `policyDrift`: workspace default connectors the task lacks, connectors the workspace no longer sets up, default OpenGeni tools missing from an agent-created task's frozen creator policy, connectors whose chosen account can no longer be used, and connectors with no account although one is now available. `POST /v1/workspaces/:workspaceId/scheduled-tasks/:taskId/refresh-access` (SDK `refreshScheduledTaskAccess`) re-freezes exactly that with the calling person's current authority through the ordinary owner update path. Only a signed-in person may call it; API keys, services, delegated bearers and agents cannot, a changed task returns 409, and a refreshed creator policy keeps a frozen permission only while that person holds it, adds only the permissions its newly added tools need (within the default worker set and that person's grant), and never changes the creator session policy.

  Scheduled runs whose own turn recorded `tool.auth_needed` carry `accessFailures`, and `GET .../scheduled-tasks/attention` (SDK `listScheduledTaskAccessAttention`) lists schedules whose latest run failed that way until a later run succeeds. It also lists schedules the scheduler refuses before creating a run because a chosen connector account can no longer be used (`unavailableAccounts`, with a null `runId` and `firedAt`), checked at read time with the same account plan as the drift; each item carries the task's `executionDigest`. The web console shows a dot on the Schedules navigation item, a badge on the schedule's row, a notice on the schedule's page with a one-click refresh, and the failure on each run row.

  The refresh accepts an optional `leaveOut` naming default connectors and OpenGeni tools to keep off the schedule; it only narrows what the refresh adds. The schedule page's "Keep without these" hides those defaults in that browser for the reviewed task head and passes them as `leaveOut` when the owner refreshes.

  `@opengeni/contracts` exports `ScheduledTaskPolicyDrift`, `ScheduledTaskAccessConnector`, `ScheduledTaskRunAccessFailure`, `ScheduledTaskAccessAttention`, `ListScheduledTaskAccessAttentionResponse`, and `RefreshScheduledTaskAccessRequest`; `ToolAuthNeededReason` is unchanged but now declared earlier in the module. `@opengeni/db` adds `listScheduledTaskCreatorPolicies`, `listScheduledTaskRunAuthNeededEvents`, `listScheduledTaskAccessAttentionEvents`, `listActiveScheduledTasksWithConnectionAccounts`, and `ScheduledTaskHeadChangedError`, and `updateScheduledTask` accepts `expectedExecutionDigest` and `creatorFirstPartyPolicy`.

- 30414a0: Add the first-party `session_set_model` MCP tool for changing an existing session's future model and reasoning defaults without waking it or rewriting accepted work. Preserve ordinary target authorization and exact-attempt fencing, provide stable idempotent receipts across reconnects, and report canonical model, reasoning and latency settings in full session readback. Share effective defaults across prompt admission, goal continuation, compaction and scheduled snapshots so older queued or resumed turns cannot undo an explicit choice. Deploy API and workers from a matched source cohort before using the new operation.
- b37af05: New Slack tasks post a shorter first message. It is one sentence that links to the session ("OpenGeni started this task", with the routed workspace named inline when routing made a choice) and carries a single Stop button while the task runs. It no longer lists the connectors, repositories and Sandbox Environment the task started with. Stop (or replying `stop`) now swaps the button to Resume on the same message instead of posting a task controls card, and the button leaves the message when the task settles. New tasks have no Status button, no task controls card and no Make recurring link, and later messages in the thread no longer repeat the workspace. The one-time first-task hint is shorter, and `<command> info` suggests asking OpenGeni in the thread to repeat a task on a schedule when the person may and the Slack task tools include scheduling.

  The opening sentence is frozen on the interaction when its session binds (rolling migration 0537 adds `slack_interactions.start_message_line`), so repairs and button updates re-render identical bytes for the digest-bound post and update ledgers. Interactions bound before this change keep their previous messages byte for byte, including their Status, Stop and Resume buttons and task controls cards; their control buttons now render from their reserved handles whatever the handles' status, so an acknowledgement repair after a press no longer conflicts. `@opengeni/db` adds `listPendingSlackInteractionMessageActionHandles`, a `supersedeSiblings` option on `settleSlackInteractionActionHandles`, and `startMessageLine` on `SlackInteraction` and `bindSlackInteractionSession`.

  Breaking: `@opengeni/db` `bindSlackInteractionSession` no longer accepts `sessionDefaultsLine` (nothing writes that column any more; existing values are still read), and `getSessionFirstTurnConnectionAuthority`, which only rendered that line, is removed.

- 14990d0: A task started from Slack now starts from what the workspace offers every new session instead of the person's last website composer selection. Connectors follow the workspace default connector policy (including the person's own personal connections when that policy includes connected servers, still executable only through the frozen delegation snapshot), OpenGeni tools follow the workspace default selection, and the Sandbox Environment and its Variable Sets follow the workspace default. Only an explicitly chosen model carries over. Mentions, commands, DMs and shortcuts now always add the read-only Slack context tools, including when the workspace has its own default OpenGeni tool selection; reactions still do not.

  Repositories are the person's own recently used repositories in that workspace: those on the top-level sessions they started there in the last 30 days, most recent first, at most five, and only through their current entry in the workspace GitHub App catalog (same catalog and `github:use` permission as the website picker), on the default branch. Archived and empty repositories are skipped. A person with no recent repositories gets none; GitHub is asked only when there is something to look up, and an outage starts the task without repositories. These repositories are attached best effort.

  Repository resources gain an optional `optional: true` flag (contracts and SDK). A failed clone of such a repository logs a warning, is reported as `skippedOptionalRepositories` on the `repository-clone` operation event, and no longer fails sandbox setup; a repository without the flag keeps the strict behavior. `GitHubRepository` gains optional `archived` and `sizeKb`, filled from GitHub when reported.

  The Slack acknowledgement adds one line naming what the task started with, for example `Using connectors: Gmail, Linear; repos: opengeni.` It names only connectors the first accepted turn can reach, so a personal-only connector the person never connected is not claimed. The line is frozen on the interaction when its session binds (rolling migration 0529 adds the nullable `slack_interactions.session_defaults_line`), so a repaired acknowledgement re-renders identical bytes. A Slack message or a reacted-to message that links a workspace or session on a different deployment under the same parent domain (for example staging versus production) now carries a model-context note, so the agent says the link is for the other deployment instead of reporting the session as not found.

  Breaking: `@opengeni/core` removes `getActorNewSessionDefaults`. Use `getActorNewSessionModelChoice`, which returns only an explicitly chosen model policy. `@opengeni/db` adds `SlackInteraction.sessionDefaultsLine`, an optional `sessionDefaultsLine` input to `bindSlackInteractionSession` (written only by the bind that wins), `listRecentSessionRepositoryResources`, and `getSessionFirstTurnConnectionAuthority`.

- d1f4724: Every accepted turn now records the product surface its request entered through: `web`, `slack`, `api_key`, `embedded`, `scheduled`, `agent`, `voice`, `site`, `automation`, `mcp`, or `system`. Slack, realtime voice, automations and maintenance name their surface; other requests derive it once from the verified access path (a managed or local browser session is `web`, an API or configured key is `api_key`, signed delegation or an external actor is `embedded`, workspace MCP OAuth is `mcp`, an agent attempt is `agent`, and a validated Site origin is `site`, including follow-up Send and Steer from the Site bridge). A scheduled occurrence records `scheduled` and another agent's message records `agent`, so scheduled runs no longer look like generic system work; other machine turns inherit the session's latest surface. `origin` is unchanged. Embedding hosts that call core directly can pass `surface` to `createSessionForRequest` and `acceptSessionUserMessage`.

  The durable host export carries `surface` and `modelProvider` (the provider family from the turn's execution policy, with operator-configured providers reported as `registry`) on session events and usage facts, and `toolFamily` on `agent.toolCall.created` (a first-party tool name, `integration:<reviewed domain>`, or `custom`). The worker stamps `toolFamily` on the tool-call event payload. All values come from fixed lists and carry no content. Rolling migration 0533 adds the immutable, checked `session_turns.surface` column, the three export columns, and the `host_export_claim_analytics_sidecars` companion, which inherits the claim function's exporter grants. Published export function signatures are unchanged.

### Patch Changes

- 378327b: Emit one `agent.message.completed` per assistant message with its `phase` and, when the provider sent one, its `messageId`. Runtime normalization read a text field that Agents SDK message items do not have, so no per-message completion or phase ever reached events. Deltas now carry the phase a Responses provider declares, also through compact delta coalescing. An undeclared message gets the SDK's own rule: `commentary` when the same response asks for client tool work (including a client tool search) or ends with a later message, `final_answer` for the message the SDK returns. A Responses message completes as soon as it finishes, before the next message streams, instead of after the whole response. The worker skips the phase-less settlement copy once the stream completed the final text.

  Commentary is activity: it no longer marks a session unread (rolling migration 0527 indexes the new attention predicate), wakes `session_wait` change mode, becomes a Slack post, or enters the SDK chat reply. A turn that settles with only commentary still replies with its latest note. When a human or API message's turn ends waiting for input (`wait_for_input`), settlement records its latest assistant message on `turn.completed` as `reply` (the output stays empty; a child an agent spawned and a scheduled, automation or maintenance session's first turn record none), so a status answer given before waiting again marks the session unread and becomes a Slack post with the requester mention while delivery stays open for the result; stored history keeps the provider's phase. The SDK chat fold completes each segment by `messageId`, so a note completed after its answer streamed never repeats the answer. The MCP conversation view labels commentary, `latest: "terminal"` skips it, and the React timeline knows a streaming note is commentary from its first delta. `phase` stays optional.

  Older SDK clients see the new completions too: their live reply now separates a note from the answer that follows it in the same response with a blank line (it was run together before), and `history()` lists each completed note as its own assistant message. Roll the API before the workers: an older API process next to a newer worker can briefly post notes to Slack, wake `session_wait` change mode on them, and mark sessions unread for them.

- e14db2a: Recognize a ChatGPT account whose plan no longer includes the requested Codex
  model (an explicit plan refusal, `usage_not_included`, or an empty HTTP 400).
  The worker re-checks the account's current plan, excludes that account for that
  model only, and moves the same turn to another eligible account, or fails with a
  typed `codex_plan_entitlement` or `codex_request_rejected` code and plain copy.
  Plan metadata now refreshes from token refreshes and usage reads, a plan change
  is recorded as lasting evidence, the remote compaction request takes the same
  path, and each exclusion expires after 24 hours. Codex accounts report
  `planCheckedAt`, `planChangedFrom`, `planChangedAt`, and `planExcludedModels`.
- a5e93ba: Background commands that finish quickly but print a lot of output are now recognized as finished on the next background check instead of staying "running" for hours. Their sandbox can then save its workspace and go idle normally, instead of being held until the provider's 24-hour limit ends it. A command's saved output keeps its first 16 MiB and its final part, with a note where output was skipped.
- c4d0d1a: A person's message no longer retires a held `wait_for_input`. A finished turn that a person started (`source` `user` or `api`, or an operator's manual compaction) that does not call `wait_for_input` itself now leaves the session wait held, with its declaring turn, reason, and deadline unchanged. Previously, a status question answered while a child ran retired the wait, so the child's later result stayed pending with nothing to wake a goalless parent. A person's turn that claimed pending immediate machine input as coalesced context (for example, a child result that arrived just before the question ran) consumed what the wait was for, so it still retires the wait; coalesced deferred notices alone do not. Goal, system, scheduled, and other machine-input turns still supersede the wait, and its own deadline still bounds it. One shared predicate now decides the wait for worker peek and settlement, wake and claim admission, public `inputWait`, and waiting-descendant counts. No schema, prompt, or tool change.
- 3b58ff8: Signal the session workflow right away when an internal update (child result, Agent message, media result) joins a wake revision that has not been delivered yet, such as the future-dated `wait_for_input` deadline. The update still coalesces into that revision. Before this change it waited for the periodic dispatcher tick, which delayed a waiting parent's pickup of a child result by up to 10 s.
- 6f28afd: A definitively lost managed Modal sandbox no longer dead-ends its sessions. Shared sandbox groups (a parent with its children) now get the automatic checkpoint fallback, and every member receives the durable filesystem-discontinuity warning. When no checkpoint can be restored automatically (no archive, an unverified or legacy archive, an invalid artifact, or a definitive, non-retryable content-integrity failure of the selected checkpoint), the whole quiescent group continues on a new empty workspace after a separate audited decision that warns every member the previous files are not available. Loss must be proven by a loss transition (a failed replacement box never counts), the empty workspace waits until the lost box is past its hard provider lifetime, other restore failures (including a missing archive object, now `archive_object_missing`, or unconfigured archive storage, now `archive_storage_unavailable`) retry the checkpoint with backoff and then wait for an operator, and a complete archive is never bypassed. Ambiguous provider states and live writers in any member still block, unknown command outcomes are never replayed, and the lost archive evidence is kept. Sessions stuck before this release recover on their next turn or Retry. The recovery projection adds `automaticLane` (`checkpoint` or `fresh_workspace`) and, for a timed wait, `availableAt` (when a Retry or a new message can decide again), and the failed-session banner says what Retry will do and when. Rolling migration 0548 requires warning protocol v3 to claim a session with an empty-workspace receipt.
- 32598eb: Expose content-free MCP phase timings and host-owned outbound trace correlation across gateway, credential, transport and persistence boundaries. Preserve W3C sampling flags, credential header semantics, exact execution authority and existing retry behavior.
- a6854a7: Allow completed turn owners to reach bounded Modal deadline capture without an interruption-only quiescence receipt. When the provider is definitively gone, select only a verified singleton CURRENT checkpoint for automatic continuity, persist a cache-stable filesystem warning before the agent runs, and fence old workers from affected sessions. Keep unknown command outcomes and unavailable or invalid archives fail-closed.
- b591ea1: Support native Claude Messages with separate encrypted Anthropic API-key and Claude subscription setup-token connections, workspace access policies, streaming tools and thinking, prompt caching and usage accounting. Add connection UI and payment-source labels. Migration 0544 expands organization connection kinds and lifecycle validation.

  Pin the Claude subscription client identity headers, persist account/device metadata with encrypted credentials, and add request-scoped attribution. Existing token-only connections require replacement with identity metadata. The captured billing checksum remains unverified and is not replayed.

  Preserve Claude session identity across worker turns and recovery while keeping prompt lineage scoped to each run.

  Admit organization Claude models through session creation and lock their correct connection kind. Preserve Claude provider labels in the client catalog. Project initial system/developer instructions into Anthropic’s top-level system field so full agent sessions with skill instructions execute successfully.

  Polish Claude setup with local settings import, full-page token renewal, named model choices, provider marks, accurate subscription payment labels, and workspace discovery of organization-owned connections.

  Support workspace-owned Claude credentials, model generations, access controls and setup/account screens alongside organization connections. Migration 0545 expands workspace custom-model provider kinds. Gate Claude subscriptions behind OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED (default off), leaving Anthropic API keys and other providers unchanged.

- 5ab0b13: Remove the unconditional five-second grace period from normal session idle completion and child-result handoff. Keep the final durable work recheck, transactional idle settlement and parent-result deduplication, and close-race signal guard. Fence runnable machine input accepted before idle settlement as well as queued turns, preventing a stale parent result when input wins that race. Late follow-ups may start another workflow run of the same session through the durable wake path. A Temporal patch preserves legacy timer histories; held input waits, goal backoff, cancellation, quiescence, and capacity timers are unchanged.
- f68b176: Preserve workspace model access restrictions when renewing or reconnecting Claude, Anthropic, OpenRouter and Gateway credentials. Bound Claude HTTP error-body reads so stalled diagnostics cannot hide rate-limit/retry information. Associate Claude account-import help and validation errors with its accessible control.
- 8d19289: Allow a fresh exact operator checkpoint authorization after a completed public recovery, preserving the superseded recovery in the audit receipt without changing automatic recovery or active consent fences.
- 7a08660: Make a finished child's result carry its answer. An idle `child_terminal_result` now includes optional `payload.finalAnswer`: the child's newest result-bearing answer, frozen by the idle settlement, bounded to 8 KiB UTF-8 with a head/tail truncation marker and a `session_events` pointer to the full text (`childTerminalResultFinalAnswer`, `CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES`). No answer is copied when the child's newest turn failed, was cancelled or superseded, or stopped at a segment limit. A turn claimed only to continue the child's goal (for example one that confirms and completes the goal after the answer) no longer replaces the answer: the answer is reported with that turn's output after it as `finalAnswer.goalContinuations`, whole when the parts fit the bound (`childTerminalResultFinalAnswerWithGoalContinuations`). Parts that do not fit are reported as the newest part, marked truncated, with `omittedSequences` and a `nextAction` that reads every part, so a child working across goal continuations still reports its final report. The walk stops at a non-answer outcome and at the child's newest goal activation, and a window holding only continuations reports the newest answer alone. The worker's enrichment upsert now keeps the committed answer and evidence instead of replacing them, and an untruncated answer serves as the parent claim's consumption evidence. When a parent's exact live attempt reads a direct child's complete answer through `session_wait` or `session_events` in its own model call (the worker now marks first-party calls with `_meta.opengeniCaller`, `FIRST_PARTY_MCP_CALLER_META_KEY`; Codemode calls do not count), the answer is recorded on the reading turn (`metadata.consumedChildAnswers`, `recordConsumedChildAnswers`) and `session_wait` stops counting that child's result as own pending input (`listOutstandingSessionSystemUpdatesForAttempt`). The attempt's successful completion settlement supersedes each still-pending idle result whose every part it received (`consumed_by_parent_read`), and a result the child commits after that completion is inserted already consumed, without a wake. A read by an attempt that fails or is interrupted suppresses nothing. The operational contract and the `session_create`, `session_wait`, `session_get`, `session_send_message`, and `wait_for_input` descriptions now price a child, prefer a direct answer or reusing an existing child, and steer multi-minute waits to `wait_for_input` instead of alternating `session_wait` and `session_get`. No tool is capped or removed.
- 57f030c: Retain failed scheduled occurrences when connection-account selection blocks
  dispatch. Run history includes structured connector/account identifiers and
  safe eligibility reasons without credential values or raw error messages.
  Replaying an occurrence retains its original outcome without admitting work.
- 3f9c757: A scheduled occurrence the scheduler refuses before running it is now a visible
  run instead of a thrown, retried activity or a silently dropped occurrence.
  `ScheduledTaskRun.admissionRefusal` (`{ version, reason, retryable }`, with
  `error` equal to `reason`) covers unprovable authority, an unavailable
  Connected Machine target, a missing Variable Set, a Sandbox Environment without
  an active version (terminal, status `failed`), and an inactive machine
  enrollment, insufficient credits or monthly limits (transient, status
  `skipped`; later occurrences run normally). Redelivery never adds a second run.
- 3f9c757: Scheduled tasks created by an organization or workspace API key (or the
  configured key) are now ownerless service schedules and run. Previously the
  key subject became the schedule's immutable owner, and every occurrence failed
  invisibly in the scheduler. An occurrence refused because its frozen authority
  cannot be proven is now recorded as a failed run with error
  `scheduled_authority_unavailable` instead of being retried to exhaustion with
  no run.
- 3f9c757: A scheduled run whose turn waits for a tool approval or a structured question
  is now visible: `ScheduledTaskRun.awaitingHuman` (`{ since, expiresAt }`) on run
  listings and `awaitingHuman` on the scheduled-task attention list, instead of the
  run looking merely "dispatched". The new optional
  `agentConfig.approvalTimeoutSeconds` (60 s to 30 days; default none) lets the
  scheduler reject the pending approval (or skip the question) as a labelled
  system decision once nobody answered in time, driven by a durable workflow
  timer.
- 1ffeb7c: The session terminal, Files, Git and desktop viewer open again for sessions whose Sandbox Environment has default Variable Sets the session did not select itself. A Variable Set the session can no longer use now answers 403 with its id instead of a bare 500, and the API logs the cause.
- 740bebd: A repeated default `skill_read` of the same Skill no longer returns the full `SKILL.md` again while that exact text is still in the session's active model history. The model receives a short `alreadyInContext` receipt with the current revision identity instead. Reads that compaction removed from history count as absent, so the next read returns full text. A stored read counts only if the current model receives it untruncated under its own tool-output bound, and a failed history lookup returns full text. Explicit `paths` (including `["SKILL.md"]`), `listFiles`, and Codemode callers always receive content. The tool schema, instructions, and Skill index are unchanged, so the cached prompt prefix is unaffected. `@opengeni/db` exports `getActiveSessionFunctionToolResults` for the active, call-paired results of one function tool.
- b28d5fa: Reading a session's stored bundled Skill selection now drops ids this build does not know instead of failing the whole session read. Dropping only narrows the stored selection; API input still rejects unknown ids, and keyed create replay still compares the exact stored selection. The bundled `document-parsing` guide now ships the upstream AnyDoc MIT license and a `SOURCES.md` attribution, the runtime package notices cover both AnyDoc-derived guidance copies, and the `skill_install` description no longer claims that `skill_search` returns library ids.
- e193b13: Add optional workspace-bot file-upload scope and an explicit, session-bound Slack retained-file delivery tool with durable upload checkpoints and uncertain-completion reconciliation. Existing bot installations remain eligible without files:write; administrators apply the canonical manifest and reinstall to enable uploads.
- 22e8ebf: The child-lifecycle outbox reconciler now delivers a backlog to parents in the order the rows were produced. The claim already selected pending rows oldest first, but returned them in the table's physical order, so a parent could receive sibling results out of completion order, or have an older progress notice supersede a newer one. Rolling migration 0528 returns the claimed rows sorted by `created_at`, then `id`; its signature and grants are unchanged.
- b99fd06: Keep task-tree authority's root-session lock compatible with foreign-key checks,
  preventing a cycle with concurrent child activity finalization while retaining
  writer serialization and exact attempt/visibility checks. Migration 0542 is
  rolling-compatible and preserves the function's owner and privileges.
- bcd9988: Give the model the current time without a tool call, and ask supported models for shorter answers. Each claimed user message now carries a separate `[Message sent <weekday> <date> <HH:MM> UTC]` part taken from the turn's durable acceptance time, and each delivered machine-input batch states its `deliveredAt` and every member's `createdAt` (scheduled occurrences add `Delivered:` and `Created:` lines). The times are persisted with the history row, never computed at inference time, and never enter `Agent.instructions`. Agent turns on the Codex subscription, direct OpenAI Responses and Azure OpenAI Responses routes send `text.verbosity: "low"` for GPT-5-family and later models; the new optional `textVerbosity` agent option is omitted everywhere else, so Gateway, OpenRouter, SuperGrok, chat and other compatible routes are unchanged. `reasoning.summary` is unchanged. Realtime voice-call history now keeps a user message's separate parts on separate lines.
- 6f4be14: Lock the workspace before validating usage-event execution identities, preventing accounting inserts from deadlocking against session lifecycle writers. The rolling migration preserves execution validation, runtime authority, and retained usage history.
- c823664: New scheduled tasks and new web sessions now pick up the workspace default Sandbox Environment and the default Variable Sets it carries. A scheduled task that omits `rigId` stores the workspace default at creation, the way session create resolves it (an existing-session task keeps its target session's environment, a Connected Machine task stores none, and `null` still opts out); a later change to the workspace default does not move an existing task. Binding an environment to a task's generated sessions, whether by default, by an explicit `rigId` on create or edit, or by switching an existing-session task to generated sessions, now requires permission to attach that environment's default Variable Sets, as session create already did. In a workspace with a default, a Sandbox Environment picked in the composer applies to that session only and is no longer carried into the next new-session form, so later sessions return to the workspace default.
- Updated dependencies [01f50bf]
- Updated dependencies [3f9c757]
- Updated dependencies [378327b]
- Updated dependencies [872391f]
- Updated dependencies [aad6598]
- Updated dependencies [6146167]
- Updated dependencies [8019cac]
- Updated dependencies [e14db2a]
- Updated dependencies [e917ce3]
- Updated dependencies [3f9c757]
- Updated dependencies [9732749]
- Updated dependencies [6f28afd]
- Updated dependencies [32598eb]
- Updated dependencies [a6854a7]
- Updated dependencies [b591ea1]
- Updated dependencies [a82657f]
- Updated dependencies [cabfc5e]
- Updated dependencies [8669490]
- Updated dependencies [126a395]
- Updated dependencies [359382e]
- Updated dependencies [2088678]
- Updated dependencies [7a08660]
- Updated dependencies [57f030c]
- Updated dependencies [3f9c757]
- Updated dependencies [3f9c757]
- Updated dependencies [f986809]
- Updated dependencies [1ea4c69]
- Updated dependencies [11151c6]
- Updated dependencies [30414a0]
- Updated dependencies [514f8ea]
- Updated dependencies [b28d5fa]
- Updated dependencies [e193b13]
- Updated dependencies [14990d0]
- Updated dependencies [bcd9988]
- Updated dependencies [d1f4724]
  - @opengeni/contracts@5.4.0
  - @opengeni/config@3.1.1
  - @opengeni/codex@0.2.29
  - @opengeni/observability@0.8.35
  - @opengeni/codemode@0.6.5

## 6.1.1

### Patch Changes

- 585f2c1: Add an operator-disabled ephemeral Chromium BrowserSession mode for disposable sandbox verification. Explicit requests use isolated browser contexts within a trusted actor and placement partition, preserve existing private-profile defaults, and become terminal after shared process loss instead of silently recreating or replaying work.
- a63a029: Reject Lightpanda placeholder images as screenshots and correct screenshot
  capabilities for existing semantic-only sessions. Keep DOM observation available.
- 4124c7c: Verify fresh conversation-history appends using their returned persisted rows instead of rereading numeric positions under row-level security while holding the session write lock. Existing-position retries retain exact content and turn checks, with atomic rollback on conflicts.
- 2563950: Add a database runtime kill switch for the one-time verified signup trial credit (rolling migration 0521). A grant now needs both `OPENGENI_VERIFIED_SIGNUP_TRIAL_CREDITS_ENABLED` and the newest row of the append-only `opengeni_private.verified_signup_trial_switch_revisions` table, which starts enabled. Operators flip it with the owner-only audited `set_verified_signup_trial_credits_enabled(enabled, operator, reason)` function. The change applies to the next setup transaction on every API replica, with no deploy or restart. Runtime roles can only read the switch. `readVerifiedSignupTrialSwitch` exposes the switch state, and the control worker publishes it as `opengeni_verified_signup_trial_credits_runtime_enabled`, next to `opengeni_verified_signup_trial_credits_deployment_enabled` for the master opt-in.
- Updated dependencies [74e0dfb]
- Updated dependencies [1842911]
- Updated dependencies [585f2c1]
- Updated dependencies [ec707de]
- Updated dependencies [3aab8f9]
  - @opengeni/config@3.1.0
  - @opengeni/contracts@5.3.0
  - @opengeni/codemode@0.6.4
  - @opengeni/codex@0.2.28

## 6.1.0

### Minor Changes

- 1a427e0: Add the optional Jev-backed `code_search` agent tool. It finds where something is implemented, configured or decided in the workspace in one call and returns verbatim, line-numbered passages with a coverage status. It is controlled by `OPENGENI_CODE_SEARCH_MODE` (`off` by default, `opt_in`, `default_on`, or `experiment` for a fixed per-session half), the `OPENGENI_JEV_*` settings, and a per-workspace `codeSearchEnabled` setting (`null` follows the deployment). Each session freezes its decision when it is created (`sessions.code_search_enabled`, rolling migration 0520, exposed as `codeSearchEnabled` on the session), and children keep their parent's, so later setting changes never add the tool to a running session's cached prompt; only the deployment switch-off and a workspace Off, and undoing them, reach running sessions. Each call records Jev usage per workspace. The Jev key stays on the server (API and worker processes) and never reaches a sandbox or Connected Machine, which only run allowlisted read-only ripgrep and file reads. Windows Connected Machines do not get the tool. `tool_search` now lists every tool the query names exactly before BM25 results.

### Patch Changes

- cbb7aa4: Let a normally completed, closed turn owner reach bounded Modal deadline and repeated-provider-error capture without an interruption-only quiescence receipt. Failed or interrupted owners still require physical quiescence proof; checkpoint publication and other-writer fences are unchanged.
- 6fd328b: Restore a browser session when ending fails before controller dispatch.
- 9b9c6df: Mark a BrowserSession lost when its controller definitively reports that the browser no longer exists during suspension.
- 6eb431b: Allow authenticated hosts to replace an existing session MCP attachment with an accessible native connection through the standalone credential rotation API. An optional explicit replacement URL must match the native account's stored destination while the old URL remains a compare-and-set precondition. Preserve resource restrictions, version fencing, quiescence and idempotent receipts without replacing session history or accepted-attempt identity.
- f11a3e3: Compare connector policy snapshots by value when replaying an exact session attempt, so PostgreSQL JSONB key ordering cannot fail approval or human-handoff resume with a false ownership conflict.
- 36e1764: An exhausted model-provider quota no longer retries. A daily or monthly allowance (for example OpenRouter's `free-models-per-day` cap or a requests/tokens-per-day limit), a used-up quota (`insufficient_quota`), an account out of credits (HTTP 402), or a 429 whose provider retry hint exceeds 15 minutes now fails the turn at once with the new `provider_quota_exhausted` code, `retryable: false`, a `quotaScope`, plain-language copy, and the provider's text as `detail`, instead of five paced same-turn recoveries. Ordinary per-minute rate limits, and quota wording whose provider retry hint is a minute or less, remain `provider_rate_limited` and retryable. `@opengeni/runtime` exports the classifier (`classifyProviderQuotaError`), and model clients that let the OpenAI SDK retry classify the exact SDK error for a 429 and mark an exhausted one `x-should-retry: false`, so the SDK does not replay it either and both decisions always agree. Google's generic `RESOURCE_EXHAUSTED` status and snake_case per-minute metric ids (Vertex `requests_per_minute_per_project`) stay retryable. A quota-refused compaction request records the same `quotaScope` marker, and failed session detail projects it. Codex and SuperGrok subscription transports keep their credential-rotation and capacity-wait semantics.
- f2ee81e: Count the one-time verified-signup trial grant as OpenGeni credits when resolving the default model for new work. Any positive credit balance now selects the configured credits default (after a saved workspace default or a connected subscription), and a balance at or below zero falls back to the deployment default.
- c1756ef: Make operational signals truthful: the session recovery backlog no longer counts effectively paused sessions as stale, a read-only first sandbox probe that finds no path is recorded as a completed startup phase, Knowledge index deferrals log a content-free cause, and repeated warnings can be throttled per key with a suppressed count.
- Updated dependencies [084616e]
- Updated dependencies [b6d65a1]
- Updated dependencies [1a427e0]
- Updated dependencies [d582db0]
- Updated dependencies [6eb431b]
- Updated dependencies [48a8774]
- Updated dependencies [e422b62]
- Updated dependencies [f48191e]
- Updated dependencies [bd365b7]
  - @opengeni/contracts@5.2.0
  - @opengeni/config@3.0.0
  - @opengeni/codemode@0.6.3
  - @opengeni/codex@0.2.27

## 6.0.3

### Patch Changes

- f4192b2: Restore an active browser session when a suspension fails before controller dispatch.

## 6.0.2

### Patch Changes

- c41aecd: Fix attached-browser event pagination and dedicated-tab creation, isolate concurrent macOS native capture helpers, separate still screenshots from live-stream reads, and serialize exact frame bytes. Preserve bounded controller diagnostics, read legacy browser capabilities conservatively, and respect explicit placement and identity when reusing interaction resources. Install matching agent and controller builds together; native capture uses protocol version 3.

  Clean up partially allocated virtual desktops when a required executable is missing instead of letting an unhandled spawn error terminate the controller.

- 7217a79: Retry pending tool receipt registration only after PostgreSQL deadlock or serialization rollback, with fresh attempt fences and bounded backoff. Reject conflicting duplicate call content without replaying inference or tool effects.
- Updated dependencies [31cf6ac]
- Updated dependencies [c41aecd]
- Updated dependencies [23f4717]
- Updated dependencies [d0b5efd]
  - @opengeni/config@2.1.1
  - @opengeni/contracts@5.1.1
  - @opengeni/codex@0.2.26
  - @opengeni/codemode@0.6.2

## 6.0.1

### Patch Changes

- d92af11: Keep original command text through ambiguous launch recovery and persist it separately from bounded previews. Preserve whitespace, mark clipped previews with an ellipsis, and show complete commands on expansion and hover.
- f60ca2b: Raise Skill folder limits eightfold to 1,024 files, 2 MiB per file, and 8 MiB total, while retaining bounded reads and existing validation.
- 56ddcfb: Resolve retained screenshots referenced by copied fork history through their original session, including existing and nested forks. Require recorded fork ancestry and a copied image receipt, retaining workspace and private-file access checks.
- 38b9857: Track child unread attention from meaningful content rather than housekeeping, and acknowledge complete parent-consumed results for the exact initiating human. Preserve newer unseen work and manual attention intent, decode retained evidence losslessly, and reconcile proven historical consumption conservatively. Requires maintenance migration 0503 before starting the matching attention-aware writers.
- 90e089a: Add a rollout-gated short MCP OAuth state that stores encrypted, time-limited callback context in Postgres. Preserve legacy in-flight callbacks and one-use replay protection.
- b1ad0c6: Start Slack tasks with the initiating user's saved website repositories, variable sets, compute and tool selections in the destination workspace. Preserve draft content, explicit empty tools, and ordinary resource authorization.
- a463199: Repair workspace control revisions behind their retained event frontier, preventing historical control replay on each fresh browser load. Reject subsequent revision rollback without altering pause state, timers, or historical events. Stop refreshing last-started model metadata for unrelated control changes.
- Updated dependencies [a642885]
- Updated dependencies [793a6c9]
- Updated dependencies [d92af11]
- Updated dependencies [f60ca2b]
- Updated dependencies [a11d810]
- Updated dependencies [86c710a]
- Updated dependencies [ab3adb3]
- Updated dependencies [2f8bc58]
- Updated dependencies [a11d810]
- Updated dependencies [90e089a]
  - @opengeni/codex@0.2.25
  - @opengeni/config@2.1.0
  - @opengeni/contracts@5.1.0
  - @opengeni/codemode@0.6.1

## 6.0.0

### Major Changes

- 1bfb6a4: Remove Packs and their Workflow templates from the application, public clients,
  runtime, and active database schema. Plugins, Skills, Connections, sandbox
  environments, Knowledge, scheduled tasks, and event automations remain independent.

  PR Review now has its own setup authority and fixed automation template. Generic
  automation routes cannot mutate review-owned sources or triggers. The API contract
  revision changes; deploy matching server and client versions together.

  Migration 0482 is a destructive maintenance cutover: drain all API and worker
  database clients, settle Pack-related operations and queued Pack automation work,
  then apply migrations and provision roles before starting only matching binaries.
  It removes Pack data without a compatibility layer or data-preservation migration.
  Historical events mixing Pack and independent automation work block the cutover
  for explicit operator resolution; independent execution history is never silently deleted.
  Customized, shared, and re-scoped Skills, Connections, and session history are
  preserved; source-only Skills lose their active distribution owner.

### Minor Changes

- c64a94f: Support simultaneous authorized personal and workspace MCP account attachments with immutable account-qualified routing, sender isolation, and scheduled execution binding. Move attachment controls inside Connectors with readable ownership labels; keep account setup on the Capabilities page.
- 1c924ed: Add authorized, resumable literal search of saved user and completed assistant
  messages, including unloaded history. Workspace search can return one
  representative match per session; in-session Find returns every occurrence with
  stable event identity and original-text UTF-16 offsets. Requests and browser
  result batches remain bounded, with explicit continuation and provisional counts.

  Expose bounded exact-sequence history navigation and message highlighting for
  React hosts. The web console connects a contextual session-search dialog to
  full-history Find, preserves search state across navigation, and keeps ended
  conversations readable. Tool output, reasoning and unfinished delta-only
  assistant messages are outside the initial searchable scope. Exact Markdown
  matches use a labeled source excerpt that stays in place when Find closes;
  readers can explicitly restore the formatted message.

- 132b945: Add organization-owned integration acquisition policy with a discoverable catalog,
  revisioned administration API and SDK, and organization settings. Enforce selected
  provider and custom-protocol permissions on supported setup and installation paths
  at preparation and persistence boundaries.

  Preserve ordinary ownership and authorization, exact completed-request replay,
  unchanged reconciliation, cancellation and other reducing operations. Existing
  connection execution and credential refresh are not revoked by this policy.
  Deployment-configured tools and embedding-host session-local MCP configuration
  retain their existing admission rules; this is not a network or execution allowlist.

  Apply the organization integration policy migration and matching role provisioning
  with the matching runtime before enabling the setting. Older runtimes do not enforce
  the new acquisition policy. See `docs/organization-integration-policy.md` for the
  administration, identity, persistence and recovery contract.

- 779b16b: Add an account-authorized organization usage summary with bounded UTC periods,
  lossless metered totals, chart buckets, and paginated workspace totals. The
  organization Billing dashboard uses this summary instead of recent-event sums.

  Use a transaction-scoped, owner-only analytical capability to apply private
  session visibility once per session before aggregating. Separate workspace-page
  reads retain the selected cutoff and do not recompute organization totals.

- 7e2436a: Keep ordinary chat attachments out of Knowledge unless selected as useful evidence or a reusable reference. Distinguish supporting evidence from discoverable references, preserve exact originals and revisions, and add read-only collection and duplicate discovery before saving. Includes maintenance migration 0469; old runtimes must be drained before activation.
- c66ba31: Unify interactive and trusted-backend OAuth setup on native workspace connections
  with optional canonical-user ownership, persisted lifecycle bindings, native
  credential refresh, and captured execution authority.

  Remove the superseded host binding, delegation, and credential-resolver API/SDK
  surfaces and runtime configuration. Migrate integrations to ordinary OAuth
  connections before upgrading; retired host selections are rejected rather than
  translated or silently replaced. Apply the matching database migrations and role
  provisioning with the runtime. Historical records remain preserved. See
  `docs/remote-mcp-credentials.md` for the cutover contract.

  Share connection setup, provider identity, loading states, conversation cards,
  composer, and activity surfaces between the console and React SDK. Preserve
  personal-account consent and native sharing authority, and keep interaction-only
  connection and command panels outside the initial session bundle.

### Patch Changes

- 4ddab4a: Preserve a warm snapshot's sole turn holder through its original bounded capture
  deadline, even after logical turn closure. Reaper sweeps must not steal a live
  finalizer's snapshot and extend interactive waiting with the drain capture budget.
  Expired claims remain recoverable, and closed attempts gain no execution authority.
- 59bad3f: Improve large session-history query plans with correlated scope statistics and an equivalent dynamic-owner RLS capability expression, preserving permissions, payloads and pagination.
- c31a951: Add connection-bound MCP tool permission discovery and Allow/Ask/Block management through the existing approval ledger, enforced consistently for direct tools and Codemode.

  Let workspace-default sessions inherit newly connected apps while retaining per-session connector exclusions and exact explicit selections. Present connected apps, logos, health, and reconnection in the composer connector menu. Keep internal runtime controls out of workspace settings and use Capabilities consistently in settings navigation.

- f90d628: Add explicit managed-human consent for same-session singleton Modal recovery from
  an exact older CURRENT checkpoint. Protect membership, route and artifact identity,
  retain durable replay receipts and generation provenance, and reconstruct a model
  warning before later inference. Separate consent from verified restoration and
  never replay failed commands. Refuse Retry on an unchanged blocked effective route
  without blocking an independently selected Connected Machine. Additive migration
  0495 keeps consent DB-disabled until operator-verified compatible rollout; permanent
  consent receipts reject old inference claims even after disabling consent or lease
  replacement. Only the warning-aware worker declares the scoped protocol.
  Preserve explicit failed-turn Retry after verified recovery or Connected Machine
  selection, and retain consent identity when post-accept status reads lose access.
  Keep fresh migration-before-role-provisioning and later runtime-role provisioning
  safe, with SELECT-only rollout access and owner-only activation.
- 348e54d: Use Sandbox Environment terminology in user-facing controls, errors, tool descriptions, and runtime guidance. Existing rig routes, tool names, IDs, permissions, and stored definitions remain unchanged.
- d1ab270: Persist configured skill catalogs as versioned conversation context, preserving prior prompt history across catalog updates, retries, compaction, and forks.
- f90d628: Repair user-owned device approval under a FORCE-RLS non-bypass database owner.
  Fence organization membership before tenancy and request locks, retain workspace
  membership row locks, and reject contention without a reverse-order wait.
  Requires the 0498 maintenance cutover; broader scoped-compute readers are not
  changed by this bounded enrollment repair.
- 0bf014d: Allow Codex subscription-source changes while work is active. Preserve accepted
  turns' original source through credential leasing, recovery, and capacity waits,
  while new work uses the workspace's selected source. Connecting a workspace
  subscription no longer overwrites an explicit source preference. Workspace
  connection controls remain available while inheriting organization subscriptions.
- c702159: Stop retrying permanent runtime database posture and configuration failures as
  connection errors. Validate local startup prerequisites, prevent overlapping
  launchers from rotating live database credentials, and check database posture
  before building the development sandbox.
- 3977932: Polish MCP OAuth consent for every client: shared OpenGeni chrome, organization and workspace pickers at authorize time, tokens that follow the chosen workspace, and token exchange that accepts any registered redirect URI.
- f90d628: Keep the global Modal orphan-safety inventory complete under a non-bypass migration owner without granting runtime roles cross-tenant table access.
- 9d5bb1c: Persist the periodic workspace capture attempt clock so failed snapshots respect the configured interval instead of blocking commands again on the next heartbeat. Forced recovery captures still bypass periodic cadence without bypassing ownership or active-capture fences.
- 621201d: Distinguish queued sessions from running agents and expose durable dispatch wait
  evidence in session detail reads, including retry timing and recorded errors.
- e261b39: Retain background command outcomes without starting a new agent turn unless the session is explicitly waiting for input. Let compatible command notices accompany later input without blocking messages behind a command backlog. Coalesce different originating turns only when their resolved human and complete inherited execution authority match, retaining original lineage and existing batch limits.
- f90d628: Add durable native supervision for supported stock Modal non-PTY commands. Retain
  the idle invocation before provider dispatch and user-code release, verify native
  capability on the exact warm instance, persist descendant-quiescence proof
  before supervisor acknowledgment, and fence canonical settlement on provider exit
  plus captured output. Deadline cancellation keeps a monotonic stdin fence without
  cancelling ordinarily adopted background commands. Unsupported and legacy paths
  remain explicit and cannot manufacture supervision proof.
- f90d628: Keep the retry writer's activity-gated transaction explicit at the canonical
  writer boundary while binding its required recovery-route check through root
  composition. Preserve the writer audit and retry safety checks unchanged.
- 0bf014d: Add a session-authorized Codex account projection. Capacity retry choices follow
  the waiting turn's accepted subscription pool after source changes, including
  Disabled. Running turns keep their accepted account label while next-turn
  choices and workspace settings continue to use the current source.
- 6ed7dfb: Give session-message search a dedicated bounded HTTP metric label so its request latency and failures can be distinguished from unknown routes without recording search text or workspace IDs.

  The stock web app debounces committed search queries, keeps partial results on transient failures, and resumes failed scans from their last successful continuation instead of discarding progress. Authorization failures still clear retained content.

  Reduce long-message search database work by reusing the already-authorized event identity and scoped transaction, and coalescing adjacent scalar windows within the existing per-request budget. Literal Unicode matching, lossless offsets, live visibility checks, and ordinary conversation slice bounds are preserved.

- b0a5a54: Allow sharing a private session while work is running or queued, preserving its accepted human identity, selected connections and resource access. Viewer access still changes immediately; privatization and permission revocation remain fenced. Requires a maintenance migration.
- 1d6e49a: Preserve shared image attachments on service-triggered turns without human authority by matching the file ACL subject scope. Keep private files and protected Drive files inaccessible without the required authority, and restore the caller's database scope after lookup.
- 23d4542: Allow repeatedly unobservable, explicitly stopping managed commands to enter the existing checkpoint-before-termination recovery after owner quiescence and idle grace. Preserve running commands, all other writer fences, failed-checkpoint recovery, and real late exit proof.
- f90d628: Keep supervised commands out of legacy observation-error containment, including
  stale enrollment, checkpoint publication and published-capture teardown retries.
  Fence older control writers at the database boundary before enabling supervision.
- 9d9b94b: Expose named Plugin removal impact using the same classifier as Skill source
  release. Preserve customized/re-scoped Skills, resolve remaining owner names
  within workspace scope, and add optional preview-token fencing with refreshed
  409 previews when ownership or Skill state changes before confirmation. Retain
  Connection ownership, immutable Skill history, and human-only removal authority.

  Freeze the pre-comparison locked Skill head set through cleanup. A head made
  visible by another subject during confirmation now aborts removal with a refreshed
  409 preview instead of silently expanding the deactivation set.

- f7c9169: Support verified-email Google and GitHub sign-in linking and personal sign-in
  method management. Preserve canonical user ownership and email-verification
  checks, require recent authentication for sensitive changes, prevent removal of
  the last usable method, and respect explicit provider disconnection until a
  verified reconnect. Surface actionable callback feedback and security
  notification outcomes without granting integration access.
- 0ea365c: Route user-facing reports, including secondary audit outputs, to native document
  Artifacts before authoring. Persist explicit report requirements and require
  server-verified current-head inspection evidence at goal completion, preserving
  ordinary chat, internal worker findings, code navigation and explicitly requested
  local-file workflows. Keep unavailable or failed report delivery incomplete
  instead of silently substituting sandbox links.
- Updated dependencies [6d0a4de]
- Updated dependencies [c64a94f]
- Updated dependencies [c387603]
- Updated dependencies [1c924ed]
- Updated dependencies [c31a951]
- Updated dependencies [f90d628]
- Updated dependencies [aa09567]
- Updated dependencies [d1ab270]
- Updated dependencies [c702159]
- Updated dependencies [c8bb974]
- Updated dependencies [3fa175e]
- Updated dependencies [332a02d]
- Updated dependencies [132b945]
- Updated dependencies [779b16b]
- Updated dependencies [1cb688d]
- Updated dependencies [9d9b94b]
- Updated dependencies [621201d]
- Updated dependencies [f90d628]
- Updated dependencies [a6251eb]
- Updated dependencies [ac006ef]
- Updated dependencies [1bfb6a4]
- Updated dependencies [7e2436a]
- Updated dependencies [c2b66d5]
- Updated dependencies [9d9b94b]
- Updated dependencies [c66ba31]
- Updated dependencies [f7c9169]
- Updated dependencies [0ea365c]
  - @opengeni/contracts@5.0.0
  - @opengeni/codex@0.2.24
  - @opengeni/config@2.0.0
  - @opengeni/codemode@0.6.0

## 5.0.1

### Patch Changes

- de5569f: Allow native full organization API keys to administer host MCP resolver registrations. Align request authorization, live-key revalidation, and the database write trigger with the public key contract without granting human organization-admin permissions. Read-only, workspace-scoped, delegated, external-user, expired, and revoked credentials remain denied.
- 7746251: Prevent agent-authored workspace instruction changes from replacing the complete active policy, fence unsafe older pending revisions at approval, and show reviewers the current and proposed instruction text before approval.
- Updated dependencies [7746251]
- Updated dependencies [85cafd0]
  - @opengeni/contracts@4.1.0
  - @opengeni/codemode@0.5.9
  - @opengeni/config@1.2.2

## 5.0.0

### Major Changes

- efeaa9c: Replace autonomous Memory and reviewed Knowledge authoring with structured Knowledge entries, exact revisions, evidence, groups and nonblocking review. Add centralized Agent learning defaults with chat and scheduled-task overrides, private original-file ownership, canonical source preparation and rebuildable retrieval. Retire legacy Memory/learning mutation APIs and SDK methods; migration 0461 requires a drained maintenance cutover and the matching runtime. See docs/knowledge.md and docs/deployment.md.

### Minor Changes

- ad9dc2f: Add a non-provisioning external identity lookup and opt-in, operation-keyed service workspace onboarding. Cancellation-bearing revocation reuses native membership teardown and the organization-workspace receipt ledger to fence a delayed grant, including when no membership exists yet. Legacy unkeyed onboarding remains unchanged and cannot be fenced retroactively.
- da4a85f: Add native organization-admin MCP credential resolver registration by stable workspace externalSource. Support encrypted, idempotent generation-checked endpoint/secret rotation and revocation with fail-closed namespace routing and live physical-use fencing. Existing accepted participant, schedule and child authority remains unchanged. Migration 0463 requires maintenance and matching API/worker binaries.

### Patch Changes

- 50ac837: Add explicit accepted-turn host binding selection for shared conversations. Capture each participant's exact owner delegation without changing the configured destination or borrowing creator credentials, preserve fixed bindings and scheduled/child live authority checks, and apply session-local server configuration to follow-up selection. Document the supported empty-session then first-text admission flow.
- 71fd840: Accept Microsoft's token responses that omit offline_access from access-token scopes. Require a refresh token as proof of offline access, preserve that capability after refresh, and continue rejecting missing resource permissions.
- 123cf57: Make agent-authored workspace instruction changes non-destructive: append new rules by default, require one exact anchor for edits or removals, and reserve complete replacement for an explicit mode while preserving baseline conflict checks and instruction budgets.
- Updated dependencies [50ac837]
- Updated dependencies [ad9dc2f]
- Updated dependencies [750060c]
- Updated dependencies [da4a85f]
- Updated dependencies [123cf57]
- Updated dependencies [efeaa9c]
  - @opengeni/contracts@4.0.0
  - @opengeni/config@1.2.1
  - @opengeni/codemode@0.5.8
  - @opengeni/codex@0.2.23

## 4.4.0

### Minor Changes

- e41027c: Add opt-in MCP operation outcome recovery through a configured read-only provider receipt tool. Persist exact operation identity before dispatch, retain original invocation outcomes separately from late receipts, and revalidate current authority across accepted attempts without replaying mutations. Preserve arbitrary SDK call IDs as correlation rather than replacing UUID operation identity.

  Apply the additive operation-ledger migration and runtime-role provisioning, and upgrade all claim-capable workers to the membership-first lock order before enabling provider mappings. Providers must implement the documented observation contract; unsupported providers and historical operations without captured authority are not automatically recoverable.

- 935af4e: Add an authorized standalone session inline MCP credential rotation operation with durable idempotent receipts, exact destination and credential-version fencing, and atomic quiescence checks. Expose the operation through HTTP and the SDK without sending messages, scheduling work, retrying external mutations, or widening connection or attempt authority. Keep existing message-bound credential updates unchanged.

### Patch Changes

- 4e2b59d: Deduplicate concurrent computer-session preparation across both operation unique indexes while preserving workspace-scoped replay and immutable request checks.
- a1bb8db: Preserve sender attribution for initial and follow-up user messages in host exports by resolving their exact triggering turn. Canonical events, existing exports, and checkpoints remain unchanged.
- 488a69b: Expose bounded current-failure evidence on session detail reads so recovery diagnostics do not depend on timeline pagination. Show recorded consecutive retry streaks without inventing lifetime totals, and distinguish Codex account assignment, affinity/lease reuse, and actual switches without changing allocation policy.

  Read session status and its replay cursor coherently, decode bounded diagnostics through the lossless storage codec, and record account transitions atomically against the current assignment with attempt-keyed replay and compatible switch reasons.

- 22a9e4d: Bound sandbox acquisition and workspace mutation waits across repeated archive capture attempts. Honor the first observed capture's persisted timeout once, without letting expired or renewed claims replenish the caller's deadline; retain all capture and writer fences.

  Release an exact unpublished drain capture after its provider promise rejects, including after a local timeout, so waiting turns can resume the intact live sandbox. Unresolved captures, published archives, successors, and provider teardown remain fenced.

  Fresh claims allocate a new provider request identity; uninterrupted replacements retain it, preventing stale snapshot replay after an intervening writer re-arms the lease.

- Updated dependencies [4e2b59d]
- Updated dependencies [e41027c]
- Updated dependencies [488a69b]
- Updated dependencies [935af4e]
- Updated dependencies [d08dbb6]
  - @opengeni/contracts@3.1.0
  - @opengeni/config@1.2.0
  - @opengeni/codemode@0.5.7

## 4.3.3

### Patch Changes

- e1a50ba: Spool Linux host-backed workspace archives through capture, object storage, and cold restore instead of materializing whole JSON/base64 payloads. Isolate each upload at a fresh physical locator and verify stored bytes without assuming conditional-PUT support. Preserve legacy locators, archive format, configured restore limits, and lease capture/publication authority; retain candidates after ambiguous publication outcomes.
- Updated dependencies [e1a50ba]
  - @opengeni/contracts@3.0.2
  - @opengeni/codemode@0.5.6
  - @opengeni/config@1.1.2

## 4.3.2

### Patch Changes

- a9cc903: Allow workspace artifact mutations from service turns that retain an immutable causal human only while the exact live attempt, selected artifact tool, publish permission, and interruption fences all hold. Document that the causal-human field is never standalone authorization, and continue to reject pure service work and stale attempts.

## 4.3.1

### Patch Changes

- 6a60a58: Canonicalize typed Skill review cards using host-owned choices. Allow explicit
  authorized Save/Don't save responses to existing exact-bound cards with the
  legacy Other flag and null option descriptions, without rewriting cards,
  manufacturing consent, or weakening human, tenant, turn, or revision fences.
  Apply rolling migration 0458; pre-0435 runtimes remain unsupported.
- Updated dependencies [6a60a58]
  - @opengeni/contracts@3.0.1
  - @opengeni/codemode@0.5.5
  - @opengeni/config@1.1.1

## 4.3.0

### Minor Changes

- cffd21b: Use authenticated canonical users instead of session end-user labels. Session
  creation rejects caller-supplied identity scope; list filters use scopeSubjectId.
  Chat user mode uses asUser and explicit workspace membership, while collaborators
  address the same session ID. Reopen legacy user-namespaced chats by session ID.

  Retire active session Memory in favor of task notes. Historical session Memory
  remains stored and old selectors hydrate as off, never workspace. User Memory
  uses the verified active-turn user. Preserve frozen scheduled agent-reach policy.
  Migration 0457 requires the documented maintenance cutover and matching writers.

- cffd21b: Add organization-scoped external users, explicit native identity linking, shared
  white-label Connect flows and Site lifecycle/bridge surfaces. Add opt-in durable
  host-MCP delegation and renewal while preserving simple short-lived credentials,
  existing schedule authority and approval behavior. Share native/embedded device
  polling and setup components, and synchronize developer integration Skills with
  the installable Product Integration Pack.

  Database migrations 0437–0457 require the documented maintenance/cutover procedure;
  older API and worker writers must not be restarted after activation. Provider
  OAuth applications and host resolvers remain deployment configuration, not
  automatic external provisioning. No package is published by this changeset.

### Patch Changes

- Updated dependencies [cffd21b]
- Updated dependencies [f8be7df]
- Updated dependencies [cffd21b]
  - @opengeni/contracts@3.0.0
  - @opengeni/config@1.1.0
  - @opengeni/codemode@0.5.4

## 4.2.2

### Patch Changes

- 87fbd92: Preserve full session messages and tool output through database paging, compact
  event delivery, SSE, browser rendering, and copying. Remove browser per-event
  preview truncation while retaining history pagination and backpressure. Events
  larger than a page or loaded-window byte target are delivered intact on their own.
- 5835c27: Reduce database round trips for large session-event history pages by fetching up to 256 rows per internal batch. Preserve the existing full-payload transfer byte budget, exact event content, pagination cursors, and tenant isolation.
- eb21b93: Allow explicitly audited operator recovery from an exact historical sandbox checkpoint while preserving generation gaps and existing restore verification.
- Updated dependencies [1b0f4f2]
  - @opengeni/contracts@2.15.2
  - @opengeni/codemode@0.5.3
  - @opengeni/config@1.0.4

## 4.2.1

### Patch Changes

- 068be26: Complete a Skill save in the same transaction as its one verified human chat decision. Show the full immutable Skill folder, preserve exact scope and revision checks, and refuse delegated, stale, or mismatched approval. Autonomous saves activate directly; declining a proposal preserves existing active guidance.
- 69924e8: Preserve structured model-history ordering through PostgreSQL replay and pending-tool recovery. Retain authorized uploaded images across turns and compaction input, preserve images in retained messages, and include their projected token cost in compaction retention budgets. Migration requires draining writers.
- 9233c88: Fix SuperGrok disconnect failing when sessions are pinned to the account. Clear
  the credential pin and its source atomically, preserving stale-update fencing.
- 2fa33e4: Unify installed and authored workspace Skills behind one versioned text-folder
  store and shared editor. Derive names and descriptions from mandatory SKILL.md
  frontmatter, provide eager sandbox-free reading with exact requested paths, and
  expose lazy search, install, save, checkout, and publish tools under workspace
  Learning policy. Preserve workspace customizations on source updates and let
  embedding hosts narrow bundled guidance independently of lazy tool discovery.

  Migration 0433 is a maintenance cutover: drain old runtimes and use the
  parser-backed migration runner. Preserve historical snapshots and archive legacy
  configuration before conversion; invalid or pinned headerless configuration
  requires explicit repair before migration. See docs/skills-lifecycle.md for the
  deployment procedure and compatibility boundaries.

- Updated dependencies [068be26]
- Updated dependencies [2fa33e4]
  - @opengeni/contracts@2.15.1
  - @opengeni/config@1.0.3
  - @opengeni/codemode@0.5.2

## 4.2.0

### Minor Changes

- 9827c25: Add message action slots and an optional source message boundary for managed-human forks. The web UI places turn feedback and Fork from here beside Copy and the timestamp. Message forks preserve existing authorization and idempotency, copy only the selected canonical history prefix, and reject ambiguous, compacted, or incomplete boundaries.

  Migration 0429 requires draining the API and both worker pools and provisioning the updated runtime routine contract before starting the new binary.

### Patch Changes

- 231b103: Apply explicit Codex account switches and unpins to capacity-blocked turns, preserving the same turn and history through recovery. Display current account selection separately from future preferences and report when a switch requests a capacity recheck.
- 392c575: Retain Modal command handles, provider execution identities, output, and exact exit status across provider-client reconstruction. Persist stream pages before acknowledging their cursors, and treat unavailable historical locators as unknown rather than proof of process loss. Execution status is provider-owned and never read from sandbox-writable files.
- 7e73418: Repair protocol-0 continuation admission to consider every explicitly selected personal Variable Set, preserving current-owner, grant, authority-epoch and causal-attempt fences. Include rolling migration 0430 in the published database package.
- 14dd6fe: Add workspace transcription provider preferences and optional fallback after explicit rejection, preserving recording pins after uncertain or successful attempts. Refresh expired SuperGrok credentials and recover the provider's invalid-credential 403 response.
- Updated dependencies [231b103]
- Updated dependencies [392c575]
- Updated dependencies [9827c25]
- Updated dependencies [5904fd1]
- Updated dependencies [14dd6fe]
  - @opengeni/contracts@2.15.0
  - @opengeni/codemode@0.5.1
  - @opengeni/config@1.0.2

## 4.1.0

### Minor Changes

- 4536385: Expose independently configurable GitHub action approval policies for routine writes, review submission, and pull-request merges, while preserving capability-first defaults, explicit policies, and attempt-frozen execution authority.
- fa12951: Separate command interaction from session history. Add bounded retained-output command reads and use the same operation for command waits. Terminal reads observe completion and suppress only still-pending completion notifications; running reads, claimed notifications, and historical tool results remain unchanged.

  Make session history conversation-first with complete-message pagination and explicit results, tools, and debug views. Preserve cursor detail selection, provide oversized-message continuation, and keep queued prompts distinct from processed conversation. Update concise model guidance for the new surfaces.

  `command_wait` now uses `waitSeconds`, an output cursor, and the same flat result as `command_read`; clients using the previous command wrapper must update. Apply the additive command-observation migration before starting the new readers.

- d9dbd5d: Add authenticated general feedback and session/turn ratings with exact comments,
  author attribution, idempotent submission, and private-session isolation.
- c90f3fc: Make workspace tool and plugin defaults independently inheritable. Add explicit reset patches, preserve existing custom lists, and prevent unrelated plugin saves from freezing built-in defaults. Show inherited/custom mode and partial group counts, with deliberate customization and inspectable individual tools.
- 0c39126: Add per-connection turn-model permissions and organization workspace assignment
  for subscriptions and model gateways. Migration 0424 requires draining APIs and
  workers; do not restart older workers after policies are enabled.

  Fix organization Codex sign-in in local mode without granting managed-human reset-credit ownership to the local administrator.

- 0c39126: Add organization SuperGrok subscription pools with multiple accounts, active selection, rotation, and shared/Personal workspace inheritance. Preserve the exact subscription scope of accepted work and organization-only management authority. Unify Codex and SuperGrok account rows and connection actions in the web settings.

  Maintenance migration 0423 requires draining API and workers before upgrading. Older workers cannot parse the organization subscription scope.

- b1d3673: Add the `@opengeni/sdk/chat` facade (`OpenGeni`, `Chat`, `createChatHandler`, Vercel AI SDK and OpenAI adapters) and the `@opengeni/react/chat` drop-in component. Sessions gain `agentAccess`, an opaque `endUser` label, and `memoryScope`, enforced in the session-authorization seam so one workspace per customer can hold isolated, per-user, or shared chats. Organization API keys gain `access: "read"` and `GET /v1/organizations/:id/sessions`. Close the tool-widening paths: child tool selection, agent tool-policy updates, scheduled-task sessions, and the Codemode SDK proxy can no longer exceed the creating session.

  Private-memory identities use bounded hashes of exact source/user tuples. Correction, archival, and replacement enforce the private writable scope. Chat reload restores unresolved approvals and questions, and the chat component uses the complete human-input form with multiple selections and Other answers.

  Session-scoped discovery preserves the embedding host's allowlist. Responses streams emit the complete message/content lifecycle with stable per-response IDs, including incomplete settlement for human waits and cancellation. Streaming text preserves the same paragraph separators as the final reply.

- 0a81cc8: Add durable workspace pause/resume timers with duration controls, countdowns,
  manual cancellation, and idempotent worker execution. Migration 0420 requires a
  maintenance deployment: drain old writers and deploy matching API/workers.

### Patch Changes

- 22a6704: Correct oversized session-message continuation with bounded source slicing, preserve typed runner terminal failures during command observation, and keep retained command output readable when live refresh encounters a recognized temporary transport failure. Refresh fallback rechecks API authorization and explicitly marks unavailable freshness; it does not mask integrity or authorization errors.
- 7dac7e3: Decode bounded session-monitoring progress scalars with their persisted lossless codec version. Preserve canonical prefixes and explicit truncation without reporting encoded storage lengths as original character counts. Clarify that completion joins use the last consumed event cursor, not a session snapshot watermark that may already include an unread child result.

  Validate the complete stored progress scalar before decoding its bounded prefix, preserving literal malformed codec markers even when an invalid suffix lies beyond the read boundary.

- 8db607e: Make GitHub connector writes capability-first when no explicit workspace action policy matches, while preserving explicit Allow, Ask, and Block decisions.
- d8b0012: Keep parked child waits and active goals from reporting successful completion to their parent. Preserve durable wake deadlines and actual terminal result delivery.
- fa2b99a: Preserve workflow wake retries until pending input is admitted, while future waits stay parked at their deadline, and expose current session waits and waiting descendant counts. Refresh wait status on live events and retain the status projection sequence so newer session reads cannot be overwritten by older events.
- 5cc0aac: Keep workspace Codex source changes, automatic account assignments, and last-used account bookkeeping from changing conversation recency or session ordering. Explicit account switches and semantic session activity retain their existing behavior.
- 341a7f6: Preserve exact command-launch and wait-timeout causal authority, keep separate humans in separate claims, and recover only proven unconsumed pre-claim failures without extending personal grants.
- c1dc59b: Default sessions_list and session_get MCP results to compact actionable discovery and child-management state. Retain the legacy bounded projections through detail: full, including effectiveToolPolicy for configuration inspection. Make related-work evidence opt-in for plain compact browse while automatically retaining search evidence and its advisory-only authority facts. Preserve exact cursors, goal completion evidence, pause reasons, and REST/UI defaults; keep target-only ancestor control redacted in both detail modes.
- ac7e07c: Retire background-command tracking after a connected agent instance is replaced, explicitly stopped, or revoked. Preserve historical records without waking old sessions, drain cleanup batches promptly, and scope session stopping counts to the requested trees.
- cc1bfe0: Keep filtered session rows consistent with their selection, track concurrent folder detachment in activity revisions, bound sparse creator lookups, and reject timestamp precision that cannot be preserved.
- ba9e5a4: Preserve the exact causal human on child lifecycle follow-up turns so personal session resources remain admissible, isolate child/goal causal claims from complete Agent Steer identities and malformed authority-bearing updates, keep atomic pre-claim database failures—including replay-compatible disposition-only results—retryable instead of terminally discarding pending work, and provide a root-only, failure-epoch-fenced repair whose idempotency receipt binds the exact recovery authority for sessions terminalized by older workers.
- c69ad5f: Preserve externally managed history across opaque compaction checkpoints and verify conversation persistence before continuation. Reject shifted history prefixes and conflicting saved items instead of silently losing completed work.
- 123a72a: Keep managed-human workspace grants scoped to organizations where the subject has an active membership.
- 1c4b707: Expose goal_resume so agents can resume any paused goal without a pause-reason restriction; include it for existing sessions with goal_pause.
- cc1bfe0: Add cursor-bound project, creator, and date filters to session pages so grouped sidebars can load older sessions independently within the group being viewed.
- 414946c: Inherit model, effort and speed from the latest started turn for follow-ups and voice handoffs. Project the same policy in session reads, fresh drafts and Insights without changing accepted turns or stored creation settings.
- b1d479b: Repeat Pause on an already-paused session to re-arm its missing exact-attempt quiescence reconciliation without resuming work.
- 64c7c5c: Allow Personal workspaces to inherit their organization's Codex subscription pool and select an explicit source while retaining organization-only credential management. Keep Personal session creation available when optional Only-me session tenancy is unavailable.

  Activate inheritance through maintenance migration 0422 after draining old API and worker processes. Include Personal workspaces in organization Codex source-change protection and capacity wakeups.

- 6e167eb: Preserve the supplied admission failure message and classified cause on the durable session failure event when no turn could be claimed.
- 575af5b: Expose workspace project management through MCP, including shared pins/order, session filing, project-filtered discovery and project selection at session creation. Bundle concise, on-demand project organization guidance for every agent, independent of compute backend and retain existing session authorization checks.
- b43a821: Prevent concurrent organization recovery dispatchers from claiming the same notification from an old statement snapshot. Preserve immutable delivery evidence and require READ COMMITTED claim transactions.
- 6de9fe3: Preserve newer composer draft content and project provenance when a stale realtime create records selection history, while exposing optional project provenance consistently across contracts and SDK types. Store project provenance in rolling-upgrade-safe additive draft columns behind a metadata fence, concurrent partial index, bounded resumable backfill, and separately committed validation; dual-write mixed-version draft writers without holding schema locks across legacy-row scans. Avoid passive hydration autosaves and honor the latest route launch intent when hydration completes.
- 732bece: Park sandbox rotation recovery until durable lease progress, and wake the exact waiting turn when provider loss, failed warming, reaping, or teardown release ends its rotation wait.
- 19c51e2: Preserve exact canonical producer authority when a concurrent reusable scheduled occurrence binds after session materialization, using the existing source-to-target receipt without weakening grant revalidation.
- baa1c36: Match scheduled-run admission to the target session's tool-inheritance semantics.
  An omitted turn override inherits session tools instead of being mistaken for an
  explicit empty override. Explicit overrides and policy-drift rejection remain
  unchanged.
- 380bba5: Preserve scheduled generated-session recovery after a model switch by validating stored creation policy separately from the latest-started display policy.
- cda46e8: Resolve session schedule indicators from current indexed schedule targets, including paused schedules. Add a session-filtered schedules list so existing chats link to all schedules targeting them without reading workspace schedules in the browser.
- c1dc59b: Project persisted and effective session tool-policy provenance through the existing related-session access boundary. Target-only reads no longer reveal an unauthorized ancestor through inheritedFromSessionId, including when full MCP detail rebuilds effective policy afterward; root-authorized lineage and all other policy fields remain unchanged.
- 2fb17fd: Track published Site session origin automatically; add origin-filtered session
  listing and skill defaults for reusable in-Site conversations. Site provenance
  remains independent of project placement and session authorization.
- 107aa14: Support standard SDK/React conversations in Sites and sandbox previews, direct
  HTML/source uploads, exact deployment package pins, and embedded layout/queue
  defaults. Refresh exhausted Grok capacity after external resets.
- d8a70ec: Unify first-party and integration tools behind one workspace gateway for MCP, model execution, Codemode, SDK, and browser clients; require host-confirmed SDK approval for human-gated model calls, keep Codemode claims live through gateway preparation, and deduplicate reclaimed tool-created events; add opt-in resource-bound MCP OAuth; ship governed self-contained HTML Sites with retained source, version rollback, an exact-version direct-call tool allowlist, and a native Site-authoring Skill; and default Modal self-hosts to OpenGeni's public digest-pinned desktop runtime image.
- Updated dependencies [22a6704]
- Updated dependencies [4536385]
- Updated dependencies [7dac7e3]
- Updated dependencies [fa2b99a]
- Updated dependencies [694c1ff]
- Updated dependencies [fa12951]
- Updated dependencies [c1dc59b]
- Updated dependencies [52cf486]
- Updated dependencies [1fc0889]
- Updated dependencies [d06450c]
- Updated dependencies [d9dbd5d]
- Updated dependencies [c69ad5f]
- Updated dependencies [1c4b707]
- Updated dependencies [c90f3fc]
- Updated dependencies [414946c]
- Updated dependencies [0c39126]
- Updated dependencies [ba890d1]
- Updated dependencies [0c39126]
- Updated dependencies [575af5b]
- Updated dependencies [6de9fe3]
- Updated dependencies [cda46e8]
- Updated dependencies [b1d3673]
- Updated dependencies [2fb17fd]
- Updated dependencies [3a29372]
- Updated dependencies [107aa14]
- Updated dependencies [92cdc31]
- Updated dependencies [d8a70ec]
- Updated dependencies [0a81cc8]
  - @opengeni/contracts@2.14.0
  - @opengeni/codex@0.2.22
  - @opengeni/config@1.0.1
  - @opengeni/network@0.3.1
  - @opengeni/codemode@0.5.0

## 4.0.0

### Major Changes

- 6f84c02: Make durable Codex credential leasing unconditional, preserve rotation-off as an active-account-only capacity policy, and recover definitive credential failures through same-turn failover or durable capacity waiting.

### Minor Changes

- 6b65383: Replace goal-scoped long waits with self-only session-level `wait_for_input`, add provider-neutral `command_wait`, and deliver terminal background-command proof as exactly-once durable agent input with workflow wakes for nonterminal sessions while preserving event-only audit for terminal sessions.

### Patch Changes

- Updated dependencies [876396d]
- Updated dependencies [6b65383]
- Updated dependencies [6f84c02]
  - @opengeni/network@0.3.0
  - @opengeni/contracts@2.13.0
  - @opengeni/config@1.0.0
  - @opengeni/codex@0.2.21
  - @opengeni/codemode@0.4.27

## 3.9.0

### Minor Changes

- b420912: Show the exact model-visible system instructions, tools, skills, and token counts in the session Debug inspector.

### Patch Changes

- fab39d2: Keep lazy session-history reads sub-second on large sessions by fitting each browser window and its continuation lookahead into one byte- and count-bounded database query instead of walking the page through sequential reads. Fresh and foreground tail loads may use one additional bounded page to preserve a complete turn boundary, and foreground replacement keeps the prior timeline visible until the new window is ready.
- Updated dependencies [d63ee0f]
- Updated dependencies [b420912]
  - @opengeni/contracts@2.12.0
  - @opengeni/codemode@0.4.26
  - @opengeni/config@0.23.3

## 3.8.2

### Patch Changes

- 38de50d: Enable Workspace Memory by default, require approval by default for agent-derived Workspace instructions and Skills, and use the clearer Require approval label for workspace and organization governance settings.
- 8b42f58: Add the managed-human API, SDK, and atomic tenant lifecycle for creating additional organizations with an isolated Personal workspace and a first shared team workspace.
- 0214875: Price model usage with a 5% default markup and dedicated cache-write rates, and show provider estimates, equivalent OpenGeni credit prices, and actual credit-path prices separately in Insights.
- 7c5897f: Preempt sandbox writers and persistent interaction holders at the provider-deadline rotation lead boundary so the zero-holder reaper can capture the exact workspace generation before provider destruction.
- e2a668b: Add the built-in, instruction-only OpenGeni Product Integration Pack for adaptive, tenant-safe customer integrations, with explicit per-session activation that prevents its implementation guidance from entering ordinary customer chats.
- ae19409: Enforce idle-boundary admission for skip-overlap scheduled sessions.
- Updated dependencies [38de50d]
- Updated dependencies [8b42f58]
- Updated dependencies [0214875]
- Updated dependencies [e2a668b]
- Updated dependencies [9c45eae]
  - @opengeni/contracts@2.11.1
  - @opengeni/config@0.23.2
  - @opengeni/codemode@0.4.25

## 3.8.1

### Patch Changes

- a5ca001: Keep provider-deadline interaction cleanup visible under FORCE RLS for lease-free controllers, prevent unrelated overdue leases from starving the bounded deadline batch, and clean already-draining Modal leases at their deadline.
- Updated dependencies [8f81b57]
  - @opengeni/contracts@2.11.0
  - @opengeni/codemode@0.4.24
  - @opengeni/config@0.23.1

## 3.8.0

### Minor Changes

- 2d0fad4: Add deployment-defined model catalogs and cost policy, workspace-managed Gateway and OpenRouter credentials plus custom models, a separate deployment-managed OpenRouter rail, live catalog refresh, the `list_models` agent tool, and model-picker/API/SDK support for the new catalog surfaces.
- 9fe5c5b: Add organization-scoped Vercel AI Gateway and OpenRouter BYOK/custom models for shared workspaces while preserving independent workspace connections.

### Patch Changes

- f5e2dfc: Keep canonical large session-event payloads lossless while exporting an explicit bounded host projection, so optional host export cannot roll back session lifecycle settlement.
- bcacd54: Release durable BrowserSession and ComputerSession holders when a requested finite-lifetime Modal lease reaches its hard provider deadline, preserve honest operation outcomes, and expose interaction-blocked rotation telemetry.
- c356468: Add explicit host authority provenance for opaque MCP connection references so embedding hosts can resolve any binding identity, including UUID values, without native delegation, catalog, attachment reauthorization, or reconnect flows reinterpreting it. Preserve the legacy non-UUID host-binding lane during rolling upgrades, retain host provenance after successful credential resolution, make auth-needed events inert in legacy browsers, and gate newly marked refs behind a default-off two-phase fleet activation.
- 5ef0757: Allow zero-holder sandbox drains to use a separate extended provider snapshot timeout without lengthening ordinary periodic or turn-end snapshot finalization, while keeping current and historical Modal rotation admission inside provider-deadline headroom and making opted-in lifecycle waiters honor an in-flight child's persisted bounded capture deadline across rolling configuration changes.
- 9af1666: Keep backward session-history pagination advancing across oversized legacy events by applying the canonical bounded read projection instead of failing the page, and report when a forensic response is no longer byte-for-byte exact.
- Updated dependencies [2d0fad4]
- Updated dependencies [9fe5c5b]
- Updated dependencies [c356468]
- Updated dependencies [5ef0757]
- Updated dependencies [9af1666]
  - @opengeni/config@0.23.0
  - @opengeni/contracts@2.10.0
  - @opengeni/codemode@0.4.23

## 3.7.4

### Patch Changes

- 3589136: Release abandoned shared rig setup ownership as soon as the superseded turn proves its sandbox writers are physically quiesced.

## 3.7.3

### Patch Changes

- 463c709: Reset provider recovery backoff after a fenced successful model request so intermittent outages cannot exhaust a long-running turn's consecutive retry budget.

## 3.7.2

### Patch Changes

- 3a7fe2f: Reconcile retained-process terminal settlement races without leaving completed routes pinned.
- 4fb337b: Reconcile stale Codex quota cooldowns from authoritative live usage without clearing generic rate limits or concurrently newer refusals.
- 478f572: Harden organization API keys with explicit credential provenance, fail-closed revocation of ambiguous legacy account keys, bounded delegation, atomic organization-key and workspace limits, and safer rotation and one-time-secret UI behavior.
- 5b9acd1: Make session attention monotonic across rapid navigation and nested trees. Failed sessions now remain red only until the viewer or their parent agent acknowledges the latest event, while historical failure lifecycle state remains intact.
- Updated dependencies [59b286a]
- Updated dependencies [4fb337b]
- Updated dependencies [5b9acd1]
  - @opengeni/config@0.22.5
  - @opengeni/codex@0.2.20
  - @opengeni/contracts@2.9.2
  - @opengeni/codemode@0.4.22

## 3.7.1

### Patch Changes

- c3b43a5: Expose bounded durable recovery-backlog metrics from every control worker and alert when closed recoverable attempts remain without active ownership or a settled session projection.
- fab355b: Allocate canonical session event sequences from the locked narrow cursor while retaining the session-row compatibility projection.
- b471a90: Add an organization-owner Off, Review first, or Autonomous policy for agent-managed organization identity, including owner-only API and SDK controls, exact-attempt automatic activation, immutable receipts, and the organization settings control.
- e41285f: Overlap optional MCP preparation with first inference even when artifact tooling is enabled, keep optional eager integrations off the first-token critical path, reuse immutable large-history projections incrementally, and expose fenced event-append phase latency without changing durable ordering.
- 1f289a0: Attach machine input that arrived during a structured human-input wait to the resumed logical turn after its open tool-call result, while leaving post-resume arrivals for the next turn.
- c9ac869: Make the narrow session-event cursor authoritative for public sequence and unread projections, and isolate accepted raw exact-attempt batches from the wide session-row lock while preserving legacy SQL writer compatibility.
- fab355b: Add the rolling, parity-checked narrow session-event cursor foundation for a later sequencer cutover.
- fab355b: Lock and parity-check each narrow session event cursor in the canonical event and control writer prefix before turn and attempt locks.
- 4bacdd3: Add fixed-scope organization API keys, idempotent external tenant workspace provisioning, Personal-workspace exclusion, and the matching SDK and integration guidance.
- 72de39c: Retain low-cardinality workspace deletion phase, inventory, and total transaction metrics with exact workspace identifiers confined to structured logs.
- Updated dependencies [b471a90]
- Updated dependencies [96624a7]
- Updated dependencies [4bacdd3]
  - @opengeni/contracts@2.9.1
  - @opengeni/config@0.22.4
  - @opengeni/codemode@0.4.21

## 3.7.0

### Minor Changes

- 699477a: Restore autonomous agent Workspace Memory writes whenever workspace Memory is enabled. Agents can save and correct active facts, decisions, incidents, fixes, and outcomes independently of Learning mode while all existing Memory kinds remain retrieval-only through search. Autonomous learning may activate eligible concise Workspace instructions and focused Skills through their governed, auditable, undoable lifecycles; Review first keeps proposals inactive and Off creates no derived change.
- ddce5cc: Allow scheduled generated sessions and nested workers to target an exact Connected Machine, and fail closed without leaving an unstarted generated session behind when that route cannot be established.

### Patch Changes

- 3ef2488: Coordinate immutable Rig setup once per exact sandbox lease epoch and provider instance while keeping credentials, repositories, and files turn-private.
- Updated dependencies [699477a]
- Updated dependencies [ddce5cc]
- Updated dependencies [132c8d3]
- Updated dependencies [88b6b48]
  - @opengeni/contracts@2.9.0
  - @opengeni/codemode@0.4.20
  - @opengeni/config@0.22.3

## 3.6.3

### Patch Changes

- 551cead: Return durable retained-process exit or loss results to shell tools instead of rendering a retryable platform fault for an already-terminal command handle.
- 06fda28: Return bounded stable-key conflict outcomes for governed preference proposals instead of exposing persistence query details.

## 3.6.2

### Patch Changes

- 8dc432d: Settle interrupted native tool-search calls with the provider correlation identity retained in provider metadata.
- c705de3: Bound session-control settlement reads to the requested session subtrees, avoid redundant workspace refreshes for session-scoped control events, and add low-cardinality MCP lifecycle telemetry with failure, latency, and runtime reliability alerts and dashboards.
- Updated dependencies [595939e]
- Updated dependencies [80d7594]
  - @opengeni/config@0.22.2
  - @opengeni/contracts@2.8.0
  - @opengeni/codemode@0.4.19

## 3.6.1

### Patch Changes

- 17d253b: Complete personal GitHub identity support across managed, self-hosted, and local modes. Add a compact connect-and-repository UI, exact local-human authority persistence, Docker-safe credential brokering, durable child and goal propagation, and reviewed GitHub tools for pull-request reviews and merges without exposing provider tokens to agents.
- ff4af61: Promote a normal human Send to Steer-equivalent replacement when an active session is waiting for human action, cancelling the stale decision surface and placing the conversational message directly in chat.
- c116379: Improve organization and workspace administration with compact people management, workspace-admin member controls, personal integration and Codex subscription setup, clearer permission presets, consistent connector presentation, and organization-scoped resource navigation.
- c116379: Recover sessions containing legacy duplicate native tool-search pairs and prevent crash settlement from appending another pair when the provider correlation id is stored only in provider data.
- Updated dependencies [17d253b]
- Updated dependencies [c116379]
  - @opengeni/config@0.22.1
  - @opengeni/contracts@2.7.1
  - @opengeni/codemode@0.4.18

## 3.6.0

### Minor Changes

- 7238fa4: Add permission-scoped advisory work discovery, durable non-exclusive typed work claims, bounded related-work projections, independent rollout controls, observability, and SDK topology filters.

### Patch Changes

- Updated dependencies [7238fa4]
  - @opengeni/config@0.22.0
  - @opengeni/contracts@2.7.0
  - @opengeni/codemode@0.4.17

## 3.5.2

### Patch Changes

- 18afc44: Accept native tool-search results whose correlation id is carried only in provider metadata.
- bc88a28: Keep recoverable sessions durably wakeable until exact attempt quiescence, including when a retained process settles after the workflow's final reconciliation check.
- 3a004ff: Preserve optional structured human-input answers, replay terminal settlements idempotently, and retain Slack replies when expiry or cancellation wins a response race.

## 3.5.1

### Patch Changes

- da0c2d2: Prevent accepted-attempt workspace learning-policy snapshots from deadlocking with ordinary session lifecycle writers. The snapshot function now locks the workspace, session, turn, and attempt explicitly in the canonical order, then revalidates the complete live-attempt and interruption tuple in a fresh statement before deriving the immutable policy snapshot.
- 92f227f: Make session and workspace Pause/Resume desired-state mutations report authoritative changed, unchanged, and replayed outcomes. Represented no-ops no longer allocate control revisions, events, interruptions, or wakes, while newer descendant overrides and missing lifecycle repairs still produce real mutations. First-party MCP session control now returns the same versioned mutation receipt for agent-bound and sessionless callers.

## 3.5.0

### Minor Changes

- a7912ea: Add a one-click, owner-authorized OpenGeni Lens GitHub App installation flow for the PR Review Pack, backed by durable single-use OAuth authority, shared signed-webhook routing, and exact-repository least-privilege installation tokens. Keep bring-your-own GitHub App, GitLab, and Azure DevOps registration as the provider-neutral advanced path.
- 986f5fe: Add provider-neutral browser login session sets with bounded independently revocable slots, explicit actor switching, isolated add and re-authentication, scoped logout, non-enumerating cross-slot deep-link recovery, and rolling legacy/dual/broker compatibility.
- 6e12f3a: Add canonical-human organization recovery custody with exactly three accepted custodians, two-person approval, a fixed seven-day cooldown, promotion-only co-owner execution, durable notification evidence, and immutable workspace organization ownership.

### Patch Changes

- d7ab403: Bundle Workspace Insights usage and model projections into bounded analytical reads while preserving filter, visibility, and UTC boundary semantics.
- 9ef491b: Add the Agent Knowledge product surface, Personal workspace knowledge views and defaults, workspace learning-autonomy administration, explicit routing guidance between Memory, Skills, and Workspace instructions, authority-first organization Document search, exact replay-safe confirmed Memory materialization, and the narrower organization identity/mission boundary with richer facts retrieved from organization knowledge.
- 03d1c6e: Repair Workspace Insights analytical reads under production FORCE RLS while preserving ordinary fact visibility and write policies.
- Updated dependencies [a7912ea]
- Updated dependencies [9ef491b]
- Updated dependencies [986f5fe]
- Updated dependencies [6e12f3a]
  - @opengeni/config@0.21.0
  - @opengeni/contracts@2.6.0
  - @opengeni/codemode@0.4.16

## 3.4.0

### Minor Changes

- 76d6396: Generate concise topic-oriented session titles with a prompt-free fallback, automatic-title safety normalization, custom-role and old-image rolling-compatible least-privilege database posture, and UI projections that never use raw initial prompts as display names. Durable title fanout now requires a versioned subscriber-recovery capability: managed NATS and supported embedded brokers coalesce one Postgres catch-up after reconnect, while legacy buses without that contract fail readiness/worker startup before durable rows can be acknowledged.
- b5071cf: Require every Rig to layer setup and checks on the deployment-managed platform sandbox, reject new explicit Rig image overrides, keep provider-native image ids out of durable lease identity, and verify Browser, Terminal, and Computer services before publishing a Rig provider image.

### Patch Changes

- Updated dependencies [76d6396]
- Updated dependencies [b5071cf]
  - @opengeni/contracts@2.5.0
  - @opengeni/codemode@0.4.15
  - @opengeni/config@0.20.1

## 3.3.1

### Patch Changes

- 8fabf12: Document the one-way deployment boundary for named signup and invited-user
  setup. Migration 0348 requires every API, control worker, and turn worker to be
  stopped and drained before it runs, with the exact old/new application database
  roles supplied to the migration runner. Start only binaries built for schema
  ordinal 0348 or newer after it commits; never restart a pre-0348 image, and
  remain in maintenance to fix forward if the new runtime cannot start.
- 8fabf12: Repair realtime human-authority routing and metrics, personal Document reads
  under FORCE RLS, private-session visibility transition checks, and
  tenant-scoped session-tenancy fencing through migrations 0343-0345.

  Migration 0345 is a one-way maintenance cutover. Stop and drain every API,
  control worker, and turn worker before applying it, then start only binaries
  built for schema ordinal 0345 or newer. Never restart a pre-0345 image after
  the migration commits: its session-tenancy writes do not enter the required
  workspace fence and will fail closed.

## 3.3.0

### Minor Changes

- 47b88d3: Add explicit managed onboarding: ordinary verified signup completes an organization-name-only setup that creates only the owner membership and canonical Personal workspace, while unregistered invitees can use a digest-only one-time account setup link before signing in normally.
- c5e4684: Expose bounded organization-admin audit APIs and SDK methods for Default-collection backfill runs, operations, workspace receipts, and organization-wide Document authority reclassifications.
- dc10a36: Let an administrator see and set which OpenGeni workspace each Slack channel starts work in, from the Slack capability sheet. A channel with no choice is not broken: it asks the first person who uses it and remembers the answer, and the sheet says so.

### Patch Changes

- d47da57: Add bounded connection-authority convergence evidence with global residual totals, fixed operator actions, deterministic membership remediation, and fail-closed command completion.
- 977fa0f: Add durable provider-neutral invited-user email delivery with scope-bound retention fences, ambiguity-preserving retries, digest-only setup preview, and explicit delivery state across the API, SDK, and organization administration experience.
- ba29352: Automatically activate session tenancy for an exact newly inserted Personal-only organization after the canonical deployment boundary, with atomic setup, private-setting, and greenfield evidence receipts.
- 9d251cb: Add server-owned viewer, member, and administrator roles for shared organization workspaces, an explicit Personal/shared workspace kind, a privacy-safe administration projection, and audited idempotent grant and revocation commands.
- Updated dependencies [47b88d3]
- Updated dependencies [c5e4684]
- Updated dependencies [977fa0f]
- Updated dependencies [9d251cb]
- Updated dependencies [dc10a36]
- Updated dependencies [dc6cfff]
  - @opengeni/contracts@2.4.0
  - @opengeni/config@0.20.0
  - @opengeni/codemode@0.4.14

## 3.2.0

### Minor Changes

- f30555c: Add atomic same-workspace session forks with an explicit private or workspace destination. Private-to-workspace copies require a durable acknowledgement, workspace members may fork a shared source into fresh authority of their own, and private sources remain owner-only. Exact applied receipts remain recoverable by the same live workspace actor after mutable source authority changes, while changed requests conflict and fresh keys still require current source authority. Every fork receives fresh authority, provenance, root, and sandbox-group identity without inheriting live grants, credentials, Connections, turns, goals, MCP, resource attachments, processes, or pins. The managed web control now exposes the generic Fork dialog to authorized shared-session members and verifies the returned owned destination before navigation.
- cb116e0: A parent turn that consumes a child's lifecycle update now acknowledges that child for the turn's initiating human, exactly as if they had opened and viewed it. An orchestrator that fans out to dozens of children used to leave a blue unread dot on every one of them forever, even though the parent agent had already consumed and acted on each result; the claim transaction that turns a batch of `session_system_updates` into durable model input now also advances that human's `session_pins.acknowledged_sequence` on every child the batch reports on, to the child's `last_sequence` at that instant.

  The rule is keyed only on "a claimed turn consumed a child lifecycle update, and that turn has a frozen initiating human", so it covers all six child lifecycle kinds, behaves identically at every level of a nested chain, and has no orchestrator-, goal-, or depth-specific special case. Several notices for one child in a single batch produce one acknowledgment, and a turn whose frozen principal is purely a service acknowledges nothing.

  It never hides a problem. Read state is per viewer, so another member still sees the child unread; `unread` remains nothing but `sessions.last_sequence > acknowledged_sequence`, so a child that emits one more event goes unread again on its own; and the `failed` and `requires_action` indicators come from `sessions.status`, rank above unread in the rail, and are untouched. The fence is monotone, so a human who already read further is never regressed.

  The one thing it does change is that an explicit mark-unread is **not** sticky against it. Because the fence is monotone and OpenGeni stores no durable "leave this unread" intent, marking a child unread, letting that child do more work and report again, and then letting the parent consume that notice acknowledges it once more. That follows from the premise that consumption is the read signal, and the mark still holds until the parent consumes a newer notice, but it is a real behaviour change for anyone using mark-unread as a personal to-do flag on a child of an active orchestrator. Making that intent sticky needs a durable explicit-unread marker, which this change deliberately does not add.

  The acknowledgment does not touch `attention_version`. That revision exists only to order explicit human attention mutations against each other, and this writer publishes no event, NATS invalidation, or sequence advance a browser could learn from, so bumping it would silently stale the version the rail holds and turn the human's next mark-read click into a 409.

  The write is one `parent_session_id`-fenced `INSERT ... SELECT ... ORDER BY id ... ON CONFLICT` per claim, so a payload field can never decide whose personal state is mutated, and rows lock in the same UUID order the other session writers use. It honours the `session-personal-state` advisory fence with `pg_try_advisory_xact_lock_shared` and skips the acknowledgment rather than blocking, because workspace membership removal takes that fence exclusively and _before_ the workspace/session lock prefix a claim already holds; the probe is shared because the rail list holds the shared counterpart for its whole transaction, and an exclusive probe would drop acknowledgments precisely while the human is watching the rail. It takes no child turn/attempt lock; `session_pins`'s two foreign keys to `sessions` do take `FOR KEY SHARE` on the child's row, which is compatible with the `FOR NO KEY UPDATE` every canonical session writer takes.

  Because a row can now appear between another `session_pins` writer's read and its write, `setSessionPin`, `setSessionAttention`, and `setSessionArchive` upsert instead of insert; the acknowledgment row is pin-neutral and archive-neutral, so their conflict path is the same transition as their insert.

- b74e557: Add an explicit, replay-safe Document authority-reclassification lifecycle and
  a resumable organization Default-collection backfill. Reclassification requires
  the exact expected authority tuple, updates the Document and every chunk in one
  transaction, and retains immutable before/after receipts. The SDK and API expose
  the account-admin and actor-fenced operations, bounded cursor-paginated receipt
  history, and same-organization portable-personal behavior without making
  collections an authority boundary.
- b2cd0f0: Slack can notify the human when work they started stops making progress, **off by default and switched on per workspace**. The new `slackOrchestrationNotices` workspace setting carries one boolean per notice (`childRequiresAction`, `goalPaused`), two checkboxes sit beside the reaction shortcut in the Slack integration settings, and `resolveWorkspaceSlackOrchestrationNoticeSettings` fails closed: absent, malformed, or partially invalid settings resolve to both disabled, so only an explicit opt-in ever posts. An unsolicited Slack post is worse than a missed one, and the in-app rail and priority feed already surface this work.

  When a workspace opts in, a Slack-originated session's `child_requires_action` notice becomes one bounded pointer card ("A worker you started needs input", a single-line first-question or waiting-approval preview, and an **Open in OpenGeni** link to the child session), and a goal that pauses for `limits` or `max_auto_continuations` becomes one bounded line. Deferred child lifecycle notices, `user_pause` / `api` / `agent` / `no_progress` pauses, and `goal.resumed` stay silent, and so does a blocked-worker notice whose exact `(child, turn, generation)` boundary already carries a resolution or whose own row is `superseded` or `cancelled` - Slack delivery runs behind the session, and a card announcing a worker that is no longer blocked is worse than no card. Both notices draw on the same durable per-interaction slot budget as assistant progress, so an orchestration that fans out to many blocked children cannot turn one thread into a feed; a slot is claimed only when a card is actually going to be posted.

  A disabled notice takes the same "nothing to post for this event" path as an undeliverable one - no post, no ledger row, and the delivery cursor advances identically - and every pre-existing Slack card type is unaffected. Both reuse the durable per-event post-operation ledger, so reaper retries and replica claims cannot double-post. Rolling migration `0329_slack_orchestration_delivery_events.sql` adds `system.update.pending` and `goal.paused` to the Slack delivery claim's event types, and `@opengeni/db` exports the read-only `getSessionSystemUpdateById` and `childRequiresActionResolutionExists` used to resolve the exact typed notice and prove it is still current.

- 1789977: Ask once where an unconfigured Slack conversation should work, remember the answer, and re-queue the request that was interrupted by the question. One live card per person per conversation is enforced by a partial unique index, an aged-out card is settled by the writer rather than holding the slot, and the answer commits the choice, the remembered route and the re-queued request together.
- 64d8d2c: Schema and resolvers for per-channel and per-DM Slack workspace routing. **Nothing reads any of this yet**: no route table is consulted, no new column is written, and single-workspace Slack behaviour is byte-identical.

  Rolling migration `0335_slack_workspace_routing.sql` adds four FORCE-RLS tables (`slack_channel_routes`, `slack_user_dm_routes`, `slack_route_prompts`, `slack_route_prompt_options`), five additive nullable routing columns plus a `route_state` CHECK on `slack_interaction_inbox`, a frozen `routed_workspace_label` on `slack_interactions`, and one narrow content-free `SECURITY DEFINER` probe, `opengeni_private.resolve_slack_interaction_tenancy`. The Slack installation binding is deliberately untouched: `resolve_slack_installation`, the active-team unique index, and the second-binding trigger are unchanged, so one team still installs into exactly one home workspace and one credential. Routing is a separate additive fact within the same organization, fenced by a `target_account_id = account_id` CHECK.

  Routing splits **home** tenancy (the installation's credential, identity link, inbox, App Home, reaction-summon settings, task policy, and every new table) from **target** tenancy (the interaction, its action handles, its progress deliveries, the grant, the session, and its events). There is no backfill: `route_state IS NULL` means "legacy / never routed" and is exactly today's behaviour, so an old API or worker image ignores the new tables and columns entirely.

  `@opengeni/db` gains the pure resolver library behind it: `probeSlackInteractionTenancy` (ids only, so thread continuation can cross workspaces on the connection-global route key), `getSlackChannelRoute` / `getSlackUserDmRoute` and their `upsert*` / `delete*` siblings (the ask-once memory), `listSlackRoutableWorkspacesForSubject` (the single implementation of "workspaces this subject may start work in", which unions permission-filtered memberships with the subject's own personal workspace), and `resolveSlackTargetAuthority` - the only place a Slack request may reach a managed human's personal workspace. `getWorkspaceGrant` is **not** widened, so no API-key or delegated-bearer principal gains personal-workspace access; the pointer path accepts only the subject's own `personalWorkspaceId` from an active same-organization membership and then re-checks live authority.

- ad6acbe: Add the bounded organization connection-authority convergence seam to the `@opengeni/db` public surface: `classifyOrganizationConnectionAuthority` and `backfillOrganizationConnectionAuthority`, plus their `ConnectionAuthorityClassificationReport` / `ConnectionAuthorityBackfillReport` types, and the durable `runKey` receipt option on the organization membership backfill drain.

  Connection owner authority now binds through one owner-only seam that works under the production database posture. `organization_memberships` and `organization_user_resource_authorities` are `FORCE ROW LEVEL SECURITY` and OpenGeni runs its SECURITY DEFINER routines as a non-superuser owner without `BYPASSRLS`, so the previous inline `SELECT ... FOR SHARE` plus authority insert matched nothing: a new personal connection whose subject held a live organization membership silently degraded to the `legacy_user` lane, and the bounded `legacy_user` upgrader refused every deterministic candidate.

### Patch Changes

- 1b21135: Attach a selected user-owned Connected Machine atomically when creating a session from the managed web console, including recovery-stable `once` authority.
- 4d83368: Separate worker-claim queue state from prompts genuinely waiting behind work, keep rapid sends on stable chat and queue surfaces, and make local development fail fast when schema or aggregate runtime readiness is lost.
- fc80fdf: Split the Slack integration's single workspace identifier into two explicit scopes: home (the installation binding that owns the bot credential, the inbox row, the identity link, and the post ledgers) and target (the workspace that owns the interaction, its action handles, the grant, and the session). The two are equal today, so behaviour is unchanged. Thread continuation is now connection-scoped through the content-free tenancy probe, interaction creation adopts an existing thread's tenancy instead of failing an idempotency conflict, delivery builds its bot client from the installation route, and the first-task hint resolves its identity claim and its frozen answer in the scope that owns each.
- 4e48785: Fence both Slack routing tenancy probes on the organization the caller is acting for, and apply the canonical live-authority rule to the membership arm of `resolveSlackTargetAuthority`, so a suspended organization member holding a stale `workspace_memberships` row is no longer granted. The two arbitrary-subject Slack resolvers are renamed to the repository's `namedSubject*` convention and carry the oracle banner.
- e720d3e: Add a quiet "-> Workspace" line to Slack acknowledgements and deliveries when routing actually chose a workspace, and bump all five Slack post operation-id seeds to v2 in the same change so no interaction with a claimed-but-unposted delivery row can wedge on a digest that will never match again.
- 3e3b09a: Add per-channel and per-DM Slack workspace routing behind `OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED` (default off). Migration 0337 adds a private ids-only action-handle tenancy mapping so a routed button click can find its handle, and gives a shared-task origin its own tenancy pair for the frozen Slack task policy revision, which stays a home fact while the origin follows the routed task.
- Updated dependencies [1b21135]
- Updated dependencies [f30555c]
- Updated dependencies [47ccfab]
- Updated dependencies [b74e557]
- Updated dependencies [16387c3]
- Updated dependencies [b2cd0f0]
  - @opengeni/contracts@2.3.0
  - @opengeni/network@0.2.3
  - @opengeni/codemode@0.4.13
  - @opengeni/config@0.19.1
  - @opengeni/codex@0.2.19

## 3.1.0

### Minor Changes

- 4be2055: Child lifecycle notices for parent sessions (rolling migration 0325 widens the `session_system_updates` / `session_system_update_outbox` kind checks and adds the `session_system_updates_pending_kind_source_idx` partial index). Behind the process-global flag installed by `configureChildLifecycleNotices`, the child's own lifecycle transactions enqueue one dedupe-keyed outbox row for the parent: `applySessionTurnSettlement` on a `requires_action` freeze (`child_requires_action`, bounded human-input previews plus approval ids) and on terminal cancellation of pending requests; `acceptSessionHumanInputResponse`, `acceptSessionApprovalDecision`, expiry, and subtree Cancel (`child_requires_action_resolved`); a direct `pause` in `mutateSessionControlInTransaction` (`child_paused`, never for a recursive ancestor pause or when the parent's own attempt issued it); `armCodexCapacityWait` / `armXaiCapacityWait` (`child_waiting_capacity`); `recordSessionGoalProgressWithEvent` (`child_progress`). Every producer takes the child-lifecycle lock prefix (the parent session row joins the UUID-ordered session lock) and the shared `parentOutboxAuthorityTx` authority resolution; the failed/idle terminal producers now route through the same `enqueueChildLifecycleNoticeOutboxTx` writer. `addSessionSystemUpdateWithSourceMutation` honors the kind's wake class (`deferred` kinds insert the pending row and event only, never wake or auto-resume a goal), applies producer-side supersession (a resolution supersedes the pending `child_requires_action` of the same exact child turn generation; a newer `child_progress` supersedes the older pending one) with a `system.update.cancelled` fact, and no child notice wakes a parent whose goal is not active. `materializeGoalContinuation` and `peekSessionWork` let only `immediate`-class pending input win against a current `goal_wait` hold. Outbox rows of every child-lifecycle kind are typed through `SessionSystemUpdateOutboxDelivery`.
  Hardening for unknown kinds (any image from here on): `claimPendingSessionSystemUpdateOutbox` dead-letters one unparseable outbox row (`status = failed`, bounded `last_error`) and keeps delivering the rest, and the claim path marks a pending `session_system_updates` row whose kind or payload it cannot parse `failed` with a visible `system.update.cancelled{reason:"unrecognized_kind"}` instead of throwing into an endless re-peek. A delivered `child_terminal_result` supersedes that child's still-pending `child_progress` / `child_waiting_capacity` notices (`superseded_by_terminal`; a pending `child_requires_action` is left to its exact resolution because terminal delivery is unordered against notice creation); `failSessionWorkBeforeAttemptClaim` resolves the child's cancelled human-input rows for the parent; interaction-intervention expiry records `respondedByKind: system` and the REST routes record `api` for key principals. With the flag off, the only behavioural change is the widened lock set (the parent session row `FOR NO KEY UPDATE`) on requires_action settlement, goal progress, and capacity-wait arms.
- de3f376: Bound and shape the durable text an agent authors on a user's behalf. The budget
  follows the destination, on every agent surface that reaches it. A mandatory
  workspace rule is composed verbatim into the prompt of every session it applies
  to, so `remember`, `instruction_policy_propose`, and `task_note_promote_instruction_policy`
  are all capped at 600 characters; the preference destination is capped at 1,200
  across its three surfaces, because only its short descriptor is composed and the
  content is retrieved on demand. Task-note promotion is checked in the database
  layer, where the content is the note rather than a request field, and is rejected
  rather than truncated before any evidence, claim, or proposal row is written.
  `company_profile_propose`, the largest always-on surface, is capped for agents at
  400 characters per scalar, 200 per list entry, and 4,096 UTF-8 bytes total. The
  Knowledge lane keeps its 4,000-character retrieval-evidence ceiling, and every
  human editor limit is unchanged so nothing a person already typed becomes
  invalid. Tool descriptions now state the prompt cost and the authoring shape, and
  the `remember` confirmation card names the character count and destination so a
  human can judge the cost before saving. Existing stored revisions are never
  rewritten.
- e6ffdc7: Input-aware goal continuation pacing. `auto_continuations` now counts only consecutive synthesized continuations that consumed no external input: the claim that binds a goal turn to a batch carrying any other machine input resets it, and the latest-finished-turn reset orders by finish time so a human prompt queued after internal turns restarts the streak. A `max_auto_continuations` pause is pacing rather than intent and auto-resumes in the same commit as new external input from every producer (child results, scheduled occurrences, media results, Agent messages, Agent Steer, human/API Send/Steer) with `goal.resumed{actor:"system", reason:"external_input"}`; `user_pause`/`api`/`agent`/`limits` pauses are never auto-resumed. A late child result or child message can therefore revive a cap-paused parent. "Newest finished turn" is ordered by finish time in the hold, evaluator, backoff, and projection, so a human turn finishing after a `goal_wait` turn retires the hold; a hold whose deadline just passed is due now and skips the backoff once. `materializeGoalContinuation` accepts an optional `idleBackoff` policy and returns `deferred` (armed `goal_idle_backoff` workflow-wake row at the pacing deadline, ledger untouched) between consecutive no-input continuations; the goal projection reports `backoff_pending` with `nextAttemptAt`. No migration.
- 0b3b8df: Add an explicit organization-owner-confirmed agent path for company-profile and
  strategic-goal administration. The two-step MCP flow stages an immutable inactive
  full-profile proposal, binds activation to the initiating human's exact
  structured confirmation, revalidates current organization authority and profile
  CAS in PostgreSQL under the canonical workspace/session lock order, and remains
  independent of workspace learning mode. The manual `account:admin` route keeps
  its admission contract, and the earlier proposal-only `company_profile_propose`
  tool (`durable_learning` provenance) is retired in favor of this path.
- bbd19e0: Add an owner/admin organization setting that enables Only-me chats in shared
  workspaces for organizations holding the session-tenancy readiness receipt
  (`GET`/`PATCH /v1/organizations/:organizationId/private-session-settings`,
  `@opengeni/sdk/organization-private-session-settings`, and the organization
  settings page). Already activated organizations are backfilled enabled.
- 8e2361b: Slack first-task onboarding hint, frozen per interaction (rolling migration 0327 adds the nullable `slack_bot_user_links.first_task_hint_interaction_id` and `slack_interactions.first_task_hint`; no defaults, no backfill, and both tables keep their FORCE-RLS workspace-isolation posture). `resolveSlackInteractionFirstTaskHint` decides once whether an interaction's acknowledgement renders the hint and writes that boolean to the interaction row in the same transaction that claims the per-identity slot, so at most one interaction per Slack identity per installation is granted it. Because `slack_bot_post_operations` binds one operation id to a request digest over the message text, and acknowledgements are re-rendered on repair, later calls replay the frozen boolean and reproduce identical bytes; unlinking and relinking the Slack identity cannot flip an acknowledgement that already rendered. Failure raises rather than degrading to "no hint". `SlackInteraction` gains `firstTaskHint` and `SlackBotUserLink` gains `firstTaskHintInteractionId`; neither `getOrCreateSlackInteraction` nor `saveSlackBotUserLink` can write them, and claiming does not bump the link row's `updated_at`.
- 5d664d8: Surface why a goal is not pursuing and how long children have waited for a human. `Session.treeStats` gains optional `attentionSince` (earliest `requires_action` entry among the counted attention descendants), `Session` gains optional `requiresActionSince` on list and lineage reads, and the goal continuation projection gains optional `holdReason` for a `held_for_input` hold. `SessionChrome`'s goal pill spells out the pause reason ("Paused · cap" / "budget" / "by you" / "agent"), explains an idle-backoff check time and an agent `goal_wait` hold, and exports `sessionChromeGoalPillLabel` / `sessionChromeGoalPillExplanation`.

### Patch Changes

- 1fc235b: Omit a human/API prompt whose turn was never claimed (still queued, or deleted/edited/cancelled before any claim) from `sessions_list` `includeLastMessage` previews and the MCP `session_events` monitoring read, so orchestrators do not mistake work the model never received for processed conversation. `queuedPromptCount` still reports waiting work, the exact stored row appears at its original sequence once the turn is claimed, and REST event pages, SSE, and forensic reads are unchanged. Rolling migration 0322 adds the partial index `session_turns_unclaimed_prompt_trigger_idx` (`workspace_id, session_id, trigger_event_id` where `started_at IS NULL`) that serves the unclaimed-turn probe.
- a9cd9e7: Add the default-off first-party GitHub REST MCP bridge with separate workspace-App and personal-OAuth actors, exact accepted-repository authority, reviewed read/write tools, connector-policy defaults for writes, Codemode parity, bounded credential-free results, and no replay after ambiguous mutations.
- acd38d1: Retire Browser and Desktop resources when their source task leaves the Connected Machine that owns their controller, stop retrying the terminal placement conflict, and let Desktop create one replacement on the task's current placement.
- 45bffc3: Return empty personal-resource authority pages before session-tenancy activation while keeping mutations and runtime use activation-gated. Allow managed humans to read their personal Rig catalog without granting Rig administration.
- Updated dependencies [4be2055]
- Updated dependencies [4be2055]
- Updated dependencies [de3f376]
- Updated dependencies [a9cd9e7]
- Updated dependencies [e6ffdc7]
- Updated dependencies [e6ffdc7]
- Updated dependencies [0b3b8df]
- Updated dependencies [bbd19e0]
- Updated dependencies [e91d89e]
- Updated dependencies [5d664d8]
  - @opengeni/config@0.19.0
  - @opengeni/contracts@2.2.0
  - @opengeni/codemode@0.4.12

## 3.0.1

### Patch Changes

- b2dd2f7: Bound the remaining request-scoped workspace control-row mutations and make the lock budget a first-class setting: `updateWorkspaceSettings`, `deleteSessionTreeIfQuiescent`, queue move/edit/delete, composer draft save, and the MCP agent message accept an optional `controlLockTimeoutMs` that API routes and core commands pass (lifecycle callers keep the unbounded wait), so a busy workspace yields the same typed retryable 503 `WORKSPACE_CONTROL_BUSY`. `OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS` is now parsed and validated once at boot by `@opengeni/config` (`workspaceControlLockTimeoutMs`, positive integer ms, default 20000), installed into `@opengeni/db` by `createApp` through `configureWorkspaceControlRequestLockTimeoutMs`, and rendered by the deployment runtime-env generator as an optional passthrough.
- ab81e47: Allow the managed staging Slack app and bot to use the visibly distinct `OpenGeni Staging` identity. The manifest, runtime configuration, installation verification, durable binding contract, SDK, web projection, and deployment artifacts now preserve one closed environment-qualified display-name setting while production continues to default to `OpenGeni`.
- Updated dependencies [b2dd2f7]
- Updated dependencies [ab81e47]
  - @opengeni/config@0.18.1
  - @opengeni/contracts@2.1.1
  - @opengeni/codemode@0.4.11

## 3.0.0

### Major Changes

- 9530e19: Let a managed human use the session surface inside their own personal workspace, without widening the owner-only exception to anyone else.

  A managed human's personal workspace deliberately has no `workspace_memberships` row (migration 0219 raises on one) — their access is the `organization_memberships.personal_workspace_id` pointer. Three session seams fenced on a bare membership probe and therefore denied the one human who always belongs: `GET /v1/workspaces/:id/sessions` returned **403** so the workspace looked empty, `PUT …/sessions/:id/pin` returned **403**, and `PUT …/new-session-draft` returned **403**.

  `subjectHasLiveWorkspaceAuthorityInScope` (`packages/db/src/workspace-authority.ts`) is now the single implementation of the corrected rule. It refuses to set `opengeni.subject_id`, which makes the arbitrary-subject oracle shape unrepresentable at these seams and keeps the authority read inside the caller's transaction and advisory fence.

  **The authorization is not that resolver.** Neither it nor the exported `namedSubjectHasLiveWorkspaceAuthority` establishes who the caller is — both answer "does subject X hold authority here". The one thing that authorizes the exception is `AccessGrantAuthorization.canonicalManagedHumanSession`, stamped only inside the branch of `resolveAccessContext` that verified a Better Auth cookie. Inspecting the grant would not do: a delegated bearer chooses its own `principalKind`, `metadata.delegated`, `serviceInitiator`, and `subjectId`. Bearer/delegated principals, API keys, service initiators, same-organization co-members, organization admins and owners, and account administrators all fail closed, as does any authentication path added later.

  The public helper is renamed `subjectHasLiveWorkspaceAuthority` → `namedSubjectHasLiveWorkspaceAuthority`, and it now restores `opengeni.subject_id` after probing (`withRlsContext` restores account/workspace but not subject, so the probed subject leaked out of the savepoint). This changeset declares the required `@opengeni/db` **major** at the first PR that lands the breaking rename; the companion connection-authority change retains its own `@opengeni/core` major for its separate public break.

- 6909443: Activate the database prerequisite for session visibility changes and independent private forks through a drained, forward-only per-organization receipt. The session-tenancy adapter now rejects non-quiescent mutations with a typed conflict, limits the first fork contract to same-workspace private destinations, and returns the exact durable event identity.

### Minor Changes

- 3e1ad07: Add turn-atomic personal Variable Set and Rig attachments for create, Send, and
  Steer, including logical-turn once receipts, recovery-safe snapshots, warning
  acknowledgement, and SDK contracts.
- dc8c73f: Add professional organization administration with canonical rename and a
  Personal-safe shared-workspace access inventory, explicit Organization /
  Workspace / Only-me scope at Rig and Variable Set creation, and activation-gated
  atomic private visibility when creating sessions.
- fbc760e: Add the first-party `goal_wait` MCP tool and a durable goal continuation hold.
  An orchestrator whose active goal depends on child sessions or an external
  event records a bounded hold (reason plus mandatory deadline, at most 7 days)
  with a `goal.held` timeline fact instead of busy-polling. The continuation
  materializer returns `held` while the declaring turn is still the latest
  finished turn and the deadline is ahead: it never consumes the goal wake
  revision and re-arms a delayed workflow wake at the deadline on every idle
  evaluation. Pending machine input wins with `queue`, and any newer finished
  turn, a passed deadline, or a human/API/agent goal mutation clears the hold.
  The goal projection reports a current hold as `blocked` / `held_for_input`
  with `nextAttemptAt` at the deadline (rolling migration 0317).
- f7497fd: Add a disabled-by-default, user-owned personal GitHub OAuth lifecycle with
  separate deployment credentials, signed PKCE state, encrypted token custody,
  verified GitHub identity, typed SDK routes, reconnect fencing, and idempotent
  disconnect.
- ff011e6: Add bounded owner-only personal GitHub repository discovery, immutable selected-repository
  authority storage, full-replacement and verification APIs, typed SDK methods, and exact
  accepted-turn/scheduled-task authority snapshots for explicitly bound repository resources.
  The dedicated `connectionType: "github_personal"` resource discriminator preserves existing
  host-opaque Git credential bindings without reclassifying them as personal OAuth authority.
  Runtime Git and GitHub API execution remain unavailable until their separately audited broker
  and provider-consumer phases land.
- 48b9f09: Allow organization administrators to invite an email before registration, bind
  the invitation only after exact Better Auth email verification, and apply its
  initial shared-workspace access when the invited user joins without creating a
  redundant fallback organization.

### Patch Changes

- e57ce11: Replace full session-id snapshots with bounded activity-fenced keyset pagination so workspaces with more than 5,000 sessions remain listable.
- 3825727: Normalize legacy or malformed workspace-membership permissions before member listing and authorization, without restoring any obsolete authority.
- 1cd0eb0: Omit Responses output-only item `status` when persisting conversation history, and omit opaque `encrypted_content` from the portable compaction temporary copy, so SuperGrok-origin portable sessions can continue and compact on Codex. Keep the Codex wire strip as defense for already-stored rows and mid-turn SDK items. Durable history is not rewritten on a model switch.
- ebb3669: Add the agent-facing `company_profile_propose` first-party MCP tool over a new `proposeCompanyProfile` seam: an exact agent attempt records one inactive organization company-profile proposal (durable-learning provenance, `agent-attempt:<attemptId>` source) that an organization account admin reviews and activates from Company Brain → Company profile & goals, which now lists pending proposals with their content.
- 492fb71: Allow foreground session readers to acknowledge an exact rendered event sequence so later unseen events remain unread.
- 66593eb: Reconcile and verify the session-list visibility predicate grant when a fresh
  deployment runs migrations before creating its restricted application role,
  and keep app-supplied composer controls shrinkable within a single footer row.
- cc2fa1b: Keep a live sandbox turn holder alive through a provider-deadline rotation: the resume-side holder-liveness loop releases only when the holder itself is gone or its attempt is superseded (`heartbeatLeaseHolderStatus` separates holder liveness from lease extension), the turn-side rotation checkpoint reinstates its exact lost holder at the same epoch/instance before the warm capture, mutation admission under a requested rotation reports `rotation_in_progress` instead of `lease_fenced` and starts that checkpoint, `write_stdin` to a retained PTY renders admission faults as the tool result instead of failing the turn, and `sandbox.box.terminated` carries the drain reason.
- e9ff652: Fix human-confirmed `remember_confirm` activation after the human-input resume
  (migration 0316): the human answer is bound to the same logical turn and exact
  proposal rather than one execution generation, so the answered request row and
  the live attempt may both carry a later generation of that turn than the
  decision receipt, for both governed-learning activation and knowledge-claim
  confirmation.
- fe54954: Add an authorized, quiescence-fenced API and SDK operation for permanently deleting a root session tree.
- ba0be3d: Add activation-gated owner management for personal-resource session and standing grants, with kind-derived actions and permissions, exact session authority epochs, route-workspace-fenced revocation, RFC3339 lifecycle timestamps, bounded keyset pages, complete credential-free delegation receipts, FORCE-RLS-safe expiry and invalid-action settlement, and SDK methods that intentionally exclude standalone `once` and custom expiry.
- d8ba09d: Make private children inherit their parent's visibility through an exact live-attempt capability, expose effective tool policy in session monitoring, keep late child results from restarting settled parents, and preserve private-owner authority on internal-update turns.
- 72736ef: Take the canonical turn/attempt lock prefix before retaining a screenshot, retry that idempotent prepare on deadlock, and keep leftover persistence failures from failing the tool.
- c7cafb1: Activate owner-only session visibility changes and same-workspace private forks
  through the public API and SDK after per-organization tenancy activation.

  Expose activation-gated session tenancy metadata, typed quiescence and
  idempotency conflicts, exact durable event fanout, and explicit retry fences.

- c83c590: Decide turn-startup SLO milestone receipts (queue, provider_dispatch, first_byte) through a per-turn ledger, `session_turn_startup_milestones` (migration 0318), instead of re-reading the turn's `session_events` rows on every inserted model-request event. Each append or settlement claims its checkpoints with one primary-key `insert ... on conflict do nothing returning`, so the cost is O(1) per model request and no longer grows with the turn inside the transaction that holds the workspace inference-control row; recovery and replay remain no-ops, the terminal failed first-byte outcome is fenced on ledger state, and a turn already in flight before the ledger is sealed once so it never re-observes a checkpoint.
- 3b6b30e: Make the workspace control prefix fair and bounded: `lockWorkspaceInferenceControl` takes a FIFO transaction advisory lock before the row lock so Pause/Resume cannot be starved by continuous shared claim/settlement/append traffic, Send/Steer/queued Steer/realtime sync hold the prefix shared while the target branch is active and escalate through a savepoint only for a paused branch, and request-scoped API mutations fail with a typed retryable `WorkspaceControlBusyError` (HTTP 503) instead of parking a pooled connection and snapshot when the prefix stays busy.
- Updated dependencies [3e1ad07]
- Updated dependencies [438e476]
- Updated dependencies [1cd0eb0]
- Updated dependencies [ebb3669]
- Updated dependencies [dc8c73f]
- Updated dependencies [3999dd5]
- Updated dependencies [9b4d5d5]
- Updated dependencies [492fb71]
- Updated dependencies [fbc760e]
- Updated dependencies [650d6f9]
- Updated dependencies [650d6f9]
- Updated dependencies [fe54954]
- Updated dependencies [f7497fd]
- Updated dependencies [ff011e6]
- Updated dependencies [ba0be3d]
- Updated dependencies [5b509be]
- Updated dependencies [c7cafb1]
- Updated dependencies [5a651c8]
- Updated dependencies [29a44c2]
- Updated dependencies [48b9f09]
  - @opengeni/contracts@2.1.0
  - @opengeni/config@0.18.0
  - @opengeni/codex@0.2.18
  - @opengeni/codemode@0.4.10

## 2.1.0

### Minor Changes

- 2a70d94: Add the read-only organization tenancy parity checker (organization-tenancy phase E). Migration `0298_organization_tenancy_parity.sql` adds a strictly read-only `check_organization_tenancy_parity(uuid, integer, integer)` SECURITY DEFINER seam behind its own transaction-scoped, migration-owner-only capability (the 0254/0285 pattern; deliberately separate from 0285's capability so the inventory seam gains no visibility it was not reviewed for). `@opengeni/db` exports `checkOrganizationTenancyParity`, the pure `composeTenancyParityReport`, and the `TENANCY_PARITY_GATES` / `TENANCY_PARITY_LANES` / `TENANCY_PARITY_UNVERIFIABLE` catalogs; `bun run db:check-tenancy-parity --organization-id <uuid>` emits the machine-readable report and exits non-zero when a gate fails.

  Fifteen invariant gates cover organization/membership/workspace consistency, one membership-row-free personal workspace per active membership, stable authority uniqueness, provider-account collision propagation, session ownership provenance, zero partial delegations, and the shadow legacy-vs-proposed scope comparison. The seam never writes, repairs, or widens anything, and no reported mismatch is resolved toward user authority. Compatibility lanes are reported separately from invariants, and properties with no honest measurement (the shape-constrained variable-set/rig/machine "unclassified" counters, default session visibility, and total session ownerlessness) are reported as explicitly unverifiable rather than as counters that could never drain to zero.

  Every lane must have a reachable zero, or the cutover gate is structurally unreachable rather than merely unmet. The workspace-writer lanes are therefore bounded observation lanes (`workspaceWriterAdmissionsLegacyUnattributedInWindow`, `workspaceWriterProcessesLegacyUnattributedInWindow`) rather than drainable all-time counts: `sandbox_workspace_mutation_admissions` and `sandbox_retained_processes` are settled by `UPDATE` and never deleted, and 0277's one-shot attribution backfill only reached rows whose actor was a turn, so every pre-0277 `direct:` / `process:` admission keeps the `legacy_unattributed` sentinel permanently. `connectionsLegacyUser` is honestly labelled as drainable only _after_ the organization-membership backfill lands, because 0256 still actively mints `legacy_user` for new connections whose subject has no active membership. The checker requires a writable primary; a read replica fails with `25006`.

- 18474f1: Add the organization-tenancy phase D session ownership classification and backfill seam (migration 0297, rolling), plus `bun run db:backfill-session-ownership`.

  The slice was scoped on a false premise. Sessions are not 100% owner-NULL: migration 0225's `guard_session_authority_write` trigger already derives session ownership on every INSERT, and `session_visibility_isolation` is live. 0285's `sessions.ownerless` count is the residue of that trigger's two INSERT-only branches, not a migration backlog - and part of it grows with every API-key or scheduled session.

  Exactly two populations are deterministically repairable, and the backfill repairs only those: a session whose workspace is exactly one active membership's `personal_workspace_id` (a 1:1 anchor) and whose creator subject is that same membership - slice B deliberately provisions a personal workspace without a `workspace_memberships` row, so 0225's second branch cannot reach it - and the parent-inheritance closure that 0225's own first branch would have produced. Everything else is recorded unresolved with a fixed ledger reason code and never guessed: `service`-created sessions, non-`user:` subjects (`api_key:`/`configured:`) that 0219 and 0263 can never provision an organization anchor for, creators without a live membership, a personal-workspace anchor that disagrees with the creator, and - the largest refusal - an active human's session in an ordinary shared workspace, because replaying 0225's second branch retroactively would evaluate today's workspace grants against a historical session.

  The backfill is dry-run by default, bounded by `--limit`, resumable through `FOR UPDATE ... SKIP LOCKED`, and idempotent over session rows. Its candidate predicate carries the classifier's `created_by_subject_id LIKE 'user:%'` fence in its own SQL on both the dry-run count and the `--apply` claim, so the write path can never attribute a subject the classifier calls permanently unrepairable; the invariant is enforced here by construction rather than borrowed from 0219/0263. A `--run-key` ledger is deliberately not re-runnable: each batch opens its own receipt and the ledger refuses to re-open a settled one, so repeat with a new key. Ledger recording is one set-based statement rather than a row-at-a-time loop. It writes only the owner pair behind 0225's own visibility-write capability: no `visibility`, `authority_epoch`, or `updated_at` change, no session event, and no read widened - every candidate is `workspace_shared`, which `session_visibility_isolation` short-circuits on. Receipt recording is `to_regprocedure`-guarded against the tenancy backfill ledger and reports `ledgerAvailable` plainly.

  Both routines are `SECURITY DEFINER` capability-claiming seams rather than migration SQL for a structural reason: `sessions` is FORCE RLS, the documented deployment posture is a non-superuser migration principal without `BYPASSRLS`, and a plain migration-time `UPDATE sessions` therefore matches zero rows and reports success on such a deployment. The suite proves a non-zero attribution under a synthetic `NOSUPERUSER NOBYPASSRLS` owner.

- 093c17f: Add the tenancy backfill receipt and unresolved-row ledger (migration 0300, rolling). Phase D of the organization-tenancy program requires backfill to record receipts and unresolved rows without widening access, so both tables are FORCE RLS with no direct `opengeni_app` DML and are writable only through the `tenancy_backfill_ledger` lifecycle seam (`open_tenancy_backfill_receipt`, `record_tenancy_backfill_unresolved`, `complete_tenancy_backfill_receipt`). Every seam is tenant-fenced on the caller's exact `opengeni.account_id`, so one organization cannot open, append to, or settle another organization's receipt. Receipts are idempotent per organization/resource-family/run key, concurrently as well as serially; unresolved evidence is append-only and its count is owned by the append path rather than supplied at completion, so a sweep cannot understate its own outstanding obligations. The unresolved-row shape deliberately carries only a resource id and a fixed reason code - it records a refusal to infer authority and has no column able to express one.

### Patch Changes

- 3e60b2a: Repair the migration-time backfills that silently matched zero rows under a non-superuser table owner, and stop the class from recurring.

  `FORCE ROW LEVEL SECURITY` binds the table _owner_, not merely ordinary roles, and OpenGeni migrates as a non-superuser owner without `BYPASSRLS`. No tenant GUC is set during a migration, so a bare `UPDATE`/`DELETE`/`INSERT ... SELECT`/`DO $$` backfill over a workspace-scoped table matched **zero rows and reported success**. The hazard was invisible in CI because the test harness migrates as a superuser.

  Rolling migration `0296_force_rls_backfill_noop_repair.sql` repairs the three statements whose no-op neither aborted its own migration nor is recomputed at runtime: `connections.origin_workspace_id` (0256), `enrollments.origin_workspace_id` (0262), and the self-organization `organization_memberships.role = 'owner'` (0263). The first denied every workspace-owned connection at use time with `connection_identity_changed`; the third locked every pre-0263 organization out of its own membership administration. The repair is idempotent, is a no-op on a superuser-migrated database, and never infers authority from `created_by`, connection attribution, a default workspace, a resource name, or current access.

  New `bun run check:migration-rls-backfills` CI guard fails any future migration that backfills, or guards with `RAISE EXCEPTION` over, a FORCE-RLS table without opening the owner-only `NO FORCE` window. New `acquireOwnerMigratedTestDatabase` test helper drives `migrate()` through a `NOSUPERUSER NOBYPASSRLS` owner so this boundary is exercised for real. Full classification of every affected migration in `docs/force-rls-migration-backfills.md`.

- b230459: Replay an organization membership `accept`/`suspend`/`offboard` transaction a bounded number of times after a PostgreSQL deadlock abort. Replay is exact rather than approximate: the whole lifecycle command runs in one transaction keyed by its caller-supplied operation id plus its CAS revisions, and a deadlock abort rolls back every durable effect, so re-running the identical command either applies it once or observes the newer authoritative state. `updateOrganizationMember()` and `acceptOrganizationInvitation()` are wrapped because they are exactly the lifecycle commands that acquire workspace rows and can therefore be inside a cycle at all. `40001` is still surfaced unchanged as the authoritative stale-revision conflict.

  This is a caller-side safety net, not a lock-order fix: migration `0299_organization_membership_lock_order.sql` removes the organization/workspace lock-order inversion in SQL, and its parallel-load probe reads `pg_stat_database.deadlocks` directly so this replay cannot mask a regression. The `0263` lifecycle test correspondingly no longer assumes a particular deadlock victim - if the concurrent visibility transition is the one aborted it is replayed once, after which the committed offboard makes its `42501` denial deterministic.

- 8fa9820: Add the Phase D organization-membership and personal-workspace backfill driver (`bun run db:backfill-organization-memberships --organization-id <uuid> [--dry-run] [--limit N] [--max-passes N] [--after-subject-id <subject>]`). It provisions the membership anchor and deterministic personal workspace for humans who held workspace access before migration 0219 and never re-authenticated afterwards, through the exact existing `ensure_managed_human_personal_workspace` lifecycle seam - the Better Auth managed-access hook and the driver now share one `ensureManagedHumanPersonalWorkspace` implementation instead of two. Migration 0290 (rolling) adds only the read-only enumeration the driver was missing over the FORCE-RLS `organization_memberships` table; its new lifecycle marker is added to that table's policy `USING` clause only and can never authorize a write. Candidates are claimed with `FOR UPDATE SKIP LOCKED` in independent transactions, so the command is idempotent, resumable, and safe to run repeatedly and concurrently; `--dry-run` writes nothing. `--limit` bounds one pass and a pass is a keyset window over the `subject_id` ordering of both populations, so a single invocation chains passes on the returned cursor until the organization is drained (`--max-passes`, default 1000, and `--after-subject-id` resume a stopped walk). That is what makes repeated runs converge on an organization with more than `--limit` subjects, and it is why the enumeration seam takes an exclusive cursor (`list_organization_memberships_without_personal_workspace(uuid, integer, text)`). Both populations page under `COLLATE "C"` and the driver merges them with the matching code-point comparator, so the keyset order is the same on both sides of the seam: under the database's locale-aware default collation the two orders disagree on mixed-case and underscored subject ids, and a cursor taken from the merge order would silently skip subjects while still reporting the organization drained. Anything lacking complete deterministic evidence (login identity, self-owned organization identity, owner-role workspace membership) is reported unresolved with a bounded reason code and left untouched.
- 323db7f: Correct the organization-membership lifecycle lock order. The three lifecycle entry points - `prepare_organization_membership_protocol_settlements`, the wrapped `organization_membership_command_0263`, and the `organization_membership_command` wrapper - locked `managed_accounts FOR UPDATE` and only then took the canonical `workspaces FOR KEY SHARE` prefix. Every ordinary workspace writer is forced into the opposite order (it holds its `workspaces` row and reaches `managed_accounts` through the account foreign-key check of the `sessions`/`session_events`/`session_turns`/`session_goals`/`session_system_updates` row it inserts), so suspending or offboarding a member concurrently with any workspace write in the same organization deadlocked with `40P01`.

  Migration `0299_organization_membership_lock_order.sql` replaces the organization row lock with a transaction-scoped advisory lock keyed on the organization id - which preserves mutual exclusion between concurrent membership commands, is re-grantable across the nested entry points in one command transaction, and lives in a lock space no ordinary writer touches - and downgrades the row lock to `FOR KEY SHARE`, which still blocks DELETE and primary-key UPDATE of the organization while being compatible with every writer's FK check. CAS on `authorization_revision`, operation-receipt idempotency, and every fail-closed authorization check are unchanged; only lock strength and lock class moved. As a side effect the lifecycle no longer stalls every session/event/turn insert in the organization for the duration of a membership command.

- 4f9b2a9: Let a live agent read, message, and control peer workspace sessions instead of denying siblings and other roots.
- c19fad8: Visibility-isolate session list snapshots and pins. Migration 0225 installed `session_visibility_isolation` by enumerating relations with a foreign key to `sessions.id`, which reached 70 relations but could not reach `session_list_snapshots.ordinary_session_ids` — a bare `uuid[]` with no foreign key — so a cached list page kept naming a session for its whole TTL after that session transitioned to `user_private`. Migration 0301 strips the identity at the transition instead of filtering it on the read path: an `AFTER UPDATE OF visibility` trigger replaces the slot with the reserved all-zero UUID in every other subject's live snapshot, preserving snapshot cardinality and in-flight cursor offsets exactly, and writes those rows under migration 0225's existing owner-minted transaction-local write capability rather than assuming the migration owner is a superuser. The same migration fixes the opposite defect on `session_pins`, where the generic `FOR ALL` restrictive policy made a non-owner's stale pin both invisible and permanently undeletable by the member who created it: the USING side gains an explicit own-subject escape (PostgreSQL applies SELECT policies to a `DELETE` that reads a column, so a command-scoped exemption cannot work) while the WITH CHECK side keeps the strict predicate, so pinning an unseen session — and using INSERT as a session-existence oracle — stays denied. `transition_session_visibility` still has no product caller, so this is a correctness fix ahead of activation rather than a live exposure.
- Updated dependencies [81d2da0]
  - @opengeni/config@0.17.1

## 2.0.0

### Major Changes

- 2cb04e0: Retire Memory V1's standing prompt block and its agent writes. `memoryPromptMode` is now always `retrieval_only`: no pinned/recency working set is injected into any agent prompt, and the `legacy_standing` rollback opt-out can no longer be selected. The `memory_save` and `memory_correct` first-party tools are removed; durable agent writes go through `remember` (explicit user-directed) and task-note promotion (the agent's own findings), while `memory_search` remains so an agent can still read what a workspace knows.

  Nothing is rewritten or deleted: `knowledge_memories` rows, human REST/UI audit, search, correction, export, and the Memory Slack publication path are unchanged. A workspace that stored `legacy_standing` keeps the stored value in its passthrough settings bag, where it simply stops meaning anything, and already accepted turns keep the mode they recorded because those snapshots are immutable facts about what was composed. Migration 0295 changes no data; it reports whether anything was still relying on the mode rather than assuming it was unused.

### Minor Changes

- 1c78ed0: Separate new-session and established-session composer policy authority. Exact draft submission now atomically freezes queued-turn text, resources, model, reasoning, and latency, then rotates the server draft; queue Edit restores that exact snapshot and stale revisions surface as conflicts instead of silent rebases.
- 79ee99b: Preference descriptors now carry `activationAuthority` (`human_confirmed` | `automatic` | `null`) alongside `provenance.trust`. Trust stays the frozen creation-time fact - a revision an agent proposed reads `untrusted_proposal` forever, and both activation adapters still require that value - while the new field answers the separate question of whether a human explicitly confirmed the activation or policy activated it automatically, read from the governed-learning activation receipt at descriptor-build time. Descriptors built before this field existed parse as `null`, which keeps their immutable stored JSON and pinned descriptor hash valid.
- 368ee6c: Add the explicit resource-classification assertion seam for Variable Sets, Rigs, and Connected Machines (migration 0291, rolling; organization-tenancy phase D slices 4-5), plus `bun run db:verify-resource-classification`. These three families need no data rewrite and none is performed: `authority_scope` is `NOT NULL DEFAULT 'workspace'` on all three tables and every `*_authority_shape_check` was `VALIDATE`d at creation, so a legacy unmigrated row and a deliberately workspace-scoped row are byte-identical and there is no discriminator to classify on. `connections` (0256) is the one sibling family with a genuine one (`subject_id` plus an active organization membership); none of these tables has it, and phase D forbids substituting `created_by`, connection attribution, a default workspace, a resource name, or current access.

  The seam therefore asserts and receipts instead. It proves per row what no constraint enforces - that a row claiming user ownership points at an authority of the matching `resource_kind`/`resource_id`, that the authority and its owning organization membership are both live, and that the delegation still has an origin workspace - and records every failure as an unresolved obligation with a fixed reason code through the tenancy backfill ledger, never as a guess or a rewrite. Its report states `ledgerAvailable` plainly so a run that could not record its obligations is visible rather than silent.

  It is a `SECURITY DEFINER` capability-claiming seam rather than migration SQL for a structural reason: all three tables are FORCE RLS behind `workspace_rls_visible`, which is false while the workspace GUC is unset, and the documented deployment posture is a non-superuser migration principal without `BYPASSRLS`. A plain migration-time `UPDATE` on these tables matches zero rows and reports success on such a deployment, and only appears to work in a harness that migrates as superuser.

### Patch Changes

- 5dc88ef: Terminalize attached Chrome Browser/Computer sessions when the device connection generation changes, stop Reconnect from retrying the stale placement, and physically stop ScreenCaptureKit helpers so replayd cannot accumulate.
- f4afa19: Resume requires_action only from the open suffix plus paired history. Pause stores the sentinel instead of a leftover SDK RunState heap.
- d581eef: Allow a connected Chrome profile to move from a revoked machine enrollment to its replacement enrollment.
- a7df809: Harden the four `remember` instruction-policy edges.

  A moved policy head is now one typed, actionable `RememberError` (`baseline_stale`) on both the propose and confirm sides instead of an untyped error or a raw SQLSTATE 40001. The activation baseline no longer contributes to operation identity, so an ordinary turn-recovery replay of the same `operationId` stays idempotent across a head change; staleness is still enforced by the compare-and-set and by the activation function. A governed write that fails now archives the evidence task note it created instead of stranding it.

  A confirmation stranded by a head that moved after the human already answered now rebaselines onto the current head and completes, instead of hard-failing and forcing the human to answer again. Proposal uniqueness moves from one-per-source to one-per-source-per-baseline to admit that successor; the successor reuses the same knowledge proposal, so the human's confirmation stays bound to exactly the content they approved.

  Two consequences worth stating plainly:

  - Activating a rule replaces the whole active policy document, so confirming a second rule discards a first rule that a human also approved, without asking again. That is the existing whole-document-replacement design of this lane rather than something the rebaseline introduces - previously the stale baseline forced a round trip that would have clobbered anyway - and the audit trail stays exact, with the activation event naming the revision it replaced and `undo` restoring it. The rebaseline removes the round trip, which makes the behaviour easier to reach.
  - Excluding the baseline from operation identity changes both the proposal request fingerprint and the governed-write input hash (which derives the service actor subject id). A `remember` operation that durably wrote rows under the previous release and is replayed under this one computes a different identity and fails as an operation-reuse conflict. This is bounded to operations in flight across the deploy and self-heals with a fresh operation id; no dual-identity compatibility path was added.

- 8583779: Resume `requires_action` from paired history plus a bounded open suffix instead of materializing an oversized SDK RunState blob.
- a99ef33: Test-only: add cross-organization isolation and revocation evidence coverage for the organization-tenancy authority tables. `packages/db/test/organization-isolation-evidence.test.ts` proves, against a real PostgreSQL instance, that a member of one organization cannot read or mutate another organization's workspaces, sessions, or resources, and that revoking a membership takes effect immediately for the exact revoked grant. No shipped runtime behavior changes; this releases the new coverage with the package.
- 7bc1cd1: Correct the organization tenancy inventory seam (migration 0292, rolling): remove the untruthful `unclassified` counters for Variable Sets, Rigs, and Connected Machines. 0285 defined them as `authority_id IS NULL`, but the authority shape constraints _require_ a NULL `authority_id` for every organization- and workspace-scoped row, so the counter was structurally `total - userScoped` - every correctly classified row was reported as unmigrated and the number could never drain to zero as the documented backfill gate. No corrected predicate exists: `authority_scope` defaults to `'workspace'`, and `origin_workspace_id` means "predates the scoped lifecycle" for Variable Sets, is still produced NULL today by `createRig`'s non-scoped branch for Rigs, and has inverted polarity for Connected Machines (0262 backfilled it while the ordinary enroll path leaves it NULL). The population is unrepresentable in the current schema, so the key is removed rather than renamed - `byScope` already reports every authority distinction the schema can truthfully make. `schemaVersion` moves 1 -> 2; the seam stays read-only, integers-only, and exact-organization scoped, and `CREATE OR REPLACE` preserves its owner and `opengeni_app` EXECUTE grant. The documents gate is unchanged: its `authority_kind = 'personal' AND authority_id IS NULL` names a genuine invariant violation and remains truthful.
- 6d22ab5: Widen the task-note expiry ceiling from 30 to 90 days. Task notes are pure agent-to-agent coordination within one root session tree; resuming a paused root session/task tree after a longer gap previously lost all coordination notes silently. `TASK_NOTE_MAX_LIFETIME_DAYS` is now the single source of truth, referenced by the application-layer bound checks and `remember`'s evidence note instead of a hardcoded literal. Fully backward compatible: every existing row and every caller supplying 1-30 days keeps working unchanged.
- Updated dependencies [1c78ed0]
- Updated dependencies [f4afa19]
- Updated dependencies [8583779]
- Updated dependencies [79ee99b]
- Updated dependencies [2cb04e0]
- Updated dependencies [f4afa19]
- Updated dependencies [4541ab2]
- Updated dependencies [6d22ab5]
  - @opengeni/contracts@2.0.0
  - @opengeni/config@0.17.0
  - @opengeni/codemode@0.4.9

## 1.5.0

### Minor Changes

- a03b86f: Read-only organization tenancy inventory (migration 0285, rolling): `bun run db:inventory-tenancy --organization-id <uuid>` reports content-free counts of every legacy-attribution population the tenancy backfill/parity program gates on - ownerless sessions, unclassified variable sets/rigs/machines, connections per authority lane, membership anchors, unattributed workspace writers, and the linked-input document/Codex gates. Integers only; the SECURITY DEFINER seam validates the exact organization context and returns no identities, keys, or values.

## 1.4.0

### Minor Changes

- 6937eaf: The API-direct session-attach variable-set materialization lane (viewer attach and direct channel operations cold-creating a box) now records the accepted subject and a `variable_set.materialized` audit fact with the live session authority tuple (migration 0282, rolling; unchanged function signature). Attribution flows through the standard request-context GUCs; an old image that sets no subject records the explicit `service:session` sentinel. Denials keep their fail-closed raise-and-rollback semantics.
- b05130a: Hard-cut editable spreadsheets to authored-only canonical state, deterministic formula projections, and explicit current compatibility protocols. Preserve React compatibility with artifact-tool 0.1 and 0.2 while adding the 0.3 line.

### Patch Changes

- f804057: Remove the arbitrary per-turn Codemode call cap. One turn may journal as many Codemode calls as the work needs; recovery still reuses that same journal rather than minting a new budget.
- 418b531: Human-confirmed Knowledge approvals now record truthful review reasons: migration 0284 adds a reason-carrying overload of `governed_learning_apply_knowledge_review`, and both human-confirmed callers (`confirm_remember_knowledge_claim` and `activate_human_confirmed_learning_decision`) pass an explicit human-confirmed reason instead of the hard-coded "Automatic governed-learning activation." wording; the 9-arg signature keeps that legacy wording for the automatic path and remains the guard-resolved capability writer.
- Updated dependencies [0a6c577]
- Updated dependencies [f804057]
- Updated dependencies [b05130a]
- Updated dependencies [55e0417]
  - @opengeni/config@0.16.8
  - @opengeni/contracts@1.4.0
  - @opengeni/codemode@0.4.8

## 1.3.0

### Minor Changes

- 4c2d958: Google Drive publication freezes its exact output destination on the accepted delegation, so a later connection-settings change fails an already-accepted turn's publication closed instead of silently redirecting it. Every publication sits behind exactly one durable execute-once connector fence (the attempt connector-action wrapper for model callers, the tool's own registration for Codemode callers): a failure before the first mutating provider request settles not_executed with a retry-safe message, while a failure after it settles uncertain and surfaces the unknown outcome.
- 4c2d958: Scoped stream tokens (`ogs_`, 120 s TTL unchanged) now carry the authenticated viewer subject and the session's live authority epoch (migration 0281). The viewer lease holder records the same pair monotonically, the API re-verifies a human viewer's current workspace membership at every mint and degrades the stream to `transport:null` when membership is gone, and the selfhosted relay fences an attach whose authority claim is below the channel's recorded floor. Pre-0281 tokens keep working during the rolling window and enforce nothing new.

### Patch Changes

- 4c2d958: `remember` with `lane: instruction_policy` no longer fails after a governed-learning rule activation: the onboarding-proposal insert now copies the head's `activated_at` baseline in SQL instead of round-tripping it through a millisecond JS `Date`, so the draft trigger's exact comparison holds against the microsecond `clock_timestamp()` value the governed-learning controller writes.
- Updated dependencies [4c2d958]
- Updated dependencies [4c2d958]
  - @opengeni/contracts@1.3.0
  - @opengeni/codemode@0.4.7
  - @opengeni/config@0.16.7

## 1.2.0

### Minor Changes

- a65505d: Connection-use audit facts record the frozen causal initiator and session authority epoch/visibility/owner of every authorized or denied use, and variable-set materialization/secret-read audit events carry the causal human, attempt authority triple, and owner authority identity (migration 0280). Variable-set authority denials are now recorded as metadata-only audit facts from a fresh transaction while the fail-closed rejection is preserved.

## 1.1.0

### Minor Changes

- ca75ed9: Add the governed-learning activation controller with exact authority revalidation, destination-native workspace activation, immutable content-free receipts, and supersession-safe append-only undo.
- c297fc0: Add permission-first Company Brain guidance, Knowledge, proposal, and content-free accepted-turn context inspection surfaces.
- 02e21fa: Accept an optional curated `category` on registry capability catalog imports instead of forcing every imported connector into the registry-wide default.
- c297fc0: Route derived Company Brain proposals through the immutable workspace learning-policy snapshot before destination admission.
  Add exact rooted Task-note to proposed workspace Knowledge promotion with immutable value-free provenance and replay-safe MCP tools.
  Add atomic Task-note correction/revert with immutable old/new lineage, strict attempt/version fencing, and replay-safe first-party tooling.
- db758f3: Publish governed-learning activations and undos to the configured workspace Slack channel through the existing durable publication outbox. The dead durable-learning adapter (`publishDurableLearningOutcomeToSlack`) is replaced by `publishGovernedLearningEventToSlack`, which projects only content-free receipt facts, uses `governed-learning:<event>:<receiptId>` idempotency, and fails closed for Slack-derived evidence.
- e9aabaa: Wire the governed-learning evaluator and activation controller into the Company Brain learning-policy router. Ways-of-working proposals now record a content-free decision receipt after they commit; under `automatic`, an eligible preference decision is activated through the destination lifecycle (instruction policy keeps a human activation boundary). The route receipt gains `learning`, `learningFailure`, and activation receipt/destination facts; `activation.activated` is no longer always `false`.
- c297fc0: Add atomic rooted Task-note promotion into inactive instruction-policy and
  preference proposals while preserving exact source evidence, replay identity,
  and human-only activation.
- 22c0c21: Add the managed-human organization invitation, role, suspension, offboarding,
  and retention lifecycle with revision-fenced APIs and SDK methods. Self
  invitation history is exposed only through bounded keyset pages, and acceptance
  resolves one exact subject-bound invitation. Already-open session,
  workspace-control, live, and interaction streams periodically recheck current
  membership authority and close after revocation. A bounded operator command
  commits expired offboarded personal database deletion together with a closed,
  exact-key cleanup-obligation set before deleting external objects. Provider
  failures retry only unfinished obligations, retained references abort before
  external bytes are touched, File bucket identity stays frozen across retries,
  and immutable lifecycle evidence survives cleanup.
- 4eb7abd: `remember` with `lane: knowledge` now returns `confirmation_required` bound to the Knowledge claim, and `remember_confirm` (`claimId`) approves the claim through the Knowledge review lifecycle after the exact initiating human answered the bound canonical question with `save` (rolling migration 0274, `confirm_remember_knowledge_claim`, immutable `remember_knowledge_confirmation_receipts`). `remember_confirm` accepts either `proposalId` + `decisionReceiptId` (preference / instruction policy) or `claimId` (knowledge); the confirm receipt carries `claimId` and a `knowledge` activation summary with `undo: knowledge_review`.
- 89d4ab3: Add the explicit user-directed `remember` / `remember_confirm` agent tools. Content becomes exact task-note evidence promoted through the learning-policy router; a preference activates immediately under `automatic`, Knowledge stays proposal-only, and everything else returns a bound `request_human_input` payload whose `save` answer authorizes activation through the new rolling migration 0272 `activate_human_confirmed_learning_decision` capability (`authority_kind = human_confirmed`, human-input request id recorded on the receipt).
- 304462e: Workspace-membership removal is now one fenced SECURITY DEFINER teardown (migration 0278): the removed member's queued/live turns in that workspace are cancelled, live attempts interrupted, realtime modes ended, private-session authority epochs advanced, workflow wakes registered, and per-workspace personal rows plus the membership deleted in one transaction. Self-removal, last-admin removal, and non-administering actors fail closed in the database seam.
- 16cbd7b: Make `retrieval_only` the default Company Brain memory prompt mode. An absent or unrecognized workspace `memoryPromptMode` now removes the broad Memory V1 standing block, excludes legacy preference-kind rows from agent search, and omits the company profile from child prompts; an explicit `legacy_standing` remains the per-workspace rollback opt-out. Rolling migration 0271 applies the same fallback at turn acceptance so frozen snapshots and the contracts resolver agree.
- 30ba620: Make every accepted scheduled agent occurrence an immutable, credential-free
  execution snapshot bound to one run, session, scheduled update, logical turn,
  and attempt chain. Agent tasks accept explicit `connectionAuthorities`
  (omitted preserves, `[]` clears, an array replaces), execution-affecting edits
  require the same causal human, `once` grants are consumed exactly once per
  run, cold reusable sessions converge on one revision-bound materialization
  receipt, and task deletion becomes a one-way paused tombstone with durable
  connector cleanup. Create/update requests are byte-bounded at ingress while
  stored rows stay readable. Migration `0275` is a maintenance cutover.
- f72563d: Slack now has exactly two authorities: the personal hosted Slack MCP grant and the OpenGeni workspace bot. The workspace-owned hosted Slack MCP connection is removed: OAuth start, reconnect, the callback fence, and capability enablement reject an explicit non-personal ownership for `https://mcp.slack.com/mcp`, an omitted ownership on that resource defaults to personal, and `listEnabledMcpCapabilityServers` no longer runs a workspace-scoped Slack MCP installation enabled by an earlier release. The bot manifest and canonical bot allowlist gain the bot-token Real-time Search scopes `search:read.public`, `search:read.files`, and `search:read.users` as requested-but-not-required extras; apply them to the Slack app before deploying, since the install URL requests every requested scope. The bot search tool itself is a separate change.
- c297fc0: Add deterministic governed-learning evaluation over exact accepted policy and evidence authority, with immutable content-free decision receipts and no activation capability.
- ea52ff2: Workspace-owned connections no longer bypass the accepted connection-use authority: resolve_accepted_connection_use gains a workspace lane (migration 0279) that revalidates the exact live workspace-owned connection inside the canonical lifecycle fences and records the same idempotent audit facts as personal delegations, and the worker routes workspace-scope MCP credential resolution and per-provider-request authorization through it. Only a pre-snapshot ref with no connection id keeps the bounded unprivileged legacy resolution.
- cac85bc: Every persistable /workspace writer admission and retained process now freezes its exact authority tuple (causal initiator, initiating human, organization-membership grant identity with observed revision, and session tenancy epoch/visibility/owner). Direct and process actors are fenced like turns: a revoked or suspended grant, or an unattributed pre-0277 tenancy half, fails a new mutation closed before any workspace generation is consumed, and the running provider process is never terminated or re-owned.

### Patch Changes

- 91d5caf: Add a provider-neutral operational instruction contract for consistent agent collaboration, execution safety, file editing, and skill usage across every OpenGeni persona. Keep persistent system instructions prompt-cache stable, project goal continuations once as canonical user messages, let authoritative human input supersede a pending continuation, and remove the unreliable inferred-progress pause.
- c297fc0: Add the permission-filtered Company Brain read and deterministic OKF export
  surface, subject-scoped full guidance history, and the Company Brain discovery
  and export experience.
- 987742d: Reduce turn-start overhead without reducing admitted history, rig variables, or
  user-visible content. Active history loads in one admitted query, automatic
  compaction skips duplicate history work below threshold, unchanged Codex
  credential pointers avoid redundant session-activity writes, rig defaults
  load at bounded concurrency for admitted worker attempts, and the attempt-scoped
  MCP wrapper no longer reuses a broader process-global tool list.

  Improve large-session interaction by measuring rich-message disclosure without
  a second React commit, showing truthful pending queue actions immediately, and
  replacing the false zero-step placeholder with the session's real lifecycle.

- 6a8954f: The `remember` and `memory_search` tool descriptions now state where saved facts actually live: a confirmed `lane: knowledge` fact enters the human-reviewed Knowledge claim lifecycle (not workspace memory), and indexed workspace documents are searched with `knowledge_search`/`knowledge_get` on the separate Document Search (docs) MCP server rather than through workspace `memory_search`.
- 5cd7b46: `remember` with `lane: instruction_policy` now binds the draft to the target's current activation baseline (active head revision and CAS version, including a deactivated-to-null boundary) instead of assuming an empty workspace, so a user-directed rule can be proposed and confirmed in a workspace that already has an active policy.
- d168b8f: Allow exact scheduled service turns to materialize organization- and workspace-scoped Variable Sets while preserving causal-human and personal-grant checks for user-scoped sets.
- 6860c5f: Add organization, workspace, and owner-private scopes for Rigs and Connected Machines. Personal machine use and Rig materialization now revalidate exact-attempt grants, membership, workspace access, authority epochs, and generations before runtime access.
- c297fc0: Freeze Company Brain mode and bounded legacy instructions when a turn is
  accepted, then bind them to a content-free first-attempt selection receipt whose
  candidate and rendered-budget subsets make replacement recovery shrink-only.
- c297fc0: Complete governed goal rewrites with strict agent change metadata, immutable
  proposal rejection and CAS-fenced rollback, bounded revision pagination, and
  accepted-turn root constraints that child agents may inherit or narrow. The
  original raw-array goal-revision list remains unchanged; bounded pagination is
  available through a separately named API and SDK surface.
- Updated dependencies [1aa02d4]
- Updated dependencies [ca75ed9]
- Updated dependencies [c297fc0]
- Updated dependencies [91d5caf]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [e9aabaa]
- Updated dependencies [1f860f0]
- Updated dependencies [c297fc0]
- Updated dependencies [22c0c21]
- Updated dependencies [4eb7abd]
- Updated dependencies [89d4ab3]
- Updated dependencies [7454580]
- Updated dependencies [16cbd7b]
- Updated dependencies [30ba620]
- Updated dependencies [d168b8f]
- Updated dependencies [6860c5f]
- Updated dependencies [f72563d]
- Updated dependencies [c297fc0]
- Updated dependencies [6c45ceb]
- Updated dependencies [c297fc0]
  - @opengeni/config@0.16.6
  - @opengeni/contracts@1.2.0
  - @opengeni/codemode@0.4.6

## 1.0.2

### Patch Changes

- a551666: Fix local Gmail provider OAuth callbacks, Google scope equivalence, stable
  Discovery compilation, and installed API integration visibility in session
  tool selection.
- 90c0c3e: Persist bounded, content-free Company Brain prompt contribution estimates on authoritative model-call facts and expose their source breakdown and coverage in Workspace Insights.
- e0e0102: Unify browser, computer, identity, realtime, and Codemode behavior across managed sandboxes and connected machines.
- 4d1ed07: Preserve complete bounded lazy-search tool schemas across durable model history, expose Linux desktop application launch when the image supports it, suppress the managed Chrome sandbox warning, label Computer sessions as Desktops in the UI, and keep AnyDoc available in headed desktop sandboxes.
- ce3b370: Restore the MPL-2.0 license and notice for the curated HashiCorp Terraform Skills in the published runtime package, and forward-repair the persisted Terraform Stacks provenance URL.
- b2af2df: Bind Integration facet idempotency receipts to the subject that created them so another workspace administrator cannot replay a personal facet result.
- e9e1016: Allow agent `goal_set` to replace completed goals while continuing to protect
  active and paused goal intent.
- ffbbf4c: Add organization, workspace, and owner-private Variable Set scopes with independent metadata, plaintext-read, write, attachment, and runtime-use authority. Runtime secret materialization now revalidates the exact live attempt and personal grant immediately before ciphertext egress while audits remain value-free.
- 3843825: Prevent workspace administrators from rebinding another subject's personal API Integration instance.
- 1ab8023: Deduplicate scheduled alert deliveries onto one atomic responder session per scheduled task and canonical alert occurrence while preserving separate roots for distinct tasks and reopened occurrences.
- 886682d: Fail closed when a persisted Terraform Stacks Pack component resolves to an unrelated, inactive, cross-tenant, or digest-mismatched Plugin installation.
- 234a5e7: Replay exact completed Integration facet configure receipts before mutable instance, Connection, or provider validation while preserving request conflicts and exact-subject isolation.
- d2f172c: Add fail-closed, metadata-only capability, exact rig-version health, exact alert-selector data-source checks, and source/claim authority fencing for scheduled incident telemetry responders before expensive retrieval.
- 04b1a1f: Add exact-attempt, workspace-local governed Knowledge proposal/correction
  routing and inactive instruction-policy and preference proposal adapters while
  preserving human activation authority and immutable Knowledge provenance.
- c056063: Project exact Integration Facet ownership so shared or externally managed bindings are read-only and direct removal reports retained owners truthfully.
- Updated dependencies [79f57b5]
- Updated dependencies [90c0c3e]
- Updated dependencies [9c4e0b8]
- Updated dependencies [e0e0102]
- Updated dependencies [d7dfc01]
- Updated dependencies [ec00479]
- Updated dependencies [ffbbf4c]
- Updated dependencies [d34dd9a]
- Updated dependencies [79f57b5]
- Updated dependencies [eeb7cb6]
- Updated dependencies [c3f0598]
- Updated dependencies [d2f172c]
- Updated dependencies [04b1a1f]
- Updated dependencies [c056063]
  - @opengeni/codemode@0.4.5
  - @opengeni/contracts@1.1.0
  - @opengeni/config@0.16.5

## 1.0.1

### Patch Changes

- 448117d: Enforce fresh per-object Google Drive ACL authorization across Knowledge
  retrieval and every file-byte consumer, and project only reauthorized,
  principal-free provider citations.
- Updated dependencies [448117d]
  - @opengeni/contracts@1.0.1
  - @opengeni/codemode@0.4.4
  - @opengeni/config@0.16.4

## 1.0.0

### Major Changes

- 083387e: Replace the removed per-turn `turnInstructions` system-prefix contract with generic per-message `modelContext` content. This is a breaking release-train cutover: old mutating clients are rejected after migration 0240. Context now enters canonical user history without standard timeline rendering, preserves the persistent prompt-cache prefix, and works across initial, queued, steer, realtime delegation, and transcript handoff paths.

### Patch Changes

- 11913b7: Add separately consented Google Drive editable-artifact publishing with an explicit writable destination, connector-action approval policy, Google-native conversion, and retry-safe provider reconciliation.
- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/contracts@1.0.0
  - @opengeni/codemode@0.4.3
  - @opengeni/config@0.16.3

## 0.36.1

### Patch Changes

- 499c70c: Retry transient pre-inference attempt claims atomically, durably re-wake a
  logical turn when its activity failed before creating an attempt, and preserve
  the requested backoff deadline once older workflow-wake revisions are delivered.
  Still-open legacy workflow histories and every effectively active durable work
  shape whose prior wake was delivered now retain the same recovery obligation:
  queued/recovering turns, accepted approval responses, released capacity waits,
  manual compaction, and pending internal updates. Held, paused, live-attempt, and
  already-pending wake states remain untouched.
  Terminal failure retries also close the workflow without synthesizing an
  active-goal continuation.
- Updated dependencies [944be7f]
  - @opengeni/codemode@0.4.2
  - @opengeni/codex@0.2.17
  - @opengeni/config@0.16.2

## 0.36.0

### Minor Changes

- 478d7fe: Add explicit, bounded root-task-tree coordination note tools with exact-attempt authority, private-session visibility, expiry, immutable create/archive receipts, and safe retry semantics.
- 478d7fe: Persist exact accepted-turn goal authority, separate semantic goal revisions
  from execution progress, and add policy-controlled rewrite proposals with API,
  SDK, MCP, and runtime support.

### Patch Changes

- d86610d: Show elapsed UTC-hour buckets for the Insights Today range while retaining UTC-day buckets for longer ranges.
- 478d7fe: Add a reversible workspace memory prompt mode that removes the legacy standing memory block, keeps preference observations out of agent behavioral authority, contains company-profile context for child agents, and reports metadata-only model-context contribution telemetry.
- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/contracts@0.50.0
  - @opengeni/config@0.16.1
  - @opengeni/codemode@0.4.1

## 0.35.1

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/codemode@0.4.0
  - @opengeni/config@0.16.0
  - @opengeni/contracts@0.49.0

## 0.35.0

### Minor Changes

- 8beed26: Add workspace-governed Slack shared-conversation task policies with durable enforcement and public contracts, and enforce vertical-only agent session authority across core and persistence.
- 8beed26: Add managed-human organization membership discovery. Expose the exact active
  self-membership and personal-workspace identity returned by the existing
  narrow provisioning capability through a managed-session-only API route and
  typed SDK method, while denying delegated/API-key principals and terminal
  memberships.
- 8beed26: Activate server-authoritative session visibility and content forking. Add user-private session ownership, authority-epoch transitions, explicit cross-workspace fork operations, session-scoped RLS actor propagation, and API authorization that preserves workspace-shared access while enforcing private-session ownership.

### Patch Changes

- 8beed26: Import authorized images from Slack direct messages and existing task-thread replies.
- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
  - @opengeni/contracts@0.48.0
  - @opengeni/codemode@0.3.3
  - @opengeni/config@0.15.1

## 0.34.0

### Minor Changes

- 1e78f58: Replace provider presets and nullable integration identities with immutable Integration Definitions. Curated and workspace-authored integrations now share one definition-based contract, provenance model, OAuth callback, SDK route, runtime projection, and maintenance migration with no legacy API alias or fallback authority.
- 1e78f58: Make Facet definitions and bindings authoritative throughout the Integration domain. Public routes, SDK methods, Pack components, owner identities, physical tables, persisted manifests, and runtime projections now use one Facet vocabulary with a maintenance cutover and no compatibility aliases.
- 746bbbe: Add canonical human identities with multiple verified login bindings, revisioned and audited lifecycle operations, immediate session invalidation, fail-closed recovery and collision handling, and metadata-minimal managed identity API routes.
- 9849e25: Add strict identifier-free xAI provider-account authority snapshots and durable
  SuperGrok/xAI multi-account persistence with live user authority revalidation,
  encrypted credential boundaries, fair exact-turn leases, pool-scoped pins,
  quota/cooldown metadata, capacity waiters, immutable accepted-work snapshots,
  FORCE RLS, and explicit runtime privilege posture.
- 1e78f58: Make normalized Plugin, Version, Skill Facet, and component-owner records authoritative for curated and imported Skills. Add reviewed library install, list, update, preview, and uninstall contracts; preserve Pack and Plugin ownership independently; and retire every non-MCP row from the generic capability catalog and installation ledger through a collision-free maintenance migration.

### Patch Changes

- 1c4ac69: Preserve complete MCP tool results through the runtime, durable database settlement, and worker recovery path without changing model-visible output, including nested prefixed servers, compact approval snapshots, and bounded live-memory retention after durable capture.
- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
- Updated dependencies [746bbbe]
- Updated dependencies [9849e25]
- Updated dependencies [1e78f58]
  - @opengeni/config@0.15.0
  - @opengeni/contracts@0.47.0
  - @opengeni/codemode@0.3.2

## 0.33.0

### Minor Changes

- 3d74340: Add the inert personal Codex provider-account authority foundation and opaque
  accepted-work snapshot contract without activating user-scoped consumption.

### Patch Changes

- Updated dependencies [73d34d6]
- Updated dependencies [3d74340]
  - @opengeni/codex@0.2.16
  - @opengeni/contracts@0.46.0
  - @opengeni/config@0.14.1
  - @opengeni/codemode@0.3.1

## 0.32.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.
- d241d13: Add the managed-human organization-membership and personal-workspace lifecycle
  provisioning capability while preserving legacy workspace access behavior.
- 733c22f: Add the organization-tenancy foundation contracts and inert database scaffolding for organization memberships, user-owned resource authority and grants, personal retention, and generic session visibility, fork provenance, and authority epochs.

### Patch Changes

- d15d3e8: Repair the Slack reaction-task experience with initial-only session links, disabled link/media unfurls, workspace-service-principal delivery, conservative terminal-output coalescing, direct execution of safe specified requests, and bounded deterministic import of exact reacted-message PNG/JPEG/WebP attachments as reference-only workspace files. Preserve fail-closed provider-outcome reconciliation and keep generic model-facing posting unavailable without a trusted durable logical-delivery identity.
- 3f81608: Stage and validate the session-channel foreign key without retaining the column-addition lock across a populated sessions-table scan.
- 42a1242: Raise the serving envelope for active session history so tool-heavy orchestration turns remain compactable.
- Updated dependencies [d2def0c]
- Updated dependencies [5215c0e]
- Updated dependencies [d15d3e8]
- Updated dependencies [733c22f]
  - @opengeni/codemode@0.3.0
  - @opengeni/config@0.14.0
  - @opengeni/contracts@0.45.0

## 0.31.1

### Patch Changes

- 5c5ea4a: Add the universal capabilities platform with named API integration instances,
  provider-specific feature bindings, and local runtime adapters.
- Updated dependencies [b57d61f]
- Updated dependencies [5c5ea4a]
  - @opengeni/contracts@0.44.1
  - @opengeni/codemode@0.2.2
  - @opengeni/config@0.13.2

## 0.31.0

### Minor Changes

- aeb07f4: Add durable workspace decision publication to verified Slack bot channels with immutable configuration revisions, outbox attempts and receipts, bounded retries and terminal states, admin review/history UX, typed SDK methods, and a post-persistence governed-learning outcome adapter.

### Patch Changes

- 87e9ae6: Add durable Google Drive Changes cursors, Shared Drive-aware delta draining,
  bounded full reconciliation, cursor-invalid repair, and a default-off
  Workspace Events wake seam. Normalize My Drive's root alias before ancestry
  checks and preserve cumulative item, provider-request, and elapsed budgets
  across delta, continuation, and full-repair checkpoints. Carry bounded
  per-object revision floors across delta-to-full and checkpointed full scans so
  older or equal Drive revisions cannot regress accepted metadata/current-version
  state, fail closed on conflicting fallback identities, and keep the first
  observation in one scan generation as a durable monotonic floor. Fence item
  version/metadata writes plus checkpoint and terminal cursor settlement to the
  exact lease, initiating subject, scan, checkpoint generation, and accepted
  floor, so a lost full-page checkpoint cannot replay version 8 as version 7.
- 8b6803a: Make Modal sandbox recovery command-ready and accurately diagnosed, use workspace-only snapshots for new sessions, enforce checkpoint cadence, and publish cached rig images only after an independent cold boot.
- ff7203c: Add a read-only Atlassian Jira and Confluence connector with shared OAuth setup, selected-source live agent search and reads, and optional governed knowledge synchronization.
- Updated dependencies [87e9ae6]
- Updated dependencies [8b6803a]
- Updated dependencies [aeb07f4]
- Updated dependencies [ff7203c]
  - @opengeni/config@0.13.1
  - @opengeni/contracts@0.44.0
  - @opengeni/codemode@0.2.1

## 0.30.0

### Minor Changes

- b46f4de: Add a compact, cursor-paginated agent-topology read surface with root, direct-child, and search filters for lazy hierarchy browsers.
- 2f4ce5e: Add durable Seedance video generation with workspace model and funding policy,
  secure media references, retained video artifacts, sandbox materialization,
  OpenGeni-credit and workspace-gateway funding, and SDK/React playback surfaces.
- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.
- 31666e2: Add immutable workspace learning-policy revisions, lifecycle-only activation and rollback, accepted-attempt snapshots, and deterministic effective-mode resolution for `off`, `suggest`, and `automatic`.
- a858835: Add unambiguous Slack installation bindings and a token-free, subject-bound workspace access-request lifecycle for signed Slack identity links.

### Patch Changes

- 7954468: Recognize threaded Slack mentions delivered as message events, include bounded invocation context, and avoid duplicate final replies or repeated session links.
- bd5514e: Add explicitly enabled provider-neutral knowledge-source schedules with durable wake provenance, generation-fenced execution checkpoints and index obligations, fail-closed ACL activation seams, no-agent execution, layered pause state, shared schedule administration, and Google Drive source lifecycle integration.
- 90eea29: Make connected-machine removal show every dependent session and support an explicit canonical move-to-default-sandbox confirmation before revocation. Default moves prove managed sandbox readiness through the existing fleet route, active turns remain fail-closed, and typed swap rejections surface as visible errors instead of false success.
- 5fcad0a: Expose an agent-safe checkpointed listing of newly indexed documents with source and provenance metadata.
- Updated dependencies [b46f4de]
- Updated dependencies [2f4ce5e]
- Updated dependencies [d55a093]
- Updated dependencies [dcfe6eb]
- Updated dependencies [ad9123b]
- Updated dependencies [31666e2]
- Updated dependencies [bd5514e]
- Updated dependencies [90eea29]
- Updated dependencies [a858835]
- Updated dependencies [5fcad0a]
  - @opengeni/contracts@0.43.0
  - @opengeni/config@0.13.0
  - @opengeni/network@0.2.2
  - @opengeni/codemode@0.2.0
  - @opengeni/codex@0.2.15

## 0.29.1

### Patch Changes

- 2cd6dce: Build and reuse version-bound immutable provider images after clean rig verification, with content-hash invalidation and runtime-setup fallback for missing or unsupported providers.
- Updated dependencies [2cd6dce]
  - @opengeni/contracts@0.42.1
  - @opengeni/config@0.12.10

## 0.29.0

### Minor Changes

- d1189ba: Add the OpenGeni-owned document, spreadsheet, and presentation authoring engine,
  its durable API/domain/live-sync surfaces, first-party React workbench, and
  editable-artifact client SDK. Publish independently lazy, identity-pinned browser
  WASM runtimes for each editor modality.

### Patch Changes

- Updated dependencies [7b2d5ff]
- Updated dependencies [d1189ba]
  - @opengeni/contracts@0.42.0
  - @opengeni/config@0.12.9

## 0.28.18

### Patch Changes

- Updated dependencies [ef78ecf]
  - @opengeni/contracts@0.41.4
  - @opengeni/config@0.12.8

## 0.28.17

### Patch Changes

- 8485ff5: Fence approved session MCP tool execution against worker-shutdown replay.
- 1385585: Bound active turn memory, make worker admission cgroup-aware, and replace paused-prompt queue pressure with eligible Temporal backlog and slot saturation metrics.
- Updated dependencies [dfcf698]
  - @opengeni/contracts@0.41.3
  - @opengeni/config@0.12.7

## 0.28.16

### Patch Changes

- e2edfbc: Add provider-aware image generation with permanent verified artifacts,
  prompt-cache-safe history, sandbox materialization, and SDK/React rendering.
- Updated dependencies [e2edfbc]
- Updated dependencies [7f70d33]
  - @opengeni/codex@0.2.14
  - @opengeni/config@0.12.6
  - @opengeni/contracts@0.41.2
  - @opengeni/network@0.2.1

## 0.28.15

### Patch Changes

- 5806484: Serialize separate read-only Modal Channel-A requests across API replicas while preserving concurrent reads inside each batch.

## 0.28.14

### Patch Changes

- 81a51ac: Settle abandoned turn workspace admissions only after the exact attempt's physical writers drain, while preserving eager cancellation holder release and late sandbox provisioning safety. Add privacy-preserving sandbox lease correlation keys to rendered lifecycle logs.

## 0.28.13

### Patch Changes

- 2727236: Make sandbox draining crash-safe with durable capture and teardown ownership, idempotent Modal snapshots, scoped operator holds, parallel Temporal reaping, exact lifecycle errors, and verified Local/Docker workspace recovery.
- Updated dependencies [2727236]
- Updated dependencies [c8eb465]
  - @opengeni/config@0.12.5
  - @opengeni/contracts@0.41.1

## 0.28.12

### Patch Changes

- bb9a346: Add token and cache coverage plus nullable provider-rate cost comparisons to Workspace Insights, preserving exact Gateway billing while keeping incomplete configured telemetry unpriced.
- Updated dependencies [bb9a346]
  - @opengeni/config@0.12.4
  - @opengeni/contracts@0.41.0

## 0.28.11

### Patch Changes

- Updated dependencies [dec7ada]
  - @opengeni/config@0.12.3

## 0.28.10

### Patch Changes

- Updated dependencies [7d13f51]
- Updated dependencies [7ac558e]
  - @opengeni/config@0.12.2

## 0.28.9

### Patch Changes

- Updated dependencies [fed43cf]
- Updated dependencies [410835e]
  - @opengeni/contracts@0.40.0
  - @opengeni/config@0.12.1

## 0.28.8

### Patch Changes

- Updated dependencies [f8eb9f9]
- Updated dependencies [200586a]
- Updated dependencies [5dfb93d]
- Updated dependencies [5dfb93d]
  - @opengeni/config@0.12.0
  - @opengeni/contracts@0.39.5

## 0.28.7

### Patch Changes

- 377180c: Preserve the deployed migration 0172 bytes and move the connected-machine session default into a forward rolling migration.

## 0.28.6

### Patch Changes

- 70ced80: Add an offline-safe Connected Machine enrollment removal lifecycle with credential revocation, durable audit history, guarded route and lease handling, SDK/MCP support, and accessible active-list reconciliation.
- Updated dependencies [70ced80]
  - @opengeni/contracts@0.39.4
  - @opengeni/config@0.11.5

## 0.28.5

### Patch Changes

- Updated dependencies [43d45c6]
  - @opengeni/codex@0.2.13
  - @opengeni/config@0.11.4

## 0.28.4

### Patch Changes

- 7a84e1b: Retry transient retained-process promotion transactions and hand ambiguous yielded processes to exact-route turn finalization so they cannot strand sandbox leases.
- 5d8bb99: Allow scheduled tasks to target and durably wake one authorized existing session without creating a helper session or replacing its goal.
- 238fb7e: Keep human-to-human Slack DM shortcuts initiating-user-private and route durable acknowledgements, progress, results, and replies through the invoking user's OpenGeni bot DM.
- 34c5cdb: Retain validated computer screenshots as authenticated, integrity-checked session artifacts with bounded event/history receipts, SDK range assembly, and React rendering while preserving historical inline-image compatibility.

  Fence screenshot cleanup and quota accounting across parent deletion, duplicate settlement, expiry, compensation, and garbage-collection races so provider objects are deleted only after durable lifecycle ownership and quota is released exactly once.

- Updated dependencies [5d8bb99]
- Updated dependencies [af24281]
- Updated dependencies [34c5cdb]
  - @opengeni/contracts@0.39.3
  - @opengeni/config@0.11.3

## 0.28.3

### Patch Changes

- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- 23de73b: Add explicitly permissioned, audited plaintext reads for encrypted workspace variable-set values across REST, SDK, React, MCP, and UI surfaces.
- 1503151: Keep capped rotation-off Codex sessions in one durable capacity wait and suppress wakes for identical usage snapshots.
- a296081: Settle abandoned null-outcome direct sandbox mutation admissions when their physically completed request holder is released, preventing a failed settlement callback from blocking workspace checkpoint capture indefinitely. Require an exact physical-quiescence receipt before re-admitting a turn after graceful worker or provider recovery, and reconcile pre-fix attempts from their durable recovery event plus Temporal activity proof.
- Updated dependencies [7dbd057]
- Updated dependencies [30a0b9a]
- Updated dependencies [23de73b]
  - @opengeni/contracts@0.39.2
  - @opengeni/codex@0.2.12
  - @opengeni/config@0.11.2

## 0.28.2

### Patch Changes

- 110d255: Project paused sessions as idle after their interrupted attempt has quiesced, while preserving the recovering turn for Resume.
- ce823ce: Replace first-party MCP mutation entity echoes with strict, versioned compact
  receipts; add bounded scheduled-task list/detail projections and preserve worker
  session references across receipt and legacy timeline results.
- Updated dependencies [ce823ce]
  - @opengeni/contracts@0.39.1
  - @opengeni/config@0.11.1

## 0.28.1

### Patch Changes

- 55f6ad0: Use one terminal-response ordinal for provider context binding, and clear the
  durable input-token signal when the latest provider response supplies no usable
  usage instead of retaining an older response's count.

## 0.28.0

### Minor Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.

### Patch Changes

- 49c7f9c: Prevent deadlocks between sandbox mutation settlement and retained-process promotion, retry idempotent settlement transactions after transient database conflicts, and clarify that an idle session sandbox can be restored when the next operation needs it.
- 5b6d36e: Use provider-reported usage rather than whole-request approximations for automatic context compaction, preserve provider-only input-token state across context rewrites, and label timeline counts as estimated conversation-history tokens.
- Updated dependencies [5b6d36e]
- Updated dependencies [6eb0b23]
  - @opengeni/config@0.11.0
  - @opengeni/contracts@0.39.0

## 0.27.12

### Patch Changes

- cbf165a: Reconcile settled attempt quiescence while session control remains paused so ancestor sessions do not stay stuck in a stopping transition.

## 0.27.11

### Patch Changes

- 17643a5: Prevent parallel child-session creation from the same agent attempt from deadlocking on the parent session row.
- Updated dependencies [8135dbb]
  - @opengeni/config@0.10.14

## 0.27.10

### Patch Changes

- 69bc207: Keep Codex history canonical across subscriptions and providers, separate optional owner-designated Codex Apps authority from inference allocation, and fence Apps authorization through each remote request.
- 144fd9e: Prevent fully quiesced historical interruptions from upgrading later ordinary workflow wakes to control signals.
- c0f8e40: Prevent model-visible GitHub installation credential exposure and duplicate brokered MCP side effects after ambiguous 401 responses.
- Updated dependencies [69bc207]
- Updated dependencies [c0f8e40]
  - @opengeni/codex@0.2.11
  - @opengeni/contracts@0.38.3
  - @opengeni/config@0.10.13

## 0.27.9

### Patch Changes

- 4502474: Add workspace-default and explicitly personal ownership for first-party social connections, preserve causal personal authority for agent work, and retain actionable structured gateway errors.
- Updated dependencies [4502474]
  - @opengeni/contracts@0.38.2
  - @opengeni/config@0.10.12

## 0.27.8

### Patch Changes

- dfa3aef: Preserve Steer priority through provider recovery and repair interrupted attempts durably.

## 0.27.7

### Patch Changes

- c29fd4c: Bound MCP OAuth callbacks through token exchange and persistence, return safe stage-specific failures to the capabilities UI, and replace incompatible dynamic client registrations with a compare-and-swap update.

## 0.27.6

### Patch Changes

- Updated dependencies [664c1d8]
  - @opengeni/network@0.2.0

## 0.27.5

### Patch Changes

- c9d8b69: Make Connected Machine project paths portable and diagnosable: session responses now expose `workingDir`, and the native agent consistently supports the service user's `~` path across exec, filesystem, git, and terminal operations while reporting missing working directories accurately.
- Updated dependencies [c9d8b69]
  - @opengeni/contracts@0.38.1
  - @opengeni/config@0.10.11

## 0.27.4

### Patch Changes

- b6e39fc: Polish session chrome and apply_patch rendering; clarify realtime voice-end handoff.

  SessionChrome gets denser selected-chip UX and Codex function-tool apply_patch shapes render in the specialized diff UI. Solo goal_continuation machine-input rows are suppressed in favor of the GoalRow landmark. The realtime transcript-tail instruction now keeps in-flight work going after voice ends.

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/config@0.10.10
  - @opengeni/contracts@0.38.0

## 0.27.3

### Patch Changes

- Updated dependencies [4976e1c]
  - @opengeni/network@0.1.2

## 0.27.2

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/contracts@0.37.0
  - @opengeni/config@0.10.9

## 0.27.1

### Patch Changes

- Updated dependencies [abe0de6]
  - @opengeni/config@0.10.8
  - @opengeni/contracts@0.36.1

## 0.27.0

### Minor Changes

- 00f7d3b: Add durable, tenant-isolated onboarding proposals that atomically create inactive instruction-policy drafts with typed replay, stale-baseline, conflict, and audit contracts, plus a bounded Workspace State admin composer.

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/contracts@0.36.0
  - @opengeni/config@0.10.7

## 0.26.0

### Minor Changes

- b121e7c: Add durable Google Drive pause, resume, disconnect, reconnect, revoked-token,
  removed-app, and permission re-consent lifecycle handling with version-fenced
  state transitions, generation-bound disconnect idempotency, stale-replay
  protection, and secret-safe provider error classification.

### Patch Changes

- Updated dependencies [b121e7c]
  - @opengeni/contracts@0.35.0
  - @opengeni/config@0.10.6

## 0.25.0

### Minor Changes

- b83af7a: Add replay-safe workspace instruction policy administration across the API,
  contracts, database, and SDK, including immutable operation receipts that reject
  changed requests reusing the same operation identifier.

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/contracts@0.34.0
  - @opengeni/config@0.10.5

## 0.24.0

### Minor Changes

- 3e4842d: Add subject-authorized accepted-attempt governance inspection to Workspace State,
  including immutable policy/preference snapshot metadata and deterministic current
  drift classification without exposing prompt or personal preference content.

### Patch Changes

- d1f0c3d: Add immutable organization, workspace, and initiating-user personal authority to Documents and chunks; filter retrieval by exact account and authority before ranking; require exact account-admin authority for organization publication; and preserve authority through a drained API, worker, and indexing-workflow cutover.
- 088d7cb: Replay historical three-field document indexing workflows by resolving the immutable stored authority tuple under exact account and workspace RLS before parser, embedding, status, or chunk writes.
- Updated dependencies [d1f0c3d]
- Updated dependencies [1d0f2ae]
- Updated dependencies [74bd3a5]
- Updated dependencies [3e4842d]
  - @opengeni/contracts@0.33.0
  - @opengeni/config@0.10.4

## 0.23.0

### Minor Changes

- 13b961e: Add an atomic terminal session-subtree cancellation command that drains queued work, fences concurrent prompts and child creation, interrupts live attempts, durably reports cancelled children to surviving parents, and exposes the operation through the API/core/SDK control surface.
- e03397d: Freeze workspace instruction policies and structured preference descriptors at
  the accepted logical-turn boundary, add immutable per-session policy roles, and
  compose the resulting exact-attempt governance into agent and compaction prompts.

### Patch Changes

- acfcf38: Preserve one durable task per distinct authorized Slack reaction when concurrent events share a canonical session, including route-bind, acknowledgement, and inbox-settlement recovery.
- Updated dependencies [13b961e]
- Updated dependencies [ecc4288]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [3baaebd]
  - @opengeni/contracts@0.32.0
  - @opengeni/codex@0.2.10
  - @opengeni/config@0.10.3

## 0.22.3

### Patch Changes

- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
- Updated dependencies [b4982fa]
  - @opengeni/contracts@0.31.2
  - @opengeni/config@0.10.2

## 0.22.2

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.
- Updated dependencies [9c4d73d]
  - @opengeni/config@0.10.1
  - @opengeni/contracts@0.31.1

## 0.22.1

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/config@0.10.0
  - @opengeni/contracts@0.31.0

## 0.22.0

### Minor Changes

- e07eb52: Enforce frozen Allow, Ask, and Block connector action policies before provider execution while persisting metadata-only approval, decision, and outcome evidence.

## 0.21.0

### Minor Changes

- 2321119: Add the provider-neutral scoped knowledge provenance, lifecycle, ACL, and normalized claim foundation for organization, workspace, and initiating-user personal evidence.

### Patch Changes

- Updated dependencies [2321119]
  - @opengeni/contracts@0.30.0
  - @opengeni/config@0.9.3

## 0.20.0

### Minor Changes

- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.

### Patch Changes

- 03ed7eb: Preserve the linked Slack user's latest effective browser-selected turn model for inbound tasks and surface bounded session admission failures in Slack.
- Updated dependencies [dd71248]
  - @opengeni/contracts@0.29.0
  - @opengeni/config@0.9.2

## 0.19.0

### Minor Changes

- 1a2d41f: Add the typed hierarchical memory governance schema, lifecycle operations, and FORCE-RLS foundation.

## 0.18.1

### Patch Changes

- 659b3ff: Harden Slack-triggered session delivery, identity linking, provider backoff, explicit connection-tool selection, and replay-safe bounded progress/final delivery.
- Updated dependencies [659b3ff]
  - @opengeni/contracts@0.28.1
  - @opengeni/config@0.9.1

## 0.18.0

### Minor Changes

- 5a4c559: Add first-party X and Reddit social connectors: OAuth connect flows (X PKCE
  S256, Reddit permanent grant) with encrypted token storage and just-in-time
  refresh, live first-party MCP tools (search, mentions, thread fetch, own-post
  sync, permission-gated reply publishing), a reddit provider in the marketing
  pack, operator config via OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON, and SDK
  startSocialOAuth/listSocialConnections.

### Patch Changes

- d4d8960: Keep Personal Slack UI, reconnect, and broker credential selection on one deterministic legacy-duplicate ordering.
- Updated dependencies [d4d8960]
- Updated dependencies [ec0bc02]
- Updated dependencies [5a4c559]
  - @opengeni/contracts@0.28.0
  - @opengeni/config@0.9.0

## 0.17.1

### Patch Changes

- Updated dependencies [8243ffe]
  - @opengeni/config@0.8.1

## 0.17.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

### Patch Changes

- dcc35c5: Add authenticated Slack mentions, commands, message shortcuts, atomically private bot-DM sessions, durable thread continuation, and globally bounded idempotent progress delivery.
- Updated dependencies [dcc35c5]
- Updated dependencies [1ec9912]
  - @opengeni/config@0.8.0
  - @opengeni/contracts@0.27.0

## 0.16.2

### Patch Changes

- c52acc0: Ship Fast latency mode with turn-column inheritance, Codex ChatGPT honor-skip for response service_tier, and model picker UX polish.
- Updated dependencies [c52acc0]
  - @opengeni/codex@0.2.9
  - @opengeni/config@0.7.22
  - @opengeni/contracts@0.26.1

## 0.16.1

### Patch Changes

- 02fb98c: Reconcile expired draining sandboxes after their exact provider instance has disappeared.

## 0.16.0

### Minor Changes

- f413e6c: Add real Workspace Insights: durable `model_call_facts` after authoritative
  `agent.model.usage`, a `workspace:admin` insights API over usage_events + facts +
  live joins, SDK client, and a web console that drops mock rollups for honest
  UTC credit/token/cache/warm/caps reporting.

### Patch Changes

- b5175a8: Move the unapplied Slack delete-operation migration after the already-deployed
  sandbox migration history, while accepting only the exact legacy staging
  receipt for an idempotent replay.
- Updated dependencies [f413e6c]
  - @opengeni/contracts@0.26.0
  - @opengeni/config@0.7.21

## 0.15.6

### Patch Changes

- 0199108: Harden the workspace Slack bot with one fail-closed scope policy, deterministic legacy connection selection, and durable replay-safe message deletion operation identities.
- 42428a2: Add per-session Codex remote compaction v2 (`remote_v2` / `portable`), with UI landmarks, Codex-only model locking, and opaque token accounting aligned to Codex CLI.
- 7b65614: Keep over-limit viewer-only sandboxes drained until a fresh serialized balance
  or monthly-cap evaluation clears a durable workspace admission gate. Viewer
  reattach can no longer re-arm a draining box or spawn a cold successor, while a
  turn-held sandbox remains viewable.
- Updated dependencies [0199108]
- Updated dependencies [42428a2]
- Updated dependencies [b2e975f]
- Updated dependencies [9f3b931]
  - @opengeni/contracts@0.25.0
  - @opengeni/config@0.7.20

## 0.15.5

### Patch Changes

- b7df541: Prevent provider-native checkpoint capture from racing sandbox operations while
  the provider has paused the source box. Capture now owns a durable
  lease/epoch/instance/generation claim, blocks new holders and mutations, drains
  provider-local reads before entering the exclusive snapshot call, and retains
  ownership through late provider settlement and exact stale-claim recovery.
  Modal's typed completed-exec stdin race is also normalized into a side-effect-free
  terminal poll, so an exec that exits between local lookup and the provider write
  settles its retained process instead of failing the enclosing turn.
- Updated dependencies [710b081]
- Updated dependencies [b7df541]
  - @opengeni/contracts@0.24.3
  - @opengeni/config@0.7.19

## 0.15.4

### Patch Changes

- 84fb671: Prevent a ready file restored during reconnect from being counted twice across the durable composer draft and the still-live attachment card. Canonical duplicate refs are removed before draft persistence and composer submission while custom mounts and exact draft revision/content conflict protection remain intact.
- Updated dependencies [96eb64b]
  - @opengeni/config@0.7.18
  - @opengeni/contracts@0.24.2

## 0.15.3

### Patch Changes

- 510eae3: Keep restored Modal checkpoints valid across live workspace writes, serialize
  lease reaping with concurrent acquisition, and rotate image or rig changes
  through durable checkpoint capture instead of discarding provider ownership.

## 0.15.2

### Patch Changes

- ddff8db: Add the read-only Workspace State inventory with bounded, authorization-scoped
  Documents aggregates and a deterministic metadata-only Memory projection. The
  projection explicitly labels legacy `knowledge_memories` preference-kind counts
  as non-authoritative observations while preserving the structured preference
  registry as the sole active preference authority.
- Updated dependencies [ddff8db]
- Updated dependencies [0a9a6eb]
  - @opengeni/contracts@0.24.1
  - @opengeni/config@0.7.17

## 0.15.1

### Patch Changes

- 6d167f4: Recover exact Codex encrypted-artifact rejections without deleting durable conversation truth, and make maintenance migration protocol activation part of the canonical migration transaction.
- Updated dependencies [6d167f4]
  - @opengeni/codex@0.2.8
  - @opengeni/config@0.7.16

## 0.15.0

### Minor Changes

- 1f6f13f: Add the isolated, versioned organization/workspace/user preference registry,
  including audited proposal and activation flows, deterministic attempt-bound
  descriptors, authorized full-content retrieval, REST/MCP tools, and SDK types.
  Attempt reads revalidate current generation and immutable-human authority in one
  locked transaction; lifecycle writes use scope-version CAS and database-owned
  audit functions that prevent direct head mutation or history erasure. Snapshot
  creation is database-canonical and lifecycle governance requires a signed
  `human_session` principal; expiry filtering and supersession are transactionally
  enforced before bounds or terminal mutation.

### Patch Changes

- a19971e: Treat native provider snapshot receipts as typed opaque artifacts instead of tar
  trees; track every Modal Image in a provider-bound, crash-safe checkpoint ledger;
  garbage-collect displaced and publication-losing Images; adopt only provable
  legacy ownership; bind retained processes to their exact Modal namespace and
  reconcile historical terminal boxes without touching successors; rotate finite
  Modal boxes through the canonical checkpoint/drain/rematerialization path before
  their persisted deadline without checkpointing across an active direct API
  mutation; memoize terminal recovery failures; and use Modal's
  documented 24-hour maximum as the default hard box lifetime. Frame confined
  filesystem/Git command output at both boundaries with a fresh attempt nonce and
  strict exit-status parsing so provider diagnostics, truncation, or delayed
  retries cannot corrupt Modal-like `execCommand` control records. Upgrade the
  Modal JavaScript SDK to 0.9.0 and explicitly retain native checkpoint Images
  until the provider-bound artifact ledger proves that their exact ids are safe
  to garbage-collect.
- Updated dependencies [a19971e]
- Updated dependencies [1f6f13f]
  - @opengeni/config@0.7.15
  - @opengeni/contracts@0.24.0

## 0.14.7

### Patch Changes

- 848287f: Seed the reviewed integrations capability catalog by default in Helm and local deployments while skipping unchanged snapshots.

## 0.14.6

### Patch Changes

- 2aca964: Allow PostgreSQL 16+ managed-service role provisioning to retain the exact non-runtime-bearing creator-management grant while continuing to reject every privilege-bearing role relationship.

## 0.14.5

### Patch Changes

- ad0bdc3: Surface managed-credit admission rejections with actionable composer recovery guidance while preserving drafts and attachments, and canonicalize default attachment mounts across established-session draft admission and replay.
- Updated dependencies [ad0bdc3]
  - @opengeni/contracts@0.23.1
  - @opengeni/config@0.7.14

## 0.14.4

### Patch Changes

- ea38a4c: Make cold sandbox recovery fail closed for database roles that bypass row-level security, preserving recovery safety before blocker settlement.

## 0.14.3

### Patch Changes

- Updated dependencies [33dc88f]
- Updated dependencies [36451c6]
  - @opengeni/contracts@0.23.0
  - @opengeni/config@0.7.13

## 0.14.2

### Patch Changes

- 1c4018e: Replace one-turn tool overrides with one durable session tool policy, expose
  OpenGeni-native tools in the same selection, default available tools on, and
  render delivered machine inputs as compact typed timeline updates instead of
  raw protocol JSON.
- Updated dependencies [1c4018e]
  - @opengeni/config@0.7.12
  - @opengeni/contracts@0.22.1

## 0.14.1

### Patch Changes

- 6908a7a: Resolve session existence and the latest workspace capture in one RLS-scoped query so capture metadata requests avoid loading the full session projection.

## 0.14.0

### Minor Changes

- 29ad09b: Persist typed machine inputs into canonical model history at turn claim, expose
  authoritative pending-input queue projections and lifecycle events, render
  delivered batches in the timeline, and preserve append-only prompt-cache
  prefixes across tools, later turns, recovery, and explicit compaction.

### Patch Changes

- dfc3235: Separate first-party MCP authorization from exact per-session tool visibility, add fail-closed registration policy, and isolate file download URLs on the files MCP surface.
- Updated dependencies [29ad09b]
- Updated dependencies [b2e23f3]
- Updated dependencies [dfc3235]
  - @opengeni/contracts@0.22.0
  - @opengeni/config@0.7.11

## 0.13.4

### Patch Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.
- Updated dependencies [519d93c]
  - @opengeni/contracts@0.21.0
  - @opengeni/config@0.7.10

## 0.13.3

### Patch Changes

- 110bb77: Enforce exact-subject ownership for personal OAuth capabilities and add secure direct OAuth installation for the separate workspace OpenGeni Slack bot.
- Updated dependencies [110bb77]
  - @opengeni/config@0.7.9
  - @opengeni/contracts@0.20.2

## 0.13.2

### Patch Changes

- 8b8545e: Keep every account-scoped workspace grant in bootstrapped access contexts so newly created workspaces remain available after an access refresh.

## 0.13.1

### Patch Changes

- Updated dependencies [ffd246c]
  - @opengeni/contracts@0.20.1
  - @opengeni/config@0.7.8

## 0.13.0

### Minor Changes

- 06a5801: Add the backend workspace instruction-policy revision, activation, rollback, audit, API, and SDK control surface.

### Patch Changes

- Updated dependencies [06a5801]
- Updated dependencies [9326255]
- Updated dependencies [5511c24]
  - @opengeni/contracts@0.20.0
  - @opengeni/config@0.7.7

## 0.12.6

### Patch Changes

- 9a8f793: Add fail-closed GitHub personal/organization owner authority proofs, audited
  workspace installation bindings with explicit repository allowlists, and
  truthful disabled/unbound/bound lifecycle contracts.
- c135339: Persist safe new-session defaults after successful creates while preserving explicit tool-policy semantics and revalidating stale workspace resources before reuse.
- Updated dependencies [9a8f793]
- Updated dependencies [c135339]
  - @opengeni/contracts@0.19.4
  - @opengeni/config@0.7.6

## 0.12.5

### Patch Changes

- Updated dependencies [a0f2442]
  - @opengeni/contracts@0.19.3
  - @opengeni/config@0.7.5

## 0.12.4

### Patch Changes

- Updated dependencies [85cb323]
  - @opengeni/config@0.7.4
  - @opengeni/contracts@0.19.2

## 0.12.3

### Patch Changes

- 1386679: Make context compaction provider-portable with Codex-compatible plaintext checkpoints, drop
  foreign account-bound reasoning during subscription rotation, and preserve the exact logical turn
  through durable all-subscriptions-exhausted capacity waits.
- b7290a3: Index duplicate-event lineage so foreign-key validation and exact session cleanup remain bounded at
  production event-table cardinality.
- dcde939: Allow a cold sandbox lease to elect a new rematerialization attempt after a restore failure explicitly marked retryable, while continuing to block non-retryable degraded and unrecoverable archives.
- 5685f32: Add the restricted runtime database posture contract and workspace-scoped RLS context validation, together with the runtime-role configuration required by standalone API and worker startup.
- de20184: Redact known runtime credentials and recognized authorization, cookie, signed
  URL, assignment, and provider-token shapes before model calls, durable session
  history, events, logs, and telemetry. Disable credential-bearing shell xtrace
  and raw Agents SDK model, tool, and MCP transport payload logging.
- Updated dependencies [5685f32]
- Updated dependencies [de20184]
  - @opengeni/config@0.7.3
  - @opengeni/contracts@0.19.1

## 0.12.2

### Patch Changes

- 7c6aa7c: Keep Codex connected-app MCP tools disabled by default behind the independent
  `OPENGENI_CODEX_CONNECTED_APPS_ENABLED` deployment switch.
- Updated dependencies [7c6aa7c]
  - @opengeni/config@0.7.2

## 0.12.1

### Patch Changes

- Updated dependencies [55c6559]
  - @opengeni/config@0.7.1

## 0.12.0

### Minor Changes

- 46bac05: Enforce a configurable inclusive nested-agent depth at the transactional
  session-creation boundary with a server default of three. Persist immutable
  lineage and policy snapshots, and return idempotent typed denial evidence without
  creating run, workflow, sandbox, usage, or billing artifacts.

### Patch Changes

- c549ed8: Persist and transactionally materialize revisioned active-goal continuation
  obligations, recover their Temporal delivery without human input or model
  polling, preserve authoritative human/Steer ordering, and expose truthful
  scheduled, running, blocked, and invariant-broken continuation state to clients.
  Make agent goal updates revisioned, attempt-recoverable commands so ambiguous
  commit responses reconcile without duplicate mutation or stale overwrites.
- 860de22: Persist actor-private pre-session drafts on the server, consume only the exact accepted revision after durable session initialization, return structured create errors, deduplicate create resources, derive checksums for SDK uploads, restore finalized attachments without browser-local byte authority, and preserve attachments added while an earlier send is in flight.
- 5b57a2d: Make provisioned-sandbox recovery truthful and atomic. Provider existence,
  lease liveness, route attachment, archive availability, restore progress,
  verified workspace readiness, and epochs are exposed separately; attach/swap
  must certify readiness. Definitive provider loss is exact-instance fenced,
  concurrent observers receive typed recovery/superseded outcomes, and ambiguous
  operations are never replayed. Rematerialization selects one verified archive
  revision under the lease lock, verifies archive bytes and restored tree contents,
  and fails closed as degraded or unrecoverable instead of publishing a partial,
  mixed, previous, or clean fallback workspace.

  Unify every persistable workspace mutation under durable turn, API-direct, or
  retained-process authority. Direct requests use exact request UUID holders;
  yielded processes retain their parent admission and exact pinned provider/route
  identity until durable exit/loss settlement. Direct/process authority blocks
  archive capture, process stdin receives a distinct mutation admission, and PTY
  control cannot be rerouted by active-pointer movement.

  Make terminal execution physically synchronous: `terminalExec` always returns a
  numeric `exitCode` with `running: false`, and timeout/error paths return only
  after exact process-group absence and retained settlement. Interactive PTYs open
  only after durable promotion, close only on exact terminal proof, and report
  provider loss truthfully.

  Activate the generation/process schema through maintenance migration 0117. All
  old API/control/turn writers must stop before the one-way cutover and may not
  restart afterward; archive completeness requires the exact closed generation.

- Updated dependencies [c549ed8]
- Updated dependencies [46bac05]
- Updated dependencies [860de22]
- Updated dependencies [5b57a2d]
  - @opengeni/contracts@0.19.0
  - @opengeni/config@0.7.0

## 0.11.0

### Minor Changes

- 0ed0f01: Add per-member session pin preferences with isolated server persistence, bounded/reused stable
  pagination snapshots, snapshot-free pin polling, typed SDK and React reconciliation, and accessible
  list and header controls.

### Patch Changes

- b32938f: Preserve the resolved model tool-output policy across pending-call recovery so
  ordinary and recovered conversation history use one byte-identical bound.
- Updated dependencies [744a93d]
  - @opengeni/config@0.6.10
  - @opengeni/contracts@0.18.1

## 0.10.7

### Patch Changes

- 0d60720: Add capability-first session tool policies with omission-as-discovery defaults,
  explicit per-turn narrowing and child inheritance, secret-safe effective-policy
  projections, stable lazy `tool_search` catalogs, and matching API, SDK, React,
  worker, embedding, and audit contracts.

  Harden credential-bearing MCP and OAuth traffic with destination-bound
  credentials, single-resolution DNS-pinned transport, bounded catalogs, schemas,
  results, request and response bodies, and independently validated manual
  redirects. Extend renewable, session-bound Toolspace access to connected
  machines while dynamically fencing every call to the session's active attempt.

- Updated dependencies [0d60720]
- Updated dependencies [bdd531c]
  - @opengeni/config@0.6.9
  - @opengeni/contracts@0.18.0
  - @opengeni/network@0.1.1
  - @opengeni/codex@0.2.7

## 0.10.6

### Patch Changes

- 524599e: Normalize model, provider, upstream deployment, credential source, billing,
  capability, health, and pricing identity; expose a secret-safe authenticated
  workspace catalog with separate fail-closed credential readiness for federated
  providers; and persist the accepted model/reasoning execution policy on new
  logical turns.
- Updated dependencies [524599e]
  - @opengeni/config@0.6.8
  - @opengeni/contracts@0.17.3

## 0.10.5

### Patch Changes

- 229902b: Add trustworthy per-subscription Codex quota/reset-credit overview and allocator OCC controls, plus an owning-human managed-cookie-only reset redemption flow with durable ambiguity-safe provider idempotency.
- Updated dependencies [229902b]
  - @opengeni/codex@0.2.6
  - @opengeni/config@0.6.7

## 0.10.4

### Patch Changes

- 4966649: Add bounded authoritative terminal-result projections to session event monitoring APIs and SDK types.
- Updated dependencies [4966649]
- Updated dependencies [cb188f9]
  - @opengeni/contracts@0.17.2
  - @opengeni/config@0.6.6

## 0.10.3

### Patch Changes

- 495c62c: Preserve published host-export migrations and enforce lineage with a bounded forward-only repair.

## 0.10.2

### Patch Changes

- ff23da5: Keep oversized event previews bounded while optionally linking them to integrity-addressed workspace-file evidence, and expose access-controlled metadata plus capped provider-native range retrieval through the API and SDK.
- Updated dependencies [ff23da5]
  - @opengeni/contracts@0.17.1
  - @opengeni/config@0.6.5

## 0.10.1

### Patch Changes

- eed3438: Preserve private per-turn instructions when queue-edited prompts are resubmitted.

## 0.10.0

### Minor Changes

- d1dee7a: Let embedding hosts read and update an existing session MCP server's approval
  policy through the public API, SDK, and React session hook. Each claimed
  attempt freezes its policy under the session lock, so updates affect the next
  attempt without reinterpreting work already running; model MCP and
  Toolspace/Code Mode consume the same exact snapshot. Toolspace tokens and
  side-effect receipts bind every proxied call to the exact active attempt, so
  Pause, Steer, recovery, and late outputs preserve one authoritative owner.

### Patch Changes

- Updated dependencies [d1dee7a]
  - @opengeni/contracts@0.17.0
  - @opengeni/config@0.6.4

## 0.9.4

### Patch Changes

- Updated dependencies [b9cec61]
- Updated dependencies [c978676]
  - @opengeni/contracts@0.16.0
  - @opengeni/config@0.6.3

## 0.9.3

### Patch Changes

- 9f84cc9: Add durable host-provided per-turn instructions, headless structured-input hooks, host-local queue
  focus, and reusable approval and human-input surfaces for embedded session consumers.
- Updated dependencies [9f84cc9]
  - @opengeni/contracts@0.15.0
  - @opengeni/config@0.6.2

## 0.9.2

### Patch Changes

- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/contracts@0.14.0
  - @opengeni/config@0.6.1

## 0.9.1

### Patch Changes

- 1f0ed18: Restore immutable concurrent-index migration history, stage populated-table migrations safely, and reject goal-bearing child sessions whose resulting first-party authority lacks `goals:manage`.
- 00e1cdc: Enforce explicit session-event lock contracts and preserve sanitized PostgreSQL failure classification without replaying external effects.

## 0.9.0

### Minor Changes

- 32011f1: Add an optional durable host event and usage export for embedded deployments: source-transactional bounded snapshots, immutable turn attribution and session-root lineage, named at-least-once checkpoints, multi-replica leases, replay and retention controls, explicit poison-record disposition, an isolated exporter database role, and a worker delivery pump. Standalone deployments keep capture disabled until a host registers a sink.
- 4401ce7: Add a scope-checked host MCP credential resolver to the public embedding port and use it consistently for model-visible MCP tools and Toolspace/Code Mode while preserving the standalone connection broker as the default. Requests carry both the immediate session and its workspace-scoped lineage root so embedded hosts can authorize child sessions through one durable root binding. Provider-neutral bindings now carry a provider family, provider host, opaque host binding id, and exact selected-repository set; successful credentials must echo the complete binding before headers are accepted. Incompatible endpoint authentication and unenforceable resource containment surface as explicit unavailable states instead of starting a duplicate OpenGeni provider connection.
- c389adc: Add a provider-neutral host run-credential port with frozen turn/session lineage,
  off-manifest environment and file generations, proactive renewal, attempt-safe
  cleanup with bounded generation retention, output redaction hints, and structured
  reconnect UI support. Hosts can explicitly opt a frozen target out, and the
  POSIX materializer supports both Linux `flock` and a portable directory-lock
  fallback with cross-platform base64 decoding.
- 1f9305b: Add a host-owned session authorization port for embedded deployments. The port
  receives server-resolved root lineage and live agent-attempt authority, scopes
  session listing inside database queries, distinguishes exact from whole-tree
  projection access, gates HTTP/core/first-party MCP/Toolspace surfaces, and
  periodically reauthorizes idle SSE streams while standalone deployments retain
  their existing behavior when the port is unset.
- 8c66185: Let agent-created child sessions inherit omitted repository, MCP tool, and
  per-session MCP server context from their trusted immediate parent. Explicit
  arrays remain authoritative, mixed Git providers and multiple bindings are
  preserved, and credential headers are copied only as encrypted ciphertext.
- d249403: Allow embedding hosts to preallocate a session UUID before OpenGeni admits the
  initial turn. Session creation preserves idempotent replays of the same UUID and
  returns a conflict for UUID reuse or an idempotency replay that changes identity.
  The additive create response also returns `initialTurnId`, so an embedding host
  can correlate a preallocated host run without misusing the nullable
  `activeTurnId` execution pointer.
- dda6398: Add durable structured human-input tool calls with exact-turn ownership,
  answer/skip/expiry/cancellation outcomes, restart-safe Temporal resumption,
  authorized API and SDK methods, and headless plus styled React embed surfaces.
- e8ca4f6: Let trusted embedding hosts sign a service-only causal initiator separately
  from the delegated subject that authorizes a create, Send, or Steer command.
  Freeze that service and its non-secret provenance onto the new session/turn,
  while rejecting human impersonation, exact agent-attempt replacement, reserved
  lineage fields, the legacy migration sentinel, and oversized provenance.
  Service-provenance HTTP tokens use a prefix-bound `ogd2_` envelope so older
  rolling-deploy verifiers fail closed instead of silently stripping attribution.
- 736f4fe: Persist and expose one immutable subject-or-service initiator for every accepted turn, including creator-safe idempotent repair, queue-edit preservation, exact live-attempt fencing for agent-created sessions, signed agent inheritance, causally dominant Agent Steer attribution, explicit service producers, rolling legacy backfill, and database-enforced immutability.
  Bounded agent provenance now retains its first causal hop together with the
  newest hops, so deep child chains do not discard their root authority when the
  middle of the audit path is truncated.

### Patch Changes

- Updated dependencies [1fcd83d]
- Updated dependencies [32011f1]
- Updated dependencies [3983021]
- Updated dependencies [4401ce7]
- Updated dependencies [c389adc]
- Updated dependencies [1f9305b]
- Updated dependencies [8c66185]
- Updated dependencies [334b63f]
- Updated dependencies [d249403]
- Updated dependencies [a11a7fc]
- Updated dependencies [44ff327]
- Updated dependencies [dda6398]
- Updated dependencies [5529945]
- Updated dependencies [e8ca4f6]
- Updated dependencies [736f4fe]
  - @opengeni/contracts@0.13.0
  - @opengeni/config@0.6.0

## 0.8.0

### Minor Changes

- dbb6232: Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

  - Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
  - Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
  - Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
  - Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.

### Patch Changes

- 77d65f9: Use one canonical lock order for session-event persistence and retry only idempotent database transactions after deadlock or serialization failures, including generic event appends and operation-keyed Agent commands.
- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- Updated dependencies
- Updated dependencies [dbb6232]
- Updated dependencies [3e65c23]
  - @opengeni/codex@0.2.5
  - @opengeni/config@0.5.3
  - @opengeni/contracts@0.12.0

## 0.7.5

### Patch Changes

- 28290a0: Make context compaction and pending tool-call recovery converge without reactivating superseded history or repeating failed internal turns.

## 0.7.4

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.
- 053c5df: The codex rotation strategy picker is gone: rotation-enabled always behaves as sticky-sharded (sharded-rotation policy). Sessions stick to one subscription each for maximum prompt-cache reuse, spread across all connected accounts, rebalancing only when a plan caps. The legacy strategies (most-remaining, round-robin, drain-then-next) are all strictly dominated post-cache-affinity and are now normalized to sharded at every worker read site; their branch code is kept but unreachable (rollback safety). The API accepts-but-ignores `rotationStrategy` writes (deprecated no-op, no caller breaks) and reports `sharded` as the effective truth; migration 0064 backfills stored legacy values and flips the column default. The web settings surface drops the strategy dropdown for honest copy. Remaining user controls are the real intents: rotation on/off, manual per-session pins, and (with account eligibility policy) per-account allocator include/exclude.
- ec0697a: Ship the production-hardened captured workspace workbench, physically verified Steer/Pause cancellation across cloud, local, and self-hosted model tools, pre-model preparation, sandbox provisioning, and lifecycle/setup commands, durable quiescence admission fencing, cancellation-aware SDK reads and turn cleanup, single-round-trip pruned workspace indexing, truthful shutdown states, a responsive and accessible review dock, Unicode coverage, and package-safe CSS/SSR integration.
- Updated dependencies [14ce2e3]
- Updated dependencies [ec0697a]
  - @opengeni/codex@0.2.4
  - @opengeni/config@0.5.2
  - @opengeni/contracts@0.11.0

## 0.7.3

### Patch Changes

- b9dbb63: Keep failed-child result provenance owned by the atomic turn settlement. Worker activities now read and deliver the exact committed outbox row without rewriting its turn-scoped payload or lineage.

## 0.7.2

### Patch Changes

- Updated dependencies [6882ff2]
  - @opengeni/codex@0.2.3
  - @opengeni/config@0.5.1

## 0.7.1

### Patch Changes

- ea52b39: Recover retryable provider failures as new fenced attempts of the same accepted turn, independent of goal state, while preserving durable tool history and pause controls.

## 0.7.0

### Minor Changes

- a0cb58f: Streaming exec to Connected Machines over the op-stream protocol (server half).
  When a runner advertises the `op_stream` capability (persisted from its connect
  Hello onto the enrollment) and `OPENGENI_AGENT_OP_STREAM_ENABLED` is on
  (default off), selfhosted exec streams as sequenced, acked, credit-flowed
  frames: no reply-size wall (retention-bounded, typed on overflow), blip-proof
  collection (re-attach + replay, blake3-verified byte-exact), and idempotent
  starts keyed by a durable per-tool-call op id so a re-dispatched turn attaches
  to the already-running command instead of re-running it. The legacy monolithic
  exec remains the permanent fallback wire form. The events bus gains an
  op-stream subscribe/publish accessor on the same managed NATS connection.

### Patch Changes

- 332ac15: Add workspace-scoped operator session-revival admission helpers and pending-work guards for safe control-plane recovery tooling.
- ad4502a: Make the workbench and console dependency-safe, keep list identities stable, preserve caught error causes, isolate desktop consent tests from real transports, and enforce warning-free repository lint plus aggregate React tests in CI.
- 477b2bb: Add a "sharded" codex rotation strategy: session-sharded account affinity. Each session is assigned a deterministic HOME account (`hash(sessionId) % healthy-accounts`) at its first codex turn, written as a `policy` pin (a new `sessions.codex_pin_source` discriminator distinguishes it from a user's `manual` pin). A session stays on its one home account for prompt-cache warmth while load spreads ~1/N across the pool.

  Both rotation guards (proactive turn-start and reactive 429) now allow a `policy`-pinned session to rebalance when its account caps — never a `manual` pin, which stays sacred. A rebalance durably REWRITES the session pin (re-sharding over the healthy survivors so capped-account cohorts spread instead of re-concentrating on one failover) rather than moving only the workspace active pointer, because credential selection returns a pinned account with no exhaustion check.

  Pin lifecycle: a `manual` pin is honored under every strategy; a `policy` pin is meaningful only while the sharded policy is active. When a workspace runs a non-sharded strategy (or rotation is disabled), a leftover policy pin is ignored and lazily cleared on the session's next turn — so the session converges to the active strategy instead of idling on a capped ex-home. The strategy is selectable alongside `most_remaining`/`round_robin`/`drain_then_next` via the existing rotation-settings API; unpinned behavior under the other strategies is unchanged.

- 04d7595: Discover repositories at any workspace nesting depth, including linked worktrees whose `.git` marker is a file, while pruning dependency/build residue and enforcing timeout and repository-count bounds. An incomplete discovery now persists an epoch-fenced degraded capture revision, announces its typed reason, and makes clients prefer live workspace data instead of presenting a misleading empty capture.
- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- faf1487: Add workspace-local, holder-fenced Codex subscription leases with deterministic
  fairness across worker replicas, explicit allocator eligibility, and
  failure-classified same-turn failover. All-exhausted active goals now persist one
  generation- and policy-fenced capacity waiter, wake from authoritative reset
  timers or revisioned capacity mutations, survive Temporal restart and
  continue-as-new, and enqueue at most one normal continuation without synthetic
  user messages, full-turn replay, provider/model rewriting, or automatic
  entitlement redemption.

  Expose a generic accepted-turn policy-scope and per-scope unavailable-diagnostic
  seam for future named pools while resolving exact live/frozen same-turn reuse
  before membership filtering. Preserve manual versus policy pin semantics and
  session-sharded cache affinity without moving an in-flight lease or the legacy
  workspace pointer for policy homes.

- 13d0889: Allow independent sessions to persist attempt-fenced work concurrently while preserving an exclusive workspace Pause boundary, and align the durable control constraint with workspace Pause.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- 4a25bfc: Connected Machines read OFFLINE immediately on a clean going-offline. When a machine announces a typed GoingOffline (user-stop / self-update / host-shutdown) it now records a nullable `went_offline_at` + `went_offline_reason` marker on its enrollment, and the liveness derivation gives an un-cleared marker precedence over last_seen aging AND over a lingering liveness probe — so the dashboard and any work-routing decision see the machine as offline right away instead of waiting out the dead-detect window. A lifecycle `revoked` status still trumps the marker, and any newer liveness signal (a reconnect Hello or a fresher heartbeat) clears it back to null. Adds the `setEnrollmentWentOffline` and `clearEnrollmentWentOffline` DB helpers, threads the marker onto `EnrollmentRecord` and the `selfhostedLiveness` input, and clears it inside `touchEnrollmentLastSeen`.
- 4a25bfc: Add the `machine.link.lost`, `machine.link.restored`, and `machine.runner.restarted` session-event types for Connected Machine control-link observability (the failure-visibility doctrine's link plane). These are session-scoped, announce-only diagnostics fanned out only to the sessions that had an active op running on the machine when its control link changed — never to idle or historical sessions. A clean going-offline emits `machine.link.lost` (plus `machine.runner.restarted` when the reason is a self-update restart), and a reconnect Hello that actually cleared a going-offline marker emits `machine.link.restored`. All three project to the timeline's quiet tier (no rendered item) and are mirrored in the SDK event-type list. Adds the `sessionsWithActiveOpOnEnrollment` DB helper (one indexed lookup, no per-op tracking table) that resolves the fan-out target set.
- e4d3569: Add per-member workspace session pins with stable pinned-first listing, subject-scoped FORCE-RLS persistence, snapshot-backed activity pagination, optimistic OCC-safe pin/unpin updates, and accessible responsive web controls.
- 810542f: Commit workspace capture announcements atomically with their revision rows and keep harmless late capture bookkeeping out of the user timeline.
- 5942493: Repair missing file-upload usage records on idempotent finalize retries, reclaim abandoned direct-upload objects through a fenced Temporal cleanup schedule, and preserve accessible provider-backed image previews across reloads.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- 9d4283d: Per-workspace model/provider hard-block policy. A new `workspace_model_policies` table (NULL = unrestricted) lets a workspace strictly allowlist which providers and/or exact model ids may serve its turns. Enforced twice: a 422 at every API model choke point (user message, queued-turn update, scheduled task, and session creation — where the EFFECTIVE model, `payload.model ?? deployment default`, is vetted, since an omitted model stamps the deployment default onto the session), and authoritatively in the worker immediately after turn model resolution, where a blocked provider/model throws `WorkspaceModelPolicyBlockedError` before any model call — including the legacy null-resolution fallback to the built-in OpenAI/Azure client, which is attributed to the built-in's own provider id so blocking the built-in also closes that path. Goal continuations that inherit a blocked model recover to the session's allowed default or pause the goal visibly with a truthful rationale. New `GET/PUT /v1/workspaces/:workspaceId/model-policy` routes (read / admin) manage the policy. Workspaces without a policy row behave exactly as before. This exists so a codex-subscription workspace can be fail-closed to codex: a turn may wait or fail loud, but can never fall through to a paid provider.
- Updated dependencies [ad4502a]
- Updated dependencies [ec508d4]
- Updated dependencies [58c78c6]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [faf1487]
- Updated dependencies [b125213]
- Updated dependencies [b804fd4]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [a0cb58f]
- Updated dependencies [e4d3569]
- Updated dependencies [5942493]
- Updated dependencies [726cf2c]
- Updated dependencies [a5f58f9]
- Updated dependencies [9d4283d]
  - @opengeni/config@0.5.0
  - @opengeni/codex@0.2.2
  - @opengeni/contracts@0.10.0

## 0.6.1

### Patch Changes

- Updated dependencies [1e7a243]
  - @opengeni/config@0.4.0

## 0.6.0

### Minor Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

### Patch Changes

- Updated dependencies [602db89]
  - @opengeni/contracts@0.9.0
  - @opengeni/config@0.3.0

## 0.5.0

### Minor Changes

- 7bfe593: Surface the desktop-capture-blocked reason as server-visible enrollment state.

  A machine can have a display it cannot CAPTURE (macOS Screen Recording / TCC not granted). The agent's connect Hello already withholds the desktop cell in that case; this persists a human, actionable reason alongside it so the Machines dashboard / VM picker can render "display: capture not granted" instead of a bare `display_unavailable`.

  - **Contracts / SDK**: `MachineView` (and `EnrollmentSummary`) gain an additive, nullable `desktopUnavailableReason`. Non-null only when a display exists but capture is blocked; `null` == capture permitted OR genuinely headless. Absent/`null` ⇒ byte-identical to today's shape for existing consumers.
  - **DB**: new nullable `enrollments.desktop_unavailable_reason` column (no backfill — `NULL` preserves the existing "capture-permitted or headless" semantics). The display-cursor writer now persists `has_display` AND the reason together, change-guarded on either field, and self-heals to `null` on the next Hello once the grant is restored.

### Patch Changes

- db468cc: Repair embedded-schema database migrations by re-granting `opengeni_app` table and sequence privileges in the active schema and setting schema-scoped default privileges for future objects.
- Updated dependencies [7bfe593]
  - @opengeni/contracts@0.8.0
  - @opengeni/config@0.2.6

## 0.4.1

### Patch Changes

- Updated dependencies [5ca067f]
  - @opengeni/contracts@0.7.0
  - @opengeni/config@0.2.5

## 0.4.0

### Minor Changes

- e513236: Add an optional per-session `instructions` field to `CreateSessionRequest`: a first-class, system-level agent persona lever composed AFTER the per-workspace `agentInstructions` (session-specific last, non-bypassable CORE preserved). It is org-visible session metadata (returned on the session record) but is never emitted as a timeline event, so hosts can deliver per-agent-type prompts without leaking prompt content into the user-visible timeline or weakening instruction authority. Absent ⇒ byte-identical to today's composition.

### Patch Changes

- Updated dependencies [dbe3a19]
- Updated dependencies [e513236]
  - @opengeni/config@0.2.4
  - @opengeni/contracts@0.6.0

## 0.3.0

### Minor Changes

- 15deca0: Add per-session third-party MCP servers with write-only encrypted headers, metadata-only responses/events, `mcp_servers:attach` permission gating, and per-message credential rotation.

### Patch Changes

- Updated dependencies [15deca0]
  - @opengeni/contracts@0.5.0
  - @opengeni/config@0.2.3

## 0.2.2

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/codex@0.2.1
  - @opengeni/config@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [548e307]
  - @opengeni/contracts@0.4.0
  - @opengeni/config@0.2.1

## 0.2.0

### Minor Changes

- 2170732: Publish the full Stage C `@opengeni/*` runtime closure to npm so external hosts can consume OpenGeni from published packages instead of vendored workspace tarballs.

  The release pipeline now builds every publishable package, rewrites every published `workspace:*` dependency to a concrete semver range, rewrites source entry points to dist entry points for every publishable package, and leaves only leaf-only non-runtime packages ignored.

### Patch Changes

- Updated dependencies [2170732]
  - @opengeni/codex@0.2.0
  - @opengeni/config@0.2.0
