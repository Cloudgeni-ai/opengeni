---
"@opengeni/db": patch
---

Codex turns in flight during a rolling deployment, a worker loss or a lost lease now recover instead of failing. Recovery runs the turn again from its checkpoint in a new attempt, but a model request that was streaming when the old attempt stopped stayed unresolved and the replacement's first request was refused, so the turn failed as not retryable. The interrupted attempt can no longer write, so its response is never used; the new attempt's requests now proceed, and the old request keeps its unknown outcome. A capacity or approval resume still cannot send a request while an earlier one is unresolved.
