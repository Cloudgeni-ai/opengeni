# Tool discovery evaluation

## Decision

Improve the existing search/list/invoke path, not a second discovery API:

- Field-aware lexical retrieval separates names and capability sentences from long operational guidance. It indexes the exact authorized deferred pool.
- Ordinary search returns compact candidates. An explicitly configured **decision model** can select a small set from the first 40 candidates and load those schemas in the same call. Known exact names bypass inference.
- `tool_list({view:"groups"})` is an on-demand directory; pass a returned `group` to browse it. Opaque connections stay together under compact display keys with a representative tool, rather than exposing long identity hashes or hundreds of tiny groups.
- Schemas are not shortened or inferred. Selected definitions are frozen on the search call and disclosed after its result. They never enter a changing earlier prompt or top-level tools block.
- There is no default paid model, embedding index, extra credential, new inference timeout or concurrency quota. Unconfigured/unavailable selection returns compact lexical candidates plus exact-name loading.

The decision model gives the strongest retrieval results here, but is **not a universal latency win**. Keep the model configurable. The fast-provider result is promising, not permission to route every deployment to that provider. The unconfigured fallback is cheaper in result tokens but can require an extra agent round trip.

## Dataset and method (October 20, 2026)

Two real catalogs, without replicated padding:

| Catalog | Raw tools | Deferred tools evaluated | Queries |
| --- | ---: | ---: | --- |
| A: general agent harness and integrations | 617 | 605 | 24 actual history queries + 36 realistic synthetic queries |
| B: application catalog | 1,079 | 1,079 | 50 actual history queries + 10 realistic synthetic queries |

Both arms use the same authorized-pool classification. Catalog B is a full application registry; real sessions can receive module- and permission-filtered subsets. Its queries were curated from 1,024 historical discovery calls. The next observed domain tool is **not** automatically ground truth: it can be a prerequisite or an unrelated later action. The public fixture contains catalog A's 60 queries. Raw catalogs, private queries, transcripts and provider responses are deliberately not committed.

Queries were frozen before scoring each catalog. A later label audit corrected seven catalog B expected sets: six omitted valid alternatives/explicitly requested capabilities and one labeled a prerequisite instead of the requested tool. The same evaluator performed this post-hoc adjudication, not an independent reviewer. Every arm is rescored with the corrected sets; original-label sensitivity appears below. This is a small development evaluation, **not a held-out generalization claim**.

`legacy-ranking.ts` freezes BM25, exact-name promotion, disclosure budgets and interaction-family expansion from baseline `cbb55f394`. Top-1/top-3 mean that an acceptable expected identity is first/among the first three. They do not prove all parts of a multi-action request are satisfied. Off-label counts are relative to the curated expected sets, not a universal judgment that every extra tool is useless. Lexical off-label hits are unloaded suggestions; decision-model extras become loaded schemas.

Token counts use `gpt-tokenizer@4.1.0`, `o200k_base` BPE of serialized JSON. They are comparable payload sizes, not provider-billed tokens. Full selected payload counts include the compact receipt **and** selected schema JSON, excluding provider declaration wrappers. Latencies are single-run wall-clock observations, not isolated throughput benchmarks or confidence intervals. Models and providers are nondeterministic.

## Retrieval results

Each cell is top-1 / top-3 over 60 queries.

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
| Lexical compact candidates only | 381 | 275 | 6.83 / 6.87 |
| Nano receipt + selected schemas | 1,451 | 892 | 0.13 / 0.25 |
| Cerebras receipt + selected schemas | 1,087 | 798 | 0.02 / 0.05 |

Before p95 payloads are 18,098 / 23,287 tokens; lexical compact p95 is 454 / 330. Nano full selected p95 is 8,478 / 3,207; Cerebras is 6,290 / 2,975. A genuinely needed large schema remains large. The tiny receipt alone (about 52–67 tokens for these decision arms) is **not** the total context cost.

| Decision route | A mean / p95 | B mean / p95 | A / B USD per search |
| --- | ---: | ---: | ---: |
| GPT-5.4 nano, OpenRouter | 1,119 / 1,449 ms | 1,134 / 1,586 ms | $0.001340 / $0.000536 |
| GPT-OSS-120B low, OpenRouter pinned to Cerebras | 661 / 1,215 ms | 556 / 931 ms | $0.002522 / $0.001069 |
| Nano, whole compact catalog | 1,389 / 1,949 ms | 1,128 / 1,631 ms | $0.002104 / $0.001874 |

Costs are the provider's reported request cost, not advertised starting prices. The Cerebras experiment explicitly pinned `cerebras/fp16` with provider fallback disabled; all 120 responses identify Cerebras. The ordinary runtime does not add a provider-pinning API. Configure an admitted provider/model through the existing registry. The `:nitro` trajectory experiment below uses ordinary provider routing and must not be presented as a pinned-Cerebras measurement.

Lexical retrieval p95 was about 6 ms. The optional embedding probe used Transformers.js 4.3.1 and `Xenova/bge-small-en-v1.5` q8, normalized CLS vectors, the model's query prefix, and RRF k=10. Index construction took 23.1 / 14.1 seconds; mean query embedding/ranking took 16 / 59 ms. The two probes ran concurrently, so those CPU timings are exploratory, not comparative capacity results. No embedding package is a production dependency.

## Live discovery trajectories

GPT-5.4 mini ran every third frozen query: 20 cases per catalog. It could search/list/load and request the first domain tool, but the harness intercepted that call **before execution**, with empty task arguments. These are live discovery-only simulations, not completed user tasks or production rollout results. Time includes main-agent and selector network/inference time through the first requested domain call. Calls count discovery operations before that call. Repeating an identical discovery request ends a stalled case rather than an unbounded loop.

The same baseline trajectories are reused across after arms. Runs were sequential per arm and arms ran concurrently, not randomized repeated trials. The final exact-name recovery implementation was used for after arms; group-only presentation changes do not affect these search-only traces.

| Catalog / path | Correct first tool | Discovery calls | Mean total time | Mean received discovery tokens |
| --- | ---: | ---: | ---: | ---: |
| A before | 60% | 1.35 | 3.03 s | 5,649 |
| A lexical-only | 90% | 2.00 | 3.93 s | 1,393 |
| A nano | 90% | 1.15 | 4.27 s | 1,331 |
| A fast GPT-OSS-120B `:nitro`, low | 75% | 1.00 | 3.54 s | 698 |
| B before | 75% | 2.20 | 3.86 s | 5,723 |
| B lexical-only | 95% | 2.00 | 3.81 s | 1,010 |
| B nano | 90% | 1.05 | 3.59 s | 864 |
| B fast GPT-OSS-120B `:nitro`, low | 90% | 1.10 | 3.16 s | 751 |

These measurements do **not** support "always faster" or "never returns unnecessary tools." They show improved first-tool accuracy and much smaller payloads, with fewer calls when selection is configured. Lexical-only uses two discovery calls in this sample; the agent itself can be a stronger final selector than a small model. Provider/agent/query variation remains important. Task-run billed main-agent costs exclude selector charges; use the separate per-search costs above rather than claiming those are total task costs.

A separate observational baseline reported 2.20 discovery calls before the first domain tool over 44 human-driven turns. Most surrounding traffic was QA/simulation, not representative customer use. That figure is context only; it is not causally comparable to these paired simulations, and its coincidence with the B scripted baseline is not validation.

## Directory and cache behavior

The default group page has 20 entries. A has 61 groups in four pages, 1,263 tokens for the first page and 3,636 for all pages. B has 96 groups in five pages, 991 tokens for the first and 4,292 overall. No directory or schemas are paid for until requested. The directory cannot widen authorization; display-key collisions can only combine tools already in the same authorized pool.

This supersedes #2650's request-local directory insertion. Rebuilding a directory before existing conversation history changes earlier text when preparation finishes or the catalog changes, even when unchanged directories reuse object identity. An ordinary tool result is the cache-stable place for it.

New search receipts freeze selected definitions once. Replaying them never calls the decision model or consults today's catalog. Legacy full-schema search markers and native interrupted calls remain replayable. Compact hits do not count as schema disclosure. Every transport now advertises stable ordinary search/list/invoke controls. The verified Codex route can project `additional_tools`; other Responses routes and Chat/Claude use existing text declarations plus `tool_invoke`. Unit/SDK tests cover all three transport modes and provider projections; this work does **not** claim a live provider matrix or live cache-hit measurement. Static instruction/control-schema changes at upgrade still establish a new prefix; no runtime result modifies an earlier item.

## Failure behavior and remaining risks

- Unconfigured, failed or invalid selection falls back to compact candidates and exact-name loading, without dumping raw provider errors. Revoked selections disclose no schema. Exact names still work during an outage. Cancellation propagates. Existing schema budgets still apply; a selected schema can be too large to disclose.
- Selection is probabilistic and can omit a needed tool or include an unwanted one. The first 40 lexical candidates are a recall constraint. A selector cannot rescue a missing candidate.
- Tool descriptions and query text are untrusted classification data. Only exact candidate IDs can resolve, and selection never grants authorization or executes tools. This is not a claim of prompt-injection immunity.
- Existing original SDK tool objects, validation and approvals remain authoritative. A valid invocation is rewritten before normal dispatch; it is not executed inside a router tool.
- Usage is recorded through the ordinary deployment provider and `tool_discovery.*` events, including malformed responses. The worker refuses to silently bill a customer-owned key/subscription for internal inference. Accounting persistence, cancellation and interrupted-run recovery deserve normal release scrutiny.
- The paid selector is opt-in. Without configuring it, compact results can add a second agent turn. The new ordinary controls, optional config field and frozen-history version are model-facing changes and require review before merge.

## Reproduce

Install with `bun install --frozen-lockfile`. Export a real authorized catalog as an array or `{tools:[...]}`, with `name`, `description`, `inputSchema` (or `parameters`) and optional `identity.serverId`. Keep raw files and results private. A different catalog can legitimately lack public-fixture targets; the offline script reports skipped cases rather than counting them as misses.

```sh
bun scripts/tool-discovery-eval.ts --catalog catalog.json --queries queries.json > ranking.json

# Explicitly configured OpenAI-compatible account; no default key or endpoint.
# Set DECISION_MODEL_API_KEY and DECISION_MODEL_BASE_URL in your environment.
bun scripts/tool-discovery-decision-eval.ts --catalog catalog.json --queries queries.json \
  --out decision.json --model YOUR_MODEL --candidates 40 --reasoning none
# OpenRouter-only optional routing experiment: --provider cerebras/fp16 --reasoning low

bun scripts/tool-discovery-agent-eval.ts --catalog catalog.json --queries queries.json \
  --out trajectories.json --model YOUR_AGENT_MODEL --decision-model YOUR_DECISION_MODEL \
  --decision-reasoning none --implementation YOUR_REVISION
# --decision-model none evaluates compact lexical + exact-name loading.
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
