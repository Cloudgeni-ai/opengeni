---
"@opengeni/observability": minor
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Fix Modal private-registry sandbox image handling for embedded deployments and republish the observability API surface.

Modal registry Secrets are resolved through the authenticated OpenGeni Modal client, and Modal private-registry images are now warmed at turn time for pack-scoped sandbox images, not only at worker boot for the deployment-global image ref.

`@opengeni/observability` is minor-bumped so the already-source-shipped `setGauge`, `incrementCounter`, `observeHistogram`, and `debug` methods are available to external consumers. The published direct dependents are patch-bumped so their 0.x caret ranges resolve to the new observability minor in a coherent install.
