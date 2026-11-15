# Tool search evaluation harness

This harness measures how well tool search finds the right tool in a real catalog.
It replays a deployment's own authorized tool catalog against labelled scenarios and
compares search strategies side by side: the runtime's actual `tool_search` on each
route, with and without a decision model, and experimental retrieval stages.

It answers four questions for every strategy:

- **First pick right:** is the first tool the agent receives an acceptable one?
- **Loaded or shown:** does the agent receive, or see by name, an acceptable tool, so it
  needs at most one more call?
- **Needs loaded:** when one search asks for several things, what share of them got a
  tool loaded by that search (and, separately, loaded or shown by name)?
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
| `--limit N` | Pass `limit: N` to every search, as agents often do (a scenario's own `limit` wins). Default: the tool's default. |

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
- `needs` (optional) splits a search that asks for several things into what each need
  accepts, a list of lists: `[["deviations.create"], ["files.create_upload",
  "photos.create_upload"]]`. Their tools are acceptable too, and the report's **needs
  loaded** counts each need as met when the search loaded one of its tools. A search
  without `needs` is one need.
- A tool that an acceptable tool's own description names (the tool to call first, or
  to get an input from) is acceptable as well: loading it is not wrong, though no need
  requires it.
- `limit` (optional) is the `limit` the search passes.
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

## Synthetic fixtures

`fixtures/synthetic-catalog.ts` writes two public catalogs: a large one of about 1,350
tools (one product API with about 1,100 dotted tools plus twelve common integrations)
and a small one of 50 (mail, calendar and chat). `fixtures/synthetic-scenarios.ts`
writes their multi-need tasks: each task is searched as packed keywords, as one plain
clause per need, and as the user's own sentence, and each need also as a search of its
own. Tasks tagged `split:holdout` were written before any selection change was tuned.

```sh
bun scripts/tool-discovery-eval/fixtures/synthetic-catalog.ts --out /tmp/tool-fixtures
bun scripts/tool-discovery-eval/run.ts --catalog /tmp/tool-fixtures/large/catalog.json \
  --scenarios /tmp/tool-fixtures/large/scenarios.json --out /tmp/tool-results --limit 2 \
  --strategies runtime-meaning-selector
```

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

## Whole turns: discovery round trips

`turns.ts` measures what search changes cost an agent end to end: how many model
requests a fresh chat spends only on `tool_search` or `tool_list` before it acts, and
the wall time of the turn. Each scenario is one person message in a fresh chat. The
turn runs through the real Agents SDK runner, the runtime's progressive tool disclosure
on the chosen route and the real composed system prompt, against a real Responses
model. Calls to other tools get a fixed simulated success, so the result measures the
path to the right tools, not the tools themselves. The shell answers that no shell is
available and `skill_read` that no Skills are installed. The system prompt is the
composed prompt of the `all/docker` case in the runtime's agent-instruction parity
fixtures, so the harness imports those test fixtures.

```sh
TOOL_EVAL_AGENT_BASE_URL=https://<resource>.openai.azure.com/openai/v1 \
TOOL_EVAL_AGENT_API_KEY_FILE=/path/to/key TOOL_EVAL_AGENT_MODEL=<deployment> \
bun scripts/tool-discovery-eval/turns.ts --catalog catalog.json --out turns.json \
  --repeat 3 --concurrency 2 --max-turns 12
```

The default scenarios are in `fixtures/turn-scenarios.ts`: ten everyday requests
(notify me, schedule a check, start a worker and message it, remember a fact, Linear,
Sentry and Slack, an email draft, a saved login, Grafana alerts, recent chats). Each
lists the tools that meet it, by name without the server prefix; a catalog without
them cannot meet that need. The catalog is `ogtool list --full` output from a real
deployment; keep it outside the repository, since it can hold private tool names.

Per run it prints the model requests, how many were discovery-only, whether the needs
were met and the call sequence; the JSON keeps every request's new input items, calls,
duration and token usage, and a summary across runs.
