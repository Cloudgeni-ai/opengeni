---
"@opengeni/react": patch
---

The timeline no longer renders queued / running / idle status dividers — they are machinery telemetry the header pill, live shimmer, and turn-chip duration facet already carry. Only attention-worthy statuses (requires_action, failed, cancelled) still earn a divider. Applies retroactively to historical traces since the filter lives in the pure projection.
