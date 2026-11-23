---
"@opengeni/react": patch
"@opengeni/sdk": patch
"@opengeni/contracts": patch
---

Steer on the collapsed queue now steers every queued message, including ones still being sent, in one command: the agent gets them in the order sent, with one interruption. The button shows the count when more than one message waits. Steer on a row in the open queue still steers just that message.

`steerQueueItem` accepts an optional `together` list of other waiting prompts (`{ turnId, expectedTurnVersion }`) to steer in the same command, and `useTurnQueue` adds `steerTurns`.
