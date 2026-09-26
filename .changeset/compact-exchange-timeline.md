---
"@opengeni/react": minor
---

Make long turns read like a coding agent in the compact progress presentation (`turnSummary={{ rolling: true }}`). Assistant commentary joins its activity cluster, and each exchange folds behind one status row ("Working · 2m 14s · 12 steps" with the latest progress note and current step, or "Waiting for 2 agents · 3m") with the answer below a "Worked for …" separator. Routine machine inputs, recorded waits, and compaction fold inside the exchange; failures, approvals, auth recovery, human input, scheduled prompts, and images stay visible. Following the tip stops once an answer pushes its question to the top, and a "Your question" control returns to the question being read. Recorded waits now say "Waited for 1 agent · 3m 5s" instead of "Wait recorded".

New API: `groupTimeline(items, { foldExchanges: true })`, `TurnSummary`'s `status` prop, and optional `waitingAgents` / `waitEndedAt` on recorded wait notices. `ActivityItem` now includes `AgentMessageItem` for folded commentary; exhaustive switches over activity kinds need an `agent-message` case.
