---
"@opengeni/core": patch
---

Avoid an empty database transaction when resolving the Site or schedule viewer from a human or service grant. Agent audiences retain their live attempt checks, and resource access keeps its existing tenant and permission checks.
