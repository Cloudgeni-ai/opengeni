---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

An MCP server can now ask the person a question in the middle of a tool call (MCP form elicitation, revision 2026-07-28, multi round-trip). Model calls to third-party MCP servers declare that they can answer forms; when the server answers `input_required`, the call pauses as an approval of the same call, the person answers in the approval card (possibly hours later, including in unattended runs), and the call is retried with the answer and the server's `requestState`. The model only sees the call's final result. `session.requiresAction` approvals carry a new `elicitation` field, and `user.approvalDecision` takes `content`, which the API checks against the server's form (422 with the reason when it does not fit). The question shows on every approval surface: the session card (web and native, with the form), the inbox (the question as the title; Allow for a confirmation, Answer for a form), phone push ("<server> asks: …"; forms open the app) and private Slack cards (Allow for a confirmation, a link to answer a form in Opengeni). New exports: the `McpElicitation*` schemas and helpers in `@opengeni/contracts` (also at `@opengeni/contracts/mcp-elicitation`) and their types in `@opengeni/sdk`; `InboxItem.serverQuestion`; `ToolActionReview.question`; `sendApprovalDecision` accepts `content`; React `ApprovalSurface` renders the question and passes the answer to `onApprove` as its second argument, and `McpElicitationRequest` is exported from `@opengeni/react/session-ui`; React Native `ApprovalStrip`'s `onDecide` receives the answer as its third argument; `@opengeni/testing/mcp-elicitation-server` is a fake server for client tests. See `docs/mcp-elicitation.md`.
