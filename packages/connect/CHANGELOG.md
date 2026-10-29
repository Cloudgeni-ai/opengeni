# @opengeni/connect

## 5.5.1

### Patch Changes

- a4b57e6: In-chat connection requests now read the same to the person and to the agent, and the sign-in window ends cleanly in embedded chats. When the person in the chat can't connect the requested integration from the card (their access doesn't allow it), `capability_authorization_request` now tells the agent so, instead of the generic "posted for confirmation" message, so it no longer asks them to use a card that can't help them. Results for people who can connect are unchanged. The card and the server share one rule for this decision (`inChatCapabilitySetup` in contracts), and the server applies it to the same access the person's chat has: what their sign-in could do when they sent the turn's message, or their latest message in that chat for a turn the platform started for them, such as a wake-up, a child's result or a goal continuation (an embed token narrows it, and their own workspace counts without a membership). Without such a message it falls back to their membership (`readTurnSenderAccess` in db). The console's chat card uses the same rule, so it no longer offers Connect to a member the agent was told can't connect.

  In-chat connect cards also start sign-in with a new optional `finishInPopup: true` flag on `POST /v1/workspaces/:workspaceId/connect/attempts`. The provider's callback then lands on a small server page that closes the sign-in window (or tells the person they can close it) instead of loading a second copy of the host page in the popup. Without the flag the return URL behaves as before. Against an older server that rejects the unknown field, `ConnectController.begin` starts again without it, so sign-in keeps working and returns to the host page as before. Browser cards set it, because they sign in through a popup. Phone cards don't, because the system sign-in browser returns to the app.

  Reviewed catalog integrations no longer carry an "MCP server" label on their connection cards and dialogs, on the web and on the phone. They read as the service itself, with its name and provider. Servers someone added by hand, and registry entries nobody reviewed, keep the label (`showsMcpServerLabel` in `@opengeni/react/in-chat-connect-model`).

## 5.4.2

## 5.3.1

## 5.2.1

## 5.1.2

## 5.0.2

## 4.8.0

## 4.7.2

## 4.7.1

## 4.7.0

## 4.6.1

## 4.5.0

## 4.4.1

## 4.3.1

### Patch Changes

- d81c315: Connecting an account no longer gives up after two minutes while the sign-in is still in progress. The Connect dialog stopped waiting after a fixed two minutes and showed "Connect polling timed out", even though the sign-in itself stays valid for much longer and can easily take more than two minutes, for example in the system browser a desktop app opens. Waiting now lasts as long as the sign-in attempt does, the backend still decides when it has expired, and if a wait does run out the person sees a plain message that they can try connecting again.

## 4.2.0

## 4.1.3

## 4.1.1

## 4.0.4

## 3.4.0

## 3.3.0

## 3.2.2

## 3.1.2

## 3.0.0

## 2.0.1

## 2.0.0

### Minor Changes

- 63bf721: Prepare a complete personal or workspace MCP connection once, with non-secret headers and protected secret-field mappings. People enter only the missing key in the conversation card; authorized agents that already have credentials use the same native Connect verification and storage lifecycle without another confirmation card.

  Connection, installation and receipt writes are atomic. Exact retries do not repeat verification or create duplicate accounts. The agent path intersects frozen attempt permissions with live ownership, selection, policy and execution fences, and never makes new tools available inside an already accepted attempt. Existing OAuth and explicit account selections remain separate and unchanged.

  Deploy matching API and worker packages before using direct agent setup. Historical attempt catalogs without the frozen permission snapshot do not gain new setup authority.

## 1.4.4

## 1.4.3

## 1.4.2

## 1.4.1

## 1.4.0

## 1.3.0

## 1.2.0

## 1.1.0

## 1.0.2

## 1.0.0

### Major Changes

- Reset package versioning: every published `@opengeni/*` package now releases together at one shared version, starting at 1.0.0. Install all `@opengeni` packages at the same version. Earlier versions are retired.

## 0.3.2

### Patch Changes

- 946f6c3: Keep OAuth completion polling active when browser isolation detaches the provider window, and discover authentication for custom MCP connection setup from the live endpoint. Resolve tool-permission discovery for selectors with a single matching account, refusing ambiguous account choices.

## 0.3.1

### Patch Changes

- d9ec660: Avoid browser warnings when an isolated sign-in window cannot be closed, and clarify the Claude authorization-code handoff.

## 0.3.0

### Minor Changes

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

## 0.2.0

### Minor Changes

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
