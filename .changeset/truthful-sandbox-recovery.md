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