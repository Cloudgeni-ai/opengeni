---
---

CI: the main CI cadence pass now retries a transient GitHub read (a 5xx, a 429, a timeout or a dropped connection) the same way the batch receipt does, so one gateway error no longer ends the whole pass. Mutations are still sent exactly once.
