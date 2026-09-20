---
"@opengeni/config": patch
"@opengeni/storage": patch
---

Parse artifact dispatcher and materializer settings independently from API and agent settings. Preserve database, telemetry, broker, and storage validation without requiring unrelated authentication or sandbox secrets in least-privilege sidecars.