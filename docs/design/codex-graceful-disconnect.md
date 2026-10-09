# Codex graceful local disconnect (OPE-766)

Status: implementation candidate; **not merged or deployed**. Follow-up to
OPE-700/OPE-717. The integration base is corrected cutover
`4d22d97da851870b6e40f926f3cfa5a9751f6bbc`, stacked on writers
`de5e7755b216f1ec16e3dc2f7693f4c379e7fbe4`. Those upstream changes have separate
ownership and approval. This candidate does not change their branches.

The reported organization DELETE returned HTTP 409 because the live-lease FK
prevented deletion. Expired-lease pruning did not fix graceful disconnect: a
lease timeout is not evidence that an upstream request stopped. The UI promise
requires a persistent fence, not removal of the guard or cancellation of work.

## Approved request boundary

The October 9, 12:53 UTC architecture decision defines **one atomic durable
request reservation** as the admission linearization boundary. It is not proof
that the network call has already started. A successful reservation permits
exactly one physical request by the exact attempt/holder, not a whole agent turn,
a session, a batch, or a reusable bearer. A replacement attempt cannot replay
the reservation. An authentication retry is another physical request.

The shared core is the sole lifecycle owner. No second legacy ledger or
chat-only drain is introduced. The deployment requires matching request-aware
binaries and the existing core cutover; migration 0686 is maintenance-only.

## Local removal and request custody

Disconnect keeps the reviewed organization-administrator/personal-owner
authorization and exact owner-only capability. Under the same connection lock
as refresh and admission it irreversibly records `disconnected_at`, disables
placement, scrubs encrypted credentials, and clears the upstream identity used
for reconnect matching. New reservations, token loads and refreshes cannot use
that identity. Allocator pause remains a separate operation, not a revocation.

The nonsecret connection row, native leases and request observations remain as
history. Secret removal is completed atomically, including with no active work;
it needs neither browser retries nor a future maintenance worker, and cannot
retain secrets indefinitely after an API/worker crash. Repeated authorized
disconnect is harmless. Reconnect creates a distinct connection ID; stale
refresh/finalization cannot rehydrate or remove the new connection.

An already reserved physical request retains its process-local bearer and
response consumer. Disconnect does not revoke its turn lease or cancel its
stream. The existing response rendezvous and durable conversation checkpoint
must retain model response and tool progress before the same continuation is
re-placed. Subsequent model requests use an eligible source, or enter the native
durable wait when policy/pins provide none. Graceful removal is not a quota
refusal and must not consume refusal budgets or quarantine the subscription.

`subscription_operation_leases` carries immutable single-request identity and
observations. `reserved` means admission only; `response_received` means the
local response was consumed, not provider-side physical quiescence;
`refused` records definitive refusal; `unknown` preserves ambiguity. Neither
expiry nor process death synthesizes a completed response. Ordinary lease
release cannot erase these records. Normal workspace/session retention may
remove their nonsecret history. Existing unrelated authorization revocation
still wins: disconnect creates no override of session visibility or control.

A replacement attempt cannot dispatch for a turn with an earlier `reserved`
model request or any `unknown` model outcome. The database checks that retained
evidence under the exact turn fence, rather than trusting a new process's empty
in-memory tracker. Without supported provider reconciliation the outcome stays
unresolved; expiry is never permission to replay it.

Non-chat consumers use the same request seam: images, realtime negotiation,
transcription, usage, discovery, Apps and reset redemption. A returned Response
header is not body completion; in particular transcription must consume its
body before releasing custody. Refresh is serialized with disconnect and late
credential writes are generation-fenced and cannot reactivate a tombstone.
The existing transaction-bound refresh capability and token deadline remain
intact: a refresh admitted first can hold that connection lock until it settles
or reaches its bounded deadline. Disconnect linearizes when it acquires the
lock and commits, not at HTTP arrival. No new request or refresh admitted after
that fence can reuse the removed source.

## Limits that must remain explicit

- Local removal does not revoke an upstream OAuth token, erase copies already
  in process memory, or prove that a provider stopped work.
- Hard upstream revocation can prevent a current request from completing.
  Definitive authentication refusal can safely trigger new placement; a lost
  response or ambiguous transport outcome cannot be blindly replayed.
- Unknown reset-redemption outcomes retain their nonsecret idempotency record.
  Removing credentials does not promise reconciliation without supported
  successor authorization or a provider outcome-query mechanism.
- Existing frozen pins retain their policy. Removing a source does not silently
  authorize fallback to another owner or billing route.

## Verification and delivery

Use fake encrypted credentials and the independently isolated PostgreSQL
cluster, never a customer account. Tests must include restricted application
roles and a NOBYPASSRLS migration owner, both reserve/disconnect lock orders,
single-use/exact-holder admission, current request completion, refresh races,
unknown crash/expiry custody, reconnect/stale completion, unauthorized tenants,
personal ownership, source projections, stream continuation, and pinned/no-source
wait behavior. Characterization tests describe the historical legacy defect,
not successful native-core behavior.

Independent Sol 6.1 review is required against the final implementation head.
Owner-disabled PR CI is not a reason to skip local database and targeted runtime
validation. PR delivery is not merge/deployment authority.
