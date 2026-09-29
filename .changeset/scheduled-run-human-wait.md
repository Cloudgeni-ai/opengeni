---
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": minor
"@opengeni/worker-bundle": patch
---

A scheduled run whose turn waits for a tool approval or a structured question
is now visible: `ScheduledTaskRun.awaitingHuman` (`{ since, expiresAt }`) on run
listings and `awaitingHuman` on the scheduled-task attention list, instead of the
run looking merely "dispatched". The new optional
`agentConfig.approvalTimeoutSeconds` (60 s to 30 days; default none) lets the
scheduler reject the pending approval (or skip the question) as a labelled
system decision once nobody answered in time, driven by a durable workflow
timer.
