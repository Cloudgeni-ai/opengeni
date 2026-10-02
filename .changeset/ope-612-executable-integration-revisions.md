---
"@opengeni/capabilities": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Include normalized effective OpenAPI operation destinations and the primary manifest URL in immutable revision identity. URL rotation no longer reuses a document-only revision, while equivalent destinations still deduplicate and existing immutable versions and installation fences remain intact.

Classify known credential Connection rejection at install-time revalidation separately from internal failures. Missing or inaccessible references return 404, and inactive or incompatible references return 422 without weakening ownership, scope, or optimistic-concurrency checks.