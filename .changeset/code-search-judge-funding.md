---
"@opengeni/jev": minor
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
---

`code_search` can run its Jev judge on TypeSafe, OpenRouter or Vercel AI Gateway (`OPENGENI_CODE_SEARCH_JUDGE_PROVIDER`, `OPENGENI_CODE_SEARCH_JUDGE_MODEL`), and `OPENGENI_CODE_SEARCH_FUNDING=credits_only` limits the deployment's own judge key to turns paid with OpenGeni credits. Other turns then use the workspace's or organization's own OpenRouter or Vercel AI Gateway connection, or do not get the tool. The default (`all`) keeps today's behaviour. `JevClient` takes a `provider` and reports `costSource`, and every call's usage is attributed to the turn's initiating human, with customer-paid calls recorded separately.
