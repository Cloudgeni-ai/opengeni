---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
---

Console test chats make nobody a member of the Console test workspace: a test chat runs as the tester's own test chat principal (only `workspace:read` and `sessions:create`, `sessions:read` and `sessions:control` there), and only its tester reads and continues it, through `GET /v1/organizations/:id/agents/:agentId/test-chats/:sessionId[/events]` and `POST .../test-chats/:sessionId/messages`, while their Console access is Editor or more. Console roles are reset in the same transaction as an organization role change or offboarding, set (to the invitation's role or none) when an invitation is accepted, written under a per-person lock that a concurrent offboarding can't overtake, only put on pending member invitations, and an invitation's Console role is written in the invitation's own transaction.
