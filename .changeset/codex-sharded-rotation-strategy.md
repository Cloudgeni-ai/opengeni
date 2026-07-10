---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Add a "sharded" codex rotation strategy: session-sharded account affinity. Each session is assigned a deterministic HOME account (`hash(sessionId) % healthy-accounts`) at its first codex turn, written as a `policy` pin (a new `sessions.codex_pin_source` discriminator distinguishes it from a user's `manual` pin). A session stays on its one home account for prompt-cache warmth while load spreads ~1/N across the pool.

Both rotation guards (proactive turn-start and reactive 429) now allow a `policy`-pinned session to rebalance when its account caps — never a `manual` pin, which stays sacred. A rebalance durably REWRITES the session pin (re-sharding over the healthy survivors so capped-account cohorts spread instead of re-concentrating on one failover) rather than moving only the workspace active pointer, because credential selection returns a pinned account with no exhaustion check. The strategy is selectable alongside `most_remaining`/`round_robin`/`drain_then_next` via the existing rotation-settings API; unpinned behavior under the other strategies is unchanged.
