---
"@opengeni/db": patch
---

A person's duplicate logins to the same account are merged into one. Before connecting reused an existing login, turning a connector on in a second workspace could save a second login to the same account, with tool choices split between the two. Where the service verified the account identity (Slack, Gmail, Google Calendar, Google Drive, Atlassian), migration 1180 keeps one login (a working one with the most scopes), moves the others' tool choices (strictest wins), workspace turn-ons, schedule pins and connector references to it, and revokes them. Logins with unknown identity, fewer covered scopes, or something depending on them (event triggers, vaults, Knowledge syncs, Site tool allowances, API Integrations) are left as they are.
