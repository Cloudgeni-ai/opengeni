---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Make provisioned-sandbox recovery truthful and atomic. Provider existence,
lease liveness, route attachment, archive availability, restore progress,
verified workspace readiness, and epochs are exposed separately; attach/swap
must certify readiness. Definitive provider loss is exact-instance fenced,
concurrent observers receive typed recovery/superseded outcomes, and ambiguous
operations are never replayed. Rematerialization selects one verified archive
revision under the lease lock, verifies archive bytes and restored tree contents,
and fails closed as degraded or unrecoverable instead of publishing a partial,
mixed, previous, or clean fallback workspace.

Unify every persistable workspace mutation under durable turn, API-direct, or
retained-process authority. Direct requests use exact request UUID holders;
yielded processes retain their parent admission and exact pinned provider/route
identity until durable exit/loss settlement. Direct/process authority blocks
archive capture, process stdin receives a distinct mutation admission, and PTY
control cannot be rerouted by active-pointer movement.

Make terminal execution physically synchronous: `terminalExec` always returns a
numeric `exitCode` with `running: false`, and timeout/error paths return only
after exact process-group absence and retained settlement. Interactive PTYs open
only after durable promotion, close only on exact terminal proof, and report
provider loss truthfully.

Activate the generation/process schema through maintenance migration 0109. All
old API/control/turn writers must stop before the one-way cutover and may not
restart afterward; archive completeness requires the exact closed generation.
