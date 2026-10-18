# Codex: reuse a familiar prefix on the first request

Status: proposed; requires review before merge. Measured October 18, 2026,
between 10:39 and 10:51 UTC. These are synthetic request pairs, not Opengeni
session trees; no child sessions or tool executions are included.

## Problem and provider evidence

New sessions send a new UUID in both the body `prompt_cache_key` and the
Responses `session_id` header. An identical prefix can therefore miss on a new
session even though follow-up requests cache well.

This is not inferred from usage totals alone. A four-way HTTP experiment varied
the two fields independently while preserving the prompt prefix, model and
account. Five fresh synthetic sessions per arm, each followed by an appended
request, produced:

| Header | Body key | First-request hits | Follow-up hits |
| --- | --- | ---: | ---: |
| Session UUID | Session UUID | 1/5 | 5/5 |
| Session UUID | Shared | 0/5 | 5/5 |
| Shared | Session UUID | 4/5 (all after its cold bootstrap) | 5/5 |
| Shared | Shared | 5/5 | 5/5 |

All arms used the same novel synthetic prefix. The shared/shared arm could use
the cache already populated by the shared-header arm, so its first hit is not
an independent cold-bootstrap comparison. Full prefix hits were 31,360 tokens
on new sessions and 31,488 on follow-ups, from approximately 31,630 input tokens.
This isolates the header as the effective affinity lever on the tested Codex
backend; changing the body key alone is insufficient. It does not reveal the
backend's physical shard topology or guarantee routing under every load.

Retained [four-way samples](codex-cache-affinity-factorial.ndjson) contain usage
and timing only. This initial isolation run used a standalone HTTP probe with
1,050 synthetic records and no tools. The reusable adapter benchmark below
uses 920 records plus a tool schema; its token counts therefore differ.

### What the providers actually document or implement

- [Codex upstream, pinned source](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/client.rs#L646):
  `prompt_cache_key()` normally returns the session ID, with an override and
  special internal-session handling. `responses_session_id()` explicitly says
  ChatGPT derives cache affinity from the Responses session-id header. Root
  sessions use the cache-key override there; non-root agents retain their
  session ID. Actual session identity remains in other metadata. Thus ordinary
  CLI session UUIDs do not solve cross-session reuse automatically.
- [OpenAI prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching):
  current documentation distinguishes older models' routing hint from GPT-5.6
  and later automatic routing and optional separate cache accounting. Cached
  states reside on individual machines; load, eviction and overflow can still
  prevent reuse. The public API documentation is not a substitute for testing
  the ChatGPT/Codex route. This change does not alter OpenAI/Azure API keys.
- [Claude prompt-caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  cache reuse depends on identical tools/system/messages and cache breakpoints,
  with workspace-level isolation on the Claude API. Opengeni's native adapter
  does not send OpenAI's `prompt_cache_key`; internally that value supplies
  Claude session identity. No evidence establishes the same Codex-header defect
  there, so Claude identity and cache markers are untouched. A live native
  adapter control was attempted but returned HTTP 429 before inference; no
  Claude cross-session cache-rate claim is made.

## Design

Only the Codex Responses header changes. Add an optional `cacheAffinityKey` to
its existing request context. The worker derives it by SHA-256 of a versioned
tuple containing workspace and frozen initiating human subject. Human-owned
scheduled/delegated runs use the same persisted human identity resolution as
preference snapshots. Unknown human identity retains the old session UUID.

The cohort is deterministic across new sessions, activity retries, turns and
worker processes. Different people and workspaces get different hints; provider
account credentials remain independent. It does not grant authority or make a
cache hint a data-isolation mechanism. An explicit human-identity change selects
that person's cohort; account changes may also be cold.

The existing body `prompt_cache_key` remains per session. No instruction, tool
schema, history item, reasoning setting, model or cache marker changes. Do not
hash a growing prompt, switch affinity after the first request, introduce a
warm-up inference, or infer cohorts from later messages: each would either
lose stickiness or introduce unnecessary state and work.

`setCodexIdentityHeaders` is shared by HTTP dispatch, WebSocket pre-open and
credential refresh. `createResponsesTurn` still receives the actual session ID;
sockets and `previous_response_id` chains remain conversation-scoped. Titles
and standalone compaction retain their existing transport scopes. Existing
package consumers without the new optional field retain legacy behavior.

## Reproduction and validation

`scripts/bench-codex-cache-affinity.ts` makes real, quota-consuming requests
through the Codex adapter. Supply `CODEX_AUTH_FILE`; optional `PROBE_MODEL`,
`PROBE_REPEATS`, `PROBE_TRANSPORT=http|websocket`, `PROBE_RUN`, and `PROBE_ARMS`
control the experiment. Arms are `session`, `body`, `header`, and `shared`.
It prints only synthetic-run metadata, usage and timing, never credentials or
prompt bodies. It validates the output and closes its own sockets.

The before/after comparison uses ten new sessions per arm, a roughly 27.7K-token
prefix including a function schema, and a private user suffix. A separate
bootstrap makes the prefix familiar; alternating arm order reduces temporal
bias. Every first request is followed by the exact prior input/output plus a
new user message. Request starts are paced to avoid cache-overflow load.

### Before/after: actual adapter and Responses WebSocket

[Raw samples](codex-cache-affinity-websocket.ndjson), model `gpt-6.1-sol`, low
reasoning. Ten measured sessions per arm, excluding each arm's bootstrap.

| Metric | Session header (before) | Shared header (after) |
| --- | ---: | ---: |
| New-session first-request cache hits | 2/10 | 10/10 |
| Mean first-request input tokens | 27,711.6 | 27,709.7 |
| Mean first-request cached tokens | 5,504 | 27,520 |
| Mean first-request uncached tokens | 22,207.6 | 189.7 |
| Mean first-request input cost, API equivalent | $0.0449656 | $0.0031314 |
| First-text latency, median | 2.056 s | 2.333 s |
| First-text latency, mean | 2.009 s | 2.462 s |
| Follow-up cache hits | 10/10 | 10/10 |
| Follow-up first-text latency, median | 1.769 s | 1.720 s |

Input costs use the benchmark's comparison rates of $2/M fresh input and
$0.10/M cached input; these are API-equivalent figures, not subscription
charges. Output was five tokens on every request and is excluded from this
input-only comparison. The measured saving is $0.0418342 per first request,
or 93.0%. A previously cold request recovers about 27.5K cached tokens; the
baseline mean is lower because two sessions happened to hit already.

All first requests used new sockets and full input; all follow-ups reused their
own sockets and incremental continuation. All synthetic tasks returned `OK`.
There is **no demonstrated first-request latency improvement**: the median was
0.277 s slower with the shared header in this small sample. This experiment
establishes cache/accounting savings and retained follow-up reuse, not a speed
win or a statistical latency regression. Provider placement/load and connection
timing remain confounders, and the sample covers one model/account/cohort.

### HTTP adapter confirmation

[Raw HTTP samples](codex-cache-affinity-http.ndjson): five new sessions per arm,
each with an appended follow-up, excluding bootstraps. First-request hits went
from 0/5 to 5/5; follow-up hits stayed 5/5. Mean uncached first-request input fell
from 27,717.8 to 196 tokens. Median first-text latency was 1.967 s before and
1.618 s after. This supports cache reuse on both transports but does not overturn
the mixed latency result from the larger WebSocket comparison.

### First-request usage and cost totals

The exact-model comparison mapping is `reviewedModelListPricing["gpt-6.1-sol"]`
in `packages/config/src/index.ts`, reviewed October 3, 2026 against
[OpenAI pricing](https://developers.openai.com/api/docs/pricing). Below 272K
input tokens: $2/M fresh input, $0.10/M cache read, $10/M output. The initial
factorial calls reported zero cache-write tokens. No cache-write fee, service
tier premium, tool cost or subscription debit is inferred. One model accounts
for 100% of each arm's equivalent cost.

| First-request sample | Input including cache | Cached input | Output | Token-weighted cache rate | Fresh input USD (% cost) | Cache-read USD (% cost) | Output USD (% cost) | Total USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| WebSocket before, 10 requests | 277,116 | 55,040 | 50 | 19.86% | 0.444152 (98.67%) | 0.005504 (1.22%) | 0.000500 (0.11%) | 0.450156 |
| WebSocket after, 10 requests | 277,097 | 275,200 | 50 | 99.32% | 0.003794 (11.93%) | 0.027520 (86.50%) | 0.000500 (1.57%) | 0.031814 |
| HTTP before, 5 requests | 138,589 | 0 | 25 | 0% | 0.277178 (99.91%) | 0 (0%) | 0.000250 (0.09%) | 0.277428 |
| HTTP after, 5 requests | 138,580 | 137,600 | 25 | 99.29% | 0.001960 (12.27%) | 0.013760 (86.16%) | 0.000250 (1.57%) | 0.015970 |

Regression coverage includes deterministic cohorts and isolation, no-human
fallback, unchanged body and prompt text, HTTP authentication retry, matching
WebSocket pre-open affinity, and two conversations sharing affinity without
sharing sockets or response chains. Existing Claude identity tests remain in
the verification set.

Local checks: 500 tests across 20 Codex/worker/Claude-identity/OpenRouter-cache
files passed, including the worker's production request-parity tests. The 154
focused affinity/transport tests also passed after formatting. Codex and worker
TypeScript projects passed. Changed source files passed formatting and lint;
the standalone benchmark typecheck and public-repository hygiene guard passed.
Three existing human-identity-resolution tests also passed. The full monorepo suite and deployed
browser benchmark were not run for this header-only draft.

## Risks and decision

Review the workspace/person affinity scope and the provider-header change
before merge. Existing sessions may pay one cold request when moving from their
old route. Busy cohorts can overflow, and eviction or account rotation can still
miss; this is not a guaranteed cache pin. No arbitrary shard count, traffic cap,
provider-wide constant, configuration switch or persisted cache-routing state
is introduced without evidence that it is needed. Synthetic requests isolate
the cost mechanism; a production/browser-task benchmark remains necessary to
claim end-to-end task latency or quality improvements.
The provider's affinity header now labels a cohort rather than an individual
session; this deliberately changes provider routing metadata, not model input.
