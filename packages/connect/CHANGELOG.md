# @opengeni/connect

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
