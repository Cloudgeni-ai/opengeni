---
"@opengeni/codex": patch
---

Wait for Codex stream-failure request settlement before exposing the provider error to the worker. A slow refusal receipt previously made transient overload skip same-turn recovery; failed settlement still prevents replay.
