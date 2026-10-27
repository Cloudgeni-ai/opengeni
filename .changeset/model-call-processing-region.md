---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Record where every model call was processed. Each model call fact and its
durable `agent.model.usage` event carry the serving route's residency claim
(geography, deployment type and regions, never evidence), facts rebuilt from
usage events keep it, and Insights calls expose each call's
`processingGeography`. Calls recorded before this change read as null; a new
call whose route is not known is recorded as unknown.
