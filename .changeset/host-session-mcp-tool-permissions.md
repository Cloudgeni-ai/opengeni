---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
---

Products that attach their own MCP server to sessions can now let workspace admins choose Allow, Ask first, or Block for each of its tools, or for all of them at once. `getSessionMcpToolPermissions` and `updateSessionMcpToolPermissions` read and save those choices by the server's id and exact URL. Saved choices replace the session's `requireApproval` recommendation from the next run, and Opengeni enforces them like any connector permission, so a run that reaches an Ask tool waits for a person to approve it. Changing these permissions needs `capabilities:manage`, so an agent cannot change its own.
