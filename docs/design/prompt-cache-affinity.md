<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may move. Code wins. Measured production figures are snapshots from the audit window, not a live SLO.

# ADR: Prompt-cache-aware codex request construction and account affinity

Status: accepted (records existing invariants + one confirmed regression class)
Scope: the codex-subscription model path (gpt-5.x driven through ChatGPT/Codex accounts).

## Context

OpenGeni drives gpt-5.x through ChatGPT/Codex subscription accounts over a **stateless
resend** path: every model call re-sends the full request (`store: false` on the OpenAI
platform, reasoning continuity via replayed `reasoning.encrypted_content`, no
`previous_response_id`). There is no server-side conversation state to lean on, so the
**only** thing that makes a 180k–240k-token request cheap instead of expensive is
**OpenAI automatic prompt caching**: an exact-prefix-hash match from the start of the
request. A cache hit is charged at the cached input rate and returns faster (lower TTFT);
a miss is charged at full input rate *and* burns that much harder against the account's
5-hour / weekly subscription rate-limit windows.

Because the mechanism is prefix-hash-only and invisible unless you measure it, it is
easy to silently destroy — one wrong byte in the wrong layer cold-starts an entire
history prefix on every call, and nothing errors. This ADR records the invariants every
future agent must preserve, the one regression class we have already hit, and the
verified baseline that says the mechanism is worth this discipline.

## Decision — the invariants

### 1. The cacheable prefix is `[instructions, tools, history-prefix]` and it is BYTE-sensitive

OpenAI hashes the request as an ordered prefix starting at byte 0: the `instructions`
block, then the `tools` block, then the `input` history items. Matching is exact-prefix:
the cache is used up to the **first byte that differs** from a previously-seen request,
and everything after that point is a miss. The minimum cacheable prefix is ~1024 tokens.

Consequences that are non-negotiable:

- The `tools` block precedes the history. **Any** change to a tool definition (a
  description, a schema, even key ordering) invalidates the entire history that follows
  it — not just the tool.
- The `instructions` block precedes everything. A change there invalidates the whole
  request.
- Serialization must be stable. `buildAgent(...)` runs **once per turn**; the request
  body key order is fixed (`model, instructions, input, include, tools, stream, store`).
  Do not introduce a code path that re-derives instructions or tools per model call.

### 2. Nothing dynamic may render into instructions or tool definitions — per-turn snapshots only

Everything in the `instructions` and `tools` layers must be a **snapshot taken once at
turn start** and held byte-identical for every model call in that turn. Specifically,
none of the following may appear in those two layers:

- Live/mutable state that fills or changes during the turn (a `Set`/`Map`/array populated
  by in-flight work, a counter, a "currently active X" pointer).
- Timestamps, dates, elapsed time, or "now".
- Unordered collections serialized without a stable sort (iteration/key order drift is
  byte drift).
- Per-call randomness (nonce, uuid, sampled value).

If a value legitimately must change within a turn, it belongs in the **append-only tail**
after the history (where earlier bytes stay stable), never in the instructions/tools
prefix. This is the same discipline Codex CLI uses: static compiled-in base instructions,
environment context appended via an append-only diff where unchanged turns emit nothing.

### 3. Caches are per-subscription-account; a switch is a cold prefix

Prompt caches are **not shared between organizations**, and each ChatGPT/Codex account is
a distinct org. Therefore:

- A different account = a **cold** prefix. Switching a session's account mid-life throws
  away its warm cache. On the codex fleet this was measured at ~26 percentage points of
  cache loss on the first call of a switched turn.
- `prompt_cache_key` is a **routing/affinity hint only** — it nudges requests with the
  same key toward the same backend to improve hit rates. It does **not** create
  cross-account sharing and cannot rescue a switch. We set it to the session id
  (`promptCacheKey = sessionId`), which is stable per session; keep it that way.
- Cache warmth is therefore an **account-affinity** property. Keeping a session on one
  account preserves its warm prefix; the full capacity/assignment design that exploits
  this lives in `docs/design/subscription-capacity-and-caching.md`.

### 4. Retention is short and some invalidation is legitimate — be schedule-aware

The Codex path cache expires after roughly **15 minutes idle** (OpenAI docs quote
5–10 min up to 1h; OpenAI staff quote ~15 min specifically for the Codex path). Two
kinds of invalidation are **expected, not bugs**, and must not be "fixed":

- **Long idle gaps.** An autonomous turn that idles > ~15 min between model calls
  legitimately cold-starts the next call. This is an OpenAI TTL, not a client defect.
- **Compaction.** Compaction deliberately rewrites the stable history prefix to shrink
  context. The next call after a compaction is *supposed* to re-warm from a new prefix.

Distinguish these scheduled invalidations from a *bug* (a warm, recent, same-account
request that still misses). Only the latter is a client problem.

### 5. Measurement is empirical — read `cached_tokens`, never assume

Cache behavior is not inferable from the code; it must be observed per call.
`usage-telemetry.ts` reads the cached count from the Responses API usage under the field
aliases `cached_tokens` / `cachedInputTokens` / `cached_input_tokens` and emits it on the
persisted `agent.model.usage` event (input tokens, cached tokens, provider, model,
sourceKey). The cached ratio for a call is `cached_tokens / input_tokens`, where
`input_tokens` is the total input (cached is a subset of it). A provider-reported
`cached_tokens: 0` is a known real 0%; absent/null cache telemetry is unknown and must
not be projected as zero. Any claim about caching — "this change helped", "the prefix
is stable", "the account is warm" — must be backed by reported usage, not by reading
the request construction.

## The canonical regression: "mutable state rendered into the stable prefix"

**Pattern name: mutable state rendered into the stable prefix.** Correct data, placed in
the wrong layer (the byte-stable, cache-hashed prefix), at the wrong cadence (per model
call instead of per turn), silently cold-starts every request.

### The incident (tool_search)

`installCodexToolSearch` wraps `getAllTools`, so the `tool_search` tool **description is
re-rendered on every model call** from a **live by-reference `Set`** of connector
namespaces that fills *during the turn* as the `codex_apps` `tools/list` results resolve.
The description flips mid-turn from:

> "…Connected sources: none currently available."

to:

> "…You have access to tools from the following sources: - github - gmail - linear"

Because the `tools` block precedes the history in the prefix (invariant 1), the model
call *after* that flip misses the **entire history prefix**, not just the tool. Nothing
errors; the only symptom is a collapsed `cached_tokens`.

This was confirmed on the wire: a two-model-call capture showed the core client prefix
byte-stable (`instructions equal: true`, `tools equal: true`, shared input items
identical) **except** the `tool_search` description, which was `equal across calls:
false` once the connector `Set` filled between calls. So the core request construction is
clean; this one rewrap is the confirmed client-side breaker. Its blast radius is scoped
to connector-enabled turns at the discovery transition — real and fixable, but not the
whole story (steady-state within-turn non-warming has a separate, backend-leaning cause;
see the plan doc).

### The fix shape (and its trap)

Snapshot the `tool_search` description **once per turn** instead of reading the live
`Set` per call. But the snapshot has a capability trap: the connector `Set` fills lazily,
and the description is the model's *only* signal of which connectors exist (schemas are
deferred). Freezing an empty/partial snapshot at "first model call" would tell the model
"no connectors" for the whole turn even though the user connected some — a **functional
capability loss, worse than a cache miss**. The only safe form is: populate the connector
`Set` *before* the first model call (block on discovery), then freeze; on discovery
timeout/partial-failure, **fall back to today's per-call live render** and accept the
cache miss. Never freeze an empty or partial snapshot.

## Reviewer checklist — before anything renders into `instructions` or `tools`

Ask, for every value composed into those two layers:

1. **Live state?** Does it read a `Set`/`Map`/array/counter/"active pointer" that is
   populated or mutated *during* the turn? (The tool_search bug.)
2. **Time?** Does it include a timestamp, date, elapsed time, or "now"?
3. **Unordered serialization?** Does it serialize a `Set`/`Map`/object whose
   iteration/key order is not explicitly, stably sorted?
4. **Per-call randomness?** A nonce, uuid, or sampled value?
5. **Cadence?** Is it computed **once per turn** (like `buildAgent`), or re-derived per
   model call by some wrapper?
6. **If it must change within the turn**, is it in the append-only tail *after* the
   history, rather than in the instructions/tools prefix?

Any "yes" to 1–4, or "per model call" on 5, is a prefix breaker. Move it to a per-turn
snapshot or to the append-only tail, and verify with `cached_tokens` on a two-call turn.

## The verified baseline (reference table)

The mechanism is worth the discipline because a single account, using this exact
construction, caches almost perfectly. The bar below is recomputed from local Codex CLI
rollouts and is reproducible with the committed script.

### Codex CLI baseline — the bar (verified, reproducible)

| Metric | Value |
| --- | --- |
| Rollout files scanned | 2,130 (2,017 with measured calls) |
| Model calls measured | 1,586,180 |
| Σ input tokens | 228,313,685,685 |
| Σ cached input tokens | 219,153,436,672 |
| **Token-weighted cached ratio** | **96.0%** |
| Per-call cached ratio, median (p50) | 98.8% |
| Per-call distribution p10 / p50 / p90 | 88.2% / 98.8% / 99.7% |
| Long agentic sessions (≥10 calls, ≥200k input), per-session median | 93.2% |
| Calls below 50% cached (cold starts) | 2.53% |
| Sanity: calls with cached > input | 0 |

Method: per model call, Codex logs an `event_msg` with `payload.type == "token_count"`
whose `payload.info.last_token_usage` carries `{ input_tokens, cached_input_tokens }` for
that single call. Token-weighted ratio = `Σ cached_input_tokens / Σ input_tokens`. The
per-call median (98.8%) is *higher* than the token-weighted figure (96.0%) because the
minority of large cold-start calls (the 2.53% below 50%) carry disproportionate token
weight — the correct relationship, and the reason the token-weighted number is the
headline for cost.

Reproduce: `node scripts/recompute-codex-cache-baseline.mjs` (reads
`~/.codex/sessions/**/rollout-*.jsonl`).

### OpenGeni codex-subscription fleet — the gap (measured at audit time)

Measured from the persisted `agent.model.usage` events over a 4-day window on the codex
fleet (point-in-time; requires production data access to reproduce, so it is *not* in the
committed script):

| Metric | Value | Note |
| --- | --- | --- |
| Token-weighted cached ratio | ~48% | vs the 96% bar on the same construction |
| Within-turn call 1 → call 2 warming (same account) | ~31% → ~31% | call 2 re-sends call 1's prefix seconds later and does not warm |
| Model variance (same client code) | ~46%–76% across models | strong signal of a backend/model component |
| Account-switch penalty (first call of a switched turn) | ~26pp lower | invariant 3, quantified |

The gap between 96% and ~48% is the subject of the north-star plan. The core client
construction is byte-stable (proven on the wire), so the loss splits between the narrow,
confirmed `tool_search` breaker above and a steady-state floor most consistent with an
OpenAI backend / per-account concurrency effect (a controlled low-load probe to nail the
latter was blocked at audit time). Treat the cache-regime win from load-spreading as a
**hypothesis to be proven by measurement**, not a certainty — see the plan.

## Canonical code

- `packages/runtime/src/index.ts` — request construction, `store: false`, `prompt_cache_key`, `agent.model.usage` emission
- `packages/runtime/src/codex-tool-search.ts` — the `tool_search` rewrap (the regression site)
- `packages/runtime/src/usage-telemetry.ts` — `cached_tokens` capture
- `packages/runtime/src/history-sanitizer.ts` — stable history serialization for the resend
- `apps/worker/src/activities/agent-turn.ts` — per-turn `promptCacheKey = sessionId`, credential selection
- `apps/worker/src/activities/codex-rotation.ts` — account rotation / affinity
- `apps/worker/src/observability-metrics.ts` — model token metrics
- `scripts/recompute-codex-cache-baseline.mjs` — reproduces the baseline table above

## 2026-07-19 evidence refresh — sticky routing accepted; telemetry boundary extended

This section is additive. It preserves the historical audit tables above while recording
the production result and primary-source contract that became available afterward.

### Accepted production slice

The fleet gap above was traced to backend shard routing, not a rewrite of the cacheable
prefix. PR #386 made the stable OpenGeni session id the Codex HTTP `session_id` sticky
routing header on every request while retaining the existing body `prompt_cache_key`.
Its squash-landed main commit is `58c78c6d65940f2b3efbea162f383dc68225299a`
(historical PR head `be1143efb783fc6b072b0ca6474caa57592d6049`, tree
`102072eb6ce1e2a7f835155fcfdb21ac79f2b10c`). Production then sustained **95–99%
token-weighted cache reads**, exceeding the approximately **94%** pinned Codex CLI
reference used for that acceptance window. This sticky-routing behavior is accepted and
must not regress; it does not, by itself, close the broader OPE-31 observability and
provider-contract scope.

### Immutable Codex and provider-documentation pins

The latest stable public Codex release observed for this refresh was `rust-v0.144.6`:

- annotated tag object `1e66aaa95b5ab39d3ef3057cd50bdecd576a8356` (no
  cryptographic signature);
- peeled commit `5d1fbf26c43abc65a203928b2e31561cb039e06d`;
- tree `8c4eca19b7b2acce60c9701d93859a7c4d66d64a`;
- commit date `2026-07-18T09:05:05-04:00`.

The public Codex `main` observed during the same research was
`678157acaa819d5510adfe359abb5d0392cfe461`; it is informational, not the release pin.
Pinned source carries `prompt_cache_key`, treats instructions, tools, reasoning,
`include`, service tier, the cache key, and text controls as request-reuse-sensitive,
and tests that follow-up input extends the prior prefix while instructions, tool order,
and cache key remain constant. Codex `TokenUsage` still exposes cached-input tokens but
not cache-write tokens. OpenGeni must therefore preserve cache-write telemetry when a
provider reports it without manufacturing writes for the Codex subscription backend.

Canonical OpenAI pages were fetched at `2026-07-19T22:39:22Z`:

| Document | SHA-256 | ETag | Last-Modified |
| --- | --- | --- | --- |
| [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching/) | `5c80eb271afcac94b337cc3607e13bf588badf4fca5935bda09b2ca184caf2d1` | `"0a1eb15d86d3fdc5d6b3d337208119e9"` | `Sun, 19 Jul 2026 21:43:49 GMT` |
| [Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create/) | `014be6fa0348e89aea395e44894e597348a2eabd64c1d10afa104f5b3c8398d1` | `"c4dc02b0e088bef4c2120fb2c85a1c33"` | `Sun, 19 Jul 2026 21:43:52 GMT` |

### GPT-5.6 usage and request controls

OpenAI documents GPT-5.6 cache writes at
`usage.input_tokens_details.cache_write_tokens`; cache reads remain `cached_tokens`.
GPT-5.6 cache writes are billed at **1.25× the uncached input rate**. The runtime
normalizes documented `cache_write_tokens` plus the SDK-style `cacheWriteTokens` alias
into nullable `cacheWriteTokens` on `agent.model.usage`. The same contract applies to
reads, writes, and reasoning detail fields: prefer a reported positive value across
detail entries; if every report is zero, preserve zero; if the field is absent or
invalid, preserve null.

For GPT-5.6+, OpenAI also documents:

- `prompt_cache_key` for more reliable matching;
- content-block `prompt_cache_breakpoint: { mode: "explicit" }` controls plus
  request-wide `prompt_cache_options`;
- a currently documented `30m` explicit-cache TTL, at most four breakpoints per
  request, and matching against up to the latest 80 conversation breakpoints;
- deprecated `prompt_cache_retention` for GPT-5.6+ (retained for earlier models);
- mutually exclusive `previous_response_id` and `conversation` stateful paths; and
- `reasoning.encrypted_content` for stateless `store: false` reasoning continuity.

These are separate mechanisms: provider-managed prefix caching is not Responses
conversation chaining, local deterministic render caching, or answer/output memoization.
OpenGeni's Codex subscription path remains stateless resend with encrypted-reasoning
replay; it does not use `previous_response_id` or `conversation`.

### Capability and accounting boundary

Do **not** send `prompt_cache_breakpoint`, `prompt_cache_options`, or retention controls
through the Codex subscription backend merely because the public OpenAI API documents
them. The Codex normalizer is a strict allowlist, and no backend entitlement/capability
proof currently authorizes those fields; unsupported fields may fail the request with a
400. They remain disabled until an exact Codex-backend contract and controlled staging
probe prove support.

Likewise, recording reported cache-write tokens does not settle billing. Current model
pricing distinguishes uncached input, cached input, and output but has no model-specific
cache-write rate. Do not silently bill reported writes as ordinary input and do not
coerce absent writes to zero. Pricing support must land through the provider/model
contract owner with the documented GPT-5.6 1.25× rate and exact provider applicability.

Worker Prometheus cache labels remain provider-only. A reported cached zero contributes
a real 0% hit-ratio observation; absent/null cached telemetry contributes no ratio.
Reported positive cache writes may advance
`opengeni_model_cache_write_tokens_total{provider}`; absent/null writes do not create a
phantom zero. Wiring the normalized write field into the shared agent-turn activity must
be coordinated with its active lifecycle/rotation owners rather than raced in a
telemetry-only change.
