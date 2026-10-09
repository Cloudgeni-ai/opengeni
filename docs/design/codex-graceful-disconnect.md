# Codex graceful disconnect — implementation boundary

Status: proposed; **not implemented or deployed**. Applies to the October 9,
2026 disconnect report, tracked as OPE-766. This is a follow-up to OPE-700, not the active
credential-writer security repair in PRs #3895/#3896.

## Existing behavior and reusable boundaries

At base `b194e3149f9f97018d8d0acdfba98f8063e57cd7`, organization DELETE calls
`disconnectOrganizationCodexAccount` in `packages/db/src/index.ts`. It takes
the complete organization workspace tenancy/source prefix, captures accepted
source bindings, locks rotation settings and deletes the credential.
`prevent_organization_codex_disconnect_with_live_leases` rejects the deletion
with SQLSTATE 55006; the HTTP adapter maps that to 409. The dialog's promise
that running work finishes is therefore not implemented.

The existing guard counts only unexpired leases. Expiry is neither an attempt
quiescence receipt nor provider-operation settlement. Removing this guard, or
first deleting expired leases, cannot implement a drain.

Reuse these existing boundaries:

- Turn admission: `acquireCodexCredentialLease` and its source/pool locks;
  the shared-core equivalent is `placeSubscriptionCoreCodexTurn`.
- Exact execution: turn, attempt, execution generation, holder and lease
  generation; a session ID or accepted source snapshot is insufficient.
- Token refresh: the existing per-credential single-flight lock and version CAS.
  Token-refresh version is **not** a connection lifecycle generation.
- Physical completion: the canonical `session_turn_attempts.quiesced_at`
  receipt and its recovery path, not `closed_at`, turn status or lease expiry.
- Core non-turn operations: `subscription_operation_leases` and the corrected
  operation admission/credential seams. These must provide durable settlement
  separate from lease liveness before disconnect can use them as drain proof.
- Recovery scheduling: an existing control-worker maintenance activity may
  consume bounded, durable pending-disconnect work. Do not make HTTP retries,
  a browser refresh, or the original administrator's continued membership the
  only way to finalize an accepted disconnect.

## Required protocol

1. An authorized disconnect transaction locks the canonical tenancy/source/pool
   prefix, then the exact connection lifecycle row. It marks that generation
   `disconnecting` and records its immutable disconnect request identity.
2. The same commit fences **all new admissions**, including explicit pins,
   active pointers, same-session later turns, capacity refresh, Apps, usage,
   model discovery, images, transcription and realtime negotiation. Allocator
   pause is not the fence: it deliberately preserves other use.
3. Atomically capture the exact already-admitted execution identities. A chat
   admission names account/workspace/session/turn/attempt/execution generation,
   holder and lease generation. An operation admission names its complete
   operation/attempt/holder/generation identity and connection generation.
   Only those identities may continue using/refreshing that generation.
   Existing unrelated membership/control revocation still wins; disconnect
   must not become a permission override.
4. Repeated DELETE returns the same accepted request and truthful lifecycle.
   No holders means immediate finalization in that transaction. Otherwise
   return success with `disconnecting`, never the old active-use 409.
5. Release/settlement records durable progress. A maintenance retry finalizes
   only when every captured identity has positive settlement proof. An expired
   lease stops authority to dispatch but does not synthesize that proof. Crash
   recovery must consume the native exact-owner/physical-writer recovery path.
6. Finalization removes encrypted credential material and dependent pointers
   under the same generation fence. An old finalizer or refresh CAS must not
   remove or overwrite a later reconnect. Do not retain secret tombstones.
7. Reconnect while draining must not overwrite the draining generation. Either
   keep a distinct new connection identity or explicitly reject replacement
   until safe completion. Pick the corrected core's native identity policy,
   not a second legacy-only generation protocol.

Selection and metadata projections must distinguish connected, disconnecting
and absent. Running exact work may retain its historical identity, while
pickers/pins/new requests cannot admit it. A visible draining state must use the
actual existing components and receive the required component preview.

## Why core integration is a prerequisite, not a guard patch

The legacy non-turn paths load a bearer without a durable operation identity:
`apps/api/src/codex-realtime.ts`,
`apps/api/src/transcription/providers/codex-subscription.ts`,
`packages/core/src/codex-model-availability.ts`, and the legacy usage/reset
helpers in `packages/db/src/codex-token-resolver.ts`. The token resolver can
re-read/refresh, but it cannot prove which physical operation was admitted
before a disconnect fence or that it settled after a crash.

Adding only a credential timestamp and filtering the allocator therefore
leaves either post-fence non-turn use or broken already-running operations.
The corrected shared core is the existing native home for this missing
identity, so its stable interfaces must be supplied before choosing whether
the legacy bridge can reuse it without crossing the cutover world boundary.
Do not activate a partial legacy drain or claim the operation/crash criteria
from chat-only tests.

Historical heads `7eede9882de84a7e466c12d50d5b90d116cdbe65` and
`e3b19eef28023bcf081d5511a11b36e81ed5a879` are not integration permission.
The security-repair owner retains exclusive ownership of its branches.

## Verification matrix

Use encrypted fake credentials and a disposable fully migrated PostgreSQL
database. Exercise application roles (including private/Personal workspace
rules); superuser fixture setup is not evidence of runtime authorization.

| Case | Required result |
| --- | --- |
| Disconnect vs acquire in both lock orders | Exactly one admission side wins; no post-fence new holder |
| Existing exact turn/operation | Continues and refreshes only its admitted generation |
| New turn in same session, pin, capacity refresh, new operation | Cannot use draining generation |
| No active work, repeated DELETE | Immediate removal; stable idempotent response |
| Holder expiry without physical receipt | New dispatch fenced; no fabricated settlement/deletion |
| Worker/API crash and maintenance restart | Native exact proof consumed; automatic recoverable finalization |
| Concurrent refresh and reconnect | Old result cannot overwrite or delete new generation |
| Organization administrator vs member/foreign organization | Existing management and RLS boundary preserved |
| Personal credential/organization inheritance | Same lifecycle rule; no broader revocation/ownership semantics |
| Status and picker projections | Truthful draining state; unavailable for new selection |

Run independent Sol 6.1 review against the exact eventual implementation head.
OpenGeni PR CI is disabled by owner policy; retain proportional local results,
including real PostgreSQL concurrency/RLS evidence. PR delivery is not merge
or deployment authority.
