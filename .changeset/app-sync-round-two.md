---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

App data syncs can page through a tool's results (`paging`, `maxRecords`), remove records the tool no longer returns (`removeMissing`), fill an app's SQL table (`target`), and run on a chosen account (`account`). Apps ask people to join a personal sync with `site.data.syncs.optIn(id)` / `optOut(id)`: Opengeni shows its own confirmation in the console and on published apps, and lists personal syncs a member hasn't joined next to the connect card. Adds `getAppSyncOptInReview` and an `account` option to `setAppSyncOptIn`.
