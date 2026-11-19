---
"@opengeni/core": patch
"@opengeni/db": patch
---

A session create that the server refuses while starting its first turn (for example a personal-resource attachment that selects no personal Rig or Connected Machine) no longer leaves an idle, usable session behind when it carried an `idempotencyKey`. The refused session and its key are released, so retrying the same request gets the same refusal and a corrected request can reuse both the key and its `requestedSessionId`. Migration 1501 adds the database function this needs without granting it to the runtime yet; until a later release grants it, a refused keyed create keeps its session as before.
