---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
---

Release completed Connected Machine command output once its exact tool result is
durable, instead of retaining it until a long turn ends. Preserve parallel and
background output ownership, and allow failed final acknowledgements to retry.
Persist independent background output custody after verified PostgreSQL capture,
then reconcile release on its original connection even after worker loss.
