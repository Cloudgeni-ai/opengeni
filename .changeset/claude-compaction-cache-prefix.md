---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Claude context compaction now reuses the ordinary request's cached prefix (tools, instructions, thinking, effort and tool choice), so a checkpoint reads the prompt cache instead of rewriting the whole conversation. A Claude subscription rate limit during compaction now recovers through account rotation or a capacity wait instead of failing the turn as a used-up quota.
