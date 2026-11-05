---
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Hosts can hide the agent's behind-the-scenes signals from end users. Pass `agentSignals={false}` to `SessionConversation`, `SessionConversationView` or `OpenGeniChat` (through `conversationProps`) to hide the goal pill and any agents or commands segments, and to React Native's `NativeSessionScreen` to hide its goal, agents and commands chips. Queued messages, approvals and the agent's questions still show; the default is unchanged.

The goal pill's pause reasons ("Paused · agent", "· cap", "· manually" and the rest) and the agents chip's "2 running" / "1 paused" now come from the message catalog (`sessionChrome.pausedReason*`, `sessionAgentsModel.runningCount`, `sessionAgentsModel.pausedCount`), so a translated chat no longer shows them in English.
