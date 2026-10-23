# Artifact source authority reads

Run `bun apps/api/scripts/bench-artifact-provenance.ts` with the normal required-real-PostgreSQL test environment. It creates and releases a disposable migrated database, sends authenticated catalog requests through the real route and application role, and makes no model/provider calls.

The fixture compares 60 published files from one source session with 60 files from distinct sources. Each variant has three warmups and five measured samples in alternating order. The output records SQL statements, transaction starts, elapsed time and process CPU. Compare the same script on the base and candidate; process CPU is not database CPU and these local results are not production measurements.

The original separate per-source reads used 53 statements / 11 transactions for the shared source and 525 / 129 for distinct sources. The batched implementation keeps 53 / 11 for the shared source and uses 109 / 25 for distinct sources. The projection window remains eight rows: this is not an unbounded whole-page authority cache.

Initial timings were noisy even for the unchanged shared-source case, so no stable latency or CPU improvement is claimed from that run. The repeatable result is the reduction in scoped database operations. Actual workload savings depend on distinct-source count and request frequency.

Authority facts are loaded through one canonical set reader. Existing single-session callers use that same implementation. The existing decision body still runs for each source, including host, Site, private-session, Slack and live-attempt checks. Post-host visibility uses a separate read, not the earlier facts. Linked external-identity checks remain live and sequential on the scoped transaction; host/Site checks on an already pinned transaction also run sequentially to avoid overlapping savepoints. Ordinary pooled callers retain parallel per-target host callbacks. There is no cross-request cache or changed artifact response contract.
