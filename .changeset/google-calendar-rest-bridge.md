---
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Google Calendar can now be connected from the chat or the Capabilities page, like Gmail: each person connects their own calendar with the deployment's existing Google sign-in app, and the agent can list events in a time range, read one event, check free/busy times, and create, move or delete events. Changes ask first by default, guests are emailed only when asked, and every answer uses the calendar's own time zone. Operators enable it with `OPENGENI_GOOGLE_CALENDAR_ENABLED=true` after enabling the Google Calendar API and adding the `calendar.calendarlist.readonly`, `calendar.events` and `calendar.freebusy` scopes to their Google consent screen.
