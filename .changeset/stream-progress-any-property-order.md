---
"@opengeni/network": patch
---

The stream progress scanner recognises a status or keepalive event by its SSE `event:` name, or by its top-level JSON `type` in any property order, so status frames such as `{"sequence_number":1,"type":"response.in_progress"}` no longer count as model progress and cannot hold off a progress deadline.
