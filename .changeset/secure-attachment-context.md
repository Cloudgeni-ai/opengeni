---
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Fail browser uploads before any network request with a typed `secure_context_required` error when HTTPS-only Web Crypto is unavailable, and surface actionable HTTPS guidance directly on failed attachment cards.