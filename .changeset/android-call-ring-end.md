---
"@opengeni/db": minor
"@opengeni/api-router": minor
---

An agent's call stops ringing on the person's other Android phones as soon as it is answered or declined on one of them, or the agent cancels it, even when the app on those phones is not running. Settling a call withdraws rings the server has not sent yet and sends each Android phone that rang a silent `opengeniCall` "ended" message with the reason, which shares the ring's collapse key and expires with the ring. Migration 1343 adds the database routine for this without granting it to the runtime; until a later migration grants it, settling a call behaves as before.
