---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

An automation run in a chat now reads as what happened, not as its instructions. A run shows one plain, centered line (the automation's name and what the event that started it says, for example "Ticket assigned to you: T-4907 Refund request from Contoso"), then the agent's answer. The pending and delivered events for a run now carry the automation's name as their summary, plus `automation: {name, eventSummaries, eventCount}` on the member, so the instructions never reach a chat; the agent still reads them in the update as before. Older runs read "Automation run".

A run with nothing for the person stays out of the chat. New occurrences tell the agent to answer exactly `NO_REPLY` when nothing needs the person, and the web and native timelines then draw neither the run's line, its work nor its answer; the token itself is never drawn anywhere, even while it streams. `NO_REPLY_SENTINEL`, `isNoReplyText` and `mayBecomeNoReplyText` come from `@opengeni/contracts/no-reply`, shared with Slack replies.

`agentSignals={false}` on `SessionConversation`, `MessageTimeline`, `NativeSessionScreen` and the native `MessageTimeline` now also keeps turn rows to their status (no step preview or host `turnSummary` facets) and shows an automation run as only its line and answer: no work row, nothing while it works, and nothing for a failure only an operator can fix. `automationRunOutcomesOnly`, `automationRunLine`, `isAutomationRunBatch` and `readableWorkIsEmpty` are exported for hosts that build their own timeline.
