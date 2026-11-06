---
"@opengeni/react": minor
"@opengeni/react-native": minor
"@opengeni/db": patch
---

Automation runs (scheduled and event-triggered) now read the same way in every chat: each run keeps its line (the automation's name and what triggered it), with only its answer and anything waiting on the person under it, and never its work row, steps or narration, while it runs or after. A run with nothing to say (`NO_REPLY`) now shows just its line instead of vanishing, so the chat shows that the automation ran; it still marks nothing unread and opens no inbox item. A failed run keeps its work so the failure can be read. Turns a person started keep their live step line, facets and work row. `buildTimeline` draws runs this way by default, so `agentSignals={false}` and `SessionConversation` hosts need no new option; `automationRunOutcomesOnly` now only additionally turns a failed run into a plain finish for readers who never see the agent's work.
