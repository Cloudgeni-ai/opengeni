---
"@opengeni/db": patch
---

Prepare Claude subscription refusals and capacity waits for the shared subscription core. On the core, a Claude sign-in refusal or rate limit is recorded against the account and the same turn moves on within the shared bound, a rate limit rests only the model that hit it, an overloaded response keeps retrying on the same account, a 403 fails the turn without touching the account, usage headers update the account's limits, and a turn with no capacity waits durably with the same events as today. Nothing changes today: no organization has the Claude cutover, so Claude, SuperGrok and Codex behave exactly as before.
