---
"@opengeni/db": patch
---

Database pools now hand each query to the connection that became idle most recently instead of the one idle longest. Rotating through every slot kept each pool at its maximum size forever, so every backend paid its own catalog and plan-cache warmup for every statement and held its own cache memory, even when only one or two queries were running. Work now stays on a small warm set of connections and the surplus closes after the existing idle timeout.
