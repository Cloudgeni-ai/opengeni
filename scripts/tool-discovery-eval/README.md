# Tool discovery evaluation

## Decision

Improve the existing search/list/invoke path, not a second discovery API:

- Field-aware lexical retrieval separates names and capability sentences from long operational guidance. It indexes the exact authorized deferred pool.
- Ordinary search loads the strongest match per explicit query clause and returns compact alternatives. No-match, operation-only and exact-tie queries stay compact. Known exact names bypass ranking and inference. This avoids making every no-model search pay for a second load call.
- Search also covers integrations the person could connect. A search with no named or strong installed match reads the catalog's top three matches for the query (bounded at 2 s, best effort). When the query contains the whole name of one whose next step is a Connect card, the result names it in `notConnected` (a developer message after the result on native routes) and loads `capability_authorization_request`, so the card is the next call. The two setup tools also load together when either is chosen.
- Native OpenAI/Azure and Codex routes **keep hosted client search and native function loading**. The shared selection runs inside that protocol, not a migration to text declarations / `tool_invoke`. Native search outputs carry only complete selected definitions; compact alternatives are available through `tool_list`, not embedded into the native search output.
- An explicitly configured **decision model** handles ambiguous searches from the first 40 candidates. Strong lexical matches skip inference. The bypass requires resource coverage of at least 0.5 and a score at least 1.25 times the runner-up for every explicit clause. These are transparent heuristics, **not calibrated confidence probabilities**; the no-model default does not pretend its best-ranked choice is certain.
- `tool_list({view:"groups"})` is an on-demand directory; pass a returned `group` to browse it. Opaque connections stay together under compact display keys with a representative tool, rather than exposing long identity hashes or hundreds of tiny groups.
- Schemas are not shortened or inferred. Selected definitions are frozen on the search call and disclosed after its result. They never enter a changing earlier prompt or top-level tools block.
- No paid model, embedding index or credential is required for the default path. Optional typed inference needs explicit deployment configuration. There is no new inference timeout or concurrency quota. Unconfigured/unavailable selection uses best-match-first lexical recovery. Only selected schemas are loaded; alternatives remain compact.

**Recommendation (October 21):** keep no-model best-match-first as the free default;
for optional paid selection, use **Jev behind the shared decision-model interface**.
The tested route is OpenRouter's typed Decisions API, model `typesafe/jev-1.13`.
It beats the old path's whole-discovery time on both catalogs in each warmed
repeat, but the no-model path is faster on A in the pooled warm results. Jev's
initial 40/40 correct first tools did **not** repeat: pooled warm accuracy is
95% / 97.5%, versus 95% / 100% before. This is a small development sample, not
a production speed or perfect-accuracy guarantee. GPT-OSS/Cerebras and nano remain
historical comparison points only, not shipped production backends or defaults.

The abstraction now lives in `@opengeni/decisions` and is used by both tool discovery
and `code_search`. It returns typed predicates, choices and scores, not prose.
The existing Jev client supplies the direct adapter; OpenAI and OpenRouter have
distinct real Decisions adapters, **not chat-completions fallbacks**. See
[configuration, accounting and verified provider boundaries](../../docs/decision-models.md).
No production configuration was changed by this evaluation.

## Repeated warm selector runs — October 21, 2026

After the initial current-model experiment below, each typed model ran the same
60 queries per catalog **twice with an explicit transport/model warmup**. These
are 60 distinct queries repeated, not 120 independent queries. Four model/catalog
processes ran concurrently, each doing its two repeats sequentially. All 480
measured requests returned valid answers; no case was omitted or relabeled.

Warmups ask a small unrelated readiness question, not an evaluated query or its
candidate prefix. They are excluded from measured rows but retained with their
own usage/cost receipts. The eight selector warmups cost **$0.000110704 total**.
Mean/p95 are empirical wall times, including transport, not confidence intervals
or a guarantee of serving latency. Cost is provider-reported and identical across
the two repeats for each query; models/versions and labels match the initial run.

| Selector / catalog | Top-1 / top-3, repeat 1; repeat 2 | Mean / p95 ms, repeat 1; repeat 2 | Pooled mean / p95 ms | Mean USD/search |
| --- | ---: | ---: | ---: | ---: |
| Jev A | 98.3/98.3%; 96.7/98.3% | 343/410; 345/424 | 344/423 | $0.000593 |
| Jev B | 98.3/98.3%; 98.3/98.3% | 339/414; 316/410 | 328/414 | $0.000387 |
| Luna A | 88.3/88.3%; 88.3/88.3% | 617/797; 574/851 | 596/805 | $0.001652 |
| Luna B | 86.7/86.7%; 86.7/86.7% | 553/747; 532/883 | 543/838 | $0.001203 |

Pooled Jev top-1/top-3 is **97.5/98.3% on A, 98.3/98.3% on B**; Luna is
88.3/88.3% and 86.7/86.7%. Off-label selections/search are 0.017/0.067 for Jev,
0/0.033 for Luna, unchanged from the initial run. The Jev A ordering variation is
retained, not hidden by quoting only the stronger repeat. This confirms the
selector-level recommendation, separately from whole-discovery timing.

### Repeated warm whole-discovery runs

Current main agent `openai/gpt-6-luna`, same 20 distinct cases per catalog,
**two warmed repeats**. Before/default are freshly interleaved within each repeat;
Jev/Luna reuse the corresponding warmed baseline. Main-agent and selector readiness
calls precede scored rows without preloading any evaluated query. Model/catalog
processes overlap; this is not randomized provider-capacity isolation. Every case
is included. These remain generic Chat Completions discovery-only simulations,
stopped before domain execution—not native Responses latency or completed tasks.

Pooled 40 observations per path/catalog (not 40 distinct tasks):

| Catalog / path | Correct first domain tool | Calls | Mean / p95 total time | Received tokens | Main + selector USD/task |
| --- | ---: | ---: | ---: | ---: | ---: |
| A before | 95% | 1.30 | 3.937 / 6.469 s | 6,489 | $0.000978 |
| A no model | 95% | 1.25 | 3.023 / 4.063 s | 1,636 | $0.000399 |
| A Jev | 95% | 1.05 | 3.248 / 4.410 s | 1,375 | $0.000690 |
| A Luna Decisions | 95% | 1.275 | 3.629 / 7.285 s | 1,471 | $0.001337 |
| B before | 100% | 1.625 | 4.735 / 10.565 s | 9,473 | $0.001407 |
| B no model | 97.5% | 1.60 | 3.757 / 7.718 s | 1,331 | $0.000387 |
| B Jev | 97.5% | 1.20 | 3.221 / 5.234 s | 738 | $0.000558 |
| B Luna Decisions | 95% | 1.30 | 3.654 / 6.065 s | 954 | $0.001282 |

Jev's selector-only cost/task is $0.000336 / $0.000275; Luna's is
$0.000956 / $0.000966. All received cost receipts are provider-reported, and no
selector call failed. Costs above exclude separately recorded warmups.

Full repeat-level results, with repeat 1 / repeat 2 in each cell:

| Path | Correct | Calls | Mean seconds | p95 seconds | Tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| A before | 95% / 95% | 1.40 / 1.20 | 4.221 / 3.654 | 8.411 / 5.413 | 6,928 / 6,050 |
| A no model | 95% / 95% | 1.30 / 1.20 | 3.083 / 2.964 | 4.063 / 4.017 | 1,712 / 1,560 |
| A Jev | 95% / 95% | 1.05 / 1.05 | 3.066 / 3.431 | 4.254 / 4.560 | 1,382 / 1,368 |
| A Luna | 95% / 95% | 1.30 / 1.25 | 3.558 / 3.700 | 7.285 / 4.781 | 1,463 / 1,479 |
| B before | 100% / 100% | 1.60 / 1.65 | 4.680 / 4.790 | 10.565 / 8.925 | 9,810 / 9,135 |
| B no model | 95% / 100% | 1.60 / 1.60 | 3.847 / 3.668 | 7.718 / 4.865 | 1,226 / 1,437 |
| B Jev | 100% / 95% | 1.25 / 1.15 | 3.246 / 3.196 | 5.176 / 5.234 | 774 / 702 |
| B Luna | 100% / 90% | 1.35 / 1.25 | 3.837 / 3.470 | 6.119 / 5.750 | 735 / 1,173 |

**The original 40/40 result is not a robust accuracy claim.** In the warmed repeats,
both no-model and Jev lose 2.5 percentage points on B versus the larger-schema
baseline, and Luna loses five. Jev is faster than before on both sets in each repeat,
but is 225 ms slower than no-model on A in the pooled data. Luna's A repeat 2 is
46 ms slower than before. The smallest Jev improvement against before is only
223 ms on A repeat 2. These tradeoffs remain visible; there was no retuning,
relabeling or rejection of unfavorable cases after the repeats.

The additional warm experiment contains 480 all-query selector requests and 320
discovery-trajectory observations. Reused baseline rows are counted only once in
spend. Measured requests cost **$0.7416988**; **28 warmup requests cost $0.000262708**;
total **$0.741961508**, all reported receipts. Warmups remain separate from accuracy,
case counts and measured latency/cost averages. The initial run below remains
available as evidence of variation, not pooled into these two warm repeats.

## Initial typed-model results — October 21, 2026

Both typed arms use the same 40 lexical candidates, common state and one predicate
per candidate. The frozen threshold is **strictly above 0.5**, descending probability,
stable candidate-order ties. Independent predicates may include alternatives or
miss/reorder actions; these are not calibrated confidence scores. Refusals or invalid
answers reject the selection, rather than loading a convenient partial set.

All 240 all-query requests succeeded with valid answers. Returned models were
`typesafe/jev-1.13-20260917` and `openai/gpt-6-luna-decisions-20261006`; both used
`https://openrouter.ai/api/alpha/decisions`. Costs below are **provider-reported**,
not advertised rates or the direct Jev client's estimates.

### All-query selector (no lexical bypass)

| Method | A top-1 / top-3 | B top-1 / top-3 | Off-label tools/search A / B | Mean / p95 ms A; B | USD/search A / B |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before BM25 | 60.0% / 76.7% | 51.7% / 70.0% | 6.92 / 6.95 | — | $0 / $0 |
| Field-aware lexical | 78.3% / 88.3% | 66.7% / 83.3% | 6.83 / 6.87 candidates | ~6 ms p95 | $0 / $0 |
| Lexical + BGE-small RRF | 76.7% / 90.0% | 68.3% / 90.0% | See historical experiment | 16 / 59 ms mean | Local inference |
| Jev typed | 98.3% / 98.3% | 98.3% / 98.3% | 0.017 / 0.067 | 381 / 465; 311 / 402 | $0.000593 / $0.000387 |
| Luna Decisions | 88.3% / 88.3% | 86.7% / 86.7% | 0 / 0.033 | 541 / 821; 522 / 755 | $0.001652 / $0.001203 |

Lexical candidate counts do not mean all those schemas are loaded. Neither pure
selector row is the conditional runtime's accuracy: strong matches bypass inference.
The fixed shortlist, same rubric and labels are used for both typed models. This is
not a claim that the rubric is optimal for every provider.

### Conditional runtime replay, including lexical bypass and schema budgets

| Generic output | A top-1 / top-3 | B top-1 / top-3 | Complete mean tokens A / B | Off-label loaded/search A / B |
| --- | ---: | ---: | ---: | ---: |
| Before | 60.0% / 76.7% | 51.7% / 70.0% | 6,671 / 5,913 | 6.92 / 6.95 |
| Default, no model | 78.3% / 88.3% | 66.7% / 83.3% | 1,221 / 718 | 0.25 / 0.35 |
| Jev conditional | 90.0% / 96.7% | 95.0% / 98.3% | 1,369 / 781 | 0.117 / 0.050 |
| Luna conditional | 88.3% / 95.0% | 91.7% / 95.0% | 1,360 / 791 | 0.117 / 0.067 |

Top-3 includes compact alternatives; complete tokens include their receipt **and**
loaded schema JSON, not just the small receipt. Default p95 tokens are 4,042 / 1,341;
Jev 8,478 / 1,584; Luna 8,478 / 1,932, versus 18,098 / 23,287 before.
A genuinely needed large schema remains large. Strong-match bypass loses accuracy
against judging every query, especially on A; its heuristic is not a probability.

Native outputs contain selected definitions only. They preserve hosted search and
direct function loading; these are offline executor results, **not live native latency**:

| Native output | A top-1 / top-3 | B top-1 / top-3 | Mean schema tokens A / B |
| --- | ---: | ---: | ---: |
| Before | 60.0% / 76.7% | 51.7% / 70.0% | 6,671 / 5,913 |
| Default | 76.7% / 76.7% | 66.7% / 66.7% | 831 / 435 |
| Jev conditional | 90.0% / 90.0% | 95.0% / 95.0% | 1,106 / 631 |
| Luna conditional | 88.3% / 88.3% | 91.7% / 91.7% | 1,098 / 641 |

The native default's B top-3 drops 70.0% → 66.7% because fewer schemas are loaded;
this can cost recovery calls. Native agents can browse compact candidates with
`tool_list`. Do not hide that tradeoff behind ranked-candidate or generic top-3.

### Whole-discovery trajectories with current main agent Luna

`openai/gpt-6-luna` ran every third frozen query: 20 distinct cases per catalog.
Before/default were freshly interleaved; typed arms reuse that same baseline and
were run afterwards, concurrently across catalogs/typed arms. This is one current
repeat, not a randomized timing trial. Both arms use **generic dispatch over Chat
Completions**. The harness stops at the first domain call, before execution, so it
measures discovery rather than completed-task success or native Responses search.

| Catalog / path | Correct first tool | Discovery calls | Mean whole-discovery time | Received discovery tokens |
| --- | ---: | ---: | ---: | ---: |
| A before | 95% | 1.35 | 4.407 s | 6,368 |
| A default | 90% | 1.55 | 3.807 s | 1,855 |
| A Jev | 100% | 1.00 | 3.257 s | 1,318 |
| A Luna Decisions | 95% | 1.55 | 4.270 s | 1,756 |
| B before | 100% | 1.50 | 4.698 s | 8,382 |
| B default | 100% | 1.45 | 3.553 s | 1,520 |
| B Jev | 100% | 1.10 | 3.368 s | 861 |
| B Luna Decisions | 100% | 1.25 | 3.685 s | 978 |

**The no-model A path has more calls and one fewer correct first tool than before**,
despite lower mean elapsed time; an outlier takes seven discovery calls. Jev avoids
that case in this run and beats before/default time on both sets. Luna is slower than
the no-model default, and its A improvement over before is only 137 ms. All rows
include errors/recovery; no favorable subset was selected.

| Mean USD per task | Before A / B | Default A / B | Jev A / B | Luna A / B |
| --- | ---: | ---: | ---: | ---: |
| Selector only | $0 / $0 | $0 / $0 | $0.000310 / $0.000275 | $0.001045 / $0.000792 |
| Main agent + selector | $0.000976 / $0.001255 | $0.000448 / $0.000394 | $0.000656 / $0.000570 | $0.001477 / $0.001108 |

All current typed trajectories recorded provider cost receipts; no failed selector
calls occurred. Outage, invalid-answer, refusal, cancellation and fallback behavior
is exercised by mocks, not claimed as live outage evidence. Direct TypeSafe and
direct OpenAI Platform success remain untested without their own keys. The real
Codex-login probe reached ordinary Luna Responses, not the fast typed endpoint:
Platform Decisions returned 401, correctly headed Codex Decisions returned JSON404.
See [exact probe scope](../../docs/decision-models.md#verified-boundaries-october-21-2026).

## Dataset and method (October 20, 2026)

Two real catalogs, without replicated padding:

| Catalog | Raw tools | Deferred tools evaluated | Queries |
| --- | ---: | ---: | --- |
| A: general agent harness and integrations | 617 | 605 | 24 actual history queries + 36 realistic synthetic queries |
| B: application catalog | 1,079 | 1,079 | 50 actual history queries + 10 realistic synthetic queries |

Both arms use the same authorized-pool classification. Catalog B is a full application registry; real sessions can receive module- and permission-filtered subsets. Its queries were curated from 1,024 historical discovery calls. The next observed domain tool is **not** automatically ground truth: it can be a prerequisite or an unrelated later action. The public fixture contains catalog A's 60 queries. Raw catalogs, private queries, transcripts and provider responses are deliberately not committed.

Queries were frozen before scoring each catalog. A later label audit corrected seven catalog B expected sets: six omitted valid alternatives/explicitly requested capabilities and one labeled a prerequisite instead of the requested tool. The same evaluator performed this post-hoc adjudication, not an independent reviewer. Every arm is rescored with the corrected sets; original-label sensitivity appears below. This is a small development evaluation, **not a held-out generalization claim**.

`legacy-ranking.ts` freezes BM25, exact-name promotion, disclosure budgets and interaction-family expansion from baseline `cbb55f394`. Top-1/top-3 mean that an acceptable expected identity is first/among the first three. They do not prove all parts of a multi-action request are satisfied. Off-label counts are relative to the curated expected sets, not a universal judgment that every extra tool is useless. Runtime top-3 includes compact alternatives after loaded matches; loaded off-label counts below distinguish them from schemas actually disclosed.

Token counts use `gpt-tokenizer@4.1.0`, `o200k_base` BPE of serialized JSON. They are comparable payload sizes, not provider-billed tokens. Full selected payload counts include the compact receipt **and** selected schema JSON, excluding provider declaration wrappers. Latencies are observed wall-clock samples, not isolated throughput benchmarks or confidence intervals. Models and providers are nondeterministic. Eval-only `gpt-tokenizer` and `openai` are root devDependencies; OpenAI remains the same 6.47.0 already resolved by the runtime, with no runtime version change.

## Historical comparisons — October 20 (not recommended/default models)

The following sections retain the earlier GPT-5.4/nano/GPT-OSS experiments as
comparison evidence, not current recommendations or supported production decision
backends. “Conditional fast” below always means GPT-OSS, **not Jev**. Current results
and the shared typed implementation above supersede their configuration advice.

### Historical retrieval results

Each cell is top-1 / top-3 over 60 queries. First, the current **generic** runtime paths, including unloaded alternatives:

| Runtime path | A: 605 deferred tools | B: 1,079 tools |
| --- | ---: | ---: |
| Before | 60.0% / 76.7% | 51.7% / 70.0% |
| Default: best lexical match + compact alternatives | 78.3% / 88.3% | 66.7% / 83.3% |
| Conditional fast selection + lexical bypass | 88.3% / 95.0% | 95.0% / 98.3% |

The conditional row replays the captured pinned-Cerebras selections through the real runtime, including strong-match bypass and schema budgets. It is not a fresh provider call or a latency measurement. Some lexical bypasses are wrong: conditional selection on A has lower top-1 than asking the selector on every query. It is a deliberate speed/accuracy tradeoff, not hidden by reporting only pure-selector results.

Native results contain selected schemas only, not compact alternatives. This is their **offline executor-output** measurement, excluding native envelope overhead:

| Native output | A top-1 / top-3 | B top-1 / top-3 | A / B mean schema tokens |
| --- | ---: | ---: | ---: |
| Before, full ranked results | 60.0% / 76.7% | 51.7% / 70.0% | 6,671 / 5,913 |
| Best-match-first | 76.7% / 76.7% | 66.7% / 66.7% | 831 / 435 |
| Conditional fast selection replay | 88.3% / 88.3% | 95.0% / 95.0% | 970 / 617 |

The underlying field-aware ranking is 78.3/88.3% on A and 66.7/83.3% on B. Native best-match-first omits one tied A case and usually loads one tool, so loaded-output top-3 cannot be equated with ranked-candidate top-3. **B's default loaded top-3 falls from 70.0% to 66.7% while top-1 improves.** That may require additional recovery calls; no native latency win is claimed. Native compact browsing remains in `tool_list`; the optional selector substantially improves selected-output accuracy here. This limitation is not hidden by the generic trajectory results.

For comparison, isolated ranking and selection on **every query**, without the runtime bypass:

| Method | A: 605 deferred tools | B: 1,079 tools |
| --- | ---: | ---: |
| Before: flat BM25 + full schema results | 60.0% / 76.7% | 51.7% / 70.0% |
| After: field-aware lexical | 78.3% / 88.3% | 66.7% / 83.3% |
| Dense: BGE-small-en-v1.5, q8 | 63.3% / 83.3% | 51.7% / 73.3% |
| Lexical + dense, reciprocal rank fusion k=10 | 76.7% / 90.0% | 68.3% / 90.0% |
| Lexical 40 → GPT-5.4 nano, none | 91.7% / 91.7% | 95.0% / 95.0% |
| Lexical 40 → GPT-OSS-120B, low, Cerebras | 95.0% / 95.0% | 98.3% / 98.3% |
| Whole compact catalog → GPT-5.4 nano | 83.3% / 93.3% | 85.0% / 90.0% |

The historical OpenAI-compatible request uses candidate integer IDs, smallest-set instructions, and catalog-before-query messages. It remains eval-only comparison code. Exact ID validation rejects malformed/duplicate/out-of-range IDs. The full-catalog arm costs more and does not improve accuracy. The tested hybrid helps top-3, especially on B, but does not justify shipping an embedding runtime/index. This does not rule out other embedding models or rerankers. These historical tables contain no Jev measurements; current typed results are above.

Exploratory trials are not substituted for final numbers: an early name-output trial produced invalid names; an earlier GPT-5.4 nano prompt scored 95.0/98.3% on A; an earlier Haiku trial on B returned many unnecessary tools (6.93 off-label tools/search). Those trials used different prompts/output formats. The table reports the final prompt, not the best observed run.

Original-label B sensitivity (top-1/top-3): baseline 46.7/68.3%, lexical 60.0/78.3%, dense 45.0/73.3%, hybrid 61.7/88.3%, final nano 90.0/90.0%, Cerebras 93.3/95.0%, whole-catalog nano 83.3/88.3%.

### Historical payload, selection latency and cost

| Result path | A mean tokens | B mean tokens | A/B off-label tools per search |
| --- | ---: | ---: | ---: |
| Before: full results | 6,671 | 5,913 | 6.92 / 6.95 |
| Default: receipt + strongest schemas + compact alternatives | 1,221 | 718 | 0.25 / 0.35 loaded |
| Conditional fast: receipt + selected schemas + alternatives | 1,232 | 768 | 0.12 / 0.05 loaded |
| Lexical compact candidates only | 381 | 275 | 6.83 / 6.87 |
| Nano receipt + selected schemas | 1,451 | 892 | 0.13 / 0.25 |
| Cerebras receipt + selected schemas | 1,087 | 798 | 0.02 / 0.05 |

Before p95 payloads are 18,098 / 23,287 tokens; default p95 is 4,042 / 1,341; conditional fast p95 is 4,854 / 1,584. Compact-only p95 is 454 / 330. All-query nano full selected p95 is 8,478 / 3,207; all-query Cerebras is 6,290 / 2,975. Compact-only off-label candidates are not loaded schemas. The default loads 1.10 / 1.02 schemas per query; conditional selection loads 1.13 / 1.05. A genuinely needed large schema remains large. The tiny receipt alone (about 52–67 tokens for the all-query decision arms) is **not** the total context cost.

| Decision route | A mean / p95 | B mean / p95 | A / B USD per search |
| --- | ---: | ---: | ---: |
| GPT-5.4 nano, OpenRouter | 1,119 / 1,449 ms | 1,134 / 1,586 ms | $0.001340 / $0.000536 |
| GPT-OSS-120B low, OpenRouter pinned to Cerebras | 661 / 1,215 ms | 556 / 931 ms | $0.002522 / $0.001069 |
| Nano, whole compact catalog | 1,389 / 1,949 ms | 1,128 / 1,631 ms | $0.002104 / $0.001874 |

Costs are the provider's reported request cost, not advertised starting prices. The Cerebras experiment explicitly pinned `cerebras/fp16` with provider fallback disabled; all 120 responses identify Cerebras. This is an eval-only historical experiment, not a shipped decision backend. The `:nitro` trajectory experiment below used ordinary provider routing, not a pinned-Cerebras route.

Lexical retrieval p95 was about 6 ms. The optional embedding probe used Transformers.js 4.3.1 and `Xenova/bge-small-en-v1.5` q8, normalized CLS vectors, the model's query prefix, and RRF k=10. Index construction took 23.1 / 14.1 seconds; mean query embedding/ranking took 16 / 59 ms. The two probes ran concurrently, so those CPU timings are exploratory, not comparative capacity results. No embedding package is a production dependency.

### Historical live generic discovery trajectories

GPT-5.4 mini ran every third frozen query: 20 cases per catalog, using generic dispatch over Chat Completions for both arms. This **does not measure the hosted Responses search used by native GPT/Codex sessions**, nor justify migrating those sessions to generic dispatch; that proposed migration was removed during review. The agent could search/list/load and request the first domain tool, but the harness intercepted that call **before execution**, with empty task arguments. These are live discovery-only simulations, not completed user tasks or production rollout results. Time includes main-agent and selector network/inference time through the first requested domain call. Calls count discovery operations before that call. Repeating an identical discovery request ends a stalled case rather than an unbounded loop.

The revised best-match-first runtime was run twice on the same 20 cases. Repeat 1 reused the original baseline; repeat 2 freshly interleaved before/default within each case. Conditional-fast arms reused the corresponding baseline. Cases ran sequentially within each process, with the two catalogs running concurrently. These are repeated measurements of **20 distinct cases**, not 40 independent tasks or randomized trials.

Aggregates over both repeats (40 observations per path per catalog):

| Catalog / path | Correct first tool | Discovery calls | Mean total time | Mean received discovery tokens |
| --- | ---: | ---: | ---: | ---: |
| A before | 60.0% | 1.35 | 3.14 s | 5,884 |
| A default, no model | 75.0% | 1.15 | 2.57 s | 1,280 |
| A conditional fast | 92.5% | 1.00 | 2.81 s | 1,018 |
| B before | 75.0% | 1.75 | 3.38 s | 6,351 |
| B default, no model | 85.0% | 1.25 | 2.58 s | 1,253 |
| B conditional fast | 97.5% | 1.10 | 2.75 s | 660 |

Repeat-level results expose the variance rather than selecting the better run:

| Catalog / path | Correct, repeat 1 / 2 | Calls, repeat 1 / 2 | Seconds, repeat 1 / 2 | Tokens, repeat 1 / 2 |
| --- | ---: | ---: | ---: | ---: |
| A before | 60% / 60% | 1.35 / 1.35 | 3.03 / 3.26 | 5,649 / 6,118 |
| A default | 80% / 70% | 1.10 / 1.20 | 2.60 / 2.53 | 1,046 / 1,515 |
| A conditional fast | 90% / 95% | 1.00 / 1.00 | 2.95 / 2.68 | 791 / 1,246 |
| B before | 75% / 75% | 2.20 / 1.30 | 3.86 / 2.91 | 5,723 / 6,978 |
| B default | 85% / 85% | 1.15 / 1.35 | 2.68 / 2.49 | 1,180 / 1,326 |
| B conditional fast | 100% / 95% | 1.05 / 1.15 | 2.79 / 2.70 | 629 / 690 |

Both new paths are faster than their corresponding old baseline in each repeat. Calls improve in aggregate; **B's no-model repeat 2 takes one extra discovery call across 20 cases** (1.35 vs 1.30), while still finishing faster. The smallest observed conditional-fast margin is only 85 ms on A repeat 1, so do not promise a durable latency advantage from this sample.

The conditional-fast route is `openai/gpt-oss-120b:nitro`, low reasoning, via the normal OpenRouter route. Repeat 2 captured actual provider/cost receipts: all 10 A and 13 B selector calls used Cerebras. This is observed routing, not a runtime provider pin. Selector cost averaged $0.001272 / $0.000703 per task, or $0.002543 / $0.001081 per actual selector call. Main-agent plus selector cost averaged **$0.003341 / $0.002596 per task**, against $0.005868 / $0.006536 before. No-model repeat-2 main-agent costs were $0.002455 / $0.002446. Repeat 1 did not record actual selector costs/providers; no total-cost claim is made for it.

### Rejected initial compact-only design

The original draft forced exact-name loading without a selector and used the selector on every non-exact query. It made A slower and was revised, not recommended. Retained measurements:

| Catalog / path | Correct first tool | Discovery calls | Mean total time | Mean received discovery tokens |
| --- | ---: | ---: | ---: | ---: |
| A before | 60% | 1.35 | 3.03 s | 5,649 |
| A compact-only, no model | 90% | 2.00 | 3.93 s | 1,393 |
| A nano | 90% | 1.15 | 4.27 s | 1,331 |
| A fast GPT-OSS-120B `:nitro`, low | 75% | 1.00 | 3.54 s | 698 |
| B before | 75% | 2.20 | 3.86 s | 5,723 |
| B compact-only, no model | 95% | 2.00 | 3.81 s | 1,010 |
| B nano | 90% | 1.05 | 3.59 s | 864 |
| B fast GPT-OSS-120B `:nitro`, low | 90% | 1.10 | 3.16 s | 751 |

Neither the initial nor revised measurements support "always faster" or "never returns unnecessary tools." The compact-only agent can be a stronger final selector than best-match-first, but pays another round trip. That rejected accuracy/latency tradeoff remains visible here. Initial task-run main-agent costs excluded selector charges.

A separate observational baseline reported 2.20 discovery calls before the first domain tool over 44 human-driven turns. Most surrounding traffic was QA/simulation, not representative customer use. That figure is context only; it is not causally comparable to these paired simulations, and its coincidence with the B scripted baseline is not validation.

## Directory and cache behavior

The default group page has 20 entries. A has 61 groups in four pages, 1,263 tokens for the first page and 3,636 for all pages. B has 96 groups in five pages, 991 tokens for the first and 4,292 overall. No directory or schemas are paid for until requested. The directory cannot widen authorization; display-key collisions can only combine tools already in the same authorized pool.

This supersedes #2650's request-local directory insertion. Rebuilding a directory before existing conversation history changes earlier text when preparation finishes or the catalog changes, even when unchanged directories reuse object identity. An ordinary tool result is the cache-stable place for it.

New search receipts freeze selection once. Replaying completed results never calls the decision model or consults today's catalog. Legacy full-schema search markers and native interrupted calls remain replayable. Compact hits do not count as schema disclosure. Native routes still declare hosted client search and load real functions through `tool_search_output`; generic routes use ordinary search/list/invoke and appended declarations. There is **no native-to-generic protocol migration**. Existing native history is replayed unchanged, and a tool loaded by an old search can be called on the next turn without another search. Real SDK tests cover both native routes, including normal approval checks; serialization tests inspect the actual Responses request body, retain hosted search, keep old output schemas and verify prefix equality. They are not live endpoint acceptance tests.

**The static prompt and control-schema changes invalidate the old cached prefix once per existing session at upgrade.** This PR does not promise zero cache misses on deployment. After upgrade, no result/catalog changes earlier items or grows the top-level block. Native search remains declared, so the rejected draft's risk of replaying native history with the hosted tool removed no longer applies. No live native-tool-search compatibility matrix was run. The October21 Codex probe checked Decisions entitlement and ordinary Responses only, not native tool-search replay. A production GPT check after an approved deployment remains useful; no rollout is included here.

## Failure behavior and remaining risks

- Unconfigured, failed or invalid selection uses best-match-first lexical disclosure, with compact alternatives on generic routes, without dumping raw provider errors. Exact ties/no-resource queries load nothing; native routes can browse compact alternatives through `tool_list`. Revoked selections disclose no schema. Exact names still work during an outage. Cancellation propagates. Existing schema budgets still apply; a selected schema can be too large to disclose.
- Selection is probabilistic and can omit a needed tool or include an unwanted one. The first 40 lexical candidates are a recall constraint. A selector cannot rescue a missing candidate.
- Tool descriptions and query text are untrusted classification data. Only exact candidate IDs can resolve, and selection never grants authorization or executes tools. This is not a claim of prompt-injection immunity.
- Existing original SDK tool objects, validation and approvals remain authoritative. A valid invocation is rewritten before normal dispatch; it is not executed inside a router tool.
- Usage is recorded through the shared deployment decision provider and `tool_discovery.*` / `code_search.decision_*` events. HTTP adapters retain received usage before rejecting malformed answers; direct Jev uses the existing client estimate and can fail before an aggregate receipt exists. Unknown failed-call cost is not zero. The worker never borrows a customer-owned key/subscription. **These events do not debit customer credits.** `recordUsageEvent` writes telemetry; customer model charges require explicit `settleModelUsage` / `applyCreditDebitUpToBalance`, which these consumers never call. The debit trigger in migration `0552_usage_allowances.sql` applies only to knowledge-query embedding events; host export is telemetry. External hosts may apply their own policy. Code-search telemetry names change from `jev` to `decision`; external dashboards need updates.
- The paid selector is opt-in, and each transport's static model-facing descriptions are identical with or without it. The changed descriptions/list schema, optional config field and frozen-selection receipts are model-facing changes and require review before merge.

## Reproduce

Install with `bun install --frozen-lockfile`. Export a real authorized catalog as an array or `{tools:[...]}`, with `name`, `description`, `inputSchema` (or `parameters`) and optional `identity.serverId`. Keep raw files and results private. A different catalog can legitimately lack public-fixture targets; the offline script reports skipped cases rather than counting them as misses.

```sh
bun scripts/tool-discovery-eval.ts --catalog catalog.json --queries queries.json > ranking.json

# Current typed endpoints: set DECISION_MODEL_API_KEY in the environment.
bun scripts/tool-discovery-decision-eval.ts --catalog catalog.json --queries queries.json \
  --backend openrouter --model typesafe/jev-1.13 --candidates 40 --warmup --out jev-typed.json
bun scripts/tool-discovery-decision-eval.ts --catalog catalog.json --queries queries.json \
  --backend openrouter --model openai/gpt-6-luna-decisions --candidates 40 --warmup --out luna-typed.json
bun scripts/tool-discovery-eval.ts --catalog catalog.json --queries queries.json \
  --decision-results jev-typed.json > jev-runtime.json
# Main agent uses DECISION_MODEL_BASE_URL=https://openrouter.ai/api/v1;
# typed decisions use their own endpoint, never that chat-completions base.
bun scripts/tool-discovery-agent-eval.ts --catalog catalog.json --queries queries.json \
  --out jev-trajectories.json --model openai/gpt-6-luna --decision-backend openrouter \
  --decision-model typesafe/jev-1.13 --warmup --implementation YOUR_REVISION

# Direct TypeSafe: existing Jev client, OPENGENI_JEV_API_KEY in the environment.
# Optional OPENGENI_JEV_BASE_URL; use an explicit model ID for reproducibility.
bun scripts/tool-discovery-decision-eval.ts --catalog catalog.json --queries queries.json \
  --backend jev --model jev-latest --candidates 40 --out jev-decision.json
bun scripts/tool-discovery-eval.ts --catalog catalog.json --queries queries.json \
  --decision-results jev-decision.json > jev-direct-runtime.json
# Live generic trajectories: DECISION_MODEL_API_KEY / DECISION_MODEL_BASE_URL
# are for the main agent; the selector uses its separate OPENGENI_JEV_* settings.
bun scripts/tool-discovery-agent-eval.ts --catalog catalog.json --queries queries.json \
  --out jev-direct-trajectories.json --model YOUR_AGENT_MODEL --decision-backend jev \
  --decision-model jev-latest --implementation YOUR_REVISION

# Comparison only: explicitly configured OpenAI-compatible selector account.
# Set DECISION_MODEL_API_KEY and DECISION_MODEL_BASE_URL in your environment.
bun scripts/tool-discovery-decision-eval.ts --catalog catalog.json --queries queries.json \
  --backend openai-compatible --out decision.json --model YOUR_MODEL --candidates 40 --reasoning none
# OpenRouter-only optional routing experiment: --provider cerebras/fp16 --reasoning low
# Replay those selections through the actual conditional runtime, including bypass:
bun scripts/tool-discovery-eval.ts --catalog catalog.json --queries queries.json \
  --decision-results decision.json > runtime.json

bun scripts/tool-discovery-agent-eval.ts --catalog catalog.json --queries queries.json \
  --out trajectories.json --model YOUR_AGENT_MODEL --decision-model YOUR_DECISION_MODEL \
  --decision-backend openai-compatible --decision-reasoning none --implementation YOUR_REVISION
# --decision-model none evaluates best-match-first + compact alternatives.
# --reuse-baseline prior.json requires the same main model, case IDs and query text.

# Optional separate, pinned Transformers.js installation; no app dependency.
# Set TOOL_DISCOVERY_EMBEDDING_MODULE to its transformers.js module path.
bun scripts/tool-discovery-embedding-eval.ts --catalog catalog.json --queries queries.json \
  --out embedding.json --cache /path/to/model-cache

# No-network adapter/CLI verification and eval-specific typecheck:
bun test scripts/tool-discovery-eval/jev-decision.test.ts
bunx --no-install tsc -p scripts/tool-discovery-eval/tsconfig.json
```

The decision script validates catalog/query hashes, backend, endpoint and request
metadata before resuming. The trajectory script also validates its experiment and
supports explicitly reusing matching baseline cases. Shared predicate protocol and
direct-Jev estimate-rate metadata are recorded; old chat results are not relabeled
as typed decisions. Use new output paths after a protocol change. Record actual
model/provider and cost source; do not combine estimates and charges silently.
Direct OpenAI uses `--backend openai --model gpt-6-luna` with its own Platform key.
API-backed scripts spend on supplied accounts but execute no domain tools.

`--warmup` makes one small readiness judgment before measured typed selections;
trajectory runs also make one main-agent readiness request. Neither warmup uses a
scored query or preloads its candidate prefix. Warmup receipts/timings are retained
separately in `warmups`, excluded from measured rows but included when reporting
total experimental spend. A completed output resumes without any warmup or paid
call; a partially completed run records new warmups when it resumes in a new
process. Use separate output files for each repeat, retain all cases, and compare
both repeat-level and pooled latency rather than picking the faster repeat.

## Research

- [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search): deferred loading and namespaces; preserve stable prefixes instead of resending the whole catalog.
- [Codex's tool-search implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search.rs): a lexical search baseline, not evidence that flat lexical ranking is sufficient for every catalog.
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool): BM25/regex or custom selection returning references. Provider-native deferred-reference requirements differ; the portable path here uses the existing invocation machinery.
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) and [OpenRouter typed Decisions contract](https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README.md): distinct typed APIs, not prose calls on fast chat models.
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) and [Cerebras GPT-OSS-120B](https://inference-docs.cerebras.ai/models/openai-oss): explicit fast-provider experiment, not a hard-coded application dependency.
