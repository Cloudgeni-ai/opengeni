---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Event source routing keeps no provider identity. The route table has no tenant RLS, so a GitHub route is now keyed by an HMAC of the installation under a secret derived from the deployment's encryption key, and Slack and Gmail sources need no route at all: Slack callbacks already arrive resolved to their workspace and Gmail is read, not delivered. Migration 0941 removes the old plain routes; adding a GitHub source again recomputes its routes. The GitHub binding writers take the route secret as `eventRouteSecret` (`eventRouteSecret(settings)` from `@opengeni/core`). A deployment without `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` can't add a GitHub source.
