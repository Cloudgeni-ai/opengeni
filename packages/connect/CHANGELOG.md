# @opengeni/connect

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
