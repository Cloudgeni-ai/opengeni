<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may move. Code wins. Phase status (exists / building / future) reflects the authoring window.

# Subscription capacity + caching — end-state plan

Companion to `docs/design/prompt-cache-affinity.md` (which owns the request-construction
and account-affinity *invariants*). This doc owns the **capacity architecture**: how we
assign, protect, observe, and optimize a pool of subscription accounts.

## Target

Run **thousands of concurrent sessions across N subscription accounts and multiple
providers, optimally** — where "optimally" means, in priority order:

1. **Never stall** a session that has any available capacity anywhere in the pool.
2. **Balance the burn** so no single account's short-window (5h / weekly) cap is hit
   while sibling accounts sit idle.
3. **Preserve cache warmth** — keep a session on one account so its prefix stays warm,
   and (hypothesis) spread load so no account is thrashed into cache eviction.
4. **Protect priority work** — orchestrator/manager sessions must not be starved of
   capacity by a swarm of workers.

These can conflict (warmth wants stickiness; balance wants spreading; protection wants
partitioning). The design resolves them as layers, cheapest and most-certain first.

## The layers

### L1 — Atomic credential leasing
A unit of work acquires an account through a single race-free write, never a
read-count-then-write. Today assignment is a durable single-write **session pin**
(`sessions.codex_pinned_credential_id`), which is atomic per session but has no notion of
a per-account *slot* or hard capacity. Deterministic assignment (L3) removes the need for
coordinated leasing at genesis; true atomic leasing (compare-and-set on an account slot)
becomes necessary only when pools carry hard per-account concurrency limits (L2/P1).

### L2 — Named, protected pools with inheritance
Accounts are grouped into named pools. A session belongs to a **self pool** and hands a
**child-default pool** to sessions it spawns. Example end-state: orchestrator/manager
sessions run on a small **protected** pool; workers inherit a **worker** pool covering
the rest. Protection means a worker swarm draining its pool cannot touch the protected
accounts, so a manager always has warm, uncapped capacity. **Promotion** moves an account
between pools. None of this exists yet; it is the P1 layer.

### L3 — Deterministic sharded assignment
Assign a session to a home account by **`stableAccountList[hash(sessionId) % N]`** within
its pool. This is coordination-free (no read-then-write race, no shared cursor), balanced
in expectation, and stable (the same session recomputes the same home). It replaces the
naive "least-loaded by live session count" idea, which is both a race (burst creation →
all pick the same account) and a weak load proxy (session count ≠ token burn). Real
imbalance is corrected reactively (L1 rebalance on cap), not by a fragile count metric.

### L4 — Observe-first cache affinity
Only **after** measurement proves that spreading load raises cache hit rate do we let
cache warmth rank assignment (e.g. prefer the home account, but bias new sessions toward
less-thrashed accounts). This is deliberately last: the cache-regime win is a
**hypothesis** (see "Honesty" below), and ranking by an unproven signal would be
premature optimization. Ships only when the data earns it.

### L5 — Live observability + a queryable capacity surface
Per-account, live: cache hit ratio, quota/window headroom, eviction pressure, active
session count, token burn rate. Rendered as dashboards **and** exposed as a surface a
manager agent can query ("which pool is under pressure? should I trim or add
subscriptions?"). When sustained eviction pressure co-occurs with high concurrency on an
account, the guidance is **add subscriptions or reduce per-account concurrency**; when
accounts sit persistently idle, **trim**. This is the control loop that keeps the pool
right-sized.

## Phases

### P0 — Landing now: instrument, fix the confirmed breaker, shard deterministically
- **Instrumentation.** Add a cached-input-token counter next to the existing
  `opengeni_model_calls_total` / `opengeni_model_input_tokens`, and add a
  **per-credential/account label** (cardinality ~N, safe) plus a per-account active-session
  gauge. Without a per-account label you cannot see load-spread, and an aggregate hit-rate
  read is confounded by hour-of-day and model mix. Commit to a **same-hour-of-day,
  model-sliced** before/after read for any policy verdict.
- **tool_search prefix fix** (the confirmed regression from the ADR): per-turn snapshot of
  the tool_search description, populated *before* the first model call, with a live-render
  fallback on discovery timeout — never freeze an empty/partial connector list.
- **Deterministic sharded strategy** (the assignment change; see required amendments).

### P1 — Named / protected pools + inheritance
Introduce pool membership, the self/child-default inheritance rule, and promotion. Land
protected-pool semantics so orchestrators are insulated from worker swarms. This is where
**atomic slot leasing** (L1, hard-capacity form) is built, because pools introduce
per-pool capacity that assignment must respect atomically.

### P2 — Cache-affinity ranking (gated on measurement)
Only after P0 instrumentation shows that spreading load measurably improves per-account
cache hit rate: let warmth/eviction-pressure bias assignment within a pool. Ships or is
dropped based on the P0 data.

### P3 — Multi-provider generalization
Generalize pools and assignment across providers (not just ChatGPT/Codex accounts):
per-provider affinity fields (`prompt_cache_key` for OpenAI, provider-specific hints
elsewhere), per-provider retention/quota models, and cross-provider routing that still
honors the per-account warmth and protection rules.

## What exists / building / future

| Piece | Status | Where |
| --- | --- | --- |
| Stateless resend + `store:false` + `prompt_cache_key = sessionId` | **exists** | `packages/runtime/src/index.ts`, `apps/worker/src/activities/agent-turn.ts` |
| Per-call `cached_tokens` capture + `agent.model.usage` event | **exists** | `packages/runtime/src/usage-telemetry.ts` |
| `opengeni_model_calls_total`, `_call_duration_seconds`, `_input_tokens` (provider-labeled) | **exists** | `apps/worker/src/observability-metrics.ts` |
| Session pin + last-credential columns; `selectCodexCredentialForTurn` (pin > active) | **exists** | DB + `apps/worker/src/activities/agent-turn.ts` |
| Rotation strategies (`drain_then_next`, `most_remaining`) + reactive-429 path | **exists** | `apps/worker/src/activities/codex-rotation.ts` |
| Cached-token counter + per-credential/account label + per-account load gauge | **building (P0)** | `apps/worker/src/observability-metrics.ts` |
| tool_search per-turn description snapshot (+ safe fallback) | **building (P0)** | `packages/runtime/src/codex-tool-search.ts` |
| Deterministic sharded assignment (+ amendments below) | **building (P0)** | agent-turn credential block + rotation |
| Named / protected pools + inheritance + promotion | **future (P1)** | new |
| Atomic account-slot leasing (hard-capacity) | **future (P1)** | new |
| Cache-affinity ranking | **future (P2, gated)** | new |
| Multi-provider generalization | **future (P3)** | new |
| Manager-agent-queryable capacity surface + trim/add guidance | **future (P1–P2)** | new |

## Required amendments for deterministic sharding (P0)

Sharding is **not** "an assignment policy on top of existing plumbing with no new
architecture" — that framing is wrong. The pin column and reactive path exist, but
correct sharding needs real additions:

- **Pin-source discriminator (schema).** A pin today cannot distinguish a *manual* "run on
  this account" override from a *policy* home assignment. Add `codex_pin_source`
  (`manual` | `policy`). Both rotation guards read `pin == null` to mean "may rotate"; to
  override a policy home on a capped account while never overriding a manual pin, they must
  tell the two apart.
- **Both rotation guards honor policy pins.** Teach the proactive and reactive guards to
  allow rebalance when a *policy*-pinned account is capped/near-cap; never override a
  manual pin.
- **Reactive rebalance rewrites the pin durably.** `selectCodexCredentialForTurn` returns a
  cooling pinned account with no exhaustion check, so a pointer-only move leaves the
  session stuck on the capped pin. The rebalance must durably **rewrite the session pin** to
  a healthy account.
- **Proactive re-shard.** The proactive block must health-check a policy-pinned session's
  account and re-shard *before* the model call, to keep pre-cap avoidance and avoid a
  wasted 429 per cap boundary.
- **Re-shard on failover, not first-eligible.** When an account caps, every session on it
  rebalances independently; if they all pick the same failover account the cold-cliff
  reappears as a warm-cliff. The failover pick must **re-shard** (hash over the healthy
  set, or least-loaded excluding the capped account).
- **Assign lazily at first codex turn, not genesis-only.** In-flight sessions created
  before a workspace switches to sharded otherwise never converge; first-turn assignment
  is also fresher than a stale genesis snapshot.
- **Deterministic hash, not least-loaded-count.** Removes the burst read-then-write skew
  and cursor contention; real imbalance is handled by the reactive rebalance above.

## Honesty about the wins

Two wins are **robust** and hold regardless of the open cache question:

- **Limit-burn balance.** Spreading sessions across all N accounts avoids synchronized
  single-account saturation and the cold-cliff at each drain boundary. (Note: the current
  `drain_then_next` does cycle accounts over a window; the real difference is
  *instantaneous* concentration, not total quota.)
- **Switch-cost elimination.** Pinned sessions stop following the shared workspace pointer,
  removing the cross-session-drag "manual" switches measured at ~26pp of cache loss each.

One win is a **hypothesis**, not a certainty:

- **Cache-regime lift** (busy-account ~35–49% → quiet-account ~65–73%) depends on the
  claim that OpenAI under-caches an account under high concurrent load. That claim is
  **field-correlational only** (per-account hit rate tracks inversely with call volume);
  a controlled low-load probe to confirm it was blocked at audit time. Sell it as a
  well-supported bet, verified by P0 instrumentation — never as a settled result. If the
  probe later refutes it, the two robust wins above still justify P0.

## See also

- `docs/design/prompt-cache-affinity.md` — the request-construction + affinity invariants and the verified baseline.
