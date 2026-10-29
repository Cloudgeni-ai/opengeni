---
"@opengeni/db": minor
"@opengeni/react": minor
---

An automation whose chat is parked waiting for a model account (for example a Codex plan with no usage left or none connected) now says so. Its skipped runs record `scheduled_session_waiting_capacity` instead of `scheduled_session_not_idle`, and they read "Skipped because the chat is waiting for a model account. Pick another model in the chat." The schedule's notice names the same fix. A scheduled update refused by such a chat returns the new reason `session_waiting_capacity`. The new message key is `automations.run.error.chatWaitingForAccount`.
