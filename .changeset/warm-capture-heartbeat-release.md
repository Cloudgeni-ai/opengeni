---
"@opengeni/worker-bundle": patch
---

Keep the worker heartbeat cleanup from releasing a closed turn's holder before its bounded warm capture settles, avoiding premature drain and cold restore.