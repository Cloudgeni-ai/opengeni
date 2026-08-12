---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/config": minor
"@opengeni/sdk": minor
---

Add the first-party Fiken connector: a registered-app OAuth flow (`startFikenOAuth` + public callback, Basic-auth code exchange, broker-owned refresh with rotating refresh tokens) and a verified paste-a-token install route, both storing one workspace-owned `fiken.no` connection; explicit-only `fiken_*` first-party MCP tools (reads plus contact-create and idempotent invoice-draft-create); a serialized single-concurrent-request Fiken client; an `api:fiken` capability tile whose connect sheet leads with OAuth and folds the token form behind a toggle; and operator config `OPENGENI_FIKEN_OAUTH_CLIENT_ID`/`_SECRET`.
