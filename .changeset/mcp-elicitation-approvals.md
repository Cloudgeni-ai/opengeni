---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

An MCP server can now ask the person a question in the middle of a tool call (MCP form elicitation, revision 2026-07-28, multi round-trip). Model calls to third-party MCP servers declare that they can answer forms; when the server answers `input_required`, the call pauses as an approval of the same call, the person answers in the approval card (possibly hours later, including in unattended runs), and the call is retried with the answer and the server's `requestState`. The model only sees the call's final result. `session.requiresAction` approvals carry a new `elicitation` field, and `user.approvalDecision` takes `content`, which the API checks against the server's form (422 with the reason when it does not fit). New exports: the `McpElicitation*` schemas and helpers in `@opengeni/contracts` (also at `@opengeni/contracts/mcp-elicitation`) and their types in `@opengeni/sdk`; `sendApprovalDecision` accepts `content`; React `ApprovalSurface` renders the question and passes the answer to `onApprove` as its second argument; `@opengeni/testing/mcp-elicitation-server` is a fake server for client tests. See `docs/mcp-elicitation.md`.
