# Agent behavior eval

Runs a fixed set of scenarios against a **real model** through OpenGeni's real
agent-turn path, scores each run, and writes a JSON + Markdown report. It is a
manual/nightly tool, not a CI gate: it needs Docker and model credentials and
costs real tokens.

## What runs

- Throwaway Postgres + NATS + S3-compatible storage (`startTestServices`, Docker).
- The real Hono API in-process: sessions are created, messaged, and answered
  (human input, tool approvals) through the public HTTP routes, and the worker's
  first-party OpenGeni MCP tools call back into it.
- The real worker activities (`runAgentTurn`, `maybeContinueGoal`, …) with the
  production runtime and the configured model provider. Temporal is replaced by
  `driveSession` (session.ts), which runs the same activity sequence as the
  session workflow.
- `local` sandbox backend with the production-like owned + lazily provisioned
  lifecycle. Fake product MCP servers (`@opengeni/testing` `startTestMcpServer`)
  are attached per session behind a loopback TLS proxy (per-session MCP URLs must
  be `https:`); `run.ts` re-executes itself once so Bun trusts that certificate.

Each run gets its own workspace, so memory, persona, and sessions never leak
between runs.

## Running

```bash
# Full LEGACY baseline (≈15 scenarios × 3 repeats)
bun run eval:behavior -- --variants legacy --repeats 3

# A few scenarios, one repeat, no judge
bun run eval:behavior -- --scenarios a,c,k --repeats 1 --no-judge

bun run eval:behavior -- --list     # scenarios and variants
bun run eval:behavior -- --help
```

Credentials: `--env-file <path>` (or `OPENGENI_EVAL_ENV_FILE`), otherwise
`./.env`, then the main checkout's `.env`. Only `OPENGENI_OPENAI_*` and
`OPENGENI_AZURE_OPENAI_*` keys are read; values are never logged. Defaults:
agent `gpt-5.6-luna` (reasoning `medium`), judge `gpt-5.6-sol` (reasoning `low`).

Behind a TLS-intercepting proxy, run with the proxy variables unset
(`env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy …`) or make sure
`NODE_EXTRA_CA_CERTS` points at the proxy CA; the harness appends its own
certificate to that bundle and adds loopback to `NO_PROXY`.

Output (default `.agent/evidence/eval/<timestamp>-<variants>/` when `.agent/`
exists, else a temp directory; override with `--out-dir`):

- `report.md` — per-variant tables, gate results, every run.
- `report.json` — the same data plus transcripts (tool calls, replies).
- `results.jsonl` — one line per run, written as runs finish.
- `harness.log` — API/worker logs (kept out of the terminal).

## Scoring

- **Deterministic checks** per scenario (tools called / not called, files in the
  sandbox, answer constraints). A run passes when every non-informational check
  passes. Informational checks and scenarios are reported but never gated.
- **LLM judge** (optional): a fixed prompt in `judge.ts` scores each run 1-5
  against the scenario rubric. Bump `JUDGE_PROMPT_VERSION` if you change the
  prompt or transcript rendering, and never compare reports across versions.
- **Skipped** runs (capability unavailable in this environment, e.g. no hosted
  web search or no artifact runtime) are excluded from pass rates.
- Metrics per run: latency, turns, tool calls, token usage, approximate list-price
  cost, and the captured system-prompt size / prefix tokens / upfront tool count.

## Gate (variant vs baseline)

When more than one variant runs, every later variant is compared with the first;
`--compare <earlier report.json>` compares every variant with the first variant
of an earlier report. A candidate passes when:

- its judge mean ≥ baseline judge mean − 0.2, and
- no gated scenario's deterministic pass rate drops by more than 1/3
  (one run in three at `--repeats 3`).

The process exits 2 when a gate fails. With 3 repeats, a single flaky run moves a
pass rate by 33 points, so rerun a failing scenario with more repeats before
drawing conclusions.

## Adding a variant

Add an entry to `VARIANTS` in `variants.ts`:

```ts
"modular-all": {
  id: "modular-all",
  description: "Modular prompt with every capability",
  shapeCreateRequest: (request) => ({ ...request, agent: { capabilities: "all" } }),
},
```

`shapeCreateRequest` receives the create-session body for each scenario session
and returns the body to send. Set `scenarios` to restrict a variant to a subset.
Then run `bun run eval:behavior -- --variants legacy,modular-all`.

## Adding a scenario

Append to `SCENARIOS` in `scenarios.ts`: a `run` (usually `singleSession` with the
messages, optional create-request fields, fixture files, and a human-input
responder), deterministic `checks`, and an optional `judgeRubric`. Use
`requiresAnyTool` or `skipIf` when the environment, not the agent, can make a run
meaningless. Keep scenarios short: the whole baseline should stay around 20
minutes.
