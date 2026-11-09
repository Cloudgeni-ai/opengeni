---
"@opengeni/react": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Removing a duplicate login no longer leaves a connector saying "Sign in again" next to a working account. A connector's status now follows the person's accounts that still exist: a working one first, then one that needs signing in again; a removed login no longer counts. When only removed logins are left, the connector offers Connect instead of a Reconnect that could never succeed.

The OAuth client no longer counts as part of an account's identity. A login made before a deployment replaced its OAuth client (for example its Google client) is still recognised as the same account: connecting again reuses it instead of saving a duplicate, and reconnecting it no longer fails as a different account. Migration 1349 merges the duplicate personal logins that were saved under different clients, using migration 1226's rules (same person, server, authorization server and verified account; the kept login must hold every scope of the merged one; logins that something depends on, now including Slack agents, are left in place).

Gmail no longer sends `include_granted_scopes`. Gmail, Google Drive and Google Calendar share one Google client, so Google's consent screen listed the person's earlier Drive and Calendar grants, and the Gmail token carried them. Gmail now asks for and holds only Gmail access. Connecting Gmail, Drive or Calendar shows Google's account picker, and reconnecting an account names it to Google, so Google no longer signs in whichever account the browser used last.
