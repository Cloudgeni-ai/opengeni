# Code search evaluation harness

Measures how well a code search strategy finds the code a task needs, against human oracle
evidence, and what it costs in latency, tokens and money. It compares the strategies an agent
could use to gather context before or while changing code:

| Arm           | What it is                                                                                                                               | Paid calls  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `bm25`        | BM25 over 60-line chunks, identifiers split into subwords                                                                                | none        |
| `repomap`     | Definitions per language plus personalised PageRank over references (Aider-style repo map)                                               | none        |
| `hybrid`      | `bm25` and `repomap` fused by reciprocal rank                                                                                            | none        |
| `jev-rerank`  | Jev predicate per `hybrid` candidate file through Vercel AI Gateway, re-ranked by probability                                            | Jev         |
| `code-search` | Opengeni's existing `code_search` pipeline (`packages/jev`) with Jev through Gateway                                                     | Jev         |
| subagent      | Read-only small-model search subagent, up to 8 parallel tool calls and 4 turns (`harness/subagent.ts`)                                   | small model |
| agent         | The current Opengeni agent with `rg` and shell, run by the benchmark runner; localization read from its events (`harness/trajectory.ts`) | main model  |

Every arm returns ranked files and spans cut to the same 12K-token context budget, so arms are
compared at equal context cost.

## Data

The primary oracle is ContextBench (arXiv 2602.05892, github.com/EuniAI/ContextBench, Apache-2.0):
1,136 tasks over 66 repositories in 8 languages with human gold context at file and line level.
Export `data/full.parquet` to JSONL (any parquet reader; keep `gold_context` parsed, file contents
not needed). Gold paths given in the annotators' container are made repository-relative; files
outside the repository are dropped, and the 4 tasks left with no gold are excluded.

Tasks split into dev and test by repository (a fixed hash, about 15% of repositories to dev: 156
dev tasks in 13 repositories, 980 test tasks). Tune on dev only; report test once.

## Run it

```sh
bun scripts/code-search-eval/run.ts --contextbench full.jsonl --split test \
  --arms bm25,repomap,hybrid --out results/cse-test
```

Model-free arms make no network calls besides cloning repositories. Paid arms need an approved
cap and the Gateway key in the environment. Supply it from your secret store at run time
(in Opengeni, as a vault reference in the command); never write it into a file:

```sh
VERCEL_AI_GATEWAY_API_KEY="$GATEWAY_KEY_FROM_SECRET_STORE" \
  bun scripts/code-search-eval/run.ts --contextbench full.jsonl --split test \
  --arms hybrid,jev-rerank,code-search --allow-live --budget-usd 25 --out results/cse-jev
```

| Option                   | Meaning                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `--split dev\|test\|all` | Which split (default `test`).                                                         |
| `--per-language N`       | Stratified sample of up to N tasks per language (seeded, stable).                     |
| `--budget-usd X`         | Hard cash cap. Each call reserves its worst case first; the ledger survives restarts. |
| `--allow-live`           | Required for any arm that makes paid calls.                                           |
| `--report-only`          | Re-render the report from `runs.jsonl`.                                               |

Runs resume: finished task and arm pairs in `runs.jsonl` are skipped. Auth, credit and billing
errors stop every paid call and are never retried; a Gateway answer without a billed cost also
stops the run rather than guessing spend. Jev goes through Gateway only, never the native
TypeSafe API.

## Metrics

File recall, precision and F1; Recall@1/3/5/10; MRR; line recall and precision against merged
gold spans; latency p50 and p95; tokens; cash and API-equivalent cost. Intervals are repository
clustered bootstrap 95% intervals; arm comparisons are paired on the same tasks.

## Tests

```sh
bun test scripts/code-search-eval
```

Tests cover dataset conversion, metrics and intervals, both indexes, the budget ledger, the
Gateway decision model with a mocked transport, trajectory import, and every arm on a real git
checkout (Jev and the subagent model faked). No test makes a network call.
