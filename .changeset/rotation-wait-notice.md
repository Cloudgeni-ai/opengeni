---
"@opengeni/react": patch
---

A message that arrives while the session's sandbox is being replaced no longer sits behind a bare "Recovering". The live status above the composer now says "The sandbox reached its maximum lifetime, so Opengeni is saving the workspace and moving it to a fresh sandbox…" (or that the sandbox is being saved before it can be used again) with "Your message is saved and runs as soon as the sandbox is ready." It shows no retry counter, because this wait has no retry budget. `ProviderRecoveryFacts` gains an optional `sandboxWait` flag.
