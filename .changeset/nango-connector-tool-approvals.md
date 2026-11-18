---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Per-tool approvals work for connectors served through Nango, the same as for native ones.

- A connector's approvals page resolves the connector exactly as a session does, including the integration backend switch. A Gmail, Calendar or Drive account connected through Nango is the account its approvals are managed for, with the same tools and defaults (Drive: the tools its bridge serves), instead of the page asking to connect an account. Choices are stored for that account and apply to its calls.
- Choices belong to the provider account, not the backend. When the same person connects the same account under the other backend, its connection starts with the choices already made, and every later change is mirrored to both. Switching a connector between native and Nango no longer resets "Ask first" or "Always allow".
- Drive through Nango lists the tools its REST bridge serves.
- A Personal workspace carries a connector its owner connected through Nango in another workspace, as it does for a native account.
- Site tools and the workspace tool gateway read a personal account's choices from the workspace it was connected from, as an agent turn does, so a choice applies wherever the account is used.
- Gmail approvals through Nango get the same review titles as native Gmail.
