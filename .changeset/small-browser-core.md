---
"@opengeni/sdk": patch
---

Add a focused `@opengeni/sdk/browser` client that keeps operator-only Document authority and tenancy-backfill methods out of browser bundles while preserving them on the root and `core` clients and exposing `@opengeni/sdk/document-authority` directly.
