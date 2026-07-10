---
"@opengeni/runtime": minor
"@opengeni/events": minor
"@opengeni/db": minor
"@opengeni/config": minor
---

Streaming exec to Connected Machines over the op-stream protocol (server half).
When a runner advertises the `op_stream` capability (persisted from its connect
Hello onto the enrollment) and `OPENGENI_AGENT_OP_STREAM_ENABLED` is on
(default off), selfhosted exec streams as sequenced, acked, credit-flowed
frames: no reply-size wall (retention-bounded, typed on overflow), blip-proof
collection (re-attach + replay, blake3-verified byte-exact), and idempotent
starts keyed by a durable per-tool-call op id so a re-dispatched turn attaches
to the already-running command instead of re-running it. The legacy monolithic
exec remains the permanent fallback wire form. The events bus gains an
op-stream subscribe/publish accessor on the same managed NATS connection.
