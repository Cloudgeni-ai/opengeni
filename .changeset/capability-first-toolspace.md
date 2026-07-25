---
"@opengeni/api-router": minor
"@opengeni/config": patch
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": patch
"@opengeni/network": patch
"@opengeni/react": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/worker-bundle": patch
---

Add capability-first session tool policies with omission-as-discovery defaults,
explicit per-turn narrowing and child inheritance, secret-safe effective-policy
projections, stable lazy `tool_search` catalogs, and matching API, SDK, React,
worker, embedding, and audit contracts.

Harden credential-bearing MCP and OAuth traffic with destination-bound
credentials, single-resolution DNS-pinned transport, bounded catalogs, schemas,
results, request and response bodies, and independently validated manual
redirects. Extend renewable, session-bound Toolspace access to connected
machines while dynamically fencing every call to the session's active attempt.
