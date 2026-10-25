---
"@opengeni/react": minor
---

The cadence picker (`@opengeni/react/ui/cadence-picker`) speaks the host's language. Its labels, weekday and month names, dates, previews and validation messages come from the message catalog under `cadence.*`, so `OpenGeniMessagesProvider` translates it like the rest of the UI. `describeCadence`, `validateCadence`, `formatRunTime` and `describeNextRuns` take the host's text as an optional `text` option, and `timeZoneLabels` as an optional second argument; without it they stay English. Typed cadences (`parseCadence` and the "text" variant) still read English.
