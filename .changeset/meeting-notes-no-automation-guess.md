---
"@opengeni/db": minor
"@opengeni/worker-bundle": patch
---

The built-in meeting notes no longer step aside when the meeting's owner has an automation on `recording.transcript.ready`. That check was a guess: it ignored the automation's filters and could not tell whether the automation writes notes at all, so an automation that only posted somewhere else still stopped the notes. The notes now start whenever the workspace's switch is on and the meeting has none. Nothing is overwritten: the built-in notes and the "Meeting notes" template both save only the first notes. `meetingSummaryCandidate` no longer takes `eventTriggersEnabled`, and its `own_automation` reason is gone.
