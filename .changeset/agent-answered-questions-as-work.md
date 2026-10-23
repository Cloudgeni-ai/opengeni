---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

A sub-session question that an agent (such as the parent) or the system answered or skipped is now shown as agent work instead of conversation: one quiet "Asked  Target branch → main" row inside the turn's "Worked for" details, which opens to the question, who answered, and the answer. Nothing appears on the person's side any more. Questions a person answered, and expired, cancelled or still pending questions, look as before. `HumanInputItem` gains `answeredBySystem`, and `@opengeni/react/timeline-model` exports `isAgentWorkHumanInput` and `agentWorkHumanInputSummary` so custom renderers make the same decision.
