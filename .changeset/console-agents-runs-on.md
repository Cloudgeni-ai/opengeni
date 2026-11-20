---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"opengeni": minor
---

Console agents can say where their chats run with `runsOn`: no computer (`none`), each chat in its own cloud sandbox, optionally from an organization Sandbox Environment (`sandbox`), or one organization machine shared by every chat (`machine`). Omitted keeps today's placement. Saving or deploying refuses machines and environments that are not the organization's (Personal machines included), chat creation checks that the machine or environment is available in the chat's workspace, and a request's own `sandboxBackend`, `targetSandboxId` or `rigId` still wins within the usual checks and is recorded as the `runsOn` override; a Personal machine is never used for an organization agent chat. Organization machines and Sandbox Environments get an "All product-managed workspaces" reach option (`allowManagedWorkspaces`) that covers every workspace the organization's product manages, including ones created later. Console's agent editor has a "Runs on" setting and the reach picker the new option; `GET /v1/organizations/:organizationId/agents/compute` and the SDK's `listOrganizationAgentCompute` list the choices. The agent file JSON Schema includes `runsOn`.
