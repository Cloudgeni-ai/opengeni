---
"@opengeni/db": patch
---

The codex rotation strategy picker is gone: rotation-enabled always behaves as sticky-sharded (OPE-36). Sessions stick to one subscription each for maximum prompt-cache reuse, spread across all connected accounts, rebalancing only when a plan caps. The legacy strategies (most-remaining, round-robin, drain-then-next) are all strictly dominated post-cache-affinity and are now normalized to sharded at every worker read site; their branch code is kept but unreachable (rollback safety). The API accepts-but-ignores `rotationStrategy` writes (deprecated no-op, no caller breaks) and reports `sharded` as the effective truth; migration 0064 backfills stored legacy values and flips the column default. The web settings surface drops the strategy dropdown for honest copy. Remaining user controls are the real intents: rotation on/off, manual per-session pins, and (with OPE-24) per-account allocator include/exclude.
