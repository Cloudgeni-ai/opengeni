---
---

Runtime: an opt-in cost experiment, `OPENGENI_EXPERIMENT_SYSTEM_PROMPT_CACHE_SPLIT` (default off), sends Claude Messages system instructions as a session-independent prefix block with its own cache breakpoint plus a workspace-specific tail, so the first request of a session reuses the shared prefix instead of rewriting the whole system prompt.
