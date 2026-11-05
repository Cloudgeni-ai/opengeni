---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Repository skill discovery no longer fails a turn when the workspace answers but its skill folders cannot be used (for example a permission error on Modal, a Connected Machine refusal, or too many skill folders). The turn starts without repository skills and the model sees a short notice naming the reason. Box, route, fence, transport, cancellation and unrecognized errors still reach the turn's existing recovery. An absent `.agents/skills` or `.claude/skills` folder now records `outcome="not_found"` instead of `failed` in `opengeni_sandbox_setup_operation_duration_seconds`, and failed discovery is counted by error class in `opengeni_repository_skill_discovery_failures_total`.
