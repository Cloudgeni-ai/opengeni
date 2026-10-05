---
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

A new chat without a goal no longer logs failed `GET .../goal` 404s in the browser console. `GET /v1/workspaces/:workspaceId/sessions/:sessionId/goal?absent=null` answers 200 `null` for a goal-less session (without the opt-in the 404 is unchanged, and a missing session is always 404). The SDK adds `findGoal`, which sends the opt-in and resolves `null`; the session proxy forwards it. `useGoal` reads through `findGoal` when the client has it (falling back to `getGoal` and its absorbed 404 otherwise), and no longer re-reads a goal-less session when the stream's opening events race the first read, so an embedded Opengeni chat makes one successful goal read per new chat. A goal set later still arrives through its `goal.*` event.
