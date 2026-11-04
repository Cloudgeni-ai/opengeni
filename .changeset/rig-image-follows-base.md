---
"@opengeni/worker-bundle": patch
---

Sandbox environments start from a prebuilt image again after a platform release: a turn that finds its version's image built on an older base starts one background rebuild on the current base, and re-verifying a version no longer fails because an earlier verification left its lease behind.
