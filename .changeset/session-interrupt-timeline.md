---
"@opengeni/react": minor
---

Render `session_interrupt` as a distinct worker action in the timeline. When a manager agent stops or steers a session it spawned (the new first-party `session_interrupt` MCP tool), the projection now emits a dedicated `interrupt` worker item carrying the target `workerSessionId` and the `mode` (`"stop"` | `"steer"`), and the activity rail titles it accordingly ("Stopping worker" / "Steering worker" / "Worker stopped" / "Worker steered") instead of a generic tool-call row — matching the existing `spawn` / `message` worker rendering.
