---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
---

Console test workspace access follows Console roles: the membership a test chat creates only starts and reads chats (never `workspace:admin`, members, keys, secrets or connections, so never `agents:manage`); it is removed whenever a person's Console access drops below Editor (role change, an owner or admin made a member, offboarding), and a failed removal answers a retryable 503 `console_access_cleanup_failed`; any chat started in the test workspace needs Editor access at that moment; grants and removals are audited (`member.console_test_access_granted`, `member.console_test_access_removed`). Console roles are reset in the same transaction as an organization role change or offboarding, set (to the invitation's role or none) when an invitation is accepted, written under a per-person lock that a concurrent offboarding can't overtake, and only put on pending member invitations.
