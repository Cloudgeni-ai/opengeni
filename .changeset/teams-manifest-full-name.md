---
"@opengeni/api-router": patch
"@opengeni/config": patch
---

The Microsoft Teams bot names itself with the configured Teams app name, `OPENGENI_TEAMS_APP_NAME` (default `Opengeni`, at most 30 characters), the same variable the app package generator uses for `name.short`. It appears in the welcome, help, the connect welcome and reminder, the not-available and not-turned-on notices and the AI notice on a new task; text about the Opengeni service and accounts is unchanged. The package generator also accepts a full app name, `OPENGENI_TEAMS_APP_FULL_NAME` (at most 100 characters), for `name.full`, which defaults to the short name. Existing deployments and packages are unchanged.
