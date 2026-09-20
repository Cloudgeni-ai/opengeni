---
"@opengeni/observability": patch
---

Link each worker execution trace to one structured start log through a stable opaque correlation key derived from authorized workspace, session and attempt records. Keep raw identities out of public telemetry and correlation keys out of metric labels.