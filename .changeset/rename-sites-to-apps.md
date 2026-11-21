---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Sites are now called apps in user-facing text, and the first-party `site_*` tools are `app_*` (for example `app_data_query` and `app_publication_update`). The old `site_*` names keep working everywhere a tool is called or selected, but are no longer listed. `FirstPartyMcpToolName` gains the `app_*` names; SDK methods, routes and field names are unchanged.
