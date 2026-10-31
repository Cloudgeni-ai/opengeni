---
"@opengeni/db": patch
---

A new turn in a long chat no longer reads the chat's whole history to find the billing origin it inherits. `1142_session_turn_origin_lookup_index` (rolling, built concurrently) adds a partial index on a chat's turns that have an origin, newest first, which the inherit trigger from `1128_billing_usage_origin` probes for its chat and parent chat. Before, a chat whose earlier turns had no origin made every new turn read all of them, so inserting turns grew quadratically with the chat's length.
