---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/react": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
"@opengeni/site-gateway": minor
---

Sites can ask what each of their tools needs for the current viewer before a click: `site.tools.$readiness(targets)` (`POST /v1/workspaces/:id/tools/readiness`) answers `ready`, `confirm`, `choose_account`, `connect`, `reconnect`, `blocked`, `open_in_opengeni` or `unavailable`, with the account the tool runs as, and `site.tools.$onReadinessChange` fires after a connect, a reconnect, an "Always allow" or a reset. It reads the same authority as a call and never reaches the provider; calls still enforce everything.

The Site tool confirmation shows which account the action runs as ("Shared with workspace" for a workspace account, "You" when none is involved). The checkbox now reads "Always allow on this Site from this account". The Site menu has "Reset allowed actions" (`POST /v1/workspaces/:id/tools/site-allowances/reset`).

Typed failures: a tool set to Block answers 403 with `details.code` `tool_blocked` (Site code: `site_tool_blocked`); a confirmation a published address can't show is `site_tool_open_in_opengeni`. A tool server that couldn't be reached before anything was sent (refused connection, DNS failure, a tunnel that is gone, decided only at the MCP transport's own request) now answers 503 `upstream_unavailable` with `details.code` `tool_server_unreachable`, `retryable: true` and `outcomeUnknown: false` for every gateway caller instead of a 500 (Site code: `site_tool_upstream_unavailable`).
