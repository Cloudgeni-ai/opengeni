---
"@opengeni/api-router": patch
---

When a connector isn't turned on in a workspace but the person already has their one own login for it, `capability_catalog_search` and `capability_authorization_request` now say so (`reason: "not_enabled"`) and that the card uses that login here without a new sign-in, instead of describing a first connection.
