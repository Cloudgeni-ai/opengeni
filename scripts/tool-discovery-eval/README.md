# Tool search evaluation harness

This harness measures how well tool search finds the right tool in a real catalog.
It replays a deployment's own authorized tool catalog against labelled scenarios and
compares search strategies side by side: the runtime's actual `tool_search` on each
route, with and without a decision model, and experimental retrieval stages.

It answers four questions for every strategy:

- **First pick right:** is the first tool the agent receives an acceptable one?
- **Loaded or shown:** does the agent receive, or see by name, an acceptable tool, so it
  needs at most one more call?
- **Recall at K:** for ranking stages, is an acceptable tool within the top K candidates?
- **Cost and delay:** latency (mean, p95, p99) and model cost per search.

Every search also keeps a full trace: the candidates each stage produced, the decision
model's per-candidate judgments, what was loaded, what was shown, and the exact text the
agent would receive. Nothing is summarised away, so a miss can be read and explained.

## Run it

```sh
bun scripts/tool-discovery-eval/run.ts \
  --catalog catalog.jsonl \
  --scenarios scenarios.jsonl \
  --out results/2026-10-29-baseline \
  --strategies runtime-generic,runtime-codex,keywords
```

Without `--scenarios` it runs the public fixture in
`scripts/fixtures/tool-discovery-queries.json` (60 intent-labelled searches over Opengeni's
own tools and common integrations).

The output directory gets `report.md` (summary tables, per-tag slices with 95% confidence
intervals, and every search that went wrong with its trace) and `results.json` (all
records and traces, for your own analysis).

Options:

| Option | Meaning |
| --- | --- |
| `--strategies a,b` | Strategies to compare (below). Default `runtime-generic,runtime-native,keywords`. |
| `--decision-models a,b` | Run the selector strategies once per decision model on the same endpoint. |
| `--k 10,40` | Candidate counts for the ranking stages and two-stage strategies. |
| `--repeat N` | Replay each scenario N times, to see run-to-run variation of model strategies. |
| `--concurrency N` | Scenarios searched in parallel (default 4). Queries inside a scenario stay in order. |
| `--budget-usd X` | Stop before new paid calls would exceed X dollars (default 2). |
| `--cache-dir`, `--no-cache` | Successful model responses are cached by exact request; a rerun replays them, including their recorded latency, at no cost. |
| `--skip-problems` | Run even when some scenarios reference tools missing from the catalog. |
| `--with-task` | Give strategies that can use it the user's request as well as the query. |
| `--selection-policy key=value,…` | Override the runtime's selection policy for this run, for example `candidates=25`. |

## Catalog

The catalog is the exact tool set the agent could search, as JSON, `{ tools: [...] }` or
JSON Lines. Each entry is either:

- an MCP tool as its server publishes it: `{ server, tool, description, inputSchema }`.
  The model-facing name is derived exactly as the runtime derives it; or
- a tool already under its model-facing name:
  `{ name, description, parameters, identity?: { serverId, toolName } }`, such as the
  entries of a turn's tool catalog.

Mark tools sent on every request (never searched) with `eager: true`. The runtime decides
which tools are searchable; the harness asks it rather than keeping its own copy of that rule.

Catalogs from a real deployment can contain private tool names and descriptions. Keep
them, their scenarios and their results outside the repository.

## Scenarios

A JSON array or JSON Lines of:

```json
{
  "id": "meetings-tomorrow",
  "task": "Which meetings do I have tomorrow?",
  "queries": ["calendar events for tomorrow"],
  "acceptable": ["google_calendar.list_events"],
  "tags": ["split:holdout"],
  "source": "logged search, labelled from the task",
  "notes": "outlook_calendar.list_events also fits when that account is connected"
}
```

- `queries` are the searches an agent made (or would make) for the task, in order. They
  are one turn: later searches see what earlier ones loaded or showed.
- `acceptable` lists every tool that would do the job, in any form the catalog resolves:
  model name, `server.tool`, the published name or its underscore form.
- A task that no tool can do has an empty `acceptable` list and the tag `no-fit`; it is
  right when search loads nothing.
- `tags` give per-slice tables in the report. Useful ones: the query's language
  (`lang:en`, `lang:no`), `multi-need` (one query, several tools), `name-guess` (the agent
  guesses a tool name), `no-fit`, and `split:dev` / `split:holdout`.

Label from the task, not from what search found. A label of "the tool the agent ended up
using" rewards strategies that find what search already finds. Have the labeller see the
whole catalog, and record every acceptable tool. Freeze a held-out split before tuning
anything and report it separately; tuning on the scenarios you measure inflates every
number. When tool descriptions change, the right answers can change too, so keep the
catalog hash from the report next to the labels.

## Strategies

| Strategy | What it runs |
| --- | --- |
| `runtime-generic` | The runtime's `tool_search` on the generic route (search, list, invoke), keywords only. |
| `runtime-native` | The same on the native OpenAI route (hosted tool search, native function loading). |
| `runtime-codex` | The same on the Codex route. |
| `runtime-selector` | The generic route with a decision model selecting from the candidates, as a deployment configures it. One strategy per `--decision-models` entry. |
| `runtime-selector-codex` | The same on the Codex route. |
| `runtime-meaning-*` | Any `runtime-*` strategy above with the runtime's meaning ranking over the `TOOL_EVAL_EMBEDDING_*` model, as a deployment with a document embedding model gets it (for example `runtime-meaning-codex`, `runtime-meaning-selector-codex`). The catalog's vectors are computed once before the run, as a long-running worker keeps them. |
| `keywords` | The runtime's keyword ranking alone, for recall at K. |
| `card-keywords` | Keyword ranking over task cards (`--cards`). Experimental. |
| `embeddings` | Embedding similarity over descriptions (and cards if given). Experimental. |
| `fused` | Reciprocal rank fusion of the available rankers. Experimental. |
| `two-stage`, `two-stage-keywords` | A chat model choosing from the top K of `fused` or `keywords`. Experimental. |
| `whole-catalog` | A chat model choosing from the entire catalog. Experimental. |

The `runtime-*` strategies call the real runtime code, so they measure what agents get.
The experimental strategies exist to test whether a new stage would help before building it.

## Models

All settings are environment variables; nothing is configured by default and no model is
called unless a strategy needs it.

Decision model for `runtime-selector*`, the typed Decisions contract the runtime uses:

| Variable | Meaning |
| --- | --- |
| `TOOL_EVAL_DECISION_PROVIDER` | `openai` (OpenAI or an Azure OpenAI v1 resource) or `openrouter`. |
| `TOOL_EVAL_DECISION_MODEL` | Model, or the deployment name on Azure. |
| `TOOL_EVAL_DECISION_ENDPOINT` | Full Decisions endpoint, when not the provider's default. On Azure: `https://<resource>.openai.azure.com/openai/v1/decisions`. |
| `TOOL_EVAL_DECISION_API_KEY` or `_API_KEY_FILE` | Bearer credential. On Azure this can be an Entra access token for `https://cognitiveservices.azure.com`. |
| `TOOL_EVAL_DECISION_USD_PER_MILLION` | Input price, for the cost columns. |

Rate-limited calls (HTTP 429) are retried after the provider's `retry-after`, and the
wait is subtracted from the reported latency. The runtime's own selector deadline
still runs during the wait, so a heavily throttled run shows up in the **Fallbacks**
column; rerun it with a lower `--concurrency` rather than reading those searches as
the selector's choices. Give the eval its own deployment or quota rather than sharing
one that serves production traffic: a selector call with 40 candidates is roughly 10
to 16 thousand input tokens.

Chat models for the experimental `two-stage`, `whole-catalog` and card writing use
`TOOL_EVAL_SELECTOR_*`, `TOOL_EVAL_CARDS_*` (`BASE_URL`, `API_KEY`, `MODEL`,
`USD_PER_MILLION` as `input,cached,output`, optional `AUTH=api-key`). Embeddings use
`TOOL_EVAL_EMBEDDING_*` with the same fields and optional `DIMENSIONS`.

## Earlier findings

October 2026, two catalogs of roughly 760 and 1,100 tools:

- Keyword ranking already had an acceptable tool in its top 40 for about 97 to 99% of
  intent-labelled searches. Most misses happened after ranking: no decision model
  configured, a route that showed the agent one tool and hid the rest, a selector that
  returned nothing when unsure, and tool names written as `server.tool` that did not
  resolve.
- With typed decision models choosing from those 40, first-pick accuracy reached about 95
  to 98%. Small models mostly failed by selecting nothing; loading the highest-probability
  candidate instead would have fixed most of those misses.
- Agents search with the words of their task, not the words of a tool's description. The
  selector therefore needs each candidate's full description (where routing guidance
  such as "for X, use Y instead" usually lives), not only its first sentence.

The scripts that produced these numbers were replaced by this harness.
