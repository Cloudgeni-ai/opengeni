---
"@opengeni/react": minor
"@opengeni/react-native": minor
---

`agentSignals` on `SessionConversation`, `MessageTimeline` and React Native's `NativeSessionScreen` now also takes an object of switches, `{ goal, agents, commands, turnDetail }`, each `true` unless set, so a host can hide one part of how the agent works without the rest. `agentSignals={{ goal: false }}` hides the goal pill and keeps queued messages, helper agents, the live step and the host's own `turnSummary` facets. `true` and `false` mean what they did. The row above `SessionConversation`'s composer (queue, wait, goal and agents chips) now sits in the composer's readable column, so it lines up with the composer in a wide panel instead of starting at the panel's left edge; a `chromeProps.className` is still added to it.
