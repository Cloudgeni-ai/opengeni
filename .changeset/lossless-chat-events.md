---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/events": patch
"@opengeni/react": patch
---

Preserve full session messages and tool output through database paging, compact
event delivery, SSE, browser rendering, and copying. Remove browser per-event
preview truncation while retaining history pagination and backpressure. Events
larger than a page or loaded-window byte target are delivered intact on their own.