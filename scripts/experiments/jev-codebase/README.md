# Jev codebase investigation experiment

Read-only, standalone Bun pilot. **Not registered as an agent tool, not enabled
in staging, and not a trusted yes/no oracle.** Jev chooses bounded IDs/labels;
the controller reads committed Git blobs and returns exact source ranges. It
does not ask Jev to generate summaries, paths, search strings, or commands.

## Install and verify

From this directory:

```sh
bun install --frozen-lockfile --ignore-scripts
bun test ./core.test.ts
bun run typecheck
bun fixtures/verify.ts
```

Dependencies are isolated from production workspaces. The root repository pins
Bun 1.4.0; use that version for repository-wide validation. Provider APIs are
experimental and packages are pinned in this directory's lockfile.

## Offline snapshot plan

```sh
bun run.ts plan --root /path/to/repository --revision HEAD
```

Only committed regular-file blobs in the authorized root are read. Worktree
changes, symlinks and submodules are not traversed. Common secret/generated
paths, unsupported extensions, large files and over-budget content are excluded.
Exclusions are reported, not proof the excluded content is irrelevant. There is
no complete secret scanner: only use repositories authorized for this provider.
Local ingestion is bounded at 8 MB, with 10,000-character overlapping excerpts.
This pilot is not yet an efficient index for a large monorepo.

The runtime/operator may supply `--subdir` for a deliberately scoped benchmark.
Agents do not need to read a file tree or provide starting paths. The tool
discovers the selected tree itself; optional search hints do not define scope.

## Live investigation

Create a request JSON with a required `question`, optional `context`, optional
`searchHints` array and `requestedOutput` (`answer_if_supported` or `evidence`).

```sh
JEV_ALLOW_LIVE=1 bun run.ts preflight
JEV_ALLOW_LIVE=1 bun run.ts investigate --root /path/to/repository \
  --request /path/to/request.json --out runs/my-investigation
```

Only `VERCEL_AI_GATEWAY_API_KEY` is used. There is no direct-provider fallback,
credential switching, top-up, retry or staging mutation. Preflight is a credit
and catalog check, not an inference. Positive credits do not reserve funds.
The caller must authorize live use and enforce its aggregate experiment budget.

Result: `answer` is yes/no/indecisive; `status` distinguishes evidence, partial,
guidance, budget and error outcomes. Every outcome can return selected exact
excerpts plus source revision, snapshot digest, inspected IDs, unresolved local
paths and exclusions. No persistent resume-token API is implemented yet.

For TS/JS, the controller uses the TypeScript parser to identify named entry
functions and static relative runtime imports. Unread discovered paths block
decisive completion. This is conservative navigation, **not a call graph or
completeness proof**: aliases, dynamic imports, injected behavior and external
dependencies remain limitations. Explicit current deployment questions yield
for runtime evidence. Semantic yes/no interpretation can still be wrong.

## Synthetic comparison

```sh
JEV_ALLOW_LIVE=1 bun run.ts benchmark --root /path/to/opengeni \
  --subdir scripts/experiments/jev-codebase/fixtures/repo \
  --cases fixtures/cases.json --split development --out runs/dev
```

The fixture tree must be committed first. Expected labels/rationale live outside
that tree and are never passed to a model. `--split holdout` selects the other
four synthetic cases; once observed or tuned against, they are regression cases,
not a fresh holdout. `--arm jev` or `--arm llm` runs a single arm.

Both arms use the same controller, evidence budget and candidate generation;
Jev uses evaluation, GPT-4.1 mini uses schema-constrained selection. The LLM's
one-hot encoding is a selected enum, **not calibrated confidence**. Jev returns
distributions; conservative evidence retention may differ by distribution.
The lexical-top4 arm is retrieval-only and cannot be compared as an answerer.
Arm order alternates by case; no clean/warm cache stratification is implemented.

The local run guard defaults to 80 requests, one at a time, $0.50 nominal/reported
cost ceiling, no retries, 15-second call timeout and four exploration steps.
`--max-requests` can reduce the request ceiling. This is not a provider-enforced
budget or a cross-process coordinator. An uncertain request blocks reuse of
its journal. Each new output directory is a new paid experiment; never create
one to bypass a failed/uncertain run without explicitly accounting for it.

Generated `manifest.json`, `requests.jsonl`, `results.json` and `costs.json` stay
under ignored `runs/`. The manifest pins snapshot and implementation digests,
prices and budgets. Requests are journaled before inference. Costs include
failed/uncertain attempts where known; missing cost is never interpreted as
zero. A failed run retains its partial receipts even if no cost summary exists.
Source excerpts remain local in results; request journals retain hashes and
bounded judgments rather than prompts or credentials.

Do not publish token/latency savings as end-to-end agent gains from this test.
Main-agent invocation, final reasoning, verification, fallback, correction,
research/setup costs and staging dispatch overhead are not measured here.
Answer agreement and required-file recall must be reported separately; a right
answer with insufficient evidence is not a fully successful investigation.

## Future tool integration gate

Before registering or toggling this at agent dispatch: independent security
review; robust immutable-snapshot ingestion/indexing; real transcript-derived
questions with independently checked current-revision oracles; model failure
and continuation handling; per-task parent+script+fallback metering; and paired
staging task runs against the existing agent workflow. Preserve evidence-only,
direct-answer and indecisive/yield modes in that tool contract.