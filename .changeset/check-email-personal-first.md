---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/react": patch
---

Asking the agent to check your email now finds your own Gmail connection first. Catalog search no longer offers a plugin that only bundles MCP servers the catalog already has as connectors, such as the workspace-wide Gmail plugin. Gmail's catalog entry is tagged email, mail and inbox, and featured connectors win close matches. Connect cards for connectors that only take a person's own account (Gmail, Google Calendar, Google Drive), and every connect card in a Personal workspace, no longer ask "Who can use this connection?". The rule is shared in `@opengeni/contracts/personal-integration-setup` as `connectorTakesOnlyPersonalAccounts`.
