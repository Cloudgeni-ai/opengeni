---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

A sub-session question that an agent (such as the parent) answered or skipped is now shown as agent work instead of conversation: one quiet "Asked  Target branch → main" row inside the turn's "Worked for" details, which opens to the question, who answered, and the answer. Nothing appears on the person's side any more. Questions a person answered, system skips (a scheduled run's unanswered question), and expired, cancelled or still pending questions look as before. `@opengeni/react/timeline-model` exports `isAgentWorkHumanInput` and `agentWorkHumanInputSummary` so custom renderers make the same decision. React Native: `NativeTimelineMessages.humanInputOutcome` and `OpenGeniNativeLabels.humanInputOutcome` gain an optional `agentSkipped` (defaults to `skipped`), and host overrides of `agentAnswered` still apply to the new row. `OpenGeniNativeSessionView`, which has no turn work details, shows the question as a compact step.
