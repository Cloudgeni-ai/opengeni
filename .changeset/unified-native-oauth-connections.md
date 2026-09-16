---
"@opengeni/contracts": major
"@opengeni/sdk": major
"@opengeni/core": major
"@opengeni/config": major
"@opengeni/db": minor
"@opengeni/connect": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
"@opengeni/deployment": patch
"@opengeni/testing": patch
---

Unify interactive and trusted-backend OAuth setup on native workspace connections
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