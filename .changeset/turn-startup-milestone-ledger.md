---
"@opengeni/db": patch
---

Decide turn-startup SLO milestone receipts (queue, provider_dispatch, first_byte) through a per-turn ledger, `session_turn_startup_milestones` (migration 0318), instead of re-reading the turn's `session_events` rows on every inserted model-request event. Each append or settlement claims its checkpoints with one primary-key `insert ... on conflict do nothing returning`, so the cost is O(1) per model request and no longer grows with the turn inside the transaction that holds the workspace inference-control row; recovery and replay remain no-ops, the terminal failed first-byte outcome is fenced on ledger state, and a turn already in flight before the ledger is sealed once so it never re-observes a checkpoint.
