---
"@opengeni/react": patch
"@opengeni/sdk": patch
"@opengeni/db": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
---

Polish session chrome and apply_patch rendering; clarify realtime voice-end handoff.

SessionChrome gets denser selected-chip UX and Codex function-tool apply_patch shapes render in the specialized diff UI. Solo goal_continuation machine-input rows are suppressed in favor of the GoalRow landmark. The realtime transcript-tail instruction now keeps in-flight work going after voice ends.
