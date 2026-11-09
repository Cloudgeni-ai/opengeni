---
"@opengeni/api-router": patch
---

The Microsoft Teams app package generator accepts a full app name (`OPENGENI_TEAMS_APP_FULL_NAME`, at most 100 characters) for `name.full`, separate from the short name Teams shows in chat (`OPENGENI_TEAMS_APP_NAME`). It defaults to the short name, so existing packages are unchanged.
