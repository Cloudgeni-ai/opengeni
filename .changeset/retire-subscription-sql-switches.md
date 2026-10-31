---
"@opengeni/db": patch
---

Remove retired per-account subscription cutover switches from current SQL authorization, accepted-authority and connection-health callers. Existing provider protocol receipts and all live membership, connection, generation and accepted-turn fences remain enforced. The migration refuses an incomplete predecessor cutover instead of changing its behavior silently.
