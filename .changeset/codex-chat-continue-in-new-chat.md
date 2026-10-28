---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Chats that stay on Codex can continue in a new chat with another model. The
model picker keeps other models visible in such chats and, through
`onContinueInNewChat`, offers to continue there; Codex usage-limit failures
offer the same action. `POST /v1/workspaces/:workspaceId/sessions/:sessionId/continuations`
(`client.continueSessionInNewChat`) creates the new chat on the chosen model,
seeded with a summary of the original and linked back to it; the original chat
keeps its model. The "Keep Codex chats portable" setting is now "Let Codex chats
switch to other models".
