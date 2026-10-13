---
"@opengeni/codex": patch
---

Wait for Codex stream-failure request settlement before exposing the provider error to the worker, including a final buffered failure without a trailing blank separator. Preserve the provider diagnostic when terminal auditing or settlement rejects. A slow refusal receipt previously made transient overload skip same-turn recovery; failed settlement still prevents replay.
