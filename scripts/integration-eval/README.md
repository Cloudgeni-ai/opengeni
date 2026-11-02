# Integration eval

Repeatable end-to-end checks that agents use third-party integrations correctly.
Each row is a real chat created through the public API. The harness approves
writes the way a person would, then grades the run from the session's tool
receipts (forensic session events), not from the answer text alone.

## What a row checks

| Kind | Passes when |
|---|---|
| `not_connected` | Run in a workspace with nothing connected. The agent shows that integration's connect card (`tool.auth_needed`) and does not invent data. |
| `read` | A tool of that integration ran without error, and the answer contains the seeded fixture facts. |
| `write` | An approval was requested for that integration, the harness approved it, the approved call succeeded, and the service-side verifier finds the object. |
| `identity` | The agent reports the connected account correctly. |
| `routing` | Ambiguous request; the right integration's tools ran and the answer has the expected facts. |

Failures are categorised as `wrong_tool`, `no_tool`, `missing_card`,
`approval_problem`, `tool_error`, `hallucinated_result`, `incomplete_answer`
or `harness_error` (the run failed for reasons that are not a product verdict;
excluded from pass rates).

## Setup

1. An organization with **API credits**. API work is paid from credits only;
   a plan's monthly credit never pays for it.
2. Two workspaces: one with the integrations connected, one with none.
3. Test accounts for each service, seeded with the synthetic "Halcyon" fixtures
   that the catalogue's expected answers name (see the comment at the top of
   `catalogue.ts`). Use test accounts and synthetic data only.
4. An API key for the organization.

```sh
export OPENGENI_EVAL_API_URL=https://app.example.com
export OPENGENI_EVAL_API_KEY=...            # organization API key
export OPENGENI_EVAL_CONNECTED_WORKSPACE_ID=...
export OPENGENI_EVAL_EMPTY_WORKSPACE_ID=...
# Optional service verifiers for write rows; see verify.ts for the names.
export VERIFY_LINEAR_API_KEY=...
```

## Running

```sh
bun run eval:integrations list                       # every row (add --cases core for the grid set)
bun run eval:integrations models                     # the grid: every credit model at every effort
bun run eval:integrations run --out results/grid --cells all --cases core --repeats 1 --concurrency 4
bun run eval:integrations run --out results/ref --cells some-model@medium --cases all --repeats 2
bun run eval:integrations report --out results/grid
```

`--cases` takes `core`, `all`, or comma-separated ids or prefixes
(`linear`, `slack.write`, `routing`). `--skip-integrations a,b` drops
integrations the deployment cannot test. `--dry-run` lists the runs.

Results append to `DIR/results.jsonl`. Running the same command again skips
rows that already have a record, so an interrupted grid resumes. The report
writes `matrix.csv` (integration × model × effort with failing chat links),
`runs.csv` (one line per chat) and `summary.md` (pass rate per cell with a
Wilson 95% interval). Each run's parsed receipts are kept in `DIR/receipts/`.

## Checking a fix

Rerun the same rows, with the same models and efforts, into a new directory:

```sh
bun run eval:integrations run --rerun results/grid/results.jsonl --failed-only --out results/grid-fix-1
```

## Sizing

A three-row pilot only checks the setup. With one core row per integration
surface and kind, the grid has about 30 rows per cell; at one repeat a cell's
pass rate has a 95% interval of roughly ±15 points, and a model's aggregate
across its efforts (100+ runs) about ±8. Compare cells only when intervals do
not overlap, and use `--repeats` on the reference cells when a difference
matters.

## Tests

```sh
bun test scripts/integration-eval
```
