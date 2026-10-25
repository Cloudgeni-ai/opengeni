---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/observability": patch
---

Hand off retained commands with unavailable foreground observations before exposing their background command IDs, so finished turns can clean up without waiting for an unavailable observer. Preserve physical writer and capture fences, classify forgotten Modal exec state as uncertainty, and retain bounded probe diagnostics. Identify outstanding writer kinds during finalization and label deliberate worker containment even when Temporal masks its force-stop exception.
