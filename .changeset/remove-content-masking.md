---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Opengeni no longer rewrites what an agent sees to hide secrets. Tool results, model input and stored history are no longer masked for known secret values or secret-shaped text, and shaped values are no longer captured into the Task vault. Text already sent to a model is never rewritten later, so the prompt cache stays stable (each active chat takes about one cache miss after the upgrade). Secrets still flow by secret reference and resolve only where a tool runs; `secret_get`, approvals and the explicit operator scrub are unchanged. Browser page reads still leave out the values of fields that standard markup marks private (password, `one-time-code`, `cc-*` autocomplete, `data-private`), but nothing is remembered or guessed, and screenshots, recordings and clipboard copies are never refused. Tool names a provider would reject (a dotted `server.tool` call) are given a valid name once, when the call is received; run `bun run db:repair-invalid-tool-names --apply` once after upgrading to fix names stored by earlier releases.
