---
"@opengeni/agent-host": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

A Connected Machine command's completion no longer reaches its session minutes late on a slow uplink. The agent sent the few-byte completion notice, its retries and its operation inventory through the same first-in-first-out connection as command output, so the notice waited behind every output frame already queued (or was dropped from a full queue) until the next reconnect. The agent now sends them on its control connection, repeating an unacknowledged completion with every heartbeat. Opengeni's collector also used to give up on a completed command's output after five seconds without it, attach again (queuing the same frames once more) and back off for up to five minutes; it now follows one attachment until the exit arrives or its claim budget ends. `replayConnectedCommandOutput` requires a deadline for terminal replays. Failed completion, inventory collection, probe, settlement and output release warnings now carry a closed `reason` code (`claim_deadline`, `exit_frontier_not_reached`, `exit_frontier_mismatch`, `output_transport_unavailable`, `control_<code>`, `database_<sqlstate>` or `unclassified`), exported by the new `connectedCommandFailureReason`, since telemetry does not export error text.
