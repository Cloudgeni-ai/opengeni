---
"@opengeni/api-router": patch
"@opengeni/observability": patch
---

Unexpected request and Channel-A failures now say which component refused them. The failure logs carry the reviewed class of the underlying error, plus the browser or computer controller's closed error code and status, the connected machine's error number, or the database SQLSTATE when there is one. Browser and computer operations are now named in Channel-A failure logs too. Messages, paths and identifiers are still never logged.
