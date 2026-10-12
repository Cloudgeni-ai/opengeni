---
"@opengeni/worker-bundle": patch
---

A turn that fails while its parallel session-title request is still running now recovers or moves to another subscription account as intended, instead of failing for good. The title request is tool-less and its answer never enters the conversation, so its unsettled state no longer blocks same-turn recovery, credential failover or lease-loss recovery for Codex and SuperGrok turns. Main-request replay fences are unchanged.
