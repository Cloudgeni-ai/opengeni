# Tool discovery evaluation

## Decision

Improve the existing search/list/invoke path, not a second discovery API:

- Field-aware lexical retrieval separates names and capability sentences from long operational guidance. It indexes the exact authorized deferred pool.
- Ordinary search loads the strongest match per explicit query clause and returns compact alternatives. No-match, operation-only and exact-tie queries stay compact. Known exact names bypass ranking and inference. This avoids making every no-model search pay for a second load call.
- An explicitly configured **decision model** handles ambiguous searches from the first 40 candidates. Strong lexical matches skip inference. The bypass requires resource coverage of at least 0.5 and a score at least 1.25 times the runner-up for every explicit clause. These are transparent heuristics, **not calibrated confidence probabilities**; the no-model default does not pretend its best-ranked choice is certain.
- `tool_list({view:"groups"})` is an on-demand directory; pass a returned `group` to browse it. Opaque connections stay together under compact display keys with a representative tool, rather than exposing long identity hashes or hundreds of tiny groups.
- Schemas are not shortened or inferred. Selected definitions are frozen on the search call and disclosed after its result. They never enter a changing earlier prompt or top-level tools block.
- There is no default paid model, embedding index, extra credential, new inference timeout or concurrency quota. Unconfigured/unavailable selection uses the same best-match-first lexical path. Only selected schemas are loaded; alternatives remain compact.

**Recommendation:** ship best-match-first without a paid model as the default. It was faster than the old path on both task sets in both repeats. For deployments prioritizing accuracy, the measured conditional GPT-OSS-120B low / fast route also beat the old path on both sets in both repeats and improved accuracy further. Keep it explicitly configured: this is not permission to route every deployment to that account/provider. It is slower than the new no-model default, and small repeated development samples do not guarantee a production latency win.

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

## Retrieval results

Each cell is top-1 / top-3 over 60 queries. First, the actual current runtime paths:

| Runtime path | A: 605 deferred tools | B: 1,079 tools |
| --- | ---: | ---: |
| Before | 60.0% / 76.7% | 51.7% / 70.0% |
| Default: best lexical match + compact alternatives | 78.3% / 88.3% | 66.7% / 83.3% |
| Conditional fast selection + lexical bypass | 88.3% / 95.0% | 95.0% / 98.3% |

The conditional row replays the captured pinned-Cerebras selections through the real runtime, including strong-match bypass and schema budgets. It is not a fresh provider call or a latency measurement. Some lexical bypasses are wrong: conditional selection on A has lower top-1 than asking the selector on every query. It is a deliberate speed/accuracy tradeoff, not hidden by reporting only pure-selector results.

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

The final decision request uses candidate integer IDs, smallest-set instructions, and catalog-before-query messages. Exact ID validation rejects malformed/duplicate/out-of-range IDs. The full-catalog arm costs more and does not improve accuracy. The tested hybrid helps top-3, especially on B, but does not justify shipping an embedding runtime/index for this improvement. This does not rule out other embedding models or rerankers.

Exploratory trials are not substituted for final numbers: an early name-output trial produced invalid names; an earlier GPT-5.4 nano prompt scored 95.0/98.3% on A; an earlier Haiku trial on B returned many unnecessary tools (6.93 off-label tools/search). Those trials used different prompts/output formats. The table reports the final prompt, not the best observed run.

Original-label B sensitivity (top-1/top-3): baseline 46.7/68.3%, lexical 60.0/78.3%, dense 45.0/73.3%, hybrid 61.7/88.3%, final nano 90.0/90.0%, Cerebras 93.3/95.0%, whole-catalog nano 83.3/88.3%.

## Payload, selection latency and cost

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

Costs are the provider's reported request cost, not advertised starting prices. The Cerebras experiment explicitly pinned `cerebras/fp16` with provider fallback disabled; all 120 responses identify Cerebras. The ordinary runtime does not add a provider-pinning API. Configure an admitted provider/model through the existing registry. The `:nitro` trajectory experiment below uses ordinary provider routing and must not be presented as a pinned-Cerebras measurement.

Lexical retrieval p95 was about 6 ms. The optional embedding probe used Transformers.js 4.3.1 and `Xenova/bge-small-en-v1.5` q8, normalized CLS vectors, the model's query prefix, and RRF k=10. Index construction took 23.1 / 14.1 seconds; mean query embedding/ranking took 16 / 59 ms. The two probes ran concurrently, so those CPU timings are exploratory, not comparative capacity results. No embedding package is a production dependency.

## Live discovery trajectories

GPT-5.4 mini ran every third frozen query: 20 cases per catalog. It could search/list/load and request the first domain tool, but the harness intercepted that call **before execution**, with empty task arguments. These are live discovery-only simulations, not completed user tasks or production rollout results. Time includes main-agent and selector network/inference time through the first requested domain call. Calls count discovery operations before that call. Repeating an identical discovery request ends a stalled case rather than an unbounded loop.

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

New search receipts freeze selected definitions once. Replaying them never calls the decision model or consults today's catalog. Legacy full-schema search markers and native interrupted calls remain replayable. Compact hits do not count as schema disclosure. Every transport now advertises stable ordinary search/list/invoke controls. The verified Codex route can project `additional_tools`; other Responses routes and Chat/Claude use existing text declarations plus `tool_invoke`. Unit/SDK tests cover all three transport modes and provider projections; this work does **not** claim a live provider matrix or live cache-hit measurement. Static instruction/control-schema changes at upgrade still establish a new prefix; no runtime result modifies an earlier item.

## Failure behavior and remaining risks

- Unconfigured, failed or invalid selection uses best-match-first lexical disclosure and compact alternatives, without dumping raw provider errors. Exact ties/no-resource queries remain compact. Revoked selections disclose no schema. Exact names still work during an outage. Cancellation propagates. Existing schema budgets still apply; a selected schema can be too large to disclose.
- Selection is probabilistic and can omit a needed tool or include an unwanted one. The first 40 lexical candidates are a recall constraint. A selector cannot rescue a missing candidate.
- Tool descriptions and query text are untrusted classification data. Only exact candidate IDs can resolve, and selection never grants authorization or executes tools. This is not a claim of prompt-injection immunity.
- Existing original SDK tool objects, validation and approvals remain authoritative. A valid invocation is rewritten before normal dispatch; it is not executed inside a router tool.
- Usage is recorded through the ordinary deployment provider and `tool_discovery.*` events, including malformed responses. The worker refuses to silently borrow a customer-owned key/subscription. **These events do not debit customer credits.** `recordUsageEvent` in `packages/db/src/index.ts` writes telemetry; customer model charges require the explicit `settleModelUsage` / `applyCreditDebitUpToBalance` path in `packages/core/src/billing/model-usage-settlement.ts`, which discovery never calls. The usage-event debit trigger in migration `0552_usage_allowances.sql` applies only to `knowledge_query` / `document.query_embedding_cost`; the host export trigger exports telemetry, not a debit. External hosts can apply their own policy. Accounting persistence, cancellation and interrupted-run recovery deserve normal release scrutiny.
- The paid selector is opt-in, and static model-facing descriptions are identical with or without it. The new ordinary controls, optional config field and frozen-history version are model-facing changes and require review before merge.

## Reproduce

Install with `bun install --frozen-lockfile`. Export a real authorized catalog as an array or `{tools:[...]}`, with `name`, `description`, `inputSchema` (or `parameters`) and optional `identity.serverId`. Keep raw files and results private. A different catalog can legitimately lack public-fixture targets; the offline script reports skipped cases rather than counting them as misses.

```sh
bun scripts/tool-discovery-eval.ts --catalog catalog.json --queries queries.json > ranking.json

# Explicitly configured OpenAI-compatible account; no default key or endpoint.
# Set DECISION_MODEL_API_KEY and DECISION_MODEL_BASE_URL in your environment.
bun scripts/tool-discovery-decision-eval.ts --catalog catalog.json --queries queries.json \
  --out decision.json --model YOUR_MODEL --candidates 40 --reasoning none
# OpenRouter-only optional routing experiment: --provider cerebras/fp16 --reasoning low
# Replay those selections through the actual conditional runtime, including bypass:
bun scripts/tool-discovery-eval.ts --catalog catalog.json --queries queries.json \
  --decision-results decision.json > runtime.json

bun scripts/tool-discovery-agent-eval.ts --catalog catalog.json --queries queries.json \
  --out trajectories.json --model YOUR_AGENT_MODEL --decision-model YOUR_DECISION_MODEL \
  --decision-reasoning none --implementation YOUR_REVISION
# --decision-model none evaluates best-match-first + compact alternatives.
# --reuse-baseline prior.json requires the same main model, case IDs and query text.

# Optional separate, pinned Transformers.js installation; no app dependency.
# Set TOOL_DISCOVERY_EMBEDDING_MODULE to its transformers.js module path.
bun scripts/tool-discovery-embedding-eval.ts --catalog catalog.json --queries queries.json \
  --out embedding.json --cache /path/to/model-cache
```

The decision script validates catalog/query hashes and model/request metadata before resuming an output. The trajectory script validates the same experiment metadata and supports explicitly reusing baseline cases. Record provider, version, reasoning and actual cost; do not compare altered prompts as if they were the same arm. API-backed scripts spend on the account explicitly supplied; they execute no domain tools.

## Research

- [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search): deferred loading and namespaces; preserve stable prefixes instead of resending the whole catalog.
- [Codex's tool-search implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search.rs): a lexical search baseline, not evidence that flat lexical ranking is sufficient for every catalog.
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool): BM25/regex or custom selection returning references. Provider-native deferred-reference requirements differ; the portable path here uses the existing invocation machinery.
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) and [Cerebras GPT-OSS-120B](https://inference-docs.cerebras.ai/models/openai-oss): explicit fast-provider experiment, not a hard-coded application dependency.
