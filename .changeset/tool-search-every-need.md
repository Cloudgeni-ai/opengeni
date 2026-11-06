---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

One `tool_search` now loads every tool the decision model judges the search needs, whatever its `limit`. Before, the model's picks were cut to `limit`, so an agent that asked for four things with `limit: 2` got two of them, and the model was told to choose the smallest set and leave out prerequisites, so "create a checklist from a template" loaded the create tool but not the template lister. The model now answers one question per candidate: will the agent need it to do what the query asks, including a tool a chosen tool needs called first, for example to get an id it requires. `limit` bounds only keyword-only results and the suggestions listed by name.

Selection fallbacks: a selection still unanswered after 2.5 s sends one identical request beside it (the first answer wins, the other is cancelled), and the deadline is 8 s instead of 5 s. Fallbacks were almost all the old 5 s deadline cutting off slow decision calls. A fallback is now counted in `opengeni_tool_search_selection_fallbacks_total` by reason (`deadline`, `rate_limited`, `provider_error`, `request_failed`, `invalid_answer`) and logged with its time and attempts; before, its cause was discarded.
