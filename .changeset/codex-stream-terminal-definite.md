---
"@opengeni/codex": patch
---

Treat a failure the provider declares inside a Codex response stream (`response.failed`, `error`, `response.incomplete`, for example "servers are currently overloaded") as a definite answer when no completed output preceded it, the same as an HTTP 5xx status. Previously only account refusals were definite, so a transient overload recorded the request as an unresolved outcome and failed the turn as non-retryable. A failure after completed output, or a stream that ends without any terminal event, stays unresolved.
