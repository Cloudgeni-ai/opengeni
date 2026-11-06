---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/react": patch
---

Agents no longer offer a Connect card for an integration this deployment cannot connect: its setup is switched off by the operator (for example Google connectors with `OPENGENI_GOOGLE_CONNECTOR_SETUP_ENABLED=false`), or the provider needs an operator OAuth client that is not configured. `capability_catalog_search` reports such entries as `setup.status: "unavailable"` with no `nextAction` and the catalog's note as the detail, `capability_authorization_request` returns `unavailable` without posting a card, and tool search no longer names them as connectable. A card already in a chat shows that the integration can't be connected here instead of a Connect button. The rule is the one the Capabilities page already used to hide these entries, now shared as `deploymentCannotConnect` in `@opengeni/contracts/personal-integration-setup`. Integrations that are already on keep working and stay manageable. Catalog entries missing their operator OAuth client now carry a note saying so.
