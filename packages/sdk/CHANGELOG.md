# @opengeni/sdk

## 7.7.0

### Minor Changes

- 351cd79: Add `includePinned: false` to session-page reads so callers loading the pinned section separately can skip repeated pin hydration. The default response and ordinary-page pin exclusion are unchanged.

  Bound the browser event working set to 16 MiB or 20,000 events, with durable history accessible through existing navigation. Avoid copying the event window when no additional question evidence is needed.

- 479ec20: Add the selectable opengeni-schedules bundled Skill for schedule creation. The
  Schedules chat shortcut keeps setup guidance in the Skill and sends only the
  user's scheduling request and time zone.
- 70af8bb: Fence subscription lease renewal against expired ownership under lock contention. Share account selection and worker lease deadlines between subscription providers. Preserve Claude model-specific quota evidence and exact dispatched-token identity through concurrent responses, refreshes and delayed finalization.

### Patch Changes

- 45e1b4f: Advertise background window input separately from background semantic controls. The CUA pilot viewer accepts targeted clicks and typing without offering unsupported foreground focus; existing native backends retain their focus guard.
- da4ba6f: Expose exact managed browser download discovery and workspace save through attempt-scoped tools and the typed Code Mode facade, retaining existing authority, integrity checks and operation identity.
- 31e3771: Expose stored Connected Machine command reconciliation diagnostics and unavailable observations through existing session-authorized reads, preserving provider execution and acknowledgement behavior.
- 76ff363: Support workspace OpenAI and Azure OpenAI API keys with provider verification, isolated encrypted credentials, and externally billed model selection. Add the optional model verification flag to connection creation and preserve shell cancellation on macOS local sandboxes.
- d2fe11d: Add capability-gated media instructions and bounded discovery hints so agents can find deferred image tools after an unmatched literal-prefix lookup. Preserve tool-family authorization, approval checks, and deferred schema visibility.
- 5dacdd7: Add brand-neutral SDK error presentation and a shared native React host error-copy override, preserving diagnostic errors and delivery/retry state.

  Keep NewChat's full-height composer contained when using shipped CSS without a host reset.

- 351cd79: Resolve session-page connector availability and defaults from one current registry read instead of loading it twice. Keep workspace and subject scopes unchanged.

  Reduce temporary query allocations and repeated session-path strings in the SDK without changing request values or legacy response handling.

- Updated dependencies [12ef019]
- Updated dependencies [45e1b4f]
- Updated dependencies [da4ba6f]
- Updated dependencies [697263e]
- Updated dependencies [31e3771]
- Updated dependencies [76ff363]
- Updated dependencies [d2fe11d]
- Updated dependencies [946f6c3]
- Updated dependencies [cbb3e36]
- Updated dependencies [479ec20]
- Updated dependencies [70af8bb]
- Updated dependencies [3a921bf]
  - @opengeni/contracts@5.7.0
  - @opengeni/connect@0.3.2

## 7.6.1

### Patch Changes

- 3f7ff5b: Fix composer draft save and submit through a session proxy with model selection disabled. Saves ignore browser model, reasoning effort, and latency choices and use the authenticated actor's server-side draft policy (initially the session defaults). Submit preserves the mandatory saved-policy snapshot as an API revision/content integrity fence, so identical retries replay the original receipt even after another draft replaces that actor's policy; missing, invalid, or changed submit policy is rejected, not rewritten into a new selection.

## 7.6.0

### Minor Changes

- e5b0123: Release the developer-setup API-key preset and SDK mirror with its credential ceiling preserved across sessions, delegated tools, automations and scheduled runs. Include the scheduled setup-policy identity migration and the bundled skills-only developer setup guide.

### Patch Changes

- Updated dependencies [e5b0123]
- Updated dependencies [4762e1a]
  - @opengeni/contracts@5.6.0

## 7.5.0

### Minor Changes

- a6ff780: Add optional direct API-key credential metadata to access contexts, including
  organization/workspace scope and effective workspace permissions. Export the
  SDK AccessCredential type and document full organization-key provisioning of
  workspaces, external members, and asUser sessions without changing existing
  grants, membership requirements, session visibility, or literal secrets authority.
- fd5fb34: Let workspace administrators test integration endpoints and see what they inherit. `testWorkspaceWebhook` sends a signed `webhook.test` event (accepted by `verifyWebhookEvent`, never queued), `testWorkspaceCredentialProvider` sends a `credentials.request` with `purpose: "test"` and returns only the names of what a run would get, and `getWorkspaceInheritedIntegrations` lists the organization provider and webhooks that reach a workspace. The web app's Developer settings now explain both integrations, give each webhook and the provider its own page with deliveries and a test, and manage organization-wide registrations under Organization settings > Developer.
- b45621d: Artifacts and Sites now work inside an embedding product with the same components the OpenGeni console uses. `@opengeni/react/artifacts` gains the console's inline Site/HTML preview (`ChatInteractiveBlock`, `ArtifactSandbox`, `DeferredChatMedia`), `SiteView`, `EditableArtifactView`, and a host-mountable `SessionArtifactViewer`; `SessionConversation` renders `opengeni-site` fences inline and opens agent artifact links through `onOpenArtifact` (`viewerLinkResolver` for a custom timeline). `createSessionProxyHandler({ artifacts: true })` serves only the artifacts OpenGeni lists for the requesting session (read, editor live ticket, Site detail and sandboxed HTML), and client config advertises the live socket URL and browser cache partition. The SDK client adds `withHeaders`, `apiUrl`, and `fetchApi` for host-authenticated transports. Every built-in artifact string is translatable through a `labels` prop (partial `ArtifactLabels`) on `SessionArtifactViewer` and `ChatInteractiveBlock`, or `ArtifactLabelsProvider`. Document and presentation editors compose one projection at a time, so opening an artifact with a long history no longer floods the artifact Worker's request queue.
- f874217: Make browser sign-in the default Claude subscription connection flow, with profile access for current usage/reset times and encrypted automatic token renewal. Reuse native workspace/organization connection ownership and access policy, bind one-use PKCE attempts to the human/browser/current generation, and preserve original model-request bindings across token renewal. Keep inference-only setup tokens as a clearly labelled fallback, and send JSON for browser usage-refresh mutations.
- b45621d: Fix embedded artifact viewing for external users by resolving fresh effective workspace grants, checking exact session associations on every request, and binding live editor tickets to their source session. Keep editor authority and reconnect reads current when clients or sessions change, and allow retrying temporary viewer configuration failures.

  Source-bound editor sockets renew a 15-second lease through the host proxy, rechecking product authorization; existing unbound console sockets are unchanged. Compact authenticated source tickets remain within the existing wire limit.

  Add server-only `@opengeni/sdk/session-proxy` helpers. Stream embedded Site HTML with backpressure and cancellation and enforce a 25 MiB actual-byte ceiling; oversized streams fail with `site_html_too_large`. Preserve the console's existing shared artifact components and list behavior.

  Allow PostgreSQL test fixtures to use an explicitly configured native server while preserving restricted-role and FORCE-RLS verification.

- 0bbe2e7: Add `chats: "private" | "shared" | "isolated"` to the session proxy and chat facade,
  and `agent` to the facade. With an authenticated `user`, the facade now defaults
  to private chats with personal Knowledge on, instead of session-only agent reach
  with Knowledge authoring off. Without a user, omitting `chats` keeps the legacy
  workspace visibility, session-only reach and Knowledge authoring off. Explicit
  private chats require a user.

  The implicit renderer defaults to markdown when admitted by the server. On an
  older or rollout-disabled server's `422 agent_config_not_enabled`, the facade
  retries once without only that implicit agent and caches the refusal per instance.
  Explicit agent settings are never stripped; their 422 gives actionable setup guidance.

  Private uses private visibility, session-only agent reach and user Knowledge;
  shared uses workspace visibility, reach and Knowledge. Isolated additionally
  provisions a separate workspace and external member for each tenant/user.
  Explicit create fields override the defaults without changing server privacy rules.
  The server-only `tenant-workspaces` subpath exposes `createWorkspaceIdResolver`;
  the facade exposes `workspaceIdFor({ tenant, user }, { isolation: "user" })`.
  Missing private-session enablement raises `OpenGeniSetupError` with owner/admin
  API, SDK and web-app remediation.

- 3545ca3: Include exact accepted-turn initiator context in signed credential-provider
  requests, with human/service/agent attribution and bounded causal lineage for
  children, continuations, and coalesced updates. Preserve initiating-human fields
  and authorization; expose the additive context through the SDK verifier.
- 5b48f00: Add recoverable allowance lifecycle state and idempotent clear receipts.
  Preserve typed allowance scope and reset details in web, MCP, and Slack
  refusals with administrator-specific remedies.
  Expose browser-safe refusal helpers through `@opengeni/sdk/allowance-refusal`
  without widening React's runtime dependency boundary.

  Recheck allowance after paid compaction and align continuation admission with
  its frozen causal lineage. Keep allowance storage compatible with rolling
  deployment, preserve settled usage across period edits, harden definer search
  paths, and order organization locks before tenancy fences.

- 709eef2: Usage allowance UI. `@opengeni/react/usage` adds `useUsage`, `UsageMeter`,
  `UsageLimitNotice` (the calm near/at-limit composer line) and
  `UsageMemberList` (an admin roster with a share-of-budget slider that shows
  oversubscription as allowed). The conversation renders an allowance refusal as
  a structured "usage limit reached" row that hosts reword with
  `allowanceExhaustedLabels` or replace with `renderAllowanceExhausted`, and a
  queued prompt refused before it starts stays above that row.
  `@opengeni/sdk/usage-allowances` exposes allowance reads and administration as
  free functions over `requestJson` for browser code without the root client.
- 5b48f00: Add workspace and member usage allowances in integer USD micros, with
  versioned configuration and member rules, operation-keyed credit grants,
  current/historical usage reads, and a typed allowance-exhaustion error.
  The session proxy exposes only the authenticated user's own usage read;
  organization budget authority remains separate from workspace-admin member
  splits, and agents cannot write allowance policy or grants.

  Document per-seat equal splits, administrator sliders, custom shares,
  top-ups, monthly team budgets, UTC month-end anchors, frozen causal usage
  attribution, and model-call soft-ceiling semantics. Shares are oversubscribable
  ceilings rather than reserved funds; admitted and concurrent calls may
  overshoot before the next admission check.

  Keep usage reads side-effect-free, retain active accounting windows across
  period/anchor edits, and evaluate rollover, expiry, and usage notifications
  through bounded periodic API maintenance. Preserve existing prepaid video
  billing with exact, idempotent allowance-allocation reversal for matching
  refunds.

### Patch Changes

- 0bbe2e7: `installApiIntegration` accepts `autoApprovedTools`: selected write or destructive tools of a custom or curated API Integration (a curated definition may forbid specific operations) that run without per-call human approval, so scheduled and other unattended runs no longer wait forever on an approval. It needs `capabilities:manage`, passes organization integration policy again, and is declarative (omit it and every write tool asks again). Connector tool-permission and session approval-policy errors for API Integration ids now point to this setting.
- 45d1301: Resolve caller-scoped client model lists and fresh session creation through the same workspace selection rules, including credential readiness, policy, and connection model permissions. Hide unavailable subscription models from public bootstrap, support an explicit workspace selector in client config, and allow an empty selectable model list.
- b45621d: Revalidate live editor source-session authority in the mutation commit transaction, and enforce source-bound socket lease expiry independently of stalled authorization. Publish the session-proxy JavaScript entry and negotiate artifact support without breaking conversation bootstrap against older APIs.
- 45d1301: Expose repeated empty final replies as a typed, informational completed-turn notice without failing goals or deferring later updates.
- 0bbe2e7: `previewApiIntegration` and `installApiIntegration` accept an inline OpenAPI document: `source: { kind: "openapi_document", sourceKey, document, baseUrl? }` (JSON or YAML, at most 8 MiB). `sourceKey` is the stable installation identity, server URLs must be absolute (or `baseUrl` given), and the preview echoes only the document's SHA-256. Calls still follow the deployment network policy, so a product on a private or loopback address still needs a public tunnel unless the operator enables private targets.
- 0bbe2e7: Allow isolated embedded users to attach the host's per-session MCP servers with the default non-admin conversation permissions. Add `memberPermissions` to the chat facade and standalone workspace resolver to replace initial onboarding permissions without modifying existing or revoked memberships.

  Keep resolving existing workspace addresses when permission changes conflict with earlier keyed onboarding, without retrying or replacing a cancelled grant. Existing users need an explicit membership update to gain new permissions.

- 0bbe2e7: `ScheduledTaskAgentConfigInput` accepts `agent`, so `createScheduledTask` and
  `updateScheduledTask` can set a schedule's agent configuration with the SDK types.
- 0bbe2e7: A top-level `createSession` now selects every server it attaches through `mcpServers`, whether `tools` is omitted or explicit (including `tools: []`). Previously an attached server that `tools` did not name was stored but never contacted, so the model reported that no tools were available. An explicit ref for the same id is kept unchanged, so `tools` is only needed to set `eager` or `optional`.
- 0bbe2e7: Every `session.requiresAction` approval entry now carries the same top-level `id`, `name`, and `arguments`, whether it is the first pause of a turn or a later one after a decision. `id` is the `approvalId` that `sendApprovalDecision` accepts (the pending tool call id). Historical fields (`rawItem`, `raw`) remain for compatibility. The SDK exports this as `SessionApprovalRequest`.
- b45621d: Refresh the generated Site browser runtime from the existing SDK source during the package build, including current deprecation notices, service-attribution safeguards and response-body cleanup. This generated synchronization is separate from the embedded artifact authorization fixes.
- 5b48f00: Default missing webhook lanes only after signature verification, preserve the
  public organization webhook event vocabulary while rejecting usage subscriptions,
  and keep allowance refusal presentation schema-runtime-free for browsers and
  React Native. Emit the focused integration and refusal entries in published builds.

  Fence the next model dispatch on settled usage and frozen-human admission, refuse
  fresh delegated work before interruption, and repair workspace-less Knowledge
  indexing and historical migration fixture dependencies.

- 0bbe2e7: `api_key` Connections now must store `{ headers: {...} }` or `{ placements: [...] }`; create and update reject any other shape (such as a bare `{ apiKey }`) with 422 instead of accepting it and failing every tool call later. The SDK types this as `ApiKeyConnectionCredential`. `previewApiIntegration` warns when the selected Connection does not place its credential where the API description declares.
- Updated dependencies [a6ff780]
- Updated dependencies [0bbe2e7]
- Updated dependencies [d9ec660]
- Updated dependencies [45d1301]
- Updated dependencies [45d1301]
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
  - @opengeni/connect@0.3.1

## 7.4.0

### Minor Changes

- 3f9c757: Bad client input no longer answers `500`. A request body that fails its schema
  is `400 validation_failed` naming each offending field (malformed JSON too); a
  server-side projection failure stays `500`. An unknown `/v1` method or path
  answers `405` (with `Allow`) or `404` before authentication, instead of the
  retryable `503` the session authorization layer used to return (for example
  `GET .../sessions/:id/tool-policy`). `PATCH /v1/workspaces/:id` with `settings`
  points at `PATCH /v1/workspaces/:id/settings`, and an Integration install whose
  `allowedTools` names a preview `operationKey` (or any unknown value) is a `422`
  listing the valid tool ids and the id each operationKey maps to.
  `PUT /v1/workspaces/external` (`ensureWorkspace`) accepts an omitted
  `accountId` from an organization API key, which creates the workspace in the
  key's own organization; every other caller must still send it.
- 304ddc5: Make the public API compatibility policy explicit and enforced
  (`docs/design/api-compatibility-policy.md`). Deprecated public routes now answer
  with standard `Deprecation`, `Sunset`, and `Link: rel="deprecation"` headers
  (exposed through CORS), and `OpenGeniClient` reports each deprecated route once
  through the new `onDeprecation` option (default: one `console.warn` per route;
  `false` silences it; `parseDeprecationNotice` is exported). The API no longer
  advertises its `x-opengeni-api-contract` revision to a bearer-authenticated
  caller that announced a different one, so published SDKs, which reject any
  other revision on every response, keep working across additive contract bumps.
- 3f9c757: The `x-opengeni-api-contract` fence is now a stale-browser-tab guard only.
  Cookie-authenticated (and unauthenticated local) mutations still need the exact
  revision and receive `409 API_CONTRACT_CHANGED` otherwise, but
  bearer-authenticated callers (API keys, delegated tokens) are admitted with an
  older revision or none, so a backend pinned to an older `@opengeni/sdk` keeps
  working across deployments. A truly breaking revision can still be refused for
  every caller through `REFUSED_API_CONTRACT_REVISIONS`. The SDK gains an
  `apiContract: "strict" | "compatible"` option: it defaults to `"strict"` only for
  a browser client without an `apiKey`, and otherwise no longer throws
  `OpenGeniApiContractMismatchError` from `getClientConfig()` or responses when
  the API advertises a newer revision.
- a6644b6: Fix `Chat.stream()` / `Chat.send()` hanging after the `done` chunk on fetch
  implementations that settle a body `cancel()` only after the request aborts
  (Next.js on Node): the chat now aborts the event stream before unwinding, and
  the SSE parser and heartbeat wrapper never await `cancel()`.

  The chat facade accepts per-message `model`, `reasoningEffort`, `latencyMode`,
  and `modelContext` on `send`, `stream`, and `steer`, and exports
  `formatImportedHistory`. The Vercel UI message stream (AI SDK 5, 6, and 7)
  no longer emits OpenGeni's own tool activity unless `toolParts: true`; opted-in
  and approval tool parts are marked `dynamic` and `providerExecuted`, and
  `uiMessageStreamParts(chunks, { framing: false })` writes into an existing AI
  SDK `createUIMessageStream` route.

- aad6598: Claude subscription setup and replacement require only the setup token. Observe
  provider usage and reset windows from ordinary model responses, including quota
  errors, and expose scoped cached reads and authorized refreshes. Preserve the last
  reading when inference-only tokens cannot use the separate usage endpoint; fence
  cached readings against credential replacement and revocation.
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

- d480872: Agent links to OpenGeni objects now work inside an embedding product. `artifact:` files download by default from `SessionConversation`; sandbox-path downloads require explicit proxy `sandboxFiles: true` and use bounded, no-symlink reads within the session working directory. Editable artifacts and Sites route through a new `resolveLink` prop (`MessageTimeline`, `SessionConversation`, `Markdown`, `OpenGeniLinkProvider`) instead of rendering console paths that 404 on the host origin. Invalid reserved references render unavailable. `parseOpenGeniLink` in `@opengeni/sdk` classifies the same hrefs for non-React clients and preserves validated console return hints. Editable-artifact export uses configured exporter capabilities and preflights the exact format and options before creating a snapshot or pinning a version. Stock deployments serve spreadsheet XLSX; the artifact Skills stop promising unsupported PDF/DOCX/PPTX exports.
- 3f9c757: An organization service key can change an existing external member's
  permissions in one shared workspace without removing and re-adding them:
  `PATCH /v1/organizations/:organizationId/workspaces/:workspaceId/external-members/:membershipId`
  (`updateExternalWorkspaceMember` in the SDK) with `{ operationId, permissions }`.
  It is keyed and idempotent like a grant, capped by the key's permissions, and
  never cancels or tears down work. Narrowing also advances the member's
  organization authorization revision so frozen authority re-checks on next use.
  Rolling migration 0540 adds the `update` action to the external membership
  operation ledger.
- 9732749: Knowledge saves can omit `entryId` when creating an entry. OpenGeni derives the id from `operationId`, so an exact retry replays the same entry instead of creating a duplicate. The all-zero UUID is rejected. A create whose `entryId` belongs to another entry now fails with a clear "entry id taken" error (HTTP 409, `knowledge_entry_id_taken`). Previously this was reported as operation-ID reuse, so agents retried forever and the fact was never saved.
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

- a82657f: Register signed credential providers and webhooks once per organization with explicit external-source filters and workspace overrides, excluding Personal workspaces. Include authorized initiating-human identity, registration lane, workspace routing and selected remote targets. Bind renewable MCP headers to normalized URLs only, restrict transport headers, skip unavailable targets and fail closed on expiry. Add immediate signing-secret rotation and canonical browser/organization-key administration. Server-only organization helpers, individual webhook reads, and secret rotation are opt-in functions from `@opengeni/sdk/workspace-integrations`, taking `client` first rather than expanding the eager browser client.
- 3f9c757: A scheduled occurrence the scheduler refuses before running it is now a visible
  run instead of a thrown, retried activity or a silently dropped occurrence.
  `ScheduledTaskRun.admissionRefusal` (`{ version, reason, retryable }`, with
  `error` equal to `reason`) covers unprovable authority, an unavailable
  Connected Machine target, a missing Variable Set, a Sandbox Environment without
  an active version (terminal, status `failed`), and an inactive machine
  enrollment, insufficient credits or monthly limits (transient, status
  `skipped`; later occurrences run normally). Redelivery never adds a second run.
- 3f9c757: A scheduled run whose turn waits for a tool approval or a structured question
  is now visible: `ScheduledTaskRun.awaitingHuman` (`{ since, expiresAt }`) on run
  listings and `awaitingHuman` on the scheduled-task attention list, instead of the
  run looking merely "dispatched". The new optional
  `agentConfig.approvalTimeoutSeconds` (60 s to 30 days; default none) lets the
  scheduler reject the pending approval (or skip the question) as a labelled
  system decision once nobody answered in time, driven by a durable workflow
  timer.
- f986809: Scheduled tasks can post to one Slack channel as the OpenGeni workspace bot. A person chooses the channel in the schedule editor ("Post to Slack" under Advanced), stored as `agentConfig.slackBotChannelId` next to `slackBotConnectionId`. Choosing or changing it needs a signed-in person with `connections:write`, and the bot must be a member of an active channel that is not shared with another organization. Agents, services and API keys cannot set or change it. `listScheduledTaskSlackChannels` in the SDK lists the eligible channels.

  Runs of such a task get two tools, `slack_bot_prepare_message` and `slack_bot_send_prepared_message`, which take no channel. Prepare saves the exact text; send posts it to the task's channel with the saved server-owned id as the Slack post operation id, so a retried send never posts twice. Both re-read the task at every call, so clearing or changing the channel takes effect immediately and never redirects an already prepared message. Rolling migration 0530 adds the private prepared-message table and its two capabilities.

- 1ea4c69: Show when a scheduled task's frozen access is out of date, let its owner refresh it, and tell the owner when a run could not use a connector.

  For the task owner (or, for a task without an owner, people who manage schedules), scheduled task reads include a read-only `policyDrift`: workspace default connectors the task lacks, connectors the workspace no longer sets up, default OpenGeni tools missing from an agent-created task's frozen creator policy, connectors whose chosen account can no longer be used, and connectors with no account although one is now available. `POST /v1/workspaces/:workspaceId/scheduled-tasks/:taskId/refresh-access` (SDK `refreshScheduledTaskAccess`) re-freezes exactly that with the calling person's current authority through the ordinary owner update path. Only a signed-in person may call it; API keys, services, delegated bearers and agents cannot, a changed task returns 409, and a refreshed creator policy keeps a frozen permission only while that person holds it, adds only the permissions its newly added tools need (within the default worker set and that person's grant), and never changes the creator session policy.

  Scheduled runs whose own turn recorded `tool.auth_needed` carry `accessFailures`, and `GET .../scheduled-tasks/attention` (SDK `listScheduledTaskAccessAttention`) lists schedules whose latest run failed that way until a later run succeeds. It also lists schedules the scheduler refuses before creating a run because a chosen connector account can no longer be used (`unavailableAccounts`, with a null `runId` and `firedAt`), checked at read time with the same account plan as the drift; each item carries the task's `executionDigest`. The web console shows a dot on the Schedules navigation item, a badge on the schedule's row, a notice on the schedule's page with a one-click refresh, and the failure on each run row.

  The refresh accepts an optional `leaveOut` naming default connectors and OpenGeni tools to keep off the schedule; it only narrows what the refresh adds. The schedule page's "Keep without these" hides those defaults in that browser for the reviewed task head and passes them as `leaveOut` when the owner refreshes.

  `@opengeni/contracts` exports `ScheduledTaskPolicyDrift`, `ScheduledTaskAccessConnector`, `ScheduledTaskRunAccessFailure`, `ScheduledTaskAccessAttention`, `ListScheduledTaskAccessAttentionResponse`, and `RefreshScheduledTaskAccessRequest`; `ToolAuthNeededReason` is unchanged but now declared earlier in the module. `@opengeni/db` adds `listScheduledTaskCreatorPolicies`, `listScheduledTaskRunAuthNeededEvents`, `listScheduledTaskAccessAttentionEvents`, `listActiveScheduledTasksWithConnectionAccounts`, and `ScheduledTaskHeadChangedError`, and `updateScheduledTask` accepts `expectedExecutionDigest` and `creatorFirstPartyPolicy`.

- 12bc3de: Add the server-side `client.asService(name, context?)` helper for explicit
  automation attribution without changing the original client's credentials or
  permissions. Validate bounded service names and flat JSON context, preserve the
  client class and options, and reject mixed service/user attribution rather than
  silently switching authority. Document product-owned background jobs and
  repository credential providers in the integration guide and client Skill.
- a6644b6: Add `createSessionProxyHandler(client | og, { resolve, ... })`, a packaged
  same-origin backend for `@opengeni/react`'s `SessionConversation`. It
  authenticates every request through the host's `resolve` hook, runs as the
  resolved external user through `asUser` (never the organization key's service
  authority), rejects any workspace other than the resolved one, and serves only
  the native `/v1/workspaces/:workspaceId/...` routes the conversation surfaces
  use, so an unmodified browser `OpenGeniClient({ baseUrl: "/api/opengeni" })`
  works against it. Session creation is server-controlled through a
  `createSession` hook (the browser supplies only the message and a retry key);
  message bodies are bounded, cannot rotate MCP credentials or attach non-file
  resources, and mutations go through an optional `authorizeMutation` CSRF hook.
  It also serves the workspace read, live control stream, and workspace Resume
  that `<OpenGeniProvider>` uses, and passes unknown query parameters through on
  served reads so newer browser SDKs keep working.
- 8a9d19e: Add human-authorized removal of saved personal/workspace Skills with version checks and replay after deletion. Allow installed capability shortcuts to display their status visibly.
- 14990d0: A task started from Slack now starts from what the workspace offers every new session instead of the person's last website composer selection. Connectors follow the workspace default connector policy (including the person's own personal connections when that policy includes connected servers, still executable only through the frozen delegation snapshot), OpenGeni tools follow the workspace default selection, and the Sandbox Environment and its Variable Sets follow the workspace default. Only an explicitly chosen model carries over. Mentions, commands, DMs and shortcuts now always add the read-only Slack context tools, including when the workspace has its own default OpenGeni tool selection; reactions still do not.

  Repositories are the person's own recently used repositories in that workspace: those on the top-level sessions they started there in the last 30 days, most recent first, at most five, and only through their current entry in the workspace GitHub App catalog (same catalog and `github:use` permission as the website picker), on the default branch. Archived and empty repositories are skipped. A person with no recent repositories gets none; GitHub is asked only when there is something to look up, and an outage starts the task without repositories. These repositories are attached best effort.

  Repository resources gain an optional `optional: true` flag (contracts and SDK). A failed clone of such a repository logs a warning, is reported as `skippedOptionalRepositories` on the `repository-clone` operation event, and no longer fails sandbox setup; a repository without the flag keeps the strict behavior. `GitHubRepository` gains optional `archived` and `sizeKb`, filled from GitHub when reported.

  The Slack acknowledgement adds one line naming what the task started with, for example `Using connectors: Gmail, Linear; repos: opengeni.` It names only connectors the first accepted turn can reach, so a personal-only connector the person never connected is not claimed. The line is frozen on the interaction when its session binds (rolling migration 0529 adds the nullable `slack_interactions.session_defaults_line`), so a repaired acknowledgement re-renders identical bytes. A Slack message or a reacted-to message that links a workspace or session on a different deployment under the same parent domain (for example staging versus production) now carries a model-context note, so the agent says the link is for the other deployment instead of reporting the session as not found.

  Breaking: `@opengeni/core` removes `getActorNewSessionDefaults`. Use `getActorNewSessionModelChoice`, which returns only an explicitly chosen model policy. `@opengeni/db` adds `SlackInteraction.sessionDefaultsLine`, an optional `sessionDefaultsLine` input to `bindSlackInteractionSession` (written only by the bind that wins), `listRecentSessionRepositoryResources`, and `getSessionFirstTurnConnectionAuthority`.

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
- a6644b6: `OpenGeniProvider` no longer blocks or reloads the page when the server's API
  contract revision differs from the bundle's; that stale-tab protection is now
  the opt-in `reloadOnApiContractChange` prop used by the stock OpenGeni console,
  so an OpenGeni deploy never reloads an embedding product's page. The session
  proxy reports its own SDK contract revision in `/v1/config/client` and never
  forwards the upstream `x-opengeni-api-contract` header to the browser.
- 6f28afd: A definitively lost managed Modal sandbox no longer dead-ends its sessions. Shared sandbox groups (a parent with its children) now get the automatic checkpoint fallback, and every member receives the durable filesystem-discontinuity warning. When no checkpoint can be restored automatically (no archive, an unverified or legacy archive, an invalid artifact, or a definitive, non-retryable content-integrity failure of the selected checkpoint), the whole quiescent group continues on a new empty workspace after a separate audited decision that warns every member the previous files are not available. Loss must be proven by a loss transition (a failed replacement box never counts), the empty workspace waits until the lost box is past its hard provider lifetime, other restore failures (including a missing archive object, now `archive_object_missing`, or unconfigured archive storage, now `archive_storage_unavailable`) retry the checkpoint with backoff and then wait for an operator, and a complete archive is never bypassed. Ambiguous provider states and live writers in any member still block, unknown command outcomes are never replayed, and the lost archive evidence is kept. Sessions stuck before this release recover on their next turn or Retry. The recovery projection adds `automaticLane` (`checkpoint` or `fresh_workspace`) and, for a timed wait, `availableAt` (when a Retry or a new message can decide again), and the failed-session banner says what Retry will do and when. Rolling migration 0548 requires warning protocol v3 to claim a session with an empty-workspace receipt.
- b591ea1: Support native Claude Messages with separate encrypted Anthropic API-key and Claude subscription setup-token connections, workspace access policies, streaming tools and thinking, prompt caching and usage accounting. Add connection UI and payment-source labels. Migration 0544 expands organization connection kinds and lifecycle validation.

  Pin the Claude subscription client identity headers, persist account/device metadata with encrypted credentials, and add request-scoped attribution. Existing token-only connections require replacement with identity metadata. The captured billing checksum remains unverified and is not replayed.

  Preserve Claude session identity across worker turns and recovery while keeping prompt lineage scoped to each run.

  Admit organization Claude models through session creation and lock their correct connection kind. Preserve Claude provider labels in the client catalog. Project initial system/developer instructions into Anthropic’s top-level system field so full agent sessions with skill instructions execute successfully.

  Polish Claude setup with local settings import, full-page token renewal, named model choices, provider marks, accurate subscription payment labels, and workspace discovery of organization-owned connections.

  Support workspace-owned Claude credentials, model generations, access controls and setup/account screens alongside organization connections. Migration 0545 expands workspace custom-model provider kinds. Gate Claude subscriptions behind OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED (default off), leaving Anthropic API keys and other providers unchanged.

- 3f9c757: `deleteOrganizationWorkspace` (`DELETE /v1/organizations/:organizationId/workspaces/:workspaceId`)
  now accepts an organization API key with `workspace:admin`, so an integrating
  backend can delete the organization workspaces it provisions with
  `ensureWorkspace`. It previously answered 401 "managed human session required"
  to every key. Personal workspaces stay undeletable by keys, a read key gets 403,
  and the existing quiescence rules still apply.
- 57f030c: Retain failed scheduled occurrences when connection-account selection blocks
  dispatch. Run history includes structured connector/account identifiers and
  safe eligibility reasons without credential values or raw error messages.
  Replaying an occurrence retains its original outcome without admitting work.
- 11151c6: Support a lossless scheduled-task model and reasoning patch through MCP, HTTP and the SDK. Preserve unrelated stored configuration and existing-session settings, keep normal authority validation, and reject concurrent execution-config changes instead of overwriting them.
- 30414a0: Add the first-party `session_set_model` MCP tool for changing an existing session's future model and reasoning defaults without waking it or rewriting accepted work. Preserve ordinary target authorization and exact-attempt fencing, provide stable idempotent receipts across reconnects, and report canonical model, reasoning and latency settings in full session readback. Share effective defaults across prompt admission, goal continuation, compaction and scheduled snapshots so older queued or resumed turns cannot undo an explicit choice. Deploy API and workers from a matched source cohort before using the new operation.
- e193b13: Add optional workspace-bot file-upload scope and an explicit, session-bound Slack retained-file delivery tool with durable upload checkpoints and uncertain-completion reconciliation. Existing bot installations remain eligible without files:write; administrators apply the canonical manifest and reinstall to enable uploads.
- d1f4724: Every accepted turn now records the product surface its request entered through: `web`, `slack`, `api_key`, `embedded`, `scheduled`, `agent`, `voice`, `site`, `automation`, `mcp`, or `system`. Slack, realtime voice, automations and maintenance name their surface; other requests derive it once from the verified access path (a managed or local browser session is `web`, an API or configured key is `api_key`, signed delegation or an external actor is `embedded`, workspace MCP OAuth is `mcp`, an agent attempt is `agent`, and a validated Site origin is `site`, including follow-up Send and Steer from the Site bridge). A scheduled occurrence records `scheduled` and another agent's message records `agent`, so scheduled runs no longer look like generic system work; other machine turns inherit the session's latest surface. `origin` is unchanged. Embedding hosts that call core directly can pass `surface` to `createSessionForRequest` and `acceptSessionUserMessage`.

  The durable host export carries `surface` and `modelProvider` (the provider family from the turn's execution policy, with operator-configured providers reported as `registry`) on session events and usage facts, and `toolFamily` on `agent.toolCall.created` (a first-party tool name, `integration:<reviewed domain>`, or `custom`). The worker stamps `toolFamily` on the tool-call event payload. All values come from fixed lists and carry no content. Rolling migration 0533 adds the immutable, checked `session_turns.surface` column, the three export columns, and the `host_export_claim_analytics_sidecars` companion, which inherits the claim function's exporter grants. Published export function signatures are unchanged.

- c823664: New scheduled tasks and new web sessions now pick up the workspace default Sandbox Environment and the default Variable Sets it carries. A scheduled task that omits `rigId` stores the workspace default at creation, the way session create resolves it (an existing-session task keeps its target session's environment, a Connected Machine task stores none, and `null` still opts out); a later change to the workspace default does not move an existing task. Binding an environment to a task's generated sessions, whether by default, by an explicit `rigId` on create or edit, or by switching an existing-session task to generated sessions, now requires permission to attach that environment's default Variable Sets, as session create already did. In a workspace with a default, a Sandbox Environment picked in the composer applies to that session only and is no longer carried into the next new-session form, so later sessions return to the workspace default.
- Updated dependencies [01f50bf]
- Updated dependencies [3f9c757]
- Updated dependencies [378327b]
- Updated dependencies [872391f]
- Updated dependencies [aad6598]
- Updated dependencies [6146167]
- Updated dependencies [3f9c757]
- Updated dependencies [9732749]
- Updated dependencies [6f28afd]
- Updated dependencies [a6854a7]
- Updated dependencies [b591ea1]
- Updated dependencies [a82657f]
- Updated dependencies [cabfc5e]
- Updated dependencies [8669490]
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

## 7.3.0

### Minor Changes

- 585f2c1: Add an operator-disabled ephemeral Chromium BrowserSession mode for disposable sandbox verification. Explicit requests use isolated browser contexts within a trusted actor and placement partition, preserve existing private-profile defaults, and become terminal after shared process loss instead of silently recreating or replaying work.

### Patch Changes

- 1842911: Recover managed browser viewers through the existing session when an unrelated attached Chrome profile loses its connection. Negotiate focused-input observations so native select choices appear after a viewer click, with existing generation fences and explicit fallback for older controllers.
- ec707de: Negotiate bounded viewer typing batches from the active browser controller. Preserve
  individual text events and input order while reducing request overhead; recheck the
  original document fence before each action and discard uncertain queued input
  without replay. Older controllers retain sequential input.
- Updated dependencies [1842911]
- Updated dependencies [585f2c1]
- Updated dependencies [ec707de]
- Updated dependencies [3aab8f9]
  - @opengeni/contracts@5.3.0

## 7.2.0

### Minor Changes

- 1a427e0: Add the optional Jev-backed `code_search` agent tool. It finds where something is implemented, configured or decided in the workspace in one call and returns verbatim, line-numbered passages with a coverage status. It is controlled by `OPENGENI_CODE_SEARCH_MODE` (`off` by default, `opt_in`, `default_on`, or `experiment` for a fixed per-session half), the `OPENGENI_JEV_*` settings, and a per-workspace `codeSearchEnabled` setting (`null` follows the deployment). Each session freezes its decision when it is created (`sessions.code_search_enabled`, rolling migration 0520, exposed as `codeSearchEnabled` on the session), and children keep their parent's, so later setting changes never add the tool to a running session's cached prompt; only the deployment switch-off and a workspace Off, and undoing them, reach running sessions. Each call records Jev usage per workspace. The Jev key stays on the server (API and worker processes) and never reaches a sandbox or Connected Machine, which only run allowlisted read-only ripgrep and file reads. Windows Connected Machines do not get the tool. `tool_search` now lists every tool the query names exactly before BM25 results.
- 6eb431b: Allow authenticated hosts to replace an existing session MCP attachment with an accessible native connection through the standalone credential rotation API. An optional explicit replacement URL must match the native account's stored destination while the old URL remains a compare-and-set precondition. Preserve resource restrictions, version fencing, quiescence and idempotent receipts without replacing session history or accepted-attempt identity.

### Patch Changes

- 084616e: Advertise the product documentation the web console links from its Help menu.
  `ClientConfig` gains an optional `documentationUrl` field (an absolute http(s)
  URL, or `null` when the deployment hides the link) served by
  `/v1/config/client`, and `@opengeni/contracts` exports
  `DEFAULT_OPENGENI_DOCUMENTATION_URL`. Operators set it with the new
  `OPENGENI_DOCUMENTATION_URL` setting: unset means `https://docs.opengeni.ai`,
  `none` hides the link, and any other value fails startup. An absent
  field means a server that predates it, so clients show no link.
- Updated dependencies [084616e]
- Updated dependencies [1a427e0]
- Updated dependencies [6eb431b]
- Updated dependencies [48a8774]
- Updated dependencies [e422b62]
- Updated dependencies [bd365b7]
  - @opengeni/contracts@5.2.0

## 7.1.1

### Patch Changes

- 3d33f17: Allow the authenticated screenshot downloader to render retained browser JPEG and WebP captures while preserving PNG-only computer screenshot validation.
- Updated dependencies [23f4717]
  - @opengeni/contracts@5.1.1

## 7.1.0

### Minor Changes

- 86c710a: Expose a first-party Connected Machine enrollment-token tool with existing enrollment-management authority, short-lived tokens and deployment-bound installer commands. Include agent guidance without introducing an additional approval flow.

### Patch Changes

- d92af11: Keep original command text through ambiguous launch recovery and persist it separately from bounded previews. Preserve whitespace, mark clipped previews with an ellipsis, and show complete commands on expansion and hover.
- 2f8bc58: Use bounded readable MCP tool aliases while preserving exact account routing and historical approval rehydration. Retain action and account display metadata in native and Codemode timeline events and approval cards without changing execution or approval identity. Legacy opaque calls resolve only against the current authorized tool catalog.
- Updated dependencies [d92af11]
- Updated dependencies [f60ca2b]
- Updated dependencies [86c710a]
- Updated dependencies [2f8bc58]
  - @opengeni/contracts@5.1.0

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

### Minor Changes

- 6d0a4de: Include opengeni-client in the default Skill catalog in local, self-hosted and
  managed deployments. The repository guide is the sole authored source; generated
  runtime assets include every reference and require no Pack, installation, network
  fetch or sandbox to read. Explicit bundledSkillIds selections still narrow it.

  Improve adaptive resource discovery, UI selection, runtime behavior, tool data
  semantics, and outcome-based verification without prescribing a fixed product
  architecture or answer format.

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

- 3fa175e: Provide bundled OpenGeni product help with official documentation links,
  integration and billing boundaries, and dependency recovery guidance. Hosts can
  exclude it with the existing bundledSkillIds selection, including an empty list
  for embedded agents. Update the canonical integration guide.
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

- 1cb688d: Add explicit permanent Skill removal review bindings and truthful removal receipts.
  Deletion approval is bound to the exact removal proposal; existing save approvals
  cannot authorize irreversible deletion. Review surfaces distinguish removal from
  activation and preserve conversations.
- 7e2436a: Keep ordinary chat attachments out of Knowledge unless selected as useful evidence or a reusable reference. Distinguish supporting evidence from discoverable references, preserve exact originals and revisions, and add read-only collection and duplicate discovery before saving. Includes maintenance migration 0469; old runtimes must be drained before activation.
- 0bf014d: Add a session-authorized Codex account projection. Capacity retry choices follow
  the waiting turn's accepted subscription pool after source changes, including
  Disabled. Running turns keep their accepted account label while next-turn
  choices and workspace settings continue to use the current source.
- 0ea365c: Route user-facing reports, including secondary audit outputs, to native document
  Artifacts before authoring. Persist explicit report requirements and require
  server-verified current-head inspection evidence at goal completion, preserving
  ordinary chat, internal worker findings, code navigation and explicitly requested
  local-file workflows. Keep unavailable or failed report delivery incomplete
  instead of silently substituting sandbox links.

### Patch Changes

- c64a94f: Support simultaneous authorized personal and workspace MCP account attachments with immutable account-qualified routing, sender isolation, and scheduled execution binding. Move attachment controls inside Connectors with readable ownership labels; keep account setup on the Capabilities page.
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
- 9d9b94b: Keep the published dependency closure aligned with the updated plugin removal
  contracts. The SDK exposes named removal outcomes and optional preview-token
  confirmation alongside the existing installation-version check.
- 621201d: Distinguish queued sessions from running agents and expose durable dispatch wait
  evidence in session detail reads, including retry timing and recorded errors.
- 1641006: Recover serialized document and presentation edits after reload without treating an already committed local edit as a stale pending conflict.
- c9e2743: Accept an explicit null skill-review reference on structured human-input questions, matching the contracts wire type without changing API runtime validation.
- Updated dependencies [6d0a4de]
- Updated dependencies [c64a94f]
- Updated dependencies [1c924ed]
- Updated dependencies [c31a951]
- Updated dependencies [f90d628]
- Updated dependencies [aa09567]
- Updated dependencies [d1ab270]
- Updated dependencies [c8bb974]
- Updated dependencies [3fa175e]
- Updated dependencies [332a02d]
- Updated dependencies [132b945]
- Updated dependencies [779b16b]
- Updated dependencies [1cb688d]
- Updated dependencies [621201d]
- Updated dependencies [f90d628]
- Updated dependencies [1bfb6a4]
- Updated dependencies [7e2436a]
- Updated dependencies [9d9b94b]
- Updated dependencies [c66ba31]
- Updated dependencies [f7c9169]
- Updated dependencies [0ea365c]
  - @opengeni/contracts@5.0.0
  - @opengeni/connect@0.3.0

## 6.1.0

### Minor Changes

- 85cafd0: Add a shared workspace/session artifact catalog over existing Sites, editable artifacts, generated images, and published files. Keep file bytes and content authorization in their existing domains, expose bounded filtered discovery through the SDK, and retain explicit sandbox-file publication provenance. The web Artifacts library includes type/search/sort controls, grid/list views, retained image previews, and file viewers that do not wake compute. Published images use the shared chat image/lightbox presentation; ordinary HTML file downloads remain non-executable.

### Patch Changes

- Updated dependencies [7746251]
- Updated dependencies [85cafd0]
  - @opengeni/contracts@4.1.0

## 6.0.0

### Major Changes

- efeaa9c: Replace autonomous Memory and reviewed Knowledge authoring with structured Knowledge entries, exact revisions, evidence, groups and nonblocking review. Add centralized Agent learning defaults with chat and scheduled-task overrides, private original-file ownership, canonical source preparation and rebuildable retrieval. Retire legacy Memory/learning mutation APIs and SDK methods; migration 0461 requires a drained maintenance cutover and the matching runtime. See docs/knowledge.md and docs/deployment.md.

### Minor Changes

- ad9dc2f: Add a non-provisioning external identity lookup and opt-in, operation-keyed service workspace onboarding. Cancellation-bearing revocation reuses native membership teardown and the organization-workspace receipt ledger to fence a delayed grant, including when no membership exists yet. Legacy unkeyed onboarding remains unchanged and cannot be fenced retroactively.
- 750060c: Support inline HTML visualizations, retained images, and embedded Sites in chat. Add a plain HTML Site client, preserve application request headers through the shared bridge, document visualization workflows, and use Image 2.5 Sunburst for Codex image generation.
- da4a85f: Add native organization-admin MCP credential resolver registration by stable workspace externalSource. Support encrypted, idempotent generation-checked endpoint/secret rotation and revocation with fail-closed namespace routing and live physical-use fencing. Existing accepted participant, schedule and child authority remains unchanged. Migration 0463 requires maintenance and matching API/worker binaries.

### Patch Changes

- 50ac837: Add explicit accepted-turn host binding selection for shared conversations. Capture each participant's exact owner delegation without changing the configured destination or borrowing creator credentials, preserve fixed bindings and scheduled/child live authority checks, and apply session-local server configuration to follow-up selection. Document the supported empty-session then first-text admission flow.
- Updated dependencies [50ac837]
- Updated dependencies [ad9dc2f]
- Updated dependencies [750060c]
- Updated dependencies [da4a85f]
- Updated dependencies [123cf57]
- Updated dependencies [efeaa9c]
  - @opengeni/contracts@4.0.0

## 5.1.0

### Minor Changes

- 935af4e: Add an authorized standalone session inline MCP credential rotation operation with durable idempotent receipts, exact destination and credential-version fencing, and atomic quiescence checks. Expose the operation through HTTP and the SDK without sending messages, scheduling work, retrying external mutations, or widening connection or attempt authority. Keep existing message-bound credential updates unchanged.
- d08dbb6: Support capability-gated transactional large-file edits on Connected Machines,
  with bounded transfers, verified outcomes, and live authorization checks. Keep
  legacy agent writes compatible and report oversized outbound requests accurately
  instead of marking a healthy agent offline. Native agent support is required;
  unsupported filesystem semantics fail closed.

### Patch Changes

- 4e2b59d: Align the optional plugin installation logo field with the API schema under exact optional property checking.
- 4e2b59d: Route plugin discovery types and endpoint compatibility through the public SDK boundary, using a narrow contracts entry without schema-runtime imports.
- 488a69b: Expose bounded current-failure evidence on session detail reads so recovery diagnostics do not depend on timeline pagination. Show recorded consecutive retry streaks without inventing lifetime totals, and distinguish Codex account assignment, affinity/lease reuse, and actual switches without changing allocation policy.

  Read session status and its replay cursor coherently, decode bounded diagnostics through the lossless storage codec, and record account transitions atomically against the current assignment with attempt-keyed replay and compatible switch reasons.

- Updated dependencies [4e2b59d]
- Updated dependencies [488a69b]
- Updated dependencies [935af4e]
- Updated dependencies [d08dbb6]
  - @opengeni/contracts@3.1.0

## 5.0.5

### Patch Changes

- Updated dependencies [e1a50ba]
  - @opengeni/contracts@3.0.2

## 5.0.3

### Patch Changes

- Updated dependencies [6a60a58]
  - @opengeni/contracts@3.0.1

## 5.0.0

### Major Changes

- cffd21b: Use authenticated canonical users instead of session end-user labels. Session
  creation rejects caller-supplied identity scope; list filters use scopeSubjectId.
  Chat user mode uses asUser and explicit workspace membership, while collaborators
  address the same session ID. Reopen legacy user-namespaced chats by session ID.

  Retire active session Memory in favor of task notes. Historical session Memory
  remains stored and old selectors hydrate as off, never workspace. User Memory
  uses the verified active-turn user. Preserve frozen scheduled agent-reach policy.
  Migration 0457 requires the documented maintenance cutover and matching writers.

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
  - @opengeni/contracts@3.0.0
  - @opengeni/connect@0.2.0

## 4.0.2

### Patch Changes

- 1b0f4f2: Expose unavailable background command observations separately from command lifecycle state, and render that uncertainty in command and session status.
- Updated dependencies [1b0f4f2]
  - @opengeni/contracts@2.15.2

## 4.0.1

### Patch Changes

- 068be26: Complete a Skill save in the same transaction as its one verified human chat decision. Show the full immutable Skill folder, preserve exact scope and revision checks, and refuse delegated, stale, or mismatched approval. Autonomous saves activate directly; declining a proposal preserves existing active guidance.
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

## 4.0.0

### Minor Changes

- 14dd6fe: Add workspace transcription provider preferences and optional fallback after explicit rejection, preserving recording pins after uncertain or successful attempts. Refresh expired SuperGrok credentials and recover the provider's invalid-credential 403 response.

### Patch Changes

- 231b103: Apply explicit Codex account switches and unpins to capacity-blocked turns, preserving the same turn and history through recovery. Display current account selection separately from future preferences and report when a switch requests a capacity recheck.
- 9827c25: Add message action slots and an optional source message boundary for managed-human forks. The web UI places turn feedback and Fork from here beside Copy and the timestamp. Message forks preserve existing authorization and idempotency, copy only the selected canonical history prefix, and reject ambiguous, compacted, or incomplete boundaries.

  Migration 0429 requires draining the API and both worker pools and provisioning the updated runtime routine contract before starting the new binary.

- 5904fd1: Remove the Site SDK endpoint allowlist. Workspace API requests now reach ordinary authorization handlers in published Sites and sandbox previews; tenant routing, agent permission limits, and direct integration-tool checks remain unchanged. Clarify the distinction between authoring, preview, and viewer access in the Sites skill, including honest reporting of viewer-only verification.
- Updated dependencies [231b103]
- Updated dependencies [392c575]
- Updated dependencies [9827c25]
- Updated dependencies [5904fd1]
- Updated dependencies [14dd6fe]
  - @opengeni/contracts@2.15.0

## 3.8.0

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

- 575af5b: Expose workspace project management through MCP, including shared pins/order, session filing, project-filtered discovery and project selection at session creation. Bundle concise, on-demand project organization guidance for every agent, independent of compute backend and retain existing session authorization checks.
- b1d3673: Add the `@opengeni/sdk/chat` facade (`OpenGeni`, `Chat`, `createChatHandler`, Vercel AI SDK and OpenAI adapters) and the `@opengeni/react/chat` drop-in component. Sessions gain `agentAccess`, an opaque `endUser` label, and `memoryScope`, enforced in the session-authorization seam so one workspace per customer can hold isolated, per-user, or shared chats. Organization API keys gain `access: "read"` and `GET /v1/organizations/:id/sessions`. Close the tool-widening paths: child tool selection, agent tool-policy updates, scheduled-task sessions, and the Codemode SDK proxy can no longer exceed the creating session.

  Private-memory identities use bounded hashes of exact source/user tuples. Correction, archival, and replacement enforce the private writable scope. Chat reload restores unresolved approvals and questions, and the chat component uses the complete human-input form with multiple selections and Other answers.

  Session-scoped discovery preserves the embedding host's allowlist. Responses streams emit the complete message/content lifecycle with stable per-response IDs, including incomplete settlement for human waits and cancellation. Streaming text preserves the same paragraph separators as the final reply.

- 2fb17fd: Track published Site session origin automatically; add origin-filtered session
  listing and skill defaults for reusable in-Site conversations. Site provenance
  remains independent of project placement and session authorization.
- 107aa14: Support standard SDK/React conversations in Sites and sandbox previews, direct
  HTML/source uploads, exact deployment package pins, and embedded layout/queue
  defaults. Refresh exhausted Grok capacity after external resets.
- 0a81cc8: Add durable workspace pause/resume timers with duration controls, countdowns,
  manual cancellation, and idempotent worker execution. Migration 0420 requires a
  maintenance deployment: drain old writers and deploy matching API/workers.

### Patch Changes

- fa2b99a: Preserve workflow wake retries until pending input is admitted, while future waits stay parked at their deadline, and expose current session waits and waiting descendant counts. Refresh wait status on live events and retain the status projection sequence so newer session reads cannot be overwritten by older events.
- d06450c: Capture final provider HTTP request bodies for the context inspector, including conversation input and provider-normalized tools/settings. Keep unsupported or oversized captures explicitly unavailable, label section/item token estimates, and preserve transport cancellation and streaming behavior.
- 1c4b707: Expose goal_resume so agents can resume any paused goal without a pause-reason restriction; include it for existing sessions with goal_pause.
- cc1bfe0: Add cursor-bound project, creator, and date filters to session pages so grouped sidebars can load older sessions independently within the group being viewed.
- 3db0b05: Bound instruction draft and activation requests, including response-body reads, and accept caller cancellation and timeout options. The web instruction editor confirms saves directly from activation responses and reuses operation IDs when retrying uncertain saves.
- 4708cfb: Preserve compact session-event coverage when re-streaming through the SDK proxy helpers so downstream gap recovery does not replay already-covered deltas.
- 6de9fe3: Preserve newer composer draft content and project provenance when a stale realtime create records selection history, while exposing optional project provenance consistently across contracts and SDK types. Store project provenance in rolling-upgrade-safe additive draft columns behind a metadata fence, concurrent partial index, bounded resumable backfill, and separately committed validation; dual-write mixed-version draft writers without holding schema locks across legacy-row scans. Avoid passive hydration autosaves and honor the latest route launch intent when hydration completes.
- cda46e8: Resolve session schedule indicators from current indexed schedule targets, including paused schedules. Add a session-filtered schedules list so existing chats link to all schedules targeting them without reading workspace schedules in the browser.
- 3a29372: Keep embedded conversation foreground and background theme-matched. Support filtering published Sites by creating or publishing session for the session Artifacts panel.
- d8a70ec: Unify first-party and integration tools behind one workspace gateway for MCP, model execution, Codemode, SDK, and browser clients; require host-confirmed SDK approval for human-gated model calls, keep Codemode claims live through gateway preparation, and deduplicate reclaimed tool-created events; add opt-in resource-bound MCP OAuth; ship governed self-contained HTML Sites with retained source, version rollback, an exact-version direct-call tool allowlist, and a native Site-authoring Skill; and default Modal self-hosts to OpenGeni's public digest-pinned desktop runtime image.
- Updated dependencies [22a6704]
- Updated dependencies [4536385]
- Updated dependencies [7dac7e3]
- Updated dependencies [fa2b99a]
- Updated dependencies [fa12951]
- Updated dependencies [c1dc59b]
- Updated dependencies [1fc0889]
- Updated dependencies [d06450c]
- Updated dependencies [d9dbd5d]
- Updated dependencies [c69ad5f]
- Updated dependencies [1c4b707]
- Updated dependencies [c90f3fc]
- Updated dependencies [414946c]
- Updated dependencies [0c39126]
- Updated dependencies [0c39126]
- Updated dependencies [575af5b]
- Updated dependencies [6de9fe3]
- Updated dependencies [cda46e8]
- Updated dependencies [b1d3673]
- Updated dependencies [2fb17fd]
- Updated dependencies [3a29372]
- Updated dependencies [107aa14]
- Updated dependencies [d8a70ec]
- Updated dependencies [0a81cc8]
  - @opengeni/contracts@2.14.0

## 3.7.0

### Minor Changes

- 6b65383: Replace goal-scoped long waits with self-only session-level `wait_for_input`, add provider-neutral `command_wait`, and deliver terminal background-command proof as exactly-once durable agent input with workflow wakes for nonterminal sessions while preserving event-only audit for terminal sessions.

### Patch Changes

- 6f84c02: Make durable Codex credential leasing unconditional, preserve rotation-off as an active-account-only capacity policy, and recover definitive credential failures through same-turn failover or durable capacity waiting.
- Updated dependencies [6b65383]
  - @opengeni/contracts@2.13.0

## 3.6.0

### Minor Changes

- b420912: Show the exact model-visible system instructions, tools, skills, and token counts in the session Debug inspector.

### Patch Changes

- d63ee0f: Keep Connected Machine file links in the target's canonical filesystem namespace, including Windows drive and UNC roots, and reject stale file requests with a retryable route conflict.
- Updated dependencies [d63ee0f]
- Updated dependencies [b420912]
  - @opengeni/contracts@2.12.0

## 3.5.1

### Patch Changes

- 8b42f58: Add the managed-human API, SDK, and atomic tenant lifecycle for creating additional organizations with an isolated Personal workspace and a first shared team workspace.
- 0214875: Price model usage with a 5% default markup and dedicated cache-write rates, and show provider estimates, equivalent OpenGeni credit prices, and actual credit-path prices separately in Insights.
- e2a668b: Add the built-in, instruction-only OpenGeni Product Integration Pack for adaptive, tenant-safe customer integrations, with explicit per-session activation that prevents its implementation guidance from entering ordinary customer chats.
- 9c45eae: Keep pending sessions distinguishable with a sensitive-safe opening-prompt preview or short session reference, and let bounded parallel semantic title generation finish after quick responses instead of cancelling it at turn settlement.
- Updated dependencies [38de50d]
- Updated dependencies [8b42f58]
- Updated dependencies [0214875]
- Updated dependencies [e2a668b]
- Updated dependencies [9c45eae]
  - @opengeni/contracts@2.11.1

## 3.5.0

### Minor Changes

- 8f81b57: Add authenticated, bounded GitHub branch suggestions for exact workspace App
  repositories and exact selected personal OAuth repositories, including focused
  contract and SDK subpaths. Recheck repository authority around provider
  requests, keep provider credentials server-side, and preserve arbitrary refs at
  the session resource boundary. Add lazy branch pickers, verified public GitHub
  URL attachment with immutable commit fencing, explicit anonymous-clone warnings
  for other HTTPS hosts, render-safe manual drafts, idempotent unlink
  reconciliation, and debounced live repository refreshes across new and existing
  sessions.

### Patch Changes

- 32b9de4: Accept web-standard custom fetch responses without requiring Bun's non-standard `Response.textStream()` extension or the newer, non-universal `Response.bytes()` method.
- Updated dependencies [8f81b57]
  - @opengeni/contracts@2.11.0

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
- Updated dependencies [9af1666]
  - @opengeni/contracts@2.10.0

## 3.3.2

### Patch Changes

- 5b9acd1: Make session attention monotonic across rapid navigation and nested trees. Failed sessions now remain red only until the viewer or their parent agent acknowledges the latest event, while historical failure lifecycle state remains intact.
- Updated dependencies [5b9acd1]
  - @opengeni/contracts@2.9.2

## 3.3.1

### Patch Changes

- b471a90: Add an organization-owner Off, Review first, or Autonomous policy for agent-managed organization identity, including owner-only API and SDK controls, exact-attempt automatic activation, immutable receipts, and the organization settings control.
- 96624a7: Move agent computer interaction to managed ComputerSession tools. The legacy runtime desktop API remains exported only as a deprecated, fail-closed migration shell; because direct sandbox desktop control and model-bound tools are no longer functional, release `@opengeni/runtime` as the next major. Managed observations now carry bounded native image content for visual model input while preserving viewer control, explicit manual/on-verify recording, and historical contract parsing.
- 4bacdd3: Add fixed-scope organization API keys, idempotent external tenant workspace provisioning, Personal-workspace exclusion, and the matching SDK and integration guidance.
- Updated dependencies [b471a90]
- Updated dependencies [96624a7]
- Updated dependencies [4bacdd3]
  - @opengeni/contracts@2.9.1

## 3.3.0

### Minor Changes

- ddce5cc: Allow scheduled generated sessions and nested workers to target an exact Connected Machine, and fail closed without leaving an unstarted generated session behind when that route cannot be established.
- 132c8d3: Require self-hosted-only session defaults to resolve to a reachable Connected Machine. Keep the composer blocked when no eligible machine exists instead of submitting an unroutable session.

### Patch Changes

- Updated dependencies [699477a]
- Updated dependencies [ddce5cc]
- Updated dependencies [132c8d3]
- Updated dependencies [88b6b48]
  - @opengeni/contracts@2.9.0

## 3.2.1

### Patch Changes

- fd05df1: Cancel abandoned session detail, lineage, and goal reads after their final mounted consumer leaves while preserving shared reads for consumers that are still active.
- 7988c84: Fence the initiating browser tab before account-changing mutations and cancel abandoned session-page, draft, turn-policy, model-catalog, and realtime-catalog reads without interrupting remaining shared consumers.

## 3.2.0

### Minor Changes

- 80d7594: Show a bounded, sensitive-safe opening-prompt preview while a session's durable automatic title is still pending, then yield automatically to the semantic agent title or a human rename.

### Patch Changes

- 595939e: Add managed Google and GitHub sign-in through fenced browser session-set transactions, server-side OAuth state, provider-aware canonical login bindings, and isolated popup UI flows.
- Updated dependencies [595939e]
- Updated dependencies [80d7594]
  - @opengeni/contracts@2.8.0

## 3.1.1

### Patch Changes

- 17d253b: Complete personal GitHub identity support across managed, self-hosted, and local modes. Add a compact connect-and-repository UI, exact local-human authority persistence, Docker-safe credential brokering, durable child and goal propagation, and reviewed GitHub tools for pull-request reviews and merges without exposing provider tokens to agents.
- c116379: Improve organization and workspace administration with compact people management, workspace-admin member controls, personal integration and Codex subscription setup, clearer permission presets, consistent connector presentation, and organization-scoped resource navigation.
- Updated dependencies [c116379]
  - @opengeni/contracts@2.7.1

## 3.1.0

### Minor Changes

- 7238fa4: Add permission-scoped advisory work discovery, durable non-exclusive typed work claims, bounded related-work projections, independent rollout controls, observability, and SDK topology filters.

### Patch Changes

- Updated dependencies [7238fa4]
  - @opengeni/contracts@2.7.0

## 2.6.0

### Minor Changes

- a7912ea: Add a one-click, owner-authorized OpenGeni Lens GitHub App installation flow for the PR Review Pack, backed by durable single-use OAuth authority, shared signed-webhook routing, and exact-repository least-privilege installation tokens. Keep bring-your-own GitHub App, GitLab, and Azure DevOps registration as the provider-neutral advanced path.
- 986f5fe: Add provider-neutral browser login session sets with bounded independently revocable slots, explicit actor switching, isolated add and re-authentication, scoped logout, non-enumerating cross-slot deep-link recovery, and rolling legacy/dual/broker compatibility.
- 6e12f3a: Add canonical-human organization recovery custody with exactly three accepted custodians, two-person approval, a fixed seven-day cooldown, promotion-only co-owner execution, durable notification evidence, and immutable workspace organization ownership.

### Patch Changes

- 9ef491b: Add the Agent Knowledge product surface, Personal workspace knowledge views and defaults, workspace learning-autonomy administration, explicit routing guidance between Memory, Skills, and Workspace instructions, authority-first organization Document search, exact replay-safe confirmed Memory materialization, and the narrower organization identity/mission boundary with richer facts retrieved from organization knowledge.
- 9a8c822: Add a focused `@opengeni/sdk/browser` client that keeps operator-only Document authority and tenancy-backfill methods out of browser bundles while preserving them on the root and `core` clients and exposing `@opengeni/sdk/document-authority` directly.
- Updated dependencies [a7912ea]
- Updated dependencies [9ef491b]
- Updated dependencies [986f5fe]
- Updated dependencies [6e12f3a]
  - @opengeni/contracts@2.6.0

## 2.5.0

### Minor Changes

- b5071cf: Require every Rig to layer setup and checks on the deployment-managed platform sandbox, reject new explicit Rig image overrides, keep provider-native image ids out of durable lease identity, and verify Browser, Terminal, and Computer services before publishing a Rig provider image.

### Patch Changes

- d741f38: Make fresh session reads generation-aware, expose authoritative detail and list read revisions plus causal read generations, and keep retained pagination and independently polled pinned projections from overriding newer session channel authority.
- Updated dependencies [76d6396]
- Updated dependencies [b5071cf]
  - @opengeni/contracts@2.5.0

## 2.4.0

### Minor Changes

- 47b88d3: Add explicit managed onboarding: ordinary verified signup completes an organization-name-only setup that creates only the owner membership and canonical Personal workspace, while unregistered invitees can use a digest-only one-time account setup link before signing in normally.
- c5e4684: Expose bounded organization-admin audit APIs and SDK methods for Default-collection backfill runs, operations, workspace receipts, and organization-wide Document authority reclassifications.
- dc10a36: Let an administrator see and set which OpenGeni workspace each Slack channel starts work in, from the Slack capability sheet. A channel with no choice is not broken: it asks the first person who uses it and remembers the answer, and the sheet says so.

### Patch Changes

- 977fa0f: Add durable provider-neutral invited-user email delivery with scope-bound retention fences, ambiguity-preserving retries, digest-only setup preview, and explicit delivery state across the API, SDK, and organization administration experience.
- 9d251cb: Add server-owned viewer, member, and administrator roles for shared organization workspaces, an explicit Personal/shared workspace kind, a privacy-safe administration projection, and audited idempotent grant and revocation commands.
- Updated dependencies [47b88d3]
- Updated dependencies [c5e4684]
- Updated dependencies [977fa0f]
- Updated dependencies [9d251cb]
- Updated dependencies [dc10a36]
  - @opengeni/contracts@2.4.0

## 2.3.0

### Minor Changes

- f30555c: Add atomic same-workspace session forks with an explicit private or workspace destination. Private-to-workspace copies require a durable acknowledgement, workspace members may fork a shared source into fresh authority of their own, and private sources remain owner-only. Exact applied receipts remain recoverable by the same live workspace actor after mutable source authority changes, while changed requests conflict and fresh keys still require current source authority. Every fork receives fresh authority, provenance, root, and sandbox-group identity without inheriting live grants, credentials, Connections, turns, goals, MCP, resource attachments, processes, or pins. The managed web control now exposes the generic Fork dialog to authorized shared-session members and verifies the returned owned destination before navigation.
- 47ccfab: Workspaces can persist exact default MCP servers and first-party OpenGeni tools for new sessions. Session creation, workspace-default policy updates, and scheduled session creation apply that policy while preserving the previous deployment defaults for workspaces without an override.
- b74e557: Add an explicit, replay-safe Document authority-reclassification lifecycle and
  a resumable organization Default-collection backfill. Reclassification requires
  the exact expected authority tuple, updates the Document and every chunk in one
  transaction, and retains immutable before/after receipts. The SDK and API expose
  the account-admin and actor-fenced operations, bounded cursor-paginated receipt
  history, and same-organization portable-personal behavior without making
  collections an authority boundary.
- 6fd5aee: Codex reset-credit overview responses now explain whether redemption belongs to the current managed human, an unowned legacy connection, another human, or an unavailable managed identity. Eligible admins can follow an explicit same-account reconnect path that claims only a null owner; existing ownership remains non-transferable without disconnect.
- b2cd0f0: Slack can notify the human when work they started stops making progress, **off by default and switched on per workspace**. The new `slackOrchestrationNotices` workspace setting carries one boolean per notice (`childRequiresAction`, `goalPaused`), two checkboxes sit beside the reaction shortcut in the Slack integration settings, and `resolveWorkspaceSlackOrchestrationNoticeSettings` fails closed: absent, malformed, or partially invalid settings resolve to both disabled, so only an explicit opt-in ever posts. An unsolicited Slack post is worse than a missed one, and the in-app rail and priority feed already surface this work.

  When a workspace opts in, a Slack-originated session's `child_requires_action` notice becomes one bounded pointer card ("A worker you started needs input", a single-line first-question or waiting-approval preview, and an **Open in OpenGeni** link to the child session), and a goal that pauses for `limits` or `max_auto_continuations` becomes one bounded line. Deferred child lifecycle notices, `user_pause` / `api` / `agent` / `no_progress` pauses, and `goal.resumed` stay silent, and so does a blocked-worker notice whose exact `(child, turn, generation)` boundary already carries a resolution or whose own row is `superseded` or `cancelled` - Slack delivery runs behind the session, and a card announcing a worker that is no longer blocked is worse than no card. Both notices draw on the same durable per-interaction slot budget as assistant progress, so an orchestration that fans out to many blocked children cannot turn one thread into a feed; a slot is claimed only when a card is actually going to be posted.

  A disabled notice takes the same "nothing to post for this event" path as an undeliverable one - no post, no ledger row, and the delivery cursor advances identically - and every pre-existing Slack card type is unaffected. Both reuse the durable per-event post-operation ledger, so reaper retries and replica claims cannot double-post. Rolling migration `0329_slack_orchestration_delivery_events.sql` adds `system.update.pending` and `goal.paused` to the Slack delivery claim's event types, and `@opengeni/db` exports the read-only `getSessionSystemUpdateById` and `childRequiresActionResolutionExists` used to resolve the exact typed notice and prove it is still current.

### Patch Changes

- 1b21135: Attach a selected user-owned Connected Machine atomically when creating a session from the managed web console, including recovery-stable `once` authority.
- 0fbf6b0: Align queued and steered message inputs with the API contract, expose the accepted control and connection-authority fields, and reject the retired per-message tools field before transport.
- Updated dependencies [1b21135]
- Updated dependencies [f30555c]
- Updated dependencies [47ccfab]
- Updated dependencies [b74e557]
- Updated dependencies [b2cd0f0]
  - @opengeni/contracts@2.3.0

## 2.2.0

### Minor Changes

- 4be2055: Child lifecycle notices. `SessionSystemUpdateKind` gains `child_requires_action`, `child_requires_action_resolved`, `child_paused`, `child_waiting_capacity`, and `child_progress` with typed, bounded payload schemas (no subject ids, credentials, or raw tool arguments), plus `SESSION_SYSTEM_UPDATE_WAKE_CLASS` (`immediate` for every pre-existing kind and `child_requires_action`; `deferred` for the other four) and `CHILD_LIFECYCLE_SYSTEM_UPDATE_KINDS`. The first-party tool catalog gains `session_human_input_respond` (default selection, not goal-required). The SDK mirrors the new kinds and tool name.
- e6ffdc7: Add the `backoff_pending` goal continuation reason (idle pacing between consecutive no-input continuations, `nextAttemptAt` at the pacing deadline) and the `SessionGoalResumedReason` / `SessionGoalResumedEventPayload` contracts for `goal.resumed` (`api` for the operator PATCH, `external_input` for the system resume of a `max_auto_continuations` pause). The React goal pill treats `backoff_pending` as ordinary scheduled work.
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
- 5d664d8: Surface why a goal is not pursuing and how long children have waited for a human. `Session.treeStats` gains optional `attentionSince` (earliest `requires_action` entry among the counted attention descendants), `Session` gains optional `requiresActionSince` on list and lineage reads, and the goal continuation projection gains optional `holdReason` for a `held_for_input` hold. `SessionChrome`'s goal pill spells out the pause reason ("Paused · cap" / "budget" / "by you" / "agent"), explains an idle-backoff check time and an agent `goal_wait` hold, and exports `sessionChromeGoalPillLabel` / `sessionChromeGoalPillExplanation`.

### Patch Changes

- Updated dependencies [4be2055]
- Updated dependencies [de3f376]
- Updated dependencies [e6ffdc7]
- Updated dependencies [0b3b8df]
- Updated dependencies [bbd19e0]
- Updated dependencies [e91d89e]
- Updated dependencies [5d664d8]
  - @opengeni/contracts@2.2.0

## 2.1.1

### Patch Changes

- ab81e47: Allow the managed staging Slack app and bot to use the visibly distinct `OpenGeni Staging` identity. The manifest, runtime configuration, installation verification, durable binding contract, SDK, web projection, and deployment artifacts now preserve one closed environment-qualified display-name setting while production continues to default to `OpenGeni`.
- Updated dependencies [ab81e47]
  - @opengeni/contracts@2.1.1

## 2.1.0

### Minor Changes

- 3e1ad07: Add turn-atomic personal Variable Set and Rig attachments for create, Send, and
  Steer, including logical-turn once receipts, recovery-safe snapshots, warning
  acknowledgement, and SDK contracts.
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
- ebb3669: Add the agent-facing `company_profile_propose` first-party MCP tool over a new `proposeCompanyProfile` seam: an exact agent attempt records one inactive organization company-profile proposal (durable-learning provenance, `agent-attempt:<attemptId>` source) that an organization account admin reviews and activates from Company Brain → Company profile & goals, which now lists pending proposals with their content.
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
- 650d6f9: Add an optional OpenSandbox Kubernetes sandbox backend with exact ID-addressed
  resume, renewable provider TTL, portable workspace archives, private server
  proxy support, pinned upstream deployment artifacts, and Azure sandbox-pool
  capacity isolation. Existing backend defaults, including Modal, remain
  unchanged unless `opensandbox` is selected explicitly.
- fe54954: Add an authorized, quiescence-fenced API and SDK operation for permanently deleting a root session tree.
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
- ba0be3d: Add activation-gated owner management for personal-resource session and standing grants, with kind-derived actions and permissions, exact session authority epochs, route-workspace-fenced revocation, RFC3339 lifecycle timestamps, bounded keyset pages, complete credential-free delegation receipts, FORCE-RLS-safe expiry and invalid-action settlement, and SDK methods that intentionally exclude standalone `once` and custom expiry.
- c7cafb1: Activate owner-only session visibility changes and same-workspace private forks
  through the public API and SDK after per-organization tenancy activation.

  Expose activation-gated session tenancy metadata, typed quiescence and
  idempotency conflicts, exact durable event fanout, and explicit retry fences.

- 5a651c8: Add the blocking first-party `session_wait` MCP tool so an agent can wait for new durable events on child or peer sessions, or for its own pending machine input, in one bounded call instead of sleeping and polling `session_events`/`session_get`/`sessions_list`.
- 48b9f09: Allow organization administrators to invite an email before registration, bind
  the invitation only after exact Better Auth email verification, and apply its
  initial shared-workspace access when the invited user joins without creating a
  redundant fallback organization.

### Patch Changes

- 9b4d5d5: Create Stripe invoices for prepaid-credit Checkout payments and expose an authorized Stripe Customer Portal session for invoices and payment information.
- 492fb71: Allow foreground session readers to acknowledge an exact rendered event sequence so later unseen events remain unread.
- 52456f9: Expose the personal-resource attachment contracts from the SDK and preserve
  atomic attachment intent through durable React composer Send/Steer delivery,
  including exact uncertain retries and authoritative stale-epoch
  reconfirmation. The managed web console can now choose fixed personal Variable
  Sets and Rigs for create and attach them with once, session, or always scope.
- Updated dependencies [3e1ad07]
- Updated dependencies [438e476]
- Updated dependencies [ebb3669]
- Updated dependencies [dc8c73f]
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

## 2.0.1

### Patch Changes

- 6f61d6e: Mint public `wss` live-view proxy URLs behind TLS terminators. Drain existing sandbox leases even when ownership is off. Treat ownership-disabled stream-capabilities as no live sandbox.

## 2.0.0

### Major Changes

- 2cb04e0: Retire Memory V1's standing prompt block and its agent writes. `memoryPromptMode` is now always `retrieval_only`: no pinned/recency working set is injected into any agent prompt, and the `legacy_standing` rollback opt-out can no longer be selected. The `memory_save` and `memory_correct` first-party tools are removed; durable agent writes go through `remember` (explicit user-directed) and task-note promotion (the agent's own findings), while `memory_search` remains so an agent can still read what a workspace knows.

  Nothing is rewritten or deleted: `knowledge_memories` rows, human REST/UI audit, search, correction, export, and the Memory Slack publication path are unchanged. A workspace that stored `legacy_standing` keeps the stored value in its passthrough settings bag, where it simply stops meaning anything, and already accepted turns keep the mode they recorded because those snapshots are immutable facts about what was composed. Migration 0295 changes no data; it reports whether anything was still relying on the mode rather than assuming it was unused.

### Minor Changes

- 1c78ed0: Separate new-session and established-session composer policy authority. Exact draft submission now atomically freezes queued-turn text, resources, model, reasoning, and latency, then rotates the server draft; queue Edit restores that exact snapshot and stale revisions surface as conflicts instead of silent rebases.
- 79ee99b: Preference descriptors now carry `activationAuthority` (`human_confirmed` | `automatic` | `null`) alongside `provenance.trust`. Trust stays the frozen creation-time fact - a revision an agent proposed reads `untrusted_proposal` forever, and both activation adapters still require that value - while the new field answers the separate question of whether a human explicitly confirmed the activation or policy activated it automatically, read from the governed-learning activation receipt at descriptor-build time. Descriptors built before this field existed parse as `null`, which keeps their immutable stored JSON and pinned descriptor hash valid.

### Patch Changes

- Updated dependencies [1c78ed0]
- Updated dependencies [f4afa19]
- Updated dependencies [8583779]
- Updated dependencies [79ee99b]
- Updated dependencies [2cb04e0]
- Updated dependencies [6d22ab5]
  - @opengeni/contracts@2.0.0

## 1.2.0

### Minor Changes

- b05130a: Hard-cut editable spreadsheets to authored-only canonical state, deterministic formula projections, and explicit current compatibility protocols. Preserve React compatibility with artifact-tool 0.1 and 0.2 while adding the 0.3 line.

### Patch Changes

- Updated dependencies [b05130a]
- Updated dependencies [55e0417]
  - @opengeni/contracts@1.4.0

## 1.1.1

### Patch Changes

- Updated dependencies [4c2d958]
- Updated dependencies [4c2d958]
  - @opengeni/contracts@1.3.0

## 1.1.0

### Minor Changes

- ca75ed9: Add the governed-learning activation controller with exact authority revalidation, destination-native workspace activation, immutable content-free receipts, and supersession-safe append-only undo.
- c297fc0: Add permission-first Company Brain guidance, Knowledge, proposal, and content-free accepted-turn context inspection surfaces.
- c297fc0: Add the permission-filtered Company Brain read and deterministic OKF export
  surface, subject-scoped full guidance history, and the Company Brain discovery
  and export experience.
- c297fc0: Route derived Company Brain proposals through the immutable workspace learning-policy snapshot before destination admission.
  Add exact rooted Task-note to proposed workspace Knowledge promotion with immutable value-free provenance and replay-safe MCP tools.
  Add atomic Task-note correction/revert with immutable old/new lineage, strict attempt/version fencing, and replay-safe first-party tooling.
- 1f860f0: Add durable publication and authenticated download support for session sandbox files. Agents can publish bounded `/workspace` outputs through a first-party tool, raw sandbox links can recover through the session API, retained file receipts render with downloads, and retained screenshots expose an explicit download action.
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
- 30ba620: Make every accepted scheduled agent occurrence an immutable, credential-free
  execution snapshot bound to one run, session, scheduled update, logical turn,
  and attempt chain. Agent tasks accept explicit `connectionAuthorities`
  (omitted preserves, `[]` clears, an array replaces), execution-affecting edits
  require the same causal human, `once` grants are consumed exactly once per
  run, cold reusable sessions converge on one revision-bound materialization
  receipt, and task deletion becomes a one-way paused tombstone with durable
  connector cleanup. Create/update requests are byte-bounded at ingress while
  stored rows stay readable. Migration `0275` is a maintenance cutover.
- c297fc0: Complete governed goal rewrites with strict agent change metadata, immutable
  proposal rejection and CAS-fenced rollback, bounded revision pagination, and
  accepted-turn root constraints that child agents may inherit or narrow. The
  original raw-array goal-revision list remains unchanged; bounded pagination is
  available through a separately named API and SDK surface.

### Patch Changes

- 6860c5f: Add organization, workspace, and owner-private scopes for Rigs and Connected Machines. Personal machine use and Rig materialization now revalidate exact-attempt grants, membership, workspace access, authority epochs, and generations before runtime access.
- 6c45ceb: Start fresh progressive-disclosure turns with only local tools, `tool_search`,
  and MCP servers explicitly marked eager by the session. Prepare every other
  strict or optional MCP concurrently, join the exact catalog only when searched
  or invoked, and keep worker first-party MCP traffic on an internal endpoint
  instead of a sandbox-facing public route while preserving the distinct root,
  documents, and files MCP paths.
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
  - @opengeni/contracts@1.2.0

## 1.0.2

### Patch Changes

- 90c0c3e: Persist bounded, content-free Company Brain prompt contribution estimates on authoritative model-call facts and expose their source breakdown and coverage in Workspace Insights.
- e0e0102: Unify browser, computer, identity, realtime, and Codemode behavior across managed sandboxes and connected machines.
- d7dfc01: Add typed workspace model-access policy reads and full-replacement updates for admin settings surfaces, plus a provider-private per-model policy verdict in the authenticated catalog.
- ffbbf4c: Add organization, workspace, and owner-private Variable Set scopes with independent metadata, plaintext-read, write, attachment, and runtime-use authority. Runtime secret materialization now revalidates the exact live attempt and personal grant immediately before ciphertext egress while audits remain value-free.
- d34dd9a: Add revision-fenced per-command memory and CPU policies for Connected Machines, exact live runner capability gating, and lifecycle-safe Linux operation accounting without introducing default resource limits.
- d2f172c: Add fail-closed, metadata-only capability, exact rig-version health, exact alert-selector data-source checks, and source/claim authority fencing for scheduled incident telemetry responders before expensive retrieval.
- c056063: Project exact Integration Facet ownership so shared or externally managed bindings are read-only and direct removal reports retained owners truthfully.
- Updated dependencies [90c0c3e]
- Updated dependencies [9c4e0b8]
- Updated dependencies [e0e0102]
- Updated dependencies [d7dfc01]
- Updated dependencies [ffbbf4c]
- Updated dependencies [d34dd9a]
- Updated dependencies [eeb7cb6]
- Updated dependencies [c3f0598]
- Updated dependencies [d2f172c]
- Updated dependencies [04b1a1f]
- Updated dependencies [c056063]
  - @opengeni/contracts@1.1.0

## 1.0.1

### Patch Changes

- 8bb860b: Keep embedded client configurations synchronized with the exported API contract revision and document the fail-closed host integration boundary.
- Updated dependencies [448117d]
  - @opengeni/contracts@1.0.1

## 1.0.0

### Major Changes

- 083387e: Replace the removed per-turn `turnInstructions` system-prefix contract with generic per-message `modelContext` content. This is a breaking release-train cutover: old mutating clients are rejected after migration 0240. Context now enters canonical user history without standard timeline rendering, preserves the persistent prompt-cache prefix, and works across initial, queued, steer, realtime delegation, and transcript handoff paths.

### Patch Changes

- 11913b7: Add separately consented Google Drive editable-artifact publishing with an explicit writable destination, connector-action approval policy, Google-native conversion, and retry-safe provider reconciliation.
- Updated dependencies [083387e]
- Updated dependencies [11913b7]
  - @opengeni/contracts@1.0.0

## 0.57.0

### Minor Changes

- 478d7fe: Add explicit, bounded root-task-tree coordination note tools with exact-attempt authority, private-session visibility, expiry, immutable create/archive receipts, and safe retry semantics.
- 478d7fe: Add a reversible workspace memory prompt mode that removes the legacy standing memory block, keeps preference observations out of agent behavioral authority, contains company-profile context for child agents, and reports metadata-only model-context contribution telemetry.
- 478d7fe: Persist exact accepted-turn goal authority, separate semantic goal revisions
  from execution progress, and add policy-controlled rewrite proposals with API,
  SDK, MCP, and runtime support.

### Patch Changes

- d86610d: Run published HTML artifacts as exact source in an opaque-origin sandbox, raise their UTF-8 ceiling to 4 MiB, and expose reusable React rendering. Add deployment-configurable default and allowed built-in session tools plus configured shared-key delegation fallback.
- Updated dependencies [d86610d]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [d86610d]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
- Updated dependencies [478d7fe]
  - @opengeni/contracts@0.50.0

## 0.56.0

### Minor Changes

- b0b2bed: Add unified browser and computer interaction APIs, reusable browser identities, native input, live streaming, and React viewer controls across managed sandboxes and connected machines.

### Patch Changes

- Updated dependencies [b0b2bed]
  - @opengeni/contracts@0.49.0

## 0.55.0

### Minor Changes

- 8beed26: Add managed-human organization membership discovery. Expose the exact active
  self-membership and personal-workspace identity returned by the existing
  narrow provisioning capability through a managed-session-only API route and
  typed SDK method, while denying delegated/API-key principals and terminal
  memberships.

### Patch Changes

- Updated dependencies [8beed26]
- Updated dependencies [8beed26]
  - @opengeni/contracts@0.48.0

## 0.54.0

### Minor Changes

- 1e78f58: Replace provider presets and nullable integration identities with immutable Integration Definitions. Curated and workspace-authored integrations now share one definition-based contract, provenance model, OAuth callback, SDK route, runtime projection, and maintenance migration with no legacy API alias or fallback authority.
- 1e78f58: Make Facet definitions and bindings authoritative throughout the Integration domain. Public routes, SDK methods, Pack components, owner identities, physical tables, persisted manifests, and runtime projections now use one Facet vocabulary with a maintenance cutover and no compatibility aliases.
- 1e78f58: Make normalized Plugin, Version, Skill Facet, and component-owner records authoritative for curated and imported Skills. Add reviewed library install, list, update, preview, and uninstall contracts; preserve Pack and Plugin ownership independently; and retire every non-MCP row from the generic capability catalog and installation ledger through a collision-free maintenance migration.

### Patch Changes

- Updated dependencies [1e78f58]
- Updated dependencies [1e78f58]
- Updated dependencies [746bbbe]
- Updated dependencies [9849e25]
- Updated dependencies [1e78f58]
  - @opengeni/contracts@0.47.0

## 0.53.1

### Patch Changes

- Updated dependencies [3d74340]
  - @opengeni/contracts@0.46.0

## 0.53.0

### Minor Changes

- d2def0c: Add the complete browser-native and semantic computer interaction system across managed sandboxes, Connected Machines, attached Chrome, and external browser placements. Ship durable browser identities, authentication repair, network routing, downloads/uploads, shared causal control, public SDK and React workbench surfaces, and one exact MCP/Codemode execution catalog with native Connected Machine access.
- 5215c0e: Add the first-party Fiken connector: a registered-app OAuth flow (`startFikenOAuth` + public callback, Basic-auth code exchange, broker-owned refresh with rotating refresh tokens) and a verified paste-a-token install route, both storing one workspace-owned `fiken.no` connection; explicit-only `fiken_*` first-party MCP tools (reads plus contact-create and idempotent invoice-draft-create); a serialized single-concurrent-request Fiken client; an `api:fiken` capability tile whose connect sheet leads with OAuth and folds the token form behind a toggle; and operator config `OPENGENI_FIKEN_OAUTH_CLIENT_ID`/`_SECRET`.

### Patch Changes

- Updated dependencies [d2def0c]
- Updated dependencies [5215c0e]
- Updated dependencies [d15d3e8]
- Updated dependencies [733c22f]
  - @opengeni/contracts@0.45.0

## 0.52.1

### Patch Changes

- 5c5ea4a: Add the universal capabilities platform with named API integration instances,
  provider-specific feature bindings, and local runtime adapters.
- Updated dependencies [b57d61f]
- Updated dependencies [5c5ea4a]
  - @opengeni/contracts@0.44.1

## 0.52.0

### Minor Changes

- aeb07f4: Add durable workspace decision publication to verified Slack bot channels with immutable configuration revisions, outbox attempts and receipts, bounded retries and terminal states, admin review/history UX, typed SDK methods, and a post-persistence governed-learning outcome adapter.

### Patch Changes

- 8b6803a: Make Modal sandbox recovery command-ready and accurately diagnosed, use workspace-only snapshots for new sessions, enforce checkpoint cadence, and publish cached rig images only after an independent cold boot.
- ff7203c: Add a read-only Atlassian Jira and Confluence connector with shared OAuth setup, selected-source live agent search and reads, and optional governed knowledge synchronization.
- Updated dependencies [8b6803a]
- Updated dependencies [aeb07f4]
- Updated dependencies [ff7203c]
  - @opengeni/contracts@0.44.0

## 0.51.0

### Minor Changes

- b46f4de: Add a compact, cursor-paginated agent-topology read surface with root, direct-child, and search filters for lazy hierarchy browsers.
- dcfe6eb: Add canonical attempt-scoped CodeMode, browser and computer interaction, and durable collaborative editable artifacts. Agents and humans now share one artifact head through the same application authority; direct MCP and CodeMode support bounded inspection, fenced edits, trusted Office import, and asynchronous export to workspace files. The session UI gains a first-class Artifacts workspace, and React interaction viewers move to an explicit lazy-loadable subpath.
- a858835: Add unambiguous Slack installation bindings and a token-free, subject-bound workspace access-request lifecycle for signed Slack identity links.

### Patch Changes

- 2f4ce5e: Add durable Seedance video generation with workspace model and funding policy,
  secure media references, retained video artifacts, sandbox materialization,
  OpenGeni-credit and workspace-gateway funding, and SDK/React playback surfaces.
- d55a093: Use truthful Google Drive read-only source-sync metadata for new connections while retaining compatibility with the legacy metadata-browser label.
- ad9123b: Pin the Slack reaction shortcut to the OpenGeni genie emoji across contracts and SDK types.
- bd5514e: Add explicitly enabled provider-neutral knowledge-source schedules with durable wake provenance, generation-fenced execution checkpoints and index obligations, fail-closed ACL activation seams, no-agent execution, layered pause state, shared schedule administration, and Google Drive source lifecycle integration.
- 90eea29: Make connected-machine removal show every dependent session and support an explicit canonical move-to-default-sandbox confirmation before revocation. Default moves prove managed sandbox readiness through the existing fleet route, active turns remain fail-closed, and typed swap rejections surface as visible errors instead of false success.
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

## 0.50.1

### Patch Changes

- 98b94e8: Project physical cancellation immediately from atomic Steer and Pause receipts, then reconcile it against durable queue truth.
- 2cd6dce: Build and reuse version-bound immutable provider images after clean rig verification, with content-hash invalidation and runtime-setup fallback for missing or unsupported providers.
- Updated dependencies [2cd6dce]
  - @opengeni/contracts@0.42.1

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
  - @opengeni/contracts@0.42.0

## 0.49.8

### Patch Changes

- ef78ecf: Separate credential-free capability discovery from exact, permission-checked live-plane grants; mint terminal credentials just in time, preserve first input across connection setup, and bound pre-open terminal memory.

## 0.49.3

### Patch Changes

- e2edfbc: Add provider-aware image generation with permanent verified artifacts,
  prompt-cache-safe history, sandbox materialization, and SDK/React rendering.

## 0.49.0

### Minor Changes

- bb9a346: Add token and cache coverage plus nullable provider-rate cost comparisons to Workspace Insights, preserving exact Gateway billing while keeping incomplete configured telemetry unpriced.

## 0.48.0

### Minor Changes

- fed43cf: Make embedded Files and Changes durable and responsive: capture complete branch comparisons, batch file-frontier and multi-repository Git reads behind one sandbox lease, preserve live stream responsiveness during reconciliation, harden portable sandbox reads, and polish the workbench's file tree, resizable panes, machine/terminal states, and embedded composer geometry.

## 0.47.1

### Patch Changes

- 200586a: Allow workspace administrators to disable structured agent human-input requests while preserving ordinary user messages.

## 0.46.6

### Patch Changes

- 70ced80: Add an offline-safe Connected Machine enrollment removal lifecycle with credential revocation, durable audit history, guarded route and lease handling, SDK/MCP support, and accessible active-list reconciliation.

## 0.46.4

### Patch Changes

- 5d8bb99: Allow scheduled tasks to target and durably wake one authorized existing session without creating a helper session or replacing its goal.
- 34c5cdb: Retain validated computer screenshots as authenticated, integrity-checked session artifacts with bounded event/history receipts, SDK range assembly, and React rendering while preserving historical inline-image compatibility.

  Fence screenshot cleanup and quota accounting across parent deletion, duplicate settlement, expiry, compensation, and garbage-collection races so provider objects are deleted only after durable lifecycle ownership and quota is released exactly once.

## 0.46.3

### Patch Changes

- 30a0b9a: Preserve internal content exactly, replace heuristic rewriting with lossless persistence, and keep public telemetry on reviewed structural projections.
- 23de73b: Add explicitly permissioned, audited plaintext reads for encrypted workspace variable-set values across REST, SDK, React, MCP, and UI surfaces.

## 0.46.2

### Patch Changes

- 5d1d0c2: Make browser live streams visibility-aware, share one routed session feed,
  bound reconciliation and heartbeat recovery, coalesce overlapping reads, and
  expose the append, publish, and SSE connection lifecycle in metrics.

## 0.46.0

### Minor Changes

- 6eb0b23: Add production resumable composer transcription with exact-subject durable
  manifests, idempotent SHA-256 chunk uploads, bounded ffmpeg segmentation, one
  recording-wide provider pin, persisted retryable segment results, deterministic
  assembly, cross-browser SDK recovery, object-ledger cleanup, and expiry purging
  of transcript metadata after every provider object is confirmed deleted. Legacy
  one-shot voice input remains compatible.

## 0.44.6

### Patch Changes

- 69bc207: Keep Codex history canonical across subscriptions and providers, separate optional owner-designated Codex Apps authority from inference allocation, and fence Apps authorization through each remote request.
- c0f8e40: Prevent model-visible GitHub installation credential exposure and duplicate brokered MCP side effects after ambiguous 401 responses.

## 0.44.3

### Patch Changes

- 4502474: Add workspace-default and explicitly personal ownership for first-party social connections, preserve causal personal authority for agent work, and retain actionable structured gateway errors.

## 0.44.0

### Minor Changes

- 664c1d8: Bound MCP OAuth setup with an absolute server deadline, abort stalled response streams, and preserve safe stage-specific API error details in SDK clients.

## 0.43.1

### Patch Changes

- c9d8b69: Make Connected Machine project paths portable and diagnosable: session responses now expose `workingDir`, and the native agent consistently supports the service user's `~` path across exec, filesystem, git, and terminal operations while reporting missing working directories accurately.

## 0.43.0

### Minor Changes

- bef5920: Add subject-scoped Workspace State preference and document-authority inventory
  metadata plus a canonical, explicitly sanitized export API and SDK method.

### Patch Changes

- b6e39fc: Polish session chrome and apply_patch rendering; clarify realtime voice-end handoff.

  SessionChrome gets denser selected-chip UX and Codex function-tool apply_patch shapes render in the specialized diff UI. Solo goal_continuation machine-input rows are suppressed in favor of the GoalRow landmark. The realtime transcript-tail instruction now keeps in-flight work going after voice ends.

## 0.42.1

### Patch Changes

- 4976e1c: Fix DNS-pinned OAuth response streaming under Bun and expose X as a built-in workspace social capability.

## 0.42.0

### Minor Changes

- fd13ba9: Add one immutable organization, workspace, or personal document destination contract for connector configuration, and make Google Drive persist and consume that authority independently from optional collections.

## 0.41.1

### Patch Changes

- abe0de6: Persist timesliced composer voice recordings in browser storage with reload-safe document ownership, opener/duplicate-tab fencing, oldest-first recovery, byte-ceiling enforcement, and durable transcript-before-draft handoff. Interrupted audio retries reuse the same recording, uncertain saved transcripts require explicit insertion instead of automatic retranscription or duplicate append, and transient handed-off cleanup failures are retried and garbage-collected owner-safely.

## 0.41.0

### Minor Changes

- 00f7d3b: Add durable, tenant-isolated onboarding proposals that atomically create inactive instruction-policy drafts with typed replay, stale-baseline, conflict, and audit contracts, plus a bounded Workspace State admin composer.

## 0.40.0

### Minor Changes

- b121e7c: Add durable Google Drive pause, resume, disconnect, reconnect, revoked-token,
  removed-app, and permission re-consent lifecycle handling with version-fenced
  state transitions, generation-bound disconnect idempotency, stale-replay
  protection, and secret-safe provider error classification.
- a49692d: Publish the provider-neutral realtime controller and the exact OpenGeni realtime composer experience at `@opengeni/sdk/realtime` and `@opengeni/react/realtime`, including proxy-friendly client contracts, batteries-included existing/new-session controls, and the public reference demo.

## 0.39.0

### Minor Changes

- b83af7a: Add replay-safe workspace instruction policy administration across the API,
  contracts, database, and SDK, including immutable operation receipts that reject
  changed requests reusing the same operation identifier.

## 0.38.0

### Minor Changes

- 1d0f2ae: Expose one effective document retrieval contract across REST, SDK, and MCP that binds the immutable initiating subject outside caller input, filters organization/workspace/personal authority before ranking, and preserves source plus authorization provenance in typed results.
- 3e4842d: Add subject-authorized accepted-attempt governance inspection to Workspace State,
  including immutable policy/preference snapshot metadata and deterministic current
  drift classification without exposing prompt or personal preference content.

## 0.37.0

### Minor Changes

- 13b961e: Add an atomic terminal session-subtree cancellation command that drains queued work, fences concurrent prompts and child creation, interrupts live attempts, durably reports cancelled children to surviving parents, and exposes the operation through the API/core/SDK control surface.
- e03397d: Freeze workspace instruction policies and structured preference descriptors at
  the accepted logical-turn boundary, add immutable per-session policy roles, and
  compose the resulting exact-attempt governance into agent and compaction prompts.
- 3baaebd: Add configurable Slack emoji-reaction summons with a least-privilege manifest, bounded thread context, and workspace-admin settings.

### Patch Changes

- 4f15920: Add an authorized, server-mediated connected-Codex GPT-Live V3 WebRTC SDP path with credential-safe negotiation and browser lifecycle helpers.

## 0.36.2

### Patch Changes

- e62495f: Allow session creators to explicitly opt out of a workspace default rig, and make live release acceptance prove its fixture command completed before waiting for a workspace capture.
- b4982fa: Expose GPT-5.6 Max reasoning end to end for managed and connected Codex models.

## 0.36.1

### Patch Changes

- 9c4d73d: Add curated OpenGeni-credit and workspace-key Vercel AI Gateway model paths for
  DeepSeek V4 Flash and Kimi K3, including exact provider routing, cache-aware
  pricing and metering, Responses tool continuity, provider-blind catalog UX, and
  stable remote-compaction cache prefixes.

## 0.36.0

### Minor Changes

- 8b3e46f: Allow a digest-pinned capability-pack sandbox image to bind an immutable Modal image ID. OpenGeni now preserves the logical OCI digest on the lease, starts the provider-native image through `ModalImageSelector.fromId`, records the actual ID in the Modal session envelope, clears lower-precedence IDs when a rig overrides the image, and keeps catalog image metadata aligned with the runtime manifest.

## 0.35.0

### Minor Changes

- dd71248: Make workspace-owned MCP OAuth connections the default, add explicit personal
  connection ownership, and preserve exact delegated personal authority across
  turns, child sessions, goals, schedules, retries, and recovery with safe
  tool-level degradation when a personal connection is unavailable.

## 0.34.1

### Patch Changes

- 408543f: Keep signed object-storage uploads credential-free so browser integrations can use provider CORS safely without sending ambient API or session credentials.

## 0.34.0

### Minor Changes

- ec0bc02: Add an opt-in browser analytics runtime contract with consent-gated, allowlisted
  Reo, PostHog, and GA4 provider configuration. Self-hosted deployments remain
  disabled by default, and public client configuration exposes no provider
  administrative credentials. Third-party modules load lazily, Reo clipboard/AI
  capture is disabled, query-bearing routes are excluded, and consent can be
  withdrawn without destabilizing the console.
- 5a4c559: Add first-party X and Reddit social connectors: OAuth connect flows (X PKCE
  S256, Reddit permanent grant) with encrypted token storage and just-in-time
  refresh, live first-party MCP tools (search, mentions, thread fetch, own-post
  sync, permission-gated reply publishing), a reddit provider in the marketing
  pack, operator config via OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON, and SDK
  startSocialOAuth/listSocialConnections.

## 0.33.1

### Patch Changes

- 8243ffe: Allow browser SDK clients to call the public API from arbitrary origins with explicit bearer credentials while keeping cross-origin cookie sessions limited to operator-configured trusted origins.

## 0.33.0

### Minor Changes

- 1ec9912: Add generic, versioned workspace artifacts with content-addressed HTML storage, a static HTML/CSS renderer, rollback history, and first-party agent publishing tools. JavaScript and active or navigation-capable markup are removed from the initial renderer until executable artifacts have a stronger isolation boundary.

## 0.32.1

### Patch Changes

- c52acc0: Ship Fast latency mode with turn-column inheritance, Codex ChatGPT honor-skip for response service_tier, and model picker UX polish.

## 0.32.0

### Minor Changes

- f413e6c: Add real Workspace Insights: durable `model_call_facts` after authoritative
  `agent.model.usage`, a `workspace:admin` insights API over usage_events + facts +
  live joins, SDK client, and a web console that drops mock rollups for honest
  UTC credit/token/cache/warm/caps reporting.

## 0.31.0

### Minor Changes

- 42428a2: Add per-session Codex remote compaction v2 (`remote_v2` / `portable`), with UI landmarks, Codex-only model locking, and opaque token accounting aligned to Codex CLI.

### Patch Changes

- 0199108: Harden the workspace Slack bot with one fail-closed scope policy, deterministic legacy connection selection, and durable replay-safe message deletion operation identities.
- b2e975f: Advance the merged knowledge release train to fresh publication identities without changing runtime behavior. This corrective source is derived from current main and does not reuse generated release output.

## Unreleased

- Add native voice-input configuration mirrors, workspace toggle resolution, and one-shot multipart `transcribeAudio` uploads.

## 0.30.2

### Patch Changes

- 96eb64b: Advance the reviewed knowledge release package graph to fresh publishable identities after the previous version projection was invalidated. This changes release metadata only and does not alter runtime behavior.

## 0.30.1

### Patch Changes

- bbcbef5: Allow callers to cancel MCP OAuth-start requests so capability activation can fail visibly instead of spinning forever when browser transport stalls.
- ddff8db: Add the read-only Workspace State inventory with bounded, authorization-scoped
  Documents aggregates and a deterministic metadata-only Memory projection. The
  projection explicitly labels legacy `knowledge_memories` preference-kind counts
  as non-authoritative observations while preserving the structured preference
  registry as the sole active preference authority.

## 0.30.0

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

## 0.29.0

### Minor Changes

- 33dc88f: Restore managed GitHub App installation with OAuth-first existing-installation
  discovery, exact owner revalidation, and hosted/operator setup-mode separation.

## 0.28.3

### Patch Changes

- 28c678d: Publish the current session first-party MCP tool selection types under a new SDK version.
- 1c4018e: Replace one-turn tool overrides with one durable session tool policy, expose
  OpenGeni-native tools in the same selection, default available tools on, and
  render delivered machine inputs as compact typed timeline updates instead of
  raw protocol JSON.

## 0.28.2

### Patch Changes

- c1dcccc: Publish the current client surfaces from one exact reviewed source revision.

## 0.28.1

### Patch Changes

- 2ec6494: Publish the current client surfaces from one exact reviewed source revision.

## 0.28.0

### Minor Changes

- 29ad09b: Persist typed machine inputs into canonical model history at turn claim, expose
  authoritative pending-input queue projections and lifecycle events, render
  delivered batches in the timeline, and preserve append-only prompt-cache
  prefixes across tools, later turns, recovery, and explicit compaction.

### Patch Changes

- 8eaa377: Expose transport-tolerant MCP output normalization from the SDK and reuse it in the React timeline parser.
- dfc3235: Separate first-party MCP authorization from exact per-session tool visibility, add fail-closed registration policy, and isolate file download URLs on the files MCP surface.

## 0.27.0

### Minor Changes

- 519d93c: Add validated inline per-session skills and discover skills directly from already-materialized repository resources.

## 0.26.3

### Patch Changes

- 110bb77: Enforce exact-subject ownership for personal OAuth capabilities and add secure direct OAuth installation for the separate workspace OpenGeni Slack bot.

## 0.26.1

### Patch Changes

- ffd246c: Keep workspace-capture Git status, diffs, and untracked files below provider retained-output limits, and publish an explicit degraded revision instead of an authoritative empty diff when repository reads fail.

## 0.26.0

### Minor Changes

- 06a5801: Add the backend workspace instruction-policy revision, activation, rollback, audit, API, and SDK control surface.
- 5511c24: Add a secure workspace-shared OpenGeni Slack bot connection with schema-backed verified-install eligibility, immutable team/bot identity across reinstall, idempotent post-operation convergence, exact scope validation, first-party channel/history/user/post tools, explicit scheduled-task routing and rebinding, and install/reinstall/recovery UI and documentation.

## 0.25.5

### Patch Changes

- 9a8f793: Add fail-closed GitHub personal/organization owner authority proofs, audited
  workspace installation bindings with explicit repository allowlists, and
  truthful disabled/unbound/bound lifecycle contracts.
- c135339: Persist safe new-session defaults after successful creates while preserving explicit tool-policy semantics and revalidating stale workspace resources before reuse.

## 0.25.3

### Patch Changes

- a0f2442: Return typed correlation-safe API failures, discard bounded non-JSON gateway bodies in the SDK, preserve retryability and ambiguous mutation outcomes, and keep composer drafts stable across transient failures and live policy rerenders.

## 0.25.2

### Patch Changes

- 85cb323: Restore provider-native web search for workspace-default Codex sessions while preserving explicit
  tool narrowing, child policy ceilings, version-fenced policy adoption, and structured URL citations.

## 0.25.0

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

## 0.24.0

### Minor Changes

- 0ed0f01: Add per-member session pin preferences with isolated server persistence, bounded/reused stable
  pagination snapshots, snapshot-free pin polling, typed SDK and React reconciliation, and accessible
  list and header controls.

### Patch Changes

- 744a93d: Add default-off, bounded adaptive Codex fleet decision telemetry with strict deterministic replay, cache-aware and work-conserving policy simulation, secret-safe event/UI observability, and independent future policy gates.

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

- bdd531c: Make Codex subscription response timeouts recoverable without blindly replaying partially observed model work. The transport now assigns a durable request identity, records attempt-fenced start/headers/first-byte/terminal metadata, enforces explicit headers, stream-idle, and whole-request deadlines, and retries once only before any response is observed. Exhausted or partial-stream timeouts retain a typed failure class and return the durable session to its existing retryable recovery path instead of hard-failing it with the opaque OpenAI SDK `Request timed out.` error. External cancellation remains authoritative, the SDK retry budget remains disabled, and Codex subscription turns keep their existing zero-credit billing path.
- 3214d70: Materialize the linked SDK and React model-provider readiness APIs from a fresh immutable release revision.

## 0.22.1

### Patch Changes

- 524599e: Normalize model, provider, upstream deployment, credential source, billing,
  capability, health, and pricing identity; expose a secret-safe authenticated
  workspace catalog with separate fail-closed credential readiness for federated
  providers; and persist the accepted model/reasoning execution policy on new
  logical turns.

## 0.22.0

### Minor Changes

- 229902b: Add trustworthy per-subscription Codex quota/reset-credit overview and allocator OCC controls, plus an owning-human managed-cookie-only reset redemption flow with durable ambiguity-safe provider idempotency.

## 0.21.2

### Patch Changes

- 4966649: Add bounded authoritative terminal-result projections to session event monitoring APIs and SDK types.

## 0.21.1

### Patch Changes

- ff23da5: Keep oversized event previews bounded while optionally linking them to integrity-addressed workspace-file evidence, and expose access-controlled metadata plus capped provider-native range retrieval through the API and SDK.

## 0.21.0

### Minor Changes

- d1dee7a: Let embedding hosts read and update an existing session MCP server's approval
  policy through the public API, SDK, and React session hook. Each claimed
  attempt freezes its policy under the session lock, so updates affect the next
  attempt without reinterpreting work already running; model MCP and
  Toolspace/Code Mode consume the same exact snapshot. Toolspace tokens and
  side-effect receipts bind every proxied call to the exact active attempt, so
  Pause, Steer, recovery, and late outputs preserve one authoritative owner.

## 0.20.0

### Minor Changes

- 9f84cc9: Add durable host-provided per-turn instructions, headless structured-input hooks, host-local queue
  focus, and reusable approval and human-input surfaces for embedded session consumers.

## 0.19.0

### Minor Changes

- 136227e: Add an immutable, versioned curated skill library with explicit workspace selection and inspectable provenance, and preserve WCAG AA contrast for dark-theme primary actions.
- 3aee519: Add a workspace-accepted, provider-agnostic transcription policy and host-adapter contract, plus an accessible composer microphone that keeps partials ephemeral and appends non-empty accepted finals to the editable draft exactly once. Policies explicitly accept automatic language detection and speaker diarization, events can carry strict neutral result metadata, pending starts and cleanup are abortable/bounded, and adapter failures stay behind controlled UI copy with redacted non-UI diagnostics.

## 0.18.0

### Minor Changes

- 4401ce7: Add a scope-checked host MCP credential resolver to the public embedding port and use it consistently for model-visible MCP tools and Toolspace/Code Mode while preserving the standalone connection broker as the default. Requests carry both the immediate session and its workspace-scoped lineage root so embedded hosts can authorize child sessions through one durable root binding. Provider-neutral bindings now carry a provider family, provider host, opaque host binding id, and exact selected-repository set; successful credentials must echo the complete binding before headers are accepted. Incompatible endpoint authentication and unenforceable resource containment surface as explicit unavailable states instead of starting a duplicate OpenGeni provider connection.
- c389adc: Add a provider-neutral host run-credential port with frozen turn/session lineage,
  off-manifest environment and file generations, proactive renewal, attempt-safe
  cleanup with bounded generation retention, output redaction hints, and structured
  reconnect UI support. Hosts can explicitly opt a frozen target out, and the
  POSIX materializer supports both Linux `flock` and a portable directory-lock
  fallback with cross-platform base64 decoding.
- d249403: Allow embedding hosts to preallocate a session UUID before OpenGeni admits the
  initial turn. Session creation preserves idempotent replays of the same UUID and
  returns a conflict for UUID reuse or an idempotency replay that changes identity.
  The additive create response also returns `initialTurnId`, so an embedding host
  can correlate a preallocated host run without misusing the nullable
  `activeTurnId` execution pointer.
- a11a7fc: Support mixed GitHub, GitLab, and Azure DevOps repositories—including multiple
  accounts or installations for one provider—in a single session through bounded,
  host-opaque credential bindings and optional read/write access intent.

  Validate binding/provider/host echoes before token injection, isolate tokens in
  hashed binding files, select Git credentials by remote path, fail provider CLIs
  closed on ambiguous bindings, and renew each binding independently while keeping
  legacy one-binding-per-provider request and file aliases compatible.

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

- 1fcd83d: Make repository mount paths provider-neutral and collision-free. Omitted paths
  now resolve to a canonical host-aware default that distinguishes GitHub,
  GitLab, Azure DevOps, and custom hosts, while one shared portable-path validator
  rejects traversal and case-folded collisions before sandbox execution.

  Hosts upgrading sessions persisted without `mountPath` should expect those
  repositories to materialize at the new host-aware location. To preserve an
  existing warm workspace location, stamp the session's former effective
  `repos/<owner>/<repo>` path explicitly before upgrading. Previously accepted
  explicit paths that are non-portable or collide after Unicode normalization and
  case folding now fail validation and must be renamed.

- 51f45a3: Publish the session-only React entry point and typed session control surface in a stable registry release.

## 0.17.0

### Minor Changes

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

## 0.16.0

### Minor Changes

- ec0697a: Ship the production-hardened captured workspace workbench, physically verified Steer/Pause cancellation across cloud, local, and self-hosted model tools, pre-model preparation, sandbox provisioning, and lifecycle/setup commands, durable quiescence admission fencing, cancellation-aware SDK reads and turn cleanup, single-round-trip pruned workspace indexing, truthful shutdown states, a responsive and accessible review dock, Unicode coverage, and package-safe CSS/SSR integration.

## 0.15.0

### Minor Changes

- f42cd4a: Replace the old queue and interruption surface with one revisioned prompt queue, durable composer drafts, atomic Steer, recursive Pause/Resume, workspace control invalidation, stale-client contract fencing, and a shared accessible queue UI for first- and third-party consumers. Remove the obsolete passive child-notification setting so every child terminal result follows the one bounded, coalescible internal-update contract.

## 0.13.0

### Minor Changes

- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- e4d3569: Add per-member workspace session pins with stable pinned-first listing, subject-scoped FORCE-RLS persistence, snapshot-backed activity pagination, optimistic OCC-safe pin/unpin updates, and accessible responsive web controls.

### Patch Changes

- ad4502a: Make the workbench and console dependency-safe, keep list identities stable, preserve caught error causes, isolate desktop consent tests from real transports, and enforce warning-free repository lint plus aggregate React tests in CI.
- 04d7595: Discover repositories at any workspace nesting depth, including linked worktrees whose `.git` marker is a file, while pruning dependency/build residue and enforcing timeout and repository-count bounds. An incomplete discovery now persists an epoch-fenced degraded capture revision, announces its typed reason, and makes clients prefer live workspace data instead of presenting a misleading empty capture.
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

- 4a25bfc: Add the `machine.link.lost`, `machine.link.restored`, and `machine.runner.restarted` session-event types for Connected Machine control-link observability (the failure-visibility doctrine's link plane). These are session-scoped, announce-only diagnostics fanned out only to the sessions that had an active op running on the machine when its control link changed — never to idle or historical sessions. A clean going-offline emits `machine.link.lost` (plus `machine.runner.restarted` when the reason is a self-update restart), and a reconnect Hello that actually cleared a going-offline marker emits `machine.link.restored`. All three project to the timeline's quiet tier (no rendered item) and are mirrored in the SDK event-type list. Adds the `sessionsWithActiveOpOnEnrollment` DB helper (one indexed lookup, no per-op tracking table) that resolves the fan-out target set.
- 3148404: Add the `machine.op.failed` and `machine.op.recovered` session-event types for Connected Machine op-outcome observability (the failure-visibility doctrine's out-of-band plane). These are session-scoped, announce-only diagnostics: `machine.op.failed` fires for infrastructure fault classes only (offline, draining-exhausted, payload-too-large, reconnecting-timeout, OS/stream/protocol) — never for a semantic miss the model asked about (a missing path, a consent gate, a nonzero exit); `machine.op.recovered` is the quiet healed-fault leading indicator. Both project to the timeline's quiet tier (no rendered item), mirrored in the SDK event-type list.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

## 0.11.0

### Minor Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

## 0.10.0

### Minor Changes

- 7bfe593: Surface the desktop-capture-blocked reason as server-visible enrollment state.

  A machine can have a display it cannot CAPTURE (macOS Screen Recording / TCC not granted). The agent's connect Hello already withholds the desktop cell in that case; this persists a human, actionable reason alongside it so the Machines dashboard / VM picker can render "display: capture not granted" instead of a bare `display_unavailable`.

  - **Contracts / SDK**: `MachineView` (and `EnrollmentSummary`) gain an additive, nullable `desktopUnavailableReason`. Non-null only when a display exists but capture is blocked; `null` == capture permitted OR genuinely headless. Absent/`null` ⇒ byte-identical to today's shape for existing consumers.
  - **DB**: new nullable `enrollments.desktop_unavailable_reason` column (no backfill — `NULL` preserves the existing "capture-permitted or headless" semantics). The display-cursor writer now persists `has_display` AND the reason together, change-guarded on either field, and self-heals to `null` on the next Hello once the grant is restored.

## 0.9.0

### Minor Changes

- e513236: Add an optional per-session `instructions` field to `CreateSessionRequest`: a first-class, system-level agent persona lever composed AFTER the per-workspace `agentInstructions` (session-specific last, non-bypassable CORE preserved). It is org-visible session metadata (returned on the session record) but is never emitted as a timeline event, so hosts can deliver per-agent-type prompts without leaking prompt content into the user-visible timeline or weakening instruction authority. Absent ⇒ byte-identical to today's composition.

## 0.8.0

### Minor Changes

- 3d708b5: Add compact event replay support for history windows and switch React session-event loading to capped compact pages with coalesced-delta resume cursors.

## 0.7.0

### Minor Changes

- 15deca0: Add per-session third-party MCP servers with write-only encrypted headers, metadata-only responses/events, `mcp_servers:attach` permission gating, and per-message credential rotation.
- 5e56bcd: Add tail-first session event loading with reverse durable pagination, older-history loading controls, and timeline props for smooth prepend pagination.

## 0.6.3

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.

## 0.6.0

### Minor Changes

- a4f370f: Carve the connected-machine UI into a dedicated `@opengeni/react/machines` subpath, and add `workingDir` to the SDK create-session request.

  - **`@opengeni/react`**: the bring-your-own-compute surface (`useMachines`, `MachinesDashboard`, `MachineCard`, `MachineDockBar`, `SharedMachineDisclosure`, `MachineStatusPill`, `ConnectionStatusPill`, `ConnectionDot`, `MachineMetrics`, `EnrollmentDeviceFlow`, `EnrollmentConsent`, `connectionStatusForState`, and the `MachineView` / `MachineState` / `MachineKind` / `MachinesResponse` / `MetricSample` view-model types) now lives at `@opengeni/react/machines`. The root keeps re-exporting it for backwards compatibility — **non-breaking** — but the root re-export is **deprecated** and will move in a future major. Import from `@opengeni/react/machines` going forward.
  - **`@opengeni/sdk`**: `CreateSessionRequest` gains an optional `workingDir?: string` field — the host working directory for a connected-machine target (the agent runs there; defaults to the machine's launch dir). Ignored for managed sandboxes.

- d9d7743: Render the self-hosted desktop stream: a PNG-frame canvas client for `transport: "relay-frames"`.

  Self-hosted machines stream their desktop as PNG-per-frame protobuf datagrams over the relay (not RFB), so the noVNC/RFB viewer could never render them — the desktop went "warm" but the live stream never came up. This adds `useRelayFrameStream`, a view-only canvas renderer that opens the relay channel, decodes each PNG frame, and paints it (latest-wins backpressure so a slow decode never queues). `useDesktopStream` now dispatches on `DesktopStream.transport`: `"vnc-ws"` → noVNC (Modal boxes), `"relay-frames"` → the frame renderer (self-hosted machines). The `DesktopStream.transport` / `client` unions gain `"relay-frames"` / `"frames"`. View-only in v1 (matches the machine's read-only mode); interactive input is a follow-up.

## 0.5.0

### Minor Changes

- 48c0d2e: Add session titles. A session now has a short display title that the agent generates itself: on the genesis turn a hidden, non-persisted directive asks the agent to call the new `set_session_title` tool, so the session is named on its own model with no extra LLM call. Users (and agents with `sessions:control`, via `set_other_session_title`) can rename; a user-set title is permanent and is never clobbered by agent writes.

  - `@opengeni/contracts`: `Session.title` / `Session.titleSource`, `UpdateSessionRequest`, and the `session.title_set` event.
  - `@opengeni/sdk`: `client.updateSession(workspaceId, sessionId, { title })`.
  - `@opengeni/react`: `useSession().updateTitle(...)`, live `session.title_set` handling, and `sessionDisplayTitle` now prefers `session.title`.

## 0.4.0

### Minor Changes

- a1c82c5: Add the world-class timeline tool-call renderer module and the sandbox workspace client surface to `@opengeni/react`.

  - **Timeline renderers**: per-tool disclosure cards (full-row toggle, keyboard-accessible), screenshots → lightbox, theme-aware Pierre diffs, turn-collapse summary chips, sub-agent worker/goal landmarks, a consumer-extensible tool registry, and complete state handling (running / complete / failed / cancelled), each with its own affordance.
  - **Sandbox surfacing**: file/terminal/git/desktop hooks and components (`useSandboxFiles`, `useSandboxTerminal`, `useSandboxGit`, `useDesktopStream`, `useTerminalStream`, `useSessionCapabilities`, `SandboxFiles`, `SandboxTerminal`, `DesktopViewer`, `WorkspaceDock`, Pierre diff/file views, `CodeEditor`).

  All additive; `MessageTimeline`'s `items` contract is unchanged. The internal `compactPayloadPreview` helper was removed from the public surface.

### Patch Changes

- 2989163: Add a `deleteDocument` client helper for removing documents from document bases.

## 0.3.1

### Patch Changes

- a78a09b: Publish the SDK source that adds `OpenGeniClient.getClientConfig()` (returns `ClientConfig`). The method was added to the source but never republished, while `@opengeni/react@0.3.0` already depends on it — so react@0.3.0 consumers could not typecheck against the published sdk@0.2.0. Released as a patch so it stays within react@0.3.0's `^0.2.0` range.

## 0.2.0

### Minor Changes

- 21c1535: Initial public release of the OpenGeni client packages.

  - `@opengeni/contracts`: shared zod wire-contract schemas and types.
  - `@opengeni/sdk`: zero-dependency, framework-agnostic TypeScript client with typed API, session lifecycle, and SSE streaming (reconnect + replay-by-sequence).
  - `@opengeni/react`: React hooks and styled components built on `@opengeni/sdk`.

  All three now ship ESM + `.d.ts` builds via tsup and are published to npm with provenance.
