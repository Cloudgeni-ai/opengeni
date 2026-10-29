---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Each person can now choose their own default machine in a shared workspace ("Your default machine" in workspace settings). The chats they start begin there, ahead of the workspace default, and any active machine they can use qualifies, including their own Only me machine. Nobody else sees the choice. Automations and agent-created chats keep following the workspace default, and when the chosen machine is removed or no longer available, the person's new chats fall back to the workspace default until they choose again. `GET`/`PUT /v1/workspaces/:workspaceId/my-default-execution-target` reads and saves it (`null` clears it), the new-session draft returns it as `memberDefaultExecutionTarget`, and the SDK adds `getMyDefaultExecutionTarget` and `setMyDefaultExecutionTarget`.
