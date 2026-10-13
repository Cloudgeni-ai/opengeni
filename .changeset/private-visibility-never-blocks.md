---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

Nothing in a chat refuses making it Only me any more (rolling migration 0769). Another member's authority is dropped by the change: their pending updates are cancelled, a subscription account choice pointing at their personal connection is removed, and a pending update that later arrives with someone else's authority on a private chat is stored cancelled. A live voice session ends. Schedules, sandbox processes, file operations and viewers no longer count. `SessionVisibilityWork` gains `liveVoice`, `otherPeoplePendingUpdateCount` and `otherPeopleAccountChoiceCount`; any of them, like running work, needs `stopActiveWork` ("make private anyway"). The visibility preview's `blocker` is deprecated and always `null`. The console skips the dialog when nothing is in the way and otherwise shows one short list with a single button.
