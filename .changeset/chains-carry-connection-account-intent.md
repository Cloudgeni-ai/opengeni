---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/worker-bundle": minor
---

Goal continuations, wait wake-ups, command and child results now use the person's current connector accounts instead of copying the accounts of the turn they continue. Each accepted turn records its account intent (whose personal accounts it may use and which accounts were explicitly picked), and work that continues it resolves that intent again, exactly as the person's next message would. A reconnected or newly connected account is picked up by long-running work, and a revoked one stops being bound. A picked account that can no longer be used is never swapped for another account: that connector is left out of the continued turn. Child sessions carry their parent turn's intent. Turns accepted before this release keep copying their exact accounts.
