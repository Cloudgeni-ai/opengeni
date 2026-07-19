---
"@opengeni/api-router": patch
"@opengeni/codex": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/events": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/testing": patch
"@opengeni/worker-bundle": patch
---

Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
for complete current model input, make compaction failure/progress transitions
durable and convergent, and replace recursive session discovery with a compact
paginated projection. Bound each SSE connection to one complete size-capped frame,
terminate stalled readers, and surface bounded-cardinality delivery-pressure metrics.
Bound workspace-control reason/actor invalidations at ingress, storage, NATS, SSE,
REST, and the typed SDK boundary with explicit non-retention accounting.
Preserve the SDK's array-returning workspace-control list method while adding a
separate continuation-aware page method.
Bound human pinned-session pages to the newest 100 matches with explicit
`pinnedTruncated` UI/SDK truth, make descendant summaries cycle-safe, and expose
inherited serializers or omitted additive event-envelope fields as explicit loss.
Keep the legacy session-list array shape while surfacing pin omission in an HTTP
header, and reject unbounded tree-stat root projections before SQL.
