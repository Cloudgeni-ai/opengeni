---
"@opengeni/observability": patch
"@opengeni/db": patch
---

Organization Codex accounts show their usage again on the Models page and the account page. Since API request tracing wraps the global `fetch`, every organization Codex live usage check refused to run, and each account row said "Usage unavailable" even though the account had a saved reading. Usage reads now accept the native `fetch` behind request tracing (`tracedFetchTarget` in `@opengeni/observability` unwraps it), and they still refuse a custom transport that cannot be awaited after an abort. When a live check does fail, the list row now shows the last saved reading, as the account page does, and says "Usage unavailable" only for an account that has never been read.
