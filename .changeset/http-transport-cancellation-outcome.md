---
"@opengeni/network": patch
---

Report HTTP response-reader cancellation separately from transport failure. A consumer that stops reading after a successful model terminal event no longer produces a false transport-failure metric.
