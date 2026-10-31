---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/subscriptions": minor
"@opengeni/api-router": minor
"@opengeni/react": patch
---

A turn uses its person's own Codex, Claude or SuperGrok subscription first, where they turned it on. In their Personal workspace it is always on; in any other workspace each person turns their own account on for the messages they send there, in shared and Only me chats alike, and it then pays before the organization's accounts. Other people's turns never use it, and turns without a signed-in person (scheduled and service turns) don't either. An account added from a shared workspace starts turned on there, and each account's page has a "Use for my messages in …" switch per workspace.

Being turned on is a standing personal-resource grant: user-resource kind `subscription_connection` with action `subscription_connection.use`, issued with mode `always` and context `workspace_shared` in that workspace and revoked like any other grant. Acceptance freezes the account into the turn as consent restricted to that session and connection, and in shared chats the database refuses an automatic binding to a personal account without it. `issueUserResourceGrant` moves to the base and browser clients, beside `listUserResourceAuthorities` and `revokeUserResourceGrant`.

The per-person personal-fallback opt-in and the organization's "personal fallback allowed" setting are retired: both are still stored and returned, but no longer change which account pays, and the settings page no longer shows them. Existing opt-ins are not converted, because that would widen where an account is used.
