---
"@opengeni/react": patch
---

A message that arrives while the session's sandbox is being replaced no longer sits behind a bare "Recovering". The live status above the composer now says "The sandbox reached its maximum lifetime, so Opengeni is moving the workspace to a fresh sandbox…" (or that the sandbox is being saved, recovered or moved, from the recorded transition) with "The turn continues automatically as soon as the sandbox is ready." It shows no retry counter, because this wait has no retry budget. `ProviderRecoveryFacts` gains an optional `sandboxWait` flag.
