---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/runtime": minor
---

Add credential profiles: an opt-in mapping from environment variable names to
secret references that Opengeni resolves for every command an agent runs and
adds to that command's environment, on Connected Machines and managed sandboxes
alike. Profiles are set for the workspace or for a chat (inherited by the chats
it starts) through `/v1/workspaces/:workspaceId/credential-profile`,
`/v1/workspaces/:workspaceId/sessions/:sessionId/credential-profile` and the
`secret_profile_get` / `secret_profile_set` agent tools. An optional git helper
lets git use `GH_TOKEN` for github.com over HTTPS without files or global config.
