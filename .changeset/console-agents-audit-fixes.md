---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"opengeni": minor
---

Console agents follow-ups. `CreateSessionRequest.agent` is widened to an agent configuration object, an organization agent key or id (string), or `{ ref, ... }`: code that reads it must narrow it first (`sessionAgentFieldNamesOrgAgent`). `asUser` `displayName`/`email` need a server with this release; older servers ignore them. `agents:manage` and `tool_credentials:write` are held only by full organization keys or keys that list them, never by `workspace:admin` alone (including the Developer setup preset). Organization compute reaches the Console test workspace only with `allowManagedWorkspaces` (now optional in `OrganizationComputeReach`, read as false). Agent sessions report `costMicros`. Storing a tool login for a workspace the product doesn't manage answers 422. Console audit event actions and workspace sources accept values unknown to the reader. CLI: a missing instructions `.md` file is an error, and `agents deploy --dry-run` prints the diff against the published version.
