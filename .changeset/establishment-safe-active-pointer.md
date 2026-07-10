---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
"@opengeni/documents": patch
"@opengeni/events": patch
"@opengeni/github": patch
"@opengeni/storage": patch
---

Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
