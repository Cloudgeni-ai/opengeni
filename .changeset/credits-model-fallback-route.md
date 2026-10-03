---
"@opengeni/config": minor
"@opengeni/db": minor
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

Add an operator switch that moves a credits model to a reviewed fallback route without a deploy. The database model catalog may declare `fallbackRoutes` (a built-in or registry credits product, the managed Vercel AI Gateway, one upstream slug and exactly one pinned endpoint provider); rolling migration 0597 adds the append-only, owner-only `set_model_route` switch that catalog resolution reads for every new turn. A switched product keeps its id, aliases, labels, limits, pricing and credits billing, debits the Gateway-reported cost plus its margin, and accepted turns keep the route frozen in their policy. Requests now leave out opaque reasoning minted by a different provider (by the producing turn's frozen policy) instead of failing with an encrypted-content rejection; durable history is unchanged. `@opengeni/db` exports `readModelRouteSwitchStates` and `listSessionTurnExecutionProviderIds`.
