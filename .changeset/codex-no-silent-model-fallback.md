---
"@opengeni/codex": patch
---

A Codex request for a model the resolver doesn't recognize is sent unchanged, so the provider rejects it visibly. Previously it was silently rewritten to the first fallback model (`gpt-6-astra`). For example, a session set to `codex/gpt-6.1-sol` ran on Astra without any indication. The resolver now also matches against the active catalog's exact upstream slugs.
