---
"@opengeni/react": patch
---

The automation form no longer shows a removable pill for every connector a run gets. The Message box keeps Repository and Environment on top, and one Connectors control under the message shows up to three logos and a count; it opens the list of connected apps to turn each on or off. A chosen app that is no longer connected is flagged on the control and stays in the list, by its catalog name where known, so it can still be removed. Connectors show their real logos there, found in the workspace catalog as in the chat composer.

`connectorLogoSources` (in the app's composer-connectors helpers) finds each connector's catalog logo by its own logo, its catalog entry or its provider's domain. `installedApiIntegrationMcpServers` now keeps an API integration's `capabilityId` and `providerDomain`, so API connectors such as Gmail or Grafana find their logos too.
