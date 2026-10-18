---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
"@opengeni/sdk": patch
---

Steer no longer cuts off the running turn. A Steer sent while the agent works is read at the running turn's next model-step boundary: the current step's tool calls finish, then, before the next model request, the turn hands over (`turn.superseded` with reason `steer` and `atModelStep: true`) and the Steer runs next on the unchanged history. Several Steers sent during one step are read together, in the order they were sent. Agent Steer (`session_steer`) behaves the same way. Queue (an ordinary Send) is unchanged and still runs after the whole turn.

To stop the running step immediately, pass `interrupt: true` to `steerQueueItem` (the queue surfaces show this as "Send now" on the waiting Steer); the queue snapshot reports the waiting Steer as `pendingSteer`. A new workspace setting `busySend` (`queue` by default, or `steer`) and a matching `busySend` option on `useComposer`, `SessionConversation` composer options and `useOpenGeniNativeSession` let a product make a normal Send act as Steer while the agent is busy; Cmd/Ctrl+Enter then does the other one.
