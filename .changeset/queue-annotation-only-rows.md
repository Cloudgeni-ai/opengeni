---
"@opengeni/react": patch
---

Show annotation-only queued turns in the compact session-chrome queue. A queued turn with an empty prompt and timeline annotations rendered as a blank row; it now shows a keyboard-reachable annotation-count chip ("Review 1 annotation") that opens the existing read-only review dialog, prompt-plus-annotation rows show both, and optimistic queue rows follow the same rule. The compact queue and `QueueSurface` share one presentation rule, and an item with neither a prompt nor annotations shows "Content unavailable" instead of blank space. `TimelineAnnotationsChip` accepts an optional `compact` prop for dense rows.
