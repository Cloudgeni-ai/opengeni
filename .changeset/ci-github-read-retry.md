---
---

CI: the batch receipt and the main CI cadence pass repeat a GitHub read after a 502, 503 or 504 or a dropped connection, as PR CI already does. One gateway error no longer turns an attested landing into a full main CI run or ends the cadence pass. Mutations are never repeated, and a lasting outage still fails closed inside the job's timeout.
