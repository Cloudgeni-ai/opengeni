---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Connecting an API integration (OpenAPI, GraphQL or built-in definition) no longer fails with a 500 when another person in the workspace already has a personal instance of it at an older revision. A new revision moves every instance to it, and the facet binding check looked up the other person's personal Connection as the caller, who cannot see it; an update that keeps a binding's Connection and tenant is no longer checked again (migration 1453). Inserts and Connection changes are checked as before.

A failed preview or install in Connect now frees the attempt, so "Add selected tools" can be tried again instead of answering 409 "in flight or uncertain". Only operations that read their source and write in one transaction opt in (`releaseClaimOnFailure`); operations with provider effects keep their claim.
