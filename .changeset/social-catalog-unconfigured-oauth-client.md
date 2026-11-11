---
"@opengeni/core": patch
---

X and Reddit no longer offer a Connect that can only fail. When the deployment has no OAuth client for the provider in `OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON`, their catalog entries now carry `runtime.operatorOAuthClient.configured: false` and the usual setup note, so `capability_catalog_search` reports them as unavailable, `capability_authorization_request` posts no card, and the Capabilities page treats them like other integrations missing an operator OAuth client. Before this, the chat's Connect card for X went straight to a 503 from the OAuth start, shown only as "Opengeni couldn't finish the request". Existing accounts stay listed and manageable.
