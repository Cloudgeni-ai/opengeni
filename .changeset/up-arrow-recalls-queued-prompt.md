---
"@opengeni/react": minor
---

Pressing Up in an empty chat composer pulls your most recent waiting (queued, not yet started) message back into the composer for editing, with its text and attachments and the caret at the end. It is withdrawn from the queue on the server through the same atomic checkout as the queue's Edit action, so it is never sent twice or lost. If the agent took it first, the composer stays as it was and shows a quiet "Already sent". Up keeps its normal caret movement whenever the composer has text, quotes or attachments, during IME composition, with a modifier key, or while the command palette is open. The queue row Up would recall shows ↑ in its Edit tooltip. `ChatComposer` and `useChatComposerController` accept `queuedRecall` (from the new `useQueuedPromptRecall`), and `useTurnQueue` gains an optional `recallTurn`.
