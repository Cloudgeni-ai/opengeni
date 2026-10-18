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

Steer reaches the agent within seconds and no longer kills work in progress. A model request still generating when a Steer arrives is cut short: assistant messages the provider had completed stay in history, unfinished text and unstarted tool calls are dropped, and the next request carries the Steer on the unchanged history. Short tool calls finish; long `exec_command`/`write_stdin`, `command_wait`/`command_read` and `session_wait` waits return early with their handle while the work keeps running (`session_wait` reports kind `steer`). The turn then hands over (`turn.superseded` with reason `steer`, `atModelStep: true` and, for a cut-off answer, `cutOffText`) and the Steer runs next. Several Steers are read together, in the order they were sent. Agent Steer (`session_steer`) behaves the same way. Queue (an ordinary Send) is unchanged and still runs after the whole turn. Custom model transports can honour preemption with the exported `isModelPreempted` and `preemptedResponseDone`.

The web and React Native session screens show a Steer only as the person's message: no status row, chip or "Send now". API callers can still stop the running attempt with `interrupt: true` on `steerQueueItem` on the turn that `steerMessage` returned. A new workspace setting `busySend` (`queue` by default, or `steer`) and a matching `busySend` option on `useComposer`, `SessionConversation` composer options and `useOpenGeniNativeSession` let a product make a normal Send act as Steer while the agent is busy; Cmd/Ctrl+Enter then does the other one.
