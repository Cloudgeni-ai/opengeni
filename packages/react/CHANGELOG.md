# @opengeni/react

## 6.22.0

### Patch Changes

- Updated dependencies [d50092b]
  - @opengeni/contracts@6.22.0
  - @opengeni/sdk@6.22.0
  - @opengeni/connect@6.22.0

## 6.21.0

### Minor Changes

- 177e342: Hosts can replace the composer's full model picker with two or three named levels. Pass `modelPickerProps.levels` to `SessionConversation`, `NewConversation` or `OpenGeniChat.conversationProps`: each `ModelLevel` is a label, one catalog model, one reasoning effort and whether it offers Ultrafast. The composer then shows a small inline level control that people tap or swipe; Ultrafast can be offered on any level and takes a deliberate press and hold (or a push past the end of the last level), and shows its usage cost when it turns on. Omitting `levels` keeps the full picker, levels the workspace cannot run are left out, a new chat starts on the first level, and an existing chat on another model keeps it and shows its name until a level is picked. `ModelLevelPicker` and `ComposerModelPicker` are exported from `@opengeni/react` and `@opengeni/react/composer`, the renderer-neutral `modelLevelsView` and `modelLevelChoice` from `@opengeni/react/model-levels`, and React Native hosts get the same control as `ModelLevelControl` from `@opengeni/react-native/timeline`, with `onSelectionFeedback` for haptics and `startOnFirstLevel` for new-chat screens.
- ef4c334: - My things: each of your own logins has Remove, which removes it from every workspace after you confirm.
  - Connect cards: when turning an integration on waits for an admin to confirm with a passkey, the card offers that as its action. Hosts set it with `onAdminStepUp` on `SessionApp` (or `adminStepUp` on the app host); by default the Opengeni app's page for it opens, then Try again.
  - `site.ai.run` and `site.ai.result` take `waitForApproval: true` to wait through approvals and input requests and resolve with the final result once the person answers in Opengeni; `onWait` reports the wait. Without it a wait still resolves as `pending`.
  - Approval cards show each value of a small argument object (up to four plain values, such as an update's changed fields) on the card instead of a collapsed "1 field"; larger objects still open in Details.
- a19c047: Turn summary facets now learn when they see only part of a turn. `TurnSummaryContext.unloadedSteps` is true when some of the turn's steps are not loaded: before the turn is opened, until its earlier pages are read, and on a long live turn whose collapsed row keeps only its newest steps. A count over `items` or `toolCalls` is then too low and can go down while the turn runs, so a facet can omit it or show it as a lower bound. The signal reaches every turn row, in both the readable and the classic presentation, on web and React Native. `@opengeni/react/timeline-model` adds the helpers that renderers use for it: `timelineTurnsWithUnloadedSteps`, `activityHasUnloadedSteps` and `turnGroupHasUnloadedSteps`.

### Patch Changes

- 6ac2cd4: A Site that uses a connected account now works for everyone who opens it. Publishing a Site that calls the publisher's own account (as an agent sees it) also declares that connector, so another viewer runs the call on their own account, or gets the Connect card when they have none, instead of `API 404: tool_unavailable`. A Site published before this that still points only at another person's account answers with `details.code` `site_tool_not_available_for_viewer` and a message saying to publish it again; the Site receives that code instead of a bare unavailable tool.

  For an agent, the publisher's accounts are its turn's own account routes, and the publication accepts the connector declared alongside each of them. A retry with the tools as originally declared replays the same publication. A list that pairing would push past the 128-tool limit is refused with a message, instead of being left working only for the publisher.

  When a Site's tool call can't complete, the viewer now sees a clear state in the Opengeni frame instead of a raw error such as `API 404: tool_unavailable`, and the Site receives a typed `code` it can read: Reconnect for an account whose sign-in stopped working (`site_tool_reconnect_required`, signing in to that same account, personal or shared; a call Opengeni refused before sending it then runs again, while a provider's result asking to sign in again is returned for the Site to call again), a plain refusal that names the system for a provider's permission error (`site_tool_permission_denied`, e.g. "Microsoft Dynamics didn't allow this for your account."), a message asking the Site owner to publish again (`site_tool_not_available_for_viewer`), and a readable message for anything else (`site_tool_unavailable`). Try again is offered only when Opengeni confirms the call ran nothing and the refusal isn't definitive, and it reuses the same operation id. A dropped connection, a 5xx or an untyped error on a call may have run, so it says to check before trying again (`site_tool_outcome_unknown`) and is never run again. The original error stays behind Details. Calls that fail the same way at once share one message. `createSiteToolBridge` takes `recoverToolCall` for this host UI and exports `SiteToolCallFailedError`; Site consent accounts carry the viewer's `connectionId`, `capabilityId` and whether it is `shared`; a tool call that needs its connection signed in again carries `structuredContent.error.code` `connection_auth_needed`, and the Dynamics bridge marks Microsoft's permission refusals `provider_permission_denied`.

  For Site authors: a failed `site.tools` call now rejects with one of the `site_tool_*` codes above. The original code (`not_found`, `upstream_unavailable`, `tool_connection_needs_attention`, ...) stays readable on `error.details.code`. A provider's error result is unchanged (its `content` and `structuredContent.error`) and gains `structuredContent.siteToolFailure` with the typed code and the viewer's sentence. `OpenGeniSiteBridgeError` has an optional `details`.

  Microsoft Dynamics connections are personal by default but can now be shared with the workspace: the connect card offers "This workspace" and the API no longer refuses workspace ownership. Everyone then acts with the sharing person's Dynamics security roles.

  The generic Microsoft Dynamics catalog entry now reflects environments already added to the workspace. When one is usable in the chat, `capability_catalog_search` and `capability_authorization_request` report it as ready and name it, instead of asking for an environment address. When the only one still needs the person's sign-in, the request shows that environment's own Connect card.

  A Dynamics 365 (Dataverse), Business Central or Finance and Operations connector's tool permissions now list the tools agents actually run through Opengeni's Web API bridge, instead of asking the environment's hosted MCP server, which failed with "Could not load the connector's tools" when the environment doesn't allow that MCP client.

  The Connect card keeps showing a connection as done after a reload or account switch when the chat already uses it, and setup card results tell the agent the chat continues on its own once the person finishes.

  - A prepared key setup (an agent's proposed MCP server) now lets the agent continue the request once it is connected, as other setup cards do.
  - A confirmation dialog opened from a form field (such as "Make this person a workspace admin?" in Add people) no longer also submits the form behind it, which added the person with the role chosen before the confirmation.
  - When a Site conversation starts waiting for the person, such as an approval from the Site's own `ai.run`, the Site's chat panel opens it.

- Updated dependencies [7d0d52b]
- Updated dependencies [ef4c334]
- Updated dependencies [ce864c0]
- Updated dependencies [6ac2cd4]
  - @opengeni/contracts@6.21.0
  - @opengeni/sdk@6.21.0
  - @opengeni/connect@6.21.0

## 6.20.1

### Patch Changes

- @opengeni/connect@6.20.1
- @opengeni/contracts@6.20.1
- @opengeni/sdk@6.20.1

## 6.20.0

### Minor Changes

- 60a33cb: A compute sandbox is deleted a day after every chat that works in it is archived.

  - Archived chats no longer keep their sandbox in storage forever. A chat restored within a day of archiving keeps its sandbox. A chat stored automatically after weeks unused loses its sandbox at once. A sandbox shared by several chats stays while any of them is live, and a chat with work under way keeps its sandbox.
  - A chat restored later continues on a new sandbox. Its timeline says the old one was deleted, and the agent is told on its next turn that the old files are gone.
  - New message key: `timeline.projection.sandboxDeletedWhileArchived`.

### Patch Changes

- ed6b66c: Connecting an integration in a shared workspace with your own login already added in another workspace now turns the integration on here, instead of saying the authorized account doesn't match. When the integration isn't set up here yet and you already have that login, the card offers to use it here instead of signing in again.
- ae3972e: The Microsoft Dynamics connection now supports Dynamics 365 Business Central. Paste the Business Central web client address (`https://businesscentral.dynamics.com/<tenant>/<environment>?company=…`) and sign in; one connection covers every company in the environment. Agents list companies and entities, query with OData, create, update and delete records and run actions such as posting, through the Business Central API (v2.0) as the signed-in user. Changes ask first by default.
- Updated dependencies [c624443]
- Updated dependencies [ae3972e]
- Updated dependencies [e37485b]
- Updated dependencies [9c17a87]
  - @opengeni/sdk@6.20.0
  - @opengeni/contracts@6.20.0
  - @opengeni/connect@6.20.0

## 6.19.0

### Patch Changes

- 1e29039: An admin change refused because a passkey confirmation is still needed now says to confirm with a passkey (or add one) instead of "You don't have permission to do this". This is what shows when the person closes the passkey prompt. The admin passkey step-up now covers only changes to who can access an organization and its data: members, roles and invitations, creating API keys, and shared connections.
- 973329a: Chats that share one sandbox (a parent and its workers) now each keep their own personal GitHub pass, broker routes and `gh` setup, so Git and `gh` in one chat no longer fail with "authorization is no longer current" after another chat on the box ran. The repository remote stays `https://github.com/<owner>/<repo>`, no token enters the sandbox, renewal updates only its own chat, and chat directories unused for a day are removed.

  A personal repository resource that also carries stray GitHub App fields is accepted with those fields ignored (access is still checked as the person), and a request without a running agent attempt now says so instead of asking to reconnect GitHub.

  Repairing an uninstalled GitHub App installation while GitHub can't be reached now says "GitHub couldn't be reached" with **Check again** (the API answers 503 `provider_unreachable`) instead of opening the account chooser. When a reinstall replaces the old installation, its approval choices move to the new one with their original setter, and the old installation's rows are removed.

- b349ca0: A durable Send refused for good is now kept as the composer draft until it is removed, restored or delivered, so closing the page no longer loses it. It never overwrites a newer draft from another device. A kept send also survives the composer remounting in the same page. The composer no longer re-reads its draft on every host render while a delivered message waits for its turn: it now reads the latest `onSent`/`onSubmitted` through refs, and re-reads only when a new admission arrives.
- 226fe73: A durable Send that gets no definitive answer (the connection drops, or Opengeni is updating) now keeps its message as the draft, so it survives closing the page and shows on the person's other devices, as it did when every Send saved the draft first. Before, a message typed and sent within the autosave pause was in no draft, and closing the tab before the send went through lost it. The draft is written only while it is still at the revision the Send went ahead from, so it never brings back a message the server already accepted and never writes over another device's newer draft. When the Send lands later, the server clears a draft holding exactly what it sent.

  An accepted Send now always moves the draft past the revision it went ahead from, also when nothing was ever saved: it creates an empty draft at revision 1 instead of leaving none.

- Updated dependencies [a85adef]
  - @opengeni/sdk@6.19.0
  - @opengeni/contracts@6.19.0
  - @opengeni/connect@6.19.0

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

- 3bc721a: A chat waiting for Codex subscription capacity now waits honestly and wakes on real capacity. Before a waiting turn is judged, the waiter re-reads both usage and every account's live model list, so it judges the same pool the resumed turn will be placed on: it no longer resumes a turn only to have it park again a second later, and the expected time it names is the reset of an account that actually offers the turn's model (and latency tier), or no time at all when none is known. A waiting turn no longer fails after ten resumptions with text only an operator could act on; it keeps waiting, with the existing backoff between resumptions. The chat and the inbox notification now say the message will be answered as soon as there is room, and that switching to another model continues sooner.
- 3b8f7da: A message sent while the agent is working (Send under `busySend: "steer"`, or Steer) now leaves the composer in the same frame it appears in the timeline. Before, the text stayed in the box until the server answered, about one to two request times later. The send also makes one request instead of two: with durable drafts it no longer saves the draft before submitting, because the submit carries the full message and the draft revision it went ahead from, and the server keeps a newer draft from another device on its own. A save still goes first only when this page has a draft write that got no answer, when the message carries a model, effort or speed pick the saved draft does not hold yet (the chat adopts a pick only from the saved draft), or when an older server refuses the send with "draft changed" (then it saves and resubmits once under the same client event ID, and remembers to save first).

  A send refused for good puts its text, files and notes back in the box when nothing new was typed meanwhile; otherwise the new typing stays and the message waits in the timeline with Retry and Restore. An unconfirmed send stays in the timeline and its retry repeats it with the same key. A queued Send that fails no longer lets autosave write its emptied box over another device's newer draft.

- d83e5f2: When an admin must confirm with a passkey before turning on an integration, the connect card now asks them to add or confirm a passkey. It used to say only an admin can turn it on, which was wrong for someone who is already an admin.
- a16189c: Slack replies no longer show Opengeni links as raw Markdown. An image or link to an artifact (`![Preview](artifact:<id>)`, `[deck](artifact:<id>)`), a chat (`session:<id>`) or a console path now becomes a Slack link to that page in Opengeni, and a `sandbox:` path becomes its label. A clickable thumbnail links with its alt text. Markdown tables become an aligned code block, with each link in a cell numbered and listed under it. Operations an earlier release bound to other bytes keep them on retry. The console's file page opens a Site when an `artifact:<uuid>` link names one, since Sites share the UUID format.

  Native app push registration now says why a deployment can't deliver to the app. `PUT /v1/native-app/push-device` answers 409 with `details.code` `native_push_unavailable` (`NATIVE_PUSH_UNAVAILABLE_DETAIL_CODE`, `isNativePushUnavailableError` in the SDK) when the app ID isn't in `OPENGENI_NATIVE_APP_IDS` or the platform has no push credentials, instead of a bare 400, or of accepting a registration that would never get a push. The iPhone app shows "This server isn't set up to send notifications to this app." instead of "Try again", shows a failed calls change under Calls from agents, and reports its APNs environment from its signing profile, also when it re-registers rotated tokens in the background (it re-registers a stored registration for the wrong environment too).

  The iPhone message field grows with its text again, up to six lines (four with large text on a small screen, and never more than half the room above the keyboard) before it scrolls. On the new architecture iOS reports a field's content size only when its layout changes, so the fixed height the composer set from it never grew past one line and earlier lines scrolled out of view.

- 73c3e82: A message sent as a Steer while no turn was running now stays above the turn it starts. When a later Steer handed that turn over at its next model step, the timeline moved the turn's work and messages above the first message, so the person's question read as if it came after its own answer, both live and after a refresh. Only Steers drawn while a turn is actually running now wait for that turn's handover.
- 89cf4ba: `FormDialog` takes `aboveOtherDialogs`, which shows the dialog and its overlay above every other open dialog, including the chat's connect dialog.
- Updated dependencies [f313a0e]
- Updated dependencies [6813960]
- Updated dependencies [9188c1d]
- Updated dependencies [3105a8b]
- Updated dependencies [a16189c]
- Updated dependencies [89cf4ba]
  - @opengeni/contracts@6.18.0
  - @opengeni/sdk@6.18.0
  - @opengeni/connect@6.18.0

## 6.17.0

### Minor Changes

- b1b69fc: The console now sends a strict, enforced Content-Security-Policy: `default-src 'self'`, scripts only from the console and the exact hashes of its inline bootstrap scripts, `object-src 'none'`, restricted `base-uri` and `form-action`, `<style>` elements only with a per-response nonce (stamped by a hashed bootstrap script) and inline style attributes only through `style-src-attr`, and exact hosts (never `*` or a bare scheme) for storage, analytics, sign-in avatars, catalog logos, Turnstile and the Sites frame host, read from the deployment's API configuration (`GET /v1/config/content-security`). Office add-in pages get the same policy with Office's framing hosts and script hosts.

  Agent-authored HTML (chat visualizations, HTML artifacts and Sites in the console) now renders in an opaque-origin sandboxed frame of a small frame-host page (`https://og.<sites domain>/_og/html-frame`, served by the Sites gateway, or `/_og/html-frame` on the console without a Sites domain) instead of a `srcdoc` frame, so it keeps running under its own policy with the same sandbox flags. `@opengeni/contracts/html-frame-host` exports the frame-host protocol; `@opengeni/react/artifacts` exports `configureContentHosting`, `ContentHostingConfig`, `displayImageSrc`, `useDisplayImageSrc` and `setImageProxyTicket`. Without configuration, embedders keep the previous `srcdoc` frames and direct image URLs.

  Images from origins the policy does not list load through the new signed-in image proxy (`GET /v1/image-proxy?url=`), which fetches only public HTTPS raster images with SSRF protection on every redirect, a size cap and a deadline, and answers them inert (SVG only under a sandbox policy). The Excel add-in, which signs in with a bearer token, appends a short-lived signed ticket from `GET /v1/image-proxy/ticket`. The GitHub connection pages allow form submissions to redirect to `https://github.com`. The API's own HTML pages (GitHub connection, MCP OAuth consent and admin-consent pages) now allow their inline scripts and styles by hash instead of `'unsafe-inline'`.

### Patch Changes

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

- d189da5: Integration OAuth (MCP connectors such as Gmail, and built-in provider integrations) now finishes only in the browser that started it. A start from a signed-in browser sets a short-lived HttpOnly binding cookie (host-only `__Host-` on https) whose hash is signed into the state. A desktop-app or native-app start finishes only where the same person is signed in. Any other callback is refused as `browser_mismatch` before anything is exchanged or saved, so a consent link sent to someone else can no longer connect their account to the sender's workspace. Connect attempts started by a signed-in person may return only to this deployment's own origins (published Sites are not trusted). Host products using their own keys or delegated tokens are unchanged.
- a4ef243: A new chat whose creation is refused now says why. When `createSession` rejects with a definite refusal of its input or state (an `OpenGeniApiError` with status 400, 409 or 422 and `outcomeUnknown: false`), the stock new chat shows the refusal's own reason, such as a speed or model that isn't available, instead of the generic "The request could not be accepted" copy. Permission and missing-item refusals (403, 404) keep their neutral copy. Typed refusals keep their worded copy, and a host endpoint's `{ error: "…", code, details }` body is read as well as Opengeni's own `{ code, message }`. The host's `formatError` receives this reason as its default message, so a host formatter that returns `undefined` for errors it has no copy for shows it too. The draft stays and Send stays available, and changing the model, speed or effort clears the stale reason. Failures whose outcome is unknown (network loss, 5xx, `outcomeUnknown: true`) keep the exact-retry state unchanged.
- e3cb3c1: Your GitHub accepts repository owners whose logins contain an underscore, as enterprise managed users' do (`octocat_acme`). Choosing, searching, attaching and using such repositories now works everywhere personal GitHub checks an owner: the repository chooser and its stored selection (migration 1370 widens the database check, 1371 validates it), a typed repository URL in the chat's repository picker, agent-created workers and schedules, the `gh` gateway, the account repository tools and the repository identity shown to the agent. Owners still need 1 to 39 letters, digits, `-` or `_`, starting with a letter or digit. The documentation also states that a schedule an agent saves with Your GitHub repositories runs as the person only while those repositories stay in their chosen list (or All my repositories) and the account stays connected, and never falls back to the workspace's GitHub app.
- 389de66: Signing out no longer leaves a person's unsent meeting and dictation recordings on the device. When recordings of theirs are still uploading, the console, the desktop app and the mobile app first ask whether to wait for the upload (they stay signed in) or discard the recordings and sign out; with nothing pending, sign-out is unchanged. Where nobody can be asked, such as a sign-out from another tab, the recordings are discarded. Signing out of one browser account removes only that account's recordings; the last account, or signing out of all, removes every one.

  For apps: stored recordings can carry an `ownerId` (`RecorderOptions`, `UploadRecordingAudioOptions` and `useRecorder`), which `localRecordingsOf` and `discardLocalRecordingsOf` use, and `useRecorder` finishes only its owner's recordings when it mounts. `prepareRecordingsForSignOut` (from `@opengeni/react/recordings` and `@opengeni/react/meetings-recorder`) runs the check before a sign-out, with `setSignOutRecordingsPrompt` for the question. On phones, the `opengeni-recordings` folder is kept off iCloud backups, the recording config plugin keeps it off Android backups and device transfers, and `forgetRecordingStore` deletes an account's folder.

- Updated dependencies [8073ab6]
- Updated dependencies [43aa19d]
- Updated dependencies [b1b69fc]
- Updated dependencies [deccb54]
- Updated dependencies [668c5ed]
- Updated dependencies [e3cb3c1]
- Updated dependencies [389de66]
- Updated dependencies [42ef2a2]
- Updated dependencies [241ce71]
  - @opengeni/contracts@6.17.0
  - @opengeni/sdk@6.17.0
  - @opengeni/connect@6.17.0

## 6.16.0

### Minor Changes

- 55058af: The blocked-message notice reads more simply.

  - A paused machine owner gets one line, "Allow it for this chat. Your message starts when the chat is resumed.", instead of "starts right away" next to a separate paused note.
  - When other people in the workspace can see the chat (workspace visibility, outside a Personal workspace), the owner learns that allowing the machine lets them see what the agent does on it. On web the composer's shared-machine heads-up steps aside while this shows.
  - "Your message is saved" is gone from every state, since the message is already in the chat. After the chat moves to a machine it can use, the notice shows "Starting on the new machine" and "The message starts by itself." The machine picker's note for a waiting message keeps only "Use a workspace or cloud machine for this message."
  - Every "starts" line names the message: "Your message…" only in the machine owner's own lines, and "The message…" wherever someone else may be reading. The permission line says who can fix it first, and the machine-access lines drop "right now" and "You can".

  API changes:

  - `SessionAdmissionNotice` takes `sharedChat`. `useSessionStart` returns `sharedChat` while the owner is asked to allow the machine, reading the workspace kind through `getWorkspace` when the client has it; it is false otherwise and while the kind is unknown.
  - `sessionAdmissionMachineAccessCopy` accepts `paused` and `shared` options.
  - New message keys: `sessionAdmission.machineAccessOwnerPausedNext`, `sessionAdmission.machineAccessOwnerSettingsPausedNext` and `sessionAdmission.machineAccessSharedNote`. `sessionAdmission.machineChangedBody` is removed; drop it from custom translations.
  - `sessionAdmissionMachineChangedCopy` now returns an empty `next`. Skip rendering an empty `next`.

### Patch Changes

- fb19875: Approval cards now read in the host's words and language. A saved review carries codes beside its English text: `reasonCode` for why it asks or is blocked, `approveLabelCode` when the button is the plain "Approve action" or "Allow", `toolName` for the action, and per field the argument it stands for (`key`) and a plain yes or no (`booleanValue`). The card, the approval list, the step in the chat (`toolDisplayName`) and the history line after a decision word these through the host's `messages`: `approvalSurface.approveAction` and `approvalSurface.allow` for the button, `toolActionReview.reason.*` for the reason, `toolActionReview.yes` and `.no` for yes or no values, and new host keys to name a connector's actions and fields the same way as `connectService.<id>.name`: `toolAction.<toolName>.title`, `toolAction.<toolName>.field.<argument>` and, for every tool, `toolField.<argument>`. Without host words nothing changes.
- Updated dependencies [fb19875]
- Updated dependencies [54dc5da]
- Updated dependencies [86e5358]
  - @opengeni/contracts@6.16.0
  - @opengeni/sdk@6.16.0
  - @opengeni/connect@6.16.0

## 6.15.0

### Minor Changes

- 3bab763: `ConnectPanel` now keeps the organization approval help up when a sign-in comes back cancelled or denied with an administrator approval link stored on the attempt, for example after someone leaves Microsoft's "Need admin approval" page with Cancel or "Return to the application without granting consent". It used to treat the cancel as finished and quietly go back to the service list. The help offers the message for IT, the approval link, "Try signing in again" (a fresh setup for the same service unless the host passes `onRetry`) and "Back to connections". A plain cancel that stores no approval link still closes quietly.

  `ConnectPanel`, `ConnectChooser`, `ConnectAccounts` and `ConnectionDiscovery` accept `finishInPopup`. Set it when your `onAuthorize` opens the provider's sign-in in a popup: the popup then ends on a small page that closes itself instead of loading your return URL, a second copy of your app, inside it. The closing page now says "Go back to where you started to continue" rather than naming the chat.

  Once a service connects, older unfinished setups by the same person for the same service, owner and destination no longer appear in the pending list (`GET /v1/workspaces/:workspaceId/connect/attempts`), so a host's "continue setup" entry for that service goes away. Custom connections (MCP servers, OpenAPI and GraphQL sources) share one provider ID across different services and are never hidden this way.

  The page a sign-in popup ends on and the page an administrator sees after the Microsoft approval link can now use the deployment's language: set `OPENGENI_CONNECT_RESULT_PAGE_TEXT_JSON` (fields `lang`, `signInFinishedTitle`, `signInFinishedBody`, `adminApprovedTitle`, `adminApprovedBody`, `adminNotApprovedTitle`, `adminNotApprovedBody`, `closeWindow`). Any field left out stays in English. `@opengeni/config` exports `parseConnectResultPageTextJson` and `ConnectResultPageTextSchema`.

- 9b75ec0: The new-chat page now asks "What can I help with?" for everyone, with "Ask anything, or describe what you need…" in the text box. It used to say "What should the agent do?" to everyone who didn't choose everyday help at sign-up. The suggestions under the composer still follow that answer, but only people who chose to build or run agents get the developer suggestions; people who skipped the question or signed up before it existed now get the everyday ones. The project picker and model stay where they were.
- f92ff08: The GitHub integration page is compact. Each Opengeni app installation is one row: a healthy one shows its account type and repository count with **Change repositories**. One that is not active shows a status in the attention colour ("Uninstalled on GitHub", "Suspended on GitHub", "No repositories", "Not checked", "Account changed" or "Needs authorization"), one sentence on what is wrong, and the one action that fixes it (Reinstall, Unsuspend on GitHub, Choose repositories, Check again, Remove or Authorize). Remove sits in the row's ⋯ menu. Approvals come before the repositories and are one table: rows are the three kinds of action, columns are the Opengeni app and Your GitHub, and an **All actions** row sets a whole column at once. Per-installation choices sit behind **Advanced**, and one footnote replaces the repeated text. A long repository list folds behind its count with a search field. The page opens with a one-line summary naming the installation that needs attention ("The Opengeni app was uninstalled from benyhh on GitHub."); its row keeps the one fix. Repair opens a dialog that names the installation and the fix, and Connect starts at that installation: `reconnectAccountId: "github-installation:<id>"` on a `github-app` attempt goes straight to installing the app again when it was uninstalled, or to the owner's sign-in otherwise, instead of the account chooser. If GitHub can't be asked, it starts at the account chooser. A reinstall replaces the binding it repaired and carries its approval choices over. `NativeConnectSetup` no longer resumes another account's pending reconnect for a new connection, and a resumed reconnect offers **Start over** instead of "Connect a different account".

  GitHub installation bindings carry an optional `issue` (`GitHubInstallationIssue`: `uninstalled`, `suspended`, `no_repositories`, `owner_unconfirmed`, `github_unreachable` or `account_changed`) that says why an installation is not active, in terms of its fix. It is null while active, and older servers omit it. The integration view model adds `IntegrationSection.rows` and `statusTone`, `IntegrationViewModel.policies` (an `IntegrationPolicyTable`) and `IntegrationAccess.collapsed`. `NativeConnectRequest.title` replaces the "Connect …" heading; with a description, the setup leaves out its generic connection summary. `ConnectSetup` takes `explained` to do the same, and a `DetailSection` action now wraps under its title on narrow screens.

- bf804ef: Chats created with an API key are now labelled by the key's name with an "API key" hint in the sidebar's creator groups and hover cards (for example "Codex operator 2026-09-11 · API key") instead of a raw principal id, and other services show a "Service" hint; a key or service without a name shows just "API key" or "Service", never an id. An API key's chats form one group (people and services keep their exact frozen kind) even when older chats recorded the key as a subject and newer ones as a service, keys that share a name are told apart by a number, and an API key never gets a person's initials chip. On the Schedules page, a schedule owned by an API key shows a bot icon instead of initials, and "API key" instead of the raw key id when the key has no name. How people are shown is unchanged.

  The session list API accepts `createdBySubjectId` without `createdByKind`, matching every session that subject created whichever kind it was recorded as; `createdByKind` alone is still rejected. The SDK's `listSessionPage` `createdBy.kind` is now optional to match, and `@opengeni/db` session list filters accept a creator without a kind. Requests that send both keep their exact behaviour.

### Patch Changes

- 7d6e488: Android 14 and later: agents' calls can ask for the full-screen notification permission they need to ring over the lock screen. Play pre-grants `USE_FULL_SCREEN_INTENT` only to calling and alarm apps, so in other apps a ring was only a heads-up notification and nothing told the person why. The Android call module now reports `fullScreenRing` in its capabilities and can open the app's full-screen notification setting (falling back to its notification settings). The call adapter exposes this as `incoming.canRingFullScreen()` and `incoming.openFullScreenRingSettings()`, absent on iOS and older builds, where rings always show full screen. The new `useFullScreenRings(callAdapter)` hook keeps the answer current as the app returns to the foreground and has `ask()`, which explains the setting in an alert and offers to open it, for hosts to call when the person turns agent calls on. `@opengeni/react` adds the default English text for that prompt.
- 60d067d: Claude subscription usage now matches what Claude reports today. The usage refresh reads the account's limit reset grants (presenting Claude Code's CLI surface, which Claude requires for them) and, while at a limit, the at-limit reset program. `ClaudeSubscriptionUsage` gains optional `limitResets`, `wallReset`, `limits`, `extraUsage`, `surfaceWindows` and `serviceState`, and the SDK exports their types. The account page lists each grant with what it clears, resets left, expiry and whether it can be used now. `@opengeni/db` adds the adapter-level claim and claim-then-refresh helpers (idempotent request ids); Opengeni never claims a grant on its own.

  The weekly limit model responses call `seven_day_overage_included` is treated as the weekly Fable limit: it limits Fable models only and shows as "Fable week". Responses served in the slow tier or grace zone mark a connection constrained (`SubscriptionQuota.constrainedUntil`): it still serves, but placement prefers accounts with plain capacity, and busy slow-tier slots are a short rate limit rather than the weekly limit.

- bf236a6: Replayed Claude thinking no longer breaks a chat. Claude's signed thinking now follows the same replay policy as OpenAI encrypted reasoning: each block records the binding it was issued under (platform, account, model and, for prefix-bound models such as Opus 5.5, the system prompt), and a request under any other binding replays it as readable historical reasoning instead of a signature Claude would refuse. This covers system prompt changes between turns (for example a repository Skill added mid-chat), model, account and transport switches, and works on every Claude transport. History stored before this change stays native until Claude refuses it. A refused replay never fails the turn: the request is sent once more with the refused blocks as readable text (remembered for the provider), and if Claude refuses that too, once more with plain history that carries no opaque provider state. Each fallback is recorded for operators as a thinking-blocks-dropped reason and is never shown to the person.
- da60317: Source links in answers no longer carry the tracking that OpenAI's hosted web search adds to the pages it finds: `utm_source=openai` (or a ChatGPT value) and `_t_q`, the search query that found the page. Chat timelines (web, desktop and mobile), copied text, the opened-page line of a web search, the notification inbox, phone push text, Slack and Teams now show the clean link; the page's own parameters, the fragment and code stay exactly as written. Only links carrying the provider's `utm_source` value are changed. Stored history and anything sent to the model keep the links as the model wrote them, and a Slack message an earlier release already started keeps that release's bytes on retry. `@opengeni/contracts/citation-urls` exports `withoutProviderTracking` and `withoutProviderTrackingInText` for other surfaces, such as products that render the raw chat stream.
- 1f2a7d0: Desktop dictation now says when the speech service is out of credit, or the model isn't available in the workspace's region, instead of "Dictation couldn't start".
- ef25cae: Show a failed turn's error once, in the failed banner next to Retry. The work header says only "Failed", an attempt replaced by Retry becomes a quiet "Attempt failed · retried" row with its text behind the disclosure, and the "failed" and "work resumed" dividers no longer repeat a turn's own failure. The banner keeps the full recorded text behind Details. Without a banner, the turn's row or the failure's own notice shows the text once.
- 2107e6f: Removing a duplicate login no longer leaves a connector saying "Sign in again" next to a working account. A connector's status now follows the person's accounts that still exist: a working one first, then one that needs signing in again; a removed login no longer counts. When only removed logins are left, the connector offers Connect instead of a Reconnect that could never succeed. The same applies in chat: a connector card no longer refuses with "More than one personal account matches" because of removed duplicates; it reconnects the person's one remaining login, or connects a new one when none is left.

  The OAuth client no longer counts as part of an account's identity. A login made before a deployment replaced its OAuth client (for example its Google client) is still recognised as the same account: connecting again reuses it instead of saving a duplicate, and reconnecting it no longer fails as a different account. Migration 1362 merges the duplicate personal Slack, Gmail, Google Calendar, Google Drive and Atlassian logins that were saved under different clients, using migration 1226's rules (same person, server, authorization server and verified account; the kept login must hold every scope of the merged one; logins that something depends on, now including Slack agents, are left in place). Of two working logins it keeps the one that refreshed most recently, so a login on a retired client is no longer kept over one that has refreshed since.

  Gmail no longer sends `include_granted_scopes`. Gmail, Google Drive and Google Calendar share one Google client, so Google's consent screen listed the person's earlier Drive and Calendar grants, and the Gmail token carried them. Gmail now asks for and holds only Gmail access. Connecting Gmail, Drive or Calendar shows Google's account picker, and reconnecting an account names it to Google, so Google no longer signs in whichever account the browser used last.

- 060c983: A sub-agent failure that its parent agent has already received no longer shows a red dot or an "unread failures" count on the parent's sidebar row, hover card, project totals or Needs you, and nothing the failed session logs afterwards counts as unread there either. Failures nobody took on still show: a top-level chat that fails, a failure whose notice its parent has not consumed, or a sub-agent that fails again after a retry. Sessions carry a new optional `failureHandled` flag.
- 6a5023d: Videos can be attached from a phone. The Expo photo library offers photos and videos, and the camera records video as well as taking photos (iOS; Android's camera stays a photo camera). Library videos keep their original file, so nothing is re-encoded before sending. The composer shows a video as a tile with its length and the upload's percentage, and a sent video shows in the timeline as a video chip that opens in the system player. The agent receives it in its sandbox like a file uploaded on the web.

  Every picked file now uploads straight from disk through Expo's native upload task, which reports progress and keeps going while the app is in the background, so a long video never has to be read into memory. Files up to 20 MiB are still hashed on the device; larger ones upload without a client digest, as a plain REST upload does. Removing an attachment, or leaving the chat, stops its upload. Hosts with their own adapters can opt in through the new optional `NativeFileAdapter.uploadSource`; without it files are read into memory as before.

  `uploadFile` in the SDK accepts a `FileUploadSource` as `data` (`{ sizeBytes, send(target) }`) for callers that send the bytes themselves, and an optional `signal` that cancels the upload.

- 02ac654: Files attached in a private embedded chat are now the uploader's own (Only me), as in the Opengeni web app, instead of workspace files. The stock conversation hooks (`useSessionConversation`, and `useOpenGeniNativeSession` in React Native) pass the chat's upload scope, and `createSessionProxyHandler` adds `scope: "personal"` to an upload that names no scope unless `chats` is `"shared"`, so older or custom browsers get the same default. An explicit `scope` passes through unchanged, and shared chats keep workspace files. `uploadScopeForSession` is exported for custom layouts that call `useFileAttachments` themselves. `useNativeFileAttachments` takes an optional `scope`. Like any Only me file, these are read as their owner (`asUser`) or by the chat's agent; a server-key-only read no longer lists them. Files uploaded this way before the change stay workspace files.
- 2405d05: Saving a file from the browser works reliably in Firefox. Downloading a retained artifact, downloading a published file from the chat timeline, exporting an editable spreadsheet, document or presentation, exporting Site data and exporting an agent now share one save step that attaches the download link to the page for the click and keeps the file's object URL alive for 60 seconds. Before, most of these paths revoked the URL right after the click, and Firefox could fail the download even though the file had been fetched in full.
- 2a7d92d: Send refusals and chat status lines no longer end with "Your message is saved." (or "Your message and attachments are saved."). The message is already visible in the chat or the composer. This covers model, repository, speed, billing, usage-limit and Site-assistant refusals, the provider-retry notice, and the "Unable to start yet" and "No agent turn is running yet" lines. The connector-account refusal now ends "then edit and send your message." `COMPOSER_MODEL_UNAVAILABLE_MESSAGE`, `COMPOSER_ACCOUNT_UNAVAILABLE_MESSAGE` and `COMPOSER_SESSION_USAGE_LIMIT_MESSAGE` carry the shorter text. A refusal restored from storage in the earlier wording is still recognized.
- 294b9d9: Signing out now leaves nothing of the person's in the tab: unsent messages and answers (in memory and in session storage) and every other per-person Opengeni session-storage entry are cleared, both on sign-out and when the last browser account signs out. Entries that hold nobody's content (reload guards, the "signed in as" notice and an invitation being carried across a change of account) are kept. Successful sign-out responses also send `Clear-Site-Data: "cache"`. Cookies and storage are not cleared that way, so embedding hosts keep their cookies and meeting recordings that have not finished uploading are kept.
- 850b4d5: When a model refuses encrypted reasoning that another model or account left in the chat, the failed-turn banner now says "This model can’t read earlier reasoning in this chat." and points at the model picker, instead of "The session stopped unexpectedly." Retry stays, and the provider's exact text stays behind Details. The runtime's recovery and the banner share one rule for recognising this refusal (`@opengeni/contracts/encrypted-reasoning-refusal`).
- Updated dependencies [708848c]
- Updated dependencies [5525e63]
- Updated dependencies [60d067d]
- Updated dependencies [da60317]
- Updated dependencies [f92ff08]
- Updated dependencies [060c983]
- Updated dependencies [bf804ef]
- Updated dependencies [dfeab20]
- Updated dependencies [6a5023d]
- Updated dependencies [02ac654]
- Updated dependencies [b0fce89]
- Updated dependencies [9885d37]
- Updated dependencies [f22647a]
- Updated dependencies [7a83f9b]
- Updated dependencies [850b4d5]
  - @opengeni/contracts@6.15.0
  - @opengeni/sdk@6.15.0
  - @opengeni/connect@6.15.0

## 6.14.0

### Minor Changes

- c976c87: Agents have one text, their Instructions: First message is gone from the agent editor, the agent page, export, `bot_template_save` and the docs. The editor is icon, name, what it helps with, Instructions, Remember across chats and who can use it. Starting a chat with an agent (`?agent=`, or an older `?botTemplateId=` link) selects it and leaves the composer as it is.

  Nothing is dropped or migrated. Every read joins an existing First message after the Instructions as its own paragraph, led by "When a chat starts:" so one-time setup stays for the start of a chat (`agentInstructionsWithFirstMessage` in `@opengeni/contracts`, `agentInstructionsSql` in `@opengeni/db`), so the editor, the API, Slack and a chat's agent layer all see the same text, and a chat with such an agent now follows it as part of its Instructions. The next change to the agent stores the joined text with an empty First message, unless the two together pass the 20,000-character limit, when both are kept as they were; the editor then saves other changes and asks to shorten the Instructions only when they are edited. The legacy `bot_templates` and `slack_agents` rows copy what is stored, never a cut text, so an older server writing them back during a rollout loses nothing. `Agent.firstMessage` is always empty and `hasFirstMessage` false; the fields stay for older clients. `firstMessage` on create and update, `bot_template_save`'s `firstMessage` and `setupInstructions`, and `/bot-templates` `setupInstructions` are still accepted and become Instructions. `/bot-templates` lists only agents made as templates, with their Instructions as `setupInstructions`. The `first_message` column stays.

  The agent icon picker opens on the emoji choices and colours, also for a new agent with no icon yet. Browsing the tabs or a colour chooses nothing; picking an emoji, icon or letters makes it the icon, in the colour browsed. Before, it showed only the Emoji, Icon and Letters tabs until one was clicked.

  "Remember across chats" is a switch in the agent form, and new agents start with it on: from the app form (including Make this an agent) and from a chat's `bot_template_save`, which now also creates the agent's Memory collection and reports in its result's `memory.status` whether that collection is `ready`, `pending_review`, `learning_off` or `not_saved`, with a note for the person. Saving the agent in the app sets up a missing collection. Agents made from a Slack proposal already started with Memory on. Existing agents keep their setting, and `CreateAgentRequest.memoryEnabled` still defaults to off when the API caller omits it.

- 904eae7: Dictation from anywhere now has one workspace of its own. Settings → Dictation gains a Workspace row (shown when the person can use more than one workspace), and every shortcut dictation goes to that workspace and is billed to it, whichever workspace the window shows. The recorder runs outside the workspace screens, so switching workspace mid-dictation no longer stops it. When the person has left that workspace, voice input is off there, or it doesn't offer a shortcut's model, the setting says so on the row at fault and the popup offers "Open settings"; a dictation never falls back to another workspace. The desktop bridge's dictation settings carry the chosen workspace (`DesktopDictationWorkspace`).
- 91320a4: A page whose sign-in is gone now stops instead of polling on. A request refused because its sign-in expired, was revoked or its cookie lapsed answers HTTP 401 `unauthenticated` with `details.code` `session_missing` (no sign-in sent) or `session_expired` (a sign-in cookie or app credential that no longer signs anyone in); another credential that is not accepted, such as an API key, is `credential_invalid`. Route-rejection metrics and logs carry the same reason instead of `unclassified`. The web app hears the first such refusal, confirms with the session read, and leaves the signed-in app at once, so its polling and streams stop and the sign-in page shows; inside the desktop app the window's sign-in is renewed and the page reloads.

  The desktop app also stops its window being signed out while the app stays signed in. Its window shares the device's session, which is renewed at most once a day by whichever request comes first. When that was one of the app's own requests (it polls the inbox, also right after the computer wakes), the renewal never reached the window's cookie, so the cookie lapsed a week after it was last set. The app now sends its own requests with the window's cookies, and a request that renews the session returns the renewed window cookie with it.

  `@opengeni/contracts` adds `AUTHENTICATION_REQUIRED_REASONS`, `AuthenticationRequiredReason` and `isSignInLostRejection`. `@opengeni/core` adds `AuthenticationRequiredRefusal`. The app state's host can pass `subscribeSignInLost`.

- 7c926f8: A meeting recording keeps a track whose source goes away instead of silently ending it. A microphone that is unplugged or turned off is opened again as soon as one is available and records on in the same track; shared tab or computer audio that ends waits for `recorder.reconnect(trackNumber)` (`reconnectTrack` in `useRecorder`), which asks again from a click. Snapshot tracks report `lost: "reconnecting" | "stopped"`, the recorder panel says what is missing and offers the click that brings it back, and `useMeetingRecorderLostTrack` lets a host show it outside the panel.
- c472500: A meeting transcript now says where a track recorded nothing, such as "Ingrid's microphone wasn't recording from 17:39 to 45:35. Everyone else was still recorded." Before, a microphone that was unplugged or tab sharing that ended left a voice missing with no explanation, so the transcript looked like it had skipped speech. Each track's new `unrecorded` field lists those stretches. The server works them out from the chunks' start times when a recording is finalized (migration 1353 adds the column). Older meetings get them the next time they are transcribed. Stretches under two seconds are ignored. The web and phone transcripts show a quiet line where each one starts, naming the person when the track carries one named voice and saying "Nothing was recorded" where every track was silent at once; no turn runs across one. `@opengeni/react/recordings` exports `transcriptUnrecordedMarks`, `interleaveUnrecordedMarks`, `trackSpeakerName` and `unrecordedMarkText` for embedders that render their own transcript, and `groupTranscriptTurns` takes the times no turn may run across.

### Patch Changes

- 4664732: Dependencies with known vulnerabilities are upgraded to fixed releases: `hono` 4.13.17 (`@opengeni/core`), `zod` 4.6.7 (`@opengeni/runtime`) and `katex` 0.18.11 (`@opengeni/react`). Behavior is unchanged.
- 618c2b7: An action the agent asked for from Code Mode can be approved in embedded chats again. Such an approval carries no arguments of its own, since they stay in the action's saved review on the server, and `SessionConversation` (and so `OpenGeniChat`) never read that review: a fresh request showed "The details of this older request couldn't be recovered" with only Decline, also when a host's `approvalProps.loadReview` resolved `null` for it. The conversation now reads the saved review (`getToolActionReview`, with `getToolReviewDetails` for its details) for every approval the host's own loader leaves to the standard card. `NativeSessionScreen` does the same when it is given the full `client`. A session client without these two methods keeps the old behaviour.
- 3b853ca: One IT approval now covers every Microsoft service the app offers in the workspace. The organization admin-consent link requests the combined permissions of all available Microsoft connections that share the same app registration (for example Outlook Mail, Outlook Calendar and OneDrive together), so a company does not need a second approval when someone adds another Microsoft service later. The Microsoft sign-in step now also carries this link as `nextAction.organizationApprovalUrl`, and the connect UI uses it for the approval help, including when a sign-in never came back.
- dd11dad: Connecting a Microsoft work account (Outlook Mail, Outlook Calendar and other Microsoft Graph connections) no longer ends in a generic failure when the person's organization requires an admin to approve the app. When Microsoft returns a consent error (AADSTS65001, AADSTS90094, `consent_required`, `access_denied`), the connect card and setup dialog explain that their IT must approve the app once, with an organization-wide admin-consent link to copy or open and a ready-made message for IT. A sign-in that never came back (the person stayed on Microsoft's "Need admin approval" page or closed it) is remembered in the browser, and the same help appears the next time they open that connection. All wording comes from `connectSetup.*` messages (`organizationApprovalRequiredTitle`, `itMessageWithLink`, `copyMessageForIt` and others), so host apps can replace it through `messages` on `OpenGeniProvider` or `OpenGeniMessagesProvider`. The admin-consent result page now also works for approvals returning through `/v1/integrations/oauth/callback`.
- dd11dad: Host apps can name and describe a connectable service in their own words, and that name is used everywhere the connect UI shows the service: discovery and chooser rows (with the description), connected accounts, the "Continue to …" sign-in step, the chat setup card, the setup dialog and the message people send their IT for approval. Pass `connectService.<providerId>.name` and `connectService.<providerId>.description` in `messages` on `OpenGeniProvider` or `OpenGeniMessagesProvider`, for example `"connectService.microsoft-outlook-calendar.name": "Outlook-kalender"`. Without them a service keeps its built-in name. `ConnectPanel` now also passes the service name to its setup step, so the IT approval message names the service instead of "my work account".
- 55665bc: `connectionOptionNeedsAttention` and `attentionFirst` now treat only connections that report attention (reconnect, failed health check) as needing attention. A connected but unavailable entry, such as one with restricted access, is something the person can't fix there, so it keeps its place instead of moving to the top.
- 89a1793: Sent user messages now show their attachments the way the composer showed them before sending: images as thumbnails that open in the preview, other files as named chips that open or download. This applies to history, optimistic sends and accepted steers. The composer's attachment chips moved to a shared module and gained a read-only mode, and the console's separate large-preview rendering of message files was replaced by the same chips.
- Updated dependencies [c976c87]
- Updated dependencies [6ae0528]
- Updated dependencies [3b853ca]
- Updated dependencies [dd11dad]
- Updated dependencies [904eae7]
- Updated dependencies [91320a4]
- Updated dependencies [7c926f8]
- Updated dependencies [c472500]
  - @opengeni/contracts@6.14.0
  - @opengeni/sdk@6.14.0
  - @opengeni/connect@6.14.0

## 6.13.0

### Minor Changes

- b15212e: A message that couldn't start because of access now starts by itself once that is fixed. When its machine is allowed for the chat, the sender's workspace access is restored, or the chat moves to a machine it may use, the saved message is released and started exactly once. A paused, cancelled or edited chat is left alone, and a claim that raced the change is re-read instead of parked. The "Recheck access" button is gone. The notice says what is blocking the message and offers the one action that fixes it: the machine's owner gets "Allow for this chat", others learn who can allow it, and lost membership names a workspace admin. Only an unknown failure offers "Try again". A claim refused because a personal machine isn't approved now reads as "Machine access needed", not as a generic permission check. `useSessionStart` adds `allowMachine`, `needsMachineAccess` and `refresh`, and `@opengeni/react` exports `allowMachineForChat`, `sessionAdmissionNeedsMachineAccess` and `sessionAdmissionMachineAccessCopy`.
- 1c7aa2a: People on a plan that doesn't include their own subscriptions (Codex, Claude, SuperGrok) now hear it before Send instead of after it. The workspace model catalog returns `ownSubscriptionPlan` (`{ key, label, monthlyPriceMicros }`) and the same `requiredPlan` on each own-subscription model while the organization's plan doesn't include them. The plan is the cheapest self-service plan that does, from the plan catalog (`ownSubscriptionUpgradePlan` in `@opengeni/contracts/billing-origin`). Connect pages and onboarding say "Using your own subscription needs Pro ($20/month).". The web and React Native model pickers label those models "Needs Pro" (`requiredPlanHint`) and keep them selectable. The new-chat page shows a notice with one action when one is chosen, and a one-time dismissible heads-up to people who connected one earlier.

### Patch Changes

- 460102f: The automation form no longer shows a removable pill for every connector a run gets. The Message box keeps Repository and Environment on top, and one Connectors control under the message shows up to three logos and a count; it opens the list of connected apps to turn each on or off. A chosen app that is no longer connected is flagged on the control and stays in the list, by its catalog name where known, so it can still be removed. Connectors show their real logos there, found in the workspace capability catalog.

  `connectorLogoSources` (in the app's composer-connectors helpers) finds each connector's catalog logo by its own logo, its catalog entry or its provider's domain. `installedApiIntegrationMcpServers` now keeps an API integration's `capabilityId` and `providerDomain`, so API connectors such as Gmail or Grafana find their logos too.

- Updated dependencies [1c7aa2a]
  - @opengeni/contracts@6.13.0
  - @opengeni/sdk@6.13.0
  - @opengeni/connect@6.13.0

## 6.12.0

### Minor Changes

- 3c94d65: When two or more actions wait for approval, the approval stack now offers **Approve all** (with the count, for example "Approve all 3") and **Decline all** beside its pager, in the chat and in each sub-session's stack in the parent chat. Each action is still decided on its own through the host's `onApprove` / `onReject`, one after another, so every decision goes through the same request and server checks as its card. Approve all counts only actions whose own card offers Approve without more input: not one only its account's owner may approve, one this person can't access, one that can't be decided yet, or an MCP server's question; Decline all covers every action its card can decline. While it runs, the stack shows "Approving 2 of 3…" and the cards wait. An action that is refused stays waiting, is selected and is named with its error ("Couldn't approve …: …"); the rest keep going. An action decided elsewhere, or whose facts change, is skipped; one that arrives meanwhile waits for its own decision; leaving the chat stops the run. With two or more waiting, `ApprovalSurface` reads each one's review (through `loadReview`) instead of only the selected one's; the selected card reuses that read. New messages: `approvalSurface.approveAll`, `approvalSurface.declineAll`, `approvalSurface.approvingIndexOfLength`, `approvalSurface.decliningIndexOfLength`, `approvalSurface.couldnTApproveTitle` and `approvalSurface.couldnTDeclineTitle`. An action already decided by the run is not offered or sent again while the host still lists it, and one whose review couldn't be read yet is read again. `useSessionControl`'s `approve` and `reject` take an optional last `ApprovalDecisionOptions` argument; `{ throwOnError: true }` rejects with the refusal instead of resolving `null` (`error` is still set), and `SessionConversation` uses it so a refused action is named in the stack.
- 281af3a: Add `OPENGENI_CLAUDE_CODE_API_KEY_ENABLED` (default off): Connect provider offers a
  "Claude Code (API key)" row that opens the Anthropic API-key connection, introduced by a short
  explanation of the monthly API credits some Claude plans include and how to claim them and create
  the key. Display only; the Claude subscription connection is unchanged.
- 906407a: Chat and agent avatars now show in native apps as they do on the web. `@opengeni/react-native/timeline` adds `SessionAvatar` (emoji, letters, icon or image avatars on their hue; image avatars load with the person's own access and fall back to the chat's initials) and `useNativeSessionIdentity`. Session rows show a chat's avatar beside its title when given an `avatarClient`, and `SessionHeaderTitle` takes `avatar` and `agentName`, so an agent's chat shows the agent's current icon and name. The shared rules (initials, fallback colours, tile colours, the agent behind a chat) are in the new `@opengeni/react/session-avatar-model` entry point.
- 60ed55d: New `@opengeni/react/automation-model` entry: how automations read to people (when one runs, its next run, the list order, what a run did, the first message of a chat that creates one) with no React DOM, for hosts that draw their own screens such as React Native. `automationAgentOpeningMessage` is also exported from `@opengeni/react/automations`. The Opengeni phone app uses it for its new Automations screens.
- 2e749ad: Resolve UUID `artifact:` links with one authenticated workspace kind lookup before handing them to host navigation. Chat, embedded viewers, and mobile links now open Sites as well as retained files; old typed routes and native editable-artifact links keep their existing behavior.
- fcdf7de: Keep operator instructions, skill bodies and the full tool catalog out of default
  chat session responses through the explicit typed `client.withSessionResponse("chat")` opt-in
  and JSON content negotiation on the existing Accept header. SDK defaults and
  required Session fields stay unchanged. Console, mobile and packaged chat clients
  opt into the compact type. Settings and server-side integrations can explicitly read
  the full configuration with `getSessionConfiguration` and session-control authority.
  Server-owned session relays refuse browser configuration and model-context reads.

  Export `OPENGENI_BROWSER_RESPONSE_HEADERS`, share it between API CORS and the
  packaged relay, and warn once when required history response metadata is unreadable.
  Cross-origin hosts should use the export for `Access-Control-Expose-Headers`.

### Patch Changes

- 64fd53f: An agent can now ask to attach a repository the workspace GitHub App offers to its own chat with the new first-party `github_repository_attach` tool. Every call waits for a person's approval through the ordinary tool approval card, in the app and in the Slack thread of a chat started from Slack. The card names the repository, the branch and the access, and says when a person removed the repository from the chat earlier. Where nobody can answer, such as a scheduled or unattended run, the call is refused.

  The API attaches only a call a person approved for exactly that repository and branch, from the same workspace GitHub App catalog and `github:use` permission as the repository picker, and never an archived or empty repository. The repository joins the chat's repositories as best effort (`optional`), ends any earlier removal record, and is one of the chat's repositories from the next turn. Asking for a repository the chat already has reports the branch it has, and a repository the App has since stopped offering no longer blocks attaching another. A new `session.resources.added` event records it.

  `@opengeni/core` adds `attachSessionRepositoryResource`, `@opengeni/db` adds `listPersonApprovedFirstPartyToolCalls`, and the timeline shows the call as "Attaching a code repository".

  An approval card for a first-party call whose review states its target facts now lists those facts, in the app and in Slack, as app action cards do; the call's raw arguments stay in Details. The Slack bot message card shows its channel and message this way too.

- 7332869: "Allow once" for a personal Connected Machine now works. Accepting the message used the one-time grant and filed its receipt against the message, but the check before the turn ran on the machine only accepted a receipt filed against the attempt, so every such turn failed with "A database error occurred." Migration 1340 lets that check accept the message's receipt for the same grant, turn, account and authority generation, so the message runs on the machine (including a retried attempt of the same turn), and the next message needs approval again. A turn whose machine approval is missing, used up, revoked or expired now ends with "Machine access needed: this chat isn’t allowed to use “<machine>” right now." (failure code `machine_access_required`) instead of a database error, and the machine's owner gets an "Allow for this chat" action in the failed-turn banner that approves the machine for the chat and continues. Failed-turn analytics add the `machine_access` class and the `allow_machine` action.
- 2e7c01e: Voice calls on Android now set up the phone's call audio, and a call that is silent on one side says so.

  - Android: `createExpoCallAdapter` no longer returns null. The package's call module now ships an Android side that, while a call runs, takes audio focus for voice communication, switches the phone into communication mode and routes the call to a connected headset or the loudspeaker (every call starts on the loudspeaker, as on iOS), then restores the previous audio state when the call ends. Before, WebRTC recorded and played as if no call were running, and on some phones the microphone handed the call nothing but silence, so the voice never heard the person. There is no system call screen on Android: the adapter reports `showsSystemCall: false`, `systemCall` stays false, and agent calls (`incoming`) remain iOS-only. The package's Android manifest adds `MODIFY_AUDIO_SETTINGS`, a normal permission with no prompt. Native Android builds need a rebuild to include the module.
  - SDK: while a call is live, the realtime controller reads the peer connection's audio statistics once a second. An unmuted microphone that delivers no sound at all for 8 seconds raises the recoverable `no_input_audio` diagnostic, and a finished reply whose audio never played raises `output_silent`; both set `error` with a plain message and clear once audio flows. Platforms whose statistics lack audio energy report nothing.
  - React Native: `useNativeRealtimeCall` returns a `notice` for these, and `OpenGeniNativeCallView` shows it under the call status.
  - React: the voice control shows "No sound from your microphone" or "Reply not played" beside the button, with the detail in its menu.

- b01c6c8: In the Opengeni app, an image you drop, paste or pick shows as a compact attachment chip with its file name, like any other file, and no longer puts an `[Image N]` tag in the message text. `imageTags` stays available as an opt-in for embedders.
- 6c69279: Connections that need attention now lead every connection list, including the short preview before "View all connections", so a problem is never hidden further down. Google Calendar, Google Drive, 1Password, Codex Apps and Mobbin show their brand marks instead of a letter, Jira & Confluence uses the Atlassian mark instead of an unreadable wordmark, and a test fails when a reviewed or built-in connector has no logo.
- 81642f5: The chat no longer jumps or shows a large blank area during long agent turns. A whitespace-only assistant message (some models send one around every tool call) is no longer turned into an empty timeline row, so dozens of them no longer stack their row gaps into a blank band or nudge the view up with nothing new on screen. A work row's toggle that stays focused after a click now anchors only the commit in which it opens or closes, so the view no longer chases that row while the answer streams above it and then snaps back by the answer's height when the turn settles. Closing a work row while at the very end of the chat resumes following new output.
- 2117a2d: When a chat's own model cannot summarize older history, the turn no longer fails with "start a new session". On an OpenAI-compatible endpoint, a summary request rejected with HTTP 400 or 422 is first sent once more without its output cap, and a summary from that retry is held to the cap by cutting it from the middle. If the summary still fails in a way that repeating it cannot fix (a definitive rejection, a non-temporary failed response, or an empty or unusable summary, including one cut off at the output limit), the history is trimmed instead: platform context and the newest requests are kept as a summarized checkpoint keeps them, and a fixed note stands in for the summary. No other model is asked, so no history leaves the chat's provider. Retryable, temporary, transport, authentication and quota failures, cancellation, Codex remote compaction and the rebuild when a Codex chat switches model keep their existing handling, with history unchanged. The provider's own error message, bounded, is now recorded in the structured `providerMessage` field of the session's events (the trimmed checkpoint's `fallback`, the `summarization_failed` skip and `turn.failed`), never in free-text errors or worker logs. The timeline shows "Older messages trimmed" with the provider's reason behind Details.
- b2c6c04: A new-chat form emptied after Send no longer clears a newer draft from another of the person's devices, for example when the post-Send read failed or a reconnect read it without showing it. An autosave of a box holding no message now checks a newer draft before saving: another device's message is kept and the form follows it, while a draft holding no message is saved over as before, so model, project and visibility picks still win. Clearing the box over a message the form never showed now brings that message up instead of erasing it; clearing it again erases it. Typing still saves on top of a newer draft.
- e9222e0: A chat whose automatically attached GitHub repository later loses access (the GitHub App is uninstalled, or the repository is taken out of it) no longer refuses every follow-up. Follow-ups used to re-check all of the chat's repositories and answer 422 "The request could not be accepted. Check your input and try again." for good, so Retry could never succeed. Now those optional repositories are left to the worker, which drops them for the turn and reports them as skipped. Repositories a message adds, and ones attached explicitly, are still checked. That refusal now carries `details.code: "github_repository_unavailable"` and the repository names, and the composer says which repository to remove or restore. Any other 400/422 Send refusal that has a server reason shows that reason instead of the generic "check your input". The SDK keeps short string lists in error `details`, for example `repositories` and `allowedLatencyModes`.
- 8cc1ddd: An agent moving its turn onto a personal (Only me) Connected Machine whose approval for the turn was used up, revoked or expired now gets a typed refusal instead of a raw database error. `sandbox_swap`, `sandbox_attach` and `run_on` return the new code `machine_access_required`, whose reason starts with "Machine access needed: this chat isn’t allowed to use “<machine>” right now.", and the chat stays on its current machine. That sentence now comes from one shared helper, `machineAccessNeededMessage` in `@opengeni/contracts`, used by the failed-turn banner, the worker's turn failure and the refusal.
- fccf354: Keep native chat responsive on long or crafted messages: bound Markdown input to
  8,192 characters and show longer messages in selectable plain-text pages, with
  every character still available. Bound math normalization too. The mobile app
  pins patched Markdown/linkification and URI-decoding dependencies.
- c63eeb2: A new chat whose draft has an Agent learning setting can be sent again. The composer saved Agent learning in the new-chat draft, but the server's check that Send matches the saved draft left it out, so every such Send was refused as a draft conflict and the person was told the draft kept changing in another tab. The check now compares every option a new-chat draft can hold, taken from the draft contract itself, and treats an Agent learning setting with nothing overridden as unset. The composer names another tab or window only when the draft really changed since its Send saved it; otherwise it stops retrying and says the message couldn't be sent.
- 98938f0: Prepare native call data and microphone-free WebRTC offers while ringing, reuse the workspace voice selection, and overlap outgoing setup with admission. Keep provider calls and microphone capture behind Answer, release abandoned preparation, and expose server setup phase timings.
- 3929153: Prepare incoming voice connections while ringing only on phones with a native audio device that guarantees silence until Answer. Hold context delivery until the answering phone wins, release unused preparations silently, and retain connect-on-answer behavior on other hosts.
- 2e1e9c6: Send always wins over the saved draft. Starting a new chat or sending in an existing chat now carries exactly what is in the box and is never refused because the draft changed, on web, the Mac app and mobile; retries stay safe through the message's client event ID.

  API change: `expectedNewSessionDraftRevision` on create and `expectedDraftRevision` on composer submit no longer make the server refuse a Send with `NEW_SESSION_DRAFT_CONFLICT` or `DRAFT_CHANGED`. They are now the revision the sender last saw, the basis for clearing the draft: after an accepted Send the server clears the draft only while it is still at that revision or holds exactly what was sent. Otherwise a newer draft typed on another device stays (composer submit returns it as `draft`) and the composer shows it. Composer submit now also accepts `expectedDraftRevision: 0`, meaning the sender saw no saved draft. Draft saves keep their revision checks.

  A person's other devices now follow their latest draft live through a private, content-free hint on the workspace live stream (`workspace.drafts.changed`), and typing over another device's edit saves on top of it instead of asking which draft to keep. Mobile new chats now clear the saved draft they were sent from. Against a server from before this change, a mobile new chat that the server refuses over its draft is retried once without the draft, as such servers always accepted.

- 8099970: A subscription speech service that is out of credit now says so. Subscription transcription reads the provider's refusal instead of discarding it, so xAI's "run out of credits" answer becomes an out-of-credit error rather than a generic failure; a failed dictation keeps that reason, and the composer and phone dictation tell you the speech-to-text service is out of credit. Phone dictation no longer says to retry when you're back online after the speech service itself failed.
- bee1e4c: With `busySend: "steer"`, a message sent while a turn runs now always reaches that turn, even when the client's copy of the session is a few seconds behind. The composer used to pick Steer or Send from its own view of the session, so a Send right after a turn started could be queued and answered only after the turn finished. It now submits the new `delivery: "steer_or_send"` (accepted by `steerMessage` and draft submits), and the server resolves it under the same locks that start and settle turns: it steers a running or just-starting turn, starts a turn when the session is idle, and queues without resuming when it is paused. Only the resolved `steer` or `send` is recorded, so nothing the model sees changes. Exact retries replay the first decision. Plain `send` and explicit Queue are unchanged, and the composer falls back to its own choice against a server without `steer_or_send`.
- 65e1fb9: Open `artifact:<32-hex id>` Markdown links as native documents, spreadsheets, or presentations in the current workspace, using the existing artifact navigation and embedded viewer resolvers. Retained-file UUID links continue to open files.
- Updated dependencies [64fd53f]
- Updated dependencies [2e7c01e]
- Updated dependencies [281af3a]
- Updated dependencies [e9222e0]
- Updated dependencies [8cc1ddd]
- Updated dependencies [98938f0]
- Updated dependencies [3929153]
- Updated dependencies [2e1e9c6]
- Updated dependencies [2e749ad]
- Updated dependencies [fcdf7de]
- Updated dependencies [bee1e4c]
- Updated dependencies [65e1fb9]
- Updated dependencies [c0b9f88]
- Updated dependencies [00dd24b]
  - @opengeni/contracts@6.12.0
  - @opengeni/sdk@6.12.0
  - @opengeni/connect@6.12.0

## 6.11.0

### Minor Changes

- d66e22b: `agentSignals` on `SessionConversation`, `MessageTimeline` and React Native's `NativeSessionScreen` now also takes an object of switches, `{ goal, agents, commands, turnDetail }`, each `true` unless set, so a host can hide one part of how the agent works without the rest. `agentSignals={{ goal: false }}` hides the goal pill and keeps queued messages, helper agents, the live step and the host's own `turnSummary` facets. `true` and `false` mean what they did. The row above `SessionConversation`'s composer (queue, wait, goal and agents chips) now sits in the composer's readable column, so it lines up with the composer in a wide panel instead of starting at the panel's left edge; a `chromeProps.className` is still added to it.
- 71395d6: Agents in the app: the sidebar's **Agents** page replaces Bot templates and the Slack agents list (All / Yours, New agent, Import, banners for the move and repeated names), with a page per agent (Chat, Export, its chats, Instructions, First message, Memory, who can use it, and Slack availability per installation through a host slot). The new-chat composer has an agent chip and `?agent=<id>` links (`?botTemplateId=` still works) that fill in the agent's First message and start the chat with `agentId`. Send waits while the agent loads and never starts an ordinary chat in its place; an agent that can't be used here shows why on the chip. An untouched First message stays out of the saved draft, so it never reaches another tab or device without its agent. An Only me agent makes the chat Only me while it is chosen. Agent chats show the agent beside the title with a source line, and the chat header's ⋯ menu has **Make this an agent** (prefilled with the chat's name, icon, description and instructions). **Export** saves an agent as an `.agent.json` file with its Instructions, First message, Memory switch and who can use it; Import reads it (an Only me agent stays Only me where Only me chats are available) and older `.bot.json` files. Renames: the chat's Agent tab is Settings, Connected agents is Connected apps, and Automations runs tasks on a schedule.

  For embedding apps: `SessionHeader`'s `onSaveBotTemplate` is now `onMakeAgent`; the create option `bot` (`NewSessionBotProfile`: name, description, avatar) is now `agent` (`NewSessionAgent`: the agent's `id` and the `avatar` the chat shows); `NewSessionBotProfile` is removed. New modules under `app/components/agents/*`, `app/lib/agents`, `app/lib/composer-agent`, `app/lib/agent-avatar` and `app/lib/session-agent`; `app/components/bots/*` and `app/lib/bot-templates` are removed.

  `CreateSessionRequest` in the SDK now types `agentId`. The archive refusal for Keep this chat active points to the chat's Settings tab.

- 5dabaa2: Archived chats now read as Archived everywhere, never as "Cancelled". Archiving a chat stops its running work, which leaves the session's internal status `cancelled`; the chat header, sidebar row and hover card, session tiles, sub-agent list, inspector, conversation divider, empty state and composer placeholder (web and native) now show the archive instead, with the existing read-only notice and Continue in a new chat. `sessionDisplayStatus` returns the new `archived` display status for archived sessions, and `sessionArchived` and `sessionStatusItemDisplayStatus` are exported. The packaged conversation is read-only for archived chats too, and `session_get` reports the archive as soon as a chat is archived, before its content is stored.
- 532751d: The composer can keep images where they were added. With the new opt-in `imageTags` prop on `ChatComposer` (also `useChatComposerController` and `SessionConversation`'s `composerProps`), pasting, dropping or attaching an image puts a plain-text `[Image N]` tag in the text at the cursor, and the image's chip shows "Image N". Removing an image removes its tag and renumbers the later ones; images restored with a draft or a recalled queued message keep the tags their text already has, and new images are numbered after them. Image N is the Nth image the message carries, the order the agent receives them, so the message and API are unchanged. Off by default; the Opengeni app turns it on. `FileAttachment` gains `restored` for files brought back with a draft, and `useFileAttachments` gains an optional `loadFileContentType`.
- 9788ab8: Hosts can hide the agent's behind-the-scenes signals from end users. Pass `agentSignals={false}` to `SessionConversation`, `SessionConversationView` or `OpenGeniChat` (through `conversationProps`) to hide the goal pill and any agents or commands segments, and to React Native's `NativeSessionScreen` to hide its goal, agents and commands chips. Queued messages, approvals and the agent's questions still show; the default is unchanged.

  The goal pill's pause reasons ("Paused · agent", "· cap", "· manually" and the rest) and the agents chip's "2 running" / "1 paused" now come from the message catalog (`sessionChrome.pausedReason*`, `sessionAgentsModel.runningCount`, `sessionAgentsModel.pausedCount`), so a translated chat no longer shows them in English.

  Hosts can lead the live "Working" / "Waiting" / "Paused" turn row with their own mark, such as a small animated mascot: `turnSummary.renderLiveMark` on the web timeline (`SessionConversation` takes it through `timelineProps`) and `renderLiveMark` on React Native's `NativeSessionScreen` and `MessageTimeline`. It receives the row's state (`working`, `waiting` with `waitingOn: "you"` for an approval or question, or `paused`) and is removed when the turn settles. The default is no mark.

- 3f64150: Your GitHub can use **All my repositories** (offered once `OPENGENI_GITHUB_PERSONAL_ALL_REPOSITORIES_ENABLED` is on, after every API and worker runs this release; `allRepositoriesAvailable` on the connection status), read only or read and write, instead of a chosen list: any repository the person can currently reach on GitHub works in chats, the git broker and the `github_personal__*` tools, checked live with GitHub (cached for a minute; renamed repositories are followed). A repository a person removed from a chat stays refused in that chat. The chosen list is kept, so switching back restores it; turning the mode off, or narrowing it, ends work accepted before, even if it is turned back on. Catalog items keep `selectedAccess` as the saved choice and add `effectiveAccess`, the access usable now. Repository search in the chooser and the session picker now asks GitHub, so it finds repositories beyond the first 100 (`query` on the personal repositories list; `allRepositoriesAccess` on the selection state and the replace request). New read tools work without a sandbox: `organizations_list`, `owner_repositories_list`, `workflow_runs_list`, `workflow_run_get` and `workflow_job_logs_get` (bounded, tail first, paged, read with HTTP ranges from the log storage). `organizations_list` comes from the person's repository access, which the connection's `repo` scope allows. One shared check, `checkPersonalGitHubRepositoryAccess` in `@opengeni/core`, decides repository access for every caller, including the `gh` gateway. GitHub REST bridge bodies and commit messages (issues, pull requests, comments, reviews, merges) keep their line breaks and tabs instead of being rejected as invalid.
- 6abf872: Integration Knowledge sync is fully removed. A migration deletes the leftover Knowledge source sync tasks with their runs, sync state and wakes, and any saved `knowledge_source` facets; Automations no longer show "Sync retired" and the integration facets panel no longer shows "Retired" sources. Native Google Drive and Atlassian source connections left from the old sync stay hidden and inert; the generic connection DELETE still revokes them. Schedules only run agent turns. The native Google Drive and Atlassian source OAuth, callbacks, lifecycle and source routes are gone; Google Drive, OneDrive and Atlassian keep working through their agent-tool connections.

  - Removed internal entry points: `@opengeni/documents/google-drive`, `@opengeni/documents/atlassian` and `@opengeni/contracts/google-drive-native-retirement`. `@opengeni/contracts/knowledge-source-sync-retirement` now exports only `KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE`, and `@opengeni/contracts/atlassian-native-retirement` only the historical tool names.
  - Removed internal `@opengeni/contracts` root exports: `KnowledgeSourceSyncScheduleControl`, `scheduledTaskKnowledgeSource`, `requireScheduledTaskKnowledgeSource` and `knowledgeSourceAgentConfig`.
  - The `OPENGENI_GOOGLE_DRIVE_CLIENT_ID`, `OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET`, `OPENGENI_GOOGLE_DRIVE_SYNC_*`, `OPENGENI_GOOGLE_DRIVE_PROVIDER_*`, `OPENGENI_ATLASSIAN_CLIENT_ID` and `OPENGENI_ATLASSIAN_CLIENT_SECRET` settings are no longer read.
  - Public SDK surface is unchanged until the next major: `browseAtlassianSources`, `saveAtlassianSources`, `setAtlassianLifecycle`, `transitionGoogleDriveLifecycle`, `browseGoogleDriveFacetSource`, `saveGoogleDriveFacetSource`, `disconnectGoogleDriveConnection`, `CreateKnowledgeSourceSyncScheduledTaskRequest`, `agentConfig.knowledgeSource` and `KnowledgeSourceSyncRunSummary` are deprecated. Their routes answer 410, except `disconnectGoogleDriveConnection`, which now revokes through the generic connection DELETE.

### Patch Changes

- 88de211: API key dialogs now name who can actually create a key you can't. On a workspace key, "All permissions" says only a workspace owner can create a key that reads secret values, since a Workspace admin can't give that. A member who manages keys sees "A workspace admin can create it." on presets that need workspace administration. For an organization admin who isn't the owner, Full access and Developer setup on an organization key stay visible but off, saying only the organization owner can create a key that manages people, keys or billing. Custom checkboxes name who can give each permission instead of "beyond your own access". The workspace-key rule, the Workspace admin and owner permission sets and the `workspaceKeyCreator`, `workspaceKeyCreatorSentence` and `workspaceKeyLiteralRefusal` helpers live in `@opengeni/contracts`, shared by the API and the apps. The API's refusal for a workspace key keeps its prefix and now ends with the same sentence.
- 80ff42d: An attached Chrome profile id now resolves only to copies announced by the same computer. A profile id is announced by the machine and stored per workspace, so a machine someone else enrolled in a shared workspace could announce the id of your Only me profile and, in that workspace, take its place in your list and receive your new browser and computer sessions. Copies now collapse only when their enrollments share the machine's key, your own personal enrollment is preferred over any shared one, and an id announced by different shared machines is refused unless a session pins its workspace, with each machine's copy listed.
- 5962929: Attached images always show as images. A draft restored after a reload or opened on another device, a queued message, and a sent message viewed elsewhere now load their pictures from the server instead of showing a generic file chip, on web and native. Every surface reads previews the same way through the new `useStoredFiles`, `useStoredFilePreview` and `readStoredFilePreviewUrl` helpers, which share one signed URL per file until shortly before it expires and re-sign once when an image stops loading.
- 276001c: An automation run in a chat now reads as what happened, not as its instructions. A run shows one plain, centered line (the automation's name and what the event that started it says, for example "Ticket assigned to you: T-4907 Refund request from Contoso"), then the agent's answer. The pending and delivered events for a run now carry the automation's name as their summary, plus `automation: {name, eventSummaries, eventCount}` on the member, so the instructions never reach a chat; the agent still reads them in the update as before. Older runs read "Automation run".

  A run with nothing for the person stays out of the chat. New occurrences tell the agent to answer exactly `NO_REPLY` when nothing needs the person, and the web and native timelines then draw neither the run's line, its work nor its answer; the token itself is never drawn anywhere, even while it streams. `NO_REPLY_SENTINEL`, `isNoReplyText` and `mayBecomeNoReplyText` come from `@opengeni/contracts/no-reply`, shared with Slack replies.

  `agentSignals={false}` on `SessionConversation`, `MessageTimeline`, `NativeSessionScreen` and the native `MessageTimeline` now also keeps turn rows to their status (no step preview or host `turnSummary` facets) and shows an automation run as only its line and answer: no work row, nothing while it works, and nothing for a failure only an operator can fix. `automationRunOutcomesOnly`, `automationRunLine`, `isAutomationRunBatch` and `readableWorkIsEmpty` are exported for hosts that build their own timeline.

- 52e1ed5: A browser or Desktop on a Connected Machine is no longer retired when it is used while its task runs on another machine. The request is refused with a final conflict that names the machine it runs on, and the browser keeps running there, so the task can use it again after moving back. The browser view explains that the chat is working on another computer.
- f987b58: A turn that runs without the person's GitHub authority, such as the idle compaction checkpoint after a person's turn, now leaves the personal GitHub tools out instead of failing with "Personal GitHub delegation is unavailable". Other turns that leave them out log a warning, and a malformed or ambiguous delegation still fails. A compaction checkpoint whose turn would otherwise end in the generic failed state now settles as a failed compaction: the chat shows "Couldn’t compact conversation history", returns to idle instead of failed, and consumes the request so it is not claimed again. An automatic compaction's failure (labelled Auto) now reads "Chat history is unchanged." without asking the person to request it again.
- fff4a9f: A model, reasoning effort or speed picked in a chat's composer now sticks even before anything is typed or sent. Before, a pick on its own was never saved to the chat's draft, so opening another chat or reloading brought back the old setting. The pick is now saved to that chat's draft straight away, on web, the desktop app and mobile. Text typed just before opening another chat (or closing the composer) is also saved instead of dropped when its autosave had not run yet; such a save never overwrites a draft that changed meanwhile, for example by a Send or another tab.
- 9d52126: Opening a composer no longer throws an unhandled `Cannot read properties of undefined (reading 'map')` when the saved-dictation lookup gets a success answer that is not a recordings list, such as a host proxy or test double answering `GET /recordings` with another route's body. `OpenGeniRecordingsClient.listRecordings` now checks the answer and rejects anything without a `recordings` array of recordings with ids as an `OpenGeniApiError` with code `invalid_response` (a missing or malformed `nextBefore` reads as the end of the list). `useVoiceInput` also tolerates a host's own recordings client that resolves without a list, and its background recovery never rejects: the composer stays as it is and a saved dictation is offered by the next composer. The recordings and transcription docs say what a custom proxy or stub must answer.
- 2a02889: Dictated text arrives sooner after you stop. `GET /recordings/:id/transcripts` takes `waitSeconds` (at most 25) and an optional `waitFor` version, and answers the moment that version (or the newest) is complete or failed instead of at once; `listRecordingTranscriptVersions` passes them, and `useVoiceInput` waits this way instead of checking every second. The worker also downloads a track's uploaded pieces 16 at a time when preparing its audio, instead of one after another. A dictation longer than 25 seconds is cut at the speaker's pauses into pieces of about 15 seconds (never more than 50), found in its decoded 16 kHz audio, and all pieces are heard at once, at most 8 together, so a long dictation is ready about as soon as a short one. Before, it was cut every 50 seconds wherever that fell, and the pieces were heard one after another. A meeting's transcript is ready sooner too: a track's pieces go to the model 4 at a time instead of one after another, and each piece is cut by seeking to it rather than decoding the whole track up to it.
- 06606ef: A Modal sandbox whose drain snapshots keep failing no longer drains until the provider kills it. After three failed snapshots over at least 15 minutes (or one inside the pre-deadline save window) the drain saves the workspace without rebuildable folders such as `node_modules`, `.next`, `.venv` and caches (`omittedPaths` on the archive descriptor); the chat shows which folders were left out and the next turns' model input carries a note to rebuild them. The drain stops the box itself when that save fails or cannot be stored after an hour of failures or near the box's lifetime limit, or when near that limit it is still running at the end of the wait or cannot be tried at all; the chat then shows "Files changed after {time} couldn't be saved before this chat's workspace machine shut down." A re-armed box's drain failures no longer carry over to its next drain. New counter `opengeni_sandbox_drain_capture_fallback_total{backend,outcome}`.
- b631728: An expired connector account is no longer invisible. When a refresh token is rejected and a connection moves to `needs_reauth`, the turn that hit it posts one inbox notice to the person who started that turn ("Gmail needs reconnecting", naming the account), deduplicated per connection. The turn notice for unavailable connectors now lists the accounts that need reconnecting with the day they stopped working, and `capability_catalog_search` says the same in the item's setup text and a new `setup.reconnect` list. `capability_authorization_request` takes an optional `connectionId` (picked automatically when exactly one account can be reconnected) and posts a card that reconnects that same account, instead of a fresh Connect card that could not finish because the account was already connected. The web and native cards show "Reconnect <service>" and skip the ownership choice.
- b05587f: A workspace's GitHub App repositories now follow GitHub. A repository added to a bound installation, including a new repository of an "All repositories" installation, appears for the whole workspace without reconnecting, and one removed from it stops being usable at once. The App's `installation_repositories`, `installation` and `repository` webhooks update every bound workspace (even with event triggers off), and every repository listing applies the list GitHub just returned, so a missed webhook repairs itself. Opening the new-chat repository menu re-reads the list. Bindings still need the original owner proof; following GitHub's later selection is the delegated behaviour, documented in `docs/github-app.md`. New Apps also subscribe to `repository` events.
- 7e28f18: Machine cards on the Machines page show memory, disk and CPU, and no longer show the load average (1m, 5m, 15m) or run queue. Those numbers mean little to most people; the machine's detail panel still charts load over time, and `MachineMetrics` with `density="full"` still shows them.
- d96bc4d: Auto-connect (MCP Enterprise-Managed Authorization) in both directions. Organization owners and admins can trust Claude's per-organization issuer (Claude Team and Enterprise) or their identity provider under Organization settings → Connected agents → Auto-connect, and members' agents are then connected to the organization MCP server the first time they use it, with no sign-in or consent screen: `/oauth/token` redeems ID-JAGs with the JWT bearer grant, members are matched by verified email to active members, the issuer's access setting applies to everyone it connects, and Recent attempts say why one was refused. The authorization server metadata now advertises the grant, the ID-JAG profile and Client ID Metadata Document support, and clients may be named by their metadata document URL. In the other direction, a new organization connector sign-in, "Connect everyone automatically" (`login: "auto_connect"`), gives each member their own account in an outside MCP app that trusts the organization's Opengeni issuer (`/v1/organizations/:id/identity`), signed and redeemed before their turn or when they choose Connect, and renewed without refresh tokens; admins check support before adding and Test as themselves. Opengeni's client metadata document lists the JWT bearer grant. New SDK methods: `listMcpTrustedIssuers`, `checkMcpTrustedIssuer`, `createMcpTrustedIssuer`, `updateMcpTrustedIssuer`, `deleteMcpTrustedIssuer`, `listMcpTrustedIssuerEvents`, `checkOrganizationConnectorAutoConnect`, `testOrganizationConnectorAutoConnect` and `connectWorkspaceOrganizationConnector`.
- 7850181: A meeting's transcript no longer waits for its compact kept audio. Each track is decoded once, straight to 16 kHz speech PCM (seconds even for an hour), and transcribed, told apart and searched for sound from that; the 16 kbit/s Opus kept copy, which takes most of a minute to encode for an hour, is written beside the transcript from the same downloaded chunks. The uploaded chunks stay until the attempt's transcript is settled, so a retry decodes exactly the same samples and reuses every piece already heard. Pieces of speech PCM are cut from the samples in-process and sent as lossless FLAC, half the size of WAV and written in seconds even for an hour; only a model that takes nothing but WAV gets WAV. The meeting page and `useRecording` keep polling a ready meeting for up to ten minutes after it ends while an audio track is still being kept, and the player waits for every track.
- 6c3fcf3: React Native hosts can now show readable approval cards. `NativeSessionScreen` and `ApprovalStrip` take `loadReview`, the same hook and the same `ToolActionReview` as the web `ApprovalSurface`: return the server's review from `client.getToolActionReview`, or your own plain title, consequence and the fields worth reading, so a write tool whose arguments are only identifiers no longer shows its raw title and identifiers. The review only changes what the card says; the approval decided is always the one the agent asked for, and a review for another approval is ignored. While it loads the card shows the tool's title and holds Approve (Reject still works); resolving `null` or a 404 keeps the standard card; any other failure shows the standard card, still decidable, with Try again. A loaded review's `availableActions`, `approvedBy`, samples and protected fields now show on the native card as they do on the web. On the web, `ApprovalSurface`'s `loadReview` may now resolve `null` to keep the standard card, so one loader serves both.
- fde0171: A React Native app no longer crashes when it returns to the foreground. The native environment shim called its `window` and `document` listeners with no event, so the `pageshow` handlers read `event.persisted` on `undefined` and threw. Every shimmed listener now receives a browser-shaped event (`type`, `target`, `currentTarget`, `timeStamp`, the usual no-op methods, `persisted: false` for `pageshow` and `pagehide`, `relatedTarget: null` for `focus` and `blur`); listener objects and `{ once: true }` work; a listener that throws is logged and the rest still run, instead of failing the app-state callback. The shimmed `document` also has `hasFocus()`. The `pageshow` handlers in `@opengeni/react` now tolerate a missing or partial event.
- 650e54a: Agents no longer offer a Connect card for an integration this deployment cannot connect: its setup is switched off by the operator (for example Google connectors with `OPENGENI_GOOGLE_CONNECTOR_SETUP_ENABLED=false`), or the provider needs an operator OAuth client that is not configured. `capability_catalog_search` reports such entries as `setup.status: "unavailable"` with no `nextAction` and the catalog's note as the detail, `capability_authorization_request` returns `unavailable` without posting a card, and tool search no longer names them as connectable. A card already in a chat shows that the integration can't be connected here instead of a Connect button. The rule is the one the Capabilities page already used to hide these entries, now shared as `deploymentCannotConnect` in `@opengeni/contracts/personal-integration-setup`. Integrations that are already on keep working and stay manageable. Catalog entries missing their operator OAuth client now carry a note saying so.
- 7ab60df: Connecting a model provider is now the same on the organization's Models page and on a workspace's: Connect provider lists the same providers in the same order (Codex, Claude subscription, SuperGrok, Azure OpenAI, OpenAI API, Anthropic API, OpenRouter, Vercel AI Gateway, Opper and Custom endpoint), each opening the same connect step. Only where the connection lives differs: organization owners and admins connect an organization account and choose its Available in; a shared workspace's admins connect Azure OpenAI, OpenAI and custom endpoints as that workspace's own keys from the same steps (they used to get a shorter list and a separate form lower on the page); anyone else sees API-key providers listed but disabled, with who can add them. The separate "OpenAI, Azure OpenAI and compatible endpoints" section is gone; a workspace's own keys are listed with its other accounts and disconnect from their row.

  Azure OpenAI is one step: endpoint, deployment name and key, checked together with a short test message before anything is saved, so it ends with a working model. Pasting any address Azure shows for the resource (Cognitive Services or Foundry endpoint, or a deployment's Target URI) reads as its `https://RESOURCE.openai.azure.com` endpoint, and a Target URI fills in the deployment name. OpenAI asks for its first model the same way.

  API: `PUT /v1/organizations/:id/model-providers/openai|azure_openai` accepts an optional `models` array (up to 16 model IDs or deployment names). Each is checked with the key (or Entra sign-in) in the request before saving, and they are saved with the connection in one transaction; other provider kinds refuse it with 422. Requests without `models` are unchanged.

- 7d86f8b: An organization can connect its own OpenAI-compatible endpoints (a public HTTPS base URL, an API key and model IDs) as organization model accounts, from the same Connect provider list as its OpenAI, Azure OpenAI, OpenRouter, Opper and Vercel accounts, with the same "Available in" step, and it can connect several. Their models reach workspaces like the other organization accounts, billed by the provider with no Opengeni credits, and every request to them stays DNS-pinned to public addresses without redirects. New routes under `/v1/organizations/:id/model-providers/openai_compatible/endpoints` list, connect, re-key and disconnect endpoints and add or remove their models; the SDK adds `listOrganizationCompatibleEndpoints`, `createOrganizationCompatibleEndpoint`, `replaceOrganizationCompatibleEndpointKey`, `revokeOrganizationCompatibleEndpoint`, `createOrganizationCompatibleEndpointModel` and `deleteOrganizationCompatibleEndpointModel`, and model connection access accepts `openai_compatible`. The first sign-in model step offers it too. Workspace-only compatible connections made before keep working and stay listed on their workspace; new ones are connected for the organization.
- f65d130: In-chat connect cards read as the service for reviewed integrations. The line under the name shows the provider ("Google") instead of a host name such as `calendarmcp.googleapis.com`, and a service without a logo shows its kind of content (a calendar or mail icon) or its word initials ("GC") instead of the first two letters of its name ("GO"). The setup dialog opens with the service's plain introduction and a short list of what the agent can do once connected, followed by one button. The host address, connection type, full catalog description and access summary move under a closed "Details" disclosure. Servers someone added by hand, and catalog entries nobody reviewed, keep their host name and "MCP server" label. `connectionCardSubtitle` is exported from `@opengeni/react/in-chat-connect-model` so other renderers can make the same choice.
- c8c10a8: A run with nothing for the person now leaves no trace for them. When a turn's answer is exactly `NO_REPLY` (for example an automation run that found nothing to do), the chat is not marked unread, no inbox reply item opens and no phone notification is sent. The run stays in the session's history. Migration 1289 changes the event cursor, inbox and push triggers; the web and native read-acknowledgement predicate follows the same rule.

  A finished turn's phone notification now carries its answer, the same text the chat shows, instead of "The agent replied."; a turn with no answer sends none. Events that arrive close together already start one run, so they give one answer and one notification.

  Internal IDs hidden from displayed system text no longer leave broken text behind. An ID now goes with what only named it: its label ("Organisation: <id>"), or a parenthetical that held only it ("(run <id>)"), and the punctuation around it is tidied, so "Connected. Organisation: <id>." reads "Connected." This applies to update summaries and to what an automation run's event says, on web and native.

- cd349e6: Voice replies play again when voice starts inside an open chat. The voice control hides until the voice-model catalog loads, and the hidden audio element went with it, so a call started there on a fresh page load had nothing to play its replies through: the transcript appeared but nothing was heard, and no prompt said so. The realtime controller now plays replies through its own audio element unless the host passes one (`remoteAudio` stays optional), so playback no longer depends on when a host mounts an element. `useSessionRealtime().audioRef` and `RealtimeVoiceControl`'s `audioRef` prop are kept but deprecated; rendering them has no effect.

  When the browser refuses to play replies, the voice control now shows a plain "Tap to hear replies" prompt beside the voice button; tapping it plays them.

- ba482ea: Archiving a chat no longer silently stops sub-chats that are still in use, and archived chats can be restored. Archive is refused (409 `session_archive_blocked`, blockers of kind `active_sub_chat`) while a sub-chat is running, waiting for input, working on a goal or was messaged by a person in the last 14 days; the refusal names each one with how many, and repeating the request with `confirmActiveSubChats` listing them archives them too. In the web app a notice names them and offers "Archive all". `{ "archived": false }` now restores a chat at any time: within the undo window it is the exact undo, and later the chat and the sub-chats archived with it come back, with content already in long-term storage put back from the verified bundle in the background (`retention.archive.restoring` until done). A restored chat whose running work the Archive stopped is put back to idle and resumed, so it takes new messages again; the turn the Archive cut off reads as interrupted. Archived chats show a "Restore chat" button.
- 42c5ebd: A running startup step in the chat timeline now says how long it has been running, updated every second in its title the way the turn header does ("Preparing runtime and model request · 1m 21s"), and a running environment setup step names the environment ("Setting up cloudgeni"). Before, a long environment setup showed only "Setting up sandbox environment" with no time, so a slow setup looked stuck. Startup phase items carry a new optional `subject`, the environment name from `rig.setup.*` events. Settled steps keep their final duration.
- 1010518: A chat's sidebar row no longer shows the paused icon just because some of its sub-agents are paused. The pause mark now appears only when the chat itself is paused (its own parked turn, or its pause holding its workers' work). Running, needs-you, failed and other sub-agent states still surface on the parent as before, and paused workers stay listed in the row's hover card and on their own rows.
- 5b15f1a: A Skill an agent saves for review now says plainly in the chat that it isn't in use yet. The collapsed "Review <name>" row is now a compact bar: the Skill's name, "New Skill · Not active until approved" (or "Skill update · Not applied until approved", or "Delete Skill · Can't be undone once approved") and inline Decline and Approve buttons. Clicking the name shows its description and files. Decline rejects the exact revision, as Knowledge > Review's Reject does, so the proposal leaves the chat and agents never use it. Approving or declining shows a one-line confirmation ("Approved · Agents can use it from your next message", or "Declined · Agents won't use it" or "Declined · The current version stays") that stays until the next turn and keeps focus on the card when the clicked button goes away. People who can't approve see no actions. The skill_save, skill_publish and skill_install descriptions and the skill-management Skill now tell agents that a Skill or change pending approval has no effect until someone who can manage it approves it, in Knowledge > Review or from its card in the chat where one is shown (an edited Skill keeps its current version until then), and to say so in their reply. The Skill tool descriptions, including skill_remove's, now name the review tab "Review", as the app does, not "Needs review".
- d355388: The Teams setup page (`/teams/connect`) now shows the API's own reason when setup is refused, such as "Only a Microsoft 365 Global Administrator or Teams Administrator can connect your organization…", instead of generic permission or conflict text. Setup and account-link refusals carry `details.code: "teams_connection_refused"` and a `details.reason`. When the installer's Opengeni account is already linked to a different Teams account in the workspace, setup says so and offers **Unlink and connect**: setup runs again with `replaceOwnLink: true`, and the API removes only the installer's own link, and only once the administrator sign-in and binding checks pass. A conflicting account link from the plugins page now returns a 409 with its reason instead of a server error. `@opengeni/react/ui/api-error` adds `serverRefusalText` and `apiErrorDetailCode`, so a page can show the server's own sentence for refusal codes it knows. The SDK's `teamsApi().installBot` takes an optional third `{ replaceOwnLink }` argument.
- d8e2bbc: Preserve organization billing notices through chat inbox updates, isolate cached inbox data across viewer changes, and include unread billing notices in inbox attention without changing chat counts.
- c82cbca: Claude subscription account rows in settings now show one tidy reading: the account's weekly limit. Model-specific weeks (such as Fable) and extra usage stay on the account's own page. The 5-hour window appears in the list only while it is reached or under 10% left. On Ultra plans (formerly Max 20x) the 5-hour window shows only while it is reached or under 10% left in the list, on the account page and in the chat account menu, since Claude still reports it and can refuse on it. Each row's limits share one grid, so labels, bars, values and reset times line up and nothing is cut off. New `subscriptionPlanWindows` and `subscriptionListWindows` helpers, an optional `plan` argument on `subscriptionAccountUsage`, and a `plan` prop on the web `ClaudeUsageReadout` and `ClaudeUsage`.
- 7f3617d: Selected text is clearly visible in dark and light themes. A new `--og-color-text-selection` token (a translucent blue) now drives the page selection, text fields (including the shared `Input` and `CopyField`, which had their own low-contrast selection colours), the code editor and the terminal. They used to take a translucent mix of the neutral grey accent, which in dark mode looked like one more grey surface. Hosts that want a branded selection colour override the new token; the selection no longer follows `--og-color-accent`. In the native composer, Android uses the token for the highlight, which was previously the opaque grey accent and left the selected text hard to read, while the caret and handles stay on the accent. On iOS the composer now uses the app's tint (system blue by default) instead of the grey accent.
- 60a67e6: A command waiting for a workspace machine that is being saved, replaced or moved now settles as not started instead of "side-effect outcome unknown". This covers, for example, a Modal box replaced because it could not start programs. The model and the person both see "The command was not started because the workspace machine was not ready. Nothing ran, so it is safe to run it again." A command that had already reached the machine keeps the unknown-outcome receipt. The command row in the timeline now shows such a receipt as its sentence instead of raw JSON.
- Updated dependencies [9bb1b56]
- Updated dependencies [7e92bda]
- Updated dependencies [71395d6]
- Updated dependencies [88de211]
- Updated dependencies [5dabaa2]
- Updated dependencies [d8e2bbc]
- Updated dependencies [276001c]
- Updated dependencies [0e8b3b2]
- Updated dependencies [90b961f]
- Updated dependencies [f12070a]
- Updated dependencies [56801f4]
- Updated dependencies [a505ce8]
- Updated dependencies [840a780]
- Updated dependencies [9d52126]
- Updated dependencies [2a02889]
- Updated dependencies [06606ef]
- Updated dependencies [888aaf5]
- Updated dependencies [b05587f]
- Updated dependencies [3345899]
- Updated dependencies [11550b6]
- Updated dependencies [d96bc4d]
- Updated dependencies [650e54a]
- Updated dependencies [7ab60df]
- Updated dependencies [e10e748]
- Updated dependencies [1b8dc89]
- Updated dependencies [7d86f8b]
- Updated dependencies [3f64150]
- Updated dependencies [486e0bf]
- Updated dependencies [cd349e6]
- Updated dependencies [ba482ea]
- Updated dependencies [6abf872]
- Updated dependencies [b1b8f58]
- Updated dependencies [6d81049]
- Updated dependencies [57748cf]
- Updated dependencies [04d36ce]
- Updated dependencies [3b81d9b]
- Updated dependencies [d355388]
- Updated dependencies [d8e2bbc]
- Updated dependencies [b9523c1]
- Updated dependencies [cf9358a]
  - @opengeni/contracts@6.11.0
  - @opengeni/sdk@6.11.0
  - @opengeni/connect@6.11.0

## 6.10.0

### Minor Changes

- fb37d99: A configured agent now pays only for what it can use on every model call. Under `capabilities: "none"` it gets a neutral introduction unless it shares a workspace, and no tool search when nothing is deferred. A configured session that cannot install the tool router (lazy tool search off for the deployment) no longer gets the Tool discovery guidance. It gets `wait_for_input` and its waiting guidance only when something can resume it (compute, children, goals, schedules, a browser, media, or a person who can answer). It gets no Skill index when it has no Skills. `request_human_input` offers the secret question only with `secrets`, Skill reviews only with Skill management, and parent-agent guidance only in child sessions. Prompt sections about web search, learning, monitoring, design choices with workspace tools and goal audits appear only with their capability. Two new capabilities, `notifications` (notify, withdraw, inbox tidy and call) and `privacyFacts` (`privacy_facts` and its prompt rule), are on under `"all"` and off under `"none"` for a session create request. Sessions stored before keep the tools they had, and saved workspace defaults and schedules that start from `"none"` keep both. The built-in meeting-summary and Site chats turn `privacyFacts` on and, with nothing that could wake them, no longer get `wait_for_input`. Sessions that have a feature get the same prompt as before; outside child sessions `request_human_input` no longer carries its parent-agent guidance. The model-context snapshot for the native Anthropic route now fills its instructions, layers and tools.

### Patch Changes

- 1fd358c: A command that fails because the chat's own cloud computer stopped answering no longer says "[connected machine] the machine is unreachable … the enrolled machine did not respond; it appears offline". It now reads "[cloud computer] the cloud computer this chat runs on stopped answering; it is most likely restarting". A command that never reached the box says nothing ran and to retry; one that was in flight says to check whether it took effect, fully or partly, before re-running it. A box that does not come back after a wake says so, that nothing ran, and to tell the person if a retry fails. Other machine-protocol faults from a cloud computer carry the "[cloud computer]" prefix. Connected Machines keep their existing wording. `isConnectedMachineOutcomeUnknownOutput` also recognizes the cloud computer receipt, so the timeline shows "outcome unknown" for it.
- d4bc733: Send no longer fails with "The message draft could not be saved before delivery" when the chat's draft changed under it. When the draft save before a Send is refused as "draft changed", the composer re-reads the draft: if it already holds the same text the message is sent, otherwise the person's text is saved at the current revision and sent, once. A tab that fell behind its own writes (a save whose reply was lost, or one that landed after the composer remounted) now catches up silently instead of showing "This draft changed in another tab". A real edit from another tab while typing still offers Keep mine / Use other draft, without the extra "Refresh and try again" line; Keep mine now saves over the other edit even if it changes again meanwhile.
- ed08f55: Machines and the Runs on menu now describe a computer the way a person picks one: "Mac", "Linux" or "Windows", and whether agents can use its screen ("Agents can use its screen", "Screen not shared", "No screen"), instead of "selfhosted · macos/aarch64 · headless". The exact system stays in the platform's tooltip. Inside the desktop app, the Runs on menu marks the computer the app runs on as "This computer". Settings → Computer use no longer shows switches that look off and can't move when a separately installed Opengeni Agent runs the computer: the screen and Chrome rows say what is in effect, from the workspace's machine list and connected browsers, and that the separate agent decides it. The warning that a change restarts the agent shows only where the switches work.
- b032ab0: Drain snapshot failures are now visible. The worker records each settled drain snapshot failure with the lease's consecutive failure count (`opengeni_sandbox_drain_capture_failures_total`, `opengeni_sandbox_drain_capture_consecutive_failures`) and the `/workspace` file count and bytes when a drain snapshot settles (`opengeni_sandbox_workspace_snapshot_files`, `opengeni_sandbox_workspace_snapshot_bytes`; from the archive itself, or one bounded walk after a failed provider snapshot). New alerts fire when one lease's drain snapshot fails a fourth time in a row (`OpenGeniSandboxDrainSnapshotFailing`) and when a sandbox has been stuck draining for over an hour (`OpenGeniSandboxDrainExpiredLong`, critical). When a lost sandbox is restored from an older verified save, every chat sharing it now shows a notice with the save's time; the model's existing discontinuity instruction is unchanged.
- dfe42f6: A proactive context compaction that runs as its own maintenance turn no longer leaves a "Working" row with a ticking clock when it is the chat's last turn. When the maintenance turn completes, its startup steps are dropped and only the "Conversation history compacted" landmark remains, as for a manual compaction.
- 6674146: A sandbox that can no longer start programs now gets a short, actionable message instead of a raw script. Before, when a machine's `/dev/null` had been removed (for example by a command that ran `rm -rf /dev/null` as root), every command failed with "not found: spawn or apply execution containment for …" followed by the whole command text, such as the Codemode client install script, and the chat stopped with that text as its error. Now the error names only the program that was started (the machine agent quotes it), never the command text, and tool output says the machine could not start the program and what to try. When the machine itself can't start programs (its `/dev/null` is gone), a compute sandbox is restarted from its disk once per turn (files are kept, running programs stop). The restarted turn continues, shown as "Workspace machine restarted". The box is checked first: unless a trivial program also fails to start, it is not restarted (another session sharing it may have restarted it already), and the turn retries as an ordinary sandbox wait; one missing program, or brief memory or process pressure on a machine other sessions may share, never restarts anything; if it still cannot start programs, or on a Connected Machine, the turn stops with a message that says what to do. The machine agent also keeps starting programs when `/dev/null` is gone: it keeps the null device open from startup and, running as root on Linux, puts a missing or replaced `/dev/null` back. Compute's control service gains `POST /v1/sandboxes/{id}/restart`, which boots a sandbox afresh from its disk keeping its files and shape.
- f45ab2f: Subscription accounts (Claude, ChatGPT and SuperGrok) now read the same everywhere they are listed. The "Use for next turn" account menu is wider and shows each account's full name and email, the plan once when every account shares it (or on each row when they differ), which account runs the next turn, and every usage window the provider reports with its short label ("5h", "Week", "Fable week", "Credits", "Extra usage"), the share left and when it resets. Nothing is assumed: a Claude Ultra or ChatGPT Pro account without a 5-hour limit shows none. Plans use the provider's current names ("Claude Max", "Claude Ultra", "ChatGPT Plus", "SuperGrok Heavy"), and a Claude Max account whose tier isn't known yet reads "Max or Ultra".

  Claude usage also follows the October 2026 plan changes: the usage endpoint's explicit `null` for a limit the plan doesn't have (a verified Ultra plan has no five-hour limit) no longer stops an early weekly reset from ending a refusal, while an omitted or `null` window still never clears a limit that refused; the separate weekly Fable limit (`seven_day_fable`) is read and cools only Fable models; and a renewed sign-in reads the plan and Max tier from the Claude profile.

- 9cf9b58: Refuse connected subscriptions for API-origin work, including scheduled and
  goal continuations, transcription and realtime voice, and skip them when choosing API defaults. Keep app
  subscription use fee-free and own-key billing configuration-driven. Clarify
  paid-plan and API pricing in the billing page, docs and bundled help.
- Updated dependencies [c9e5547]
- Updated dependencies [1fd358c]
- Updated dependencies [a143aaf]
- Updated dependencies [fb37d99]
- Updated dependencies [4fc9529]
- Updated dependencies [f619179]
- Updated dependencies [15763a2]
- Updated dependencies [b089060]
- Updated dependencies [116acad]
- Updated dependencies [e551a50]
- Updated dependencies [f45ab2f]
- Updated dependencies [9cf9b58]
- Updated dependencies [d717b72]
  - @opengeni/contracts@6.10.0
  - @opengeni/sdk@6.10.0
  - @opengeni/connect@6.10.0

## 6.9.0

### Minor Changes

- 8572155: The desktop app can remind you about a minute before a calendar meeting with a Google Meet, Zoom, Teams or Webex link: a card in the corner says "<title> · Starts in 1 min" with Join and start recording, which opens the meeting and records it, named after the calendar event. While another meeting is being recorded it offers Join and record this one. Only the active account reminds, each meeting once, and Settings → Computer use → Voice has a switch for it, with a link to connect a calendar when none is.

  New `GET /v1/workspaces/:workspaceId/upcoming-meetings` lists the caller's own meetings about to start with their join links (`listUpcomingMeetings` in the SDK). Creating a recording accepts `calendarEvent` (`{ provider, id }`), which names it after that event and is kept in `metadata.calendarEvent`. `createMeetingDetection` takes a `calendar` option and has `accountChanged()`, `refreshCalendar()` and `shutdown()`.

### Patch Changes

- 331bc5e: Scrolling the chat with the mouse wheel now works over a message with four or more annotations. The annotation stack no longer stops the scroll from reaching the timeline, so once the stack is at its edge, or has nothing to scroll, the conversation scrolls as usual.
- 54bf495: A paused chat no longer says it is working. Its turn row reads "Paused" with the clock stopped where the pause began, and switches back to working on Resume; paused time is not counted as work. This covers a chat's own Pause, a parent's and the workspace's. Sidebar rows mark paused work with a pause icon instead of the spinner, including a parent whose workers are paused, through the new `treeStats.pausedWorkDescendants` count. A sub-chat's descendant counts now also respect its ancestors' pauses. `MessageTimeline` in both `@opengeni/react` and `@opengeni/react-native` takes the live pause through its new `pause` prop (`timelineLivePause(session.effectiveControl)`); custom timelines can use `useTimelinePauses`.
- Updated dependencies [f1c6437]
- Updated dependencies [8572155]
- Updated dependencies [54bf495]
  - @opengeni/sdk@6.9.0
  - @opengeni/contracts@6.9.0
  - @opengeni/connect@6.9.0

## 6.8.0

### Patch Changes

- fbb70bc: The chat now stays at the bottom while you work through approvals. Clicking a button, such as Create draft, no longer unpins the view, so the next approval card and any later growth stay in sight. Scrolling up, selecting text or opening an in-place disclosure still lets you read without being pulled down, and finishing a connect card no longer pulls a reader who scrolled up back to the bottom. Each waiting approval also keeps its Decline and approve buttons while the turn resumes, and a card that can't be decided yet says so and retries instead of showing an empty footer.
- feaecf8: Send never does nothing without saying why. The new chat and open chat composers share one Send guard; whenever it blocks Send and no other notice already explains it, one short line under the composer says why, with at most one action. A model choice whose reasoning level or speed the account can't run (for example a saved Ultrafast speed after connecting a ChatGPT Free account, which offers GPT-6 Luna only) shows "This model can't run with the selected reasoning level or speed." with "Use supported settings". When an unavailable model is replaced automatically, the speed now follows the replacement. A Codex refusal of a model the ChatGPT account can't use ("not supported when using Codex with a ChatGPT account") is now treated as a plan refusal: that account skips the model for a while and the chat shows the plan error. Connecting a Codex account now lists the Opengeni models it offers, and warns when it offers none (`CodexConnectPoll.models`). A new chat the server refuses to start now keeps the reason under the composer until the message, model, reasoning level or speed changes, instead of only a passing toast, and the reason is specific (the model policy, an unavailable model, or a speed the model can't run) rather than "Check your input and try again". Session create refusals keep a typed `details.code` for an unavailable model and are logged with their reason and a message fingerprint instead of "unclassified". A device-code sign-in that has waited a minute now shows "Still waiting?" on every Codex and SuperGrok connect surface, not only onboarding; for ChatGPT it names the "Enable device code sign-in for Codex" setting under Settings → Security and login, which ChatGPT checks on its own page without telling Opengeni. A refused new chat words the refusals a person can hit instead of showing developer text: a model that isn't available to them (including "model is not selectable", now typed `details.code: "model_unavailable"`), and the workspace model policy (new `details.code: "model_policy"` with `reason` "credits", "provider" or "model", from the new `ModelPolicyRefusedError` in `@opengeni/contracts`). A refusal that arrives after the composer changed (more typing, or a voice link that set the model) falls back to the toast, so it is never silent, and a model policy refusal no longer offers a retry that would be refused again: every API route now types it as a nonretryable 422 with `details.code: "model_policy"`, including Send in an open chat.
- b393cac: Work-log steps whose text is cut off now open to show it in full, selecting their text no longer toggles them, and an open step has a Copy button. A chat's or Site's title can be copied by right-clicking it in the top bar (or a Site's title in the macOS window bar), and from the chat's "…" menu. Site rows and the Site page now offer what fits from a chat's actions plus the Site's own: Copy link, Copy title, Pin, Duplicate, Site details, Archive, Open published Site (once it is on the web) and Move to project on the row, and Copy title, Duplicate and Site details in a new "…" on the Site page, with Pin and Archive there too while the sidebar is open.
- Updated dependencies [58b04d1]
- Updated dependencies [feaecf8]
  - @opengeni/contracts@6.8.0
  - @opengeni/sdk@6.8.0
  - @opengeni/connect@6.8.0

## 6.7.0

### Minor Changes

- cb37e4d: A meeting being recorded shows in the desktop app's menu bar (the tray on Windows and Linux). While one records, the icon becomes a recording badge (a dictation under way still shows its own icon first), and the menu starts with the meeting: whether it records or is paused, for how long, its name (or when it started), and the account it records in when the window shows another. "Open Live Transcript" brings that account up and opens the meeting; "Stop Recording" stops it. Nothing about meetings shows while none records. `DesktopMeetingDetection.setRecording()` takes an optional `DesktopRecordingMeeting` (title, recorded time, paused), and `DesktopMeetingRequest` adds `{ kind: "open" }`, sent only to a page that described its recording. The meeting recorder in `@opengeni/react` describes its recording and opens it on `open`. `MeetingDetection` adds `recording()`, `onRecording()`, `openRecording()` and `stopRecording()`.

### Patch Changes

- 0d04cf4: Error toasts and messages no longer show "API 409:" or a request reference when a request is refused for a reason you can act on (a 4xx); they say only what to do. Unexpected failures (5xx, network, unknown) keep a short message. In the session UI's toasts, inline error text, notices and field errors their reference sits behind a quiet "Copy details" (or Technical details); toasts that call sonner directly still show it inline, as before. Toasts no longer show an error's raw text. Archiving a chat with "Keep this chat active" on now offers one action, "Turn off and archive", which turns the setting off and archives; Undo, or a failed archive, turns it back on.
- 57237db: Your GitHub keeps working past its token's 8-hour lifetime. Opengeni now asks GitHub for a JSON reply when it renews the token. Without that, GitHub answered form-encoded and every renewal failed silently. The connection still showed as connected, while Git and the `github_personal__*` tools failed with "authorization is no longer current" or "credential is unavailable".

  When GitHub refuses a renewal, which it reports as a successful response carrying an error, the connection is now marked as needing a reconnect instead of staying "connected". Temporary GitHub errors, such as `slow_down` or a server error, leave the connection connected and Git and the tools say GitHub is temporarily unavailable. The GitHub settings page shows "needs to reconnect" with a Reconnect button. A Reconnect toast stays until the person acts on it or closes it, and appears once per stale connection. Git and the GitHub tools say the person must reconnect. A repository list that couldn't load no longer reads "0 repos", and a background read that needs nothing from the person no longer shows a toast.

  Disconnecting Your GitHub always works for its owner. If the connection changed while the dialog was open, for example after a reconnect, Opengeni reads it again and disconnects the current one instead of asking the person to refresh.

- cf35731: Only the owner of a personal (Only me) login can approve an action that runs on it. An approval runs on the accounts its message froze, so before this any member, workspace API key or Slack click by someone else could make an action happen as another person. The owner's personal API key and `asUser` tokens count as the owner. Approving such an action as anyone else now answers 403 with `details.code: "APPROVAL_REQUIRES_ACCOUNT_OWNER"` and a message naming who can approve (the SDK adds `isApprovalRequiresAccountOwnerError` and `APPROVAL_REQUIRES_ACCOUNT_OWNER_CODE`); declining stays open to anyone who can control the chat, and actions on workspace logins keep their ordinary rules. A tool review adds the optional `approvedBy` ("you" or "account_owner") and `accountOwnerLabel` fields, and the review card says who can approve, or tells the owner in a shared chat that the decision is theirs. Slack cards for anyone else offer only Decline, and the desktop and mobile apps show or route a refused approval instead of failing.
- Updated dependencies [c08233e]
- Updated dependencies [cb37e4d]
- Updated dependencies [0d04cf4]
- Updated dependencies [57237db]
- Updated dependencies [cf35731]
- Updated dependencies [4a7da4c]
  - @opengeni/contracts@6.7.0
  - @opengeni/sdk@6.7.0
  - @opengeni/connect@6.7.0

## 6.6.0

### Minor Changes

- 62198d1: The composer's repository menu is clearer for someone opening it for the first time. It is for picking repositories: the "GitHub access" section with installs, per-installation links and unlink buttons is replaced by one "Manage GitHub access" row that opens the GitHub settings page, where every installation now also has its own Unlink (installations that are no longer active stay listed there, so they can still be unlinked). A switched-on repository says who it acts as ("Acts as You (@login)" or "Acts as Opengeni app") when your GitHub is connected, instead of an unexplained "As you" pill, and shows its branch once. With nothing connected, the menu offers Your GitHub (Connect) and, on hosted workspaces, the Opengeni app (Install), each with one plain line about what it means; an operator who hasn't created the app yet keeps Create app even when other repositories are listed. Repositories already in a chat show "In chat", with "To change the branch of a repository already in this chat, start a new chat." The menu has no "Refresh list" row any more: it updates in the background when it opens (at most once every 30 seconds), and whenever you come back within ten minutes of leaving for GitHub or the GitHub settings page (for a workspace admin, also syncing from GitHub); a failed load or a failed update of a shown list says so with an inline "Try again", and a failed load keeps "Manage GitHub access" reachable. Links to other app pages go through the app's navigation, so an embedded session opens them beside the host page. Change repositories on the GitHub settings page opens GitHub through a fresh link, one tab per click. `RepositoryContextPickerProps` gains `githubSettingsUrl`, `githubUpdateFailed` and `onLeaveForGitHub` and drops `githubAppOpen`, `onGitHubAppOpenChange`, `onConfigureInstallation` and `onDisconnectInstallation`; `useRepositoryCatalogRefresh` returns `onLeaveForGitHub`, and `markGitHubAccessChanged` (in `app/lib/github-access-return`) marks a return from pages outside the composer; the app context drops `githubAppOpen` and `setGithubAppOpen`.
- 2c76a2a: Each desktop dictation shortcut can pick its own speech-to-text model, such as one for English and another for Norwegian. The client config lists the models a dictation can use (`voiceInput.models`), a dictation recording may name its `providerId` and `model`, and it is then heard by exactly that model with no fallback to another provider. Escape no longer cancels a dictation, on the desktop or in the composer: only the Cancel button and the cancel shortcut do, so a stray Escape never loses speech or is taken from the app being typed in. The dictation window no longer draws a drop shadow around its pill.

### Patch Changes

- fb49abf: Connecting a built-in integration such as SharePoint, Outlook or OneDrive now finishes as soon as the person signs in: the provider's callback saves the account and adds every reviewed tool in one step, so nobody waits on "Finishing setup…" and closing the dialog, reloading or quitting the desktop app during the hand-back can no longer leave the account connected without tools. The Connect dialog closes itself and the Capabilities page says "SharePoint connected". The callback reads the reviewed tools before its short commit and finishes only what the person who started the setup could have installed themselves, with the same permission and member policy checks.

  If the callback cannot read the reviewed tools in time, the server keeps trying in the background. A setup still left with a saved account and no tools finishes the next time the person opens Capabilities or an in-chat setup card for it is shown, through the new `POST /v1/workspaces/:workspaceId/connect/attempts/finish` (`connectTransport().finishUnfinished`, `finishUnfinishedConnectSetups`); in chat, its tools then join that chat and the agent continues. This covers setups from before this release too, for 7 days after they started and even once their attempt has expired (it then moves from `expired` to `complete`; the transition report carries the previous state). Finishing applies the same rollout, permission and member policy checks as installing by hand, finishes one setup per account at a time, and never finishes a setup that a later setup of the same account replaced, so tools the person removed stay removed. Neither Capabilities nor the chat card waits for it. Closing the Connect dialog after signing in also lets the remaining setup carry on in the background (`continueConnectSetup`); `NativeConnectSetup`'s `onComplete` can therefore fire after `onClose`.

- 45f7296: A failed send no longer sits under newer messages and running tools. When the person has sent something newer, the failure keeps its place before that message, so it no longer looks like the latest thing they said. With nothing newer, it stays last, next to the composer.
- 80eb21d: Forking a chat at an agent reply that was sent through `wait_for_input`'s `reply` now works: the fork ends at that wait call and its result. Such replies were refused as "from before the conversation was compacted"; the remaining refusal for a message with no matching history point now says so plainly.
- 77bd008: Meetings are part of the ⌘K menu. "Meetings" opens the Meetings page, the newest meetings are listed before anything is typed, and typing finds meetings by title, by someone who spoke, by words said in them, or by when they happened ("yesterday", "friday", "30 oct", "last week", also in Norwegian). On a meeting's page, the menu offers "Ask about this meeting", which asks the typed question as the meeting's Ask field does, and "Copy meeting link".
- 1650d7c: The `@pierre/diffs` peer range skips 1.6.3, a release published with unresolved `workspace:*` dependencies that no package manager can install. Apps that install `@opengeni/react` with its peers no longer fail on it.
- 4930632: When no sandbox can be created or woken because the sandbox fleet has no free capacity (compute's "no host can take it now", or E2B's typed busy error), the turn no longer reports the chat model or its provider as unavailable. It now records `sandbox_capacity_unavailable`, shows "No sandbox capacity is available right now" while the same turn retries about once a minute, and says so again if the retries run out. Other retryable sandbox control service failures record `sandbox_service_unavailable`; refusals that retrying cannot fix record `sandbox_service_refused` and stop. A capacity failure inside a tool call, which previously stopped the turn with raw error text, now retries the same way, unless an uncertain sandbox action in the same failure forbids a replay. Other sandbox provider SDK failures that read as a model provider outage are relabelled as the sandbox service. The person-facing text for these failures never includes the sandbox service's raw message.
- 3cb05f9: Slack agents are now shown one way everywhere: `@Opengeni Data team`, with the name as the admin wrote it (`+name` still works). In a thread, a bare name switches agents only when it is the whole message or is followed by "," or ":", and a bare name stays in the request. New names need two letters and can't be sentence starters such as "Hi" or "Test"; one-word names get a warning. Chats hand off only when the person asks for the agent by name, and otherwise answer and may show "<Agent> handles questions like this." with an Ask button. Admins can pick an announcement channel for new agents, the intro page shows a live Slack preview, sorts and searches channels, and reports channels where Slack limits posting. Chats started from a Slack mention show the request without the mention of Opengeni, with other people shown by name.
- Updated dependencies [fb49abf]
- Updated dependencies [2c76a2a]
- Updated dependencies [09bc485]
- Updated dependencies [2e72a00]
- Updated dependencies [029497c]
- Updated dependencies [3cb05f9]
  - @opengeni/connect@6.6.0
  - @opengeni/sdk@6.6.0
  - @opengeni/contracts@6.6.0

## 6.5.1

### Minor Changes

- 8fb2596: In the macOS app, the window bar names the open Capabilities page (for example "Slack" or "New Slack agent") instead of always saying "Capabilities". The catalog stays mounted under an open page and its header kept the bar. `WindowBarTitleBoundary` takes a `fallback` prop: headers inside it take the bar only while no other header has a title.
- 3f9ef93: The agent knows both GitHub identities, and the GitHub sheet names them. `github_connect_link` adds a `personal` field for the person's own account ("Your GitHub"): `{ enabled, connected, status, login, repositoryCount, connectUrl, manageUrl }`, with links only for `connections:write` and no token; the App fields are unchanged. `capability_catalog_search` offers a new `api:github-personal` capability ("Your GitHub") when personal OAuth is enabled, and `capability_authorization_request` posts its in-chat card (connect, then choose repos). Agent guidance maps "connect my GitHub" or "do it as me" to Your GitHub and "install the GitHub app" to the Opengeni app. The repositories prompt lists each mounted GitHub repository's identity (as the person, with their login, or as the Opengeni app) and says that `gh` and raw API calls do not act as the person. The GitHub sheet shows two sections, "Your GitHub" and "Opengeni app", each with one action; the header's "Connect another account" is gone, and the repository chooser opens right after connecting. New exports: `PERSONAL_GITHUB_CAPABILITY_ID`, `PERSONAL_GITHUB_SETUP_QUERY_VALUE` and `personalGitHubSetupPath` in `@opengeni/contracts/personal-github`; `AgentPromptRepositoryIdentity`, `repositoryIdentitiesFor` and the `personalGitHubLogin` build option in `@opengeni/runtime`; and `IntegrationSection` with `IntegrationViewModel.sections` in `@opengeni/react`.
- 468e8c3: A meeting's transcript can be told how many people spoke. `transcription.speakers` (1 to 32) on a recording or a transcript re-run makes Opengeni's speaker detection find exactly that many on a recording with one track, and is each track's upper bound when the recording has several. Models with their own diarization get it as their speaker count. The meeting page's "Transcribe again" asks for the "Number of speakers", also for models that rely on Opengeni's speaker detection, and "Wrong number of speakers?" under the speakers list opens it.
- 7f3d037: A member of a shared workspace (`connections:write`) now removes the custom MCP servers they added themselves, with the new `DELETE /v1/workspaces/:workspaceId/capabilities/:capabilityId/installation` (SDK `removeCapabilityInstallation`). It removes the server's installation from the workspace; its catalog entry, connected accounts and any admin tool rules stay, and whoever adds it back becomes its installer. A server an admin or another person turned on, one with no recorded installer (every server from before this change) and one an admin turned off are removed only by integration admins (`capabilities:manage`), who remove any custom server; a member's other removal is refused with the usual `capabilities:manage` 403, decided on the locked row inside the removal transaction. The installer is recorded in the new `capability_installations.installed_by_subject_id` column (migration 1228, nullable, existing rows left empty). `GET …/capabilities` now returns `canRemove` for the caller on each catalog item, and the web app's connector page offers members "Remove from this workspace" from it; admins keep "Turn off for this workspace". Servers a plugin brings are removed with their plugin, a server the organization serves here is turned off here instead (`canRemove: false`, even once turned off), and servers configured in settings are not removable.
- f4f82c0: **My things** lists every one of a person's own logins, model subscriptions and machines in the organization in one place, grouped by kind, each with where it works. Opening one shows the same **Where it works** switches its own page has. It opens from the account menu and from Settings under Your account. Before, a person had to visit each connector, plan and machine to see which workspaces it worked in.

  `GET /v1/workspaces/:workspaceId/own-resources` returns the caller's own logins, then plans, then machines, each with its account or name, provider, reported plan and the same workspace list the reach endpoint returns. Only the caller's own things appear, and only kinds they may list. The SDK adds `listOwnResources`, and `@opengeni/react` adds `MyThings`; `useOwnResourceReach` accepts `initialWorkspaces` so a list can seed each row without reading it again.

- 317fb4d: A chat has one kind of archive. Archive now archives the chat for everyone, the same long-term storage the idle-session archive uses, instead of hiding it from one person's list. It needs session control. The chat leaves every list at once and the notice offers Undo for ten seconds; after that the chat's goals pause, its running work stops, its one-time automations are removed, and it is stored read-only for good. An archived chat stays readable, searchable and linkable, is listed on the Archived page (formerly Read-only chats, whose old path redirects), and offers "Continue in a new chat". Archive is refused with a plain reason while keep-live, a repeating automation or a site sign-in keeps the chat live.

  "Hide for me", Restore and the pause confirmation are gone. `PUT …/sessions/:id/archive` accepts `{ archived: true }`, and `{ archived: false }` only within the Undo window (409 `session_archive_final` after it); `mode`, `confirmPause`, `expectedVersion` and `clientEventId` are accepted and ignored. Refusals are 409 `session_archive_blocked` with `blockers`. `SessionList`'s Archive button (`archive` prop) does the same and shows its own Undo line. Chats people had hidden with the old personal archive are archived for real by the migration, unless something keeps them live; those come back to the list.

- 05ce0d6: Organization admins, like the owner, now manage the organization's vaults, organization-owned 1Password and other vault-provider connections, organization machines (approving, removing, command policy, screen control and agent updates) and organization Sandbox Environments. The rule is the organization's owner or an admin signed in as themselves, or a credential that holds `account:admin`; being an admin of one organization grants nothing in another. The Secrets, Sandbox Environments, device approval and machine pages show these controls exactly when the server allows them; device approval offers organization scope only to someone who also manages enrollments in that workspace.
- b18bd6c: Organizations can add an API integration once and choose where it works, the same way as an organization connector. An organization owner or admin checks an OpenAPI or GraphQL address, picks how turns sign in to it (each person with their own key or token, one organization key, or none) and which workspaces it reaches. The reviewed definition is stored with it, so every workspace it reaches runs exactly what the admin checked, and a change at the source needs a new check. In those workspaces it works like the workspace's own API integration and is listed under Custom APIs as **From your organization**. A workspace's own setup of the same API wins. A workspace manager turns it off there and back on, and a member adds their own key or token where it asks for one. New: `POST /v1/organizations/:organizationId/connectors/api-integrations/preview` (the SDK's `previewOrganizationApiIntegration`), `apiIntegration` and `apiKey` on `POST /v1/organizations/:organizationId/connectors`, `apiKey` on its `PATCH`, `kind` and `apiIntegration` on each organization connector, and `PUT /v1/workspaces/:workspaceId/integrations/:capabilityId/organization` (the SDK's `setOrganizationApiIntegrationHere`) to turn one off or on in a workspace. `ApiIntegrationInstallationSummary.organizationConnector` says when an installation comes from the organization. Migrations `1199_organization_api_integrations.sql` and `1200_validate_organization_connector_kind.sql` add `organization_connectors.kind` and validate its check.
- 83ccc2b: Organization machines and sandbox environments work in the workspaces the organization's owner or an admin picks: every shared workspace or chosen ones, plus a switch for members' Personal workspaces, with the same "Available in" picker as the organization's model keys and connectors. The workspace a machine was connected from, or a sandbox environment was made in, always has it, and existing ones keep working everywhere they did. New `PUT .../machines/:enrollmentId/reach` and `PUT .../rigs/:rigId/reach` routes, `updateMachineReach` and `updateRigReach` in the SDK, and `reach` on organization machines and sandbox environments.

  Fixes organization sandbox environments failing in chats outside the workspace they were made in ("query returned no rows" when a turn started).

  A sandbox environment's page offers changes to an organization sandbox environment only to the organization's owner or an admin, as the API requires. Before, members who manage sandbox environments saw actions there that were then refused.

- dd7759c: A person's own logins, model subscriptions and machines each show **Where it works**: every workspace the person belongs to in the organization, with a switch for each. It replaces the single "Use for my messages here" switch, so a person can see and change every workspace from one place instead of visiting each. Logins and subscriptions always work in the Personal workspace; a machine can be turned off there too. The machine page shows the list under "Who can use it?".

  `GET /v1/workspaces/:workspaceId/own-resources/reach?resourceKind=&resourceId=` lists the workspaces, Personal first, each with `on`, `alwaysOn` and `canChange`; `PUT` on the same path with `{ resourceKind, resourceId, on }` turns it on or off in that workspace through the existing standing personal-resource grants. `resourceKind` is `connection`, `subscription_connection` or `connected_machine`. Anything that isn't the caller's own answers 404; turning a login or subscription off in the Personal workspace answers 422. The SDK adds `getOwnResourceReach` and `setOwnResourceReach`, and `@opengeni/react` adds `OwnWhereItWorksSection`, `OwnWhereItWorksCard` and `useOwnResourceReach`, plus a `whereItWorks` slot on `MachineDetail`.

- 9d08d81: The settings sidebar now looks and behaves like the session sidebar. In the macOS app it shows the same window glass instead of a flat opaque panel, with no line between it and the window bar; it is as wide as the session sidebar, including a width you dragged it to; and the empty space beside the Opengeni logo moves the window. Both sidebars are drawn with the new shared `rail-surface` pieces (`ShellRail`, `RailSurface`, `RailBrandRow`, `RailBrandMark`, `RAIL_BRAND_LINK_CLASS`).
- 6826a21: In the macOS app, a Site's "Publish to web" page names the window bar instead of keeping the Site's name there. `useWindowBarTitle` takes an optional `fallback` flag: the claim then yields to any other header with a title, as headers in a `WindowBarTitleBoundary fallback` do. When the Slack workspaces can't load, the Slack page and its new agent form say so, with Retry, instead of asking to add a Slack workspace.
- cf6c808: Slack agent pages: creating, editing and introducing an agent keep the page gutter instead of touching the sidebar, the icon is a button next to the name that opens the picker, and editing links the agent's Memory in Knowledge. Create now works when the Opengeni bot loads after the form opened, and says why it can't when no Slack workspace is connected. Deleting an agent says its Memory stays. New `SessionAvatarPickerButton`; the avatar picker's kind switch and icon grid no longer stretch across the form.
- abb4af1: Slack agents: named teammates people call through the Opengeni Slack app with `@Opengeni +name`, each with an icon, a description, a fixed workspace, instructions and a shared Memory. Adds the Slack agent contracts and admin API (`/integrations/slack/agents`), SDK client methods, `slackAgentId` on Slack channel routes, the `slack_agent_handoff` and `slack_agent_chats` tools for Slack-started chats, and the "Slack agent" chip. Installations without agents behave exactly as before.
- c17e9a6: Sub-agent chats you work in are now easy to get back to. Control+Tab lists every chat you opened recently, sub-agent chats included (the chats it carries on with after those stay your own). In ⌘K, recently opened sub-agent chats join Recent chats, and a search lists up to three matching sub-agent chats in their own group below the chats, including ones only the server found; the server's chat search now covers top-level chats separately, so a workspace full of sub-agent chats cannot push them out. Pinning a sub-agent chat makes it one of your own: it lists like any other chat in ⌘K, Control+Tab and the home screens' pinned chats. Wherever a sub-agent chat shows in these lists it says which chat it belongs to ("in Release lead"); the app reads the parent's title when it doesn't have it and remembers it with your recent chats.

### Patch Changes

- 485069a: Every artifact offers Copy link where it is open, as a chat does: in a chat's artifact panel, on a file, image, document, spreadsheet or presentation page, on a Site's details and in the Site view. It copies the artifact's own address and says "Link copied".
- 7de2adf: Connector cards show a well-known service's own name and logo instead of its raw hostname and a letter, for example "Google Search Console" with its mark and a "Connect Google Search Console" button. The catalog overlay gains `identities` (name, logo and homepage only) for 164 services including every Google API row, and generated letter placeholders from integrations.sh are screened out so the product's own monogram shows instead. `validateLogoAsset` rejects such placeholders when called with `rejectGeneratedPlaceholder` (the catalog import and vendoring paths); a custom MCP server's own declared icon is accepted as before. A re-import clears a stored catalog logo once its row has no logo by policy (`RegistryCapabilityCatalogItemInput.clearLogoAsset`). The setup card no longer repeats a subtitle identical to its title. The SharePoint and OneDrive setup cards show their Microsoft marks instead of a letter, like Teams and Outlook already did.
- 52403f0: In a chat shared with the workspace, the note about your own logins is now one quiet line above the composer, "N personal connections in this chat", counting the accounts that are on. It opens a menu that says people in the workspace see what the agent does with them, with one switch per account; turning one off stops it for your messages in this workspace, and it stays in the menu so you can turn it back on. Many accounts scroll. An account connected more than once is listed once, and its switch covers every connection of it; accounts that only share a display name stay apart.
- a8273ce: The in-chat GitHub card lets a chat use repositories from any number of GitHub App installations, as the composer picker already does; it no longer says "This chat already uses another account's repositories. Start a new chat". `github_connect_link` also returns `settingsUrl`, a console link to the workspace's GitHub settings, so the agent can point a person to **Install on another account** when its own grant cannot mint the install link.
- d5ce7de: Transcribing a meeting again also writes its notes again when nobody has touched them. Before, the built-in summary only ever wrote a meeting's first notes, so after a re-run the notes still described the transcript the re-run replaced, for example claiming one speaker after the new transcript found two. Now a re-run starts the built-in summary when the notes were last saved by an earlier summary chat of the same meeting in which every turn was the service's; `meetingSummaryCandidate` returns their revision as `replacesRevision`, and `meetingSummaryPrompt` takes it, telling the chat to save over exactly that revision and to keep anyone else's notes. Notes a person edited, an automation wrote, or someone talked to the notes chat about are never replaced. A first summary's message is unchanged. The Transcribe again description says so, under new message keys (`meetings.detailPage.makesANewTranscriptNotesToo`, `native.meetings.meetingView.aNewTranscriptAndNotesToo`) so hosts translate it again.
- da9b7e5: Members of an organization can now see who else is in it, by name. `GET /v1/organizations/:organizationId/member-names` (SDK `listOrganizationMemberNames`) returns `{ available, members }`, where each member has only a membership `id`, a display `name` (or `null`) and `you`. Any active owner, admin or member acting as themselves can call it; outsiders, suspended and offboarded people get `403`. Product users (`external_user:`), services and keys are never listed, and emails, roles, status, invitations, workspace access and usage stay with the owner and admin directory (`/members`), which is unchanged. In the console, a member's People settings page now lists everyone by name with a search. Migration 1211 creates the `list_organization_member_names_v1` database function without granting it to the runtime yet, as the two-release rule requires; until a later migration grants it, the route answers `available: false` and the People page says only owners and admins can see who is in the organization.
- 0f7f559: A person's own (Only me) logins work for their messages where they turned them on. In their Personal workspace every own login works; in a shared workspace a login works once its owner turns it on there. A login starts on in the workspace it was added from, and connecting or reconnecting the same account from another shared workspace turns it on there too. Logins that existed before start on in every shared workspace their owner belongs to, so nothing that worked stops working.

  When a chat asks for a connector whose login the person added in another workspace, the Connect card offers it with one click ("Use it here") instead of a new sign-in. Each own login on a connector's Capabilities page has a "Use for my messages here" switch. In a chat shared with the workspace, the owner sees a one-line note that their logins work for their messages there and that people in the workspace see what the agent does with them, with "Stop using it here"; it never blocks a turn.

  Being turned on is a standing personal-resource grant: user-resource kind `connection` with action `connection.use`, issued with mode `always` and context `workspace_shared` and revoked like any other grant; other modes are refused for logins. `ConnectionMetadata` gains `turnedOnHere` and `turnedOnHereGrantId` on a person's own accounts. Logins that are off in a workspace are not attached to turns there. Personal GitHub keeps its own per-chat repository choice.

- 0f7f559: A turn uses its person's own Codex, Claude or SuperGrok subscription first, where they turned it on. In their Personal workspace it is always on; in any other workspace each person turns their own account on for the messages they send there, in shared and Only me chats alike, and it then pays before the organization's accounts. Other people's turns never use it, and turns without a signed-in person (scheduled and service turns) don't either. An account added from a shared workspace starts turned on there, and each account's page has a "Use for my messages in …" switch per workspace.

  Being turned on is a standing personal-resource grant: user-resource kind `subscription_connection` with action `subscription_connection.use`, issued with mode `always` and context `workspace_shared` in that workspace and revoked like any other grant. Acceptance freezes the account into the turn as consent restricted to that session and connection, and in shared chats the database refuses an automatic binding to a personal account without it. `issueUserResourceGrant` moves to the base and browser clients, beside `listUserResourceAuthorities` and `revokeUserResourceGrant`.

  The per-person personal-fallback opt-in and the organization's "personal fallback allowed" setting are retired: both are still stored and returned, but no longer change which account pays, and the settings page no longer shows them. Existing opt-ins are not converted, because that would widen where an account is used.

- de8fc61: Own subscriptions (Claude, Codex/ChatGPT, SuperGrok and any other connected subscription) no longer pay the 5% platform fee; own API keys (provider, gateway or custom endpoint keys) still pay it from paid credit as before. With Stripe billing and subscription plans enabled, using an own subscription needs a paid plan of at least $20 a month (Pro, Max or a custom plan, active or trialing), which then allows unlimited subscription use alongside the plan's normal credits. On the Free plan, without a plan, or on a past-due or canceled plan, an own-subscription call is refused before it runs with `402 subscription_plan_required`, "Upgrade to Pro to use your own subscription." and one Upgrade to Pro action; existing connections stay connected, are not picked as the default model for new chats or scheduled tasks while the plan does not allow them, and work again after upgrading. During a rolling deploy, workers still on the previous release may charge the fee on a subscription turn until they are replaced. Scheduled runs skip the occurrence and goals pause on credits. Internal accounts on legacy billing terms stay exempt. New exports: `ownModelFunding`, `ownSubscriptionPlanAllows`, `planAllowsOwnSubscriptions`, `ownSubscriptionPlanRequired` and `checkOwnSubscriptionPlan` in core, `getOrganizationPlanStanding` in db, and `SUBSCRIPTION_PLAN_REQUIRED_CODE`, `SUBSCRIPTION_PLAN_REQUIRED_MESSAGE`, `OWN_SUBSCRIPTION_MIN_PLAN_PRICE_MICROS` and `planIncludesOwnSubscriptions` in contracts. The web app shows the refusal with one Upgrade to Pro action (React gains the `subscription_upgrade_required` refusal kind and `isUpgradeRefusal`), Pro and higher plan cards say "Your own AI subscriptions, no fee", and the billing page's fee line reads "Platform fee on your own API keys". See `docs/billing-origin.md`.
- c77bf12: A chat whose agent has replied shows the unread dot in the sidebar even while its sub-sessions are still working or it waits on them, instead of a spinner or hourglass that hid the reply. The dot's label keeps the work ("1 unread · 2 working"), and expanded worker rows keep their own spinners. The chat's own running turn keeps its spinner. Anything that needs you, a failure or an unsent message still comes first; the command menu and Control+Tab switcher show the same marker.
- b4eeaf6: Claude and SuperGrok chats show the subscription account menu in the chat header again, with each account's usage, the same way Codex chats do. The header chose the provider from the model's `credentialSource`, which the workspace model catalog never sends, so only Codex (recognised by its model id) ever got a menu. The provider now also comes from the Claude subscription model and provider ids and the model's public rail. The same fix makes the model details name Claude subscription billing instead of Codex. Each account row in the menu also has a small bar for its most-used usage window again, next to the usage text.
- 0f7f559: A workspace's own Codex, SuperGrok or Claude subscription can now serve other shared workspaces and stays that workspace's. Its workspace's admins can add workspaces they also administer and remove any, from the account's "Where it can be used" page; an admin of a workspace it serves sees it as "Shared by" its workspace and can remove it there (new `DELETE /v1/workspaces/:scopeId/model-connections/:kind/:connectionId/access`). Organization admins can choose any shared workspaces for it and it keeps its owner; choosing every shared workspace, Personal workspaces or people now needs an explicit `moveToOrganization: true`, which the organization page confirms as "Move and save". Account summaries gain `ownerWorkspaceId`.
- Updated dependencies [f1998df]
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
- Updated dependencies [4682263]
- Updated dependencies [52c8c3b]
- Updated dependencies [52c8c3b]
- Updated dependencies [52c8c3b]
- Updated dependencies [abb4af1]
- Updated dependencies [86e35f1]
- Updated dependencies [0f7f559]
  - @opengeni/contracts@6.5.0
  - @opengeni/sdk@6.5.0
  - @opengeni/connect@6.5.0

## 6.4.0

### Minor Changes

- 92f419c: The billing page shows plan credit and credits as separate balances and the month's "Platform fee on your own keys" as its own line. A refused own-key call on the Free plan says "Upgrade to Pro to use your own key" with one Upgrade to Pro action; otherwise it says "Add credits to use your own key", and a refused API-origin call says "API usage uses credits, not your plan credit. Add credits to continue.", each with one Add credits action and no model-switch suggestion; a member without billing access is told to ask an organization owner. The credits dialog opened for or beside an own-key refusal offers no coupon, since coupon credit can't pay the own-key fee; a member's refused send says to ask an organization owner too (`useComposer` takes an optional `canBuyCredits`, default true, and returns it so the `Composer` notice uses the same wording). Upgrade to Pro controls report the new `upgrade_plan` analytics action. Remaining "Buy credits" labels now read "Add credits". A chat stopped between model calls names the same fix; the new `creditRefusalFromEvents` reads it from the last turn end. The Plans section states the subscription and API pricing lines. `BillingBalance` in the SDK gains `creditsMicros`, `apiDebtMicros`, `paidPlanCreditMicros`, `paidCreditsMicros`, `byokPlatformFeeMonthMicros` and `byokFeeDebtMicros`.
- bc5c6d5: More connections now know which account they belong to, so you can connect several accounts of the same service and connecting the same one again reuses it.

  - **New identity checks.** Linear (its `get_user` "me" tool), Notion (the token's workspace and user, or `notion-get-self`), Asana (`get_me`) and Stripe (`get_stripe_account_info`) identify the signed-in account, and are labelled with its email, name or workspace. Any other service whose authorization server advertises OpenID Connect (for example PostHog, Zapier, Vercel, Mobbin, PagerDuty and Dropbox) is asked for `openid` and `email` with a nonce, and identified by a verified `id_token` or its userinfo endpoint. These scopes are never added where the server doesn't advertise them. Every check is bounded and never fails the connection.
  - **One account per person for services that can't say.** When a service doesn't tell us which account you signed in with, each person sees at most one connection to it: a second one, a personal one beside a shared one, or a shared one beside your own is refused with "This service doesn't tell us which account you signed in with, so you can connect one account. Disconnect it to use a different one." (`account_limit_one`). Other people's personal connections never block yours. A connection made before its service could be identified must be reconnected once before another is added (`account_reconnect_required`).
  - **Yours and Shared.** Connected accounts are labelled "Yours" or "Shared" (was "Only me" and "This workspace") in account lists, pickers and the composer's Connectors menu, and agents see `<connector> — <account> · Yours` or `· Shared`, so a personal and a shared connection never look the same.
  - **API.** OAuth MCP connections in connection lists include `accountIdentity`: `verified`, `reconnect` or `single`. In `@opengeni/react`, `addAccountLimit` and `ADD_ACCOUNT_LIMIT_COPY` mirror the rule, and the connector page hides Add account with that sentence where the rule applies.

- b4e780e: Meetings from audio recorded elsewhere, such as a phone call recorded with the phone's own record button or a voice memo. Share it to the app, or pick it with the phone Meetings list's new Import a recording button, and it becomes a meeting with a transcript and notes. It is saved on the phone first and uploaded in the background.

  - `useRecorder().importAudio(...)` (React) makes a meeting from a file.
  - `@opengeni/react-native/meetings` adds `useSharedAudioImport`, `sharedAudioRedirect` for expo-router's `+native-intent`, `importAudioFile`, and the config plugin option `audioImport: true`. With that option, iOS accepts audio documents and Android shows the app under "Open with" for audio.
  - `uploadRecordingAudio` reads an M4A file's length and recording date from its header when they aren't given (`audioFileDurationMilliseconds`, `audioFileCreatedAt`), and its recording now ends after the audio's length rather than when the upload started.

- 06adef4: Meetings: a workspace can list names and words every meeting transcript listens for, such as people, customers, products and trade terms ("Words to listen for" in meeting settings, `recordings.keyterms` in workspace settings). A recording's own keyterms come first, each word is sent once, and the list stops at the 100 a request takes. Re-runs use the list as it is then. Desktop dictation's vocabulary uses the same shared field.
- ace882b: Members of a shared workspace (`connections:write`) can now add integrations: install and remove plugins and API integrations, add custom MCP servers, turn on any catalog integration that is not on yet, configure integration sources, finish an agent-prepared MCP key setup, and connect a workspace-owned OAuth MCP account from the chat card. Integration admins (`capabilities:manage`) still own tool approval rules (Allow/Ask/Block), auto-approval (`autoApprovedTools`, an explicit `requireApproval` other than `true`), changing an integration that is already on, and turning one off for everyone. A member's add is create-only, checked inside the install transaction: it never updates a plugin, an API integration instance or its revision, never rebinds or reconnects a shared account, and never rewrites or turns back on a server an admin set up or turned off (a plugin that would is refused with 403; retrying or resuming one's own install still works). Members can remove what an admin added. The organization integration allowlist still applies, and an organization that sets `personalIntegrationSetup: "admins"` keeps turning integrations on for admins; the workspace catalog now returns that setting as `memberIntegrationSetup`, and the web app, chat cards and the agent's setup check offer members only what the API accepts. New exports: `INTEGRATION_SETUP_PERMISSION` and `canAddIntegrations` (contracts), `requireIntegrationSetupAuthorization`, `hasIntegrationSetupPermission` and `hasIntegrationAdminPermission` (core), `MemberIntegrationSetup` (contracts), `canAddWorkspaceIntegrations`, `canManageWorkspaceIntegrations`, `canChangeWorkspaceIntegrations` and `canConnectWorkspaceMcpFromChat` (react), and `CreateCapabilityCatalogItemInput.createOnly`, `InstallApiIntegrationInput.memberCreate` and `IntegrationChangeRequiresAdminError` (db).
- dcb2352: An organization's owners and admins can now choose whether members connect machines of their own. Organization settings → Security & data has a "Members connect their own machines" switch, on by default. Through the API it is `membersConnectOwnMachines` on `GET`/`PATCH /v1/organizations/:organizationId/privacy-settings`, changed by the same owners, admins and administration-capable organization keys as the other privacy choices.

  Off, only the organization's owners and admins connect a new Only me machine, or any machine in a Personal workspace. Workspace permissions don't lift it. Minting a connect command and approving a pairing code answer `403` with a plain sentence; declining a code still works. Shared-workspace and organization machines keep their existing rules, and machines already connected keep working and stay their owners' to change or remove.

  `GET /v1/workspaces/:workspaceId/machines` now reports `canConnectOwnMachine` for a person (omitted for an agent listing its own chat and by older servers), and `useWorkspaceMachines` exposes it. `ConnectMachineDialog` takes a `canConnectOwnMachine` prop: false disables Only me (and This workspace in a Personal workspace), skips the this-computer path, and explains who can connect when nothing is left.

- f3e6835: Documents, spreadsheets and presentations can be Only me, like chats, Sites and files. One made by an agent in an Only me chat, or imported from an Only me file, starts Only me; everything else, including every existing one, stays shared with the workspace. An Only me one opens only for its owner and for agent turns acting for them or running in their own Only me chat; colleagues, workspace administrators, keys and services cannot read, edit, export or open it live, and the artifact library does not list it for them. A file an agent exports from it is Only me for its owner, even from a shared chat. Only the owner changes the audience, from the app: `PUT /v1/workspaces/:workspaceId/editable-artifacts/:artifactId/visibility`, the SDK's `updateEditableArtifactVisibility`, or the document's Artifacts menu. Create and import accept an optional `visibility`; editable artifact responses and catalog items carry `visibility` and `ownedByViewer`. A Site made in an Only me chat by a run without a person, such as a meeting summary, now stays Only me under the chat's owner. Rolling migration `1160_editable_artifact_audience.sql`.
- 0b19c29: A person's Only me meetings and files work where they turn them on: in the workspace that stores them and their Personal workspace, plus the other workspaces they pick (`reachWorkspaceIds`, or `null` for all of them). New ones start in those two; meetings and files from before keep working everywhere they did. Meetings change it with `updateRecording`, files with the new `client.updateFileReach` (`PUT /v1/workspaces/:workspaceId/files/:fileId/reach`). The meeting page offers it as **Available in…** when the host passes `reachWorkspaces`, and a file's page offers it in its audience menu while the file is Only me.
- b098518: Projects can be Only me, like chats. `Channel.visibility` is `workspace` (seen by everyone in the workspace, as every project was before) or `private`: seen only by its owner and agent turns acting for them, holding only that owner's own Only me chats and Sites, with a name that is unique only among their Only me projects. `CreateChannelRequest.visibility` chooses it; omitted, a person's project is shared and an agent's `project_create` follows its chat, Only me when made in an Only me chat. Its owner shares it with `UpdateChannelRequest.visibility: "workspace"`, from a signed-in person only; nothing makes a shared project Only me. Filing another kind of chat or Site in an Only me project is refused with 422, and a chat or Site that later becomes shared leaves it. In the app, New project offers "Who can see it" where Only me chats are allowed, the sidebar marks Only me projects with a lock and offers "Share with workspace…", and choosing an Only me project for a new chat makes that chat Only me. Rolling migration 1161.
- a853c7a: Organization admins now manage the organization's Knowledge, documents and their backfills, organization Skills and the preference registry, the company profile and its agent policy, and can list the organization's sessions, as the owner does. Admins can also choose organization documents as the destination for connector syncs (Atlassian, Google Drive, Slack). The rule is "owner or admin of this organization", proven by the signed-in human session; admins don't get `account:admin`, so billing, roles, ownership and deleting the organization stay owner-only, and admin rights in one organization never apply to another. Agent turns started by an admin can propose and confirm company-profile changes (migration 1096). The web app shows these controls to admins exactly when the server allows them. New `@opengeni/core` helpers: `holdsOrganizationAdministration`, `authorizationHoldsOrganizationAdministration` and `requireOrganizationAdministrationStamp`.
- a7b05f9: Organization settings > Integrations lists the organization's connectors: owners and admins add one from the catalog or by server address, choose how people sign in and where it works, turn it off everywhere, change where it works, replace its key or remove it. A connector a workspace turned off shows **Turn on for this workspace** on its page.
- 237329e: A person's own connected machine now runs that person's own turns in every workspace where they have it on, in private and shared chats alike, without asking again each chat. A machine is on in the owner's Personal workspace, in the workspace it was connected from (until the owner turns it off there), and in any workspace where the owner allowed it with standing permission. The first use where it is on by default records that standing permission, so the owner can turn it off later. Another person's turns still never run on someone else's personal machine; they keep waiting for the owner, unchanged.

  Allowing your own machine from a chat's machine card, or moving a chat to it, now turns it on in that workspace from then on, and the card says so; in a shared chat it also notes that people in the workspace see what the agent does there. `disallowAgentsOnComputer` in the SDK now turns the computer off in a workspace even where it was on by default. The refusal reason and setup blocker for a personal machine say that its owner has not turned it on in this workspace.

- cdb9d27: Agents answer privacy, retention, training and "where does it run" questions from server facts. The new always-visible `privacy_facts` tool reports the chat's model, provider route and how it is paid for, the route's declared region, whether the workspace is EU-only, the provider's training, retention and processing location from one reviewed table with source links and the date checked, Opengeni's own retention facts, where the deployment hosts app data and where this chat's sandbox runs, and the deployment's privacy policy, subprocessor list, terms and support contact. New optional settings `OPENGENI_DATA_HOSTING_LOCATION` and `OPENGENI_LEGAL_SUBPROCESSORS_URL` declare the hosting and subprocessor list; unset, they are reported as unknown and the agent is pointed to the privacy policy. Unknowns are stated as unknown. The operational contract tells agents to call it for these questions and answer only from it.
- aaf1758: One "Available in" control, with its owner and who manages it, for every shared thing: model accounts, Connect provider, vaults and the Slack bot. The vault editor now says organization owners manage organization vaults.

### Patch Changes

- 106652b: A member's share of a workspace usage allowance (`equal_share` or `{ share }`) is now a share of the period's whole pool, the same amount as the workspace limit: included credits plus grant credits spent this period plus those left. Before, it was a share of included credits plus the grant credits still left. So every credit anyone spent from a grant lowered every member's limit (for example 19,998 became 19,997), and in a workspace funded only by grants, an equal share of two ran out at about a third of the credits. Usage reads, admission, threshold and exhaustion notifications and `UsageMemberList`'s percentages now agree. A member's share stays steady through the period, rises when credits are bought and starts again from what is left in a new period.
- 75d3c08: Available here also lists the organization's connectors that reach the workspace, each saying whether people sign in with their own account or share the organization's key (one the workspace turned off is left out; one whose organization setup is broken is marked unavailable), and, in a Personal workspace, the Only me connectors carried in from other workspaces.
- de928fa: Workspace settings has an Available here page: everything agents in the workspace can use (connectors, machines, rigs, vaults, Skills and Knowledge), grouped by whether it belongs to the workspace, is shared by the organization or is your own, with who manages each and a link to its page. `WorkspaceSettingsSection` gains `"available"`.
- 000c023: Calls on a person's own provider key or subscription pay a platform fee (`OPENGENI_BYOK_PLATFORM_FEE_BPS`, default 500 = 5% of the list-price equivalent; custom endpoints with no list price use $1.25/$10 per million input/output tokens) while credit billing is active. The fee is payable only from paid credit: a paid plan's credit for app use, then topped-up or operator-granted credits that ordinary spending has not used (it draws promotional credits first). Free, signup and promotional credit never pay it; without paid credit the call is refused with `402 byok_paid_credit_required` and one action: Upgrade to Pro on the Free plan in the app, otherwise Add credits. Paid credit counts a coupon top-up net of its discount, and a past-due plan or leftover Free period never pays the fee; each fee and each top-up, grant or refund records on its row what it did to paid credit, and each receipt carries running totals, so the balance read takes paid credit and fee debt from the latest receipt (through the new partial index `credit_ledger_receipt_rows_idx`): it does not grow with the number of fees, and accounts with or without fees read their balance as fast as before. Fee debt is never repaid by plan or promotional credit; the next top-up repays it first. Migration 1129 (rolling) makes `plan_period_usage` count only the plan-paid part of a fee and lets `plan_app_general_balance` keep API debt and unpaid fee debt (not fees paid in full) out of plan credit, matching the app's balance; migration 1130 builds the index concurrently. The web app shows these refusals as credit stops. See `docs/billing-origin.md`.
- 1e0a7ed: Projects you collapse in the chat list stay collapsed after a reload. The app remembers the collapsed projects and groups per person and workspace on that device. New projects still open by default, and moving a chat into a collapsed project still opens it. The new `useCollapsedSessionSections` hook in the app's browse preferences holds this state.
- 641fd9e: Two messages sent in quick succession from the composer (Send, then Steer or another Send while the first is still on its way) now both arrive, in order. Before, the second message's draft save could land between the first message's save and its submit, so the server refused the first with "Submitted content is not the saved draft" and the person saw a conflict error with a failed bubble. A durable send now holds the chat's draft slot from its save through its submit; autosaves and other sends wait their turn.
- e132b96: The first-party tool picker options are built on first use instead of when the module loads, so the web build's chunk evaluation check no longer fails when other changes shift which chunk owns the tool name list.
- 9416f77: In the macOS app, every page now uses the same window bar as a chat: the sidebar toggle beside the traffic lights and the page's title in the bar, on settings, content pages, detail pages, the new-session page and the playground. Settings can collapse its sidebar from the bar.
- 952d1d9: "Transcribe again" estimates the cost of every recorded track. A meeting with a microphone and computer audio is transcribed and billed once per track, but the estimate priced only the meeting's length, so it showed half the real cost. The hint now says when a meeting has several tracks. Adds the `meetings.detailPage.aboutEstimateForTracks` message.
- 61107a3: A meeting's sticky player and "Ask about this meeting" bars now reach the window's edge when the host page pads its scroll frame. A sticky bar stops at its scroller's padding, so a host that keeps room at the bottom for its own floating button showed the meeting notes scrolling past under the Ask bar, and a host with top padding showed them above the pinned player. The page background now covers that strip: always under the Ask bar, which ends its column, and above the player while it is pinned. The cover is a clipped shadow, so it adds no scroll length and catches no clicks. Without host padding nothing changes. `demo/embedded-meeting.html` shows a meeting page in such a host.
- 73f01eb: A new chat shows where it runs and who can see it as chips beside the project chip above the message, instead of hiding them under "+". Each chip appears only when there is a choice, opens the same menu as before, and the chips wrap on narrow screens instead of truncating each other. Hosts that turn off the chat list still get the Runs on and Visibility chips.
- 3c16116: Deciding several parallel tool approvals now just works. A decision for an approval that is still undecided is accepted while the turn resumes from a sibling decision, instead of failing with "no unhandled approval is pending". One resume applies every decision made before it, so each decision no longer restarts the turn and asks the rest again, and an already decided approval is never asked again. Deciding the same approval twice is accepted once, and a real conflict says why: already approved or declined, already finished, or the turn ended. The chat, the sub-session card, the phone app and the embedded chat keep the undecided approvals up and decidable while the turn resumes. `approvalsDecidable(status)` is exported from `@opengeni/react` and `@opengeni/react/session`.
- d784716: Pausing active work shows "Current work stopping" as soon as the Pause is accepted, while the running command stops. The chip used to wait for the next queue refresh, so a quick stop could pass with no feedback at all. It now follows the Pause receipt until the session's control catches up, and the queue takes over from there.
- d55f740: The stopping status clears once the work has stopped. Before, it could stay up until some later queue change, because the refresh for the event that ended it could reuse an older read still in flight. `getQueue` accepts `{ fresh: true }` to start a read no earlier than the call, and `useTurnQueue` uses it for every read that follows an observed change: events, reconnects, workspace control changes, stream opens, retries and failed mutations. In the session chrome the status stays on one line just before Activity, and on a crowded rail its words give way before the other chips do.
- 4a48589: Pinning an archived chat restores it, so it shows under Pinned. A chat opened from search could be pinned from its header while archived: it was marked pinned but never appeared under Pinned, which lists active chats only. Pinning now restores the chat in the same transaction (archiving still unpins), the open chat's header reflects the restore at once, and a migration repairs chats already saved as both pinned and archived.
- 1e98c19: A repository picked "As you" stays an As-you selection in the next new-chat draft instead of coming back as a manual URL, and a manual URL row for a repository already selected "As you" at the same branch folds into that selection instead of blocking Send with a duplicate mount path.
- 4bd54f1: A seat-limit refusal names its one fix. The API's `402 seat_limit_reached` message is "Upgrade to Pro to add more people." or "Upgrade to Max to add more people." (whichever plan has room), or "Talk to us about Enterprise to add more people.", and its details add `seatLimit`, `seatsUsed`, `upgradePlan` and `upgradePlanLabel`. `formatErrorMessage` uses the named plan. The invite page shows it as soon as the plan is full, with one Upgrade button for people who manage billing, and tells everyone else to ask an organization owner. New: `seatUpgradePlan` in `@opengeni/contracts/seat-upgrade`, and `planSeatsFull`, `seatUpgradeFor` and `seatUpgradeFromError` in the React subscription-plan helpers.
- 3b9a997: Add `POST /v1/workspaces/:workspaceId/sessions/:sessionId/resources/remove` and SDK `removeSessionResources` to remove repositories from a running session and its child sessions, recorded as `session.resources.removed` events. Access through Opengeni-brokered paths and new credential mints ends on the next call: the personal Git broker, the GitHub tools and Git token minting refuse a removed repository, including for running turns, children and goal continuations. Tokens already in a sandbox stay valid until they expire, except that a dedicated token Opengeni's own GitHub App minted is best-effort revoked. The next managed-sandbox turn removes the repository folder and credential binding.

  `Session` gains an optional `removedRepositories` list (migration 1140). A removal lasts until a person attaches the repository again: an agent cannot re-attach it (with a message or a child session, which now returns 403), turns queued earlier leave it out, and child sessions inherit it. Only a person or an API caller can remove repositories. `SessionAuthorizationOperation` gains `"session.resources.write"`; hosts with an exhaustive switch over it must handle the new value.

  In the chat composer, a mounted repository can now be switched off in the repository picker. A confirmation names the repository and warns when its folder has uncommitted or unpushed changes. The SDK `Session` type gains the optional `removedRepositories` field and the `SessionRemovedRepository` type.

- 1efa378: Organization settings has a Shared page for owners and admins: everything the organization shares with its workspaces and where each works. Models and their payers link to Models; the organization's machines, rigs, Skills and Knowledge are listed as working in every workspace, Personal workspaces included; each organization vault says where it works and opens in a workspace the viewer can reach. New: `GET /v1/workspaces/:workspaceId/organization-vaults` (`account:admin` and `secrets:list`) lists every organization vault wherever it works, with `complete: false` while the server can list only the ones that work in the requested workspace, and the SDK's `listOrganizationVaults`. Migration 1218 creates its routine with the runtime grant withheld for one release. `OrganizationAdminSection` gains `"shared"`.
- 184b5d7: Text, icons and backgrounds that named colours the theme does not define now use the intended theme colours: secondary text in the interaction banner, API update screen and conversation notices is muted, success checks are green, warning icons are amber, error messages are red, and inactive status dots and fallback cards have their intended colours. These had silently shown in the default text colour or no colour.
- c825e31: Deleting a workspace no longer shows a false "Failed to delete workspace" error when the browser loses the server's response while the delete is still committing. The app now confirms the outcome for about half a minute, and reports the original error only if the workspace is still there.
- Updated dependencies [1f918a4]
- Updated dependencies [92f419c]
- Updated dependencies [000c023]
- Updated dependencies [bc5c6d5]
- Updated dependencies [b4e780e]
- Updated dependencies [06adef4]
- Updated dependencies [ace882b]
- Updated dependencies [dcb2352]
- Updated dependencies [894121c]
- Updated dependencies [f3e6835]
- Updated dependencies [0b19c29]
- Updated dependencies [b098518]
- Updated dependencies [a853c7a]
- Updated dependencies [a99a7d6]
- Updated dependencies [c2f978b]
- Updated dependencies [c59d7f8]
- Updated dependencies [237329e]
- Updated dependencies [bf3cf84]
- Updated dependencies [d55f740]
- Updated dependencies [cdb9d27]
- Updated dependencies [0d409a7]
- Updated dependencies [cfce969]
- Updated dependencies [df44bd8]
- Updated dependencies [cf9415d]
- Updated dependencies [4bd54f1]
- Updated dependencies [3b9a997]
- Updated dependencies [1efa378]
- Updated dependencies [237329e]
- Updated dependencies [af8a173]
  - @opengeni/contracts@6.4.0
  - @opengeni/sdk@6.4.0
  - @opengeni/connect@6.4.0

## 6.3.1

### Minor Changes

- d91058a: Agents can call a person. The new `call_user` tool rings the person's phones with the system's incoming-call screen (CallKit on iOS, through a PushKit VoIP push) when something cannot wait, waits up to 40 seconds while it rings, and returns `answered`, `declined`, `missed` or `cancelled`. Answering opens the chat's voice call, which starts by saying why the agent called. Nothing rings until the person turns on "Let agents call this iPhone" on that phone (native push rule `call`); "Teammates' agents too" (`call_members`) lets agents of other workspace members call them. One call rings a person at a time, a chat calls at most three times an hour, and after a decline it cannot call again for 15 minutes. A missed call leaves a "Missed call" notification. New: `session.agentCall.ringing` and `session.agentCall.settled` events (also subscribable by workspace webhooks, so a product can ring its own app with its own push credentials), `GET /v1/workspaces/:workspaceId/agent-calls/:callId` with `/answer` and `/decline`, the SDK's `getAgentCall`, `answerAgentCall` and `declineAgentCall`, the native push device's `voipToken`, and in `@opengeni/react-native` `useIncomingAgentCalls` and `useNativeVoipToken`.
- b5c112c: Approval cards for app actions name what they change. The server reads each id the action takes, as the person the chat acts for, and the question names the target in its own words, for example "Remove the Gmail connection for anna@example.com?", with a few facts beneath it (who can use it, when it was added). Arguments the agent wrote never write the question or the facts; in Details they sit under "Sent by the agent". A target the person can't see, or one that can't be read, keeps the plain wording. Answered approvals say what was decided for each action, one line each in a batch, instead of "You responded to this approval." Slack's private review shows the same question and facts. `@opengeni/db/app-action-targets` is a new subpath.
- d872b12: Feedback reports carry what is needed to debug them, not just a screenshot. A report's `context` can now name the chat in view (`sessionId`) and carry the app's latest API requests (`recentRequests`: method, path without its query, status, duration and the server's correlation id, which finds the request's logs), errors nobody caught and files that failed to load (`recentExceptions`, with stacks), and the steps before it (`breadcrumbs`: screens opened, the app hidden or shown, the network lost or back). The web and desktop console and the phone app record these in memory and send them only with a report; the forms say what is sent. The server also stores, with each report and never shown to clients, its own version and deployment revision and, when the author can read the chat in view, that chat's status, last event sequence and latest turn (status, model, reasoning effort and times) in the new `feedback_submissions.diagnostics` column. `OPENGENI_CORRELATION_HEADER` is exported from `@opengeni/sdk/browser`. The phone app resends a report without the new fields when a server older than the app refuses them.
- c35704f: Meetings name themselves. Nobody has to type a name: a meeting started without one is named after the event on its owner's connected Google or Outlook calendar at the time it started, or else, once its notes are written, from what was said (the built-in summary passes a short name to `meeting_notes_save` as the new `title`). A name someone types, at start or by renaming, always wins and is never replaced. Recordings carry `titleSource` (`person`, `calendar`, `conversation`, `app` or `default`; migration 1132 adds it, and existing recordings are `person`), and create requests may pass `titleSource: "app"` for a title the app only guessed, such as the desktop app's "Zoom meeting". The web and phone recorders no longer send a made-up date name, the recorder shows the calendar name once the server has it (`serverTitle` in the upload status), and the meeting page shows the new name when the notes arrive. Private, declined, cancelled and all-day events are never used, and the calendar lookup never holds up capture.
- 99159e9: A session can now mix GitHub repositories from several GitHub App installations and from your personal GitHub. Each mounted repository commits as its own identity: the Opengeni app's bot for App repositories, your `users.noreply.github.com` address for repositories used through your GitHub. The worker writes `user.name`/`user.email` into each repository's local git config (marked `opengeni.managedIdentity`; an identity you set yourself is kept) instead of one sandbox-wide `GIT_AUTHOR_*`/`GIT_COMMITTER_*` identity, so a sandbox with both no longer fails setup with "repository resources require different Git commit identities". New sandboxes no longer carry a bot identity in their environment, so the sandbox viewer and terminal create the same environment as the worker and a session with only personal repositories never commits as the bot. Sandboxes created before this change keep their pinned environment; a `git` wrapper written to the per-turn CLI wrapper directory (`$HOME/.opengeni/bin`, ahead of the real git on PATH) runs git without the baked identity when the repository has a managed identity, and passes through otherwise. A deployment-configured `OPENGENI_GIT_AUTHOR_NAME`/`OPENGENI_GIT_AUTHOR_EMAIL` stays the default identity for App and host repositories. `applyGitAuthPointerEnvironment` from `@opengeni/config` ignores its deprecated identity argument; `GitCredentialBindingSeed` in `@opengeni/runtime` gains an optional `identity`.

  The repository picker shows one row per repository. A repository reachable both through the Opengeni app and your GitHub has an "Acts as" choice when selected (you by default when your GitHub can write to it), and repositories from any number of App installations can be selected together with your own. The picker footer is now "GitHub access", with "Your GitHub" (connect, or choose which repositories Opengeni may use) and "Opengeni app" (installations and "Install on another account"). Automations can also select repositories from several installations. `RepositoryContextPickerProps` drops `selectedInstallationId` and gains `personalGitHubManageUrl`; the app context drops `selectedInstallationId`.

- 375ea76: `SessionApp` takes `starters`: suggestions under the new-chat composer that replace Opengeni's own, such as tasks that fit the app the chat sits in (an empty list shows none). The new-chat page's recent sessions now lead with the chats the person opened there most recently, so in a busy workspace other running sessions no longer hide the chat they just left.

### Patch Changes

- 32bc3e9: App use is paid from monthly plan credit; API use (organization and personal API keys, products on the SDK, outside agents over MCP) is paid from credits only. Each turn freezes its funding origin, sub-agents and tools inherit their chat's, and API work with no credits is refused with `402 api_credits_required` and an Add credits action (`1128_billing_usage_origin`, rolling; it adds `billing_origin` to the scheduled-task execution exclusion lists in place, keeping 1115's `creator_locked`). See `docs/billing-origin.md`. A schedule an API caller edits or runs by hand, or an automation an API caller's test event or replay fires, is API use from then on, and so is an automation fired by a webhook whose signing secret or custom format an API caller set or received (`event_sources.secret_billing_origin`), and so is an automation fired by a workspace MCP source an API caller pointed at a server's URL. The agent tools that create and change webhook sources mark them the same way for an outside agent or an agent in an API chat. A custom webhook format can no longer read its event type or ids from the header its signature is in, so a shared token is never stored in events or the delivery log; one stored before reads that header as absent. Intake also drops any header that contains the source's secret and replaces copies of it in the kept body with `[secret]`, so a `url_token` secret echoed by the app or a proxy is never kept. The web app shows an API turn refused for lack of credits as a credit stop. Paid tools in the app are paid from plan credit too, the Free plan's included. Internal accounts (CloudGeni's host account and our own team's organizations) keep today's billing through `OPENGENI_BILLING_LEGACY_ACCOUNT_IDS` (listed by default). The SDK keeps the `add_credits` and `upgrade_plan` refusal actions and names the fix in its messages.
- ced76d5: Claude's web-search citation tags no longer show as raw markup in chat. With Anthropic's native web search, Claude marks quotes with `cite` tags that the API turns into citations only in ordinary answer text, so an answer given through the `wait_for_input` reply arrived with the tags intact. The Claude transport now rewrites them in that reply into the quoted text linked to the search result the tag's index names (or plain text when the index names no result). Chat timelines (web, desktop and mobile), copied text, Slack and Teams also show any remaining tag as its text, while fenced and inline code keep their contents exactly; nested tags are replaced innermost first. A Slack message an earlier release already started keeps that release's bytes on retry. `@opengeni/contracts/claude-cite-tags` exports `hasClaudeCiteTag`, `rewriteClaudeCiteTags` and the `ClaudeCiteSource` type.
- 40b79c9: Claude subscription models no longer disappear from a workspace when the Claude accounts serving it are not managed by that workspace. The catalog, model admission and cross-provider failover now count every Claude account that serves the workspace, the same accounts placement already used, for both the `workspace-claude-subscription/` and `organization-claude-subscription/` model ids. Readers also accept the upcoming canonical `claude/<model>` ids (provider `claude-subscription`), which a later release starts writing; the two legacy ids stay accepted as aliases.
- 3972ff6: Collapse completed in-chat machine setup to a confirmation with settings on demand.
- d010825: In the macOS app, the sidebar toggle and a chat's header now sit on the same line as the traffic lights, also with desktop apps from before the new top bar (0.1.33 and older), whose traffic lights sit lower, and when the page is zoomed. At a large zoom, where they don't fit above and below that line, they start at the top of the window instead of being cut off. The desktop bridge adds `windowBarHeight` and `zoomFactor()`.
- b9d38df: While a meeting is processed, its player waits until every recorded track can play. Before, the microphone could play alone for many minutes while it was transcribed, and a meeting recorded with computer audio sounded as if the call's side was never recorded. The worker now also prepares every track's audio before it transcribes any, so the whole meeting is playable within seconds of the recording ending.
- d39663d: When a member is suspended, removed from the organization or removed from a workspace, the confirmation says that schedules they own stop running. A schedule stopped because its owner's access changed now also says what happens when the owner has left: it can't run as them again, so someone else can set it up as theirs or delete it.
- 008d073: Members of a shared workspace can now edit its instructions and review the agent's proposed changes to them, like shared Skills and Knowledge. Anyone who can start chats there (`sessions:create`), acting as themselves, may create drafts, import the earlier persona, propose onboarding instructions, activate and roll back, and approve or reject instruction proposals; the Knowledge page shows these controls to them. Viewers still can't, and tokens that only carry `sessions:create` (an agent's own, a worker's, an organization or workspace API key's, or another product's person) are refused, so agents still change instructions only through agent learning. A member's personal API key, or a chat they gave full access, acts as that member, like their connected agent, within what they allowed. The workspace's learning settings stay with admins and the Personal owner. New `requireWorkspaceContributorGrant` / `workspaceContributionAuthorized` in `@opengeni/core` and `canContributeWorkspaceContent` in `@opengeni/react`.
- e8b24d1: Regular members can do more without an admin. Anyone who can start chats in a workspace can now edit or delete its shared bot templates (only the creator or an admin can make one Only me; templates now report `viewerCanMakePrivate`, and the Edit dialog offers Only me only when it is true). Members can record social posts through a connection they can see, and posts through workspace-owned connections still need workspace settings access. Organization admins, not only the owner, can now share a workspace's Slack bot with other workspaces when they manage that workspace's integrations.
- d3f93eb: When a chat shared with the workspace runs on your own personal machine, a one-line heads-up above the composer now says so: people in this workspace see what the agent does on it. "Use another machine" opens the same machine picker to move the chat. Your private chats, and chats in your Personal workspace, show nothing. `SessionMachineAccessNotice` takes `shared` and `className` for this, and `SessionMachinePickerAction` takes `compact` for the small trigger.
- 21390fc: The chat header's Waiting status pill now has the same text size, height, padding, border and dot as the other status pills; it used a size class that does not exist and showed in the larger surrounding text. The tool action review title now uses the package's medium text size instead of inheriting the host page's size.
- Updated dependencies [d5db2de]
- Updated dependencies [d91058a]
- Updated dependencies [b5c112c]
- Updated dependencies [32bc3e9]
- Updated dependencies [923c161]
- Updated dependencies [ced76d5]
- Updated dependencies [40b79c9]
- Updated dependencies [d872b12]
- Updated dependencies [d010825]
- Updated dependencies [c35704f]
- Updated dependencies [c0b945b]
- Updated dependencies [008d073]
- Updated dependencies [d0295f8]
- Updated dependencies [e8b24d1]
- Updated dependencies [f4ad926]
- Updated dependencies [e53c5ad]
- Updated dependencies [a550481]
- Updated dependencies [af8fb16]
- Updated dependencies [139a2be]
- Updated dependencies [1afdda0]
  - @opengeni/sdk@6.3.0
  - @opengeni/contracts@6.3.0
  - @opengeni/connect@6.3.0

## 6.2.1

### Minor Changes

- 7af3643: A workspace can connect its own OpenAI-compatible model API: Settings → Models → "Connect an OpenAI-compatible endpoint" asks for an HTTPS base URL, an API key, a model ID, the API format (Chat Completions or Responses) and an optional name. The model then appears in that workspace's picker like any other direct model, billed to the workspace's own key, which never leaves that workspace. The same works through `POST /connections` with `metadata.credentialRole: "direct_openai_compatible"` and `metadata.directModelProvider: { provider: "openai_compatible", baseUrl, model, api?, label? }`.

  Only public HTTPS hosts are accepted, and every request resolves the host once and refuses private addresses and redirects. These endpoints report an unknown data location, so residency policies that require a known region leave them out. A model check that cannot reach any direct provider now answers 422 with the reason instead of a generic "temporarily unavailable".

### Patch Changes

- 7c94b6e: Find in a chat (Cmd/Ctrl+F) now covers the whole chat and starts at the newest match. It counts matches in the background, so the bar reads "3 / 120" instead of "1 / 50+"; in a chat with thousands of matches it shows how many it has found so far. Previous from the first match goes to the newest, Next from the newest goes straight to the first, and Enter, Shift+Enter, the arrows and Cmd/Ctrl+G all step through matches. Closing and reopening the bar starts again at the newest match. Session message search accepts `order: "newest"` to walk messages newest first; the default stays `oldest`, and `groupBy: "session"` only supports `oldest`.
- Updated dependencies [cbfd911]
- Updated dependencies [7c94b6e]
- Updated dependencies [7af3643]
  - @opengeni/contracts@6.2.0
  - @opengeni/sdk@6.2.0
  - @opengeni/connect@6.2.0

## 6.1.1

### Minor Changes

- 0422c7b: Connecting Gmail now asks Google only to read mail. When an agent later needs to draft, send or organize mail, the chat shows "Give Gmail more access" with an Allow button, which reconnects the same account and asks only for the missing permission; everything already allowed stays. Once the account holds that access, the agent carries on by itself, the same way it does after a first connection. Every Gmail tool stays in the agent's tool list; a tool the account cannot use yet stops before anything runs and before any approval card. Accounts connected earlier keep their access.

  Connect begin requests accept an optional `requestedScopes` list for a reconnect (`reconnectAccountId` is required with it), and OAuth provider profiles can declare `incrementalScopes` that are asked for only when requested or already granted. The connection token resolver now returns `grantedScopes` for every OAuth credential. The capability continuation request also accepts `{ connectionId }`: after a reconnect from an account's own card, the chat continues once that account is active and holds the scopes the card asked for.

- d60e6ec: Command steps in a chat's activity read as what they did in plain words ("Downloaded email-review.json", "Read report.md", "Ran make_chart.py", or the tool an `ogtool call` ran, such as "Search messages") instead of the raw `$ command`. The full command stays one click away, at the top of the step's output. Signed and token-bearing links (storage signatures such as `sig=` or `X-Amz-Signature=`, and `token=`-style parameters) never show their query as text, in commands, command output or tool payloads. Credentials are hidden too: well-known token formats, `Authorization` and `Cookie` headers (including `[name, value]` header pairs), `.netrc` passwords, password flags such as `mysql -p…`, `sshpass -p` and `docker login -p`, and values under secret-looking names. Command fields are read as commands, while output and prose are read as text, so code (calls, member access, constants) and ordinary words stay visible, and saved secret references stay intact. `@opengeni/react/timeline-model` exports `commandStepTitle`, `redactSignedUrls`, `redactPayload` and the `CredentialContext` type, and the English catalog gains the `timeline.commandStep.*` keys. Plain tool details are unchanged.
- 6573dc7: The system instructions and tool list follow how a chat started and never change mid-chat, so earlier requests stay cacheable. A chat that a scheduled task or event trigger starts unattended is told so from its first turn, like a session created with `unattended: true`. When the switch, or a person writing in an automation's chat, makes a turn's attendance differ from how the chat started, that turn's input carries a short note saying so (the unattended guidance, or that a person is now present and can answer). In a chat switched to unattended after it started, a question or hand-off to a person returns at once with a result saying no one will answer.

  Unattended sessions no longer wait on a person anywhere. A call that needs someone's approval under the workspace's tool permissions is refused at once with an error result saying nobody can approve it in an unattended session, in model tool calls and in Codemode, so the agent works around it and lists it as a step left for a person. Nothing is approved and no approval request is opened; permissions stay exactly as configured. Chats that scheduled tasks and event triggers start are unattended by default; a task chooses with `agentConfig.unattended`, and a task that sets `approvalTimeoutSeconds` without it stays attended. A new **Work without me** switch in a chat's Agent tab turns unattended mode on or off from the next turn, through `PUT /v1/workspaces/:workspaceId/sessions/:id/unattended` (SDK `updateSessionUnattended`); session reads include `unattended`. Explicit choices (the switch, the create option, a task's `agentConfig.unattended`) stay; only the automatic default of a scheduled or event-triggered chat ends when a person writes in it from the web app, Slack or a voice call. Interactive sessions are unchanged.

### Patch Changes

- Updated dependencies [0422c7b]
- Updated dependencies [9f02c05]
- Updated dependencies [6573dc7]
- Updated dependencies [9cf4bc0]
  - @opengeni/contracts@6.1.0
  - @opengeni/connect@6.1.0
  - @opengeni/sdk@6.1.0

## 6.0.2

### Minor Changes

- 83ed5c0: An automation whose chat is parked waiting for a model account (for example a Codex plan with no usage left or none connected) now says so. Its skipped runs record `scheduled_session_waiting_capacity` instead of `scheduled_session_not_idle`, and they read "Skipped because the chat is waiting for a model account. Pick another model in the chat." The schedule's notice names the same fix. A scheduled update refused by such a chat returns the new reason `session_waiting_capacity`. The new message key is `automations.run.error.chatWaitingForAccount`.
- 44ba53b: Bots, finished. Bot templates now have a visibility: `workspace` (everyone who can open the workspace) or `private` (only the person who saved it). The template dialog has a "Who can use it" choice and private templates show an "Only me" chip. When an agent in an Only me chat saves itself with `bot_template_save`, the template is private; a run with no person behind it cannot save from an Only me chat. A `sourceSessionId` sent to `POST /bot-templates` must be a chat in the same workspace that the caller can open.

  Marketplace plugins are listed in the integration catalogue (`kind: "plugin"`), so an agent can find one with `capability_catalog_search` and offer it through the same in-chat card it uses for connectors. The card shows the agent's reason, who made the plugin and what it adds, and the person reviews and installs it from there. Someone without permission to manage the workspace's plugins sees that a workspace admin has to install it, and the agent is told the same. `PluginDetails` takes `showIdentity={false}` for hosts that already show the plugin's name and logo.

  In Slack, a bot chat with an avatar can post its replies under its own name and avatar. This uses the optional `chat:write.customize` scope, so a Slack admin must reinstall the app to grant it; without it, posts stay under the app's name. The avatar image comes from a new signed public route, `GET /v1/public/session-avatars/{token}.png`. The API image now includes an emoji font so emoji avatars render in that image.

- f385091: A person can share a chat with a read-only link. The link opens a snapshot of the conversation exactly as the chat shows it (each person's messages under the name the chat shows for them, never an email, and the replies; queued messages that were deleted, edited or cancelled before they ran, images and links to the chat's own files left out) without signing in, and only while the person who shared it can still read the chat. The share page loads no third-party analytics that record its address and is never indexed. The person who started the chat creates, refreshes or stops it from the chat's Share… menu item or by asking the agent, which runs `createSessionShareLink` after one confirmation; `listSessionShareLinks` lists their links. `OPENGENI_PRIVACY_CHAT_SHARE_LINKS_ALLOWED=false` turns links off and stops existing ones opening. Member changes on a personal workspace now say that personal workspaces are private to their owner and point to a share link when that person can create one, instead of "missing permission: members:manage".
- d8a1b83: A Codex chat can now switch to any other model in the same chat. Chats that use ChatGPT's own memory of long conversations (remote compaction) used to be locked to Codex models, so a used-up Codex plan left them stuck. Now picking another model just works: before its first reply, the chat's earlier messages are summarized again from Opengeni's stored history, so the new model can read them, and the chat keeps a shared summary from then on. The transcript shows one short note, "Earlier messages summarized for the new model". If Codex already compacted the chat, choosing another model shows one line saying earlier messages will be re-summarized, so it may remember less detail. When a Codex usage limit stops a chat, one line says when it resets, with a "Continue at reset" switch. It is on by default: the chat waits and continues on its own at the reset. Turning it off pauses the chat until the person continues it. Picking another model in the picker continues the chat with that model right away. The usage-limit failure now records `resetsAt` when the reset is known. The "Keep Codex chats portable" workspace setting is gone because switching always works; the `codexCompactionDefault` API field is still accepted. The `codex_compaction_v2_provider_locked` error code stays in the contracts for older clients but is no longer returned.
- aa6b340: When the agent changes a chat's model (for example with `session_set_model`), the composer now shows the new model and the person's next message runs on it, instead of silently switching the chat back to the model the composer had loaded. A composer draft either holds the person's own pick or follows the chat's settings: `ComposerDraft.policyFollowsSession` says which, and while it is true the draft's `model`, `reasoningEffort` and `latencyMode` are the chat's current ones. `saveComposerDraft` and `submitComposerDraft` take those three fields together or not at all; without them the draft follows the chat and the message runs on its current settings. Picking a model, effort or speed in the composer still makes it the chat's setting when the message is sent, after which the composer follows the chat again. Composers on web, phone and embeds (`useComposer`) refresh on `session.model_settings.updated`, and `useComposer` exposes `sendPolicy`: the person's pick, or null while following. Clients that always send a model keep today's behaviour.
- f2e1953: Turning on computer use in the desktop app no longer spins forever. When it is on but still not usable after a minute, the switch stops saying "Turning on…" and says why in one line: the server isn't accepting the computer's sign-in, the server can't see it yet, the agent isn't starting, another copy of the agent is in the way, or moving the agent into the app is taking too long, with the agent's own words below when it gave some, and **Try again**. Try again restarts an agent that is already running (its service, or the app's helper), so it signs in and connects right away instead of after its backoff. An agent that has stopped retrying because the server needs it connected again is a problem at once, and turning it on reconnects it. The app's own agent is no longer shown as on, and the menu bar no longer calls the computer available, while the server refuses its sign-in; a connection the agent stopped retrying is enrolled afresh on turning on, even while the server still lists it. `parseConnections` reads each connection's `authentication` state from `opengeni-agent connections`; `ThisComputerStatus` gains `waitingOn` and `waitingDetail`, and `ThisComputerErrorCode` gains `reconnect_required`; `useThisComputer` gains `stalled` and a `turnOnLimitMs` option; `@opengeni/react/this-computer` exports `computerUseStalledText`; `ComputerUseProblem` gains `stalled`.
- 1271da5: Cancel throws a dictation away. Cancel, Escape and the phone's cancel now delete the dictation under way, while it records or while it is being transcribed, so no composer offers it again. Before, speech longer than a few seconds was kept and the composer offered it later. A dictation an earlier page left only stops being retried when cancelled, and dictations that fail are still kept and offered as before.

  The desktop app keeps a cancelled dictation's speech in Recent dictations, marked "Cancelled, not transcribed", to play or transcribe again there; the retry shortcut transcribes it and types it. `useVoiceInput` gives `onAudio` the cancelled copy with `cancelled: true`, the `cancelled` desktop dictation report carries its `audio`, and history entries have `cancelled: true` until they are transcribed again.

  `useVoiceInput` has a new `setAside()` for interruptions other than the person's Cancel, such as live voice taking over or another chat opening: capture stops and the speech stays saved to insert later, as `cancel()` did before. The composer's cancel button reads "Discard dictation".

- 3fc010b: Send pressed right after a chat opens no longer does nothing. While the composer is still loading what it needs to send (the model list, a saved draft, the chat's tools or accounts), Enter or Send with a draft now waits, shown as sending, and goes out as soon as Send is allowed. Clearing the box cancels it; if something then blocks Send, that blocker shows its own message as before. A saved draft whose first read times out keeps the send waiting through its retry, and a load that never finishes ends the wait after 30 seconds with a short message instead of spinning forever. `ComposerState` has a new optional `preparing` flag for custom deliveries that want the same behaviour.

  When part of the chat UI fails to download (a dropped connection or a deploy mid-load), the place it would have appeared now says so with a Reload button, in the whole chat and in single timeline items, tool rows and previews alike, instead of a Try again or "couldn't be displayed" that can't help. Lazily loaded extras inside a message (its actions, inline previews, cards) fail on their own, so the message itself stays visible.

  Behaviour change for apps that embed `SessionApp`: a rendering error inside it is now contained in the app, which shows "This chat couldn't be displayed" with Try again (or Reload when code didn't download) and starts fresh when the person opens another chat or screen. Such errors no longer reach the host app's own error boundary. Wrap `SessionApp` in your own boundary only for errors outside it.

- dfc7190: Show EU-only inference in the app. Organization settings > Security & data has
  an EU-only inference switch: members see it, owners and admins turn it on, and
  turning it off is offered only when the API answers `canTurnOff`, after a
  confirmation; without a recent sign-in it offers "Sign in again" first. In an
  EU-only workspace, models and features the server switched
  off (reason `region_restricted`) show "Not supported in EU" and can't be chosen
  or turned on. The app reads this for the open workspace and again after a workspace switch
  or a change to the setting. New SDK methods `getOrganizationInferenceResidency` and
  `updateOrganizationInferenceResidency`, `ClientConfig.inferenceFeatures` and
  `ClientModel.availability` types, and `@opengeni/react` helpers
  `isRegionRestricted`, `regionRestrictedText` and `inferenceFeatureRestriction`.
  The curated Opper model is labelled "Claude Opus 5.5": EU status comes from
  residency records, never a name.
- 09972b5: One mechanism reads every app's webhooks. Linear and Sentry are now presets of the custom webhook, like Tailscale, and their own adapters are gone: `WEBHOOK_FORMAT_PRESETS` has `linear`, `sentry` and `tailscale`, and sources stored with the `linear` or `sentry` adapter read as `custom` with that preset (`currentWebhookAdapter`, `webhookPresetOf`). Creating one with the older adapter still works and stores it as `custom`. A format can now say more:

  - `signedContent` on `hmac_sha256` for apps that sign more than the body, such as `v0:{header:X-Request-Timestamp}:{body}`.
  - An `ed25519` scheme, whose secret is the app's public key.
  - A `url_token` scheme for apps that can't sign: the secret is part of the address, at least 24 URL-safe characters.
  - `freshness`, which refuses deliveries whose send time is too old.
  - A `type` joined from `parts`, lists of fallback paths for the text fields, and `actorKind` to tell people from bots.

  Agents with `scheduled_tasks:manage` can add webhook sources themselves. `event_sources_create_webhook` takes a preset or a format and a signing secret, which can be a secret reference, and returns the address to give the app. `event_sources_update` and `event_sources_delete` change and remove sources. For a webhook source, `event_sources_list` with its `sourceId` now shows its format and last five deliveries. The event-triggers Skill explains how to write a format from an app's webhook docs.

  A secret reference in those tools' `signingSecret` resolves to its value, and only there: the source keeps the secret encrypted, and a name or format next to it stays reference text. A reference that could not resolve is refused rather than stored.

- 7b98d86: Agents can offer options as an interactive answer. An `opengeni-ui` fence holds one JSON object with the options, the fields to compare, an optional chart field and whether the person may pick; the conversation draws it as cards, a sortable table (web) and a bar chart, with filter chips, the best value per field marked, and a pick bar that sends the choice as the person's next message. The answer grows in place while it streams and stays read only in ended sessions. `InteractiveAnswer`, `InteractiveAnswerProvider` and `browserInteractiveAnswerStore` are exported from `@opengeni/react`, the renderer-neutral model from `@opengeni/react/interactive-answer-model`, and `NativeSessionScreen` accepts an `answerStore`. The bundled `visualize` Skill describes the fence.
- cebc433: Question cards offer "Let the agent decide". On every ordinary question (never a secret, a Skill review or a secret approval; tool approvals stay human-only) one secondary action replaces Skip and settles the request as `{ outcome: "skipped", agentDecides: true }`, accepted even when the request does not allow an ordinary skip. The agent's tool result carries a note to make its own best choice and say in one sentence what it chose, and the settled card reads "You let the agent decide". On a sub-session's question shown in a parent chat, the action instead sends the parent's own agent a message naming the exact request; the card says "Your agent is deciding" and stays answerable, and the message shows what the agent decided once the sub-session's request settles. `HumanInputForm` takes `onLetAgentDecide` and `agentDeciding`, `HumanInputSurface` forwards them, and `humanInputAgentMayDecide` tells which requests qualify.

  A sub-session's blocking question now also wakes a parent whose goal is completed (the goal is not reopened), so the parent agent can answer it before the person has to. Before, such a parent kept the notice unread and the person was the only one asked. Agents are told to answer a child's question from their task context before the person has to, and to do the agent work it asks for (such as starting a reviewer) and then answer. The `request_human_input` description tells a sub-session to message its parent agent, rather than ask the person, when what it needs is agent work.

- 449bcae: An MCP server can now ask the person a question in the middle of a tool call (MCP form elicitation, revision 2026-07-28, multi round-trip): a confirmation or a form to fill in. Model calls to third-party MCP servers declare that they can answer forms (form mode only; URL mode is not offered, and a server that asks for a page anyway ends the call with an error result). When the server answers `input_required`, the call pauses as an approval of the same call, the person answers in the approval card (possibly hours later, including in unattended runs), and the call is retried with the answer and the server's byte-exact `requestState`. Declining is sent to the server too (`action: "decline"`), so it can release what it was holding and finish the call its own way; the model then sees the server's result followed by a short note that the person declined. The model never sees the question or the answers. `session.requiresAction` approvals carry a new `elicitation` field (`{ server, round, requests }`); `user.approvalDecision` takes `content` and `elicitationRound`. Approving an approval with `elicitation` requires `elicitationRound` to be the current question's round, and the API checks `content` against the server's form (422 with the reason otherwise), so a stale card or a surface that never showed the question cannot answer a newer one. The question shows on every approval surface: the session card (web and native), the inbox (the question as the title; Allow for a short confirmation, Answer for a form), phone push ("<server> asks: …", opening the app, with no lock-screen actions) and private Slack cards (Allow for a confirmation, a link to answer a form in Opengeni). Connector action records gain `input_round`, so a tool with an Ask policy or saved rule can be asked more than once and answered in a later worker attempt. New exports: the `McpElicitation*` schemas, `MCP_ELICITATION_MAX_ROUNDS` and helpers in `@opengeni/contracts` (also at `@opengeni/contracts/mcp-elicitation`), and their types including `McpElicitationAnswer` in `@opengeni/sdk`; `InboxItem.serverQuestion` (`{ server, kind, round }`); `sendApprovalDecision` accepts `content` and `elicitationRound`; React `ApprovalSurface` renders the question and passes `{ content, elicitationRound }` to `onApprove` as its second argument, and `McpElicitationRequest` is exported from `@opengeni/react/session-ui`; React Native `ApprovalStrip`'s `onDecide` receives the same answer as its third argument; `@opengeni/testing/mcp-elicitation-server` is a fake server for client tests. See `docs/mcp-elicitation.md`.
- 37538aa: Meetings get their notes written automatically. When a meeting's transcript is ready, Opengeni starts one chat for the meeting's owner (Only me for an Only me meeting, a workspace chat for a shared one) that writes the notes: an overview, topics, decisions and action items, with speakers and people linked as `speaker:` and `person:` mentions. The chat can only read that one meeting and save its notes, and nobody can widen it later. It runs on the workspace's shared Codex or Claude subscription accounts like other background work, and doesn't start when no subscription account can serve it, so it never spends credits or an API key. It never writes over saved notes and steps aside when the owner has their own automation for ready transcripts. Admins can turn it off with "Write notes after each meeting" in the meeting settings (`settings.recordings.autoSummary: false`). `meeting_read` now gives each speaker's label, and the "Meeting notes" template asks for the same format.
- c6ba725: Meetings no longer stay stuck. Finishing a recording that can't be paid for ends capture and fails its transcript with the reason, or, when nobody picked a model, transcribes it with one that needs no credits; a transcript that runs past its time budget (half an hour plus three times the audio, at most twelve hours) fails as `timed_out`. The meeting page names the fix for a refused transcript (transcribe with a model that needs no credits, add credits, or connect a model) and offers Transcribe again; says when this device is still uploading a meeting's audio, with Try again after a failure (`RecordingUploader.retry`, `useRecorder().retryUpload`); and no longer promises "a minute or two" for long meetings. A signed-in person's own Only me meetings now appear in the normal Meetings list of every workspace of their organization they belong to, their Personal workspace included, labelled with the workspace that stores them (`Recording.sourceWorkspace`), and open in place there for them and their agents when the request has the same access in the storing workspace; shared meetings, other people's and an app's own users' meetings stay in their workspace, and nothing crosses organizations.
- 047bf8c: A Personal workspace now learns and keeps files like a shared workspace. Its workspace chats, scheduled tasks and Site guest chats save Knowledge, Skills and instructions to the Personal workspace's own Workspace layer under its modes, and its files and Sites follow the chat's audience. Only me chats still learn for their person. Nobody but the owner can be in a Personal workspace, so its Workspace layer stays private to them; organization admins, other members and other workspaces still cannot reach it. As in a shared workspace, a workspace chat there doesn't read the owner's Personal Knowledge or Only me files, and the files it makes are Workspace files; existing workspace chats and schedules there no longer read the owner's earlier Personal Knowledge or Only me files, and a schedule there takes Only me files only for an Only me target chat. Migration 1095 copies the owner's Personal learning modes, and their chat and task overrides from that workspace, to its Workspace layer when it has none, and existing personal data is unchanged: the owner and their Only me chats keep it. The Agent learning page in a Personal workspace shows its Workspace layer beside "Your private chats". Publishing an Only me Site no longer silently shares it; share it first, as in any workspace.
- 6c5a6b5: Projects get a profile like a chat's: a description and an avatar (an emoji, icon or letters on a colour, or a workspace image). The avatar replaces the folder icon in the sidebar, the new-chat project picker and the Move to project lists, and pointing at a project shows its description. **Edit project…** in the project's menu replaces **Rename project** and opens the same dialog as a chat's **Edit profile…**. `Channel` gains `avatar`, `POST`/`PATCH /v1/workspaces/:workspaceId/channels` accept it, and agents set it with `project_create` and `project_update`. Changing it needs the same permission as a rename, and an image avatar must be shared with the workspace.
- ce001ee: Agents can mark one option of a question as recommended, ask a yes/no question whose two buttons use their own words (`confirm: true` with two options, the action first), and attach a short preview to each option, such as the exact text a choice would send. The web and phone question cards show a "Recommended" badge, the two decision buttons and the previews.
- 71bcf11: A saved message that was sent for one of the person's machines no longer leaves the chat at a dead end after the chat moves to another of their machines. The chat now names the machine the message was sent for, offers "Run it on …" (move back, then one recheck), and explains how to send it again on the current machine instead of offering a recheck that can't pass. `SessionMachineAccess` gains `queuedTurnNotApprovedHere` and `queuedTurnApprovedMachines` (machine names only for the message's sender), and `@opengeni/react/session` exports the shared model. The generic "not approved for this chat" wording no longer tells the owner to ask the owner.
- fd80817: A person's message no longer waits behind a turn parked on a subscription usage limit (or an account that needs reconnecting). Sending a message now replaces the parked turn and starts right away on the model it was sent with, the same way a message replaces a pending decision. A paused chat, a chat held by used-up Opengeni allowance or credits, a queued-prompt edit, and agent or machine input keep ordinary queueing. `@opengeni/react` adds `promptSendDestination`, which web, embedded and native composers use to show such a message in the chat instead of the queue; the console keeps Pause available while a turn is parked.
- a744c56: Bots. Any chat can now have a one-line description and an avatar (an emoji, an icon, letters, or an image from the workspace) next to its title, which is its name. People set them from the chat header and the sidebar menu; the agent sets them with `set_session_title` and `set_other_session_title`. They are display-only and never sent to the model. `PATCH /sessions/{id}` accepts `description` and `avatar`, and `createSession` accepts `profile`.

  Bot templates (`/bot-templates`) hold a name, description, avatar and setup instructions. Starting a bot from one opens a kept-live chat with the instructions as its first message, and the agent sets itself up from there. The agent can save itself as a template with the new `bot_template_save` tool, and templates export and import as `opengeni.bot-template` files. See `docs/bots.md`.

- 670913f: Sites can have several pages and use links with query parameters. `site.location` gives a Site its own address (`path`, `search`, `hash`, `href` and parsed `params`), `site.navigate(to, { replace })` moves between the Site's own pages without reloading, and `site.onLocationChange` hears Back, Forward and links. On a published Site this is the real address, kept through sign-in including its `#hash`; in the console it is kept in the Site page's `?page=` parameter. Ordinary links to the Site's own pages now move the Site instead of failing inside its frame (`createOpenGeniSiteClient({ links: false })` opts out). Older hosts report no location.

  Site SQL binds two more verified viewer values: `:viewer_access` (`member`, `invited`, `user` or `guest`) and `:viewer_email` (the verified email in lowercase, or NULL). `:viewer_kind` is unchanged.

- 3aaf6ed: Site rows in sidebar projects move like chat rows. Their menu has the same "Move to project" list (Default takes the Site out of every project), and a Site row can be dragged onto a project. The move is shared, like a chat's project: the Site and its conversations in that project go to the new one, and the Site stays published and in Artifacts. New `PUT /v1/workspaces/:workspaceId/published-artifacts/:artifactId/channel` (`updateSiteProject` in the SDK) needs `sessions:control` and control of every conversation that moves.
- 77f483f: Sites can now run tools that need approval. When a Site you view in Opengeni calls one, for example Gmail "Send message", Opengeni asks you around the Site: what will happen, from which of your accounts and to whom, with Send and Cancel, plus "Always allow for this Site". The call always uses your own account. `createSiteToolBridge` accepts `confirmToolCall` and `connectForToolCall` for hosts that show this confirmation.

### Patch Changes

- 20f51f3: The chat header no longer shows a bot's description next to its name. On a crowded header it took the room the name needed, cutting the name off while the description still showed. The description stays in the chat's profile, opened from the avatar or **Edit profile…**.
- d96e0c9: Connect cards no longer ask "Who can use this connection?" when nobody else could use it: for services that are always personal (Gmail, Google Drive, Google Calendar) and for a person who is the only member of their workspace (including the one person on a local install), the card connects their own account straight away. After a person finishes a card, the conversation follows the agent's continuation instead of leaving it below the fold behind "Jump to latest"; focus stays on the card. Events from a card's setup dialog no longer count as reading the conversation, so scrolling or pressing keys there no longer stops following or loads older history.
- f0fe215: A content page's start padding can now be widened by the host through the `--og-content-page-start` CSS variable, for example where something sits over the page's top-left corner.
- 7f627c9: A page in the Opengeni desktop app's own window that lacks the shell's bridge now reports it once per page load as the `desktop_bridge_missing` client signal, with the platform and the app version from its user agent. The API counts it in `opengeni_client_desktop_bridge_missing_total{platform}` and logs the version. The account menu no longer offers to download the desktop app inside the app when the bridge is missing; it follows the same desktop decision as the layout (`desktopPlatform`). A window the app opens with `openBlankTab` is named so it keeps the web layout, like other windows the page opens. `desktopPlatformIn` exposes that decision for a given window.
- a4d583d: The Opengeni desktop app's pages keep room for the window controls even when the shell's bridge doesn't reach the page. `desktopPlatform` takes the platform from the bridge, or from the app's user agent (`Opengeni/<version> … Electron/<version>`) in the app's own window; a window the page opened, which has the system title bar, and a page in a frame keep the web layout. `installDesktopShell` marks the document from it. Layout choices (`windowControlsInPage`, the rail's width and drawer breakpoint) follow it; desktop capabilities still come only from the bridge. On macOS, a full-window Site's Back no longer falls under the traffic lights when the bridge is missing.
- f0708a1: The desktop app has a thin bar across the top of the window for the window controls: the macOS traffic lights (and the wider badge macOS shows while the window is shared or recorded) and the Windows caption buttons. The page starts below it, so nothing is drawn under the controls in any layout, and the collapsed rail stays narrow.

  - `@opengeni/desktop`: the macOS traffic lights are centred in the 44px bar, and the Windows caption buttons are 44px tall.
  - `@opengeni/react`: the session rail keeps its brand row on every platform. Layers that fill the window (a full-window Site or panel, the image viewer, side sheets) carry `data-window-layer`, so a host can start them below its own window bar. `windowControlsInPage` is deprecated.

- 9d2eca5: The new-chat page now suggests everyday asks to people who chose "Get help with everyday things" at sign-up: plan a trip, write a message, explain something, help me decide, plan the week's meals and learn to do something. People who chose to add agents to a product keep their own agent and the demo first, and everyone else keeps the general suggestions. They also see "What can I help with?" with an "Ask anything" text box, following their current answer on any device. "Explain something" offers attaching a photo only where uploads are available (`NewSessionStarters` takes an optional `fileUploads`). `signupStarterSet` now also returns `"everyday"`, `newChatWording` gives the matching heading, placeholder and composer label, and `EVERYDAY_SESSION_STARTERS` lists the new set.
- 73d6402: A question card with one question now says "Send answer" instead of "Send answers", on the web and on the phone. `HumanInputFormMessages` gains an optional `submitOne` label for that case. A host that sets its own `submit` label keeps it for single questions too unless it also sets `submitOne`.
- a6004c8: Compact a session's context right after a person's own turn leaves a root session at its automatic compaction threshold, instead of making the next message wait for the checkpoint. The idle request reuses the existing `/compact` maintenance execution, is labeled `proactive` (new `sessions.compact_request_trigger`, migration 1102), skips sessions with an active goal, a held `wait_for_input` or a pending delayed wake, is dropped (with a `capacity_unavailable` skipped landmark) when no subscription capacity is available, and can be turned off with `OPENGENI_IDLE_CONTEXT_COMPACTION_ENABLED=false`. API turns are not included. While it runs the session counts as running, as during a manual `/compact`.
- 9d2f49f: Follow-ups to "Let the agent decide":

  - `HumanInputFormMessages.letAgentDecide` and `agentDeciding` are optional. A host's complete message set written before they existed type-checks again, and the card uses the default copy for any key the host leaves unset.
  - The chat record of a hand-off stops reading the sub-session's question once it is settled.
  - The record's words, and the text of the hand-off message, come from the host's messages (`humanInputDelegation.message`, `humanInputDelegation.messageWithMore`, `messageTimeline.agentDecided`, `messageTimeline.agentDecidedSummary`, `messageTimeline.answeredSummary`).
  - A hand-off another member sent no longer reads "You let the agent decide". It reads "Let the agent decide" under that member's name.
  - A hand-off that fails to send shows the API's own message on the card (for example "The service is updating. Try again in a moment."). It no longer shows the generic "The request could not be completed."

- 5c0e0cc: In the macOS app, the top bar and the sidebar now form one window surface, so the traffic lights no longer sit in an empty strip of their own. The sidebar toggle moves into that bar, beside the traffic lights, and on a chat the chat's header (title, access, model, status and actions) is the bar's row, so the chat gets the whole panel below it; it steps aside while a full-window Site, artifact or workspace covers the chat. The main pane sits on the window as an inset, rounded panel. Full-window Sites and the maximized workspace use the same panel. The web app, Windows and Linux are unchanged.

  For hosts: only inside the Opengeni macOS app, the rail's sidebar toggle renders into `[data-window-bar-controls]`, in a host at the start of the body, and on a chat the canvas carries `data-window-bar-row` and the `--og-window-bar-row-left` property. The session rail carries `data-shell-rail`, and while a full-window artifact, Site or workspace is open the document root carries `data-window-layer-open`.

- bd7200d: Meeting notes are written entirely in the meeting's language, headings included. The built-in summary and the "Meeting notes" automation template named their Decisions and Action items headings in English, and notes for a meeting held in another language kept those two headings in English.
- 1b856da: Meetings components now take light or dark and their surfaces from the page they sit on, as the embedded chat already does. Before, a meeting page embedded in a host whose background differs from Opengeni's page grey showed grey boxes behind its sticky player and its "Ask about this meeting" bar, and its cards kept Opengeni's greys. The outermost meetings component now resolves the host theme on its root (`data-og-host-theme`), so those bars, the page background and the cards follow the host's own background in dark and light. Inside Opengeni's app, or under another embed root, nothing changes.
- 5a3ed41: Each person can now choose their own default machine in a shared workspace ("Your default machine" in workspace settings). The chats they start begin there, ahead of the workspace default, and any active machine they can use qualifies, including their own Only me machine. Nobody else sees the choice. Automations and agent-created chats keep following the workspace default, and when the chosen machine is removed or no longer available, the person's new chats fall back to the workspace default until they choose again. `GET`/`PUT /v1/workspaces/:workspaceId/my-default-execution-target` reads and saves it (`null` clears it), the new-session draft returns it as `memberDefaultExecutionTarget`, and the SDK adds `getMyDefaultExecutionTarget` and `setMyDefaultExecutionTarget`.
- a2d28b5: In a Personal workspace, Connect provider now opens the key form for that workspace for OpenRouter, Vercel AI Gateway, Opper and Anthropic, as it already did from an organization key's page; organization keys can't be used there. Sandbox environment versions and changes, and Site Data records, now show the person's name (or "you") instead of a raw `user:user:<id>`. New sandbox environment versions record the person's subject once (`user:<id>`); older versions still show the right name. Site Data owners keep their documented form. Removes the unused Site agent member SQL tool list and corrects a stale comment about Site agent workspace tools.
- d215541: The phone meeting screen can now teach Opengeni your voice, as the web page does. Naming a speaker offers "It's me", and naming yourself asks once whether to remember your voice so later meetings suggest your name. A name suggested from a voice shows as Suggested and is confirmed or turned down from its speaker (with Undo), and a named person's voice is remembered or forgotten from their speaker. Someone outside the workspace is remembered only after confirming they agreed. A new name typed on the phone now joins the people directory, as on the web, so their voice can be remembered too. `useMeetingView` gains `viewer` and `voiceRecognition` options for this, and `recordings` to use a recordings client of the host's own.
- 36c1fea: GitHub status checks that run on their own (when the app loads or its window comes back into focus) no longer show a "GitHub status unavailable" toast when they fail. Where GitHub is used, the failure shows in place instead: the repository picker says GitHub couldn't load and offers **Refresh list** (rather than "No repositories" and setup), and the GitHub card and integration page show it with **Retry**. The check also runs again on its own when the window comes back into focus or the connection returns, and, when Opengeni is briefly unreachable (a deploy or a network drop), it tries again by itself with a growing pause until Opengeni answers. The person's own GitHub status and the workspace MCP tools, loaded with every workspace view including chats, do the same: a deploy no longer pops "Your GitHub account is unavailable" or "Couldn't load workspace MCP tools", and their other failures show one toast that a repeat replaces. A refresh or retry the person starts still shows one toast, and repeated failures replace it rather than stacking. `refreshGitHub` and `refreshPersonalGitHub` accept `userInitiated`.

  Reading a workspace's GitHub repositories no longer asks GitHub every time: the API reuses GitHub's repository list for a minute, shares one GitHub call between concurrent reads, and keeps answering with the last good list for up to 30 minutes while GitHub has an outage (not when the installation or configuration is gone). A list fetched before the workspace last connected GitHub is never reused, and connecting again reads GitHub's list fresh. Syncing repositories still asks GitHub and reports its failure. Which repositories the workspace may use is still checked on every read. When GitHub refuses the connected installation (401, 403 or 404 rather than an outage), listing or syncing repositories now answers 409 asking to reconnect GitHub instead of a 502, so clients don't keep retrying it.

- accee33: Removed the deprecated surfaces that nothing uses any more:

  - The first automation API (`/v1/workspaces/:workspaceId/automations/*`, `POST /v1/webhooks/automations/:endpointId`, `@opengeni/sdk/automations` and the `automationRunWorkflow`) and PR Review built on it (`/v1/workspaces/:workspaceId/pr-review/*`, the Opengeni Lens GitHub App connect flow, `@opengeni/sdk/pr-review` and the `OPENGENI_PR_REVIEW_GITHUB_*` settings). Automations are scheduled tasks with event triggers; pull-request review is one of their templates.
  - Resumable transcription recordings (`/v1/workspaces/:workspaceId/transcription-recordings/*` and their SDK methods). Recordings and the live transcription stream replace them.
  - The retired Knowledge search routes that only answered `410 gone`, and the "retired action" entries of the app action catalog.
  - The deprecation-notice machinery: the API no longer sends `Deprecation`/`Sunset` headers and the SDK no longer has the `onDeprecation` option or `parseDeprecationNotice`.
  - The response-header compatibility for SDKs up to 7.x: responses always carry `x-opengeni-api-contract`.

- 399757b: Removed the retired Variable Set and environment fields. Vaults replaced Variable Sets in SDK 2.0.0, and nothing has used these fields since:

  - Sessions, session create and fork requests, new-session drafts and scheduled tasks no longer carry `variableSetId`, `variableSetIds` or `environmentId`.
  - Rig versions and rig create or edit requests no longer carry `defaultVariableSetIds`.
  - Incident telemetry data routes name their vault and secrets directly (`{ kind: "vault", vaultName, secretNames }`), and the preflight reports `requiredVaultNames` and `requiredSecretNames`.
  - The retired `variable-sets:*` and `environments:*` permissions in workspace roles, memberships, API keys and Slack access requests are rewritten to the matching `secrets:*` permissions.

- 4b0dd0b: Approval cards for long HTML emails now list every link target the reader doesn't show in full, however long the message is: a "Links:" line leads the preview, and past its limit it says "Details lists every link": the message's Details now lead with every link target, one per row. Link addresses decode exactly as a browser does (every named reference, numeric references without a semicolon), a form's submit destination counts as a link, and paragraph and line breaks read as breaks. Operation titles: Stripe-style ids such as `PostChargesChargeCapture` read "Capture charge", and `users.user.sendMail` reads "Send an email".

  The integration Connect card keeps every line true: when it can no longer see the sign-in window while waiting (closed, or cut off by the provider's page, as Google's sign-in pages do) it keeps waiting and says "Finish signing in to {name}. If you closed the sign-in window, open it again." with an Open sign-in window button, the "You can close the sign-in window." reminder goes once the window closes, and keyboard focus stays on the card after connecting. The code step reads in order (code, a button-styled "Open the sign-in page", then what to do there) on web and phone, and "Waiting for authorization" now reads "Waiting for you to sign in".

- 3c0113c: Models a deployment lists under the same name now say what differs, so a person
  never sees two choices they can't tell apart. When two routes of a model share a
  name in the same picker group, a route whose residency record names its
  processing geography gets it in brackets ("GPT-6.1 Sol" and "GPT-6.1 Sol (EU)");
  twins in the same place get their connection's name instead ("Sonnet 4.6 (Your
  OpenRouter)"). Models with a unique name, and organization and workspace copies
  of one model, keep their plain name. The picker search, the trigger and the
  Models settings view use the same names, and `list_models` shows the agent the
  same name for such twins. The SDK's `ClientModel` type now includes the
  `residency` record the server already sends; `@opengeni/sdk/model-picker-order`
  exports `modelLabelDistinctions` and `@opengeni/react/model-policy` exports
  `withDistinctLabels` for hosts that build their own picker rows. EU
  status still comes only from residency records, never a name.
- 717284e: Opening a long session shows its newest conversation sooner. The first history read now asks for 255 events, the most the server answers in a single database query, instead of 1,000, which it read in four sequential batches walking back through the conversation. On a long session whose rows were no longer cached that first read took 35 seconds before anything rendered. Scrolling back and catching up still load up to 1,000 events per page.
- 4246602: Add a SharePoint integration for work and school Microsoft 365 accounts: search SharePoint content, find sites, browse document libraries and read files, read lists, and add or update list items with review. Microsoft Search is a reviewed read limited to file, list and site results, so searching never asks for approval and cannot reach mail, calendar or chats. Reviewed read-only overrides are part of the revision identity. OneDrive and Outlook Contacts consent screens now label only the permissions they actually request. The Atlassian and Google Drive catalog entries are marked as verified vendor-hosted servers, and Atlassian gets consent copy and admin guidance for allowing the Opengeni domain.
- 579964c: A Site opened from the Artifacts page has a Back to it at the start of the Site's toolbar, returning to the page with its tab, search, sort and scroll; the browser's and the desktop app's Back go there too. A Site shown in a session's workspace panel has one expand, "Expand Site to full window", instead of that and the panel's look-alike Maximize; the other panels keep Maximize.

  - `useWorkspacePanelOwnsExpand(owns)`: a `WorkspaceDock` panel showing its own expand control hides the dock's Maximize while it is on screen (a maximized dock still shows Restore).
  - `SiteView` and `ArtifactSandbox` take `toolbarStart`, a control drawn first in the Site's toolbar (and above its loading or error state).
  - The dock's machine status truncates with an ellipsis instead of being cut off in a narrow panel rail.

- 0f77b2d: The chat beside a Site in the console's Site view is now the regular chat: the same composer, messages and status row as a chat on its own page, without the session panel. Screenshots and files can be pasted or dropped into it (a drop anywhere on the chat, or on the Site beside it, attaches to the chat instead of going to the Site's frame), and it has the attach button, dictation, voice, the model chip, the queue and steer row, find and fork. A new conversation started there uses the regular composer too, including attachments and voice-first start. The chat can move to the left of the Site from its ⋯ menu (Move chat to left or right); the side is remembered per person with its width and hidden state, and stays on the right by default. The API accepts file attachments on a new conversation created from the console's Site view (the Site's id and version without a frame marker); Site code still can't attach anything.
- 2d026a5: The app has a Start recording action with its own key: ⌃⌘N on Mac, Ctrl+Alt+N on Windows and Linux. It is in ⌘K, the ⌘/ shortcut sheet and the desktop File menu, and it starts the same recording as the Meetings page's Start recording button. While a recording is going it reads "Go to recording", and a Stop recording action (no key) stops it and opens the meeting. Where nothing records meetings or the browser can't record, both are left out of ⌘K and the shortcut sheet and greyed out in the desktop File menu.

  A start someone asked for outside the recorder panel, such as a desktop call notification's Record, now also starts after an earlier recording stopped or failed, as a click on Start does. A recording started with the button uses up a start still waiting, so it never begins a second one after Stop. A start without a title keeps one already typed in the panel.

- a84f101: Keep adjacent composer attachment touch targets from overlapping, so removing one file does not accidentally remove its neighbor.
- b12e9db: Chat timelines no longer show web-search citation handles that cannot be resolved. Besides complete handles, they now hide file citations, handles a model wrote as plain text (`citeturn0search1turn1view0`), a handle still streaming at the end of an answer, and stray delimiter characters from a handle cut short. Ordinary words such as "cite" and "excited" are untouched.
- af0437b: A voice session's handoff now answers in the language the user spoke: the note that carries the remaining transcript to the agent asks it to reply in the transcript's language rather than the note's English. The timeline shows the handoff notice ("Voice session ended…") and the console's "Voice handoff" and "Voice request" labels through the host's messages, so they read in the reader's language.
- Updated dependencies [e1ebd25]
- Updated dependencies [44ba53b]
- Updated dependencies [d4fd76d]
- Updated dependencies [f385091]
- Updated dependencies [7a5395e]
- Updated dependencies [aa6b340]
- Updated dependencies [f2e1953]
- Updated dependencies [12b773f]
- Updated dependencies [7f627c9]
- Updated dependencies [1271da5]
- Updated dependencies [e8bc121]
- Updated dependencies [ecc876a]
- Updated dependencies [f6c6c0f]
- Updated dependencies [dfc7190]
- Updated dependencies [09972b5]
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
- Updated dependencies [accee33]
- Updated dependencies [399757b]
- Updated dependencies [21856c5]
- Updated dependencies [4b0dd0b]
- Updated dependencies [ce001ee]
- Updated dependencies [3c0113c]
- Updated dependencies [71bcf11]
- Updated dependencies [942fcc1]
- Updated dependencies [fb41dfd]
- Updated dependencies [31e07a6]
- Updated dependencies [a744c56]
- Updated dependencies [a895f0b]
- Updated dependencies [ad1dc82]
- Updated dependencies [b0f7062]
- Updated dependencies [670913f]
- Updated dependencies [3aaf6ed]
- Updated dependencies [0f77b2d]
- Updated dependencies [77f483f]
- Updated dependencies [a1e75dc]
- Updated dependencies [5cab358]
- Updated dependencies [35387c2]
- Updated dependencies [149a15c]
  - @opengeni/contracts@6.0.0
  - @opengeni/sdk@6.0.0
  - @opengeni/artifact-tool@6.0.0
  - @opengeni/connect@6.0.0

## 5.5.1

### Minor Changes

- 9180cf8: Dictation from anywhere in the desktop app: press a shortcut in any app, speak, press it again (or hold it while speaking), and the text is typed where the cursor is. Each shortcut can have its own language; on macOS a shortcut can be modifier keys alone (Control and Fn by default).

  - `@opengeni/desktop/dictation`: the main-process controller (`createDesktopDictation`, `Dictation`), which watches the shortcuts, shows a small progress window at the bottom of the screen, and types the text by pasting it and putting the clipboard back (macOS with Accessibility, Windows through PowerShell, Linux through xdotool, wtype or ydotool), or only copies it. It keeps the last 50 texts on the computer. `words` puts its small window in the app's language (`ENGLISH_DICTATION_WORDS` by default), and `language` sets what the first shortcut hears until the person picks another (it detects the language by default); the status names problems by code (`shortcutErrors[].problem`, `paste.blocker`) for the page to translate. `handleDictationIpc` answers the page; `@opengeni/desktop/preload/dictation` exports `exposeDictation()`, which defines `window.opengeniDictation` for apps that aren't the Opengeni desktop shell.
  - `@opengeni/react/desktop-dictation`: `DesktopDictationHost` records and transcribes for the shortcut on a signed-in page with the workspace's voice input, so each dictation is an ordinary dictation recording (a failed one offers Retry, a dismissed one stays saved for the composer). `DesktopDictationSettings` is the stock settings UI and `useDesktopDictation` the hook under it; `desktopShortcutLabel` and `acceleratorFromKey` name and record shortcuts.
  - `useVoiceInput` takes `recover: false` for a host that dictates somewhere else, and returns `release()`, which lets go of the current dictation without deleting it.
  - `@opengeni/sdk/desktop-bridge`: the `dictation` capability, the `DesktopDictation*` types, `getDesktopDictation()` and `DESKTOP_DICTATION_GLOBAL`.

- 1908715: Dictation listens for a vocabulary, and dictation from anywhere keeps each dictation's speech to play and transcribe again.

  - A dictation recording's `transcription` takes `keyterms` as well as `language`. The worker passes them to the voice input model when it takes keyterms: ElevenLabs Scribe and Azure Speech as keyterms, OpenAI and Azure OpenAI as the prompt (their text models now report `keyterms: true`, so meetings on them listen for keyterms too).
  - `useVoiceInput` takes `keyterms` and `onAudio`, which hands over each dictation's microphone audio with its text, and returns `transcribe(blob)` to transcribe audio kept earlier as a new dictation.
  - `@opengeni/sdk/recordings`: `uploadRecordingAudio()` uploads finished audio as a one-track recording.
  - `@opengeni/desktop/dictation`: settings gain `vocabulary`, `retryShortcut` (transcribes the last dictation again and types it) and `cancelShortcut`; the status reports `actionShortcutErrors`. The history keeps each dictation's speech on the computer (private to the person, deleted with the history), and `historyAudio(id)` and `transcribeAgain(id)` play and re-transcribe it. While dictation is on, the app opens at login.
  - `DesktopDictationSettings` offers the vocabulary, the retry and cancel shortcuts, and Play and Transcribe again on each recent dictation.

- e473f84: Products that embed meetings get the workspace's own choices without extra wiring, and a meetings-only phone app no longer gets call setup.

  - The recorder on `MeetingsListPage` (web) and `MeetingsList` (React Native) starts with the live transcript on when the workspace's `recordings.liveTranscript` setting says so. `GET /v1/workspaces/:workspaceId/recording-models` now returns `liveTranscript`, and `useRecordingModels` returns it too (undefined until the server answers, or from an older server). A host's own `liveTranscriptDefault` still wins; before, a host that passed none always started with it off, and a phone app had no way to follow the setting at all.
  - The Expo config plugin sets up calls only when asked: `["@opengeni/react-native", { "recording": true }]` now adds just the background recording setup, without the `voip` background mode, the `INStartCallIntent` activity or the generated Siri and Shortcuts intent. Add `call` to set up calls as well, or pass `"call": false` to leave them out of any entry. The plugin without options still sets up calls, as before.
  - On phones, "No sound is reaching the microphone" no longer appears during ordinary pauses. It now shows only when a recording has delivered digital silence since it started or resumed, which is what a muted, blocked or broken microphone delivers; a microphone that has picked up any sound is working, however long the pause.

- 8382bdb: Buying credits from a chat now takes one answer. When an agent opens a payment page through the app actions (`createBillingCheckout`, `createSubscriptionCheckout` and the two billing portals), the chat shows it as a card with one button that opens the exact page in a new tab, so nobody copies a long link by hand. For credits the card confirms the payment in place, with the new balance, once the person pays, in the web app and in `OpenGeniChat` alike; it checks only after the button was used, backs off from every 2 s to every 15 s and stops after 30 minutes. Links nobody opened show as expired once they lapse. The card is primary output like a presented image: conversation-first history keeps these calls (one classification shared by the client and the database filter), so it stays visible after a reload. Opening a checkout charges nothing, so the two checkouts no longer ask for a confirmation and also run in read-only chats; the billing portals, whose links can change the payment method or plan, keep a plain confirmation ("Open your billing page? It can change your payment method or plan.") and stay unavailable in read-only chats. The agent's result says what is true for each kind of page, including that test-mode pages are expected on deployments that take test payments. Action search now finds buying credits and the balance in everyday words. A checkout created without return URLs now returns to `/checkout-complete.html`, a small page that sends the person back and needs no sign-in, and the web app's `/billing` return opens organization billing instead of the general settings. The SDK session proxy now forwards `GET billing/checkout/:id` as the person, pinned to the workspace's organization and gated on `billing:read`. New contract exports: `PAYMENT_PAGE_ACTIONS`, `appActionPaymentPage`, `appActionNeedsConfirmation`, `appActionCallNeedsConfirmation`, `SESSION_EVENT_PRESENTED_APP_ACTIONS`, `SESSION_EVENT_PRESENTED_APP_ACTION_NAMES`, `SESSION_EVENT_APP_ACTION_ID_SPACE`, `presentedAppActionId`, `PresentedAppActionId`, `PresentedAppActionPage` and `isPresentedSessionToolCall` (also from the SDK); new React exports: `PaymentPageActivityProvider` and `PaymentPageActivity`.

### Patch Changes

- c866336: Connecting a computer that isn't connected yet is now an obvious action in the in-chat Connected Machine card. The card ends with an **Another computer** row whose **Connect** opens the connect flow, instead of a small link under everything else, and no listed machine gets the primary button just because it is the only one online. Screen control and the Chrome extension rows show only for the machine this chat runs on, so steps about a machine the person may not mean no longer compete with choosing or connecting the right one. Without a host connect callback, the embedded card's **Connect another computer** opens in place as a disclosure that says the steps happen on the other computer.

  On the web, the shared `ThisComputerCard` keeps **Connect another computer** as a secondary action beside a connected computer when the host supplied a connect path (`onConnect`, `downloads`, `openAppUrl` or `downloadUrl`). On the phone, `useNativeInChatConnect` accepts an optional `shareConversation` callback; with it, the computer offer explains that a computer connects from the computer itself and offers **Share link to this chat**.

- a4b57e6: In-chat connection requests now read the same to the person and to the agent, and the sign-in window ends cleanly in embedded chats. When the person in the chat can't connect the requested integration from the card (their access doesn't allow it), `capability_authorization_request` now tells the agent so, instead of the generic "posted for confirmation" message, so it no longer asks them to use a card that can't help them. Results for people who can connect are unchanged. The card and the server share one rule for this decision (`inChatCapabilitySetup` in contracts), and the server applies it to the same access the person's chat has: what their sign-in could do when they sent the turn's message, or their latest message in that chat for a turn the platform started for them, such as a wake-up, a child's result or a goal continuation (an embed token narrows it, and their own workspace counts without a membership). Without such a message it falls back to their membership (`readTurnSenderAccess` in db). The console's chat card uses the same rule, so it no longer offers Connect to a member the agent was told can't connect.

  In-chat connect cards also start sign-in with a new optional `finishInPopup: true` flag on `POST /v1/workspaces/:workspaceId/connect/attempts`. The provider's callback then lands on a small server page that closes the sign-in window (or tells the person they can close it) instead of loading a second copy of the host page in the popup. Without the flag the return URL behaves as before. Against an older server that rejects the unknown field, `ConnectController.begin` starts again without it, so sign-in keeps working and returns to the host page as before. Browser cards set it, because they sign in through a popup. Phone cards don't, because the system sign-in browser returns to the app.

  Reviewed catalog integrations no longer carry an "MCP server" label on their connection cards and dialogs, on the web and on the phone. They read as the service itself, with its name and provider. Servers someone added by hand, and registry entries nobody reviewed, keep the label (`showsMcpServerLabel` in `@opengeni/react/in-chat-connect-model`).

- 133a221: A smoother first run in the chat app. Adding credits from a chat or the new-chat page returns to that page with the draft kept and a short "You added $N in credits" confirmation, instead of landing in organization billing; embeds keep their existing new-tab checkout. With no usable credit, the new-chat page says so once in plain words ("Add credits to start chatting", or "Add credits to use this model" when the credit left covers only other models), with the one action that fixes it, and the failed-turn and credit-refusal notices say "Add credits", use the same wording from the organization's balance, and can top up in place through a new optional `onAddCredits`; `CreditRefusalNotice` takes optional `accountId` and `canReadBilling` for that balance check. The voice control renders nothing until a voice model can run, instead of a disabled button explaining which provider to connect. `ListRow` sets `aria-controls` only while its panel is rendered. In the web app, someone who chooses "Run agents in the cloud" gets an organization named after them (renameable in Organization settings or by asking in chat) instead of the "Create your organization" form, which the developer path keeps; and the model step lists Opengeni credits and the subscription providers first, with OpenAI, Azure OpenAI, OpenRouter, Opper and Vercel AI Gateway one click away under "Use your own provider account".
- 2483f32: The image lightbox closes on any click outside the image, at every zoom level, including the dark space right beside the image, the gutters around it and its caption. Before, once the image was zoomed, a click beside it zoomed it back instead. The zoom cursor now sits on the image and always shows what a click will do (zoom-in when a click enlarges, zoom-out when it shrinks); the backdrop keeps a plain arrow. In a desktop (Electron) shell, the whole lightbox opts out of window-drag regions, so a draggable title bar underneath no longer swallows presses on the close button or the backdrop. Its round buttons show hover and press feedback. `ZoomPanSurface` no longer zooms on a click beside the image; it calls `onBackdropClick` when given one and otherwise does nothing.
- cc59c02: The desktop app asks whether to record a call on a card of its own in the top right corner of the screen, instead of in a system notification. Focus and Do Not Disturb hid the notification, so a person in a call often never saw the question. The card shows above full-screen apps on every desktop and space, never takes the keyboard from the call, and has two buttons: Record and Not now (or Stop recording and Keep recording when the recorded call ends). A question to record goes away after 45 seconds unless the pointer is on it; a question to stop stays until answered. Closing or ignoring a question no longer holds back the next call's. Each question and its outcome is written, with the call app's id and the time only, to `meeting-detection.log` in the app's logs folder.

  Any Electron app that shows Opengeni's meetings can now offer this too. `@opengeni/desktop/meeting-detection` exports `createMeetingDetection` and `handleMeetingDetectionIpc` (with the card's words, so an app can show them in its own language), and `@opengeni/desktop/preload/meeting-detection` exports `exposeMeetingDetection()`, which defines `window.opengeniMeetingDetection`. The meeting recorder uses it when the Opengeni desktop bridge is absent (`getDesktopMeetingDetection` in `@opengeni/sdk/desktop-bridge`). A choice now waits up to a minute for the page to listen, so choosing Record while the window is closed still starts recording once it opens, and Stop recording goes to the page that records.

- 4a86d4d: Meetings name the person recording in apps whose users Opengeni has no name for, leave the call's echo out of the live text, and show a stopped meeting's tabs right away.

  - `POST /v1/workspaces/{workspaceId}/recordings` takes an optional `ownerName`. With computer or tab audio beside the microphone, the microphone is the person recording; when Opengeni has no name for them (an app's own users usually have none), this name adds them to the speaker directory, so the transcript's microphone reads their name instead of "Microphone". A name Opengeni already has, and a person already in the directory, stay as they are. `createBrowserRecorder` and `useRecorder` take `ownerName` and send it only for such recordings; the React recorder panel sends its `viewerName`.
  - The live transcript no longer repeats the others in a call under the person recording's name when they have no headphones. A microphone line is left out when at least two of its words, and 70% of them, were heard in computer audio within two seconds. `withoutLiveMicrophoneEchoes` is exported from `@opengeni/react/recordings`, and `LiveTranscript` takes the recording's `tracks` to apply it.
  - After Stop, the meeting page switches to Summary, Transcript and Notepad (with Ask) at once. It stayed in the recording layout until a reload while the recorder still held its live text.

- d569481: `OnboardingUseCase` gains `everyday`, with `isOnboardingUseCase`. The self-service organization setup request accepts `useCase: "everyday"`, and migration 1006 lets the organization keep that answer as itself (the first answer still wins). In the web app, "How do you want to use Opengeni?" now leads with "Get help with everyday things", which creates an organization named after the person and goes straight to the model step and their first chat; the two existing choices are unchanged.
- 1cc657b: A chat's payment page card now loads only when a conversation shows one, so its card and payment glyphs no longer ship in every session's startup code. Conversations still provide the payment check up front: `PaymentPageActivityProvider` and `PaymentPageActivity` are unchanged and now come from a small module of their own.
- 52a0439: Keep the chat header on a single line at every screen size, including small phones and 200% zoom. A child chat's link back to its parent is a small line above the title again instead of sharing its row. When the row has no room, the least important parts (access key, model, Site, machine, find, pin, automations, full access, access, status, then the workspace panel) move into the "…" menu, where they work as before, and come back when there is room. The automation chip's words shorten to its icon before anything moves.
- 031e173: The person's current answer to "How do you want to use Opengeni?" is kept on the server per organization (migration 1007). `GET /v1/organization-memberships` returns it as an optional `signupUseCase`, and the new `PUT /v1/auth/organization-onboarding/use-case` changes it for an organization the person belongs to. In the web app, going Back and choosing again updates it, and the new-chat suggestions follow the account to any browser; the first answer is still recorded as before.
- 5ea8c5c: The Site column and the Site toolbar carry `data-site-column` and `data-artifact-toolbar`, so desktop app styles can keep the Site's toolbar clear of the macOS window controls beside a collapsed rail.
- a56e1ea: Use compact session summaries for command-menu title searches instead of downloading full session configuration. Clients without the optional summary method retain the existing full-page search.

  Ignore late answers from cancelled searches before they can add stale results to the local chat list.

- Updated dependencies [fa7516a]
- Updated dependencies [23fb6ef]
- Updated dependencies [f23588a]
- Updated dependencies [1600e2d]
- Updated dependencies [e555018]
- Updated dependencies [22b129b]
- Updated dependencies [9180cf8]
- Updated dependencies [1908715]
- Updated dependencies [a4b57e6]
- Updated dependencies [729329e]
- Updated dependencies [cc59c02]
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
- Updated dependencies [9c8a5d5]
  - @opengeni/sdk@5.5.0
  - @opengeni/contracts@5.5.0
  - @opengeni/connect@5.5.0

## 5.4.2

### Minor Changes

- 3a2f020: Chat messages now render math. Inline and display TeX written with `$…$`, `$$…$$`, `\(…\)` or `\[…\]` is typeset with KaTeX on the web and as SVG (MathJax's TeX font, no WebView) in the native timeline, instead of showing as source with its backslashes stripped. Single dollars follow Pandoc's rule, so prices such as `$5 and $10` stay text, and code spans and fenced code are never touched. The math renderer loads on the first message that contains math: KaTeX is a separate lazy chunk on the web, and the native MathJax engine is evaluated only on first use. Invalid TeX shows its source instead of breaking the message. The shared delimiter handling is exported as `@opengeni/react/markdown-math` (`prepareMathMarkdown`, `mayContainMath`).
- 01188c9: Automations can listen to any app's webhooks. A new `custom` webhook adapter reads deliveries as the source's `format` describes: how they are signed (`standard_webhooks`, `hmac_sha256` of the body in a header, `timestamped_hmac_sha256` as Stripe and Tailscale send, or a shared `token` header), whether one delivery holds a list of events, and where each event's type, id, time, summary, subject, link and actor are (JSON paths or headers). The whole event is the event's data, so trigger conditions can filter on any field. The secret is the one the app shows or the one a person set there; the source waits, blocked, until it is pasted. `WEBHOOK_FORMAT_PRESETS` ships Tailscale's format: "Add a source" offers Tailscale by name, and its event-type catalog lists Tailscale's documented types.
- 659f5a4: Managed accounts can sign in with a passkey. Anyone signed in adds passkeys under their sign-in methods and can then sign in with one instead of a password. With `OPENGENI_MANAGED_AUTH_PASSKEY_SIGNUP_ENABLED=true`, a new person can also create an account with only a name and a passkey, with no email address or password, while new sign-ups are open and no email allowlist is set. Passkeys are offered on trusted HTTPS or `localhost` origins in the legacy session-set mode. Rolling migration 0998 adds the passkey store but withholds it from the runtime role, so passkeys stay off until a later release grants it.
- 5b9feb9: A meeting recorded with computer or tab audio now names its microphone after the person recording. Each new transcript version gives the microphone speaker the owner's person in the speaker directory, added for them if they have none, as "It's me" does, with `source: "track"` and no confidence, so it doesn't read as a voice suggestion. A name someone gave that speaker carries over through every later version instead (before, one that had already carried over once could be replaced), and a microphone alone stays diarized as Speaker 1, 2…. The naming enrolls nobody's voice: it gives no agreement, and an unconfirmed `track` speaker never teaches a voiceprint. Starting such a recording adds the owner to the directory, so the live preview shows the microphone under the owner's name to everyone watching (the person recording sees their own) and the computer or tab audio as "Others". New exports: `recordingMicrophoneIsOwner` (contracts), `ownerLiveLaneName` (react), `workspaceMemberDisplayName` and the `TrackSpeaker` type (db); `MeetingsListPage` and `RecorderPanel` take an optional `viewerName`, and `createRecording` an optional `ownerName`.
- 454ca0a: A transcript that failed because its model's provider has no key now names the model and that provider ("Scribe v2 needs ElevenLabs, which isn't connected…"), on the web and on phones, instead of saying that no transcription provider is connected. It suggests trying another model only when the deployment offers more than one, and for a provider the deployment itself pays for it points to whoever runs the deployment rather than to Organization settings. `transcriptErrorText` takes an optional third argument with the model's and provider's names, and optionally its `funding` and whether the deployment is `pinned`.
- de7087a: Agents can write a meeting's notes. The new `meeting_notes_save` tool replaces a meeting's written-up notes (Markdown) as the person the session works for, so it reaches exactly the meetings they can see. It needs `sessions:create` and the revision `meeting_read` gave, so edits made in the meantime are not overwritten. `meeting_read` now also returns the meeting's notepad and its notes with their revision. In the timeline the tool shows as "Saving meeting notes", and it is part of the Meetings capability group.
- 454ca0a: A meeting recording no longer stops when the person switches to another workspace. The recorder stays with the workspace the recording started in until it stops, then moves to the workspace shown. On the web and in the desktop app the recorder is also kept through a dropped connection or an update. After Stop, a recording made in another workspace opens in its own workspace. `MeetingRecorderProvider`'s `onOpenMeeting` now also receives the meeting's workspace ID. `useMeetingRecorder()` returns the recorder's `workspaceId` and `openMeeting`, and `createMeetingRecorderStore` takes an optional second argument that opens a meeting in its workspace. `MeetingRecorderProvider` takes an optional `scope`, such as the signed-in person's id, for a host that mounts it above sign-in: a new value ends a recording at once, and null means nobody is signed in, so nothing records and a desktop "Record" request is not kept for whoever signs in next. The console passes the signed-in person, so signing out or another person signing in ends a recording at once. `MeetingRecorderStore`'s new `workspaceId` and `openMeeting` members are optional, so stores made by hand still type-check.
- 4e83a4d: The meeting page reads like notes. `MeetingDetailPage` has Summary · Transcript · Notepad tabs under the title, opening on Summary when the meeting has written notes and on Transcript otherwise; while the meeting is recorded on this device it keeps the single page with the recording bar, notepad and live preview. An unsaved edit of the Summary survives switching tabs, and changing `recordingId` starts the page fresh for that meeting. Transcript turns show the speaker's name once in their colour above a soft bubble, and a pencil on hover or focus opens "Correct the words" directly beside the ⋯ menu. The Summary shows `[Name](speaker:<label>)` and `[Name](person:<id>)` mentions as chips with the speaker's or person's current name (unknown ones read as plain text), and Copy copies the Markdown with names in place of mentions (code and images stay as written); the format is documented under Notes in `docs/recordings.md`. The standalone `MeetingNotes` shows mentions as their plain link text. A new optional `onAsk(recordingId, question)` adds "Ask about this meeting" under Summary and Transcript; resolve false to keep the question when the host couldn't take it. New English keys: `meetings.ask.couldNotAsk`, `meetings.ask.placeholder`, `meetings.ask.send`, `meetings.detailPage.show`, `meetings.detailPage.summary`, `meetings.notes.copied`, `meetings.notes.copy`, `meetings.notes.couldNotCopy` and `meetings.transcript.correctTheWordsOfNameAt`. The `@opengeni/react/testing/meetings` ready meeting's notes now use mentions.
- 96502c5: A message someone else sends to a chat that runs on another member's personal machine no longer blocks the chat. It waits for the machine's owner instead: it never starts or interrupts the owner's turns, the owner's next message brings it to the agent as context, and it runs on its own once the chat moves to a machine the sender may use. Steering a waiting message, and an agent steering such a chat on behalf of somebody else, are refused with a clear reason. Send results report `waitsForMachineOwner`, and the chat's machine explanation lists whose messages wait (`waitingMessages`). This takes effect once a later release grants the runtime the new machine-owner lookup; until then chats behave as before.
- 0408d62: When an agent asks for a connection in chat, the phone app now shows the same connect card as the web chat instead of a dead-end "needs to be reconnected" note. OAuth opens the system sign-in browser and returns to the conversation; key-based setup uses the native secure field; the card follows the setup's saved state, and the agent continues once the connection is ready. A first connection no longer says "reconnect". The card choice, setup state and sign-in window handling now live in renderer-neutral modules that the web and native cards share (`@opengeni/react/in-chat-connect-model`). Native approvals show app actions as the readable confirmation card the web shows, a settled approval shows a check instead of a warning, and question cards render their Markdown, help text and option descriptions as on the web. React Native's `AbortController` gains the standard abort reason and `signal.throwIfAborted()` when the runtime lacks them, which the connect flow relies on.
- b18d187: Failures no longer show people text that was written for operators. When a turn fails with an unclassified error, or with one of the few codes whose recorded text is an operator diagnostic (`pre_claim_failure`, `interrupted_turn_retired`, `worker_death_redispatch_exhausted`, `sandbox_command_observation_unavailable`, `sandbox_command_start_outcome_unknown`, `sandbox_materialization_verification_failed`, `invalid_sse_terminal`), the timeline names the outcome instead: the startup step the turn failed at, in that step's own words ("Sandbox didn't start"), or "The turn stopped unexpectedly". The recorded text stays reachable: as the turn chip's hover title, behind Details on a failed turn's notice, and behind Details on the failed startup step, which now expands to show its recorded error (except under `toolDetails="plain"`). The failed-session banner uses the same rule and says "The sandbox didn't start." when that is what happened. Copy the worker writes for people (coded provider, subscription, MCP and other failures) is unchanged, and stored events, including the text the agent reads, are untouched.

  Because the projection now presents the failure once, `TurnEndItem.failureText` and the timeline groups' `failureText` hold the people-facing summary, with the replaced text in the new optional `failureDetail`; `TurnSummary` takes a matching `failureDetail` prop. React Native and other renderers of `failureText` get the plain summary without changes. `StartupPhaseItem` gains an optional `detail`, and `presentFailure` returns a `diagnostic` flag.

- 6a280a7: New `@opengeni/react-native/meetings` entry, so an app can add meetings to its phone app with the same screens the Opengeni app uses. `MeetingRecorderProvider` holds one recorder above the screens (recording keeps going while the person moves around the app or locks the phone), `MeetingsList` is the meetings page with the recorder on top, and `useMeetingView` gives one meeting's transcript plus the actions for the host's own header menu. They read the client and workspace from `OpenGeniProvider`, take an `externalRef` to scope a list (and new recordings) to something in the host, and every label comes from the shared Opengeni catalog under `native.meetings.*`, so hosts translate them like the rest.
- 1320698: Agents can link another chat as `[title](session:<sessionId>)`. `parseOpenGeniLink` returns a `session` target and `openGeniConsolePath` maps it to the chat's console route. A link resolver may now return `{ href, open }`: a plain click runs `open` in place while modified clicks keep the browser's handling of `href`. The console opens chat references in place, and a reference no host resolves shows just its title.
- 936d9e0: Add optional Turnstile signup verification, reversible promotional-credit holds, and signature-backed repeated free-credit claim detection. Keep purchased credit and incurred usage settlement intact, with tenant-safe balance projections and owner-only audited review controls. All enforcement defaults off and requires explicit deployment configuration after every funding reader is upgraded.
- f1579d6: The Site view header says whether a Site is on the web, and publishes it from there. A published Site shows "Published", whose menu names the address with Open, Copy link and, for people who can publish, Publishing settings; an unpublished Site shows Publish to those people. Publish and Publishing settings open the Site's own publish form (the same form, permissions and publication as its Settings tab) in place of the Site, with the chat still beside it. The Site view no longer shows the frame's "Live" label, so "Live" never reads as "on the web"; Updating and Reconnecting still show. In the app components, `SitePublicLink` is now `SitePublicationControl` (it takes `onOpenPublishing` instead of linking to Settings), `useSitePublicationLink` returns `{ load, update }`, and `SitePublishPage` accepts `onSubmitted` and titles a published Site's form "Web address" in every layout.

### Patch Changes

- d649005: An open chat's artifact list no longer reads the catalog once per sub-session. `GET /v1/workspaces/:workspaceId/artifact-catalog` takes `includeSubSessions=true` with `sourceSessionId`. The server then lists that chat and the sub-sessions its lineage lists (depth 5, 200 at most) in one keyset-paged query. It authorizes those sessions in one batch and skips any the caller may not read, and each item keeps its own `sourceSessionId`. The session dock now makes two paged reads per refresh (active, then archived) however many sub-agents the chat started, with no lineage read or per-sub-session cache. It keeps at most one refresh in flight and runs one more afterwards if new tool output arrived meanwhile. Before, a chat with about 50 running sub-agents re-read up to about 100 catalog pages on every turn end and overlapped those reads on a busy chat. Rolling migration 0991 lets the published-file listing routine accept a bounded `sourceSessionIds` list. The previous release's single `sourceSessionId` keeps its meaning.
- 768b175: `@opengeni/react/composer` now exports `PauseButtonSlot`. Place it at the end of `Composer.Controls` in a custom composer: while nothing is working and Pause is hidden, it keeps Pause's room in the row, so controls such as the model picker keep one width instead of jumping each time Pause comes and goes.
- 801743c: A connected MCP server's own icon now shows as its connector logo. When a workspace connects or enables its own (custom) MCP server, Opengeni reads the `icons` the server lists in its `initialize` reply (`serverInfo.icons`, MCP 2025-11-25), picks the best one for a single tile (theme-neutral before light or dark, vector before a large raster, favicons last), and stores it as the item's logo. Icons go through the same checks as vendored catalog logos (an image type the asset route serves, at most 512 KB, no scripts or external references in SVGs), are fetched through the deployment's outbound network policy with a timeout and at most three redirects, and are served from `/v1/catalog-assets/...`, so the browser never loads them from the server's host. A server without a usable icon keeps its monogram and connects as before. Tool steps from such a server also find the logo by the server's host. Editing a custom catalog item no longer clears its logo. New `@opengeni/capabilities` exports: `mcpServerIcons`, `rankMcpServerIcons`, `decodeDataUriIcon`, `validateLogoAsset`, `catalogAssetObjectKey` and the other logo-asset checks previously private to the catalog scripts; new `@opengeni/db` export `setWorkspaceCapabilityCatalogItemLogo`.
- cb5f4d7: Capability logos now look the same on every surface. `LogoTile`, `CapabilityLogo` and `ConnectionLogo` measure each logo once after it loads (new `logo-fit` helper, cached by URL): a roughly square image with opaque edges is an app icon and fills the tile, anything else is a mark and sits padded on a light plate in both themes, so dark marks no longer disappear on dark backgrounds. An image the browser cannot read (a cross-origin asset without CORS) is treated as a mark. `LogoTile`'s `fit` now defaults to `"auto"`; `"cover"` and `"contain"` still force a treatment. `CapabilityLogo` is now drawn by `LogoTile` (same sizes as before). `ConnectionLogo` exposes the decision as `data-fit` and, like `LogoTile`, shows a missing logo as a monogram on surface-2 in both themes; the `--og-connection-icon-padding` variable is gone and dark marks use `--og-connection-mark-plate` (default `--og-color-fg`).
- ebf148a: Add an `@opengeni/react/meetings-recorder` entry so a host can mount the meeting recorder provider without loading the whole meetings kit at startup.
- a2ae2ce: When the desktop app can't record computer audio, the recorder now says why in the viewer's language instead of showing the desktop app's English sentence under a translated title. The recorder's `error` carries a new optional `reason` (`permission_denied`, `sound_server_unavailable`, `unavailable` or `capture_failed`, the desktop bridge's codes), and `RecorderCaptureError` has the same `reason`. The meetings recorder maps each one to its own message: macOS points to Screen & System Audio Recording in System Settings, Linux says no sound server is running, and the others suggest recording without computer audio. New message keys: `meetings.recorderPanel.computerAudioIsnTAllowed`, `allowThisAppToRecordComputerAudio`, `noSoundServerIsRunning`, `thisComputerCanTRecordItsOwnAudio` and `computerAudioDidnTStart`. The recorder's track labels now size to the longest label, so a longer translation of "Computer audio" is no longer cut off, and the level bars line up.
- cb15454: Meetings pages now show every label in the host's language. Recording lengths ("45 sec"), list states ("Uploading", "Transcribing"), transcript error advice, default speaker names ("Speaker 2", "Microphone", "Shared audio"), the default meeting title and dates come from the message catalog and locale under new `meetings.recordings.*` keys, and language names follow the locale ("Norsk bokmål" in Norwegian). The `@opengeni/react/recordings` helpers take an optional `OpenGeniText` and keep their English output without one. `@opengeni/contracts` adds `recordingSpeakerDefault`, which says what an unnamed speaker label is, so a client can name it in its own language.
- 627bcd6: Meetings started without a title show a local, readable title instead of the server's UTC stand-in. `meetingTitle` is exported from `@opengeni/react/recordings`.
- a5a9336: A meeting page or list showing a meeting that is still being recorded, here or on another device, now reads it every 10 seconds, so it notices when the recording stops and moves on to the transcript instead of staying on "Not finished yet".
- 0da62e3: Meetings menus and dialogs keep Opengeni's styling when a product embeds the meetings pages. They used to open under the host page's `<body>`, outside the scoped stylesheet, so the speaker menu, the visibility menu and the Correct the words dialog showed up unstyled and see-through. Each meetings component now opens its overlays in a styled layer that carries its theme, or in the app's own portal container when there is one.
- 2a29ac1: Meetings say less, more plainly. Explanations of how things work inside (versions, model words, where audio is kept, "pieces of audio") are gone; each state says the one thing that matters and what to do. While recording in the desktop app the panel just says what it records, and an unnamed meeting started on the web is named after when it starts ("Meeting, Oct 26, 12:15") instead of getting the server's "Recording 2026-10-26 11:15 UTC".

  Form dialogs, confirm dialogs and detail sheets read their default Cancel, Close, Loading and Working… text from the host's messages (`formDialog.*`), so a translated product no longer shows them in English.

- a8b429e: Meeting model prices now show only where the workspace pays them. `GET /recording-models` returns `usdPerHour` for a model on the workspace's own key, and for a deployment's model only where its use is charged in credits; otherwise it is null. The recorder's live transcript switch, on web and phone, then says nothing about cost instead of "Uses extra transcription credit", so people whose deployment covers transcription no longer see a provider's list price.
- 627bcd6: The meetings recorder bar is quieter. The meeting language and the live transcript now sit in one small menu beside Start recording, since both are usually set once in Meetings settings; the menu also says what the live transcript costs, so the line under the bar no longer does. A meeting's page no longer repeats "Transcribing" beside its title when the notice under it already says so, a failed transcript offers Transcribe again once, and after Stop the live preview says the transcript replaces it in a minute or two. A host whose meeting language is Bokmål (`nb`) or Nynorsk (`nn`) sees it once in the language list, in Norwegian's place.
- 26c3bc6: Meetings no longer say "Uploading" while a meeting is recorded or after Stop. Audio uploads while it records, so a meeting's page opened from Take notes now shows the recording's clock with Pause and Stop, and after Stop it reads Transcribing on the page and in the list. A paused recording reads Paused in the list, and the recorder's own line after Stop reads "Saving the rest of the audio." on web and phones. A meeting still being recorded elsewhere reads In progress; only a lost connection or a refused upload is called out. Adds `meetingHereStatus` to `@opengeni/react/recordings`; the list label for a recording in progress uses the new `meetings.recordings.inProgress` key instead of `meetings.recordings.uploading`, the recorder's `meetings.recorderPanel.uploadingCountPiecesOfAudio` and `finishingTheUpload` keys become `meetings.recorderPanel.savingTheRestOfTheAudio`, and the meeting page's unused `meetings.detailPage.uploading*` and `stillUploading` keys are removed. Hosts that translate the catalog should rename their `meetings.recordings.uploading` translation to `meetings.recordings.inProgress`, add `savingTheRestOfTheAudio` and drop the removed keys.
- 464f57b: A meeting whose transcript failed before its audio was prepared (for example because no transcription provider was connected yet) no longer says its audio isn't available, and "Transcribe again" works on it. The meeting page now treats audio as gone only once retention deleted it or when none was ever uploaded, and no longer shows that notice while a first transcript is being made.
- 57cfc37: Embedded meetings are transcribed in the workspace's meeting language. `GET …/recording-models` now returns the workspace's `language` (null detects), and the meetings list's recorder starts on it when the host passes no `defaultLanguage`. Until it is known, starting a meeting names no language, so the server uses the workspace's. Before, an embedding that passed no language asked every meeting to detect it, which overrode the workspace setting and could return Norwegian as Danish or Swedish.
- f20b8fb: Every workspace member can now connect their own computer. A signed-in member who can see the workspace's machines connects an "Only me" machine from the Machines page, a chat's machine card or the pairing-code page, and changes, updates or removes their own "Only me" machines. Sharing a machine with the whole workspace still needs a workspace admin, and the whole organization an organization admin; for a member, "This workspace" shows disabled with the reason. Keys, agents, services and credentials acting for someone keep needing `enrollments:manage`, and a refusal is now a plain sentence instead of "missing permission: enrollments:manage". In `@opengeni/react`, `useWorkspaceMachines` adds `canConnect` and `canManageMachine(machine)`, `ConnectMachineDialog` takes `canShareWithWorkspace`, `EnrollmentConsent` takes `allowWorkspaceScope`, and `MachinesDashboard` takes `canUpdateMachine`. The action catalog lists `enrollments:read` as the first permission these routes check.
- d3d8ccf: A computer_open or browser_open that moved the chat to another machine and then failed now says the chat moved, so the agent does not assume it is still on its old machine. Moving a chat in the UI to a machine that has not reported its workspace folder, or whose workspace does not contain the chat's working folder, shows what to do instead of "Try again."
- 8be9be2: Codemode works on a personal ("Only me") Connected Machine used from a chat in another workspace. The machine's runner now keeps the workspace the control plane addressed and replaces only the server address, instead of pointing Codemode at the workspace that enrolled the machine, where the chat's token was refused with 403 "workspace access denied". Takes effect with the next runner release. Machine pickers also say who can use a machine ("Only me", "Workspace") when two listed machines share a name.
- 7bb67e3: Changing a polled read's interval no longer aborts and repeats the read in flight. The session list switches from polling to live list hints shortly after it opens; that switch used to cancel its first `GET /sessions` and send a second one. Now the first read finishes and only the poll schedule changes.
- 936d9e0: Explain Free-credit restrictions in the signed-in workspace and billing page, with a Request review link to the configured support address. Keep sign-in separate from promotional eligibility and refresh review status while the page is visible.
- 69a05bd: Up and Steer now work on a message as soon as it shows as queued. A sent message appears in the queue row at once, but the server needs a moment to place it in the queue, and until the next queue read Up did nothing and Steer was greyed out. Both are now taken immediately and carried out once the message lands: Up pulls it back into the composer, and Steer sends it to the agent now. Neither ever acts on an older message instead, and steering several just-sent messages steers each of them. If the send fails nothing is steered or recalled, and if the agent starts the message first the composer stays as it was and shows "Already sent". Typing or sending another message while Up waits cancels that press and keeps what you typed.
- d8ae831: Keep every chat header on one row of the same height. The automations chip and the parent chat link now sit on the title's row instead of adding a row above it, so the header no longer grows when a chat has an automation or a parent. The automations chip lists each event and the next run on hover, collapses to its icon in narrow headers, and gives up its space before the title does.
- 4651b0d: A Site's sidebar row now moves only when the Site gets a new published version (creation is the first). Messages and turns in its conversations, including a side chat used to edit it, and activity in the chat that created or published it no longer lift it; a publish from any of them still does. Opening a Site, archiving, restoring and the version chip's Undo (a rollback, which adds no version) don't move it either. Opened Sites and Sites with conversations keep their rows in their own project, and session rows are unchanged. `SiteConversationGroup.updatedAt` is now the Site's newest publish. When there are more than 200 Site rows, the limit keeps pinned rows first and then Sites with recent publishes or conversation activity, so a Site whose conversation needs you stays in the sidebar.
- a48504a: The voice control says plainly whether voice can start. While the voice models load it reads "Checking voice" instead of a setup step from a placeholder model, a failed load reads "Voice couldn't load", and where the page may not use the microphone (an embedded frame without microphone permission) or the person blocked it, it says so and offers no Start button that would fail. `useRealtimeModelSelection()` returns `loadState`, which the voice controls take as `loadState`.

  A new feature switch, `addCredits`, controls the new-chat page's "Add credits" button for billing managers. It is on in the `app` and `embed` presets, as before, and off in `companion`, so the Excel add-in no longer shows it; the credits notice still appears when a model's credits run out.

- 70623d6: Phone apps can walk people through starting a voice call with a spoken phrase of their own, such as "Hey Opengeni". iPhone (iOS 18 and later) runs a Siri request when the person says a phrase they taught it under Settings › Accessibility › Vocal Shortcuts; apps cannot create those phrases themselves. The new `WakePhraseGuide` shows the three steps, copies the Siri request that starts the app's call shortcut ("Talk to <name>" by default, so it must match one of the call plugin's phrases), and opens Settings. `wakePhraseSetupAvailable()` says whether the phone supports it. The Opengeni phone app offers it in Settings as Set up "Hey Opengeni". The guide's text uses new `native.realtime.wakePhrase.*` message keys.
- Updated dependencies [931325b]
- Updated dependencies [d649005]
- Updated dependencies [5aa883b]
- Updated dependencies [4488c59]
- Updated dependencies [5a48fe7]
- Updated dependencies [3ee89da]
- Updated dependencies [f6298be]
- Updated dependencies [58d272f]
- Updated dependencies [01188c9]
- Updated dependencies [415c32b]
- Updated dependencies [995c16f]
- Updated dependencies [53e1fe5]
- Updated dependencies [d30a243]
- Updated dependencies [659f5a4]
- Updated dependencies [5b9feb9]
- Updated dependencies [de7087a]
- Updated dependencies [a2ae2ce]
- Updated dependencies [cb15454]
- Updated dependencies [a8b429e]
- Updated dependencies [57cfc37]
- Updated dependencies [f20b8fb]
- Updated dependencies [96502c5]
- Updated dependencies [5f332c1]
- Updated dependencies [24b71c6]
- Updated dependencies [1320698]
- Updated dependencies [54c2f9e]
- Updated dependencies [936d9e0]
- Updated dependencies [4651b0d]
- Updated dependencies [30b9cd2]
  - @opengeni/contracts@5.4.0
  - @opengeni/sdk@5.4.0
  - @opengeni/connect@5.4.0

## 5.3.1

### Minor Changes

- 1988e97: A person can now have the agent do in the chat what they would otherwise do in settings: switch this chat's model, invite someone or share the chat, check their plan, credits and usage, or change a workspace preference. In a chat a person started, `admin_actions_search`, `admin_action_describe` and `admin_action_call` are listed by default and run as the person who sent the message, never with more than that message itself could do: what it may do is frozen with its turn when it is accepted, capped to the chat's workspace. Reads run at once; every change first shows that person a plain confirmation card in the chat ("Invite anna@example.com to your organization as an admin?", one line of the key values, Allow and Cancel, the raw call behind Details), and the API refuses a change that person did not confirm. Only someone signed in to the app itself can confirm changes; with any delegated sign-in (an embed's host-issued token, an external user, another integration's person token) the route only reads unless the deployment sets `OPENGENI_DELEGATED_SIGN_IN_APP_ACTION_CHANGES=true`, which applies to all of them. An Allow given through an API key, a Slack button or a delegated sign-in that isn't turned on never confirms: approvals now record who decided (`decision_by_kind`) and whether they were signed in to the app (`decision_by_signed_in_person`), both fixed with the decision. Calls that create, show, copy or rotate keys, passwords, tokens or other secrets, or carry one in their body, are left to the app unless the session has full access. Contract schemas mark secret fields with the new `secretValue(...)` helper (registry `secretValues`); the catalog generator records them, plus secret-sounding field names, as `secretFields` on catalog entries. Codex and SuperGrok device sign-in starts now have a response schema (`SubscriptionDeviceSignInStart`). A session with full access behaves as before. Scheduled, goal and other unattended turns, API-key and service turns, child sessions and service sessions gain nothing.

  This is on by default for every organization, including existing ones: migration `0971` adds `chatActionsAllowed` (default true) to the agent admin-access setting. Owners and admins turn it off under Security & data > Agents, or with `PATCH /v1/organizations/:organizationId/agent-admin-access` (which now accepts either field). Embedding hosts that draw approvals with `ApprovalSurface` get the same card, with `approvalSurface.allow` and `approvalSurface.cancel` messages to translate; a host can leave the route off by not selecting these tools. The app-action catalog moved to `@opengeni/contracts/app-actions`. `SESSION_ADMIN_ACCESS_TOOL_NAMES` and `SESSION_ADMIN_ACCESS_TOOL_NAME_SET` are deprecated aliases of `SESSION_APP_ACTION_TOOL_NAMES` and `SESSION_APP_ACTION_TOOL_NAME_SET`. `toolReviewFields` takes an optional tool name.

- c5974ea: Agents can set up event triggers: `FirstPartyMcpToolName` adds `event_sources_list` and `events_get`, and `BundledSkillId` adds `builtin:event-triggers`. The timeline shows both tools as "Checked events".
- e3782bb: Automation templates and a "This workspace" event source.

  - **Templates.** A template is where a new automation starts: its message, a schedule without a time zone, and event triggers that name a kind of source. Using one opens the ordinary form filled in; nothing is created until the person saves. `@opengeni/react/automations` ships built-in templates (`builtinAutomationTemplates(t)`, including "Meeting notes"), and `AutomationsPanel` takes `templates` (the host's own), `workspaceTemplates` (offer and save the workspace's saved templates, on by default) and `workspaceEvents` (offer this workspace's own events as a source, off by default). The new-automation view offers "Start from scratch", the host's templates and the saved ones; an automation's menu has "Save as template". `useEventSourceStandIns`, `AutomationTemplateList`, `AutomationTemplateTile` and `AutomationTemplateDialog` are exported for hosts that build their own.
  - **Saved templates.** Workspaces keep the templates their people save: `GET`/`POST /v1/workspaces/:workspaceId/automation-templates` and `PATCH`/`DELETE …/:templateId`, with `listAutomationTemplates`, `createAutomationTemplate`, `updateAutomationTemplate` and `deleteAutomationTemplate` in the SDK. Reading needs `scheduled_tasks:run`, saving needs `scheduled_tasks:manage`; whoever saved a template and workspace admins can rename or delete it (`viewerAccess`). A workspace keeps up to 200; saving more returns 409.
  - **"This workspace" source.** `createEventSource({ kind: "workspace" })` creates the caller's own source for the workspace's recording events (`recording.started`, `recording.finished`, `recording.transcript.ready` and the rest). It reads under the owner's row security, so a trigger only sees the meetings its owner may open.

- 5a256f4: The automation parts in `@opengeni/react/automations` now speak the host's language. Every label, hint and validation message comes from the message catalog under `automations.*`, so `OpenGeniMessagesProvider` translates the trigger editor, event source tiles, delivery log and the "waiting for an event" status like the rest of the UI. The pure helpers take the `t` from `useOpenGeniText()` first. New: `eventSourceChoices(t)`, `eventSourceChoiceName`, `eventDeliveryStatusBadge`, `eventCommonFields(t)`, `eventConditionOperatorLabel`, `eventRowColumns(t)` and `sessionAutomationWaitLabel`. The English-only constants they replace (`EVENT_SOURCE_CHOICES`, `EVENT_DELIVERY_STATUS`, `EVENT_COMMON_FIELDS`, `INBOUND_EVENT_COLUMNS`, `EVENT_DELIVERY_COLUMNS`, `SESSION_AUTOMATION_WAIT_LABEL`) are deprecated.
- 8e20038: `AutomationsPanel` in `@opengeni/react/automations` is a drop-in list, page and form for automations, for hosts that embed chats. Give it the host's `OpenGeniClient` and a workspace, and optionally a chat: in a chat, new automations continue it with its settings; otherwise each run starts a new chat with the workspace's defaults and the owner's access. It turns automations on and off, runs them now, edits and deletes them, and shows recent runs. `eventServers` offers the host's own MCP servers before the person has an event source for them, and `argumentDefaults` fills subscription arguments such as the open project.

  Also new: `AutomationForm`, `AutomationWhenField` (a schedule and event triggers, each optional), `EventArgumentsField` (MCP subscription arguments as fields from the event's JSON Schema, with JSON as the fallback), and the pure automation helpers behind them (`automationCreateRequest`, `automationUpdateRequest`, `automationWhenWords`, `automationWhenSentence`, `automationNextRun`, `sortAutomations`, `deriveAutomationName` and others). The trigger editor edits MCP arguments with those fields, and `EventTriggersField` takes `argumentDefaults` and `actions`. The field's "Optional" marker is translated.

- eb30cb4: Schedules become Automations. An automation runs on a schedule, when matching events arrive, or both. In the web app, the Automations page (formerly Schedules, with the old links redirecting) adds event triggers with only-when conditions, run-once automations, the event runs per hour limit, and Event sources pages to connect GitHub, Slack, Gmail, Linear, Sentry, MCP servers and signed webhooks, with each source's delivery log, replay and test event. Chats that wait for an event show it in the rail and the chat header.

  `@opengeni/react/automations` exports the reusable parts: the event trigger editor and summary, the event source tile, delivery and event rows, and the pure models behind them, for hosts that build their own automation pages.

  Linear and Sentry event sources can be created before their signing secret is pasted: the source shows `awaitingSigningSecret` and refuses deliveries until the secret is set with `updateEventSource`. REST reads of a source include `viewerAccess` (`manage` or `use`), so a UI can show only the actions the caller may take. Sessions carry `waitingForEvents` when an active automation would continue them on an event.

- d806f0f: The cadence picker (`@opengeni/react/ui/cadence-picker`) speaks the host's language. Its labels, weekday and month names, dates, previews and validation messages come from the message catalog under `cadence.*`, so `OpenGeniMessagesProvider` translates it like the rest of the UI. `describeCadence`, `validateCadence`, `formatRunTime` and `describeNextRuns` take the host's text as an optional `text` option, and `timeZoneLabels` as an optional second argument; without it they stay English. Typed cadences (`parseCadence` and the "text" variant) still read English.
- 8da1f14: The ⌘K / Ctrl+K command menu finds Sites in the current workspace. Typing still lists chats first, then matching Sites in a Sites group after them, by title, using the workspace's access-checked Site catalog, so people only see Sites they can open. With nothing typed it shows up to three recently active Sites. Choosing one opens it in the app's Site view, including in the desktop app; ⌘/Ctrl+Enter on the web opens it in a new tab. If Site search fails, the rest of the menu keeps working.
- 8b34e6d: The status area above the composer takes less height, leaving more of the conversation visible on laptops and phones. The wait status is now one chip in the `SessionChrome` row (reason and next check time, details on tap) instead of a two-line banner; pass it with the new optional `wait` prop. Goal pause and clear moved into the goal panel, and a plain file attachment shows on one line.

  `SessionChromeSignalId` gains `"wait"`, so exhaustive switches over it need a new case. The existing goal message keys (`sessionChrome.pauseGoal`, `resumeGoal`, `clearGoal`) are kept and now name the goal panel's buttons.

- dcbe25d: In the desktop app, the computer you're on is now **Computer use**: one on/off switch in Settings > Machines (and at the top of **Connect a machine**) instead of Turn on, Pause, Turn off and the old "Connecting …" card. It shows one state at a time: off (the same whether never set up, turned off, or removed from Machines), turning on, on, a calm "allow Opengeni in System Settings" line with **Open System Settings** while a macOS permission is still missing (not an error: files and commands work meanwhile), or a real problem in red with exactly one fix (**Sign in**, or **Try again** with the server's own message). Before, a computer removed from Machines kept saying "Connecting …" forever with "Couldn't reach the server" although the server had answered; now removal is detected and shows as off, and turning it on registers the computer again. Only a server that really can't be reached says so (new `ThisComputerErrorCode` values `removed` and `signed_out`; failed reads are classified by kind, and `ThisComputerDeps.readMachine` resolves null only when the server answered without the enrollment).

  Off is pause, so it survives restarts and keeps the registration. Turning on is the whole step: it resumes, re-registers or starts the agent as needed, then asks macOS for each missing permission in turn (the system prompt, or the exact System Settings list with the floating guide) and finishes by itself once they are granted; if the person comes back without allowing one, it stops asking until they choose **Open System Settings**. An agent already registered to the workspace from the web app's install command is adopted and shows as on with nothing to do; on macOS the app then runs that same agent as its own helper (same registration, its service turned off) when the app already holds the service's screen permissions or when a missing one is asked for, so one set of permissions, Opengeni's, covers app-shots and computer use. The service runs it again if the helper doesn't stay up, when the app quits, or at the next launch if the helper's program is gone, so the computer never has two agents or none. The sidebar shows a small notice only while computer use turns on, needs a permission, or has a problem. Inside the app, **Connect a machine** no longer offers downloads or **Open app and connect** for this computer; in a browser it is unchanged. `useThisComputer` gains `turnOn`, `turnOff`, `pending`, `asking` and `allowPermissions`; `ThisComputerStatus` gains `requestedPermissions`; `ThisComputerDeps` gains `hostServiceAgent` and `ThisComputer.summary()` gains `handsBackOnQuit`; `@opengeni/react/this-computer` exports `computerUseState`, `computerUsePermissionText` and `useComputerUse`, and the desktop app exports `DesktopComputerUseRow` and `useDesktopComputerUse`.

- 31bca3c: Composer dictation is now a recording with `purpose: "dictation"`, recorded, uploaded and kept by the same local-first pipeline as meetings, so a closed tab, a killed phone app, a dropped connection or a failed transcription never loses what was said. A dictation has one microphone track, is always private, is transcribed and billed as voice input, sends no webhook events, never appears with meetings, and is deleted a day after it is heard. `GET …/recordings?purpose=dictation` (and `listRecordings({ purpose })`) lists the caller's own kept dictations, so the next composer offers text an earlier page left behind.

  `useVoiceInput` records through the recordings API when the client can and the deployment advertises `voiceInput.resumable`, inserts the text once (taking it deletes the dictation first, so two tabs never insert it twice), keeps anything longer than three seconds on Cancel or Escape, and hears a failed dictation again on Retry. It is also exported from `@opengeni/react/recordings`, and `useNativeDictation` in `@opengeni/react-native/recordings` brings the same dictation to phones on the native recorder. A client with only `transcribeAudio` records in memory and sends one request, as before. `ComposerTranscriptionControl` accepts `recordings` and `platform`; `createRecordingStore` and `createOwnerId` are deprecated and ignored.

  The `transcription-recordings` routes and their SDK methods are deprecated, answer with `Deprecation` and `Sunset` headers, and are kept until January 26, 2027. See https://docs.opengeni.ai/integrate/meetings#moving-from-transcription-recordings.

- 1d5bc4e: Event deliveries name what they became: `EventDelivery` adds `eventTypes`, the types of its events each once, and `@opengeni/react/automations` adds `deliveryTitle`, so a delivery log row reads "pull_request.opened" instead of "1 event". Automation pages, notices and menus say "automation" where they meant the whole automation.
- 6acfbd3: Event sources and triggers now say why they are blocked or off as a code clients can word in their own language. `EventSource` and `EventTrigger` gain `statusReasonCode` and `statusReasonDetail`, and `EventTypeDescriptor` gains `unavailableReasonCode` and `unavailableReasonDetail`, next to the existing English sentence (codes are listed in `EVENT_STATUS_REASON_CODES`). `@opengeni/react/automations` adds `eventStatusReasonText`, which words a known code from the host's message catalog (`automations.statusReason.*`) and shows the server's sentence for a code it doesn't know; source and trigger badges, the event source picker and the event type picker use it.
- 6168cfe: A turn that takes more than a second to load its conversation history before the first model request now shows it as a "Loading conversation history" startup step, with its duration in startup timings, instead of a silent wait. `StartupPhase` gains `"history"`.
- bd57ea7: Agents can now find the deployment's reviewed Microsoft integrations (Outlook Mail, Calendar and Contacts, OneDrive and Teams) by the names people use, including Hotmail, Live and MSN, and post a Connect card for them in chat. `SessionIntegrationCapabilityCard` connects the viewer's own personal account in one click (never a workspace account, and reconnecting an expired one, the most recently used one when there are several), installs the reviewed tools for that account, selects them for the chat, lets the agent continue the request, and shows Microsoft's administrator approval link when an organization requires it. It renders in the console and in `SessionConversation` / `OpenGeniChat`, including session-proxy embeds, for people who may connect their own accounts (`sessions:control` plus `connections:personal`, which per-user embed identities get by default). `attachSessionCapability` also accepts an installed integration's runtime server. `ApiIntegrationInstallationSummary` gains `connectionLastUsedAt`, and its `connected` is now true only while the bound connection is active.
- c307566: Sites are edited live in the console's Site view. Every way into a Site opens it there, with its chat beside it; Edit with Opengeni starts a new conversation in that panel. The conversation knows its Site, a publish or restore reloads the preview in place, versions published elsewhere show within seconds, and a version chip offers the history and one-click Undo.

  New public API: `SessionConversation` `onEvent` (each event that arrives after its history loaded); `SiteView` `versionId`, `watch` and `versionControl`; `ArtifactSandbox` `liveState` (Updating or Reconnecting, shown beside the Live indicator or its `liveStatus` replacement) with the `SiteLiveState` type and the `liveUpdating` and `liveReconnecting` labels; `ArtifactSandbox` `frameKey`; `siteConversationContext` in `@opengeni/contracts/site-session-http`; `GET /v1/workspaces/:workspaceId/published-artifacts/:artifactId/current` with `getWorkspaceArtifactCurrent` and `WorkspaceArtifactCurrentResponse` in the SDK, which the Site view uses to check for new versions without reading their history.

- 90e52dc: `RelativeTime` and the time formatting functions now take their words from the message catalog (`time.*` keys), so a host that supplies `messages` and a `locale` gets translated relative times ("Just now", "48 min ago", "Yesterday"), absolute times, dates, weekday and month names and time zone labels. The component reads the nearest messages provider. `formatRelativeTime`, `formatAbsoluteTime`, `formatDate`, `formatShortTime` and `formatExactTime` accept `text` in their options, and `timeZoneLabel` and `inSentence` accept it as a second argument; all stay English when it is omitted. English output is unchanged.
- 2806e31: Meetings show their notes: a notepad that saves as you type during and after the meeting, and the written-up notes above the transcript, with who wrote them and a link to the chat when an agent did. Adds `useRecordingNotes` and `MeetingNotes`.
- 87d1b8a: Embed meeting recording. `@opengeni/sdk/recordings` adds `OpenGeniRecordingsClient` for the recordings API, a local-first `RecordingUploader` that stores chunks on the device before uploading them straight to storage and finishes recordings left behind by an earlier page, IndexedDB and in-memory chunk stores, and `createBrowserRecorder` for microphone plus shared tab or system audio as separate tracks. `@opengeni/react/recordings` adds `useRecorder`, `useRecordings`, `useRecording`, `useTranscript`, `useRecordingPeople` and `useRecordingModels`. Recording response shapes are now published contract schemas.
- 1cac78f: Record meetings on phones. `@opengeni/react-native` adds native microphone capture for iOS and Android that keeps recording in the background and writes AAC chunks to the device before they are uploaded, an on-device chunk store, and an Expo config plugin for the microphone permission and background audio. `useRecorder` from `@opengeni/react/recordings` takes a `platform`, so the same hook drives the browser and the phone recorder; the meeting list and transcript view models are shared from `@opengeni/react/recordings`.

  The SDK's `RecordingUploader` no longer leaves a recording that captured no audio stuck uploading: it removes it, on the server and on the device, and reports `discarded`. Stopping a recording while a chunk is still being uploaded can no longer be lost. The worker accepts AAC tracks and remuxes them before transcription.

  Speakers nobody named now read the same on the server and in every client: `defaultRecordingSpeakerName` from `@opengeni/contracts` gives "Speaker 2" for a diarized `speaker_1` and "Microphone" or "Shared audio" for a whole-track label, and the API's speaker `name` uses it. A speaker counts as named only when it has an assignment (`source` is set). Transcript versions report BCP 47 language tags, so ElevenLabs' `eng` is now `en`.

  An upload refused with 401, 408, 425 or 429 is retried with backoff instead of failing, since a sign-in that loads late or is refreshed, a timeout or rate limiting doesn't make the recording bad. `useRecorder` sends its uploads through the latest client it was given, so a recorder created before the app's sign-in token loaded no longer uploads without it, and only the current recording updates what the hook shows.

  `RecordingUploadStatus.created` says when the server has a new recording, so a list can refresh then and show it while it is still being recorded. `languageName` names ISO 639-2 codes such as `eng` on engines that don't canonicalize them, like Hermes.

- 78ff3e6: The web app has a Meetings page. Record a meeting from the browser (microphone, optionally with a tab's audio), keep working elsewhere in the workspace while it records and uploads, then read the transcript, play the audio, name who spoke, correct a turn, and transcribe again with another model.

  `@opengeni/react/recordings` exports `useRecordingsClient`, which returns the recordings client the hooks use, for calls no hook wraps.

- 9efd19f: The phone app shows and manages a session's full access like the web header does. `SessionHeaderTitle` takes `fullAccess` and then shows a small shield and "Full access" on its status line. The new `@opengeni/react/session-admin-access-model` entry point shares the offered time limits (`ADMIN_ACCESS_DURATIONS`, `adminAccessDurationHours`), `endsText`, `adminAccessGrantedByText` and the grant description between web and native.
- 4695d41: Meetings and dictation share one set of speech-to-text providers. Each model says what it can do and who pays for it (`funding`: a workspace key, a workspace subscription or the deployment). Dictation can use any of them, including Azure Speech and ElevenLabs Scribe. Meetings need a model with word timings; models that return only text (the subscriptions, OpenAI and Azure OpenAI) serve dictation only. `OPENGENI_SPEECH_TO_TEXT_PINNED` makes one model the only one for every use, so a deployment can guarantee where audio goes. Deployment-funded meeting transcripts are charged in credits at the model's price. `GET …/recording-models` adds each model's funding, `dictationDefault` and `pinned`. The voice input provider `azure-mai` is now `azure-speech`; the old name is still accepted.
- 021130f: Phones show the live transcript too. With `liveTranscript: true`, the native recorder streams the microphone to the workspace's live speech model and fills `snapshot.live`, as the browser recorder does. The native capture module sends a 16 kHz copy of the audio (`onPcm`) only while it is asked for (`setLivePcm`); paused audio is not sent, and an app build without the new module records as before with no live text. The live text helpers `groupLiveTurns`, `tidyLiveText` and `tidyPartialText` are now in `@opengeni/react/recordings`, so a phone and a web page join live text the same way.
- ca88f26: New `@opengeni/react/meetings` entry: the ready-made Meetings UI the console uses, so products can embed it. It has `MeetingRecorderProvider` (one recorder above the routes, which also carries out the desktop app's call notifications through `onOpenMeetings` and `onOpenMeeting`), `MeetingsListPage`, `MeetingDetailPage`, `MeetingDefaultsView`, and the pieces they are built from (`RecorderPanel`, `MeetingTranscript`, `MeetingPlayer`, `LiveTranscript`). Pages navigate through callbacks, so any router works. A product can scope the list and new recordings to its own `externalRef` (such as a project), show a `notice` before every start, not offer the live preview, hide the page header, and add its own `details` beside a meeting's transcript. `useRecorder().start` now also takes `externalRef` and `metadata`. `@opengeni/react/testing/meetings` adds an in-memory recordings client for previews and tests.
- f9f0607: Event sources that need no setting up are ready to use. An MCP server the person is signed in to that offers events, a Gmail account they connected and "This workspace" are listed by `GET /v1/workspaces/:workspaceId/event-sources/ready` (`client.listReadyEventSources`) with a key such as `mcp-server:<serverId>`, `gmail:<connectionId>` or `workspace`. A trigger's `sourceId` can be that key: saving adds the person's own source behind it, or reuses the one they have. Agents see them under `readyToAdd` in `event_sources_list` and can set up an automation on one without anyone adding a source first. `AutomationsPanel` and the web app's form offer them in the source picker; `useEventSourceStandIns` takes `readySources`, and stand-in ids are now the ready keys.
- 7d419e2: Add the live transcript preview for recordings. `createRecordingLiveSession`, `appendRecordingLiveSegments` and `listRecordingLiveSegments` on the recordings client; `createLiveTranscriber`, plus `liveTranscript` on `createBrowserRecorder` and `useRecorder`, which stream each track to a live speech model while recording and expose the text in `snapshot.live`; `useLiveTranscript` to follow a recording from another device; and `liveModels` from `useRecordingModels`. Tracks carry a `live` summary, and workspaces can turn it on by default with `settings.recordings.liveTranscript`.
- a9809ee: A blocked "ask before each use" secret use now reaches the person through Opengeni itself instead of depending on the agent to relay a card. The resolver posts Opengeni's own approval card as a human-input request with the new `origin: "secret_use_approval"`, so it appears in the chat, the inbox, a phone notification (without an inline answer) and the Slack thread; an identical blocked use while the request is pending reuses it and never notifies again. The card outlives the turn that hit it. When the signed-in person answers, the grant or denial is recorded and the agent receives the new immediate `secret_use_approval_decided` update telling it to retry the call, or not to, which wakes an idle chat. `SessionHumanInputRequest` gains optional `origin`, `SessionSystemUpdateKind` gains `secret_use_approval_decided`, and `SecretReferenceError` carries `approval: { approvalId, asked }` instead of `approvalCard`; the `approval_required` tool output no longer includes a card and its hint says the person was asked. `request_human_input` refuses `secret-approval:` questions, and agent-relayed approval questions no longer carry authority. Migration 0961 (rolling) adds the request `origin` column and the new update kind, and keeps pending approval cards open in the inbox when a turn ends.
- f3d19a2: Vault items, or single fields of them, can be marked "ask me each time". Agents still see and reference a marked item, but a use that no approval covers stops before any value is read and fails with the new `approval_required` code, and Opengeni asks the person with its own card describing the blocked use (item and field, surface, tool and destination). Only the person the run acts for can answer it, and the answer becomes a grant: allow once, allow in this chat, allow for an hour across the person's chats in the workspace, or deny. The check runs in the shared resolver, so hosted and connected vaults and every surface behave the same. New routes `GET`/`PUT /v1/workspaces/:workspaceId/vaults/:vaultId/items/:itemId/approval` and `POST …/approval/grants/:grantId/revoke` (people only for changes), SDK methods `getItemApproval`, `setItemApproval` and `revokeItemGrant`, an "Ask before each use" section on the item page, and migration 0952 (rolling) adding the `secret_approval_rules` and `secret_use_approvals` tables. `SecretUseContext` gains optional `destination` and `lookupDestination`, and secret-use audit rows list the approvals a use relied on.
- 198d6f5: Clicking an image or file in a session's Artifacts panel opens a full-window viewer that steps through the listed artifacts in their current order, respecting search and filters, with Previous and Next buttons, Left and Right arrow keys, swipe on touch, an "N of M" position and Escape to close. Neighbouring images are preloaded, and other artifacts show their existing preview inside the viewer.

  Images in that viewer and in the chat screenshot lightbox can be zoomed and panned: they open fitted (small ones enlarged up to 2x), zoom with Cmd/Ctrl + plus and minus, Cmd/Ctrl + wheel, pinch or the new zoom buttons with a percentage, fit again with Cmd/Ctrl + 0 or Fit, toggle fitted and actual size on click, and pan by dragging or scrolling. While an image is shown, the zoom keys zoom the image rather than the page or desktop window. `LightboxControlLabels` accepts `zoomIn`, `zoomOut` and `fit` labels.

- e509f04: Show Pin and Archive on every sidebar row, including spawned chats and Site rows, on hover or keyboard focus with tooltips, and in the right-click and touch menus. Site rows can be pinned and archived as personal sidebar state (`updateSiteSidebarState`); archiving a Site only hides it from your own sidebar and never unpublishes it. Archive on a spawned chat archives its workstream.

  Session lists for a signed-in person that include or group Site conversations (`siteConversations: "include"` or `"group"`) now leave out conversations of Sites that person archived; a Site's own conversation list is unchanged.

- 4e44f04: The Site view header links to the published Site. "Live ↗" opens the Site's primary public address (in the desktop app, in the default browser) and a copy button copies it, for anyone who can open the Site; an unpublished Site says "Not published", with Publish for people who can publish. `GET /v1/workspaces/{workspaceId}/published-artifacts/{siteId}/publication/link` (SDK `getSitePublicationLink`, contract `SitePublicationLink`) returns a Site's published URL, hostname and status to anyone who can read the Site; the publication's settings stay behind `getSitePublication`. `ArtifactSandbox` and `SiteView` accept a `liveStatus` slot that replaces or hides the header's "Live" indicator.
- 1b99a18: Pressing Up in an empty chat composer pulls your most recent waiting (queued, not yet started) message back into the composer for editing, with its text and attachments and the caret at the end. It is withdrawn from the queue on the server through the same atomic checkout as the queue's Edit action, so it is never sent twice or lost. If the agent took it first, the composer stays as it was and shows a quiet "Already sent". Up keeps its normal caret movement whenever the composer has text, quotes or attachments, during IME composition, with a modifier key, or while the command palette is open. Right after a send, recall waits until that message reaches the queue, so it never pulls back an older one instead. The queue row Up would recall shows ↑ in its Edit tooltip. `ChatComposer` and `useChatComposerController` accept `queuedRecall` (from the new `useQueuedPromptRecall`), and `useTurnQueue` gains an optional `recallTurn`. `SessionConversation` turns recall on when you pass the signed-in person's `viewerSubjectId`, and then only recalls that person's own messages.
- 1534f12: Send feedback on web and in the desktop app attaches screenshots and context, like the phone app. The form offers **Take screenshot** (the desktop app takes a still of its own page without asking, and attaches one as the form opens; browsers use tab capture), **Add image** and paste, up to three images, each removable. `FeedbackDialog` takes `screenshots` and `reportContext`; `webFeedbackContext` (in `@opengeni/react/app/lib/feedback-capture`) reports web or desktop, versions, the page, browser, language, time zone, connection and the last error toasts, which `recordErrorToasts` (in `@opengeni/react/app/lib/recent-errors`) remembers. The desktop bridge gains the `captureWindow` capability and `appVersion`.

### Patch Changes

- de7e142: A Connected Machine whose agent process serves several workspaces no longer shows a failed agent update in the workspaces that did not start it. While one workspace's update runs, the others record a postponement (`update_busy_updating`, retried on the busy backoff and shown as waiting) instead of a failure, and once the restarted agent proves through its update receipt that it runs exactly the target build, every workspace's pending, postponed or failed update for that build is marked succeeded.
- 0676499: Archiving a chat with Pause now removes the one-time waits that continue it or its sub-chats: a run-once event automation that has not run yet, and a one-time scheduled run still ahead. They go in the same transaction as the pause, so an archived chat is never woken by a "wake me when" it was waiting on, and Restore does not bring them back. Repeating automations stay, and Hide for me changes nothing. The archive confirmation says so.
- b4acabd: The Automations panel now says why a run failed or was skipped in words, such as "Skipped because the chat was still busy with earlier work.", instead of showing the recorded reason code (for example `scheduled_session_not_idle`). Skipped runs now show their reason too. The new `automationRunErrorText(t, error)` in `@opengeni/react/automations` turns a run's `error` into that sentence, and a code it doesn't know reads as "Something went wrong with this run." The words are new `automations.run.error.*` message keys, which hosts that translate the catalog can add.
- adeb323: A chat now labels a run of an automation "Automation run" ("2 automation runs" when several arrive together), and the composer chrome calls its source "Automation". It used to say "Scheduled update" and "Schedule" even when an event or a manual run started it. The message keys changed accordingly: `machineInputDisplay.scheduledUpdate` and `machineInputDisplay.scheduledUpdatesCount_other` are now `machineInputDisplay.automationRun` and `machineInputDisplay.automationRunsCount_other`, and `sessionChrome.schedule` is now `sessionChrome.automation`. Hosts that translate these keys should rename their entries.
- 7ae955f: The Automations panel's recent runs pick up a run started with Run now without leaving the page, and keep a queued run's status current while the automation is open.
- e1838ff: A chat's "waiting on" status names every app its automations wait on, not only the first. `SessionAutomationWaitSummary` gains `events`: one entry per source with all the event types its active triggers wait for, in the order the automations were made. The header chip reads "Waiting on GitHub and Gmail" (two names, then "and 2 more"), and its tooltip, the sidebar mark and the hover card list each source's events. With servers that only send `event`, the words are as before.
- 3046e82: `AutomationsPanel` rows read as one line, "Every day at 07:30 · Oslo · Next run: Tomorrow, 07:30", that truncates once instead of twice. On a phone-width panel a row shows only its next run, or the events it waits for. `automations.panel.next` now reads "Next run: {time}".
- 7e88548: `AutomationsPanel` is a styled root of its own, so `compiled.css` styles it in any host. Its menus, pickers and delete confirmation open in a layer of their own under `<body>` that carries the panel's theme, so a host's dialog neither unstyles nor clips them. Inside an app that already provides an overlay container, they open there. The list's loading note and the delete button's pending label come from the messages catalog (`list.loading`, `automations.panel.deleting`).
- ce72530: Scheduled tasks are called automations everywhere people read about them. The agent capability label is "Automations", the permission group is "Automations", timeline steps read "Set up an automation" and "Checked automations", and the repository picker and the archive blocker for a chat an automation posts into say automation.
- f3d19a2: Bitwarden and Vaultwarden connect directly, like the other password managers. A new package, `@opengeni/vaults-bitwarden`, talks to the server's client API with the account's personal API key and decrypts items itself, so connecting needs only the server address, the API key and the master password, entered once. No bridge program or Bitwarden CLI runs anywhere, and nothing has to be unlocked by hand. Opengeni stores the API key, the server's addresses and the account's user key; the master password is used during setup and never stored. Works with Bitwarden Cloud (US and EU), self-hosted Bitwarden and Vaultwarden.

  The account sees My vault and every organization collection it belongs to, each as its own vault, read-only where the collection is. A hide-passwords collection allows plain fields but refuses passwords, one-time passwords and files. Values are read live on every use and never cached. Writes create logins and notes, patch fields and move items to Bitwarden's trash, and a write that raced another client is a conflict instead of an overwrite.

  Breaking for Bitwarden connections only: the Bitwarden credential is now `{ provider: "bitwarden", serverUrl, clientId, clientSecret, masterPassword }`, Bitwarden is no longer a remote provider on the signed `opengeni.vault.v1` protocol (`VaultProviderWireProvider` is `"external"` only), and a connection saved with the old bridge settings reports that it must be removed and connected again. The bridge package is gone. The shared provider operation helpers Keeper and Proton Pass used now live in `@opengeni/vaults`.

- 45cddc7: Hosts that compile the components through the Tailwind v4 source bridge now render them the same as `compiled.css`. The scoped base (a root's own font and colour, scrollbars, selection colour, input cursors and the shimmer's display) moved into cascade layers, so a call-site utility on the same element wins again: the composer's "Connect a model" pill, for example, showed as a filled pill with no visible text. The README's bridge snippet now also imports `@opengeni/react/app.css`, which the session app needs. In `compiled.css` a root's base font and colour now have one class of specificity, like the rest of the scoped base, so a host's element selectors such as `button { font-family }` no longer restyle an Opengeni root.
- 9f6cab2: The published packages now build the `@opengeni/contracts/event-triggers` and `@opengeni/react/automations` entries, so importing them resolves to emitted files.
- 6f6c356: A chat that an automation will post into now says what it is waiting for. Sessions and session list entries carry `automationWait` (`nextRunAt`, the `event` with its `source` and `eventTypes`, and how many `automations` wait), and the lineage read carries `sessionAutomationWait`, for readers who may see schedules. Only automations the reader can see count, and a source that is private to someone else stays unnamed. `sessionAutomationWaitWords(t, session, { now })` from `@opengeni/react/automations` turns it into a sentence ("Waiting for deploy.finished from Deploys. Next run: Tomorrow, 09:00") and a chip label ("Waiting on Deploys"), and falls back to the plain "Waiting for an event" or "On a schedule" for servers without the details. The sidebar mark, hover card, command menu and chat header use it.
- d6c7c4a: The agent now continues on its own after a person finishes setting up a capability from the agent's connect or add-credentials card, instead of waiting for them to say they are done. After setup is verified, the shared chat cards (and the OAuth return handlers) call the new `POST /v1/workspaces/:workspaceId/sessions/:sessionId/capability-continuations` endpoint (`client.continueAfterCapabilitySetup`). The API records one immediate `capability_setup_completed` internal update per card, and only when the capability is now usable in that chat, nobody has written since the card, and the caller is the person whose request it was. The agent sees one short internal update saying the setup is finished and its tools are available. Failed or cancelled setup sends nothing.

  `SessionConversation` and `OpenGeniChat` now render the shared connect card for the agent's OAuth capability requests with no host code, when the person's grant allows every setup step; otherwise the card says the integration can't be connected from here instead of showing a dead end. The session proxy reports a new `chatConnections` client-config field (`false` when its `createSession` hook owns chat tools), and `timelineProps.renderAuthNeeded` still takes precedence.

- 627b2f1: Google Calendar can now be connected from the chat or the Capabilities page, like Gmail: each person connects their own calendar with the deployment's existing Google sign-in app, and the agent can list events in a time range, read one event, check free/busy times, and create, move or delete events. Changes ask first by default, guests are emailed only when asked, and every answer uses the calendar's own time zone. Operators enable it with `OPENGENI_GOOGLE_CALENDAR_ENABLED=true` after enabling the Google Calendar API and adding the `calendar.calendarlist.readonly`, `calendar.events` and `calendar.freebusy` scopes to their Google consent screen.
- c992791: Record other apps' audio in desktop meeting recordings. The desktop app ships a small native helper that captures what the computer plays, apart from the app's own sounds: a Core Audio process tap on macOS 14.2 and later, WASAPI process loopback on Windows 10 2004 and later, and the PulseAudio or PipeWire default monitor on Linux. `@opengeni/desktop` runs it per page and streams its samples over the new `systemAudio` bridge capability, and stops it when the page navigates away, closes or the app quits.

  `@opengeni/sdk` adds `desktopSystemAudioSource`, which turns those samples into a `MediaStreamTrack` the recorder records as its own track, `displaySystemAudioSource` for the browser's shared tab or screen audio, and `defaultSystemAudioSource`, which picks the desktop helper when the app offers it. `RecorderOptions.systemAudioSource` overrides the choice, `RecorderPlatform.systemAudioKind` says which one a recorder uses, and capture failures are reported as the exported `RecorderCaptureError`. `useRecorder` from `@opengeni/react/recordings` exposes `systemAudioKind`.

- 826b002: Agents can find and read recorded meetings with two new first-party tools. `meetings_search` finds the meetings the person can see by words said or in the title, a named speaker, a start-time range or a product's reference, newest first, with each meeting's speakers and the transcript lines that matched. `meeting_read` reads one meeting's details and its transcript as speaker-named, timestamped lines with names and corrections applied, in parts or for a stretch such as 12:00 to 15:00, and reads the live preview while a meeting is still being recorded. Both are searchable (deferred) tools in the knowledge group and need `sessions:read`. The recordings list in the API and SDK also gains `person`, `startedFrom` and `startedTo` filters.
- 4998a79: Meetings can have a language. A workspace sets the language new meetings are in (`recordings.language`), the recorder picks one per meeting, and both the live transcript and the final transcript use it. The live transcript hears only a few seconds at a time, so detecting the language can drift there, which a named language prevents. In a request, `transcription.language: null` detects the language even when the workspace names one (`RecordingTranscriptionRequest`). ElevenLabs gets Norwegian Bokmål and Nynorsk as Norwegian, the one Norwegian it knows. `useRecorder().start()` also accepts `transcription` for one recording. On a meeting page, a speaker can be named "It's me", which links the name to your account so your own voice can be remembered, and naming yourself offers to remember it. When the workspace doesn't recognize voices, naming someone says once that names won't carry over to later meetings.
- 1477b70: On phones, the session access control in the title bar and the Model and effort pill in the composer are now full 44×44 px touch targets. The title bar's narrow-width icon layout no longer shrinks the access control to 32 px on touch screens. The model pill no longer shrinks to a 28 px icon; when its row has less than 44 px of room, it steps aside instead.
- d6c7c4a: New `connections:personal` permission: connect your own accounts and use them in your own chats without administering the workspace. It allows creating, listing and removing only the caller's own (personal) connections, signing in to one's own account through Connect, and turning a reviewed catalog OAuth integration on for personal accounts when it is not on yet (create-only, subject-scoped, no credentials or config, within the organization integration policy). It never covers custom MCP servers, shared or workspace connections, other people's connections, or disabling or reconfiguring integrations. `connections:write` includes it, so existing roles, keys and organization key policies keep their meaning, and workspace Members can now turn such an integration on for their own accounts. Once on, the integration is visible to the workspace's other members as optional; each must connect their own account.

  Organizations can reserve this for admins with the new `personalIntegrationSetup` integration policy setting (`members` by default, `admins`), also in Organization settings → Integrations (migration 0974).

  Embeds: per-user workspaces now get `connections:personal` by default, and the new `identities` option (`"per_user"` or `"shared"`) on the `Opengeni` facade and `createWorkspaceIdResolver` decides it for tenant workspaces: `per_user` adds signed-in tenant users with it, `shared` keeps it off everywhere. `memberPermissions` still overrides both. The shared connect card and the stock conversation's in-chat connect decision use the new `personalIntegrationSetupAccess` helper from `@opengeni/contracts/personal-integration-setup`, offering only a personal connection when that is all the person may do.

- e0f94c2: Record credential preparation, client publication and sandbox client readiness in startup timings. Overlap independent lazy post-provision prerequisites while awaiting all started work before failure or cleanup. Batch timing receipts without changing model input or credential authority.
- 9be821d: The components now work on React 18, which the package has always declared alongside 19. Many of them read `ref` as an ordinary prop, which only React 19 passes through, so on React 18 (and runtimes that behave like it, such as Preact with `preact/compat`) a ref never reached its element. In a narrow embed, where `SessionShell` shows the chat list as a drawer, focus did not return to "Open navigation" after the drawer closed, Radix triggers built with `asChild` lost their anchor, and on some runtimes opening and closing the drawer threw and left the page covered by overlays. Every component that takes a ref now forwards it with `forwardRef`, which works the same on React 18 and 19, and `inert` is written in a form both versions apply. `NewSessionLink` accepts anchor props and a ref, so a tooltip trigger can wrap it. A host that supplies its own `NavigationHost.Link` on React 18 should wrap that link in `forwardRef` so the ref reaches its anchor.
- fcb58f9: The compiled stylesheet now includes the layout utilities the event trigger editor uses, so its form lays out correctly in hosts that load the compiled CSS.
- 314522c: A meeting can be renamed while it records. `Recorder.rename(title)` (and `rename` from `useRecorder`) stores the title with the recording on the device: before the server has the recording it goes out with its creation, after that with the next upload pass, so a dropped connection only delays it; once the recording is finalized it goes straight to the server. The recorder snapshot now has the `title`. `RecordingTransport` may include `updateRecording`, which renaming needs once the server has the recording. The web recorder shows the meeting's name while recording, with Rename.
- 83682c3: Meetings can recognize people by voice. It is off by default. When a workspace turns on `settings.recordings.voiceprints`, each diarized speaker's voice vector is kept with the transcript. People who agreed to be remembered get a voiceprint learned from the speakers named as them, and new transcripts suggest them by name with a confidence. The new routes are `PUT` and `DELETE /v1/workspaces/:workspaceId/recording-people/:personId/voice`. A member agrees with `self` consent, and someone from outside the workspace with `attested` consent. Turning the setting off forgets every voice. `PATCH …/speakers` takes `rejectSuggestions` to turn a suggestion down. The SDK adds `rememberRecordingPersonVoice` and `forgetRecordingPersonVoice`, `useRecordingPeople` adds `rememberVoice` and `forgetVoice`, and `useTranscript` adds `rejectSuggestion`.
- acac580: The session-only React entry no longer reaches `@opengeni/contracts`. Telling a secret approval card from an ordinary question now comes from the new zod-free `@opengeni/sdk/secret-use-approval` subpath (`secretUseApprovalIdFromQuestionId`, `secretUseApprovalQuestionId`, `SECRET_USE_APPROVAL_QUESTION_PREFIX`), backed by `@opengeni/contracts/secret-use-approval-question`; the contracts root still exports the same helpers.
- 34f54fe: Opening a Site no longer moves its sidebar row, just as opening a chat doesn't. A Site row's time is the latest of its conversations, its newest published version, and the chats that published it (the one that created it and any used to edit it), as far as you can see them. Opening a Site still lists it in your sidebar.
- 119f33d: Add independently gated Microsoft Teams agent tools and linked Teams conversations, with durable admission and delivery, private-message authority checks, and workspace setup APIs. Both integrations remain disabled by default.
- c194abb: The desktop app has a Settings → Computer use page that shows, in one place, what Opengeni may do on the computer. The Computer use switch comes first; under it are control the screen (with Screen Recording, Accessibility and Input Monitoring), Google Chrome through the Opengeni Browser extension, the Desktop, Documents and Downloads folders and the Excel add-in, then App-shots and the microphone. Each row has one switch or one action. Turning a switch on asks the system for its permissions in the same step, one after another as each is allowed, or opens the exact System Settings pane when macOS needs the person to change it there, and the row shows Allowed when they come back. A permission the person hasn't allowed is a calm line naming what's missing, not an error, with one Open System Settings action for the page (on the Computer use row, or the row's own for the microphone); red is only for real failures. Turning one off is enforced: with screen control off the app restarts its agent with `OPENGENI_AGENT_SCREEN_CONTROL=off`, and the agent then offers no desktop, reports no screen consent or macOS permission states, starts its browser controllers without a computer backend, asks for no grants, captures nothing and injects no input whatever the connection's consent says; with Chrome off the agent releases its Chrome native-messaging host and starts no attached-browser bridge; with the microphone off the app refuses every microphone request. The switches are on by default and persist in the app's data folder; a settings file that can't be read counts as everything off until a save replaces it (a damaged one is also copied to `.corrupt`). A save or restart that fails shows on its row. The desktop bridge gains `computerCapabilities`, and this-computer status gains `folders`. App-shots settings move from Settings → Machines to this page, which Machines now points to. The agent's `permissions` answer says it honours the screen-control switch; with an older agent the switch shows as unavailable. The `computer-use` page joins the client page list.
- Updated dependencies [c8ddf55]
- Updated dependencies [1988e97]
- Updated dependencies [e7f5d38]
- Updated dependencies [c5974ea]
- Updated dependencies [15b4701]
- Updated dependencies [e3782bb]
- Updated dependencies [e1838ff]
- Updated dependencies [eb30cb4]
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
- Updated dependencies [dca33ef]
- Updated dependencies [392db50]
- Updated dependencies [3b9f0e5]
- Updated dependencies [dcbe25d]
- Updated dependencies [31bca3c]
- Updated dependencies [1d5bc4e]
- Updated dependencies [6acfbd3]
- Updated dependencies [21e7ecf]
- Updated dependencies [fb90446]
- Updated dependencies [0826dfd]
- Updated dependencies [627b2f1]
- Updated dependencies [bd57ea7]
- Updated dependencies [c307566]
- Updated dependencies [a97c71b]
- Updated dependencies [8bd2c99]
- Updated dependencies [406d1b9]
- Updated dependencies [2c34440]
- Updated dependencies [c992791]
- Updated dependencies [87d1b8a]
- Updated dependencies [1cac78f]
- Updated dependencies [826b002]
- Updated dependencies [4998a79]
- Updated dependencies [4695d41]
- Updated dependencies [d6c7c4a]
- Updated dependencies [68b195d]
- Updated dependencies [f9f0607]
- Updated dependencies [75348a5]
- Updated dependencies [cc319f3]
- Updated dependencies [314522c]
- Updated dependencies [3b1d8c1]
- Updated dependencies [ee4df07]
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
- Updated dependencies [b7a14bd]
- Updated dependencies [119f33d]
- Updated dependencies [c194abb]
- Updated dependencies [0383280]
- Updated dependencies [1534f12]
- Updated dependencies [7c02dbd]
  - @opengeni/contracts@5.3.0
  - @opengeni/sdk@5.3.0
  - @opengeni/connect@5.3.0

## 5.2.1

### Minor Changes

- fb72b9d: Any member can now give a session they started their own access, not only organization owners and admins. The app calls it full access. Its agent can do exactly what that person can do in the app and nothing more, and the access ends when the person leaves the session's workspace. The organization's on/off switch is unchanged.

### Patch Changes

- b3a641c: With the `chatList` feature off, the new-chat page no longer shows the project picker or the workspace's recent chats, so an embed that shows a single chat does not list the others.
- c4d18a1: The app no longer reads the workspace GitHub status for a member whose grant lacks `github:use`; it shows no GitHub state instead of a failed 403 request.
- Updated dependencies [fb72b9d]
- Updated dependencies [2d6484c]
  - @opengeni/contracts@5.2.0
  - @opengeni/sdk@5.2.0
  - @opengeni/connect@5.2.0

## 5.1.2

### Minor Changes

- 9c72069: `SessionApp` takes `onSessionState`: it is called with the open chat's status and the events the chat holds (`SessionViewState`) each time they change, read from the stream the chat already uses. A host can show that the agent is working, or refresh what a turn changed, without opening a second stream for the same chat.

### Patch Changes

- Updated dependencies [5d377a7]
  - @opengeni/sdk@5.1.0
  - @opengeni/connect@5.1.0
  - @opengeni/contracts@5.1.0

## 5.0.2

### Minor Changes

- 3083c1e: `createSessionProxyHandler` is now a relay: it forwards every Opengeni route and method inside the resolved workspace as the resolved user, so a product with its own sign-in gives its users the same Opengeni they would get natively (chats and their history, queue, goals, approvals and human input, files, artifacts and Sites, voice, schedules, Knowledge), decided by Opengeni's permissions instead of a list in the relay. Outside the workspace it answers only the bootstrap reads (`GET /v1/workspaces`, `GET /v1/access/me` and `GET /v1/config/client`, each scoped to the resolved workspace); a path naming another workspace is a 403. Path segments are forwarded re-encoded, so keys and subject ids in paths work as in the SDK client. Archived history import (`session-imports`) and browser MCP credential rotation stay refused: only the product's server may write either. Request bodies stream through, Opengeni's statuses, error envelopes and content headers are kept, and SSE streams get heartbeats between events.

  Narrow what users can do with the organization key's permissions, the member's permissions (`addExternalWorkspaceMember`, `updateExternalWorkspaceMember`), and the new `refuse(route, context)` hook for routes Opengeni would allow but the product keeps closed (`route` is `{ method, segments, sessionId }`; return `true` for a 404 or a `Response`). Choose what users see with UI props and `SessionApp` presets. `authorizeSession` now also runs for every request that names a chat in `x-opengeni-session-id`.

  Breaking:

  - Removed options and their replacements: `sessionApp` and `office` (the full app and the Excel add-in work without them), `sessionList` (the list is Opengeni's; pass `listProps={{ mineOnly: true }}` to `OpenGeniChat` or `mineOnly` to `SessionList` for the user's own chats), `archive` (`listProps={{ archive: false }}`), `voiceInput` and `realtimeVoice` (the `voiceInput` and `realtimeVoice` component props), `files`, `sandboxFiles`, `artifacts` and `sites` (permissions, or `refuse` for the routes; `editableLiveUrl` is now a top-level option).
  - Newly reachable for a resolved user, within their permissions: every workspace route, including sandbox file reads (`files:read`, without the old workspace-only rewrite), artifact and Site writes (`artifacts:publish`), schedules, Knowledge, chat cancel, workspace pause and resume, and archive with Pause (`sessions:control`). Without a `createSession` hook the browser now creates chats with Opengeni's own create request (MCP credential updates refused), with `chats` defaults filling what it leaves out.
  - Artifact and Site reads are no longer checked against the session that produced them; `authorizeSession` and Opengeni's `artifacts:read` decide (a product that wants the old check calls `getSessionProxyArtifactAssociation` from `refuse`). `downloadSessionProxySiteHtml`, `SESSION_PROXY_SITE_HTML_MAX_BYTES` and `SessionProxySiteHtmlTooLargeError` are removed; Site HTML keeps Opengeni's sandboxing and download headers.
  - Without `authorizeMutation`, mutations with a `text/plain` or `application/x-www-form-urlencoded` body are now refused as well as cross-site ones.
  - The client config no longer reports `sessionCreation`, `archive`, `realtimeVoice` or `sandboxFiles`; `artifacts` is reported whenever the editor's live socket and the user's grant are available. Stock components treat the missing flags as available and keep honoring them from older relays.
  - Create and other responses keep Opengeni's status (for example `202` for a created chat).

  `@opengeni/react`: `SessionList` gains `mineOnly`, and `OpenGeniChat` forwards it through `listProps`.

- 1320d6c: `SessionApp` takes `resolveLink` and `renderLink`, so a host opens links in agent messages its own way (an artifact on the host's own page, its own link scheme); they are asked before the app's own handling. Object links in an embed no longer resolve against the host page's origin: with the dock on they open in the dock, and with it off (the `embed` preset) they open the object's page in the web app through `openUrl` instead of a broken host-origin link.
- 217ed52: Shared chats on a member's personal machine now show one clear notice when another member's messages or worker results are waiting, naming whose work waits and why. The machine owner can continue with that work in one click; other members see that it waits for the owner before they send.
- ce7f5f3: The Site view's chat panel no longer repeats the Site's conversation list (the sidebar already nests it under the Site row). It shows the open conversation as a regular chat with the model picker, titled in its header, with one New action. The panel can be resized by dragging its left edge or with the keyboard (320 to 720 px, leaving the Site 360 px where there is room), hidden and shown again (choosing a conversation shows it), and its width and hidden state are remembered per person. Adds a reusable `ResizeHandle` window-splitter primitive.

### Patch Changes

- ca3f931: Workspace control events now reach a reader only for chats that reader can see; a cursor-only frame keeps hidden events from stalling the reader. Session start notices accept machinesEnabled so viewers without machine access never request the machine list.
- a9d20b3: Pause chat work atomically before personal archiving, require confirmation for active shared work, and retain explicit hide-only behavior for read-only and embedded proxy clients. Restore does not resume work. Keep sidebar survivors stable across archive completion and overlap independent session response reads without changing transaction or authorization boundaries.
- 929ca26: The session list's archive action reads its "Hide for me" label from the host message catalog again (`sessionList.archive`), so apps can translate or rename it.
- f7dfe7a: The composer's "Opengeni is updating" line now appears only when a session event stream that was live drops and keeps reconnecting. A slow first connection, or a host client that never reports its stream state, no longer shows it or shifts the conversation.
- Updated dependencies [ca3f931]
- Updated dependencies [487bd43]
- Updated dependencies [a9d20b3]
- Updated dependencies [171cdb7]
- Updated dependencies [3083c1e]
- Updated dependencies [6d29c01]
- Updated dependencies [f975174]
- Updated dependencies [4afe92f]
- Updated dependencies [217ed52]
  - @opengeni/sdk@5.0.0
  - @opengeni/contracts@5.0.0
  - @opengeni/artifact-tool@5.0.0
  - @opengeni/connect@5.0.0

## 4.8.0

### Patch Changes

- fd953dc: A sub-session question that an agent (such as the parent) answered or skipped is now shown as agent work instead of conversation: one quiet "Asked Target branch → main" row inside the turn's "Worked for" details, which opens to the question, who answered, and the answer. Nothing appears on the person's side any more. Questions a person answered, system skips (a scheduled run's unanswered question), and expired, cancelled or still pending questions look as before. `@opengeni/react/timeline-model` exports `isAgentWorkHumanInput` and `agentWorkHumanInputSummary` so custom renderers make the same decision. React Native: `NativeTimelineMessages.humanInputOutcome` and `OpenGeniNativeLabels.humanInputOutcome` gain an optional `agentSkipped` (defaults to `skipped`), and host overrides of `agentAnswered` still apply to the new row. `OpenGeniNativeSessionView`, which has no turn work details, shows the question as a compact step.
- 3089aaf: Stay calm while Opengeni is updating. The SDK now decodes the parked maintenance answer (`{"error":"maintenance"}`) into an `OpenGeniApiError` with `code: "maintenance"`, `retryable: true` and `outcomeUnknown: false`, without a support reference. `isMaintenanceError` and `OPENGENI_MAINTENANCE_ERROR_CODE` are exported, and `isTransientRequestError` treats the marker as transient.

  In the console and embedded chat, an update or brief outage no longer shows red errors, References, a "Queue needs attention" chip or error toasts. The composer shows one line, "Opengeni is updating. We'll reconnect automatically.", keeps a message sent meanwhile in place with the same idempotency key and delivers it once the API answers, and clears on its own. Reads keep retrying for as long as the maintenance marker lasts. Other transient failures stay calm for two minutes; after that, and for any definitive error, the existing error copy appears. At startup, the web, desktop and embedded apps show "Updating" or "Reconnecting" and continue by themselves when the API is back, with Try again as a secondary action.

- bcce117: The Connected Machine card keeps its Allow button when the agent asks for a machine while the chat already runs on a different one. Before, it showed as done ("This chat runs on …") and gave no way to allow the requested machine.
- e2a641c: Muting replies on a run of a schedule that starts a new chat each time now mutes the whole schedule, so later runs stay quiet. The session menu says "Mute this schedule's replies" there, and `SessionInboxMute` carries an optional `scope`.
- Updated dependencies [3089aaf]
- Updated dependencies [e2a641c]
- Updated dependencies [85fb89e]
  - @opengeni/sdk@4.8.0
  - @opengeni/contracts@4.8.0
  - @opengeni/connect@4.8.0

## 4.7.2

### Patch Changes

- 8301382: A sub-session's question can now be answered by the person or by the parent agent, and the first answer wins. The parent's `child_requires_action` notice now carries each question's id, kind, prompt and option ids and labels (never secret specs), so the parent can answer with `session_human_input_respond` without reading the sub-session's history. The notice now also wakes an idle parent that has no goal. An agent whose answer arrives after someone else's gets `outcome: "unchanged"` with `alreadyAnswered: true`, who answered, and a warning not to answer again; before, it got a success-looking `replayed` result. The `user.humanInputResponse` event records whether a person, API key, agent or the system answered. The agent instructions and the `request_human_input` and `session_human_input_respond` descriptions now say that a parent answers when it can from its task context, leaves questions only a person can answer (decisions, preferences, credentials, approvals) to the person, and never answers on the person's behalf. The conversation now says "Agent answered" instead of "You answered" when an agent gave the answer.
- e423d8f: A parent session now shows the questions and tool approvals its sub-sessions are waiting on, pinned above the composer. Each one names the sub-session that is asking, uses the same answer form or approval card as the sub-session's own page, and sends the answer or decision to that sub-session as if it were given there, with the same permission checks. An unsent answer is shared with the sub-session's page, so it is still there when you switch between them. Several waiting sub-sessions stack under one line ("3 sub-sessions need you") that collapses. Each item links to the sub-session, opened at the moment it asked. A request disappears once it is resolved anywhere, including by the parent agent answering it. The collapsed bar of a question with a deadline no longer shows "[object Object]".
- b3fc68b: Site rows in the sidebar sort only by real activity: their conversations, a new published version, and your own opens. Archiving, restoring or rolling back a Site no longer lifts it for everyone. The console records one open per page that shows a Site: not again when its client is replaced, and not again when a reload, restored tab or Back shows a page where it was already recorded. A page that loads hidden counts once it is shown.
- ee5020c: Text selected and copied from the conversation timeline no longer carries the app's styling. Browsers copy a selection's rich text with the page's computed colours, fonts and the surrounding message's background inlined, so pasting into a document or chat brought the timeline's dark or tinted backgrounds along. The timeline now copies its selection as clean semantic HTML (paragraphs, lists, emphasis, code, links, tables and images keep their structure) together with the browser's own plain text. Selections inside editable fields and outside the timeline keep the browser's default copy.
- Updated dependencies [c6499fc]
- Updated dependencies [a6a1dac]
- Updated dependencies [8301382]
  - @opengeni/contracts@4.7.2
  - @opengeni/sdk@4.7.2
  - @opengeni/connect@4.7.2

## 4.7.1

### Patch Changes

- @opengeni/connect@4.7.1
- @opengeni/contracts@4.7.1
- @opengeni/sdk@4.7.1

## 4.7.0

### Patch Changes

- f6d388d: Tool steps from connectors whose server lives on another host than the provider (Linear's mcp.linear.app) show the connector's logo again instead of the generic wrench. `connectorLogoIndex` and `connectorLogo` in `@opengeni/react/timeline-model` index each catalog entry under its provider domain, its connection's domain and its MCP server's host, so web, native and embedded surfaces resolve logos the same way.
- 28a7a33: Control+Tab in the desktop app now reaches further back. The list keeps every chat you opened recently (it used to stop at ten), then carries on through your other recently active chats in all your workspaces under a "Recently active" heading, so holding Control and pressing Tab keeps scrolling back in time. Chats that load while the list is open join at the end without moving anything.
- c09c85e: A list row's one-line meta no longer leaves a separator dot with nothing after it on narrow screens. A fact without room for a few letters now drops out whole, and later facts still give way before earlier ones. A Claude account that needs reconnecting no longer shows an empty usage fact (which rendered as a stray leading dot).
- 0b378e8: Keep the "Connect a model" composer pill label readable: the label no longer forces the normal foreground colour onto the primary-coloured pill, which made the text invisible.
- a0a7916: Skill tool rows now say "Read skill" and name the skill, with a distinct skill icon.
- Updated dependencies [31095f1]
  - @opengeni/contracts@4.7.0
  - @opengeni/sdk@4.7.0
  - @opengeni/connect@4.7.0

## 4.6.1

### Minor Changes

- d0eb91c: A session's sub-agents now come back newest first at each level, and the 200-agent cap keeps direct agents and newer ones before deeper or older ones (it used to keep an arbitrary subset ordered by id). `sessionAgentAttention` and `formatWaitingSince` in `@opengeni/react/session-agents-model` give the word a manager must act on (Needs you · 10h, Failed, Stuck, Paused) for web and native. The phone's agents sheet shows that word in place of the time, and folds each agent's own agents behind a count.

### Patch Changes

- Updated dependencies [e7ca55f]
  - @opengeni/sdk@4.6.0
  - @opengeni/connect@4.6.0
  - @opengeni/contracts@4.6.0

## 4.5.0

### Minor Changes

- f838cb7: A deployment that ships its own branded build of the browser extension can now name and link it. Set `OPENGENI_BROWSER_EXTENSION_NAME` and `OPENGENI_BROWSER_EXTENSION_INSTALL_URL`. Agent tool descriptions, setup notes and errors, `/v1/config/client` (`browserExtension`), the machine card's Chrome step and the browser panel's install hint then use that name and install link. Without them, everything still says Opengeni Browser and links its Chrome Web Store page, unchanged.
- 1d65f48: The mobile app can search chats across all of a person's workspaces, like ⌘K on the web. A search button on the home screen opens the chat search, which matches chat titles in the current workspace first and in the person's other workspaces after, labelling each chat from another workspace with its workspace's name. Matching workspaces appear too, so a search can also switch workspace. Opening a chat from another workspace switches to that workspace. `SessionRow` accepts an optional `workspaceName`, and `@opengeni/react` exports the chat-title ranking helpers `rankLabel`, `foldForSearch` and `LOOSE_MATCH_BELOW`.
- 4e8a749: Every Site is a sidebar row, not only Sites with conversations. A Site sits in the project of the chat that created it, and new Site conversations are filed there too. Opening a Site counts as activity for its row, so Sites in use rise and untouched ones sort down. Adds `recordSiteOpened` to the SDK (`POST /v1/workspaces/:workspaceId/published-artifacts/:artifactId/opened`), returning `SiteOpenedResponse`.

  `siteGroups[].conversations` can now be 0. An older `@opengeni/react` rail shows such a row with a "0" count until it is updated.

- d0bc2d6: Sites with conversations are rows in the sidebar. Each Site row shows how many conversations it has and their status, sorts by latest activity with other rows and stays in its project. Its conversations are nested under it, collapsed by default, and no longer appear or disappear depending on which session is open. Session lists take a `siteConversations` option: `group` returns complete `siteGroups` for a root page, and `include` lists Site conversations as ordinary rows. Workspace list hints report the viewer's changed Site conversations separately in `siteSessionIds`.
- 0b3b079: Opening a Site from the sidebar shows the Site with its conversations beside it. The newest conversation is open, the others are listed to switch between, and New starts another one in the Site. Opening one of a Site's conversations from the sidebar or from a chat's Site link shows the same view with that conversation selected.

### Patch Changes

- 6f9b6f5: An embedded session app (the `embed` preset) no longer shows Opengeni branding a product did not ask for. The mobile header respects the `brand` switch. A new `starters` switch, off in `embed`, hides Opengeni's suggested first tasks (connect Slack, GitHub, Linear and so on). Someone without GitHub access in the workspace no longer gets a "GitHub status unavailable" toast every time the window regains focus.
- 7e5e08f: Every first-party tool step in the timeline now draws an icon that matches its words (a globe for the browser, a monitor for the screen, a spreadsheet for Excel, an hourglass for waiting, and so on) instead of the generic wrench. The mapping lives in one shared table keyed by tool step, so the web app, React Native and embedded chats all get the same icons; a new step without an icon fails to compile. Connector and custom tools keep their family icon or the wrench.
- debd64e: When something you can fix blocks the agent, the setup card now appears in the same reply, so you no longer have to ask the agent how. The first case is your own Chrome: if the agent needs it and it isn't connected, a Chrome card shows one step at a time: connect a computer, add the Opengeni Browser extension, then continue. The existing card for allowing a chat to use your personal machine now goes through the same path.
- 0910456: Holding ⌘ (Ctrl on Windows and Linux) for a moment in the desktop app shows each pinned chat's ⌘1 to ⌘9 key in place of its time, so the shortcut is discoverable. The numbers follow the order the Pinned section shows. Browsers keep ⌘1 to ⌘9 for their own tabs, so the hint appears only where those keys work.
- 3e4426e: Ride out API rolling deploys and short network blips quietly. The SDK client now retries safe JSON reads (`GET`/`HEAD`) that fail with a transport error or a `502`, `503` or `504`: up to 4 attempts within 5 seconds with jittered backoff, honoring `Retry-After`. Tune it with the new `readRetry` client option or turn it off with `readRetry: false`; mutations are never retried. `isTransientRequestError` is exported for callers with their own retry loop.

  In the console, session, session list and workspace reads, the session event stream and the session lookup page keep showing the loading state or the last loaded view through a transient failure and retry on their own, with no error toast. Only a failure that lasts more than 20 seconds shows an error, once, with a Try again action, and the page keeps retrying in the background and recovers by itself.

- 60e9756: The Site view counts as its own `sites` page in web analytics and client signals, and it declares that its panes scroll themselves inside the app canvas.
- d8179be: The timeline step for starting a worker now reads "Started a worker" instead of "Got help from another assistant", which claimed the help had arrived when the worker had only started. A worker started through `tool_invoke` now shows as the same worker card (title, status, link to the worker) as one started directly.
- Updated dependencies [f838cb7]
- Updated dependencies [debd64e]
- Updated dependencies [3e4426e]
- Updated dependencies [68c3907]
- Updated dependencies [e38f20d]
- Updated dependencies [e22eeca]
- Updated dependencies [4e8a749]
- Updated dependencies [d0bc2d6]
- Updated dependencies [60e9756]
  - @opengeni/contracts@4.5.0
  - @opengeni/sdk@4.5.0
  - @opengeni/connect@4.5.0

## 4.4.1

### Minor Changes

- 2a2acb2: Chats and workspaces across the whole account, from the keyboard. ⌘K now finds chats in all of your workspaces (this workspace's first, others tagged with their workspace) and finds workspaces by name; "Switch workspace…" lists them to pick from. Control+Tab in the desktop app reaches recent chats in other workspaces too. ⌥⌘↑ and ⌥⌘↓ (Ctrl+Alt+↑ and Ctrl+Alt+↓ on Windows and Linux) go to the previous and next workspace, and the workspace picker lists every workspace, grouped by organization, in that order. ⌘K and the desktop Chat menu also offer "Fork chat", which forks from the latest message.
- b58a428: The desktop kit now fits a product whose web app has its own routes and its own server.

  - `webPaths` in the desktop kit's config says where the product's web app shows a workspace, a session, the inbox and settings. The app reads links, reopens the last page and opens notifications and menu commands with it. `parseAppLink`, `parseComputerConnectLink` and `computerConnectUrl` take the same `AppWebPaths`; `OPENGENI_WEB_PATHS` is Opengeni's own web app and stays the default.
  - The "Open in app" handoff uses the app's own scheme: `parseAppLink(url, { scheme })`, `appHandoffUrl(url, scheme)` and `openInAppUrl(url, scheme)`.
  - `allowOtherServers: false` hides "Use another server" on the first-run page, and the app then signs in to its own server only. Its messages name the configured server instead of Opengeni's.
  - `agentPath`, `agentConfigDir` and `adoptStandaloneAgent` pass through to `ThisComputer`, so an app can keep its own agent apart from a separately installed one.

- e3c07bc: Embedded chats can now explain why a message didn't start. When a shared chat still runs on someone else's personal computer and another participant's message is held, `SessionStartNotice` from `@opengeni/react/session-ui` says why in the reader's language, lists the machines they're allowed to use, and offers one recheck once the chat has moved. The saved message is kept and is never sent twice, and access rules are unchanged. `useSessionStart` and the matching model helpers are available from `@opengeni/react/session` for custom layouts, and all text comes from the new `sessionAdmission.*` message keys. The React Native session screen shows the same explanation and machine choices. The hosted app now uses these same components.
- 182eff6: Embedded conversations now show the same startup row as the Opengeni web app while a new chat's first turn starts (queued, preparing the sandbox, contacting the model), instead of a separate "Thinking…" loader that the turn's work row later replaced.

  `SessionConversation` and `useSessionConversation` take a `pendingPrompt` (`{ text, sentAt }`) and accept a `null` session ID. A host whose server creates the session can render the conversation the moment the person sends, with their message and the startup row, and pass the session ID when its create call returns. It stays the same mounted conversation, so the message and startup row stay in place through the hand-over to live history, with no empty "No activity yet." frame. `OpenGeniChat` passes the first prompt the same way when it opens a chat it just created, and `CreatedConversation` now includes `sentAt`.

- 926e0b8: The Excel add-in now has its own Capabilities tile, "Microsoft Excel". The tile explains the add-in, shows the three setup steps and links to the deployment's install page. It uses the deployment's own add-in name and install URL (`OPENGENI_OFFICE_ADDIN_NAME`, `OPENGENI_OFFICE_ADDIN_INSTALL_URL`).

  Agents can find it with `capability_catalog_search` (excel, spreadsheet, xlsx) and post its install card with `capability_authorization_request` (`api:excel-addin`). The card reports ready when the person already has a workbook open with the add-in. `excel_run` and the spreadsheets Skill tell agents to offer the add-in when someone works on a spreadsheet and no workbook is connected. `excelAddin`, `excelAddinCatalogItem` and `EXCEL_ADDIN_CAPABILITY_ID` are exported from `@opengeni/core`.

- 25d1500: Infrastructure-only session events, such as the idle sandbox reaper terminating a shared box, no longer move a session's `updatedAt`, so stopped sessions keep their real last-activity time in the sidebar and session lists (migration 0904). Sessions and session list entries now carry `hasUpcomingSchedules`, and the sidebar schedule icon only appears for schedules that can still fire. A session whose schedules are all paused or expired keeps a distinct "No upcoming runs" schedule button in its header. Editing only a schedule's timing now refreshes open session lists (migration 0905).
- 201c380: Add `homeSessionSections` to `@opengeni/react/session-list-model`: every pinned conversation, then up to fifteen recently used ones (running first), so pins never push recent work off a phone home screen. The mobile app's home screen now lists Pinned and Recent chats under the composer, scrolls through them, and ends with a link to all sessions. Relative times between 45 and 59 seconds now read "1m" instead of "0m".

### Patch Changes

- dd61c8d: The keyboard action list is built on first use (`appActions()` replaces `APP_ACTIONS`), so its icons are never read before the chunk that defines them has loaded, whichever page a visitor opens first.
- efd4df0: Typing with AltGr on Windows no longer fires Ctrl+Alt shortcuts. AltGr+A ("ą" on Polish keyboards) no longer archives the chat, and AltGr+B ("{" on Czech and Hungarian keyboards) no longer toggles the workspace panel. The typed character now reaches the message box.
- 4ff99bd: A turn's answer no longer jumps past the work row when the turn finishes. Once the agent declares its answer, the "Working" row moves above it while the turn is still running, the same place the "Worked for" row takes afterwards, so the answer someone is reading stays where it is.
- 23dfcb2: Keep the chat directory's status-change check free of the rail's status code, so eager pages no longer load the command menu's status marks and the production web build passes again.
- b800b7f: The command menu's chats and the Control+Tab switcher show each chat's status with the sidebar's marks: working, queued, waiting, needs you (and for how long), failed, unread, scheduled, and who started it. Statuses show only while they are known to be current; chats outside the sidebar on screen are read again when a list opens and every 20 seconds while it stays open.
- a506901: Compact session times ("3d") now count calendar days in the viewer's time zone, the same way the long form ("4 days ago") does, so the sidebar and the command menu show the same age for a chat.
- dfa5df0: Opening a chat puts the cursor in its composer: choosing a chat from the command menu or Control+Tab focuses the composer once the menu closes and the composer is ready, and opening or reloading a chat focuses it when nothing else has focus.
- 565253c: The in-flight shimmer on "Working", running tools, running agents, transcription and timeline loading labels no longer keeps the main thread busy. It used to animate a text-clipped gradient, which repainted the text on every frame for as long as anything was running and slowed typing and scrolling in long chats. The new `ShimmerText` slides a masked highlight copy with transforms only, so the compositor runs it. It looks the same and still turns off for reduced motion and forced colors. The `og-shimmer-text` class remains for host markup.
- 343c1aa: Connecting a built-in integration such as Outlook or Gmail now finishes by itself after sign-in: setup loads the reviewed tools and installs them, showing "Finishing setup…" instead of stopping at a "Choose tools" step. Before, closing the window or leaving the page at that step left the account connected with no tools, so agents could not use it. Custom OpenAPI and GraphQL sources still ask which tools to add, and any error brings the manual controls back.
- 524ddde: The desktop app shows an Update button at the bottom of the sidebar as soon as it finds a new version. One click installs it: a downloaded update restarts the app at once, otherwise the download finishes and the app restarts by itself. The app now checks for updates every hour, and the desktop bridge gains an `updates` capability (state, install and change events).
- 73132c4: A form whose save finishes after the person has already left it (for example navigated to another page) no longer closes itself afterwards, so it can't pull them back to where the form was.
- 85c0948: A dialog that its owner closes while a save is still running, such as a confirm that closes and then refreshes the page, can again be dismissed with Escape or a click outside when it is reopened. The form still tells its owner when the save ends, even after it has closed.
- 67ce6ff: Unsent answers to an agent's question are no longer lost when you leave the session and come back. Typed text, Other text and selections are kept in the browser tab until you send or skip, the question expires, or it is answered elsewhere. Secret answers are never kept.
- dbc847f: When an agent is refused a personal (Only me) machine, the Connected Machine card now names the machine it asked for and leads with Allow; other machines and setup fold under "Use a different machine". The card event carries the requested machine as `requestedSandboxId`. If the agent asks again in a later turn, only the newest card stays a full card and earlier ones become one short line, so a chat no longer piles up copies of the same card.
- b81d318: Connecting Outlook or OneDrive no longer dead-ends when a Microsoft 365 organization requires an administrator to approve the app. When Microsoft refuses or the person returns from its "Need admin approval" page, the connect dialog explains that a Microsoft 365 admin can approve the app for everyone and offers an admin approval link to open or copy. The administrator lands on a short confirmation page, and people connect again afterwards. The connect attempt's error message carries the same link, so agents can pass it on.
- 7157f58: Typing in the composer and streaming replies no longer restyle the whole page. Several stylesheet rules used `:has()` on an element other than the one being styled (the composer footer's voice states, the macOS title bar beside a collapsed sidebar, connect-form labels, and the avatar group count), which made Chromium recompute styles for every element on each DOM change: about 35 ms per keystroke in a long chat. The composer footer now carries `data-footer-transcription-capturing`, `data-footer-transcription-attention` and `data-footer-realtime-attention` itself, the session shell carries `data-rail-collapsed`, and `AvatarGroupCount` takes a `size` prop instead of inferring it. A test keeps such selectors out.
- 81a516c: Organizations and workspaces can choose the default voice model. Organization → Models → Voice and a workspace's Voice settings gain a "Default voice model" choice: the model a new voice conversation starts with. A workspace follows its organization's choice unless it picks its own, and "Automatic" keeps the previous behaviour (GPT Realtime when available, otherwise the first available model). People can still pick another model when they talk, and a model someone already picked on their device stays their choice while it remains available.

  API: `OrganizationModelDefaults.realtimeDefaultModel` and `UpdateWorkspaceSettingsRequest.realtimeDefaultModel` (a voice model id, or null for automatic or to follow the organization), and the realtime model catalog marks `workspaceDefault` and `organizationDefault`. The packaged voice control starts with the person's own usable pick, then the workspace default, then the organization default. Rolling migration 0903 adds one nullable column.

- 486abe4: The packaged voice control keeps the model of a voice conversation that is already running when the voice model catalog loads afterwards (for example after reopening a session with a live call). It no longer switches to the workspace's or organization's default model and replaces the running call's controller.
- 9c0c6d1: Keep the public sandbox recovery response compatible now that every managed backend recovers a lost sandbox. `SandboxRecoverySelection.artifactId` is a required native checkpoint id again, as it was before, so existing SDK readers never receive null there. A portable checkpoint that an automatic Retry restores is named by the new optional `SandboxRecoveryProjection.automaticCheckpoint` (`SandboxCheckpointSelection`, whose `artifactId` is null for a portable archive); `checkpoint` is set as well only when that checkpoint is native. The packaged recovery actions read `automaticCheckpoint` first. Older clients still recover these sessions when the next message is sent; they only lack the Retry shortcut for a portable checkpoint.
- 67882a3: Screen readers now read the session header's read-only access mark ("Workspace session access. Visible to people in …") and the Private mark for Personal workspace chats. Both were focusable spans with an `aria-label` but no role, which ARIA does not allow, so assistive technology could skip the label.
- 84c8b32: `createSessionProxyHandler` accepts `sessionApp: true`, so the packaged `SessionApp` runs behind a product's session proxy with no Opengeni credential in the browser (`<SessionApp apiBaseUrl="/api/opengeni" …/>`). The app sees only the resolved workspace and the resolved user's access to it. Its other reads in that workspace, and in chats `authorizeSession` admits, pass through as that user, so Opengeni's permissions decide what they see. A short list of the app's own writes passes too: pinning a chat, moving it to a project, managing projects, the new-chat draft and a chat's tool approval settings. Every other write is refused. Rosters, keys, budgets and administration stay closed even for reads. All existing proxy routes keep their rules, including the host's `createSession` and message hooks.

  Startup error screens no longer name Opengeni, so a product that embeds the app shows neutral text ("Couldn't start", "Under maintenance").

- b7943f4: ⌘B (Ctrl+B) toggles the sidebar, ⌥⌘B (Ctrl+Alt+B) toggles a chat's workspace panel, and ⌃⌘A (Ctrl+Alt+A) archives or restores the current chat. The sidebar and panel buttons and the chat menu show their keys. ⌃⌘S (Ctrl+Shift+S) still toggles the sidebar, and the menu bar shows it because rich text keeps ⌘B for bold.
- 886dc39: Site stills in the artifact library now also require their no-network policy from the frame itself, so supporting browsers block outside requests before the Site markup is parsed.
- f7f7987: Show an actionable error when a connector account was removed while a chat was open. Refresh account choices without replacing explicit selections or retrying a failed message with different credentials.
- 84b1a18: Every subscription account now has exactly one owner: the organization, one workspace, or one person, and it is used wherever it reaches and nowhere else. The per-workspace split between a workspace's own copy of an account and the organization's copy, the preference that chose between them, and "Set aside" are gone; each account has one on/off switch. A migration keeps everyone's access exactly as it was.

  The organization's account lists now include `reach` (who each account reaches), and the organization's Models page lists every account once, grouped by provider, with its owner and a summary of how many are on and how many need reconnecting. Accounts that are turned off fold away when a provider has several, and the page no longer reads every workspace's accounts or each account's access one by one.

- Updated dependencies [e697879]
- Updated dependencies [11e56da]
- Updated dependencies [524ddde]
- Updated dependencies [b58a428]
- Updated dependencies [25d1500]
- Updated dependencies [dbc847f]
- Updated dependencies [d295544]
- Updated dependencies [614c744]
- Updated dependencies [81a516c]
- Updated dependencies [60e031c]
- Updated dependencies [9c0c6d1]
- Updated dependencies [a75f55e]
- Updated dependencies [84c8b32]
- Updated dependencies [84b1a18]
  - @opengeni/contracts@4.4.0
  - @opengeni/sdk@4.4.0
  - @opengeni/connect@4.4.0

## 4.3.1

### Minor Changes

- bb438b0: An open chat now jumps to its newest messages after the connection drops, for example when a laptop wakes from sleep, the network comes back or the stream times out, instead of streaming every event it missed. A gap of 16 events or fewer still replays over the live stream; a longer one catches up the conversation and re-reads the working turn's newest steps, or loads the newest window, and the live stream continues from there. The chat also notices a sleep or a returned network right away instead of waiting for the stream's heartbeat timeout. `streamSessionEvents` and `client.streamEvents` accept an optional `beforeReconnect(cursor)` that may move a reconnect's cursor forward; callers that don't pass it keep exactly-once replay.
- 0e135b2: Add a command menu and keyboard shortcuts. ⌘K (Ctrl+K on Windows and Linux) opens one list of chats and actions: recent chats, actions for the open chat (copy link, pin, rename, mark unread, archive) and general actions, with "Search messages" handing the query to full-history search. ⌘/ opens a cheat sheet of every shortcut. One action registry feeds the menu, the chat row and header menus, tooltips and the desktop menu bar, so a key or label is defined once. `@opengeni/react/ui/context-menu` exports `ContextMenuShortcut`, and the prebuilt `@opengeni/react/compiled.css` includes the new menu's styles.

  The SDK's desktop bridge adds the `menuActions` capability with `DesktopMenuAction` and `DesktopMenuSection`, so the desktop app builds its menu bar from the actions the page reports; older desktop builds keep their static menu. Chat title search matches every word of the query in any order, in the title or first message, instead of one literal substring.

- 03947ed: Keep idle session sidebars quiet using authorized commit-level invalidations on
  the existing workspace live stream. Web and desktop refresh dirty loaded scopes
  within the existing 15-second cadence and reconcile on reconnect/focus. Private
  session IDs are filtered with the same RLS and membership fence as list reads.

  Database hosts using a transaction pooler may configure a separate direct/session
  notification URL. Older servers, external host ACLs, injected database handles
  without a listener, and finite HTTP/1 streams keep their polling fallback. The new
  SDK workspace event is transient and does not advance either durable stream cursor.

- cc0792a: Add a Control+Tab recent chat switcher for the desktop app. A quick Control+Tab opens the previously viewed chat and pressing it again comes back; holding Control shows recently viewed chats in the middle of the window, Tab and Shift+Tab move the highlight, and releasing Control opens it. Browsers keep Control+Tab for their tabs, so the switcher only runs inside the desktop app. The prebuilt `@opengeni/react/compiled.css` includes its styles.
- 2963eca: App-shots in the desktop app. When turned on in Settings → Machines, a shortcut (both Command keys on macOS by default) attaches the window you are looking at in another app to the chat you are using: a screenshot plus the window's app, title and the text it shows, including text scrolled out of view. Nothing is sent until you send it, and the attachment can be removed first. The agent receives the window's text as untrusted data inside that message only, so earlier turns stay unchanged. When your computer is connected to the workspace, the agent also learns which machine and window it was, so it can keep working in that window with computer tools; for a browser window it also gets the page address and the browser profile connected through the Opengeni extension, so it can continue in that tab with browser tools. Uploads accept an optional `appShot` description for image files (`uploadFile` in the SDK), and `useFileAttachments` gains `addAppShot`. macOS only for now; Windows and Linux plug into the same capture boundary.
- 1b57d74: Eleven Realtime now listens and replies in the person's language instead of guessing. The voice conversation follows the app language (or the browser's) by default, and the voice model menu has a Language page to pick another one. Realtime controllers accept `getLanguage`, the WebSocket connect request takes an optional BCP 47 `language`, catalog entries for models that need a fixed conversation language list their `languages`, and `@opengeni/react` exports `useRealtimeLanguagePreference`, `realtimeConversationLanguage` and `realtimeAppLanguage`.
- 277c99c: Add Eleven Realtime voice models (v1 max and v1 mini) on the shared WebSocket voice path. Workspaces connect their own ElevenLabs API key under Settings > Models > Voice, and the voice model hands work to the Opengeni session through the same delegation tool as the other voices. The SDK exports `SESSION_REALTIME_MODELS` and `isSessionRealtimeModel`, and the WebSocket answer may set `transcriptAudioTags` so clients strip expressive audio tags from transcripts.
- c236847: Live voice connects and answers faster. The microphone is requested alongside the begin request, WebSocket voices prepare capture while the provider session is minted, and microphone audio leaves the browser in 20 ms AudioWorklet frames instead of ~170 ms blocks. `prestartSessionRealtime` lets a host start voice for a session it has just created while it navigates; the session view's `useSessionRealtime` adopts that call. A delegated turn's spoken result is fetched as soon as the session reports the turn's outcome rather than on the next one-second sync.
- 4fadd37: Realtime voice settings are configurable. Each voice model offers what its provider supports: Eleven Realtime takes its built-in voices or any voice in the ElevenLabs account's My Voices by voice ID, a conversation language and turn eagerness; AI Gateway and SuperGrok models take their built-in voices. A workspace saves settings per model in the new `realtimeVoice` workspace setting (Settings > Models > Voice, or `updateWorkspaceSettings`), and an embedding app can set them per session with `voiceSettings` on the stock voice control, `useSessionRealtime` and `prestartSessionRealtime`, or `getVoiceSettings` on SDK realtime controllers. The realtime model catalog lists each model's `voices`, `customVoice`, `turnEagerness` and `voiceDefaults` and the workspace's saved `workspaceVoiceSettings`, the WebSocket connect request takes `voiceSettings`, and the SDK exports `RealtimeVoiceSettings` and `RealtimeTurnEagerness`. Nothing changes until a setting is chosen.
- 83a467d: Opening a turn's steps now reads large tool outputs as bounded previews instead of whole payloads, so a long turn's steps load in a fraction of the bytes. A row reads its full output once, when it is expanded or when its renderer needs the exact result (screenshots, images, receipts, search results, and custom renderers). Until then its body says the full output is loading, and if that read fails it says the body is a preview and offers Retry. Presented results such as images, published files and Skill or Knowledge writes are still read in full. `listEventPage` and `listEvents` accept `toolOutputs: "preview"`; servers that predate it return exact outputs. `ToolCallItem.outputPreview` and the `ToolOutputPreview` type are new and additive.

  `useSessionEvents().events` now carries those previews for opened turns until a row's exact output is read. A previewed `agent.toolCall.output` payload is marked with `outputPreview` (`truncated: true`, `shape`, `originalBytes`, `previewBytes`); with `shape: "text"` its `output` is the head and tail of the output's text rather than the original value. Code that reads tool outputs from `events` should treat a payload with `outputPreview` as partial, and read the exact event with `listEventPage` when it needs it.

- 67262de: Adds the Ultrafast speed for GPT-6 Astra and GPT-6.1 Sol. When a model offers it, the model picker replaces the Fast toggle with a Speed choice (Standard, Fast, Ultrafast) and shows what the faster speeds cost: 8× usage on a ChatGPT/Codex plan, or the rate multiple on metered routes. A Codex account offers Ultrafast only when its own model list advertises the tier, so the picker shows it only when some account serving the workspace can run it, and an Ultrafast turn is placed only on such an account. Ultrafast requests use `service_tier: "ultrafast"`, and a response served at a lower tier is not counted as Ultrafast. Turns accepted before a model declared Ultrafast keep running unchanged.

### Patch Changes

- 49f2177: Agents can record a browser flow as a video. The new `browser_record` tool starts a recording of a managed or attached browser tab and stops it into an MP4 in the chat's workspace, with a log of when each action happened beside it, and publishes the MP4 so it plays in the chat. Frames are captured only when the page changes, so recording costs almost nothing while a page is still, and the video is encoded on the server, so browser hosts need no video encoder. The SDK adds `startBrowserRecording`, `getBrowserRecording` and `saveBrowserRecording`.
- 579239a: The desktop workspace dock drops its separate header row: the machine status and the maximize and hide controls sit under the panel tabs. Site previews can hide their frame toolbar and take reload and full-screen control from the host.
- 6dd3785: A finished work row that compacted the conversation first now stays folded. The expected "Compacting conversation first" wait no longer counts as an interruption that opens the row.
- bf39d5e: Show ambiguous Connected Machine command outcomes as uncertain instead of successful, including when command details are hidden. Preserve the existing warning to inspect effects before retrying; command execution and retry behavior are unchanged.
- 540d75b: Credit refusals now say that the remaining credit does not cover the model, instead of implying the organization has no credit. Promotional credit can cover some models while another model has none left, so a 402 on Send and a turn that stops with `segmentLimit: "budget_exhausted"` both tell the person to choose a model their credits cover or add credits. The model picker's hint for an uncovered credits-billed model reads "Not covered by your credits" instead of "Needs credits". Message keys and exports are unchanged.
- 20b0aad: The credit refusal notice above the composer shows the server's sentence on its own, without the "API 402:" status prefix or the request reference.
- ee83178: Editable documents and presentations now have a Download action, exporting DOCX and PPTX like spreadsheets export XLSX. `EditableArtifactView` accepts `downloadArtifact` for all modalities; `downloadSpreadsheet` remains supported.
- b20c9b2: Retain bounded agent-update blocker categories/counts and show their report age
  and elapsed holds in Machines and fleet, without disclosing private session IDs. Distinguish controller work
  from native request admission without changing update safety, killing work or
  adding command deadlines. Older agents that cannot identify a blocker remain
  explicitly unspecified. These diagnostics do not establish the cause of an earlier
  hold whose admission snapshot was not retained.
- 70f0522: A chat whose sandbox workspace cannot be restored is no longer stranded: the current archive can be retried on a new attempt, a cold workspace follows the session's selected sandbox backend, and a person can explicitly continue with an empty workspace. The agent then sees a filesystem-discontinuity notice on every later turn, appended at the end of its history.
- 23fed2a: Chat history no longer depends on the server and `@opengeni/react` being released in a particular order. The events API now says when it applies the conversation filter (`X-OpenGeni-Conversation-Filter: 2`, read as `SessionEventPage.conversationFilter`). When a server does not say so, the React history reads keep tool calls in and drop the ones that are not presented in the browser, so an older server that ignores `presentedToolCalls` no longer makes images, published files or Skill cards vanish from history.

  A long turn's model bookkeeping also stops filling the history window: each model call's `agent.model.request` and `agent.model.usage` rows load with the turn's steps. The server keeps the request rows up to a turn's first model response, which draw its startup phase, and every bookkeeping row of a turn that has no other steps, so what the conversation shows is unchanged. `createEmbeddedSessionClient` now keeps `listEventPage` when the base client has it.

- eeab39f: Keep accepted turns recovering while required first-party MCP setup cannot reach the internal API, instead of failing after five attempts during a deployment outage.
- e4915c1: Expose lightweight defaults, workspace-control event, and durable-fanout entry points without changing the existing root exports. Index timeline tool-call lookups by ID to avoid repeated scans while preserving event ordering and fallback behavior.
- 7ed4d2b: Keep Models settings reads across navigation, expose their freshness with an explicit refresh action, and reserve account-detail space while data loads. The client-scoped cache now supports internal mounted-read activity observation without changing the public React API.
- 7517fbc: Organization owners and admins can now connect OpenAI and Azure OpenAI once for the whole organization in Organization settings → Models, next to the other organization providers. OpenAI stores an encrypted API key; Azure OpenAI stores an encrypted key plus the Azure resource endpoint. Admins add the organization's OpenAI model IDs or Azure deployments as its models, and each is checked with the organization's key (and Azure endpoint) before it is saved. The models (`organization-openai/<model>` and `organization-azure-openai/<deployment>`) inherit into the organization's current and future shared workspaces (Personal workspaces stay local), work for sessions created through the web app and the public API, and are billed to the organization's own provider account with no Opengeni credits. `OrganizationModelProviderKind` and `ModelConnectionAccessKind` gain `openai` and `azure_openai`; organization provider connection requests and responses gain an optional `endpoint` (Azure only). A missing or revoked connection fails closed and never falls back to deployment credentials. Host `OPENGENI_MODEL_PROVIDERS_JSON` can no longer use the reserved `organization-openai` or `organization-azure-openai` provider ids. Rolling migration `0898_organization_direct_openai_model_providers.sql` widens the provider-kind, lifecycle-fact and analytics allow-lists and adds the nullable endpoint columns.

  An organization ElevenLabs key no longer counts as an OpenRouter access policy when a workspace's model restrictions are read.

- 6f150d1: Organizations can set up realtime voice once for every workspace. An organization ElevenLabs key (`elevenlabs` organization provider connection) is used by every workspace without its own key, and organization model defaults gain `realtimeVoice`: per-model voice, language and turn-taking defaults that a workspace uses for a model until it saves its own. The realtime model catalog reports the inherited settings as `organizationVoiceSettings`. Organization custom models stay limited to the model-catalog provider kinds (`OrganizationModelCatalogProviderKind`).
- 427f2a5: Leave existing standalone agents untouched when the desktop app opens. Explicit
  signed-in setup reuses their service and signed installation, preserving macOS
  privacy grants. Service-backed pause/resume persists across logins; quitting the
  desktop does not stop the service. Permission guidance uses the running agent's
  reported grants rather than probing the desktop app. Existing agents require
  the matching native release with structured service inspection before management.
- 6b08cbe: A message that waited in the queue behind running work no longer shows that waiting time as "Worked for". When several queued messages were steered in quickly one after another, each turn showed minutes of work even though it ran for about a second. A turn's queue phase now starts when the work ahead of it ended, not when the message was queued.
- b45d380: Claim compatible waiting Steer messages together, preserving each message while avoiding empty replacement attempts and response rows.
- c6a3493: Each provider row in the realtime model picker has its own `data-testid` (`realtime-model-provider-opengeni`, `-codex`, `-supergrok`, `-gateway`, `-elevenlabs`). The rows were keyed by billing class, so the AI Gateway and ElevenLabs rows, which both bill to the workspace's own key, shared one id.
- 9508318: Live voice models reached over a WebSocket (AI Gateway voices and SuperGrok) now share one path. `POST …/realtime/websocket` and `client.negotiateRealtimeWebsocket` return the provider socket URL, its subprotocols, the wire dialect and the complete provider session configuration, and `createRealtimeWebsocketTransportStarter` opens any of them; the browser no longer carries per-provider configuration. `sessionRealtimeTransportKind` now returns `websocket` for every such model; `gateway` and `xai-subscription` stay in `SessionRealtimeTransportKind` as deprecated names that are no longer returned. `negotiateGatewayRealtime`, `negotiateXaiSubscriptionRealtime` and the two older transport starters keep working and are deprecated.
- a1265ca: A browser or desktop whose sandbox instance is gone no longer keeps the sandbox warm. When a sandbox lost, drained or replaced the instance a browser or desktop controller ran in, the resource stayed `active` forever and its holder kept every later box of that sandbox warm on every provider, so it never idle-drained. The interaction reaper now marks such a resource `lost` (`placement_instance_lost`), settles its pending operations and releases its holder, and the sandbox drains normally. Resources on the current instance are untouched.
- f2ec8b4: Opening a conversation reads the session once again. Since the sandbox terminal started reading its own history, `useSessionEvents` reads the session's head to join the live stream there, a second read of the detail `useSession` already reads fresh. The head read now joins that detail read when one started since the stream began loading, and reads the session itself only otherwise.
- fe99ea2: A sidebar group no longer keeps a row another device archived or changed when that change arrives while an explicit "Show more" has failed or is still loading. The background refresh still leaves Retry and the loaded rows alone, but the group is now reread once the explicit read succeeds. Before, the stale row stayed until some later unrelated change reached the same group.
- 5f5fe8d: Steering several queued messages one after another no longer leaves a stack of empty "Worked for" rows after the messages. A turn that handed over to the next Steer before doing anything but start up did no work of its own, so it now shows no work row; the turn that does the work still shows its own.
- b603f10: Tool review details now list a Gmail selection by subject and sender instead of bare message IDs. `ToolReviewDetailsPage` items gain an optional `detail` line, which `ToolActionReviewDetails` renders under each row.
- Updated dependencies [49f2177]
- Updated dependencies [bb438b0]
- Updated dependencies [0e135b2]
- Updated dependencies [03947ed]
- Updated dependencies [f1fd83b]
- Updated dependencies [659c01a]
- Updated dependencies [d81c315]
- Updated dependencies [bf39d5e]
- Updated dependencies [fda625e]
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
- Updated dependencies [c236847]
- Updated dependencies [23fed2a]
- Updated dependencies [e4915c1]
- Updated dependencies [16781e5]
- Updated dependencies [7517fbc]
- Updated dependencies [6f150d1]
- Updated dependencies [9976132]
- Updated dependencies [427f2a5]
- Updated dependencies [724b529]
- Updated dependencies [2058cd3]
- Updated dependencies [3915617]
- Updated dependencies [908c0d3]
- Updated dependencies [4fadd37]
- Updated dependencies [9508318]
- Updated dependencies [b95784c]
- Updated dependencies [83a467d]
- Updated dependencies [b603f10]
- Updated dependencies [67262de]
  - @opengeni/sdk@4.3.0
  - @opengeni/contracts@4.3.0
  - @opengeni/connect@4.3.0

## 4.2.0

### Minor Changes

- 8c38fe4: An embedded conversation marks itself read while the person watches it.

  - `@opengeni/react`: `SessionConversation` and `SessionConversationView` acknowledge each delivered reply, question or failure for the signed-in person while the timeline is on screen, the page is visible and the window focused (once per reply, never per streamed token, with `acknowledgedThroughSequence` so a late request never hides a newer reply). Unread state, and notifications a server derives from it, then skip replies the person already saw. A hidden timeline, background tab or unfocused window acknowledges nothing; `readAcknowledgement={false}` turns it off. `useSessionReadAcknowledgement` (from `@opengeni/react/session`) does the same for custom layouts. `createEmbeddedSessionClient` passes an optional `updateSessionAttention` through.
  - `@opengeni/react-native`: the native session uses the same acknowledgement implementation, which now retries a transient failure once after a short delay and stops after a permanent rejection.
  - `@opengeni/sdk`: `createSessionProxyHandler` forwards `PUT …/sessions/{sid}/attention` with only `{ unread: false, acknowledgedThroughSequence? }`.

- 5252d01: Embedding products can show their own name everywhere people look.

  - `@opengeni/react`: a `productName` prop on `OpenGeniProvider` and `OpenGeniMessagesProvider` (and `createOpenGeniText`) fills `{product}` in every built-in string that names the product, such as credit labels and recovery notices. Default "Opengeni".
  - `@opengeni/agent-host`: `browserExtension: false` keeps an app's own agent from registering as the Opengeni Browser extension's native host, and removes a registration it made earlier, so another agent on the same computer keeps the extension.
  - The agent's browser and computer helpers now run as `browserd` and `computer-native`, so Activity Monitor and Task Manager show no product name under an app that runs the agent under its own name. Older names beside an installed agent are still found.

- 64e6d6b: Products can draw their own links in agent replies. Pass `renderLink` to `Markdown` or `OpenGeniLinkProvider` and links the agent writes with your scheme (`myapp:order/42`), in-app paths or web URLs reach you with the exact `href`, the link text and whether the link stands alone on its line, so you can show a chip or a card that opens in place. A paragraph holding a standalone link renders as a block so a card is valid there. Returning `undefined` keeps the default link. Without `renderLink`, nothing changes.

### Patch Changes

- a868e17: Repaint retained spreadsheet text tiles when web fonts finish loading so fallback glyphs do not remain cached until the next resize.
- 47eeb80: Site and console chat turns now use the same native authority, tools and execution settings. Remove automatic Site-agent restrictions and forced member profiles; retain normal access checks, approvals and outside-workspace visitor identities. Existing saved member settings and accepted turns are not rewritten. Site authors can explicitly choose narrower ordinary chat settings.
- f6cb82d: Refresh compiled styles to include the vertical padding used by the chat render-error boundary in embedded and published Site conversations.
- 44dc72a: The chat no longer blanks a published Site. The model picker accepts catalog rows without readiness or availability details, and SessionConversation and NewConversation now contain render errors with a "This chat couldn't be displayed" message and a Try again button instead of unmounting the host page.
- Updated dependencies [641e179]
- Updated dependencies [8c38fe4]
- Updated dependencies [e018445]
- Updated dependencies [47eeb80]
  - @opengeni/sdk@4.2.0
  - @opengeni/connect@4.2.0

## 4.1.3

### Patch Changes

- Updated dependencies [404e017]
  - @opengeni/sdk@4.1.2
  - @opengeni/connect@4.1.2

## 4.1.1

### Minor Changes

- 1e16831: `ArtifactSandbox` accepts optional `fullScreen` and `onFullScreenChange` props, so a host can control its full screen, for example from the page URL. Without them the frame manages full screen itself, as before.
- 04019de: Make computer offers client-aware: connect directly inside a desktop app, preserve the account and workspace in an app handoff from the browser, and let embedded products supply their own downloads and connection flow without a terminal-command fallback.
- 843bd39: Products that embed the chat can give people one Send and nothing to learn. With `busySend: "steer"` (web `composerOptions`, native `useOpenGeniNativeSession`), a message sent while the agent works is read as soon as it can, and the stock screens show no Queue choice beside Send and no Queue or Steer words: paused or lined-up messages show as waiting messages, without Steer actions. `offerQueue: true` brings the Queue choice back. `SingleSendWording` applies the same wording around your own composition of the parts.

### Patch Changes

- 34081e9: Explain unconfirmed Connected Machine cleanup and how to recover before retrying an agent update, instead of only saying the idle state is unavailable.
- 395e2ff: Shared chat fixes for embedding products:

  - Counted labels no longer crash on Hermes (React Native), which has no `Intl.PluralRules`. Without it, 1 uses the `_one` form and every other count `_other`, so no polyfill is needed.
  - The voice button no longer names the voice model: it reads "Start voice", "Try voice again" and "Talk live with the agent." The React Native call screen no longer shows the model as its subtitle. Hosts can name the action after their assistant through `messages`, for example `"realtime.realtimeControl.startVoice": "Talk to Ava"`. The keys `realtime.realtimeControl.startVoiceWithLabel`, `tryVoiceAgainWithLabel` and `talkLiveWithModellabel` are replaced by `startVoice`, `tryVoiceAgain` and `talkLiveWithTheAgent`.
  - A turn that stops because automatic capacity recovery ran out now shows a translatable explanation (`lib.format.capacityRecoveryExhausted`) instead of the server's English text. The stored event is unchanged.

- 57e3a3e: Expose actionable Connected Machine credential-expiration diagnostics without overriding live runner authority. The matching native agent pauses refused transport credentials, renews recoverable grants, and persists reconnect-required state only after an explicit permanent renewal denial. Deploy the API and release the updated agent for the complete recovery behavior.
- 9be9a82: Steer reaches the agent within seconds and no longer kills work in progress. A model request still generating when a Steer arrives is cut short: assistant messages the provider had completed stay in history, unfinished text and unstarted tool calls are dropped, and the next request carries the Steer on the unchanged history. Short tool calls finish; long `exec_command`/`write_stdin`, `command_wait`/`command_read` and `session_wait` waits return early with their handle while the work keeps running (`session_wait` reports kind `steer`). The turn then hands over (`turn.superseded` with reason `steer`, `atModelStep: true` and, for a cut-off answer, `cutOffText`) and the Steer runs next. Several Steers are read together, in the order they were sent. Agent Steer (`session_steer`) behaves the same way. Queue (an ordinary Send) is unchanged and still runs after the whole turn. Custom model transports can honour preemption with the exported `isModelPreempted` and `preemptedResponseDone`.

  The web and React Native session screens show a Steer only as the person's message: no status row, chip or "Send now". API callers can still stop the running attempt with `interrupt: true` on `steerQueueItem` on the turn that `steerMessage` returned. A new workspace setting `busySend` (`queue` by default, or `steer`) and a matching `busySend` option on `useComposer`, `SessionConversation` composer options and `useOpenGeniNativeSession` let a product make a normal Send act as Steer while the agent is busy; Cmd/Ctrl+Enter then does the other one.

- Updated dependencies [afff3f9]
- Updated dependencies [04019de]
- Updated dependencies [57e3a3e]
- Updated dependencies [9be9a82]
  - @opengeni/sdk@4.1.0
  - @opengeni/connect@4.1.0

## 4.0.4

### Major Changes

- 911c0b1: Apps can now show the components in their own words and languages. Every label, notice and user-facing error in `@opengeni/react` and `@opengeni/react-native` comes from one typed message catalog: pass `locale` and `messages` to `OpenGeniProvider` (or `OpenGeniMessagesProvider` from the new DOM-free `@opengeni/react/messages` entry), with plural forms chosen per language and English as the fallback. `englishMessages` is the full default catalog for translation tooling, and `OpenGeniMessageCatalog` types a complete translation.

  Breaking: default label objects that used to be constants are now functions of the translator (for example `defaultChatComposerMessages(t)`, `SESSION_GROUP_LABELS(t)`, `DEFAULT_SESSION_USAGE_LIMIT_LABELS(t)`, `defaultNativeTimelineMessages(t)`, `DEFAULT_OPENGENI_NATIVE_LABELS(t)`), and exported helpers that produce text take the translator first (for example `buildTimeline(t, events)`, `machineDisplayName(t, machine)`, `orgLabel(t, accountId, grants)`). Get it with `useOpenGeniText()` in components, or `createOpenGeniText()` elsewhere.

### Minor Changes

- f010292: When an agent's Skill, workspace instruction or Knowledge save is refused, the chat now tells the person. A "Not saved to Skills" (or workspace instructions, or Knowledge) row appears beside the agent's reply and stays visible when the turn folds. It appears only for genuine refusals: Agent learning is off where the change would be saved, the chat isn't allowed to make the change, or the agent was started from a Site page. It says why in plain words and links to Agent learning settings or the item. Mistakes the agent can correct and retry itself, such as citing evidence the destination's readers can't see, show no row. Previously a refusal was visible only inside the folded tool call, so a request to remember something could be lost silently.

  The refusal travels as a content-free `_meta["opengeni/learningRefusal"]` fact on the tool result (destination, reason and the targeted Skill ID only), which the model never sees. New exports: `learningRefusalFromToolOutput` and the `LearningRefusal` type from `@opengeni/sdk/learning-refusal`; the full fact from `@opengeni/contracts/learning-refusal`; and `LearningRefusalActionsProvider` and `LearningRefusalPlace` from `@opengeni/react`, which let a host open the right page. `NoticeItem` gains an optional `learningRefusal`.

- e2e75c0: "Use this computer" is now a reusable kit, so any product's desktop app can let its agents work on the person's own computer the way the Opengeni desktop app does.

  - `@opengeni/agent-host` runs the connected-machine agent from a desktop app: it downloads and signature-checks the agent (or uses one bundled in a store package with `bundledAgent`), connects it with a personal enroll token, pauses and resumes it, and on macOS walks the person through Screen Recording, Accessibility and Input Monitoring with a guide window beside System Settings that names the app and ticks off each switch as it is turned on.
  - `@opengeni/sdk/this-computer` holds the shared shapes (status, permissions, error codes, the host interface) and `allowAgentsOnComputer`, which grants the person's agents standing use of their computer, so no chat has to ask again.
  - `@opengeni/react/this-computer` has the screens: the setup dialog (intro, download progress, one permission at a time, done), the sidebar offer, the settings panel with pause, resume and turn off, and the conversation card that turns this computer on from a chat inside the desktop app and, elsewhere, says whether the person's computer is ready or where to get the app. Every word is in the message catalog under `thisComputer.*`, so a product translates them, and names its own agent, with the rest of its text; the look follows the og design tokens, with the kit's own stylesheet in `@opengeni/react/this-computer.css`. What macOS itself calls things (its permission lists and buttons) is quoted in the Mac's own language: English is built in, and a host adds others with a `MacSystemNameCatalog`.
  - The Opengeni web app now uses these screens in the desktop app: the rail offer, a "This computer" panel on the Machines page, and "Use this computer" as the connected-machine card's action when the chat runs inside the desktop app.
  - Conversation steps that find machines, move onto one and back, and use its screen now read plainly ("Looked at the screen", "Typed “hello”") from catalog keys, and a deferred tool run through `tool_invoke` is shown as the tool it ran.

### Patch Changes

- 2a93842: The startup loading animation no longer re-renders in a burst after every update to the conversation around it. Its rotating phrase was re-picked on every render, and each new pick caused another render until the random choice happened to repeat. The phrase now changes only on its five-second timer.
- 9fb9db3: A refused move to another machine now says why. Moving a running chat onto a personal (Only me) machine is refused with the new `chat_busy` code, a machine the person may not use with `personal_machine_not_permitted`, and a machine that is gone with `stale_pointer`; only a real simultaneous move is reported as `concurrent_swap`. Previously every refusal was reported as a concurrent swap. `useMachines` now shows plain copy chosen by the code and never the server's `reason` text, which is written for agents and logs.
- 5581036: The `@opengeni/react/messages` entry is now included in the published package, and the model picker popover shows its own accessible name ("Model and effort", or the host's text) again.
- 79ec9fd: Let a machine owner move a running chat to their personal Connected Machine. Record the click as consent for the current logical turn, retain it across replacement attempts, and recheck ownership and access before each operation without exposing other personal machines or resources. Remove the obsolete busy-chat refusal.
- 5b10fc9: Opening a conversation reads each resource once, and reopening a recently viewed one draws at once.

  - Session, queue, lineage, goal and human-input reads now report the session sequence they reflect (`X-OpenGeni-Session-Sequence`), so the shared event feed's opening burst no longer re-reads what the first read already covers. Opening one conversation drops from 11 requests (16 inside `OpenGeniProvider`) to 7 (8 with the provider's contract check). Older servers that do not send the header keep the previous refresh behaviour.
  - `OpenGeniProvider` no longer runs its reconnect repair on the first open of a conversation; reconnects still repair every view.
  - When the host retains reads (`OpenGeniProvider retainReadsAcrossMounts` or the new `useRetainedReads(client)`), reopening a conversation draws its last timeline, details, queue, goal, lineage and open questions from memory on the first render and refreshes behind it, with no spinner. Retained conversations are kept in memory only, per client object, within the event-browser byte budget; the composer draft is always read fresh.
  - Workspace-scoped client config reads join one request per client and workspace (`readClientConfig`).

- b99865a: Fewer duplicate requests when a conversation starts. Mounted readers of one workspace's model catalog (the conversation and the new-chat composer) now share one catalog and config request, `useAvailableModels` readers share one config request, and the provider's API-contract check joins the deployment config read the conversation is already making instead of sending its own.
- a5a5500: A chat whose model was retired or removed now explains that the model is no longer available and that another model must be chosen, instead of failing its turn with "Activity task failed".
- Updated dependencies [2f6b8bd]
- Updated dependencies [f010292]
- Updated dependencies [9fb9db3]
- Updated dependencies [79ec9fd]
- Updated dependencies [6ab7b55]
- Updated dependencies [a22ed79]
- Updated dependencies [5b10fc9]
- Updated dependencies [e2e75c0]
- Updated dependencies [24b346d]
  - @opengeni/sdk@4.0.0
  - @opengeni/artifact-tool@4.0.0
  - @opengeni/connect@4.0.0

## 3.4.0

### Minor Changes

- c594c1d: The session list can show only your workstreams. `mineOnly=true` (with `view=page`; SDK `listSessionPage`/`listSessionSummaryPage` `mineOnly`, React `useWorkspaceSessions` `mineOnly`) keeps a workstream when any session in its tree was created by you or received a message you sent directly; agent-relayed messages and service turns do not count. Matching roots list their children in full, totals follow the filter, and the response echoes `mineOnly: true`. The web sidebar's view menu adds an "Only mine" option. A new online index (`session_turns_human_prompt_subject_idx`, built concurrently in rolling migration 0799) keeps the probe to one index lookup per tree session.

### Patch Changes

- Updated dependencies [28844d8]
- Updated dependencies [ceaf911]
- Updated dependencies [60191f6]
- Updated dependencies [c594c1d]
- Updated dependencies [7998676]
- Updated dependencies [7998676]
  - @opengeni/sdk@3.4.0
  - @opengeni/connect@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies [38ac98e]
  - @opengeni/sdk@3.3.0
  - @opengeni/connect@3.3.0

## 3.2.2

### Patch Changes

- c30cf85: Mark expanded Site headers so the desktop app can keep Back and other actions clear of native window controls without changing inline or browser viewers.
- Updated dependencies [a0c35a1]
  - @opengeni/sdk@3.2.0
  - @opengeni/connect@3.2.0

## 3.1.2

### Patch Changes

- 9f92b60: `markClassicScrollbars` is also available from the small `@opengeni/react/scrollbars` entry point, so an app can mark its document before the first paint without loading the rest of the package.
- e332bc1: A turn no longer fails for good when an image sent earlier in the conversation is briefly unreadable from object storage, for example while a storage replica catches up after an outage. The same turn now retries with the usual short backoff, shows "An image from earlier in this conversation can't be read from storage" while it waits, and sends the same pixels once the image is readable. Bytes that no longer match the stored checksum still fail the turn, because retrying cannot fix them.
- 86df483: Streamed text deltas are now merged when they are written instead of folded afterwards. The turn writer flushes model fragments at most 100 ms apart, sends the first fragment of each item at once, and stores each flush's adjacent plain text fragments as one `session_events` row, so a stream writes about a fifth of the rows it used to and nothing is deleted later. The settled-turn folding pass and its `foldSessionTurnDeltas`, `listSessionDeltaFoldCandidates` and `unfoldSessionEventDeltas` helpers are removed; rows folded by earlier versions stay readable through `coalescedUntil`.

  Reasoning summary parts keep their paragraph breaks wherever fragments are merged: `@opengeni/events` exports `reasoningDeltaSeparator`, and the read-side coalescer now uses it, so consecutive bold headings no longer render glued together after a reload.

- Updated dependencies [17d61c6]
- Updated dependencies [74a259d]
  - @opengeni/sdk@3.1.0
  - @opengeni/connect@3.1.0

## 3.0.0

### Major Changes

- 6339cec: Published Site limits now follow the viewer. Workspace members have no Site caps, only the flood brakes, and keep the embedded agent even when it is off for everyone else. Invited and signed-in people share one Site spend limit ($10 a month by default, or a daily limit) with an optional per-person limit; guests also meet the bot guards (20 conversations per visitor per day, 500 per Site per day, 50 turns and $1 per conversation). Workspace tools reach only members who may use connections, and outsiders never get a subscription-billed model: they use the workspace's credit-billed default or are refused. Sites also meter platform usage (gateway requests, Site SQL rows read and written, stored bytes) against a monthly workspace allowance with overage prices, in `usage_only`, `shadow` or `credits` billing mode, and a deployment-wide monthly spend brake an operator can lift with `scripts/operator/site-platform-brake.ts`. Managers see what each audience can use, readiness warnings with one-click fixes and a View as visitor preview; Site code reads `site.capabilities`. The SDK adds `applySitePublicationFix` and `getSitePlatformUsage`, and agents get `site_publication_apply_fix`.

  Breaking: `agent.guestTools` is accepted but ignored. On published hosts, `not_available_for_viewer` (with the feature name) replaces `site_agents_unavailable`, `site_tools_unavailable` and audience-only Site Data and Site SQL forbidden errors. `details.legacyCode` retains the earlier code for migration; clients must explicitly adopt the new code or read that alias. Ownership refusals keep their own code. `effectiveLimits` now describes non-member limits, never a member's budget. The `free` profile is now `standard` (`free` remains an accepted alias). Limits follow the viewer. These immediate user-directed semantic changes are recorded in the API compatibility exception log, not claimed as a 90-day transition or security exception.

  Migration 0790 adds platform metering, spend windows and verified conversation viewer emails. Migration 0791 is a no-write compatibility checkpoint: legacy stored kinds and overrides stay readable by old releases, with no locked backfill. New writers store standard as free. Request-time normalization ignores old-free defaults in unmarked custom overrides and preserves other owner values; new explicit overrides carry an internal version marker so intentional old-default values are preserved. Existing Sites and old-pod writes pick up the new defaults without republishing. See `docs/published-sites.md` for the exact values and compatibility mapping.

  Members receive no Site budget or session usage-limit stamp. Every published-host conversation gets its own Site Data tools, viewer-bound Site SQL named queries when enabled, and member-only read-only SQL, never management tools. Site agents have no sandbox; publication settings expose no sandbox opt-in. Console-frame tools are narrowed per tool name. Non-member models are explicit and existing subscription conversations are refused. A configurable $0.25 per-turn reservation avoids consuming entire conversation caps; reservation contention returns retryable 429 `site_budget_busy`. React renders audience, budget and platform-brake refusals inline.

  Migration 0790 also adds nullable pending-admission tokens. Funding stays reserved across dispatch, and enqueue transactions verify the token. Crash/unknown-outcome recovery revokes delayed requests and reconciles the locked canonical queue before refunding; neither an idle label nor a timeout can double-allocate funds.

  Keyed Site Start retries also repair sessions whose shell committed but whose first turn did not. Repair reuses the original prompt/model, acquires fresh funding without duplicating conversation or turn counts, and invokes the existing core initialization path.

  Platform usage excludes model spend and defaults to metering only. Site SQL has no monthly row quotas by default and 5 GiB storage per Site. Publishing can return 402 `site_platform_quota_exhausted` only in credits mode and 503 `site_platform_brake_engaged` while the global brake is engaged. The `OPENGENI_SITES_FREE_*` agent settings are deprecated fallbacks for `OPENGENI_SITES_AGENT_*` and `OPENGENI_SITES_GUEST_*` settings.

### Minor Changes

- db3efc5: Sites can now be published to the web. A Site's owner or a workspace admin can give it its own address under the deployment's Sites domain (for example `team-crm-4k9x.opengeni.site`) and choose who can open it: workspace members, invited people who sign in with their email, or anyone, with anonymous visitors as guests. Published Sites keep their Site Data and embedded agent, but their direct tool calls return 403 (tools need a person's session in the console), and only a workspace admin can give the embedded agent workspace tools (guests get them only with `agent.guestTools`). Site code reads the viewer with `site.viewer` and starts sign-in with `site.auth.signIn()`, and no Opengeni credential reaches the Site. Collections gain a guest rule (`none`, `read`, `append`, `own`). Embedded agent use is paid by the organization under a limit profile (free, credits, unlimited or custom) per workspace and per Site. Visitors can report a Site, and managers can take it down and restore it. Breaking: Site HTTP is limited to an explicit operation allowlist (`SITE_OPERATIONS`) in every host, so a console Site that called other API routes through the bridge is now refused; an agent started from a Site page may send workspace API writes only to its tools, its conversations, files and content, and other writes return 403. The SDK adds `getSitePublication`, `updateSitePublication`, `unpublishSite`, `checkSiteHostname`, `takeDownSite`, `restoreSite`, `listSiteAbuseReports`, `updateSiteAbuseReport`, `getSiteLimitProfile`, `updateSiteLimitProfile` and `authorizeSiteViewer`; `ArtifactSandbox` and `SiteView` accept a `viewer`; agents get `site_publication_get`, `site_publication_update` and `site_hostname_check`. Publishing is off until `OPENGENI_SITES_DOMAIN` is set.

### Patch Changes

- 99ab991: Distinguish scheduled runs skipped because their chat is paused from busy-chat overlap, and show the reason and recovery action on the schedule. Explain explicit model-account pins that are turned off for allocation instead of presenting them as temporary quota waits. Reclassification of an existing capacity waiter appends a new, deduplicated status event without changing earlier context, resuming paused work, or replacing an account pin.
- be83e73: Links in an agent's question are now clickable, both on the pending question card and in the answered question in the timeline. Bare `http(s)` URLs in a question's title, prompt and help text open in a new tab, and long URLs or tokens wrap inside the card instead of running past its edge.
- 1c1aa30: Show a turn that must compact its context before its first model request as a calm "Compacting conversation first" step instead of a red "Runtime/model preparation failed" row. The worker records that step as an expected transition, then reopens model preparation for the retried request so its real dispatch is recorded and timed on its own. Compaction raised at stream entry no longer leaves a duplicate running preparation row. Earlier session events are unchanged.
- 2077293: When an agent switches to or runs on someone's personal (Only me) machine that the chat is not allowed to use, the swap now returns a typed refusal (`personal_machine_permission_required` or `personal_machine_not_permitted`) with a plain reason saying how the owner can allow it, and leaves the chat's route unchanged. Previously the tool failed with a raw database error. One-off `run_on` calls give the same reason.
- bfa1754: Import the `SiteViewer` type from `@opengeni/sdk` in the Site view and artifact sandbox, so the published type declarations reference only declared dependencies.
- f7abc0b: Images returned by any tool, such as an integration's capture tool, are now kept the same way as viewed images and screenshots: stored once in object storage with a compact reference in session history, instead of base64 inside each history row. The timeline shows them as images, and the model receives the same image bytes, in the same form, as before. Each image in a result is stored separately, and an image that cannot be stored stays inline exactly as today. Only new tool results change; existing history is untouched. Stored tool images follow the existing screenshot retention period and workspace quota.
- Updated dependencies [9a15dda]
- Updated dependencies [664368a]
- Updated dependencies [2077293]
- Updated dependencies [db3efc5]
- Updated dependencies [957f6ee]
- Updated dependencies [6339cec]
- Updated dependencies [37169cd]
  - @opengeni/sdk@3.0.0
  - @opengeni/artifact-tool@3.0.0
  - @opengeni/connect@3.0.0

## 2.0.1

### Patch Changes

- Updated dependencies [e8d18da]
  - @opengeni/sdk@2.0.1
  - @opengeni/connect@2.0.1

## 2.0.0

### Major Changes

- 945c247: Variable Sets are replaced by vaults. Secrets live as items with fields in vaults owned by a task, a person ("Only me"), a workspace or the organization, and agents use them through `{{secret:Vault/Item/field}}` references that resolve when a tool, command or browser action runs. Existing Variable Sets were migrated to vaults with the same ids and values.

  Removed: the `/variable-sets` and `/environments` routes (now 410 `variable_sets_removed`), `PUT /sessions/:sessionId/variable-sets`, the `variableSetIds`/`variableSetId`/`environmentId` request fields on sessions, forks, drafts and schedules and `defaultVariableSetIds` on rigs (now 422 when they carry a value), `OpenGeniClient` `listVariableSets`, `resolveVariableSetAttachments`, `createVariableSet`, `getVariableSet`, `getVariableSetVariable`, `updateVariableSet`, `deleteVariableSet`, `setVariableSetVariable`, `deleteVariableSetVariable`, `updateSessionVariableSets` and the deprecated `*Environment*` aliases, their types, and React `useVariableSets`/`useEnvironments`.

  Added: `client.vaults(workspaceId)` (vault, item, field-history, reveal, session vault policy and 1Password routes), the vault wire types, `vaultErrorCode`/`vaultErrorDetail`, `vaultPolicy` on session create and schedules, and React `useVaults`, `useVault`, `useVaultItems`, `useVaultItem`, `useVaultFieldVersions`, `useSessionSecrets` and `useVaultsApi`. Read fields that carried the old selection (`variableSetIds`, `variableSetId`, `environmentId`, `defaultVariableSetIds`) remain on responses as inert, deprecated legacy data.

  This removal ships in SDK 2.0.0 without the usual 90-day deprecation window, as an explicit exception to the API compatibility policy.

### Minor Changes

- c69d74d: The lightbox can page through chat images. Register an element's image with `useLightboxGalleryItem(ref, entry)`; an open lightbox then shows previous/next controls, arrow-key navigation and an "N of M" counter across registered images in the same timeline, resolving each image only when it is shown.
- c08dfcd: Connector tool rows read short. A connector tool call now shows the connector's logo (when the host passes `resolveProviderLogo`, otherwise the usual icon) and a short label such as "List issues · Done". The account is named only when the connector has more than one account in the turn ("Get issue · kari@example.com"); approval cards say "Linear" or "Linear · kari@example.com" instead of the full route label. Tool display metadata gains optional `connector` and `providerDomain` fields, and older events with the long route label show just the tool name. The model still gets the full account description.
- 3822e5f: Turning Opengeni credits off in a workspace (`allowCreditModels: false`) now stops every credit meter, not only credit-billed models. Paid web search and web fetch are no longer offered to the agent (a call already offered is refused with a message that names the switch), knowledge search falls back to keyword results (`fallbackReason: "credits_disabled"`; `mode: "vector"` returns 403), and paid knowledge indexing waits without calling the embedding provider and resumes when credits are turned back on. The model catalog reports a credit model blocked only by the switch with the new availability reason `credits_disabled`, which the React picker labels "Opengeni credits off". Both enum values are additive; clients that do not know them keep their existing fallback.
- 8017d94: Embedded chats no longer carry Opengeni's own defaults into your product. In `SessionConversation` and `OpenGeniChat`, live voice is now opt-in (`realtimeVoice={true}`, or `createSessionProxyHandler({ realtimeVoice: true })`, which now reports `realtimeVoice: true` in the client config), so a call never spends credits or asks for the microphone unless you turn it on. The working indicator says "Thinking…" instead of the console's playful phrases; the new `genieLoading` prop sets your own copy or visual. The session proxy accepts `visitor: true` from `resolve` for anonymous visitors: they get no attach button and their uploads are refused unless the handler sets `visitorUploads: true`. A proxy with `files: false` now also reports uploads off, so the stock composer hides the attach button it could not serve. Explicit `realtimeVoice`, `attachments`, and `files` settings keep working; the Opengeni web app is unchanged.
- c13d080: Add canonical sparse row-height and column-width set/reset commands with live
  spreadsheet projections and immediate, frame-coalesced drag and keyboard
  resizing. Preserve existing dimension-free artifacts and shared artifact
  authority, collaboration, and history.

  Preserve sparse dimensions through native workbook reconciliation and verified
  XLSX materialization, including empty-sheet geometry. Refresh all modality
  kernel distributions together to retain their shared build identity.

  Keep spreadsheet input responsive during delayed saves, retain pending cell
  drafts when refocused, surface independent failures without unsafe overlapping
  retries, and show server sync state separately from local command acceptance.

  Center resize targets on header borders and retain valid covered cells while
  viewport queries change. Show submitted cell input immediately without inventing
  formula results. Support canonical worksheet renaming by double-click or F2,
  with validated Enter/Save, Escape/Cancel, and readable pending/failure feedback.

- 945490f: A connected machine can switch between This workspace and Only me in place, keeping its enrollment, sandbox id, credentials and live connection, so chats, schedules and the installed agent are not registered again. The Machines page gains **Who can use it?**, a dialog that summarizes what one confirmation does, backed by `POST .../machines/:enrollmentId/audience/preview` and `PUT .../machines/:enrollmentId/audience` (`previewMachineAudience` and `changeMachineAudience` in the SDK). Narrowing applies everything in one transaction: the owner's chats stay (shared ones stay shared, usable only by the owner) and their running attempts are re-authorized; other people's chats move off; turns that may no longer use the machine end as cancelled through the terminal `authority_change` interruption; the owner's Workspace schedules on it become Only me (or pause) and other schedules pause; and each affected person gets one inbox notice. Only a second live connection of the same computer blocks the switch. The worker reads the machine's current audience on every operation, so running sessions follow the change without a rebuild and the agent needs no restart or upgrade.
- 0c763f2: Show who sent a message in shared chats. User message items now carry the sender recorded with the message, and `MessageTimeline` (and `SessionConversation` timeline props) accept `renderMessageSender` to draw a small label above the bubble. Nothing is drawn unless the host supplies it, so embedders that have no identity for their users, or do not want attribution, see no change. `MessageSenderLabel` renders an avatar or initials with a name. The web app names other members' messages and leaves your own unlabeled.
- 35fb6fd: Add `useSessionModelAccount`, a provider-neutral hook for a session's model account: the shared accounts and the caller's own personal accounts it may use, choosing one (or automatic selection), and the caller's personal-fallback opt-in. The web app's session header shows the matching account menu for subscription models on the shared subscription core; Codex keeps its existing menu for now.

  Provider-qualified choices and Automatic preserve other providers' bindings. The menu shows stored usage without duplicating the selected account's top summary. Personal fallback is configured separately in Models settings, not in the account dropdown. `ModelPolicyPicker` supports model-identity-only policies with `allowModelOptions={false}`.

- e7f6a53: Native chat media at web parity. `@opengeni/react-native/timeline/previews` adds `createNativePreviewRenderers`: retained-file images load inline (tap for a zoomable full-screen view), and `opengeni-html` / `opengeni-site` previews render in a sandboxed web view sized to their content, with the web's animated "Preparing preview…" surface while the assistant is still writing them, plus incomplete and error states. `createWebMarkdownRenderer` gains `renderImage` and `renderInteractiveBlock`, plain image URLs load, and wide tables scroll sideways with an edge hint. `@opengeni/react/native-previews` exposes the DOM-free pieces (`inlineHtmlDocument`, `previewLoadingDocument`, `loadSiteSnapshot`, `paintPreviewLoading`).
- 412671a: Connect a machine just for yourself. `mintEnrollToken(workspaceId, { scope: "user" })` mints a one-machine command whose machine only the signed-in person can use, in every workspace they can open; `scope: "workspace"` (the default) shares it with the workspace as before. Only a verified person can mint a personal command: someone signed in, or a credential acting as them (a personal API key, or an organization key acting `asUser`). A key, service or agent acting as itself gets `422`. The owner is always the caller, the command is single-use, and the machine is created only if that person is still a member when the command runs. A personal machine reconnects only from the workspace it was first connected from; elsewhere the command answers `409` and changes nothing. The response now says which `scope` and `allowScreenControl` it granted; an older server omits `scope` and mints a workspace command, so check it before showing a personal command. Machine cards label access as "Only me", "Workspace" or "Organization" (`machineScopeLabel`). In the web app, the Machines page and the chat's machine card share one Connect a machine dialog: choose who can use it (Only me by default), screen control (off by default) and Mac, Linux or Windows, copy one command, and the same dialog confirms the connected machine, with Use in this chat from a conversation.
- 63bf721: Prepare a complete personal or workspace MCP connection once, with non-secret headers and protected secret-field mappings. People enter only the missing key in the conversation card; authorized agents that already have credentials use the same native Connect verification and storage lifecycle without another confirmation card.

  Connection, installation and receipt writes are atomic. Exact retries do not repeat verification or create duplicate accounts. The agent path intersects frozen attempt permissions with live ownership, selection, policy and execution fences, and never makes new tools available inside an already accepted attempt. Existing OAuth and explicit account selections remain separate and unchanged.

  Deploy matching API and worker packages before using direct agent setup. Historical attempt catalogs without the frozen permission snapshot do not gain new setup authority.

- 945c247: Human-input cards answer `kind: "secret"` questions. The field is an uncontrolled password input read only at submit, so the value never enters React state, props or storage, and it is cleared after a successful submit and on unmount. It pairs an optional username with the password for password managers, sets `autocomplete` from the spec (`new-password` when Generate is allowed, `one-time-code` with a numeric keyboard for one-time codes), offers show/hide and Generate (filled in the browser with a `SecretsUiProvider` generator, otherwise generated by the server with Undo), shows the `looksLike` hint and a soft, non-blocking pattern warning, and has a Save to select (Only me, This task, This workspace). New `allowedSaveTo` prop on `HumanInputForm` and `HumanInputSurface`: a requested target outside it falls back to the most private allowed one with a note. Submit sends `secretAnswers` next to `answers`. Answered secret questions show "Saved to <vault> › <item>", never a value. Secret references (`{{secret:…}}`, `{{secretfile:…}}`) render as chips in Markdown prose and whole-reference inline code (never in fenced code or links), tool payloads and commands, tool row titles and approval review fields, when a `SecretsUiProvider` is mounted; malformed references stay plain text. New exports `SecretRefChip`, `SecretRefText`, `SecretAnswerChip` and `secretReferenceLabel`, and `SecretsUiProvider` from `@opengeni/react/session-ui`.
- cb9e426: Secrets: every vault row opens again, and 1Password connections are manageable.

  - Fixed vault, item and connection rows that only opened when their title or timestamp was clicked. A page-wide hit-area rule on the Secrets pages covered each row's full-width click target.
  - Connect 1Password is a visible button on Secrets. The flow asks who can use the connection first (Only me, This workspace or the organization), links to 1Password's guide for creating a service account, and names plans in plain words.
  - Settings › Secrets lists 1Password connections with their owner, linked vaults and any token or sync problem. A connection's page links more vaults, replaces the token in place (linked vaults keep working) and disconnects it (unlinks its vaults; nothing is deleted in 1Password). A vault's Replace token action now updates its connection instead of creating a second one.
  - Vaults are grouped by who can use them; a vault linked from 1Password shows which account it comes from and links to it.
  - New API routes `GET /connections/1password/service-accounts`, `PUT /connections/:connectionId/1password/token` and `DELETE /connections/:connectionId/1password`, with SDK methods `listOnePasswordConnections`, `replaceOnePasswordToken` and `disconnectOnePassword`.

- 11779ba: Render per-task usage limits. The timeline shows a `session_usage_limit` stop as a neutral "Usage limit reached" row, a goal paused at the limit explains how to continue, and a refused Send keeps the draft without offering Retry. New exports: `SessionUsageLimitNotice`, `summarizeSessionUsageLimit` and related labels from `@opengeni/react/usage`.
- 844c089: Sites can now save data. Every published Site gets persistent collections of JSON records and files that survive new versions: Site code uses `site.data` (list, get, insert, put, patch with conflict detection, delete, increment, count, batch) and `site.files` (upload, list, url, delete) from `createOpenGeniSiteClient()`, with no credentials in the Site. Each collection's access mode decides what viewers may do (shared, shared read, per viewer, append only), enforced by the server; the Site page itself always acts as a viewer, and an Only me Site's data stays its owner's. Agents and scheduled tasks manage data with new `site_data_*` and `site_files_*` tools, and the Site page has a Data tab for the people who manage the Site. Quotas, write limits, per-Site and per-workspace limits on schema-checking time, and usage metering (usage only, no charge yet) apply. Hosts opt in by giving `createSiteToolBridge` a pinned Site and `fetchResponse`; older hosts report `site_data_unsupported`.
- 7f3f19f: Expose the stock new-conversation controller and view used by `OpenGeniChat`.
  Keep uncertain retries tied to their original creation, preserve newer text,
  files and model choices through native draft handoff, and support opt-in
  voice-first creation without a synthetic prompt. The session proxy preserves
  browser creation idempotency keys unless its server hook supplies its own.
  Simple embeds continue to use the same one-component API.
- ef1f78d: Subscription accounts and their usage limits no longer have to reload from scratch every time you come back to them. `useCodexAccounts` and `useSuperGrokAccounts` now share reads per `client` object: readers mounted at the same time share one request, failed reads are never served as cached data, and a pin or activation re-reads every mounted list for that workspace even when the component that made it has unmounted. New `OpenGeniProvider` prop `retainReadsAcrossMounts` (default off) keeps those reads across navigation, so a remount renders the last accounts at once and re-reads them in the background; retained reads are dropped when `client` changes or the provider unmounts. Without it nothing is served to a later mount. **Host action item:** set `retainReadsAcrossMounts` only if every signed-in person gets their own `client` object; leave it off when one client is reused across people. `useCodexAccounts().refreshUsage({ maxAgeMs })` reuses live usage readings only when every listed account was read within `maxAgeMs` and shares one provider read between concurrent callers, and the result exposes `liveUsageUpdatedAt` (the oldest account reading). No new exports.
- 27db84b: Timeline rows for spawning an agent, messaging one, and every update one sends back now name the agent and link to its session. Agent updates inside a delivery pill render as named rows with a two-line preview and the full text on expand, and the pill says who sent them ("Update from API audit", "3 updates from API audit and Docs"). Repeated progress notes from one agent fold into its latest note. A child result still reads "Result from …", never "finished". `MessageTimeline` and `SessionConversation` accept `resolveSessionTitle` for current titles; without it, rows use the title given at spawn, then the generic labels.
- a91718c: Workspaces can turn off Opengeni-credit models in one step. The workspace setting `allowCreditModels: false` (`PATCH /v1/workspaces/:id/settings`, SDK `updateWorkspaceSettings`) blocks every model billed in Opengeni credits, including credit models added to the catalog later. The allowlist stays as it is, whether the workspace has its own or follows its organization's. Session creation, messages, schedules, goals, child agents and the omitted-model default all honor it, and so do credit-funded live voice and voice input (where credits are billed; voice input falls back to a connected subscription) and managed video generation. Paid web search and knowledge embeddings are not affected. The model-policy responses report it as `allowCreditModels`; saving or removing an allowlist never changes it. The React live-voice control labels a model refused for this reason "Credits off".

### Patch Changes

- 04ebc42: A session whose next turn the runtime refused to start (an admission block, such as a rejected database claim) no longer reads as "Waiting on you" with nothing to answer. It now reads as "Stuck" in the session header, lists, hover details, sub-agent rows and the timeline divider, on the web and in the native app. The web session notice is titled "Stuck" and, for a rejected claim, says nothing is needed from the person. The native session screen shows a matching card with a Try again action (Resume), and its composer offers Send instead of Stop while the session is stuck. Session list entries now carry `admissionBlock`, and the SDK's `Session` type gains the optional `admissionBlock`. New helpers `sessionDisplayStatus` and `sessionAdmissionBlocked` return the display status `blocked`, and the native timeline messages gain `stuckTitle`, `stuckBody`, `stuckAccessBody`, `stuckRetry` and `stuckRetryFailed` for hosts that swap copy.
- 14a9340: A person's question asked while the agent is working or waiting always gets a visible answer. `wait_for_input` is refused (as a tool error, at most twice per turn attempt; a resumed or retried attempt starts again, and the check fails open if it cannot decide) when the turn answers a person's message and the agent has not written any visible reply yet, so a status drafted only in reasoning is written out before the turn yields. `prepareAgentTools` accepts the new `inputWaitReplyGuard` option for this check.

  In the timeline, a reply the agent wrote before more tool work and a wait stays visible after the "Worked for" row instead of folding into it: a turn that answers a person and ends with only progress notes keeps its first and last message visible, and the notes between them still fold.

- d4c17b3: Automatic agent updates no longer close open browsers. Agents before 0.1.58 close every managed browser when they restart, so the automatic updater now leaves such a machine on its current agent while it still has a managed browser that may be open, and looks again on the usual busy backoff. The machine card shows "Update to vX postponed: open browsers would close" and notes that updating by hand closes them; "Update now" still works. Agents from 0.1.58 on keep their browsers across a restart and are updated as before.
- d8a4e8e: The browser viewer no longer loops on ending a lost attached-device browser. A refusal (4xx) is not retried, and transient failures retry at most three times with backoff; previously a 409 was re-sent on every registry refresh, about one request per second.
- f36484a: Let slow browser inventory reads finish when refresh events arrive. Combine pending refreshes into a trailing read, while still canceling obsolete reads when the workspace, client, or enabled state changes.
- 5f8d2e2: A turn blocked on model subscription capacity now reads "Limit reached" on its work row, with one quiet line saying it continues automatically, instead of a long separate warning. Once the turn resumes or settles the warning is gone, and "Worked for" no longer counts the time spent waiting for capacity. The `waiting_capacity` session status label is now "Limit reached". Waits that need a person (an ineligible pinned account, a disallowed model, accounts disabled for allocation, or an account that needs reconnecting) keep their recorded reason.
- dfee983: Show fallback text for Codex capacity waits when optional detail text is absent or empty, instead of rendering a blank notice.
- 561c701: Chat messages now show a single newline as a line break, so an agent reply written on three lines (1, 2, 3) shows three lines instead of "1 2 3", the same as ChatGPT or GitHub comments. This applies to agent replies, progress notes, and your own messages in the Opengeni web app and in embeds that use the default `MessageTimeline` renderer. Code blocks, lists, tables, quotes, and headings render as before. Custom renderers can opt in with the new `softLineBreaks` prop on `Markdown`.
- 7f2446f: The session workspace dock no longer polls the machine fleet for viewers who cannot read it. `<SandboxWorkspace>` and `useSandboxWorkspaceTabs` accept `machinesEnabled` (default `true`); Opengeni's web app passes the viewer's `enrollments:read` grant. A 401, 403, or 404 from the fleet read now stops the 15-second poll until the read is disabled and re-enabled or explicitly refreshed. In the web app, Organization → Billing reads workspace budgets four workspaces at a time and requests this month's usage only for workspaces the viewer belongs to, and a refused Add people candidate list is not requested again when the page remounts.
- 4532435: Codex Apps keeps working when a workspace routes models through its organization's Codex accounts. The workspace's designated Apps account now loads, and its token refreshes persist, through the Apps designation itself instead of the model-routing pool; that authority still reaches only the designated account, owned by this workspace and its current owner. Turning Apps off (`DELETE /v1/workspaces/:workspaceId/codex/apps`) now works in every routing mode, so `apps.canDisable` is accurate.

  Apps no longer posts an authorization card every time it sets up a turn. A card appears only when an Apps tool call needs one, at most once per turn, and an unusable designated account is reported with the new `tool.auth_needed` reason `designated_credential_unavailable` instead of `refresh_failed`. Clients should treat unknown reasons generically, as before.

- 4f18b7e: Preserve bounded first input while an explicitly PTY-capable cold terminal acquires its viewer grant, then deliver it once at the existing negotiated readiness boundary. Plain SSE and transport downgrade fences remain unchanged.
- c960696: Long orchestration runs no longer stack identical "Agent update / Worked for / Waited" rows. Two or more consecutive quiet cycles (routine input, work without a visible reply, a finished wait) fold into one row such as "8 updates over 5h 54m · 30 steps", with the latest wait reason under it on the web. Expanding it shows the original rows unchanged. Visible replies, people's messages and the turns they open, failed turns, approvals, live work and the current wait are never folded.
- c9f2c11: A context compaction cut short by its own attempt's cancellation (for example a turn worker draining during a deploy) is no longer reported as a summarization failure. The worker records `session.context.compaction.skipped` with `reason: "interrupted"`, keeps any explicit `/compact` request pending for the recovered attempt, and lets the cancellation recover the same turn as before. The timeline shows "Compaction interrupted" with retry copy instead of "Couldn't compact conversation history".
- dc38882: Focus rings on the compaction Details toggle and the image lightbox keep a visible outline in forced-colors mode, and the precompiled stylesheet no longer ships unused utilities generated from code comments and sandboxed visualization CSS.
- fb298ad: A failed context compaction now appears once, on its timeline landmark: "Couldn’t compact conversation history" with one short recovery step and a single Details control (the provider response, rejected parameter and request ID, or the recorded error text when there is no provider rejection). The failed turn chip names the outcome instead of the raw provider text, no separate notice repeats the failure, and the landmark no longer overflows the timeline. `ContextCompactionItem` gains an optional `failureDetail` with the same turn's recorded failure text.
- 64c4dd3: The default model picker in `SessionConversation` now disables other providers' models in a session locked to Codex remote compaction, as the API refuses them there, instead of offering them.
- 285968f: A GitHub organization member who isn't an owner now gets a clear path instead of a dead end. Opengeni explains that an organization owner must approve and lets them send the request through GitHub. Afterward they see a calm "Waiting for your GitHub organization owner" state, and the GitHub card updates on its own once an owner connects the organization. An organization owner who approves on GitHub lands on a page explaining the one remaining step instead of an expired-link error. Published `.patch` and `.diff` files now have a "Copy command to apply these changes" button. It copies one `curl … | git apply` command that uses the existing short-lived authenticated download link, which expires in 5 minutes. `ConnectSetup` shows the owner-approval state, and `RetainedArtifactLoader` accepts an optional `{ prefer: "url" }`.
- 121f6ed: A new chat without a goal no longer logs failed `GET .../goal` 404s in the browser console. `GET /v1/workspaces/:workspaceId/sessions/:sessionId/goal?absent=null` answers 200 `null` for a goal-less session (without the opt-in the 404 is unchanged, and a missing session is always 404). The SDK adds `findGoal`, which sends the opt-in and resolves `null`; the session proxy forwards it. `useGoal` reads through `findGoal` when the client has it (falling back to `getGoal` and its absorbed 404 otherwise), and no longer re-reads a goal-less session when the stream's opening events race the first read, so an embedded Opengeni chat makes one successful goal read per new chat. A goal set later still arrives through its `goal.*` event.
- f3aa7f2: `recentSessionsForHome` now lists only top-level conversations, so sub-agent sessions no longer push your own recent work off the home screen.
- 5baab79: Stop Modal boxes that only an unused browser or desktop keeps warm. After the general sandbox idle grace without use (agent tool calls, a person's input, or a visible live view's heartbeat), a saveable browser is checkpointed and suspended, other browsers and desktops are released as `idle_released`, and the box saves `/workspace` and stops. Saved browsers resume on demand, also when the desktop they were shown in has stopped.
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
- ea7428d: Machine cards and the machine page now describe the agent in plain words and never contradict the health badge. A second agent process refused days ago is quiet history on the machine page instead of a red banner; only one being kept out right now shows a calm heads-up. An update postponed because the machine was busy reads as postponed with an "Update now" action, a failed update to the version already installed is not shown at all, and real failures say why and offer "Try again" only when it can help. The machine page gains an Agent panel with the build, the update action and the connection.
- da01634: Add a provider-neutral explicit model-account choice for sessions and a person's own personal-fallback opt-in. `GET`/`PUT /v1/workspaces/{workspaceId}/sessions/{sessionId}/model-account` lists the workspace's shared accounts and the caller's own personal accounts with whether each can be chosen, and sets or clears an explicit choice; the database still decides, so a personal account is accepted only for its owner's private session or Personal workspace while personal accounts are allowed. An ownerless session lists every account as not choosable (`session_has_no_owner`). `GET`/`PATCH /v1/organizations/{organizationId}/me/model-account-preferences` reads and changes only the caller's own opt-in; turning it on wakes waiting turns so they can fall back at once. The SDK gains `getSessionModelAccount`, `setSessionModelAccount`, `getModelAccountPreferences` and `updateModelAccountPreferences`. Rolling migration 0729 adds the owner's own access to their preferences row and nothing else. `isCodexAccountEvent` in `@opengeni/react` also matches `model_account.selection.changed`.
- 4cb80a9: Show Anthropic Opus, Sonnet and Haiku models without the redundant Claude word (`Opus 5.5`), since the maker mark already says Claude. Older names such as `Claude 3.5 Sonnet` and the Models settings pages are unchanged.
- 9a78a48: The native app shows and changes the person's pinned chats, the same personal pins as the web. The sessions list has a Pinned section above the projects, the home list shows pins first as the web home does, and both load every pin through the pin-aware session page. A long press on a row (or its accessibility action) pins or unpins it: the row moves at once and the server's answer settles it. `SessionRow` and `SessionRowList` gain `onTogglePin`, and pinned rows show a small pin mark. `@opengeni/react` adds `applySessionPinToLists`, which moves a session between the pinned and ordinary lists and ignores pin answers older than the row shown. The native messages gain `pinned` and `pinFailed`.
- 38b1ba1: Use Opengeni in product copy and Slack manifest defaults, add a clearly labeled staging icon, and accept both current and historical Slack installation names without rewriting saved credentials or receipts. Expose the Opengeni chat facade while preserving the existing `OpenGeni` export and public identifiers.
- 6960770: Opper is a first-class model provider with the same three rails as OpenRouter and Vercel AI Gateway. `OPENGENI_OPPER_API_KEY` adds reviewed EU-pinned `opper/vertexai/gemini-3.8-flash-eu` and `opper/aws/claude-sonnet-4-6-eu` routes billed in Opengeni credits at the exact Opper-reported cost +5% (reviewed list price as fallback); workspace admins can connect their own Opper key (`workspace-opper/…`, billed to their Opper account) and add exact custom Opper ids; organization owners can connect Opper once for every shared workspace (`organization-opper/…`). The SDK adds `listWorkspaceOpperCustomModels`, `createWorkspaceOpperCustomModel`, `deleteWorkspaceOpperCustomModel`, `ModelConnectionAccessKind`, and `"opper"` as an organization model provider kind. Opper management keys (`op-mak-…`) are rejected with an explanation. Deployment catalog documents accept a reviewed `opperModels` list. Host `OPENGENI_MODEL_PROVIDERS_JSON` can no longer use the reserved `opper`, `workspace-opper`, or `organization-opper` provider ids; move a hand-written Opper registry entry to `OPENGENI_OPPER_API_KEY`. Rolling migration `0636_opper_model_providers.sql` widens the provider-kind, lifecycle-fact, and analytics allow-lists.
- 78c28ca: When a sandbox is gone, all of its background commands now settle at once. The reaper used to settle each retained command only after its own provider probe, at most 20 per 30-second sweep, so a box with 35 commands that Modal had already ended took 11 more minutes to clear while the session waited. The first probe that finds the exact current box missing now retires the whole box in one transaction: every command, open request, terminal and process holder is settled, the lease goes cold, and a turn waiting on the box is woken. Commands lost with their sandbox now tell the agent "`cmd` is no longer running because its sandbox was shut down or lost; whether it finished is unknown. Check its effects before running it again." instead of "result unavailable", and the session's Incoming panel shows several such results as one row with a single dismiss action.
- d6ea462: When a model provider is overloaded or unavailable, conversations now name the affected model and provider instead of reporting a generic "upstream dependency". While Opengeni retries the same turn, a live status above the composer reads, for example, "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock) — retrying (attempt 2 of 5)…". It replaces itself on each attempt and adds no timeline rows. If every retry fails, the turn ends with "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock). Opengeni retried 5 times without success. Try again in a few minutes, or switch to another model." The web app's failure banner keeps its Retry button and suggests the model picker. Recovery events gain the optional public fields `modelLabel`, `providerLabel`, `providerCondition` and `maxProviderRecoveryCount`. `@opengeni/react` exports `ProviderRecoveryNotice` and `currentProviderRecovery`, and `SessionConversation` shows the live status automatically. Retry pacing and the five-retry budget are unchanged.
- 5cb9c49: The collapsed queue chip in `SessionChrome` now shows the text of the latest queued message beside its Steer action, so a message sent while the agent is working is visible without opening the queue. That Steer now sends the message it shows (the latest) instead of the first in line. In the open queue list, every row keeps Steer visible; move, edit and delete still appear on hover.
- 588b90f: Preserve restored button and link focus when a composer becomes interactive after delayed draft hydration.
- 541a359: Keep the session-only conversation controller independent of the full provider and styled component graph.

  Preserve unavailable-chat feedback and custom labels when an older session proxy refuses new conversations.

- 2a19988: Buffer early ttyd terminal input until a supported sandbox's Bash Readline readiness signal. Keep old images explicitly legacy and offer a deliberate manual-input escape that clears buffered typing for startup prompts or unsupported shells. The guarantee requires the matching sandbox image; existing daemons are not restarted. Relay PTY behavior is unchanged.
- 8f02eb2: Links are now recognisable at rest. A new `og-link` utility gives text links a quiet resting underline tinted from the link's own colour, a full-ink underline on hover, and a focus outline, because the neutral grey palette cannot mark links by colour alone. Chat markdown links (web, artifact and sandbox file links), child-session links, usage-meter and viewer retry actions use it, and so do the web app's shared link primitives (`Button` link variant, help links, setting-row links, empty-state links) and inline text links across settings, capabilities, schedules and knowledge. The precompiled stylesheet ships the utility for hosts without Tailwind.
- 2fb5ec6: Record operator-retired child work as a visible, non-actionable parent timeline receipt, without waking the parent or creating pending execution input.
- b9ae380: A message that arrives while the session's sandbox is being replaced no longer sits behind a bare "Recovering". The live status above the composer now says "The sandbox reached its maximum lifetime, so Opengeni is moving the workspace to a fresh sandbox…" (or that the sandbox is being saved, recovered or moved, from the recorded transition) with "The turn continues automatically as soon as the sandbox is ready." It shows no retry counter, because this wait has no retry budget. `ProviderRecoveryFacts` gains an optional `sandboxWait` flag.
- 27287ee: Support an authenticated XLSX download action in the native spreadsheet editor, including embedded views, sync gating, progress, errors and cancellation.
- 615480c: A turn parked on a usage limit while a startup step is still running no longer shows a chevron that opens an empty fold. Running startup steps are hidden in the work row, so only failed or cancelled steps count as details to reveal.
- 2499dd2: A turn parked on a usage limit now reads "Usage limit reached" with the guidance "Try again after your quota resets, or switch to another model or provider." It no longer shows a running clock or promises that the work continues automatically. Waits that need a person (reconnect, disabled accounts, an ineligible pinned account) keep their recorded reason and are not labelled a limit; they also show no clock. A work row with nothing to reveal (for example a turn parked before any visible work) renders without a chevron and is not a disclosure control, and the wait guidance stays visible when the work is expanded. Approval and agent waits and the Working clock are unchanged. `TurnSummaryStatus` gains an optional `guidance` line and `TurnSummary` an optional `expandable` prop.
- Updated dependencies [04ebc42]
- Updated dependencies [e03f1ff]
- Updated dependencies [055015d]
- Updated dependencies [1ee99c1]
- Updated dependencies [1756cfe]
- Updated dependencies [40e2542]
- Updated dependencies [4532435]
- Updated dependencies [851cbdc]
- Updated dependencies [496ce55]
- Updated dependencies [c08dfcd]
- Updated dependencies [3822e5f]
- Updated dependencies [3962da3]
- Updated dependencies [c4dd318]
- Updated dependencies [8017d94]
- Updated dependencies [2be7683]
- Updated dependencies [121f6ed]
- Updated dependencies [5b4a738]
- Updated dependencies [334c470]
- Updated dependencies [96d7167]
- Updated dependencies [0c6f5c4]
- Updated dependencies [c13d080]
- Updated dependencies [810d1d9]
- Updated dependencies [8e7cb8d]
- Updated dependencies [945490f]
- Updated dependencies [4d8eb5e]
- Updated dependencies [8e878ac]
- Updated dependencies [9701372]
- Updated dependencies [da01634]
- Updated dependencies [ab3306a]
- Updated dependencies [eb68b58]
- Updated dependencies [38b1ba1]
- Updated dependencies [6960770]
- Updated dependencies [e125c0c]
- Updated dependencies [3426850]
- Updated dependencies [412671a]
- Updated dependencies [63bf721]
- Updated dependencies [3a4a435]
- Updated dependencies [14343e4]
- Updated dependencies [2b8ee21]
- Updated dependencies [945c247]
- Updated dependencies [6861501]
- Updated dependencies [a81a567]
- Updated dependencies [6861501]
- Updated dependencies [6861501]
- Updated dependencies [5441ac9]
- Updated dependencies [945c247]
- Updated dependencies [cb9e426]
- Updated dependencies [e8c3557]
- Updated dependencies [5cdfbaa]
- Updated dependencies [8cf9e0a]
- Updated dependencies [7852cda]
- Updated dependencies [726bdc1]
- Updated dependencies [11779ba]
- Updated dependencies [66b3026]
- Updated dependencies [844c089]
- Updated dependencies [a51c96e]
- Updated dependencies [7f3f19f]
- Updated dependencies [35fb6fd]
- Updated dependencies [35fb6fd]
- Updated dependencies [7bf1a02]
- Updated dependencies [a13bf1a]
- Updated dependencies [945c247]
- Updated dependencies [c676ae8]
- Updated dependencies [a91718c]
  - @opengeni/sdk@2.0.0
  - @opengeni/artifact-tool@2.0.0
  - @opengeni/connect@2.0.0

## 1.4.4

### Patch Changes

- 6384dbd: Keep browser actions on the selected tab when earlier receipts arrive after a source, tab, controller or document change. Discard prior source state before paint and capture immutable controller fences. Preserve immediate input from completed receipts for the same page without extra accessibility requests. Prevent earlier action deliveries from replacing newer settled observations or failures while returning each operation's result to its caller. Fence selection observations and errors to their exact invocation so a selection round trip cannot revive an obsolete view. Order selection observations with refresh reads while preserving current action outcomes.

  Prevent older tab-open and tab-close results from replacing later selections. Reconcile their inventory after pending selections settle without replacing the selected page's observation.

- 6384dbd: Preserve the current Desktop selection and generation when an action receipt arrives after a view or source change. Discard previous source state before paint, while retaining current observations during same-source refreshes. Keep explicit focus behavior and fresh fences for immediate sequential input. Prevent earlier action deliveries and their refreshes from replacing newer settled observations or control failures while returning each operation's result to its caller. Fence selection observations and errors to their exact invocation so a selection round trip cannot revive an obsolete view. Order selection observations with refresh reads while preserving current action outcomes.
- 6384dbd: Negotiate native desktop click continuation so viewers send the first click immediately and submit the real second click while its HTTP receipt is pending. Require the exact completed first operation plus one-use native delivery proof, preserve painted-frame coordinates and geometry, and reject failed, unknown, expired or unrelated continuations without replay. Later viewer input waits for both outcomes; Linux physical input serializes without queuing independent background AT-SPI actions. Background native mutation admission fences click proof through completion, cancellation and panic so overlapping work cannot restore authority.

  Keep bounded original Window keyboard/clipboard identities across read-only refreshes, with live object, process, geometry and focus revalidation. Preflight whole key batches before input, and reject Window pointer points covered by another X11 client. Preserve uncertain outcomes after any possible input delivery.

- 1405691: `OpenGeniChat` / `SessionList`: Rename and Archive are visible on touch devices. They were hover-only, so phone and tablet users of an embedded chat could not rename or archive a chat.
- Updated dependencies [6384dbd]
  - @opengeni/sdk@1.4.4
  - @opengeni/connect@1.4.4

## 1.4.3

### Patch Changes

- Updated dependencies [c0c0f74]
  - @opengeni/sdk@1.4.3
  - @opengeni/connect@1.4.3

## 1.4.2

### Patch Changes

- b9bd35f: Every `@opengeni/react` entry is now marked `"use client"`, so a Next.js App Router Server Component (for example `app/page.tsx`) can render `<OpenGeniChat />` directly. Before, `next build` failed while prerendering with `TypeError: createContext is not a function`, and the host had to wrap the chat in its own client component.
  - @opengeni/connect@1.4.2
  - @opengeni/sdk@1.4.2

## 1.4.1

### Patch Changes

- 9145bad: Connector catalogs no longer offer connectors that cannot connect on the current deployment. Some providers refuse OAuth self-registration (Asana, HubSpot, Front, Box, Dropbox, Canva, Vercel, and others). When the deployment has no operator-registered OAuth client for such a provider, the catalog reports `runtime.operatorOAuthClient.configured: false` and connector discovery hides the row. Rows that are already connected stay visible.
- be95071: Live voice for embedded chats. `createSessionProxyHandler` now forwards the realtime model catalog and the live voice call routes (begin, connect, heartbeat, end, activate, transcript sync) as the resolved end user, with Opengeni's usual `sessions:control` and call-ownership checks; `beforeForwardMessage` sees voice start and transcript saves as `delivery: "realtime"`, and `realtimeVoice: false` turns it off. The stock `OpenGeniChat` composer shows the live voice button when the workspace offers an available voice model.
- 1f112d5: An expired or revoked server API key no longer shows end users a raw `OpenGeni API 401: authentication required` message. `OpenGeniChat` and `SessionConversation` in `baseUrl` mode now say "Chat is unavailable right now. Ask an administrator for help." (other load failures use the same brand-neutral copy as the rest of the UI), and the session proxy logs one server-side warning telling the developer to create a new key and update `OPENGENI_API_KEY`.
- 17bb58b: `useGoal` no longer refetches (and 404s) the goal on every turn and session event while the session has no goal; only goal events can create one.
- 0e45b19: `@opengeni/react/compiled.css` no longer triggers Vite's "Transforming this CSS nesting syntax is not supported" build warning. The markdown table's last-row rule now nests with a leading `&`, which bundlers flatten for their default browser targets.
- 6c69bb0: `@opengeni/react/compiled.css` no longer makes Next.js builds report "Compiled with warnings" (autoprefixer: `start value has mixed support`). The capability-setup label uses `align-items: flex-start`.
- 37c7278: The conversation timeline now listens for `scrollend` natively. React 18 has no `onScrollEnd` prop, so React 18 hosts logged "Unknown event handler property `onScrollEnd`" and never ran the handler that decides when a reader has scrolled away from the live tip.
- e852eb7: Voice input never deletes a real dictation on Cancel, Escape, or when live voice takes the microphone: anything longer than a few seconds stops and stays saved on the device to transcribe or discard explicitly, and an Escape already handled by a dialog or menu is ignored. A dictation left behind by a closed or crashed tab is offered again as soon as the app reopens instead of after the owner timeout. A transcript that was never inserted is offered plainly ("Insert it into your draft?") rather than as possibly duplicated. Dictation shows elapsed time and warns before the automatic stop. Saved/error explanations wrap instead of truncating, and on phones (including container-responsive embeds) they take the controls row while Pause, Stop, and Send stay. Fixed dictation failing after a remount (React StrictMode) because the recording store was reused after close. Live voice: a definitive failure before the first connection, including a blocked or missing microphone, ends the call and keeps an actionable reason visible next to the voice button until the user dismisses it or tries again (no "OpenGeni API 409" prefix or reference id); autostart makes one attempt instead of looping; the model menu says "Opengeni"; and a disabled start control names its blocker. `useVoiceInput` exposes `recordingStartedAt` and `maxRecordingSeconds`. A slow microphone prompt no longer fails live voice in a session that had an earlier call ("Realtime lease version changed"). The dictation start error is dismissible, live voice taking the microphone clears a stale one, and starting dictation retires a stale live-voice start failure, so the two never show side by side. Voice credit copy no longer says "out of credits" to an account holding only free chat credits.
- Updated dependencies [9145bad]
- Updated dependencies [be95071]
- Updated dependencies [1f112d5]
- Updated dependencies [784e862]
- Updated dependencies [f290348]
- Updated dependencies [e852eb7]
  - @opengeni/sdk@1.4.1
  - @opengeni/connect@1.4.1

## 1.4.0

### Minor Changes

- 5a0c6f3: Add configurable Azure GPT Live hosted voice through the existing realtime controller, preserving connected subscriptions and workspace providers. Persist timed transcript fragments across connection rotation and graceful stop.
- e0ccba8: Goal controls and sub-agent chats in the stock embedded chat.

  - `createSessionProxyHandler` serves the session goal: `GET goal`, `PATCH goal` forwarding only `{ status: "paused" | "active" }` (a browser rationale is dropped; other fields are refused), and `DELETE goal`, the proxy's only `DELETE` route.
  - `SessionConversation` shows the goal in its chrome with Pause, Resume, and Clear when the client can reach goals. An older proxy's 404 reads as "no goal".
  - `SessionConversation` takes `onOpenSession`, forwarded to the timeline's sub-agent cards and the chrome's child updates. `OpenGeniChat` defaults it to opening the child chat in place.

- 8e11301: Make the stock `OpenGeniChat` work end to end behind `createSessionProxyHandler`.

  - Generated images and video, published files, and browser or computer screenshots now display in an embedded chat. Under `files` the proxy forwards a session's screenshot reads and the workspace artifact content (with `Range`) and video playback-source routes, and only for an artifact the API proves that session produced. `SessionConversation` supplies the loaders by default; `createWorkspaceRetainedArtifactLoader`, `createSessionRetainedScreenshotLoader`, and `createWorkspaceRetainedVideoLoader` are exported for custom timelines.
  - The proxy's client config reports `artifacts: false` (unless `artifacts: true`), `sessionCreation`, and `archive`. Site previews show as unavailable without a request, and "New chat" and "Archive" are hidden when the proxy cannot serve them. A refused create from an older proxy shows the "New chats are not enabled" label.
  - The composer microphone appears in `SessionConversation` and the new-chat composer when the deployment reports voice input available; `voiceInput={false}` opts out.
  - The API's CORS policy allows the `X-OpenGeni-Session-Id` scope header, so a cross-origin browser client's conversation media and Site reads are not refused at preflight.

- ef0f1c8: Metered voice input: add the `azure-mai` voice-input provider id and the `insufficient_credits`, `allowance_exhausted`, and `monthly_model_cost_limit` transcription error codes, which resumable recordings now also report as their `errorCode`. The composer transcription control adds `errorInsufficientCredits`, `errorAllowanceExhausted`, and `errorPolicyBlocked` messages; a caller whose payer cannot be verified now sees a policy refusal instead of a microphone-permission error.
- e01662a: Deployment-funded live voice is credit-gated and billed per started minute. Heartbeats can return a `stop` instruction, the realtime controller ends the call gracefully and exposes `refusal` (`insufficient_credits`, `allowance_exhausted`, `monthly_model_cost_limit`, `realtime_voice_unavailable`), and catalog items carry `unavailableCode`. The voice control shows an out-of-credits state instead of a generic error.

### Patch Changes

- bd9521c: Approval reviews read as one action: multi-item work no longer shows "batch" in titles, a Block reports its own reason and a `blocked` status, and an older request whose saved arguments cannot be recovered still offers Decline so the session never stays stuck.
- 3bd1060: Add a read-only capability access review and version-fenced root-to-child application helper so the web connection card can explicitly approve parent tool additions before selecting integration tools in a child chat. Preserve existing choices and child policy ceilings, and avoid adding mandatory runtime servers to explicit selections.

  Preserve optional/eager connector flags when retaining workspace defaults, and keep setup owners valid across StrictMode replay while retiring work from changed access scopes.

- 12f84ed: Loading older session history no longer tears down and reopens the live event stream. Rows that arrive while an older page is in flight append once, in order, onto the prepended window, and the connection state stays `live` (no "Connecting…" flash or repeated session reconciliation on every scroll-up). The stream still closes when a full backward page evicts the live tail and the timeline enters history mode.
- 8e90088: The dark theme's composer focus glow is now the intended faint halo (10% of the accent) instead of a full-strength 24px glow, which showed as a strong grey haze on dark hosts.
- Updated dependencies [5a0c6f3]
- Updated dependencies [e0ccba8]
- Updated dependencies [8e11301]
- Updated dependencies [ef0f1c8]
- Updated dependencies [e01662a]
  - @opengeni/sdk@1.4.0
  - @opengeni/connect@1.4.0

## 1.3.0

### Minor Changes

- 178b5ae: Unify connector Allow, Ask first and Block decisions across tool transports and settings. Add durable programmatic approval handles, exact stored-operation continuation, and shared review facts with portable React presentation and paginated protected details.

  Add lightweight Gmail message selection and bounded pagination/chunk helpers. Preserve exact access checks, uncertain outcomes and existing client compatibility. Deploy matching API, worker and native runtime artifacts through the documented maintenance migration.

### Patch Changes

- 2aed1a1: Embedded chat fixes for proxied embeds:

  - `OpenGeniChat`'s new-chat composer is now the follow-up composer: file attachments, the model picker when offered, and `conversationProps.composerProps` (custom controls, voice input, copy). The first message's files and explicit model choice reach `createSession`, whose hook input now carries `resources` and, unless `modelSelection: false`, `model`, `reasoningEffort`, and `latencyMode`; the proxy adds those files and applies those choices to the request the hook returns.
  - The session proxy forwards voice input (`POST .../transcriptions`) as the resolved user, and reports only one-shot recordings in the client config. `voiceInput: false` reports voice unavailable and refuses the route. Previously the config advertised voice while the route returned 404.
  - `OpenGeniChat` and `SessionConversation` in `baseUrl` mode accept `headers` (static or per request) and `fetch` for bearer-token apps, and use a `client` passed alongside `baseUrl` instead of silently dropping it.

- Updated dependencies [178b5ae]
- Updated dependencies [2aed1a1]
- Updated dependencies [414d416]
  - @opengeni/sdk@1.3.0
  - @opengeni/connect@1.3.0

## 1.2.0

### Minor Changes

- d870f32: Support model-scoped signup and coupon credits with a shared operator default and
  per-offer overrides. Update coverage at runtime, spend eligible promotions before
  general credits, and preserve allocation and retry accounting. Keep scoped coupon
  redemption separate from paid top-ups. Show credit funding in model selection and
  current coverage on demand in billing. Legacy unrestricted grants stay unrestricted.

### Patch Changes

- e70ddfe: Refresh model funding when the embedded conversation's model picker opens, so
  credit labels reflect current balances and promotional coverage without closing
  the menu or adding labels to the closed selector.
- 21c8904: Support optional HTTPS model catalog logos with safe image fallbacks, and declare the item type of the SDK filesystem function tool's command tuple.
- d081155: Keep accepted startup feedback in the conversation with continuous loading presentation and immediate dispatch diagnostics. Show loading details after 30 seconds and slower-start copy after 60 seconds.
- Updated dependencies [11c4d3c]
- Updated dependencies [21c8904]
- Updated dependencies [d870f32]
  - @opengeni/sdk@1.2.0
  - @opengeni/connect@1.2.0

## 1.1.0

### Patch Changes

- c600e3a: Use the full scoped model catalog for goal continuation and validate goal Resume before changing state. Preserve specific admission pause reasons and show the actionable rationale in the existing goal controls.
- Updated dependencies [411b3b5]
- Updated dependencies [4d5053f]
- Updated dependencies [208dec1]
  - @opengeni/sdk@1.1.0
  - @opengeni/connect@1.1.0

## 1.0.2

### Patch Changes

- 43da85e: Write the product name as "Opengeni" in user-visible messages. Code identifiers, the `OpenGeni API <status>:` error prefix, and protocol values are unchanged.
- ba5a639: Fix a dark composer on light pages: stock theme tokens rewritten by the host's CSS minifier (for example Next.js turning `#333333` into `#333`) are no longer mistaken for host customizations.
- d4ada81: Expanding a live turn's work row now reads like a finished turn: its progress notes are listed in order between the steps, and the copies above the row fold away in one short motion while the row rises into the first note's place (or the top edge) with its list beginning just beneath. Closing reverses it. Nothing else on screen jumps: the reader's position is held through the moment the page is briefly shorter, and closing from the sticky header lands back on the closed row.
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
- Updated dependencies [43da85e]
- Updated dependencies [4476ca7]
- Updated dependencies [cbe4357]
  - @opengeni/sdk@1.0.1
  - @opengeni/connect@1.0.1

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

### Patch Changes

- Back to your message now floats 12px below the top of the conversation, and drops just below an expanded work-header strip only while that strip is pinned to the top, instead of always sitting below where the strip would be.

## 7.8.1

### Patch Changes

- Updated dependencies [627ff68]
  - @opengeni/sdk@7.8.1

## 7.8.0

### Minor Changes

- 692a1f5: Show models by their clean display name and maker logo outside model settings. Add `modelDisplayName`/`modelVendor` (`@opengeni/sdk/model-display`) and `ModelName`/`ModelMark` (`@opengeni/react`). Picker rows, triggers, queue rows and fleet tiles no longer show routing ids, and organization- and workspace-connected copies of one model share one "API keys" group and render identically.
- 395becb: Make the embedded chat look native inside host products. `OpenGeniChat` and `SessionConversation` now follow the host page's light/dark theme (an enclosing `data-og-theme`, `class="dark"`/`data-theme` on `<html>`/`<body>`, the host `color-scheme`, then the page background) instead of defaulting to dark, and derive their backgrounds and cards from the host background (`surface="host"`; `surface="theme"` and customized `--og-color-*` tokens are kept). Their composer shows a Stop control only while a response runs instead of the workstream Pause control, and the next message continues a stopped conversation (`composerProps.runControl` opts back into `"pause"`); `ChatComposer` gains `runControl`/`running` and the composer subpath exports `StopButton`. The model picker is hidden in these embeds unless `modelPicker` is set or the proxy reports `createSessionProxyHandler({ modelSelection: true })`. In these embeds a yes/no question renders as two buttons without "Other" (`HumanInputForm`/`HumanInputSurface` `decisionButtons`), the live "waiting on you" divider no longer repeats the turn's waiting header, the "Back to your message" pill stays inside the timeline and hides in short viewports, a failed load offers Try again (`labels` localizes it), the new-chat state has a heading, and with `compiled.css` host global list/paragraph/heading styles no longer leak into SDK markup. `MessageTimeline` gains `questionNavMinViewportHeight`.

### Patch Changes

- f893cb5: Preserve annotation review scrolling and focus across parent and layout updates by consuming each requested note focus once.
- 92e4045: Add accessible Back and Forward controls to the Browser address bar using the existing target and document fenced history actions. Disable them while navigation is pending or no tab is selected, refuse observations from a previously selected tab, and retain existing address draft, focus, and failure handling.
- af57cf9: Use canonical ComputerSession frames and actions for screen and window viewers. Preserve the painted frame fence, reflect authorized human input availability, and enforce human sandbox input policy on each action while retaining separate agent tool authority. Older controllers keep frame viewing behind an encrypted proxy without receiving RFB input grants.

  App-only viewers require an explicit current input posture before enabling mutations. Refresh rechecks permission without starting a stream or native action, and physical machine screen-control consent remains separate from viewing.

- 8ce490f: Support multiple Claude subscription accounts with shared workspace, organization and owning-user account controls, verified browser sign-in profiles, usage windows, exact credential leases and quota-aware rotation. Preserve accepted work during capacity waits and recovery. Upgrade existing encrypted subscription credentials through the documented maintenance migration before starting matching runtime binaries.
- 424f44d: Make the conversation's floating navigation compact. Jump to latest and Back to your message are now identical small round arrow buttons at fixed, centered spots: the down arrow just above the bottom of the conversation and the up arrow just below the top. Their labels remain available to assistive technology and as tooltips, and touch screens get a larger invisible tap area instead of a larger button.
- e518530: Keep Desktop menus inside the viewer, make long lists scroll, and close viewer menus with Escape, an outside pointer, or focus moving out. Return focus to the menu trigger after keyboard choices without taking focus from pointer actions.
- 49fc1c0: `SessionCapabilityFrame` accepts optional `details` content inside the card and an `actionUnavailable` explanation that replaces the action when the viewer cannot start setup.
- b96f26e: Show an active goal as Waiting while other session work runs, with an explanation that the goal continues automatically after that work finishes.
- 3caca71: Jump to latest no longer shows while the reader is already at the bottom. Using a control in the conversation (Copy, a connection card) hands the view to the reader; the pill now appears only once something lands below them.
- 3cc26b5: Identify the default pinned HTTP client with a User-Agent, preserve caller overrides, and show retryable MCP sign-in discovery failures in connection setup.
- fe1739f: Use neutral model-group labels and icons in the stock embedded picker, while keeping explicit host branding and external-provider identities. Expose appearance-only picker customization on the complete conversation and preserve explicit first-party console branding.
- 978981a: Present expected sandbox lifecycle waits during model preparation as waiting rather than failed. Retain technical failure receipts and keep actual model and provider failures visible.
- 272c016: Expose command readiness separately from edit permission. Pause presentation mutations while earlier changes await settlement, preserving drafts, slide navigation, and zoom.
- 97d4f07: Require an explicit server-enforced screen grant for managed ComputerSession RFB input. Preserve viewing with pixel-only grants, recheck controller and target authority before forwarding packets, and use canonical frames and actions with older controllers. Desktop viewers default old attachments to view only.
- bb52f56: Open the whole desktop by default, show a screen selector for multiple displays, and move app/window views into the Advanced menu. Preserve explicit target choices and existing input authority across refreshes.
- Updated dependencies [af57cf9]
- Updated dependencies [8ce490f]
- Updated dependencies [692a1f5]
- Updated dependencies [395becb]
- Updated dependencies [3395acc]
- Updated dependencies [00000d7]
- Updated dependencies [746464c]
- Updated dependencies [272c016]
- Updated dependencies [6cdc0aa]
- Updated dependencies [0fba21e]
- Updated dependencies [97d4f07]
- Updated dependencies [1826595]
- Updated dependencies [b4d1c5b]
- Updated dependencies [14e95e9]
  - @opengeni/sdk@7.8.0

## 7.7.0

### Minor Changes

- 351cd79: Add `includePinned: false` to session-page reads so callers loading the pinned section separately can skip repeated pin hydration. The default response and ordinary-page pin exclusion are unchanged.

  Bound the browser event working set to 16 MiB or 20,000 events, with durable history accessible through existing navigation. Avoid copying the event window when no additional question evidence is needed.

### Patch Changes

- 9f0f7d3: Anchor the conversation's floating navigation in one stable place. Jump to latest and Back to your message now stack centered at the bottom of the timeline, with the later-activity status above them, instead of measuring the rows beneath them and sliding sideways or dropping below toolbars as content streamed or the host resized. The pills no longer wander on narrow, embedded, or mobile layouts, and both keep a 44px touch target on coarse pointers.
- 45e1b4f: Advertise background window input separately from background semantic controls. The CUA pilot viewer accepts targeted clicks and typing without offering unsupported foreground focus; existing native backends retain their focus guard.
- b786e5c: Keep failed or unconfirmed browser input visible while live frames continue. An explicit fresh check of the same browser clears the notice without replaying input.
- f336d3e: Show a pending approval once: readable turns no longer repeat the live "Approval needed" banner when the turn header already says "Waiting for you". `ApprovalSurface` lists flat arguments as labeled fields with an "exact arguments" toggle (nested arguments stay JSON), and the composer no longer shows a default keyboard hint (shortcuts stay in the send button title).
- 110bcb7: Fit computer frames to the dock, including small window captures, while preserving aspect ratio, capture resolution, and pointer coordinates. Refit on dock and frame size changes without measuring every incoming frame.
- 76ff363: Support workspace OpenAI and Azure OpenAI API keys with provider verification, isolated encrypted credentials, and externally billed model selection. Add the optional model verification flag to connection creation and preserve shell cancellation on macOS local sandboxes.
- c7be92c: Keep desktop IME candidate text and selection keys local until the person commits the text, then send that text once.
- 065316d: Keep desktop controls unavailable after a control service failure even while frames continue arriving. Reconnect refreshes the same desktop's control and media channels. App inspection failures, target refusals, and uncertain input outcomes remain separate from service outages.
- 946f6c3: Keep OAuth completion polling active when browser isolation detaches the provider window, and discover authentication for custom MCP connection setup from the live endpoint. Resolve tool-permission discovery for selectors with a single matching account, refusing ambiguous account choices.
- 5dacdd7: Add brand-neutral SDK error presentation and a shared native React host error-copy override, preserving diagnostic errors and delivery/retry state.

  Keep NewChat's full-height composer contained when using shipped CSS without a host reset.

- 8a5f977: Show named desktop actions and editable values in App controls. Structural accessibility nodes no longer crowd out usable controls, and the control count matches the available actions.
- cbb3e36: A send that names a model no longer in the live catalog now returns its 422 with `details: { code: "model_unavailable", modelId }` (the status, code and message are unchanged). `@opengeni/react` maps it to plain composer copy, offers Edit message instead of a Retry that cannot succeed, and exports `COMPOSER_MODEL_UNAVAILABLE_MESSAGE` and `isModelUnavailableSubmissionError`.
- Updated dependencies [7798558]
- Updated dependencies [45e1b4f]
- Updated dependencies [351cd79]
- Updated dependencies [da4ba6f]
- Updated dependencies [56584f9]
- Updated dependencies [31e3771]
- Updated dependencies [76ff363]
- Updated dependencies [d2fe11d]
- Updated dependencies [946f6c3]
- Updated dependencies [5dacdd7]
- Updated dependencies [479ec20]
- Updated dependencies [351cd79]
- Updated dependencies [70af8bb]
  - @opengeni/sdk@7.7.0
  - @opengeni/connect@0.3.2

## 7.6.1

### Patch Changes

- d03b4a8: Clarify that window app controls work in the background and label explicit foreground activation as “Bring to front”.
- cf1570d: Keep desktop images usable in narrow panels by placing app controls below the image. Wider viewers retain their side panel. Keep the foreground activation button readable within the image bounds.
- 09a991f: Hide Jump to latest when readers scroll back to the live bottom after returning to their question, preserving scroll intent across renders and releasing stale question focus.
- Updated dependencies [3f7ff5b]
  - @opengeni/sdk@7.6.1

## 7.6.0

### Patch Changes

- 9b3c40e: Show factual response-waiting copy once a model request is dispatched, while preserving the loading indicator and host customization.
- a1a23d2: Recover raw PostgreSQL rollback failures during turn startup using the existing exact-attempt recovery boundary. Present database failures without raw SQL or parameters, including historical failure events.
- Updated dependencies [e5b0123]
  - @opengeni/sdk@7.6.0

## 7.5.0

### Minor Changes

- b45621d: Artifacts and Sites now work inside an embedding product with the same components the OpenGeni console uses. `@opengeni/react/artifacts` gains the console's inline Site/HTML preview (`ChatInteractiveBlock`, `ArtifactSandbox`, `DeferredChatMedia`), `SiteView`, `EditableArtifactView`, and a host-mountable `SessionArtifactViewer`; `SessionConversation` renders `opengeni-site` fences inline and opens agent artifact links through `onOpenArtifact` (`viewerLinkResolver` for a custom timeline). `createSessionProxyHandler({ artifacts: true })` serves only the artifacts OpenGeni lists for the requesting session (read, editor live ticket, Site detail and sandboxed HTML), and client config advertises the live socket URL and browser cache partition. The SDK client adds `withHeaders`, `apiUrl`, and `fetchApi` for host-authenticated transports. Every built-in artifact string is translatable through a `labels` prop (partial `ArtifactLabels`) on `SessionArtifactViewer` and `ChatInteractiveBlock`, or `ArtifactLabelsProvider`. Document and presentation editors compose one projection at a time, so opening an artifact with a long history no longer floods the artifact Worker's request queue.
- 709eef2: Usage allowance UI. `@opengeni/react/usage` adds `useUsage`, `UsageMeter`,
  `UsageLimitNotice` (the calm near/at-limit composer line) and
  `UsageMemberList` (an admin roster with a share-of-budget slider that shows
  oversubscription as allowed). The conversation renders an allowance refusal as
  a structured "usage limit reached" row that hosts reword with
  `allowanceExhaustedLabels` or replace with `renderAllowanceExhausted`, and a
  queued prompt refused before it starts stays above that row.
  `@opengeni/sdk/usage-allowances` exposes allowance reads and administration as
  free functions over `requestJson` for browser code without the root client.

### Patch Changes

- c85f432: Show failed-send reasons inline rather than hiding them in a tooltip. Credit and usage-allowance refusals no longer offer an unchanged Retry; Edit message restores a definitively refused prompt and its attachments into an empty composer while preserving the current model selection. Transient and uncertain deliveries keep their existing retry and reconciliation behavior.
- 2253be0: Clarify that browser diagnostic counts include earlier pages in the same tab. Show unavailable counts until an observation exists, preserving observed zero counts.
- c9c59b5: Explain when a chat's browser was lost or failed instead of silently showing an empty viewer.
- 726f09d: Respect the desktop backend's mouse and keyboard availability. Encoded-frame views allow supported input independently; RFB views require both capabilities for direct control. Keep screenshots visible and show a view-only notice when direct input is unavailable.
- 28c2b3f: Show Latest question only after the chat's initial history is ready, so startup cannot silently cancel that navigation.
- 5ba250d: Offer Add note for text selected while the timeline's annotation controls are still loading.
- 45d1301: Expose repeated empty final replies as a typed, informational completed-turn notice without failing goals or deferring later updates.
- b45621d: Fix embedded artifact viewing for external users by resolving fresh effective workspace grants, checking exact session associations on every request, and binding live editor tickets to their source session. Keep editor authority and reconnect reads current when clients or sessions change, and allow retrying temporary viewer configuration failures.

  Source-bound editor sockets renew a 15-second lease through the host proxy, rechecking product authorization; existing unbound console sockets are unchanged. Compact authenticated source tickets remain within the existing wire limit.

  Add server-only `@opengeni/sdk/session-proxy` helpers. Stream embedded Site HTML with backpressure and cancellation and enforce a 25 MiB actual-byte ceiling; oversized streams fail with `site_html_too_large`. Preserve the console's existing shared artifact components and list behavior.

  Allow PostgreSQL test fixtures to use an explicitly configured native server while preserving restricted-role and FORCE-RLS verification.

- d60f96a: Preserve history reading position when Markdown tables are remeasured during host rerenders or tail streaming, without changing table overflow, copy controls or viewport resizing.
- 0bbe2e7: Keep all React root exports available without requiring optional workbench peers at build time. Add terminal, editor, and desktop opt-in loader subpaths; hosts mounting those surfaces enable the installed peers once, with optional grammar and WebGL loaders supplied by the host.
- 45d1301: Load client-config model defaults for the exact workspace requested by the workspace model catalog hook.
- 0bbe2e7: `@opengeni/react/session-ui` exports `OpenGeniProvider` and the tool-renderer
  registry (`createDefaultToolRegistry`, `createToolRegistry`,
  `defaultToolRegistry`), so a host can render `OpenGeniChat` or
  `SessionConversation` from that entry alone without the root's optional
  workbench peers.
- 5f7aa12: The conversation's floating "Jump to latest" and "Latest question" pills slide sideways when their resting spot would cover a control, such as the active turn's "Working" row or an inline Site card's toolbar. Only the pill moves; the timeline's scroll geometry is unchanged.
- 5b48f00: Add recoverable allowance lifecycle state and idempotent clear receipts.
  Preserve typed allowance scope and reset details in web, MCP, and Slack
  refusals with administrator-specific remedies.
  Expose browser-safe refusal helpers through `@opengeni/sdk/allowance-refusal`
  without widening React's runtime dependency boundary.

  Recheck allowance after paid compaction and align continuation admission with
  its frozen causal lineage. Keep allowance storage compatible with rolling
  deployment, preserve settled usage across period edits, harden definer search
  paths, and order organization locks before tenancy fences.

- 5b48f00: Default missing webhook lanes only after signature verification, preserve the
  public organization webhook event vocabulary while rejecting usage subscriptions,
  and keep allowance refusal presentation schema-runtime-free for browsers and
  React Native. Emit the focused integration and refusal entries in published builds.

  Fence the next model dispatch on settled usage and frozen-human admission, refuse
  fresh delegated work before interruption, and repair workspace-less Knowledge
  indexing and historical migration fixture dependencies.

- Updated dependencies [a6ff780]
- Updated dependencies [0bbe2e7]
- Updated dependencies [d9ec660]
- Updated dependencies [45d1301]
- Updated dependencies [fd5fb34]
- Updated dependencies [b45621d]
- Updated dependencies [b45621d]
- Updated dependencies [45d1301]
- Updated dependencies [f874217]
- Updated dependencies [b45621d]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [3545ca3]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [0bbe2e7]
- Updated dependencies [b45621d]
- Updated dependencies [5b48f00]
- Updated dependencies [5b48f00]
- Updated dependencies [709eef2]
- Updated dependencies [5b48f00]
- Updated dependencies [0bbe2e7]
  - @opengeni/sdk@7.5.0
  - @opengeni/connect@0.3.1

## 7.4.0

### Minor Changes

- 9a4a45c: Make long turns read like a coding agent in the compact progress presentation (`turnSummary={{ rolling: true }}`). Assistant commentary joins its activity cluster (a phase-less message of the running turn stays the live note until its turn ends or it outgrows a note), and each exchange folds behind one status row ("Working · 2m 14s · 12 steps" with the latest progress note and current step, or "Waiting for 2 agents · 3m") with the answer below a "Worked for …" separator. Routine machine inputs, recorded waits, and compaction fold inside the exchange; failures, approvals, auth recovery, human input, scheduled prompts, and images stay visible. Following the tip stops once an answer pushes its question to the top, and a "Your question" control returns to the question being read. Recorded waits now say "Waited for 1 agent · 3m 5s" instead of "Wait recorded".

  New API: `groupTimeline(items, { foldExchanges: true })`, `TurnSummary`'s `status` prop, optional `waitingAgents` / `waitEndedAt` on recorded wait notices, and optional `startedAt` (when a streamed message began) on `AgentMessageItem`. `ActivityItem` now includes `AgentMessageItem` for folded commentary; exhaustive switches over activity kinds need an `agent-message` case.

- a6644b6: Framework adapters for web-standard handlers such as
  `createSessionProxyHandler` and `createChatHandler`: `@opengeni/sdk/next`
  (`toNextRouteHandlers`, `createSessionProxyRoute` for an App Router catch-all
  route), `@opengeni/sdk/express` (`toNodeMiddleware` for Express, Connect, and
  `node:http`, streaming SSE and aborting on disconnect), and
  `@opengeni/sdk/hono` (`toHonoHandler`).

  The session proxy serves the chat list (`listSessionPage`, limited by default
  to the chats the resolved user created; `sessionList: "visible" | false`) and
  archive/restore (`archive: false` to disable). `@opengeni/react` adds
  `SessionList` and `OpenGeniChat`, a list-plus-conversation experience with a
  responsive sidebar/drawer, a new-chat composer, and rename/archive.

- a6644b6: `OpenGeniProvider` no longer blocks or reloads the page when the server's API
  contract revision differs from the bundle's; that stale-tab protection is now
  the opt-in `reloadOnApiContractChange` prop used by the stock OpenGeni console,
  so an OpenGeni deploy never reloads an embedding product's page. The session
  proxy reports its own SDK contract revision in `/v1/config/client` and never
  forwards the upstream `x-opengeni-api-contract` header to the browser.
- d480872: Agent links to OpenGeni objects now work inside an embedding product. `artifact:` files download by default from `SessionConversation`; sandbox-path downloads require explicit proxy `sandboxFiles: true` and use bounded, no-symlink reads within the session working directory. Editable artifacts and Sites route through a new `resolveLink` prop (`MessageTimeline`, `SessionConversation`, `Markdown`, `OpenGeniLinkProvider`) instead of rendering console paths that 404 on the host origin. Invalid reserved references render unavailable. `parseOpenGeniLink` in `@opengeni/sdk` classifies the same hrefs for non-React clients and preserves validated console return hints. Editable-artifact export uses configured exporter capabilities and preflights the exact format and options before creating a snapshot or pinning a version. Stock deployments serve spreadsheet XLSX; the artifact Skills stop promising unsupported PDF/DOCX/PPTX exports.
- a6644b6: `@opengeni/react` no longer names the optional `@pierre/diffs` peer in any
  `import()` reachable from the conversation, so a Next.js (Turbopack) or Vite
  host that imports only `OpenGeniProvider` and `SessionConversation` builds
  without it. Hosts that install `@pierre/diffs` opt in once with
  `enablePierreDiffs()` from the new `@opengeni/react/diffs` entry (or
  `registerPierreDiffs(loader)`); otherwise diffs and file views are plain text.
  `SessionConversation` hides its model picker when the client config reports
  `modelSelection: false`, with a `modelPicker` prop to override.

  `createSessionProxyHandler` adds `beforeForwardMessage`, which returns
  server-owned `modelContext` and MCP credential rotations
  (`mcpCredentialUpdates`) for every forwarded message, steer, composer submit,
  and browser-started create, or a `Response` to refuse it. With
  `modelSelection: false` the proxy reports it in the client config.
  `ClientConfig` gains the optional `modelSelection` field.

- a6644b6: `SessionConversation` now renders pending tool approvals with Approve/Reject
  actions, wires composer file attachments into sent messages when the
  deployment enables file uploads (opt out with `attachments={false}`), and
  accepts a `toolRegistry` for product-specific tool-call rendering.

### Patch Changes

- d00a203: Keep every answer visible in the compact progress presentation (`turnSummary={{ rolling: true }}`). An answer was folded into the "Worked for …" row, and shown only as a muted two-line preview, as soon as another machine-triggered turn followed it in the same exchange (an agent message, child result, wait timeout, goal continuation, background command result, or steer instruction). Now only work folds: the later turns fold into a new row below the answer, which opens as soon as the input is delivered, and their own answers render below that row. A reader stopped at an answer stays in place while that later work runs.
- 378327b: Emit one `agent.message.completed` per assistant message with its `phase` and, when the provider sent one, its `messageId`. Runtime normalization read a text field that Agents SDK message items do not have, so no per-message completion or phase ever reached events. Deltas now carry the phase a Responses provider declares, also through compact delta coalescing. An undeclared message gets the SDK's own rule: `commentary` when the same response asks for client tool work (including a client tool search) or ends with a later message, `final_answer` for the message the SDK returns. A Responses message completes as soon as it finishes, before the next message streams, instead of after the whole response. The worker skips the phase-less settlement copy once the stream completed the final text.

  Commentary is activity: it no longer marks a session unread (rolling migration 0527 indexes the new attention predicate), wakes `session_wait` change mode, becomes a Slack post, or enters the SDK chat reply. A turn that settles with only commentary still replies with its latest note. When a human or API message's turn ends waiting for input (`wait_for_input`), settlement records its latest assistant message on `turn.completed` as `reply` (the output stays empty; a child an agent spawned and a scheduled, automation or maintenance session's first turn record none), so a status answer given before waiting again marks the session unread and becomes a Slack post with the requester mention while delivery stays open for the result; stored history keeps the provider's phase. The SDK chat fold completes each segment by `messageId`, so a note completed after its answer streamed never repeats the answer. The MCP conversation view labels commentary, `latest: "terminal"` skips it, and the React timeline knows a streaming note is commentary from its first delta. `phase` stays optional.

  Older SDK clients see the new completions too: their live reply now separates a note from the answer that follows it in the same response with a blank line (it was run together before), and `history()` lists each completed note as its own assistant message. Roll the API before the workers: an older API process next to a newer worker can briefly post notes to Slack, wake `session_wait` change mode on them, and mark sessions unread for them.

- 1503ad7: Report unavailable browser controls even while cached or live frames remain visible, and disable keyboard capture until control recovers.
- 4f6d83a: Keep browser diagnostics opaque and confined to the page viewport, below tabs,
  address controls, and human handoff banners. Correct missing browser and desktop
  surface/text color utilities in both themes, and keep drawer actions usable in
  narrow docks.
- 7a3d134: Keep browser profile and launch menus within narrow viewer panels, with scrollable
  content. Dismiss browser menus on outside pointer input or Escape without closing
  the expanded workspace underneath.
- 01f50bf: Mark the composer send and pause buttons and the queued-prompt Steer buttons
  with a stable `data-analytics-action` attribute (`send`, `pause`, `steer`) that
  a host's product analytics can read. The attribute is inert, and a host can
  override it on `SendButton` and `PauseButton` through their props.
- 0aa60a6: Keep a failed optional Files module inside its workspace tab with an explicit
  reload action instead of replacing the conversation and composer with a route error.
- 4b39032: Load the optional workspace Files renderer asynchronously when first mounted, keeping chat and workspace
  state mounted while its renderer loads. Preserve file capability checks and the
  existing visited-tab lifetime.
- 454476c: Fence retained history-navigation callbacks and pending page reads to their owning
  session, workspace, client, and replay lifetime. Stale navigation cannot stop a
  replacement session's live feed, replace its history, or leave loading stuck.
- 4b39032: Expose successful initial history readiness independently of loading and stream
  errors, including empty histories. Clear stale initial-load errors on fenced retry
  and successful window recovery without letting old sessions overwrite new state.
- 4b39032: Give queued Latest question callbacks a current-navigation guard so a delayed
  refresh cannot reopen the queue after another history jump. Reuse canonical
  execution evidence when locating queued prompts whose ledger lacks turn.started,
  including tools, startup, recovery, and capacity events.
- 4b39032: Load the optional Latest question resolver on demand while preserving queued
  destinations, bounded history, retryable lookup errors, and navigation guards
  across the module-loading delay.
- a6644b6: Diff and file views already on screen upgrade to highlighted rendering when a
  host registers `@pierre/diffs` later, so hosts can call `enablePierreDiffs()`
  from the lazily loaded route that renders diffs instead of at startup. The
  OpenGeni console now does this, keeping the peer and its highlighter out of
  the initial bundle.
- dcb578d: Keep legacy timeline work without turn IDs aligned with approval, terminal status, and subsequent-work boundaries instead of leaving stale Working indicators.
- b591ea1: Support native Claude Messages with separate encrypted Anthropic API-key and Claude subscription setup-token connections, workspace access policies, streaming tools and thinking, prompt caching and usage accounting. Add connection UI and payment-source labels. Migration 0544 expands organization connection kinds and lifecycle validation.

  Pin the Claude subscription client identity headers, persist account/device metadata with encrypted credentials, and add request-scoped attribution. Existing token-only connections require replacement with identity metadata. The captured billing checksum remains unverified and is not replayed.

  Preserve Claude session identity across worker turns and recovery while keeping prompt lineage scoped to each run.

  Admit organization Claude models through session creation and lock their correct connection kind. Preserve Claude provider labels in the client catalog. Project initial system/developer instructions into Anthropic’s top-level system field so full agent sessions with skill instructions execute successfully.

  Polish Claude setup with local settings import, full-page token renewal, named model choices, provider marks, accurate subscription payment labels, and workspace discovery of organization-owned connections.

  Support workspace-owned Claude credentials, model generations, access controls and setup/account screens alongside organization connections. Migration 0545 expands workspace custom-model provider kinds. Gate Claude subscriptions behind OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED (default off), leaving Anthropic API keys and other providers unchanged.

- cabfc5e: Adopt the neutral theme: a shared `hover` token, unified menu and popover
  styling across the composer, model picker, realtime control and file browser,
  refreshed terminal colors, and "Opengeni" in user-visible copy.
- a1b6b8e: An automatically attached (optional) repository that loses access after a task started no longer fails the task's later turns. Before the strict per-turn GitHub App allowlist recheck and installation-token mint, the worker drops, for that turn only, each optional repository the workspace allowlist no longer admits or the GitHub App installation can no longer reach, and reports it as `skippedOptionalRepositories` on a `sandbox.operation.completed` event named `optional-repository-access`. It only ever removes repositories; explicitly attached repositories keep the strict behavior.

  Optional repository clones are also bounded (60 seconds each, 90 seconds together) when the sandbox has a `timeout` binary, so a hung fetch is skipped with the usual warning instead of failing sandbox setup. Explicit clones are unchanged.

  `@opengeni/github` adds `findInaccessibleGitHubAppInstallationRepositories`. `@opengeni/runtime` exports `OPTIONAL_REPOSITORY_CLONE_TIMEOUT_SECONDS`, and `repositoryCloneCommand` and `runRepositoryCloneHook` accept an optional per-repository timeout.

  `@opengeni/react` keeps the `optional-repository-access` report out of the transcript, like the routine repository-clone event.

- c2acd21: Show annotation-only queued turns in the compact session-chrome queue. A queued turn with an empty prompt and timeline annotations rendered as a blank row; it now shows a keyboard-reachable annotation-count chip ("Review 1 annotation") that opens the existing read-only review dialog, prompt-plus-annotation rows show both, and optimistic queue rows follow the same rule. The compact queue and `QueueSurface` share one presentation rule, and an item with neither a prompt nor annotations shows "Content unavailable" instead of blank space. `TimelineAnnotationsChip` accepts an optional `compact` prop for dense rows.
- 4b39032: Keep assistant progress and prior replies readable in independent turn summaries,
  with rolling tool activity and truthful Working/Worked timing. Remove cross-turn
  folding, text-length display inference, and forced answer anchoring. Add a single
  Latest question navigation callback backed by bounded durable history lookup.
  Keep expanded outer work headers reachable with section-scoped stickiness,
  without stacking nested headers or changing timeline scroll ownership.
  Resolve Latest question against authoritative queue/lifecycle state: focus pending
  prompts in SessionChrome, restore distant started prompts at their actual turn
  boundary, and skip withdrawn prompts without getting stuck on invisible rows.
- 4b39032: Keep standalone completed maintenance compaction visible without creating a live
  work summary. Clear resolved approval waiting from same-turn lifecycle/tool-result
  evidence while preserving historical attention landmarks and renewed approvals.
- 9649fcc: Share retained-image retry and figure markup to keep the session bundle within its existing size budget.
- a5da013: Allow retrying failed saved-image retrieval in the timeline without recapturing screenshots or modifying conversation history.
- 8a9d19e: Add human-authorized removal of saved personal/workspace Skills with version checks and replay after deletion. Allow installed capability shortcuts to display their status visibly.
- a12f4cf: Keep the model picker open after selecting a model so reasoning effort can be adjusted without reopening it.
- e403746: Keep live per-turn progress above one trailing activity disclosure, then fold settled progress and tools together chronologically while leaving the final response visible. Preserve expanded work, manual-reader position and focus, phase-aware duration, attention surfaces, and classic grouping.
- 4b39032: Keep Latest question and earlier-history controls in separate pointer regions
  when both are visible, including narrow mobile layouts. Preserve existing
  history navigation, callbacks, and scroll ownership.
- d480872: An expanded turn's sticky work header now pins flush to the top of the timeline instead of 3.5rem below it, so rows no longer scroll visibly above it; the floating Latest question action sits below the header strip.
- Updated dependencies [3f9c757]
- Updated dependencies [304ddc5]
- Updated dependencies [3f9c757]
- Updated dependencies [378327b]
- Updated dependencies [a6644b6]
- Updated dependencies [aad6598]
- Updated dependencies [e14db2a]
- Updated dependencies [a6644b6]
- Updated dependencies [a6644b6]
- Updated dependencies [d480872]
- Updated dependencies [3f9c757]
- Updated dependencies [9732749]
- Updated dependencies [6f28afd]
- Updated dependencies [b591ea1]
- Updated dependencies [a6644b6]
- Updated dependencies [a82657f]
- Updated dependencies [3f9c757]
- Updated dependencies [57f030c]
- Updated dependencies [3f9c757]
- Updated dependencies [3f9c757]
- Updated dependencies [f986809]
- Updated dependencies [1ea4c69]
- Updated dependencies [11151c6]
- Updated dependencies [12bc3de]
- Updated dependencies [30414a0]
- Updated dependencies [a6644b6]
- Updated dependencies [8a9d19e]
- Updated dependencies [e193b13]
- Updated dependencies [14990d0]
- Updated dependencies [d1f4724]
- Updated dependencies [c823664]
  - @opengeni/sdk@7.4.0

## 7.3.1

### Patch Changes

- 6cbccaa: Keep IME candidate-selection and commit keys local to the browser viewer so composing text cannot move the remote caret or submit a remote form. Continue forwarding committed text and subsequent ordinary keys.

## 7.3.0

### Patch Changes

- 78f1d59: Offer native dropdown choices in BrowserViewer when Chromium page frames omit the popup. Keep selection bound to the observed control and preserve normal input/change events, private-field redaction, and disabled options.
- 7f75daa: Keep long browser session lists scrollable with their action buttons visible, and label browser choices for assistive technology.
- 889a360: Accept fresh browser frames when an attachment renews and its producer restarts the frame sequence for the same page.
- ac83339: Show browser discovery failures and retry target loading instead of displaying a semantic-only browser when session loading fails.
- 1fa1216: Bind browser viewer input to the frame actually painted, cancel stale queued input
  across navigation and target changes, and preserve ordered scroll input. Treat
  plain upstream gateway failures as transport errors without blindly replaying
  browser mutations.
- 1842911: Recover managed browser viewers through the existing session when an unrelated attached Chrome profile loses its connection. Negotiate focused-input observations so native select choices appear after a viewer click, with existing generation fences and explicit fallback for older controllers.
- 6d4ccb9: Preserve keyboard focus after desktop canvas clicks, bind pointer input to the
  painted frame, and discard stale queued gestures and clipboard continuations.
  Keep continuous scrolling responsive while preserving ordered input and deltas.
- ec707de: Negotiate bounded viewer typing batches from the active browser controller. Preserve
  individual text events and input order while reducing request overhead; recheck the
  original document fence before each action and discard uncertain queued input
  without replay. Older controllers retain sequential input.
- 212de3d: Keep queued browser input fences without retaining earlier screenshot bytes or render callbacks. Preserve input order and discard queued actions when their viewer generation changes.
- cc4bc8e: Hide the agent workspace's machine-state chip while viewing independent Browser or Desktop resources. Those viewers retain their own runtime status, so a sleeping agent sandbox no longer makes an active browser appear asleep.
- Updated dependencies [1842911]
- Updated dependencies [585f2c1]
- Updated dependencies [ec707de]
  - @opengeni/sdk@7.3.0

## 7.2.0

### Patch Changes

- 19ecc86: Composer `autoFocus` no longer moves focus out of an open menu, listbox, or dialog when the composer becomes interactive late, so a hydrating composer cannot dismiss a menu the person just opened.
- b85a966: Keep suspended browsers asleep when their viewer opens, and resume only after an explicit Open browser action.
- d0b6742: Detach live browser frames when the page has been hidden, and reconnect when it becomes visible.
- 2eaeec6: Publish the `@opengeni/react/accounts` subpath with its built JavaScript and declaration files. The previous release mapped that export to a source file name the package does not ship, so importing it failed.
- Updated dependencies [084616e]
- Updated dependencies [1a427e0]
- Updated dependencies [6eb431b]
  - @opengeni/sdk@7.2.0

## 7.1.2

### Patch Changes

- 24968dd: Keep retained image retrieval out of compact progress labels so they do not report a missing image loader while the full timeline image remains available.

## 7.1.1

### Patch Changes

- Updated dependencies [3d33f17]
  - @opengeni/sdk@7.1.1

## 7.1.0

### Minor Changes

- bf744ed: Add optional model-policy picker group labels, icons and description overrides for host branding, shared by menu, trigger, accessibility and search without changing model or billing behavior.

### Patch Changes

- 701ea95: Preserve the original shell command when adopting background processes, so running command rows and completion notices show the command instead of execCommand. Keep long command rows ellipsized and expose their saved preview on hover and expansion.
- e9c4379: Resolve published-file Markdown links through host navigation, expose message presentation in SessionConversation, and document exact retained-file link/embed syntax.
- d92af11: Keep original command text through ambiguous launch recovery and persist it separately from bounded previews. Preserve whitespace, mark clipped previews with an ellipsis, and show complete commands on expansion and hover.
- a463199: Increase browser conversation retention from 8 MiB / 10,000 events to 160 MiB / 200,000 events, reducing eviction during history navigation without changing fetch sizes or folding behavior. Account for appended event bytes incrementally instead of serializing retained history on every live batch.
- 2f8bc58: Use bounded readable MCP tool aliases while preserving exact account routing and historical approval rehydration. Retain action and account display metadata in native and Codemode timeline events and approval cards without changing execution or approval identity. Legacy opaque calls resolve only against the current authorized tool catalog.
- dd3387f: Preserve Markdown paragraphs and embedded media when host link callbacks change, preventing selection jumps and video preview restarts.
- a463199: Repair workspace control revisions behind their retained event frontier, preventing historical control replay on each fresh browser load. Reject subsequent revision rollback without altering pause state, timers, or historical events. Stop refreshing last-started model metadata for unrelated control changes.
- Updated dependencies [d92af11]
- Updated dependencies [86c710a]
- Updated dependencies [2f8bc58]
  - @opengeni/sdk@7.1.0

## 7.0.0

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

- 3b73fc0: Add server-authoritative session-page sorting by last activity, creation date, or durable name and explicit active, archived, or all archive status. Pagination cursors bind these choices, and clients reject servers that do not acknowledge requested ordering or archive filtering.

  The stock sidebar offers compact Status, Group by, Sort by, and Show empty groups controls with workspace- and subject-scoped persisted preferences.

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

- cf9249d: Keep document typing and paste after a trailing newline, ignore IME composition Enter, and show spreadsheet General numbers without binary residue while leaving stored values and formula-bar source unchanged.
- 4258aeb: Show browsable public Skill results before a search and align Skill and Plugin catalog grids across desktop and mobile.

  Give connection setup a clear primary authorization action and quieter recovery controls, with shared responsive styling.

  Reuse plugin and skill discovery results briefly across tab visits with client/workspace/query isolation, align installed shortcuts, and remove duplicate catalog headings and search affordances.

  Keep All available in Capabilities navigation and cap its ordered category previews at six results, with explicit navigation to the full filtered category.

- c64a94f: Support simultaneous authorized personal and workspace MCP account attachments with immutable account-qualified routing, sender isolation, and scheduled execution binding. Move attachment controls inside Connectors with readable ownership labels; keep account setup on the Capabilities page.
- d5dba2a: Respect composer delivery readiness even when attachments are ready. File-only messages remain supported when the delivery owner reports them ready to send.
- 667a90f: Keep available connection services usable when another catalogue fails or stalls, handle synchronous transport failures, and discard stale discovery results after scope changes.

  Keep the console's Gmail logo fallback independent of the complete service registry so it does not bundle unused provider icons.

- 47a37c8: Align the optional voice-model drill-in header and spacing with the composer's resource menus while preserving model availability and payment-source selection.
- 348e54d: Use Sandbox Environment terminology in user-facing controls, errors, tool descriptions, and runtime guidance. Existing rig routes, tool names, IDs, permissions, and stored definitions remain unchanged.
- aa09567: Preserve explicit host MCP delegation selections through durable composer Send and Steer admission, including exact retries after an uncertain response. Keep existing owner, generation, visibility, revocation and replay checks; omitted selections do not inherit authority.
- 9de8e51: Route missing integration setup through provider-neutral catalog discovery and the shared human authorization card, with an explicit next action for every eligible catalog integration. Continue account selection and installation through owner authorization without an extra launch click, and open repository configuration in a separate tab.
- f3920a7: Add a compact accessible mobile slide selector so presentation editors can jump to any slide when the desktop rail is hidden below `sm`, without changing desktop rail virtualization or keyboard selection.
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

- 1cb688d: Add explicit permanent Skill removal review bindings and truthful removal receipts.
  Deletion approval is bound to the exact removal proposal; existing save approvals
  cannot authorize irreversible deletion. Review surfaces distinguish removal from
  activation and preserve conversations.
- 621201d: Distinguish queued sessions from running agents and expose durable dispatch wait
  evidence in session detail reads, including retry timing and recorded errors.
- f7e41e7: Show unavailable saved changes previews inside the affected Changes view instead of displaying capture-error notifications when a session opens. Preserve the existing explicit live-workspace action and the live-only Staged view.
- 9d9b94b: Allow plugin discovery to choose an initial registry while preserving all registry filters. The OpenGeni web catalog initially selects OpenAI.
- 6b32304: Reuse the shared activity row and running-command animation for incomplete previews, replacing the standalone loading card while preserving completion and interruption behavior.
- c9e2743: Accept an explicit null skill-review reference on structured human-input questions, matching the contracts wire type without changing API runtime validation.
- 0bf014d: Add a session-authorized Codex account projection. Capacity retry choices follow
  the waiting turn's accepted subscription pool after source changes, including
  Disabled. Running turns keep their accepted account label while next-turn
  choices and workspace settings continue to use the current source.
- c4a2775: Unify provider and MCP service discovery in the embedded connection panel. Preserve Gmail branding for personal accounts without workspace installation references, bundle Outlook branding, share service logo loading, and clarify ownership and tool-selection copy.
- b88890f: Show a neutral pulsing dot and command count on the session activity button, with reduced-motion support. Open command details directly when background commands are present.
- Updated dependencies [6d0a4de]
- Updated dependencies [c64a94f]
- Updated dependencies [3b73fc0]
- Updated dependencies [1c924ed]
- Updated dependencies [c31a951]
- Updated dependencies [f90d628]
- Updated dependencies [3fa175e]
- Updated dependencies [132b945]
- Updated dependencies [779b16b]
- Updated dependencies [1cb688d]
- Updated dependencies [9d9b94b]
- Updated dependencies [621201d]
- Updated dependencies [1bfb6a4]
- Updated dependencies [1641006]
- Updated dependencies [c9e2743]
- Updated dependencies [7e2436a]
- Updated dependencies [0bf014d]
- Updated dependencies [c66ba31]
- Updated dependencies [0ea365c]
  - @opengeni/sdk@7.0.0
  - @opengeni/connect@0.3.0

## 6.1.0

### Minor Changes

- 85cafd0: Add a shared workspace/session artifact catalog over existing Sites, editable artifacts, generated images, and published files. Keep file bytes and content authorization in their existing domains, expose bounded filtered discovery through the SDK, and retain explicit sandbox-file publication provenance. The web Artifacts library includes type/search/sort controls, grid/list views, retained image previews, and file viewers that do not wake compute. Published images use the shared chat image/lightbox presentation; ordinary HTML file downloads remain non-executable.

### Patch Changes

- 71ca29b: Preserve the current history window when loading later activity fails, expose the original error, and offer explicit timeline retry without repeated observer requests. Ignore late failures from a previous session or navigation lifetime.
- Updated dependencies [85cafd0]
  - @opengeni/sdk@6.1.0

## 6.0.0

### Major Changes

- efeaa9c: Replace autonomous Memory and reviewed Knowledge authoring with structured Knowledge entries, exact revisions, evidence, groups and nonblocking review. Add centralized Agent learning defaults with chat and scheduled-task overrides, private original-file ownership, canonical source preparation and rebuildable retrieval. Retire legacy Memory/learning mutation APIs and SDK methods; migration 0461 requires a drained maintenance cutover and the matching runtime. See docs/knowledge.md and docs/deployment.md.

### Minor Changes

- 750060c: Support inline HTML visualizations, retained images, and embedded Sites in chat. Add a plain HTML Site client, preserve application request headers through the shared bridge, document visualization workflows, and use Image 2.5 Sunburst for Codex image generation.
- 46a0267: Load authoritative goals on mount when reusing a shared event feed. Add optional native loading messages for accessible status, slow waits, and details controls, preserving English defaults. Expose SessionChrome's successful queue-checkout composer focus handoff.

### Patch Changes

- 48c624f: Show discovered desktop targets immediately so slow or failed semantic inspection cannot block the live view or switching windows and screens.
- d5582c1: Accept restarted frame sequences after a fresh desktop attachment so automatic renewal does not freeze the last image. Preserve frame ordering within a stream and reject detached sockets.
- 49d43e6: Show desktop connection errors and Reconnect after an established stream fails or socket retries are exhausted, and let Refresh desktops retry a failed stream.
- Updated dependencies [50ac837]
- Updated dependencies [ad9dc2f]
- Updated dependencies [750060c]
- Updated dependencies [da4a85f]
- Updated dependencies [efeaa9c]
  - @opengeni/sdk@6.0.0

## 5.2.0

### Minor Changes

- c1ad490: Allow hosts to localize user-message disclosure actions through direct component props and the default timeline composition. Each label falls back independently to English, while message expansion, accessible controls, and scroll anchoring retain their existing behavior.

## 5.1.1

### Patch Changes

- 0507f91: Retry timed-out composer draft reads with backoff and clear their warning after a successful refresh, including when the draft revision is unchanged. Keep draft-read failures separate from Send, Steer, and control failures, and identify draft sync timeouts in the composer message.

## 5.1.0

### Minor Changes

- d40bd9b: Replace startup timing rows with a quiet animated genie and rotating loading copy. Retain timing evidence in diagnostics, support a browser-local detail preference, and keep failures visible. Add a replayable loading studio.

### Patch Changes

- 4e2b59d: Keep loading animation options self-contained in public declarations so NodeNext consumers do not need to resolve the renderer's internal type imports. Supported animation options and runtime behavior are unchanged.
- 4e2b59d: Route plugin discovery types and endpoint compatibility through the public SDK boundary, using a narrow contracts entry without schema-runtime imports.
- 9968ae5: Allow host rendering of DeviceAuthorization while retaining shared clipboard state and URL validation. Restore the native Codex and SuperGrok subscription sign-in panels without changing embedded defaults or integration setup.
- 488a69b: Expose bounded current-failure evidence on session detail reads so recovery diagnostics do not depend on timeline pagination. Show recorded consecutive retry streaks without inventing lifetime totals, and distinguish Codex account assignment, affinity/lease reuse, and actual switches without changing allocation policy.

  Read session status and its replay cursor coherently, decode bounded diagnostics through the lossless storage codec, and record account transitions atomically against the current assignment with attempt-keyed replay and compatible switch reasons.

- 5ef34cf: Allow hosts to open a workbench tab with `openTabRequest`. The stock console routes Site links into the session artifact panel and retains a session return link when expanding Sites or editors full-page.
- Updated dependencies [4e2b59d]
- Updated dependencies [4e2b59d]
- Updated dependencies [488a69b]
- Updated dependencies [935af4e]
- Updated dependencies [d08dbb6]
  - @opengeni/sdk@5.1.0

## 5.0.5

### Patch Changes

- @opengeni/sdk@5.0.5

## 5.0.4

### Patch Changes

- 3d9ab25: Keep wide markdown tables stable while subsequent message text streams by preserving their layout observer and remeasuring content without resetting the expanded width.

## 5.0.3

### Patch Changes

- @opengeni/sdk@5.0.3

## 5.0.2

### Patch Changes

- 05957ee: Keep the workbench's initial tab unresolved while a signed capture manifest is loading, so pending capture metadata cannot permanently select Files instead of Changes. Preserve host overrides, settled empty/error fallbacks, and the user's later tab selection.

## 5.0.1

### Patch Changes

- be17b8e: Remove the SDK Skill loader capability and use eager sandbox-free Skill reading
  with a turn-prepared descriptor index. Keep on-demand checkout and repository
  Skill discovery separate, and render Skill tool calls consistently in the timeline.

## 5.0.0

### Minor Changes

- f8be7df: Allow hosts to render inline connection setup for timeline authentication requests. Add an optional safe return path to Fiken OAuth so setup can return to the originating conversation.
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
  - @opengeni/sdk@5.0.0
  - @opengeni/connect@0.2.0

## 4.0.2

### Patch Changes

- 39adecb: Let top-level assistant tables expand into available chat panel space while keeping surrounding text at its normal reading width. Tables remain contained when a side panel opens or the conversation is narrow, and keep horizontal scrolling when content still cannot fit.
- 1b0f4f2: Expose unavailable background command observations separately from command lifecycle state, and render that uncertainty in command and session status.
- 87fbd92: Preserve full session messages and tool output through database paging, compact
  event delivery, SSE, browser rendering, and copying. Remove browser per-event
  preview truncation while retaining history pagination and backpressure. Events
  larger than a page or loaded-window byte target are delivered intact on their own.
- Updated dependencies [1b0f4f2]
  - @opengeni/sdk@4.0.2

## 4.0.1

### Patch Changes

- 068be26: Complete a Skill save in the same transaction as its one verified human chat decision. Show the full immutable Skill folder, preserve exact scope and revision checks, and refuse delegated, stale, or mismatched approval. Autonomous saves activate directly; declining a proposal preserves existing active guidance.
- d1cb266: Keep automatic history filling from evicting the latest reply or cycling between older and newer pages. Preserve explicit history navigation and stable jumps back to latest. Retain provider message identity so assistant chunks interleaved with tool activity remain one message without merging distinct replies.
- Updated dependencies [068be26]
- Updated dependencies [2fa33e4]
  - @opengeni/sdk@4.0.1

## 4.0.0

### Major Changes

- c915b0f: Remove the separate `@opengeni/react/chat` component. Use the existing
  `SessionConversation` or compose the timeline and composer for the full agent
  experience. The server-side `@opengeni/sdk/chat` wrapper and adapters remain
  unchanged; their protocol requires a custom or compatible frontend.

### Minor Changes

- 9827c25: Add message action slots and an optional source message boundary for managed-human forks. The web UI places turn feedback and Fork from here beside Copy and the timestamp. Message forks preserve existing authorization and idempotency, copy only the selected canonical history prefix, and reject ambiguous, compacted, or incomplete boundaries.

  Migration 0429 requires draining the API and both worker pools and provisioning the updated runtime routine contract before starting the new binary.

### Patch Changes

- 0c5e2fd: Group composer timeline annotations into one count chip, pin numbered badges on the quoted source text, and keep Add note available for long highlights that end in message chrome. Dense and long notes stay in a viewport-clamped review list, overlapping badges pack onto distinct in-viewport points instead of stacking, Enter moves to the next empty note, and sent cards collapse instead of growing without bound.
- 231b103: Apply explicit Codex account switches and unpins to capacity-blocked turns, preserving the same turn and history through recovery. Display current account selection separately from future preferences and report when a switch requests a capacity recheck.
- 9d36a0f: Keep the latest streamed answer visible outside collapsed steps when an input wait ends a turn without final output.
- Updated dependencies [231b103]
- Updated dependencies [9827c25]
- Updated dependencies [5904fd1]
- Updated dependencies [14dd6fe]
  - @opengeni/sdk@4.0.0

## 3.8.0

### Minor Changes

- b1d3673: Add the `@opengeni/sdk/chat` facade (`OpenGeni`, `Chat`, `createChatHandler`, Vercel AI SDK and OpenAI adapters) and the `@opengeni/react/chat` drop-in component. Sessions gain `agentAccess`, an opaque `endUser` label, and `memoryScope`, enforced in the session-authorization seam so one workspace per customer can hold isolated, per-user, or shared chats. Organization API keys gain `access: "read"` and `GET /v1/organizations/:id/sessions`. Close the tool-widening paths: child tool selection, agent tool-policy updates, scheduled-task sessions, and the Codemode SDK proxy can no longer exceed the creating session.

  Private-memory identities use bounded hashes of exact source/user tuples. Correction, archival, and replacement enforce the private writable scope. Chat reload restores unresolved approvals and questions, and the chat component uses the complete human-input form with multiple selections and Other answers.

  Session-scoped discovery preserves the embedding host's allowlist. Responses streams emit the complete message/content lifecycle with stable per-response IDs, including incomplete settlement for human waits and cancellation. Streaming text preserves the same paragraph separators as the final reply.

- 107aa14: Support standard SDK/React conversations in Sites and sandbox previews, direct
  HTML/source uploads, exact deployment package pins, and embedded layout/queue
  defaults. Refresh exhausted Grok capacity after external resets.

### Patch Changes

- 0ca6728: Label child-result receipts without claiming task completion, explain pending input, and let hosts open the exact child from incoming and delivered updates.
- fa2b99a: Preserve workflow wake retries until pending input is admitted, while future waits stay parked at their deadline, and expose current session waits and waiting descendant counts. Refresh wait status on live events and retain the status projection sequence so newer session reads cannot be overwritten by older events.
- 1fc0889: Group deployment-provided models under OpenGeni regardless of upstream provider. Badge only explicitly free models, keep paid rows compact, and preserve separate workspace, organization, and subscription connections with accurate payment descriptions.
- e271780: Replace nested model selection with a searchable list grouped by payment source. Select models immediately, keep thinking and speed controls visible in the picker footer, and preserve supported settings when switching models. Prioritize model names in compact composer controls.
- 952331e: Restore click-to-expand previews for ready image attachments after their composer remounts, while keeping signed preview URL creation lazy.
- ecffc88: Use the selected appearance for message-detail backgrounds instead of the operating system theme.
- 8be8a72: Show failed live-file wake requests with a retry that renegotiates the workspace, instead of leaving a permanent waking spinner. Preview complete PNG, JPEG, GIF, and WebP files without enabling binary editing or waking machines during passive capture browsing.
- ba890d1: Keep selected models in their provider groups, consolidate subscription descriptions, and simplify reasoning controls. Show image compatibility warnings only when a draft contains images.
- 730b78b: Identify the goal explicitly in compact status chips so its state is distinct from the session status.
- e9d092a: Resolve goal landmark icons when rendered so circular production chunks cannot leave continuation rows permanently unavailable.
- ca2b4e2: Offer the session-chrome queue when chrome is idle and at least one authoritative prompt is waiting. Closing it dismisses that session until occupancy drains; a different session on the same chrome instance may still offer. A live Send stays a paint-only chip receipt.
- 3673900: Preserve reading position during session history pagination, keep folded history loading, and prevent false retries across stream reconnects.
- 3a29372: Keep embedded conversation foreground and background theme-matched. Support filtering published Sites by creating or publishing session for the session Artifacts panel.
- eeb5500: Label preserved wait outcomes with their recorded date and time and expose them as static notes, keeping historical agent text distinct from current session state.
- 0f3dc9a: Keep an unpinned timeline reader in place when older history prepends into a compact tail. Restoring the row offset no longer looks like a scroll back to the live tip, so the view does not snap to the bottom after loading earlier messages.
- fe73da9: Keep hidden composer height measurement out of document overflow after responsive resizing. Allow session chrome hosts to identify an active goal blocked by failed session execution without changing the goal state.
- d8a70ec: Unify first-party and integration tools behind one workspace gateway for MCP, model execution, Codemode, SDK, and browser clients; require host-confirmed SDK approval for human-gated model calls, keep Codemode claims live through gateway preparation, and deduplicate reclaimed tool-created events; add opt-in resource-bound MCP OAuth; ship governed self-contained HTML Sites with retained source, version rollback, an exact-version direct-call tool allowlist, and a native Site-authoring Skill; and default Modal self-hosts to OpenGeni's public digest-pinned desktop runtime image.
- f0f1e17: Keep a durable wait reason visible after a tool-only turn settles, including legacy goal holds, while preserving collapsed step detail and recovering missing or partial terminal responses from authoritative turn output.
- Updated dependencies [4536385]
- Updated dependencies [fa2b99a]
- Updated dependencies [fa12951]
- Updated dependencies [d06450c]
- Updated dependencies [d9dbd5d]
- Updated dependencies [1c4b707]
- Updated dependencies [cc1bfe0]
- Updated dependencies [3db0b05]
- Updated dependencies [c90f3fc]
- Updated dependencies [0c39126]
- Updated dependencies [0c39126]
- Updated dependencies [4708cfb]
- Updated dependencies [575af5b]
- Updated dependencies [6de9fe3]
- Updated dependencies [cda46e8]
- Updated dependencies [b1d3673]
- Updated dependencies [2fb17fd]
- Updated dependencies [3a29372]
- Updated dependencies [107aa14]
- Updated dependencies [d8a70ec]
- Updated dependencies [0a81cc8]
  - @opengeni/sdk@3.8.0

## 3.7.0

### Patch Changes

- 6b65383: Replace goal-scoped long waits with self-only session-level `wait_for_input`, add provider-neutral `command_wait`, and deliver terminal background-command proof as exactly-once durable agent input with workflow wakes for nonterminal sessions while preserving event-only audit for terminal sessions.
- 6f84c02: Make durable Codex credential leasing unconditional, preserve rotation-off as an active-account-only capacity policy, and recover definitive credential failures through same-turn failover or durable capacity waiting.
- Updated dependencies [6b65383]
- Updated dependencies [6f84c02]
  - @opengeni/sdk@3.7.0

## 3.6.0

### Patch Changes

- d63ee0f: Keep Connected Machine file links in the target's canonical filesystem namespace, including Windows drive and UNC roots, and reject stale file requests with a retryable route conflict.
- fab39d2: Keep lazy session-history reads sub-second on large sessions by fitting each browser window and its continuation lookahead into one byte- and count-bounded database query instead of walking the page through sequential reads. Fresh and foreground tail loads may use one additional bounded page to preserve a complete turn boundary, and foreground replacement keeps the prior timeline visible until the new window is ready.
- Updated dependencies [d63ee0f]
- Updated dependencies [b420912]
  - @opengeni/sdk@3.6.0

## 3.5.1

### Patch Changes

- Updated dependencies [8b42f58]
- Updated dependencies [0214875]
- Updated dependencies [e2a668b]
- Updated dependencies [9c45eae]
  - @opengeni/sdk@3.5.1

## 3.5.0

### Patch Changes

- 633f9bf: Reconcile sustained hidden-tab sessions by measuring their durable event gap: replay tiny gaps normally, append semantically small compact catch-ups in one paint, and reload the latest tail only for large or complex backlogs.
- Updated dependencies [32b9de4]
- Updated dependencies [8f81b57]
  - @opengeni/sdk@3.5.0

## 3.4.2

### Patch Changes

- b88a194: Stabilize timeline annotation interactions when lazy UI effects settle under load.

## 3.4.1

### Patch Changes

- a8da2c5: Stabilize release admission checks under loaded CI runners.

## 3.4.0

### Minor Changes

- 2d0fad4: Add deployment-defined model catalogs and cost policy, workspace-managed Gateway and OpenRouter credentials plus custom models, a separate deployment-managed OpenRouter rail, live catalog refresh, the `list_models` agent tool, and model-picker/API/SDK support for the new catalog surfaces.
- 9fe5c5b: Add organization-scoped Vercel AI Gateway and OpenRouter BYOK/custom models for shared workspaces while preserving independent workspace connections.

### Patch Changes

- c356468: Add explicit host authority provenance for opaque MCP connection references so embedding hosts can resolve any binding identity, including UUID values, without native delegation, catalog, attachment reauthorization, or reconnect flows reinterpreting it. Preserve the legacy non-UUID host-binding lane during rolling upgrades, retain host provenance after successful credential resolution, make auth-needed events inert in legacy browsers, and gate newly marked refs behind a default-off two-phase fleet activation.
- dd98677: Fail browser uploads before any network request with a typed `secure_context_required` error when HTTPS-only Web Crypto is unavailable, and surface actionable HTTPS guidance directly on failed attachment cards.
- 9af1666: Keep backward session-history pagination advancing across oversized legacy events by applying the canonical bounded read projection instead of failing the page, and report when a forensic response is no longer byte-for-byte exact.
- Updated dependencies [2d0fad4]
- Updated dependencies [9fe5c5b]
- Updated dependencies [c356468]
- Updated dependencies [dd98677]
- Updated dependencies [9af1666]
  - @opengeni/sdk@3.4.0

## 3.3.2

### Patch Changes

- Updated dependencies [5b9acd1]
  - @opengeni/sdk@3.3.2

## 3.3.1

### Patch Changes

- Updated dependencies [b471a90]
- Updated dependencies [96624a7]
- Updated dependencies [4bacdd3]
  - @opengeni/sdk@3.3.1

## 3.3.0

### Patch Changes

- Updated dependencies [ddce5cc]
- Updated dependencies [132c8d3]
  - @opengeni/sdk@3.3.0

## 3.2.1

### Patch Changes

- fd05df1: Cancel abandoned session detail, lineage, and goal reads after their final mounted consumer leaves while preserving shared reads for consumers that are still active.
- 7988c84: Fence the initiating browser tab before account-changing mutations and cancel abandoned session-page, draft, turn-policy, model-catalog, and realtime-catalog reads without interrupting remaining shared consumers.
- f499d32: Reconcile browser account authority when an invalidation supersedes the initiating fence or post-mutation host settlement, prevent stale dispatch after the peer-hold yield, and discard superseded retry commands.
- Updated dependencies [fd05df1]
- Updated dependencies [7988c84]
  - @opengeni/sdk@3.2.1

## 3.2.0

### Patch Changes

- 80d7594: Show a bounded, sensitive-safe opening-prompt preview while a session's durable automatic title is still pending, then yield automatically to the semantic agent title or a human rename.
- Updated dependencies [595939e]
- Updated dependencies [80d7594]
  - @opengeni/sdk@3.2.0

## 3.1.1

### Patch Changes

- ff4af61: Promote a normal human Send to Steer-equivalent replacement when an active session is waiting for human action, cancelling the stale decision surface and placing the conversational message directly in chat.
- 0bbaee2: Harden live and historical session timelines: preserve reader ownership through cumulative pointer movement and animated layout shrink, keep bidirectional history windows density-bounded and compact-cursor correct, schedule large window swaps without blocking the browser, and prevent unmatched tool outputs from settling unrelated calls.
- Updated dependencies [17d253b]
- Updated dependencies [c116379]
  - @opengeni/sdk@3.1.1

## 3.1.0

### Patch Changes

- Updated dependencies [7238fa4]
  - @opengeni/sdk@3.1.0

## 3.0.0

### Major Changes

- c525324: Add clickable composer attachment previews through the shared route-level lightbox with safe retained object-URL lifetimes, localized preview and lightbox control messages, full-chat file drag-and-drop affordances, and the updated reduced-motion-aware working indicator.

### Patch Changes

- c52c841: Show the timeline's Jump to latest control while a pinned session is catching up from meaningful pre-existing tip debt.
- 3887ad2: Bound composer draft read retries and ignore unchanged soft-reload projections to prevent request feedback loops during reconnects and transient gateway failures.
- 3a004ff: Preserve optional structured human-input answers, replay terminal settlements idempotently, and retain Slack replies when expiry or cancellation wins a response race.

## 2.6.0

### Minor Changes

- 5d4edd4: Add a public atomic composer application command shared by HTTP and in-process hosts, including atomic host-authorized resource augmentation without a trusted draft rewrite; add a receiver-safe narrow React session client constructor with host submit overrides and draft projection; and add presentation-only file-node filtering across the packaged workbench surfaces.
- 986f5fe: Add provider-neutral browser login session sets with bounded independently revocable slots, explicit actor switching, isolated add and re-authentication, scoped logout, non-enumerating cross-slot deep-link recovery, and rolling legacy/dual/broker compatibility.

### Patch Changes

- f1f7c22: Keep controlled composer inputs on the latest local draft while older autosave settlements render.
- 720ca4a: Render controlled composer edits synchronously before deferred host delivery settles.
- 27f3364: Clear ordinary Send drafts before host submission callbacks can re-project the submitted text.
- 82e72ce: Preserve the latest controlled composer edit across synchronous child-controller renders.
- 1135a6b: Keep pinned session streaming at the rendered layout tip so the viewport no longer reveals already-rendered output through a delayed catch-up glide.
- Updated dependencies [a7912ea]
- Updated dependencies [9ef491b]
- Updated dependencies [986f5fe]
- Updated dependencies [6e12f3a]
- Updated dependencies [9a8c822]
  - @opengeni/sdk@2.6.0

## 2.5.0

### Minor Changes

- 76d6396: Generate concise topic-oriented session titles with a prompt-free fallback, automatic-title safety normalization, custom-role and old-image rolling-compatible least-privilege database posture, and UI projections that never use raw initial prompts as display names. Durable title fanout now requires a versioned subscriber-recovery capability: managed NATS and supported embedded brokers coalesce one Postgres catch-up after reconnect, while legacy buses without that contract fail readiness/worker startup before durable rows can be acknowledged.

### Patch Changes

- 85e4f3c: Release committed older-history pagination ownership when projected rows stay unchanged, while preserving the legacy public callback return compatibility.
- d741f38: Make fresh session reads generation-aware, expose authoritative detail and list read revisions plus causal read generations, and keep retained pagination and independently polled pinned projections from overriding newer session channel authority.
- Updated dependencies [d741f38]
- Updated dependencies [b5071cf]
  - @opengeni/sdk@2.5.0

## 2.4.0

### Patch Changes

- c10f396: Keep one completed commentary reply visible when a tool-bearing turn settles without a final answer, including goal-wait holds, while preserving ordinary finals and avoiding disclosure duplicates.
- Updated dependencies [47b88d3]
- Updated dependencies [c5e4684]
- Updated dependencies [977fa0f]
- Updated dependencies [9d251cb]
- Updated dependencies [dc10a36]
  - @opengeni/sdk@2.4.0

## 2.3.0

### Patch Changes

- 4d83368: Separate worker-claim queue state from prompts genuinely waiting behind work, keep rapid sends on stable chat and queue surfaces, and make local development fail fast when schema or aggregate runtime readiness is lost.
- Updated dependencies [1b21135]
- Updated dependencies [f30555c]
- Updated dependencies [47ccfab]
- Updated dependencies [b74e557]
- Updated dependencies [6fd5aee]
- Updated dependencies [0fbf6b0]
- Updated dependencies [b2cd0f0]
  - @opengeni/sdk@2.3.0

## 2.2.0

### Minor Changes

- 4be2055: `requireSessionAuthorization` denies `session.approval.write` to every agent attempt on every surface: tool approvals stay human-only, while structured human input (`session.human_input.write`) remains answerable by a live attempt. The React queue chrome and timeline label the new child lifecycle notice kinds (`child_requires_action`, `child_requires_action_resolved`, `child_paused`, `child_waiting_capacity`, `child_progress`) instead of dropping them.
- 5d664d8: Surface why a goal is not pursuing and how long children have waited for a human. `Session.treeStats` gains optional `attentionSince` (earliest `requires_action` entry among the counted attention descendants), `Session` gains optional `requiresActionSince` on list and lineage reads, and the goal continuation projection gains optional `holdReason` for a `held_for_input` hold. `SessionChrome`'s goal pill spells out the pause reason ("Paused · cap" / "budget" / "by you" / "agent"), explains an idle-backoff check time and an agent `goal_wait` hold, and exports `sessionChromeGoalPillLabel` / `sessionChromeGoalPillExplanation`.

### Patch Changes

- e6ffdc7: Add the `backoff_pending` goal continuation reason (idle pacing between consecutive no-input continuations, `nextAttemptAt` at the pacing deadline) and the `SessionGoalResumedReason` / `SessionGoalResumedEventPayload` contracts for `goal.resumed` (`api` for the operator PATCH, `external_input` for the system resume of a `max_auto_continuations` pause). The React goal pill treats `backoff_pending` as ordinary scheduled work.
- 5e9795c: Derive Connected Machine list state from the durable heartbeat cursor instead of a live ControlRpc ping on every `GET /machines`, and share one `useMachines` poll per workspace+session.
- acd38d1: Retire Browser and Desktop resources when their source task leaves the Connected Machine that owns their controller, stop retrying the terminal placement conflict, and let Desktop create one replacement on the task's current placement.
- e91d89e: Open Markdown `sandbox:` file links in the current session's Files workbench, preserve exact decoded paths through the selected filesystem authority, reveal deep lazy-tree ancestors, and handle malformed references safely.
- Updated dependencies [4be2055]
- Updated dependencies [e6ffdc7]
- Updated dependencies [0b3b8df]
- Updated dependencies [bbd19e0]
- Updated dependencies [5d664d8]
  - @opengeni/sdk@2.2.0

## 2.1.1

### Patch Changes

- Updated dependencies [ab81e47]
  - @opengeni/sdk@2.1.1

## 2.1.0

### Minor Changes

- 438e476: Add explicit anonymous OpenAI-compatible model providers with credential-free
  transport, external billing attribution, catalog readiness, and an External
  picker rail while preserving older client parsing by classifying the route from
  existing billing metadata instead of widening closed client enums. Anonymous
  providers reject all configured request headers and query parameters, and the
  runtime strips credential-like headers as a defense in depth. Document the
  temporary OpenCode Zen free-preview configuration.
  Generic Chat Completions routes also reject an `unknown` finish reason before
  accepting a terminal response, so the same accepted turn recovers from durable
  history without executing tools from ambiguous output.
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
- c9faa51: Replace the horizontally scrolling workspace tabs with a responsive vertical
  activity rail, add a panel-local Hide workspace action, and distinguish managed
  sleeping compute from genuinely offline Connected Machines.

### Patch Changes

- 66593eb: Reconcile and verify the session-list visibility predicate grant when a fresh
  deployment runs migrations before creating its restricted application role,
  and keep app-supplied composer controls shrinkable within a single footer row.
- 650d6f9: Route OpenSandbox browser and computer streams through the API frame-proxy so the workbench can show live JPEG/RFB when the lifecycle proxy cannot carry browserd WebSocket grants.
- 52456f9: Expose the personal-resource attachment contracts from the SDK and preserve
  atomic attachment intent through durable React composer Send/Steer delivery,
  including exact uncertain retries and authoritative stale-epoch
  reconfirmation. The managed web console can now choose fixed personal Variable
  Sets and Rigs for create and attach them with once, session, or always scope.
- 5880ec8: Keep channel/project hooks cache-coherent across mounted consumers, including immediate confirmed-create projections with stale-read protection and failure rollback.
- 428300c: Open agent `sandbox:/workspace/...:line` links in the Files workbench at that line, and accept `/workspace/...` hrefs as the same session-local file shape.
- 0e5a644: Keep structured human-input decisions in the main conversation: pending forms
  render at the timeline tip, settled history preserves both the agent's question
  and the human's readable answer, the duplicate generic Ask step is omitted, and
  every choice question offers an inline Other answer without losing exact text.
- 7918925: Keep optimistic user messages continuously mounted while their canonical durable events arrive, and show actionable delivery failures without an ordinary sending label.
- Updated dependencies [3e1ad07]
- Updated dependencies [438e476]
- Updated dependencies [ebb3669]
- Updated dependencies [dc8c73f]
- Updated dependencies [9b4d5d5]
- Updated dependencies [492fb71]
- Updated dependencies [fbc760e]
- Updated dependencies [650d6f9]
- Updated dependencies [fe54954]
- Updated dependencies [f7497fd]
- Updated dependencies [ff011e6]
- Updated dependencies [ba0be3d]
- Updated dependencies [52456f9]
- Updated dependencies [c7cafb1]
- Updated dependencies [5a651c8]
- Updated dependencies [48b9f09]
  - @opengeni/sdk@2.1.0

## 2.0.1

### Patch Changes

- 6f61d6e: Mint public `wss` live-view proxy URLs behind TLS terminators. Drain existing sandbox leases even when ownership is off. Treat ownership-disabled stream-capabilities as no live sandbox.
- 21728f0: Preserve in-progress structured human-input answers when live session updates refresh the same pending request.
- Updated dependencies [6f61d6e]
  - @opengeni/sdk@2.0.1

## 2.0.0

### Minor Changes

- 1c78ed0: Separate new-session and established-session composer policy authority. Exact draft submission now atomically freezes queued-turn text, resources, model, reasoning, and latency, then rotates the server draft; queue Edit restores that exact snapshot and stale revisions surface as conflicts instead of silent rebases.

### Patch Changes

- 5dc88ef: Terminalize attached Chrome Browser/Computer sessions when the device connection generation changes, stop Reconnect from retrying the stale placement, and physically stop ScreenCaptureKit helpers so replayd cannot accumulate.
- Updated dependencies [1c78ed0]
- Updated dependencies [79ee99b]
- Updated dependencies [2cb04e0]
  - @opengeni/sdk@2.0.0

## 1.2.0

### Minor Changes

- b05130a: Hard-cut editable spreadsheets to authored-only canonical state, deterministic formula projections, and explicit current compatibility protocols. Preserve React compatibility with artifact-tool 0.1 and 0.2 while adding the 0.3 line.

### Patch Changes

- 0a6c577: Keep periodic workspace snapshots off the first provider-request critical path, clarify the overlapping runtime/model-preparation timing in the session timeline, and promote the complete signed Agent 0.1.16 bundle as the default stable installer target.
- Updated dependencies [b05130a]
  - @opengeni/sdk@1.2.0

## 1.1.1

### Patch Changes

- @opengeni/sdk@1.1.1

## 1.1.0

### Minor Changes

- 1f860f0: Add durable publication and authenticated download support for session sandbox files. Agents can publish bounded `/workspace` outputs through a first-party tool, raw sandbox links can recover through the session API, retained file receipts render with downloads, and retained screenshots expose an explicit download action.

### Patch Changes

- 987742d: Reduce turn-start overhead without reducing admitted history, rig variables, or
  user-visible content. Active history loads in one admitted query, automatic
  compaction skips duplicate history work below threshold, unchanged Codex
  credential pointers avoid redundant session-activity writes, rig defaults
  load at bounded concurrency for admitted worker attempts, and the attempt-scoped
  MCP wrapper no longer reuses a broader process-global tool list.

  Improve large-session interaction by measuring rich-message disclosure without
  a second React commit, showing truthful pending queue actions immediately, and
  replacing the false zero-step placeholder with the session's real lifecycle.

- Updated dependencies [ca75ed9]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [c297fc0]
- Updated dependencies [1f860f0]
- Updated dependencies [c297fc0]
- Updated dependencies [22c0c21]
- Updated dependencies [30ba620]
- Updated dependencies [6860c5f]
- Updated dependencies [c297fc0]
- Updated dependencies [6c45ceb]
  - @opengeni/sdk@1.1.0

## 1.0.3

### Patch Changes

- 2a69f65: Keep versioned direct-session web builds within the measured release bundle contract.

## 1.0.2

### Patch Changes

- e0e0102: Unify browser, computer, identity, realtime, and Codemode behavior across managed sandboxes and connected machines.
- 4d1ed07: Preserve complete bounded lazy-search tool schemas across durable model history, expose Linux desktop application launch when the image supports it, suppress the managed Chrome sandbox warning, label Computer sessions as Desktops in the UI, and keep AnyDoc available in headed desktop sandboxes.
- 79f57b5: Present an active goal yielding to a foreground human turn as waiting instead of blocked, and keep active-goal elapsed time advancing.
- ffbbf4c: Add organization, workspace, and owner-private Variable Set scopes with independent metadata, plaintext-read, write, attachment, and runtime-use authority. Runtime secret materialization now revalidates the exact live attempt and personal grant immediately before ciphertext egress while audits remain value-free.
- d34dd9a: Add revision-fenced per-command memory and CPU policies for Connected Machines, exact live runner capability gating, and lifecycle-safe Linux operation accounting without introducing default resource limits.
- Updated dependencies [90c0c3e]
- Updated dependencies [e0e0102]
- Updated dependencies [d7dfc01]
- Updated dependencies [ffbbf4c]
- Updated dependencies [d34dd9a]
- Updated dependencies [d2f172c]
- Updated dependencies [c056063]
  - @opengeni/sdk@1.0.2

## 1.0.1

### Patch Changes

- 8bb860b: Keep embedded client configurations synchronized with the exported API contract revision and document the fail-closed host integration boundary.
- Updated dependencies [8bb860b]
  - @opengeni/sdk@1.0.1

## 1.0.0

### Major Changes

- 083387e: Replace the removed per-turn `turnInstructions` system-prefix contract with generic per-message `modelContext` content. This is a breaking release-train cutover: old mutating clients are rejected after migration 0240. Context now enters canonical user history without standard timeline rendering, preserves the persistent prompt-cache prefix, and works across initial, queued, steer, realtime delegation, and transcript handoff paths.

### Patch Changes

- 1ef18cc: Deduplicate realtime model catalog loads and reuse settled catalogs across embedded control remounts.
- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/sdk@1.0.0

## 0.57.0

### Patch Changes

- d86610d: Prevent deterministic model-generated worker-spawn failures, hide exhausted nested-agent creation, and show bounded structured session orchestration diagnostics in worker timeline rows while preserving the advanced public REST/SDK create contract.
- d86610d: Run published HTML artifacts as exact source in an opaque-origin sandbox, raise their UTF-8 ceiling to 4 MiB, and expose reusable React rendering. Add deployment-configurable default and allowed built-in session tools plus configured shared-key delegation fallback.
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/sdk@0.57.0

## 0.56.0

### Minor Changes

- b0b2bed: Add unified browser and computer interaction APIs, reusable browser identities, native input, live streaming, and React viewer controls across managed sandboxes and connected machines.

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/sdk@0.56.0

## 0.55.0

### Minor Changes

- 8beed26: Add managed-human organization membership discovery. Expose the exact active
  self-membership and personal-workspace identity returned by the existing
  narrow provisioning capability through a managed-session-only API route and
  typed SDK method, while denying delegated/API-key principals and terminal
  memberships.

### Patch Changes

- Updated dependencies [8beed26]
  - @opengeni/sdk@0.55.0

## 0.54.0

### Patch Changes

- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
  - @opengeni/sdk@0.54.0

## 0.53.1

### Patch Changes

- @opengeni/sdk@0.53.1

## 0.53.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.

### Patch Changes

- Updated dependencies [d2def0c]
- Updated dependencies [5215c0e]
  - @opengeni/sdk@0.53.0

## 0.52.1

### Patch Changes

- 5c5ea4a: Add the universal capabilities platform with named API integration instances,
  provider-specific feature bindings, and local runtime adapters.
- Updated dependencies [5c5ea4a]
  - @opengeni/sdk@0.52.1

## 0.52.0

### Patch Changes

- Updated dependencies [8b6803a]
- Updated dependencies [aeb07f4]
- Updated dependencies [ff7203c]
  - @opengeni/sdk@0.52.0

## 0.51.0

### Minor Changes

- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.

### Patch Changes

- 2f4ce5e: Add durable Seedance video generation with workspace model and funding policy,
  secure media references, retained video artifacts, sandbox materialization,
  OpenGeni-credit and workspace-gateway funding, and SDK/React playback surfaces.
- 76e54a9: Keep mobile voice-input Cancel and Stop controls visible while recording in crowded composer footers.
- bd5514e: Add explicitly enabled provider-neutral knowledge-source schedules with durable wake provenance, generation-fenced execution checkpoints and index obligations, fail-closed ACL activation seams, no-agent execution, layered pause state, shared schedule administration, and Google Drive source lifecycle integration.
- 90eea29: Make connected-machine removal show every dependent session and support an explicit canonical move-to-default-sandbox confirmation before revocation. Default moves prove managed sandbox readiness through the existing fleet route, active turns remain fail-closed, and typed swap rejections surface as visible errors instead of false success.
- Updated dependencies [b46f4de]
- Updated dependencies [2f4ce5e]
- Updated dependencies [d55a093]
- Updated dependencies [dcfe6eb]
- Updated dependencies [ad9123b]
- Updated dependencies [bd5514e]
- Updated dependencies [90eea29]
- Updated dependencies [a858835]
  - @opengeni/sdk@0.51.0

## 0.50.1

### Patch Changes

- 98b94e8: Project physical cancellation immediately from atomic Steer and Pause receipts, then reconcile it against durable queue truth.
- Updated dependencies [98b94e8]
- Updated dependencies [2cd6dce]
  - @opengeni/sdk@0.50.1

## 0.50.0

### Minor Changes

- 7b2d5ff: Add trust-gated in-session capability recommendations, human-owned authorization
  requests, and a GitHub owner-consent flow that returns to the initiating session.
- d1189ba: Add the OpenGeni-owned document, spreadsheet, and presentation authoring engine,
  its durable API/domain/live-sync surfaces, first-party React workbench, and
  editable-artifact client SDK. Publish independently lazy, identity-pinned browser
  WASM runtimes for each editor modality.

### Patch Changes

- Updated dependencies [7b2d5ff]
- Updated dependencies [d1189ba]
  - @opengeni/sdk@0.50.0

## 0.49.9

### Patch Changes

- 727b186: Keep the session timeline entry compatible with React Native Metro and Hermes bundles.
- 245baf7: Preserve Changes rail focus and scroll while safely resetting virtualization after diff shrinks.

## 0.49.8

### Patch Changes

- ef78ecf: Separate credential-free capability discovery from exact, permission-checked live-plane grants; mint terminal credentials just in time, preserve first input across connection setup, and bound pre-open terminal memory.
- Updated dependencies [ef78ecf]
  - @opengeni/sdk@0.49.8

## 0.49.7

### Patch Changes

- 422d1d8: Expose semantic terminal readiness, prevent pre-connect focus from silently dropping keystrokes, and let browser automation wait for live PTY input.

## 0.49.6

### Patch Changes

- 49be13b: Preserve dirty code-editor buffers and their guarded-save baseline across live same-file refreshes.

## 0.49.5

### Patch Changes

- 6f31d0d: Require an authoritative warm sandbox before capture-backed workbench hooks issue live reads during capability negotiation.

## 0.49.4

### Patch Changes

- e627d88: Keep known-cold sandbox views passive, fence delayed live-read invalidations across draining transitions, and expose bounded structural Channel-A failure diagnostics without leaking provider details.

## 0.49.3

### Patch Changes

- e2edfbc: Add provider-aware image generation with permanent verified artifacts,
  prompt-cache-safe history, sandbox materialization, and SDK/React rendering.
- db82911: Keep teardown-owned workspaces capture-backed until explicit reacquisition reaches warm, and prevent historical events or capability reads from issuing provider I/O during teardown.
- Updated dependencies [e2edfbc]
  - @opengeni/sdk@0.49.3

## 0.49.2

### Patch Changes

- bdac906: Open the live desktop automatically when its viewer mounts instead of requiring a confirmation click.
  - @opengeni/sdk@0.49.0

## 0.49.1

### Patch Changes

- bdbdf5c: Render bounded tool-output previews with explicit delivery and full-evidence truncation facts.

## 0.49.0

### Patch Changes

- Updated dependencies [bb9a346]
  - @opengeni/sdk@0.49.0

## 0.48.2

### Patch Changes

- 74e7a31: Cancel Modal commands that stall before provider yield without bypassing physical quiescence, and show the truthful stopping state while replacement work waits.

## 0.48.1

### Patch Changes

- 86bd95c: Preserve committed-only workspace captures and load multi-repository Git changes in bounded batches.

## 0.48.0

### Minor Changes

- fed43cf: Make embedded Files and Changes durable and responsive: capture complete branch comparisons, batch file-frontier and multi-repository Git reads behind one sandbox lease, preserve live stream responsiveness during reconciliation, harden portable sandbox reads, and polish the workbench's file tree, resizable panes, machine/terminal states, and embedded composer geometry.

### Patch Changes

- Updated dependencies [fed43cf]
  - @opengeni/sdk@0.48.0

## 0.47.1

### Patch Changes

- 5dfb93d: Keep derived design tokens available through both the compiled stylesheet and the Tailwind source bridge while sharing compact public fallbacks, so SessionChrome retains its complete default presentation without duplicating color formulas in application bundles.
- 5dfb93d: Let one Connected Machine agent retain and serve independent connections to multiple OpenGeni workspaces and deployments, with additive connection UX and connection-scoped runtime isolation.
- Updated dependencies [200586a]
  - @opengeni/sdk@0.47.1

## 0.47.0

### Minor Changes

- d8b9b71: Add opt-in container-responsive `ChatComposer` and `Composer.Root` layout, including source-container-aware portalled model and realtime menus while preserving viewport defaults.
- d8b9b71: Ship a ready-to-use, Preflight-free compiled CSS entry scoped to OpenGeni React roots, while retaining the Tailwind v4 bridge and CSS-free session surface.

## 0.46.6

### Patch Changes

- 43fa8f4: Expose authorized Codex Apps through the server-authoritative tool catalog and make setup recovery actionable without widening explicit session policies.
- 70ced80: Add an offline-safe Connected Machine enrollment removal lifecycle with credential revocation, durable audit history, guarded route and lease handling, SDK/MCP support, and accessible active-list reconciliation.
- Updated dependencies [70ced80]
  - @opengeni/sdk@0.46.6

## 0.46.5

### Patch Changes

- 43d45c6: Keep saved voice recordings on their original retry deadline during live UI renders, and normalize connector tool results whose optional structured payload is null without changing tool routing.
  - @opengeni/sdk@0.46.4

## 0.46.4

### Patch Changes

- b783f12: Keep optional MCP setup authentication out of unrelated chat timelines while preserving actionable tool-call reconnect events.
- 34c5cdb: Retain validated computer screenshots as authenticated, integrity-checked session artifacts with bounded event/history receipts, SDK range assembly, and React rendering while preserving historical inline-image compatibility.

  Fence screenshot cleanup and quota accounting across parent deletion, duplicate settlement, expiry, compensation, and garbage-collection races so provider objects are deleted only after durable lifecycle ownership and quota is released exactly once.

- 252095e: Keep durable composer voice recordings in automatic bounded recovery after transient failures, while requiring explicit insertion for every delayed or reload-recovered transcript.
- 4fd349d: Revoke attachment preview URLs on unmount even when React has not committed their attachment state yet.
- Updated dependencies [5d8bb99]
- Updated dependencies [34c5cdb]
  - @opengeni/sdk@0.46.4

## 0.46.3

### Patch Changes

- 800d091: Clear file attachments when their client or workspace changes, revoke outstanding preview URLs on unmount, fence late upload settlements from stale scopes, and reset Changes-tab virtualization measurements when a same-size diff is replaced.
- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- 23de73b: Add explicitly permissioned, audited plaintext reads for encrypted workspace variable-set values across REST, SDK, React, MCP, and UI surfaces.
- Updated dependencies [30a0b9a]
- Updated dependencies [23de73b]
  - @opengeni/sdk@0.46.3

## 0.46.2

### Patch Changes

- 5d1d0c2: Make browser live streams visibility-aware, share one routed session feed,
  bound reconciliation and heartbeat recovery, coalesce overlapping reads, and
  expose the append, publish, and SSE connection lifecycle in metrics.
- ce823ce: Replace first-party MCP mutation entity echoes with strict, versioned compact
  receipts; add bounded scheduled-task list/detail projections and preserve worker
  session references across receipt and legacy timeline results.
- Updated dependencies [5d1d0c2]
  - @opengeni/sdk@0.46.2

## 0.46.1

### Patch Changes

- 2bfbfcc: Keep compact desktop controls while giving mobile model, voice, navigation,
  composer, and session controls full-size touch targets.

## 0.46.0

### Minor Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.

### Patch Changes

- 5b6d36e: Use provider-reported usage rather than whole-request approximations for automatic context compaction, preserve provider-only input-token state across context rewrites, and label timeline counts as estimated conversation-history tokens.
- Updated dependencies [6eb0b23]
  - @opengeni/sdk@0.46.0

## 0.45.1

### Patch Changes

- ca7d125: Improve mobile touch targets and responsive session interactions across the React surfaces.

## 0.45.0

### Minor Changes

- 7faf6a9: Add a lossless `UserMessageBody` disclosure for very tall sent messages, including per-message expansion memory and timeline-owned scroll anchoring.

## 0.44.6

### Patch Changes

- 69bc207: Keep Codex history canonical across subscriptions and providers, separate optional owner-designated Codex Apps authority from inference allocation, and fence Apps authorization through each remote request.
- Updated dependencies [69bc207]
- Updated dependencies [c0f8e40]
  - @opengeni/sdk@0.44.6

## 0.44.5

### Patch Changes

- 4e39d4d: Keep the Northstar demo's host font reset contained to embedded OpenGeni surfaces.

## 0.44.4

### Patch Changes

- 9159e64: Add render-compatible runtime typography and model-picker density tokens, a compact embedded preset, host-reset-safe component typography, and token propagation for portalled model and realtime menus.

## 0.44.3

### Patch Changes

- Updated dependencies [4502474]
  - @opengeni/sdk@0.44.3

## 0.44.2

### Patch Changes

- 2542ae0: Recover stale composer-draft OCC after tab sleep by recognizing DRAFT_CHANGED, soft-reloading on wake, and retrying autosave with the server revision while keeping local text.
- 2542ae0: Give progressive `tool_search` its own timeline card: capability query, disclosed tool leaves with source prefixes, and quiet no-match / failure states instead of the generic Done dump.

## 0.44.1

### Patch Changes

- e051404: Measure composer textarea height off-DOM so multi-line typing no longer collapses the live box and yanks tip-follow.
- 99e9b48: Give the realtime voice controls an accessible named group role.

## 0.44.0

### Patch Changes

- Updated dependencies [664c1d8]
  - @opengeni/sdk@0.44.0

## 0.43.1

### Patch Changes

- Updated dependencies [c9d8b69]
  - @opengeni/sdk@0.43.1

## 0.43.0

### Patch Changes

- b6e39fc: Polish session chrome and apply_patch rendering; clarify realtime voice-end handoff.

  SessionChrome gets denser selected-chip UX and Codex function-tool apply_patch shapes render in the specialized diff UI. Solo goal_continuation machine-input rows are suppressed in favor of the GoalRow landmark. The realtime transcript-tail instruction now keeps in-flight work going after voice ends.

- Updated dependencies [b6e39fc]
- Updated dependencies [bef5920]
  - @opengeni/sdk@0.43.0

## 0.42.1

### Patch Changes

- Updated dependencies [4976e1c]
  - @opengeni/sdk@0.42.1

## 0.42.0

### Patch Changes

- Updated dependencies [fd13ba9]
  - @opengeni/sdk@0.42.0

## 0.41.1

### Patch Changes

- abe0de6: Persist timesliced composer voice recordings in browser storage with reload-safe document ownership, opener/duplicate-tab fencing, oldest-first recovery, byte-ceiling enforcement, and durable transcript-before-draft handoff. Interrupted audio retries reuse the same recording, uncertain saved transcripts require explicit insertion instead of automatic retranscription or duplicate append, and transient handed-off cleanup failures are retried and garbage-collected owner-safely.
- Updated dependencies [abe0de6]
  - @opengeni/sdk@0.41.1

## 0.41.0

### Patch Changes

- Updated dependencies [00f7d3b]
  - @opengeni/sdk@0.41.0

## 0.40.0

### Minor Changes

- a49692d: Publish the provider-neutral realtime controller and the exact OpenGeni realtime composer experience at `@opengeni/sdk/realtime` and `@opengeni/react/realtime`, including proxy-friendly client contracts, batteries-included existing/new-session controls, and the public reference demo.

### Patch Changes

- Updated dependencies [b121e7c]
- Updated dependencies [a49692d]
  - @opengeni/sdk@0.40.0

## 0.39.0

### Patch Changes

- Updated dependencies [b83af7a]
  - @opengeni/sdk@0.39.0

## 0.38.1

### Patch Changes

- d299c54: Keep captured-file actions legible and ensure the hosted voice-options control meets its minimum target size.

## 0.38.0

### Patch Changes

- 763aa97: Preserve a latency-mode selection made while a durable composer draft is loading.
- Updated dependencies [1d0f2ae]
- Updated dependencies [3e4842d]
  - @opengeni/sdk@0.38.0

## 0.37.0

### Minor Changes

- 1c49020: Publish the full model, reasoning-effort, and latency-mode picker used by the web app as a reusable, token-themed React component.

### Patch Changes

- Updated dependencies [13b961e]
- Updated dependencies [e03397d]
- Updated dependencies [4f15920]
- Updated dependencies [3baaebd]
  - @opengeni/sdk@0.37.0

## 0.36.2

### Patch Changes

- b4982fa: Expose GPT-5.6 Max reasoning end to end for managed and connected Codex models.
- Updated dependencies [e62495f]
- Updated dependencies [b4982fa]
  - @opengeni/sdk@0.36.2

## 0.36.1

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.
- Updated dependencies [9c4d73d]
  - @opengeni/sdk@0.36.1

## 0.36.0

### Patch Changes

- Updated dependencies [8b3e46f]
  - @opengeni/sdk@0.36.0

## 0.35.3

### Patch Changes

- a299919: Make horizontally scrollable Markdown code blocks and tables reachable from the keyboard.

## 0.35.2

### Patch Changes

- 83ac3b6: Keep a malformed or unavailable timeline renderer from crashing the entire conversation by isolating each timeline group behind a visible fallback, then retry the row when its renderer inputs change.
  - @opengeni/sdk@0.35.0

## 0.35.1

### Patch Changes

- b286dad: Keep fleet-decision timeline rows mounted when unrelated session metadata, including personal pin state, changes.

## 0.35.0

### Minor Changes

- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.

### Patch Changes

- Updated dependencies [dd71248]
  - @opengeni/sdk@0.35.0

## 0.34.3

### Patch Changes

- ea344d6: Keep agent goal tools inside the activity cluster (no breakaway GoalRow split),
  allow collapsing live turn step shells, and keep densified Workspace hub /
  timeline disclosure changes under a stable Radix vendor chunk.

## 0.34.2

### Patch Changes

- 9840496: Avoid replacing an in-flight initial workspace-capture read when the matching capture announcement arrives first.

## 0.34.1

### Patch Changes

- Updated dependencies [408543f]
  - @opengeni/sdk@0.34.1

## 0.34.0

### Patch Changes

- Updated dependencies [ec0bc02]
- Updated dependencies [5a4c559]
  - @opengeni/sdk@0.34.0

## 0.33.1

### Patch Changes

- b5f2fb5: Keep live workbench acceptance aligned with the hosted controlled-panel contract and remove a real-time boundary from its related React regression coverage.
- Updated dependencies [8243ffe]
  - @opengeni/sdk@0.33.1

## 0.33.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

### Patch Changes

- Updated dependencies [1ec9912]
  - @opengeni/sdk@0.33.0

## 0.32.1

### Patch Changes

- c52acc0: Ship Fast latency mode with turn-column inheritance, Codex ChatGPT honor-skip for response service_tier, and model picker UX polish.
- 48ae722: Smooth tip-follow camera and streaming timeline motion (settle folds, tool enter, fence soft-close).
- Updated dependencies [c52acc0]
  - @opengeni/sdk@0.32.1

## 0.32.0

### Patch Changes

- Updated dependencies [f413e6c]
  - @opengeni/sdk@0.32.0

## 0.31.0

### Minor Changes

- 42428a2: Add per-session Codex remote compaction v2 (`remote_v2` / `portable`), with UI landmarks, Codex-only model locking, and opaque token accounting aligned to Codex CLI.

### Patch Changes

- b2e975f: Advance the merged knowledge release train to fresh publication identities without changing runtime behavior. This corrective source is derived from current main and does not reuse generated release output.
- Updated dependencies [0199108]
- Updated dependencies [42428a2]
- Updated dependencies [b2e975f]
  - @opengeni/sdk@0.31.0

## Unreleased

- Copy affordances: fenced code + tables in `Markdown`, hover copy on user/assistant messages, and "Copy turn" on settled turn chips (includes the lifted final answer).
- Session timeline history navigation: `loadOldest` / `loadNewer` / `jumpToLatest` on `useSessionEvents`, plus Jump to start / Jump to latest chrome on `MessageTimeline` (bounded windows; no middle gap walk).
- Add `SessionChrome` — production/embed session-signal dock (incoming / queue / goal / agents) with token overrides (`--og-session-chrome-*`), token tooltips, crossfade panel switches, and queue hover actions wired to `UseTurnQueueResult`. Replaces stacked `QueueSurface` + host goal/agents chrome in the web session route.
- Export shared `Tooltip*` primitives used by SessionChrome (portal-token aware).
- Fix SessionChrome tooltips: inverted tip surface uses inline fg/bg so `.og-root` cannot blank the text; tip only icon actions; Steer copy matches QueueSurface (`Make this the next direction`).
- Light ChatComposer spacing/token freshen (quieter focus border, tighter footer/input padding).
- Replace host-adapter composer transcription with native MediaRecorder capture and immediate server transcription.
- Compact composer voice chrome: live/fallback waveform, separate cancel vs stop-and-transcribe actions, and a quieter transcribing state.

## 0.30.2

### Patch Changes

- 84fb671: Prevent a ready file restored during reconnect from being counted twice across the durable composer draft and the still-live attachment card. Canonical duplicate refs are removed before draft persistence and composer submission while custom mounts and exact draft revision/content conflict protection remain intact.
- 96eb64b: Advance the reviewed knowledge release package graph to fresh publishable identities after the previous version projection was invalidated. This changes release metadata only and does not alter runtime behavior.
- Updated dependencies [96eb64b]
  - @opengeni/sdk@0.30.2

## 0.30.1

### Patch Changes

- Updated dependencies [bbcbef5]
- Updated dependencies [ddff8db]
  - @opengeni/sdk@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [1f6f13f]
  - @opengeni/sdk@0.30.0

## 0.29.3

### Patch Changes

- 8dca209: Remove redundant success glyphs from collapsed turn summaries while preserving failed, cancelled, and active state indicators.
- 821f664: Seed shared session-event cursors from loaded history to prevent historical replay storms, and preserve the MCP SDK's exact request-timeout classification through safe transport-error sanitization.

## 0.29.2

### Patch Changes

- ad0bdc3: Surface managed-credit admission rejections with actionable composer recovery guidance while preserving drafts and attachments, and canonicalize default attachment mounts across established-session draft admission and replay.
  - @opengeni/sdk@0.29.0

## 0.29.1

### Patch Changes

- 8478e60: Default workspace-tracking sessions to every configured MCP server while
  preserving exact explicit API allow-lists. Keep OpenGeni's internal carrier and
  default-on Files surface out of the web picker's visible choices and counts.
  Settle provider-native web searches from their own terminal status, render each
  web action truthfully, keep completed searches before the answer they informed,
  and hide unresolved private citation handles from the human timeline.

## 0.29.0

### Patch Changes

- Updated dependencies [33dc88f]
  - @opengeni/sdk@0.29.0

## 0.28.3

### Patch Changes

- 1c4018e: Replace one-turn tool overrides with one durable session tool policy, expose
  OpenGeni-native tools in the same selection, default available tools on, and
  render delivered machine inputs as compact typed timeline updates instead of
  raw protocol JSON.
- Updated dependencies [28c678d]
- Updated dependencies [1c4018e]
  - @opengeni/sdk@0.28.3

## 0.28.2

### Patch Changes

- c1dcccc: Publish the current client surfaces from one exact reviewed source revision.
- Updated dependencies [c1dcccc]
  - @opengeni/sdk@0.28.2

## 0.28.1

### Patch Changes

- 2ec6494: Publish the current client surfaces from one exact reviewed source revision.
- Updated dependencies [2ec6494]
  - @opengeni/sdk@0.28.1

## 0.28.0

### Minor Changes

- 29ad09b: Persist typed machine inputs into canonical model history at turn claim, expose
  authoritative pending-input queue projections and lifecycle events, render
  delivered batches in the timeline, and preserve append-only prompt-cache
  prefixes across tools, later turns, recovery, and explicit compaction.

### Patch Changes

- 8eaa377: Add per-timeline `add`, `remove`, and `replace` customization for collapsed turn summary facets while preserving the existing defaults.
- 8eaa377: Expose transport-tolerant MCP output normalization from the SDK and reuse it in the React timeline parser.
- Updated dependencies [29ad09b]
- Updated dependencies [8eaa377]
- Updated dependencies [dfc3235]
  - @opengeni/sdk@0.28.0

## 0.27.0

### Patch Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.
- Updated dependencies [519d93c]
  - @opengeni/sdk@0.27.0

## 0.26.3

### Patch Changes

- Updated dependencies [110bb77]
  - @opengeni/sdk@0.26.3

## 0.26.2

### Patch Changes

- f92af07: Give each session-only React hook an exact structural client contract so embedded hosts can use session reads, goals, lineage, file attachments, structured human input, and MCP approval policies without implementing unrelated composer, queue, workspace, or workbench APIs.

## 0.26.1

### Patch Changes

- ffd246c: Keep workspace-capture Git status, diffs, and untracked files below provider retained-output limits, and publish an explicit degraded revision instead of an authoritative empty diff when repository reads fail.
- Updated dependencies [ffd246c]
  - @opengeni/sdk@0.26.1

## 0.26.0

### Patch Changes

- Updated dependencies [06a5801]
- Updated dependencies [5511c24]
  - @opengeni/sdk@0.26.0

## 0.25.5

### Patch Changes

- 6f0690d: Preserve persisted tool-call correlation and bounded truncation telemetry when loading timeline history.
- Updated dependencies [9a8f793]
- Updated dependencies [c135339]
  - @opengeni/sdk@0.25.5

## 0.25.4

### Patch Changes

- 5846352: Keep the session-only React entry provider-free by resolving session hooks through the session context, preserving the exclusion of provider and workbench dependencies.

## 0.25.3

### Patch Changes

- a0f2442: Return typed correlation-safe API failures, discard bounded non-JSON gateway bodies in the SDK, preserve retryability and ambiguous mutation outcomes, and keep composer drafts stable across transient failures and live policy rerenders.
- Updated dependencies [a0f2442]
  - @opengeni/sdk@0.25.3

## 0.25.2

### Patch Changes

- Updated dependencies [85cb323]
  - @opengeni/sdk@0.25.2

## 0.25.1

### Patch Changes

- 9db6c17: Prevent live session and policy rerenders from repeatedly fetching the same composer draft while preserving target, explicit, and event-driven reloads.
  - @opengeni/sdk@0.25.0

## 0.25.0

### Patch Changes

- c549ed8: Persist and transactionally materialize revisioned active-goal continuation
  obligations, recover their Temporal delivery without human input or model
  polling, preserve authoritative human/Steer ordering, and expose truthful
  scheduled, running, blocked, and invariant-broken continuation state to clients.
  Make agent goal updates revisioned, attempt-recoverable commands so ambiguous
  commit responses reconcile without duplicate mutation or stale overwrites.
- 860de22: Persist actor-private pre-session drafts on the server, consume only the exact accepted revision after durable session initialization, return structured create errors, deduplicate create resources, derive checksums for SDK uploads, restore finalized attachments without browser-local byte authority, and preserve attachments added while an earlier send is in flight.
- Updated dependencies [c549ed8]
- Updated dependencies [46bac05]
- Updated dependencies [860de22]
- Updated dependencies [5b57a2d]
  - @opengeni/sdk@0.25.0

## 0.24.0

### Minor Changes

- 0ed0f01: Add per-member session pin preferences with isolated server persistence, bounded/reused stable
  pagination snapshots, snapshot-free pin polling, typed SDK and React reconciliation, and accessible
  list and header controls.

### Patch Changes

- 744a93d: Add default-off, bounded adaptive Codex fleet decision telemetry with strict deterministic replay, cache-aware and work-conserving policy simulation, secret-safe event/UI observability, and independent future policy gates.
- Updated dependencies [744a93d]
- Updated dependencies [0ed0f01]
  - @opengeni/sdk@0.24.0

## 0.23.0

### Minor Changes

- 0d60720: Add capability-first session tool policies with omission-as-discovery defaults,
  explicit per-turn narrowing and child inheritance, secret-safe effective-policy
  projections, stable lazy `tool_search` catalogs, and matching API, SDK, React,
  worker, embedding, and audit contracts.

  Harden credential-bearing MCP and OAuth traffic with destination-bound
  credentials, single-resolution DNS-pinned transport, bounded catalogs, schemas,
  results, request and response bodies, and independently validated manual
  redirects. Extend renewable, session-bound Toolspace access to connected
  machines while dynamically fencing every call to the session's active attempt.

### Patch Changes

- Updated dependencies [0d60720]
- Updated dependencies [bdd531c]
- Updated dependencies [3214d70]
  - @opengeni/sdk@0.23.0

## 0.22.1

### Patch Changes

- Updated dependencies [524599e]
  - @opengeni/sdk@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies [229902b]
  - @opengeni/sdk@0.22.0

## 0.21.2

### Patch Changes

- Updated dependencies [4966649]
  - @opengeni/sdk@0.21.2

## 0.21.1

### Patch Changes

- bd46c89: Mount long session timelines progressively so the newest activity paints first and low-end browsers remain responsive while older groups hydrate.
- Updated dependencies [ff23da5]
  - @opengeni/sdk@0.21.1

## 0.21.0

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
  - @opengeni/sdk@0.21.0

## 0.20.0

### Minor Changes

- 9f84cc9: Add durable host-provided per-turn instructions, headless structured-input hooks, host-local queue
  focus, and reusable approval and human-input surfaces for embedded session consumers.

### Patch Changes

- Updated dependencies [9f84cc9]
  - @opengeni/sdk@0.20.0

## 0.19.0

### Minor Changes

- 3aee519: Add a workspace-accepted, provider-agnostic transcription policy and host-adapter contract, plus an accessible composer microphone that keeps partials ephemeral and appends non-empty accepted finals to the editable draft exactly once. Policies explicitly accept automatic language detection and speaker diarization, events can carry strict neutral result metadata, pending starts and cleanup are abortable/bounded, and adapter failures stay behind controlled UI copy with redacted non-UI diagnostics.

### Patch Changes

- 136227e: Add an immutable, versioned curated skill library with explicit workspace selection and inspectable provenance, and preserve WCAG AA contrast for dark-theme primary actions.
- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/sdk@0.19.0

## 0.18.0

### Minor Changes

- 5547b2f: Let embedders allowlist Changes, Files, Terminal, and Desktop workbench surfaces while keeping disabled surfaces behaviorally dormant.
- 4401ce7: Add a scope-checked host MCP credential resolver to the public embedding port and use it consistently for model-visible MCP tools and Toolspace/Code Mode while preserving the standalone connection broker as the default. Requests carry both the immediate session and its workspace-scoped lineage root so embedded hosts can authorize child sessions through one durable root binding. Provider-neutral bindings now carry a provider family, provider host, opaque host binding id, and exact selected-repository set; successful credentials must echo the complete binding before headers are accepted. Incompatible endpoint authentication and unenforceable resource containment surface as explicit unavailable states instead of starting a duplicate OpenGeni provider connection.
- c389adc: Add a provider-neutral host run-credential port with frozen turn/session lineage,
  off-manifest environment and file generations, proactive renewal, attempt-safe
  cleanup with bounded generation retention, output redaction hints, and structured
  reconnect UI support. Hosts can explicitly opt a frozen target out, and the
  POSIX materializer supports both Linux `flock` and a portable directory-lock
  fallback with cross-platform base64 decoding.
- a11a7fc: Support mixed GitHub, GitLab, and Azure DevOps repositories—including multiple
  accounts or installations for one provider—in a single session through bounded,
  host-opaque credential bindings and optional read/write access intent.

  Validate binding/provider/host echoes before token injection, isolate tokens in
  hashed binding files, select Git credentials by remote path, fail provider CLIs
  closed on ambiguous bindings, and renew each binding independently while keeping
  legacy one-binding-per-provider request and file aliases compatible.

- 2dfd415: Let embedders keep composer drafts in local React state while leaving message, attachment, steer, and control behavior active. Queue checkout is withheld because its atomic API contract necessarily creates a durable composer draft.
- dda6398: Add durable structured human-input tool calls with exact-turn ownership,
  answer/skip/expiry/cancellation outcomes, restart-safe Temporal resumption,
  authorized API and SDK methods, and headless plus styled React embed surfaces.

### Patch Changes

- 4498714: Preserve tool names and arguments when projecting serialized approval items through the session-only React API.
- 51f45a3: Publish the session-only React entry point and typed session control surface in a stable registry release.
- 44ff327: Fence queue, composer, and control hook state to the active workspace and session so target switches cannot expose or accept stale private state.
- Updated dependencies [1fcd83d]
- Updated dependencies [4401ce7]
- Updated dependencies [c389adc]
- Updated dependencies [d249403]
- Updated dependencies [a11a7fc]
- Updated dependencies [51f45a3]
- Updated dependencies [dda6398]
- Updated dependencies [e8ca4f6]
- Updated dependencies [736f4fe]
  - @opengeni/sdk@0.18.0

## 0.17.0

### Minor Changes

- 717a7ef: Add a headless chat-composer controller, compound composer primitives, and typed message overrides while preserving `ChatComposer` as the default preset.
- dbb6232: Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

  - Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
  - Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
  - Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
  - Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.

### Patch Changes

- bb09be8: Add a session-only React entrypoint and mirror MCP approval policy in
  the public SDK type.
- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- Updated dependencies [bb09be8]
- Updated dependencies
- Updated dependencies [dbb6232]
  - @opengeni/sdk@0.17.0

## 0.16.1

### Patch Changes

- 4e9c48c: Preserve the exact autosaved composer text when sending or steering so trailing whitespace cannot trip the draft consistency fence.
- 9a7dec2: Keep captured workspace files and diffs usable when the live sandbox provider is temporarily unavailable, surface a truthful retryable degraded state, and distinguish provider failures from invalid workspace paths.

## 0.16.0

### Minor Changes

- ec0697a: Ship the production-hardened captured workspace workbench, physically verified Steer/Pause cancellation across cloud, local, and self-hosted model tools, pre-model preparation, sandbox provisioning, and lifecycle/setup commands, durable quiescence admission fencing, cancellation-aware SDK reads and turn cleanup, single-round-trip pruned workspace indexing, truthful shutdown states, a responsive and accessible review dock, Unicode coverage, and package-safe CSS/SSR integration.

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.
- Updated dependencies [ec0697a]
  - @opengeni/sdk@0.16.0

## 0.15.0

### Minor Changes

- f42cd4a: Replace the old queue and interruption surface with one revisioned prompt queue, durable composer drafts, atomic Steer, recursive Pause/Resume, workspace control invalidation, stale-client contract fencing, and a shared accessible queue UI for first- and third-party consumers. Remove the obsolete passive child-notification setting so every child terminal result follows the one bounded, coalescible internal-update contract.
- 0399277: Add a per-machine telemetry detail view and upgrade the machine cards. The card now leads with a fused health verdict (connection + resource pressure + sample freshness), previews a CPU trend, and shows live freshness; opening a card reveals full metric history (CPU, memory, disk, load, GPU) over 15m/1h/6h/24h with threshold guides and a hover crosshair — rendering the downsampled series the API already served but nothing consumed. Resource meters now read as a coherent green/amber/red traffic-light aligned with the health verdict, and load average renders neutral (it is not core-normalized) with the run queue carrying the real saturation signal.

### Patch Changes

- 215d01d: Render normalized persisted MCP text outputs in custom timeline tool cards.
- Updated dependencies [f42cd4a]
  - @opengeni/sdk@0.15.0

## 0.14.0

### Minor Changes

- dc79905: Harden the workspace dock with persistent tab state, authoritative live-versus-capture defaults, accessible mobile navigation, guarded-file routing, and deterministic browser acceptance coverage.

## 0.13.0

### Patch Changes

- 7a7126d: Fence session events, workspace capture, file tree, git state, warm intents, and tab latches by session identity; bound signed-manifest fetches; refresh same-shape diffs when hunk content changes; and clear stale file metadata during reconciliation.
- ad4502a: Make the workbench and console dependency-safe, keep list identities stable, preserve caught error causes, isolate desktop consent tests from real transports, and enforce warning-free repository lint plus aggregate React tests in CI.
- 04d7595: Discover repositories at any workspace nesting depth, including linked worktrees whose `.git` marker is a file, while pruning dependency/build residue and enforcing timeout and repository-count bounds. An incomplete discovery now persists an epoch-fenced degraded capture revision, announces its typed reason, and makes clients prefer live workspace data instead of presenting a misleading empty capture.
- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- fbf029c: Make the workspace dock usable on narrow and touch surfaces: replace the cramped two-column diff with an identity-stable changed-file picker, preserve selection across reordered captures, provide accessible target sizes for dock and file controls, and raise text/diff contrast to WCAG 2.2 AA.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
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

- Updated dependencies [ad4502a]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [faf1487]
- Updated dependencies [b804fd4]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [e4d3569]
- Updated dependencies [a5f58f9]
  - @opengeni/sdk@0.13.0

## 0.12.0

### Minor Changes

- f0ce46c: Credit exhaustion renders as a first-class failure with a top-up CTA (was: silent idle). A budget-exhausted `turn.completed` (`segmentLimit: "budget_exhausted"` / `detail: "insufficient OpenGeni credits"`) now projects as a failed turn-end plus a failed notice instead of a clean completed turn, and `turn.failed` credit errors collapse to one canonical sentence via `humanizeFailureReason`. New exports: `isCreditExhaustion`, `creditExhaustedFromEvents`, and `CREDIT_EXHAUSTION_MESSAGE`. The web console (unversioned app) rides along: a credit-specific banner with an "Add credits" link to organization settings — shown also on idle sessions whose last turn died of budget exhaustion — replacing the "send a message to revive" copy that cannot work without credits.

## 0.11.0

### Patch Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

- Updated dependencies [602db89]
  - @opengeni/sdk@0.11.0

## 0.10.0

### Minor Changes

- 7bfe593: Surface the desktop-capture-blocked reason as server-visible enrollment state.

  A machine can have a display it cannot CAPTURE (macOS Screen Recording / TCC not granted). The agent's connect Hello already withholds the desktop cell in that case; this persists a human, actionable reason alongside it so the Machines dashboard / VM picker can render "display: capture not granted" instead of a bare `display_unavailable`.

  - **Contracts / SDK**: `MachineView` (and `EnrollmentSummary`) gain an additive, nullable `desktopUnavailableReason`. Non-null only when a display exists but capture is blocked; `null` == capture permitted OR genuinely headless. Absent/`null` ⇒ byte-identical to today's shape for existing consumers.
  - **DB**: new nullable `enrollments.desktop_unavailable_reason` column (no backfill — `NULL` preserves the existing "capture-permitted or headless" semantics). The display-cursor writer now persists `has_display` AND the reason together, change-guarded on either field, and self-heals to `null` on the next Hello once the grant is restored.

- 351665b: Completed activity clusters of a still-running turn now fold behind neutral chips (facets + a quiet pulse dot; no verdict glyph — the turn has none yet), keeping only the live tail expanded. This bounds the DOM of very long autonomous turns the same way settled folding bounds history; on settle, everything collapses into the single turn fold as before. TurnSummary's `outcome` prop is now optional (absent = in-progress cluster).

### Patch Changes

- 550b055: Fresh-eyes review fixes: sandbox command output uses its canonical `chunk` wire field end-to-end — the projection and the compact coalescer previously read only legacy `text`/`output`, so compact history windows dropped terminal output entirely (and the resume cursor skipped the raw events that carried it); coalesced sandbox runs now also break on stream and commandId so stdout/stderr never merge. Live-cluster folding is re-based on the true invariants: a cluster with running/streaming items never folds, and folding happens only when the NEXT group is agent progress (activity/turn/narration) — so a pending queued message or an approval pause no longer folds the work the reader needs in view.
- Updated dependencies [7bfe593]
  - @opengeni/sdk@0.10.0

## 0.9.1

### Patch Changes

- ea8757a: The timeline projection's event-grammar contract is now pinned by a golden fixture suite (8 realistic event-log fixtures → committed projection snapshots, including compact/raw equivalence and legacy/malformed tolerance). Intentional grammar changes regenerate snapshots so the diff is reviewed; unintentional ones fail CI.
  - @opengeni/sdk@0.9.0

## 0.9.0

### Patch Changes

- 445fb78: First paint of a session is now a single compact fetch (deeper history loads via the scroll sentinel), and the hook exposes `initialLoading` so hosts can suppress genesis fallbacks while the tail window is still fetching — on large sessions the web console painted the session's initial message at the top for the whole fetch.
- Updated dependencies [e513236]
  - @opengeni/sdk@0.9.0

## 0.8.0

### Patch Changes

- 3d708b5: Add compact event replay support for history windows and switch React session-event loading to capped compact pages with coalesced-delta resume cursors.
- Updated dependencies [3d708b5]
  - @opengeni/sdk@0.8.0

## 0.7.0

### Minor Changes

- 5e56bcd: Add tail-first session event loading with reverse durable pagination, older-history loading controls, and timeline props for smooth prepend pagination.

### Patch Changes

- 068c647: A no-op pinned-follow scroll assignment left the programmatic-scroll mark set (no scroll event fires to consume it), which made the reader's next real scroll-up read as programmatic and get eaten — the view snapped back to the bottom and upward backfill could never engage. The mark now self-clears when an assignment doesn't move the scroller.
- d84eef8: Session load and backfill no longer flicker: the timeline stays invisible until its first bottom-anchored frame (a flash of the window top is structurally impossible), rows decide at mount whether they animate so bulk paints never replay entrance animations across the timeline, the scroller disables native browser scroll anchoring (it fought the reader-anchor corrections during backfill), and programmatic scroll echoes can no longer unpin the bottom-follow (which could strand the view just short of the bottom).
- Updated dependencies [15deca0]
- Updated dependencies [5e56bcd]
  - @opengeni/sdk@0.7.0

## 0.6.3

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/sdk@0.6.3

## 0.6.2

### Patch Changes

- a63bc1f: Anchor queued user messages at the turn that actually executes them in the timeline projection, show still-pending queued messages quietly, and ignore cancellation events for queued turns that never started.

## 0.6.1

### Patch Changes

- d935316: The timeline no longer renders queued / running / idle status dividers — they are machinery telemetry the header pill, live shimmer, and turn-chip duration facet already carry. Only attention-worthy statuses (requires_action, failed, cancelled) still earn a divider. Applies retroactively to historical traces since the filter lives in the pure projection.

## 0.6.0

### Minor Changes

- a4f370f: Carve the connected-machine UI into a dedicated `@opengeni/react/machines` subpath, and add `workingDir` to the SDK create-session request.

  - **`@opengeni/react`**: the bring-your-own-compute surface (`useMachines`, `MachinesDashboard`, `MachineCard`, `MachineDockBar`, `SharedMachineDisclosure`, `MachineStatusPill`, `ConnectionStatusPill`, `ConnectionDot`, `MachineMetrics`, `EnrollmentDeviceFlow`, `EnrollmentConsent`, `connectionStatusForState`, and the `MachineView` / `MachineState` / `MachineKind` / `MachinesResponse` / `MetricSample` view-model types) now lives at `@opengeni/react/machines`. The root keeps re-exporting it for backwards compatibility — **non-breaking** — but the root re-export is **deprecated** and will move in a future major. Import from `@opengeni/react/machines` going forward.
  - **`@opengeni/sdk`**: `CreateSessionRequest` gains an optional `workingDir?: string` field — the host working directory for a connected-machine target (the agent runs there; defaults to the machine's launch dir). Ignored for managed sandboxes.

- d9d7743: Render the self-hosted desktop stream: a PNG-frame canvas client for `transport: "relay-frames"`.

  Self-hosted machines stream their desktop as PNG-per-frame protobuf datagrams over the relay (not RFB), so the noVNC/RFB viewer could never render them — the desktop went "warm" but the live stream never came up. This adds `useRelayFrameStream`, a view-only canvas renderer that opens the relay channel, decodes each PNG frame, and paints it (latest-wins backpressure so a slow decode never queues). `useDesktopStream` now dispatches on `DesktopStream.transport`: `"vnc-ws"` → noVNC (Modal boxes), `"relay-frames"` → the frame renderer (self-hosted machines). The `DesktopStream.transport` / `client` unions gain `"relay-frames"` / `"frames"`. View-only in v1 (matches the machine's read-only mode); interactive input is a follow-up.

- ccebacd: Completed, failed, and cancelled turns now fold their activity behind a TurnSummary chip in MessageTimeline, with failed turns starting expanded so their failure text remains visible.
- 5a289d0: Settled turns now collapse the entire turn span behind one summary chip, leaving only the final agent message visible until expanded. Expanding the chip reveals mid-turn narration and nested per-cluster activity summaries.

### Patch Changes

- Updated dependencies [a4f370f]
- Updated dependencies [d9d7743]
  - @opengeni/sdk@0.6.0

## 0.5.0

### Minor Changes

- 48c0d2e: Add session titles. A session now has a short display title that the agent generates itself: on the genesis turn a hidden, non-persisted directive asks the agent to call the new `set_session_title` tool, so the session is named on its own model with no extra LLM call. Users (and agents with `sessions:control`, via `set_other_session_title`) can rename; a user-set title is permanent and is never clobbered by agent writes.

  - `@opengeni/contracts`: `Session.title` / `Session.titleSource`, `UpdateSessionRequest`, and the `session.title_set` event.
  - `@opengeni/sdk`: `client.updateSession(workspaceId, sessionId, { title })`.
  - `@opengeni/react`: `useSession().updateTitle(...)`, live `session.title_set` handling, and `sessionDisplayTitle` now prefers `session.title`.

### Patch Changes

- Updated dependencies [48c0d2e]
  - @opengeni/sdk@0.5.0

## 0.4.0

### Minor Changes

- a1c82c5: Add the world-class timeline tool-call renderer module and the sandbox workspace client surface to `@opengeni/react`.

  - **Timeline renderers**: per-tool disclosure cards (full-row toggle, keyboard-accessible), screenshots → lightbox, theme-aware Pierre diffs, turn-collapse summary chips, sub-agent worker/goal landmarks, a consumer-extensible tool registry, and complete state handling (running / complete / failed / cancelled), each with its own affordance.
  - **Sandbox surfacing**: file/terminal/git/desktop hooks and components (`useSandboxFiles`, `useSandboxTerminal`, `useSandboxGit`, `useDesktopStream`, `useTerminalStream`, `useSessionCapabilities`, `SandboxFiles`, `SandboxTerminal`, `DesktopViewer`, `WorkspaceDock`, Pierre diff/file views, `CodeEditor`).

  All additive; `MessageTimeline`'s `items` contract is unchanged. The internal `compactPayloadPreview` helper was removed from the public surface.

### Patch Changes

- Updated dependencies [2989163]
- Updated dependencies [a1c82c5]
  - @opengeni/sdk@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [a78a09b]
  - @opengeni/sdk@0.3.1

## 0.3.0

### Minor Changes

- daaffd7: Chat `MessageTimeline` now renders message bodies as **markdown by default** (react-markdown + remark-gfm, themed to the `og-*` design tokens — headings, lists, GFM task lists, inline/fenced code, blockquotes, tables, links). The `renderMessageText` prop still overrides the default renderer.

## 0.2.0

### Minor Changes

- 21c1535: Initial public release of the OpenGeni client packages.

  - `@opengeni/contracts`: shared zod wire-contract schemas and types.
  - `@opengeni/sdk`: zero-dependency, framework-agnostic TypeScript client with typed API, session lifecycle, and SSE streaming (reconnect + replay-by-sequence).
  - `@opengeni/react`: React hooks and styled components built on `@opengeni/sdk`.

  All three now ship ESM + `.d.ts` builds via tsup and are published to npm with provenance.

### Patch Changes

- Updated dependencies [21c1535]
  - @opengeni/sdk@0.2.0
