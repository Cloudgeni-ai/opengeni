# Session title ownership independent of turn handover

## Problem

Title generation is display-metadata work, but its current promise, request
custody, serving lease and usage publisher belong to `runAgentTurn`. Joining it
delays Steer; cancelling it discards useful work and makes a successor repeat
naming. Dropping the await would instead leave an unowned provider request.

## Decision

Admit one durable title operation under the accepted source turn, then execute it
in its own idempotently named Temporal workflow/activity. Workflow arguments are
identifiers only; the bounded opener and frozen route live in the operation row.
The operation pins the source turn/attempt, provider, model and exact connection;
it never runs account placement again and never holds the chat-turn lease.

Reuse the subscription core's operation leases and request custody for a
`session_title` operation. Its authority comes from the immutable admitted title
operation and the source turn's accepted account selection, rather than the
source turn remaining active. Live membership, connection visibility,
disconnection and revocation checks remain authoritative. A title grant is not
permission to continue the source conversation or to call tools.

Connection-backed API-key routes pin and re-resolve that connection. Execution
rebuilds the normal provider settings and compares the frozen provider, model,
definition and connection identity. Deployment keys come from current deployment
settings, not a copied settings object. The encrypted envelope contains the
bounded opener and non-secret route/accounting facts; it never copies bearer,
refresh or API-key material.

The source attempt and execution generation are immutable admission facts. The
title claim has a separate monotonically increasing fencing generation, so an
expired holder can be reclaimed without borrowing a newer conversation attempt.
A single request reservation belongs to the title job; lease expiry never
permits another dispatch. Terminal state ends the grant. Title requests do not
advance the conversation binding's prompt-cache warmth clock.

The title activity owns dispatch, response, usage and persistence. It retains the
existing bounded title request and model settings, records dispatch intent before
network mutation, and never replays an uncertain request. A retry may recover
database-only settlement from a retained response. The human-set or newer title
wins via the canonical title mutation's compare-and-set. Title failure does not
fail or hold the conversation turn.

Admission runs concurrently with the first request; the source joins only that
database/Temporal admission promise before settlement, never title generation.
Known-unsent transient failures retry the same job. Reclaim and terminal
settlement remove the exact owner lease without deleting request evidence.
Responded jobs retry only atomic usage, title CAS and terminal settlement.
Only recognized transient database failures or provider-lease contention retry;
permanent configuration or retained-payload errors terminate the job. Finite
request evidence settles under the locked title claim, even if provider access
was revoked after dispatch. This cannot authorize another request. API-key SDK
retries within one live invocation share its reservation; crash recovery never
replays that invocation. Paid usage is metered with a stable idempotency key
before checking whether the metadata holder expired, then reconciled with the
usage event, fact, title CAS and terminal state. Response-retained recovery loads
the same provider settings and frozen pricing as the live path.
Codex retains the existing included-credit protection with live consent under
the title grant; stored rate limits and model cooldowns are not new title gates.
Response quota observations retain their bearer-version fence and wake existing
waiters when availability recovers, without warming the conversation binding.

An active title operation is a durable naming-in-progress marker. The originating
turn keeps its current first-request disclosure. Subsequent turns use the same
title-tool plan as a normally titled session and do not start another title.
Previously sent prompt prefixes are never rewritten. Embedded runtimes without
the independent operation service retain their existing owned lifecycle.

## Why not retain the old activity's title tail?

Dispatching a successor while `runAgentTurn` still owns the title would introduce
a second activity-completion boundary into session signals, physical-quiescence
receipts, interruption handling, idle closure and continue-as-new. A separately
owned metadata operation keeps those conversation invariants unchanged.

## Verification required

- Real-Postgres admission and revocation across all subscription providers,
  including frozen personal selections after the source turn ends.
- Exact provider/account/model selection; no conversation lease retained and no
  account fallback during title execution.
- Steer during a fixed-delay first-answer title: handover matches the no-title
  control while the original title and usage finish exactly once.
- Withdrawn Steer, cancellation, human rename, worker loss and uncertain dispatch.
- Source and successor request-byte equivalence, no duplicate title, no changes
  to existing prompt-cache prefixes.
- Matched before/after measurements and recorded production deployment boundary.

## Measured local result

Ten matched fresh-chat Steers per variant used one full development stack and a
separate synthetic provider with a fixed two-second title response. The control
joined the legacy title; the candidate ran the independent operation:

| Durable interval | Control median / p90 | Independent median / p90 |
| --- | --- | --- |
| Steer acceptance to superseded | 1,866 / 1,888 ms | 79 / 93 ms |
| Steer acceptance to next main request audit | 2,268.5 / 2,331 ms | 465 / 499 ms |

Every candidate completed exactly one title job with its normal title. The
instruction and tool hashes matched across all forty first/successor main
requests. The request audit is not remote receipt or visible first text. These
are controlled local results, not a production latency claim.

Separate full-stack cancellation and withdrawn-Steer probes each retained one
title job and produced the normal title. Cancellation stopped the conversation;
withdrawal preserved its running turn, with no superseded event or title restart.
