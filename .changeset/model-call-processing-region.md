---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Record where each agent-session model call that writes a model-call fact
(turns, compaction and session titles) was processed. Each fact and its durable
`agent.model.usage` event carry the serving route's residency claim
(geography, deployment type and regions, never evidence), facts rebuilt from
usage events keep it, and Insights calls expose each call's
`processingGeography` (undefined from servers older than this release). Calls
recorded before this change read as null; a new call whose route is not known
is recorded as unknown, and a stored eu claim that breaks the eu rules reads as
unknown.
