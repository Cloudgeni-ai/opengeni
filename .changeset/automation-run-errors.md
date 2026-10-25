---
"@opengeni/react": patch
---

The Automations panel now says why a run failed or was skipped in words, such as "Skipped because the chat was still busy with earlier work.", instead of showing the recorded reason code (for example `scheduled_session_not_idle`). Skipped runs now show their reason too. The new `automationRunErrorText(t, error)` in `@opengeni/react/automations` turns a run's `error` into that sentence, and a code it doesn't know reads as "Something went wrong with this run." The words are new `automations.run.error.*` message keys, which hosts that translate the catalog can add.
