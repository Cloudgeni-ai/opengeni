---
"@opengeni/api-router": patch
---

Typing a saved secret on a Connected Machine or attached browser whose agent predates secret values (older than 0.1.56) now fails before anything is resolved or typed, with a clear "update this machine's agent" error, instead of the agent rejecting the whole action as "computer action is invalid".
