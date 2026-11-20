---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

Console test chats can answer "Ask first" approvals (`POST /v1/organizations/:id/agents/:agentId/test-chats/:sessionId/approvals/:approvalId`) and be stopped and resumed (`POST .../test-chats/:sessionId/control` with `pause` or `resume`; `GET .../test-chats/:sessionId` reports `paused`), only by the chat's own tester. `POST .../test-chats` takes an `idempotencyKey`, so starting twice with the same key returns the same chat. The Console test chat shows approval cards and a Stop control, and polls only new events. `PUT .../console/member-roles` now sets members' roles only; an invitation's Console role is chosen when inviting.
