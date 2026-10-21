---
"@opengeni/db": minor
"@opengeni/events": minor
"@opengeni/worker-bundle": patch
---

Avoid transferring unused frozen session, turn and attempt data for tool receipt and operation checkpoints. Mutation callers can explicitly request the existing narrow event-fence projection; plain callbacks still receive full rows. Lock order, authority decisions, atomic receipt/event persistence and replayed model history are unchanged.
