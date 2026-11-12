---
"@opengeni/worker-bundle": patch
---

Tool search decision-model requests are now visible in traces and metrics. A tool search that asks the decision model runs inside the model step that called it, before the step's result and usage are recorded, so its wait showed up only as an unexplained gap after the model response. Each request is now a `worker.tool_search.decision` span (provider, question count, outcome, input tokens) and a sample in `opengeni_tool_search_decision_duration_seconds`, labelled `completed`, `cancelled` (a hedged request that lost the race, or a deadline) or `failed`. Requests and results are unchanged.
