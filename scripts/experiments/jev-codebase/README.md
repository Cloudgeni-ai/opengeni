# Jev codebase investigation experiment

Read-only, standalone Bun pilot. **Not registered as an agent tool, not enabled
in staging, and not a trusted yes/no oracle.** Jev chooses bounded IDs/labels;
the controller reads committed Git blobs and returns exact source ranges. It
does not ask Jev to generate summaries, paths, search strings, or commands.

## Install and verify

From this directory:

```sh
bun install --frozen-lockfile --ignore-scripts
bun test ./core.test.ts ./investigation.test.ts
bun run typecheck
bun fixtures/verify.ts
```

Dependencies are isolated from production workspaces. The root repository pins
Bun 1.4.0; use that version for repository-wide validation. Provider APIs are
experimental and packages are pinned in this directory's lockfile.
The experiment requires the TypeScript 5 compiler API, not the root TypeScript 7
toolchain. Unit-shard CI installs this directory's frozen dependencies before
running its discovered tests; local root-suite users must install them too.

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

The default `v3` workflow separates entry discovery, bounded local dependency
reads, evidence classification, answering the literal question, and verification
of the proposed answer against the requested path. It reassembles overlapping
source windows before parsing and recognizes named constants/arrow functions.
Code-shaped names (camelCase or underscore/dollar identifiers) take precedence
over generic words such as `request`; the first matching declaration in that
group is an entry-point heuristic, not a semantic proof. Other declarations
remain contrast candidates. Two independent
lexical candidates can expose alternate implementations without treating them
as reachable from the entry point. `--workflow legacy` preserves the earlier
per-excerpt loop for diagnosis; its outcomes must not be pooled with v3.

An explicit unknown entry-selection result yields immediately. Gapped source
windows remain separate excerpts rather than causing a global parsing error;
an incomplete required file cannot justify a decisive answer. Contrast-only
imports do not become mandatory execution dependencies. Evidence-only requests
can return source even when it cannot establish an external runtime outcome.

Each returned answer remains a model judgment, not a formally verified property.
Verification is a second model judgment using the same provider and correlated
errors remain possible. Direct mode is still experimental.

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

For an explicitly authorized experiment spanning several outputs, `--ledger`
shares one append-only request journal and its budget across runs. `--max-requests`
can be set up to 160 and `--max-usd` up to 1; larger limits are not accepted.
There is no concurrent-process budget locking: run one process at a time.
Requests include case/run attribution, and per-run cost summaries filter the
shared ledger to their own run. Failed or unsettled shared-ledger calls stop
further calls. `--case` selects one named regression case without silently
overwriting earlier results. Old unknown-billing failures remain historical
evidence; starting a newly authorized experiment does not settle their bills.

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
Benchmark rows expose `operationalSuccess` (neither error nor budget exhaustion),
`answerCorrect` (operational success plus oracle answer agreement), and
`strictEvidenceSuccess` (answer correctness plus every required oracle path
returned and no unresolved local dependencies). An empty required-path set has
no path-recall obligation; recall remains null. These are file-level evidence
checks, not proof that the excerpts establish the answer. Missing or excluded
relative imports remain unresolved rather than silently satisfying completion.

## Future tool integration gate

Before registering or toggling this at agent dispatch: independent security
review; robust immutable-snapshot ingestion/indexing; real transcript-derived
questions with independently checked current-revision oracles; model failure
and continuation handling; per-task parent+script+fallback metering; and paired
staging task runs against the existing agent workflow. Preserve evidence-only,
direct-answer and indecisive/yield modes in that tool contract.

## Terra end-to-end trajectory comparison

`trajectory-run.ts` compares `openai/gpt-5.6-terra` with ordinary bounded
list/search/read tools against the same Terra model forced to invoke Jev once
at the start, then allowed the same ordinary tools for verification/fallback.
The final answer and explanation are produced by Terra in both arms. This
tests a mandatory-delegation policy, not an optimal learned routing policy.
It is a controlled API harness, not the complete OpenGeni/Codex runtime.

```sh
JEV_ALLOW_LIVE=1 bun trajectory-run.ts --root /path/to/opengeni \
  --revision COMMIT --subdir apps/web/src/lib --cases /path/to/cases.json \
  --out runs/terra-fresh --ledger runs/terra-shared.jsonl
```

Cases are independent JSON `BenchmarkCase[]` records as declared in
`trajectory.ts`; only question/context/mode are given to the model. Freeze code
before viewing fresh labels, alternate arm order, keep smoke/regression runs
separate, and never overwrite output manifests. CLI work is read-only outside
its output receipts. No staging integration or subscription billing is implied.

The shared sequential journal caps the current content-first iteration at 697 cumulative inference requests
and $2.564718566 known-or-reserved, reserving each call before transport. This pass
also enforces at most 80 additional attempts/$1 above the retained baseline of
617 attempts/$1.564718566 known-or-reserved. The historical direct-route comparator
retains its 536/$2.28 ceiling and 496-attempt baseline; earlier manifests retain their original ceilings. Unsettled,
authentication, missing-usage and ambiguous failures stop the experiment. Explicit
HTTP 429/502/503/504/529 failures are retained with the unknown bill reserved; failed
Jev discovery yields empty evidence to ordinary Terra tools, while exhausted Terra
calls end that case. This pass unconditionally disables retries; `--no-retry` remains
accepted for command compatibility. Failed cases from earlier runs remain failures, not retroactively rescued.
An old explicit
transient failure requires `--resume-transient FAILED_REQUEST_UUID` in the same ledger;
this records authorization, not settled billing. Never reset the ledger to bypass it.
Limits: 10 Terra turns per task, 2,200 output tokens per call, 60-second
Terra timeout, 30-second Jev timeout, 240-second task deadline propagated to
inference and checked before accepting results, no SDK retries. Synchronous snapshot
ingestion is timed but cannot be interrupted by that deadline. This is not a
provider-enforced spending limit. Prices and reported costs fail closed when
missing/invalid; Jev is supported only with its verified zero output-token rate.
Terra reasoning uses the provider default; resolved model
and available reasoning-token usage are recorded, without assuming an exact
upstream weight version. The earlier $2/200-request no-retry manifests remain historical evidence.

### Content-first controller and equal-retrieval comparison

The default `--workflow content` uses `content-investigation.ts`. Its reusable request
accepts `question`, `context`, `searchHints` (literal content-query strings), and
`requestedOutput`. Supplied hints are normalized but not supplemented with guessed
filenames; if omitted, bounded question/context terms are extracted deterministically.
No model call is needed to execute search, read files, or construct candidate IDs.

`searchContent` searches file contents, not path names. It returns exact surrounding
lines, ranks by content-term matches, and supports pagination. Jev evaluates those
snippets, selects reads, then judges sufficiency and which exact source to return.
For missing evidence it can request the next match page or select a named identifier
from the source for another content search. Member/property/import identifiers are
eligible, not only bare function calls. Bounds: three rounds, eight accepted reads,
four new reads per round, 48,000 internal source characters, and 6,500 returned source
characters. Reads share the ordinary `SourceTools.read` backend and must include the
selected match. No match is an unknown, never a negative proof. Added unassessed
import/helper context suppresses a decisive Jev answer. Terra still owns the final
answer in this full-workflow benchmark; standalone typed yes/no/indecisive judgments
remain advisory and can always be accompanied by evidence.

For this comparison, the harness freezes initial terms from question/context only.
Both initial tools require an actual `queries` string-array argument, with bounded
length in the schema and exact equality checked at runtime against that same frozen
array: ordinary `discover` returns content candidates to Terra; delegated
`investigate` passes them internally to Jev. Both force one initial tool call, use
the identical search backend, and retain ordinary content search/read for follow-up.
Candidate digests allow exact retrieval parity to be audited. This isolates selection
and delegation, **not** how freely acting agents generate search terms. Case labels,
oracle spans, and rationale never enter the initial queries or model state.

Search bounds are explicit: 8 million input characters, 200,000 scanned lines,
50,000 retained matches, up to 16 snippets/16,000 characters per page, and periodic
local deadline checks. Oversized context falls back to the exact matching line;
unavailable lines and truncated scans are disclosed. Rare-term weighting is lexical,
not semantic retrieval. Narrow caller terms generally avoid scanning many generic
matches. Source exclusions and bounded recovery still prevent completeness claims.

The September 22 content-first regression run completed all four pairs with identical
initial candidate digests. Both arms passed strict evidence/label checks. These are
previously seen regression cases, not new holdouts. The first run stopped on an initial
Terra HTTP400; a manually corrected schema removed an array-valued enum, then a new
run completed. The exact original provider explanation was not retained, so the
schema cause is suspected, not proven. The failed request's full unknown-billing
reservation remains in the ledger. There is no runtime HTTP400 recovery switch:
historical reconciliation requires an exact completed replacement id/hash with
matching task/model attribution; new nontransient failures stop the experiment.
No automatic retries occurred.

The historical `--workflow compact` controller ranks a source path/export index locally,
lets Jev choose a primary/companion from 40 candidates, and broadens on unknown
within six pages. If both choices duplicate the same file, a conditional judgment
selects a distinct companion or none; that extra call is metered. It reads at most 48,000 source characters internally, includes
relative dependencies, and asks Jev to select exact AST-based source spans. At most
6,500 source characters return to Terra. Imports/types are selectable; fragmented
source is retained with original ranges and disclosed as incomplete. Snapshot
character limits never truncate a physical line and label it exact. This is bounded
discovery, not repository-wide absence proof. A plausible wrong root can still miss
other candidates. `--workflow legacy` remains available for explicit comparison.

Compact v10 merges overlapping exact source before charging its return budget,
preserves referenced import bindings, and adds one hop of small (at most 1,500
characters) referenced same-file function declarations. This syntactic context
expansion is not symbol resolution or dependency closure: shadowing can add extra
context; arrow helpers, large helpers and deeper dependencies may still be omitted.
Budget-dropped context is disclosed. Same-line declarations retain their opening
physical line. Source classification automatically partitions questions only when
the serialized state plus questions would exceed 96,000 bytes; each batch keeps
the identical full source, shares the deadline and is metered separately. Oversized
single questions/state still yield; selected candidate paths survive that yield.
Repeated source tokens in batches are not free. No retries are added.

Both arms default to `--citation-mode ids`: each delivered excerpt has a stable
handle, and Terra selects handles that the runtime resolves to exact source ranges.
`--citation-mode ranges` retains the earlier explicit-line interface for ablation.
Handles reduce line arithmetic, not semantic mistakes; broad excerpt citations can
raise mechanical recall without improving reasoning. Source and delivered coverage
are checked across contiguous unions, never unread gaps. Exception paths roll back
undelivered excerpts, and every arm must match the first snapshot digest. A missed
helper citation still fails strict coverage even when its source was returned.

The optional `--jev-question-batch 8` partitions independent Jev questions into batches of at most eight,
retaining identical full state in each batch and validating every answer. This is a
workload mitigation, not a documented provider limit: an alternating diagnostic saw
three 26-question controls fail with HTTP503 while all twelve calls in the equivalent
three batched pipelines succeeded. It repeats source tokens and adds calls; both are
metered, not treated as free. The subsequent no-retry end-to-end check still saw
503s on an eight-question span batch and a two-question file selector: batching has
not established reliable service or eliminated the failure. Batching is off by default.
Completed validated batch judgments can survive a later journaled transient as partial
exact evidence; unjudged spans are never labeled irrelevant. Successful discovery paths
survive a later selection failure as candidate paths, not proven answer evidence.
Fallback requires a branded error linked to the failed/reserved ledger attempt, not
an arbitrary matching error string. Controller and task deadlines still apply.

`gateway-call.ts` is shared by the runner and diagnostic utility. Its offline SDK
integration test covers two 503s, reserved unknown bills, ordinary fallback, and
rejection of request401 against a configured 400-request ceiling. Authentication
and missing-cost errors fail closed. Transport receipts retain request correlation,
body hashes/sizes and safe error fields, never authorization values. Jev state/question
payloads are retained in private run files for exact replay; they contain source and
must be handled with the same access controls as the repository. Each trajectory run
retains its implementation sources and digest alongside its manifest.

The Gateway-only diagnostic utility uses the same cumulative ledger and no retries:

Its historical 496-request ceiling remains unchanged. `compare-routes.ts` retains
the earlier direct-pass authorization; `trajectory-run.ts` uses the improvement
authorization above. New directories never reset the shared budget.

```sh
JEV_ALLOW_LIVE=1 bun diagnose-gateway.ts minimal \
  --out runs/diagnostic-new --ledger runs/terra-shared.jsonl
JEV_ALLOW_LIVE=1 bun diagnose-gateway.ts code --root /path/to/opengeni \
  --revision COMMIT --subdir apps/web/src/lib --cases /path/to/cases.json \
  --out runs/diagnostic-code-new --ledger runs/terra-shared.jsonl
JEV_ALLOW_LIVE=1 bun diagnose-gateway.ts batches \
  --payloads runs/diagnostic-code-new/payloads.jsonl --payload-id REQUEST_UUID \
  --out runs/diagnostic-batch-new --ledger runs/terra-shared.jsonl
```

`replay` accepts `--payloads` plus comma-separated `--payload-ids` and compares
direct/combined abort signals three times. `batches` alternates whole versus
eight-question batches three times; `code` repeats supplied cases three times.
Do not use a new ledger to evade the cumulative authorization. These diagnostics
cannot attribute an uncorrelated upstream503 to Gateway versus TypeSafe by themselves.

### Explicit native TypeSafe comparison

The September 21 direct-route experiment was explicitly authorized by the user.
`--jev-route direct` uses only `JEV_API_KEY` at the fixed TypeSafe endpoint, pins
`jev-1.13.0`, rejects redirects and validates native Choice answers and usage.
Terra still uses its Gateway credential. No silent endpoint fallback occurs;
Gateway remains the default route unless the option is supplied.
Native cost is recorded as catalog-estimated input cost with `reportedUsd: null`,
not as a reported invoice charge. The native adapter deliberately supports Choice only.

```sh
JEV_ALLOW_LIVE=1 bun trajectory-run.ts --root /path/to/opengeni \
  --revision COMMIT --subdir apps/web/src/lib --cases /path/to/cases.json \
  --out runs/direct-new --ledger runs/terra-shared.jsonl --no-retry --jev-route direct
JEV_ALLOW_LIVE=1 bun compare-routes.ts --plan /path/to/plan.json \
  --out runs/route-comparison-new --ledger runs/terra-shared.jsonl
```

The route plan contains four `{file,id,label}` records identifying retained payloads
in JSONL files. The comparison sends one native synthetic smoke, then two alternating
route repetitions of each unchanged payload, with 30-second deadlines and no retries.
The Gateway upstream version and provider-account configuration are not attested to
match the pinned native version/account; this comparison does not prove a route-only
causal effect or permanent availability. Do not reset the ledger to rerun beyond its cap.

The harness's task-bound investigate tool accepts only search hints; runtime supplies
the active question/context. The underlying controller accepts an explicit Request
and remains reusable for general tools. Jev does not generate summaries: it selects
typed choices and source IDs. Terra inspects those excerpts and owns the final answer.
Both arms receive the same instruction to avoid rereading sufficient evidence.
Evidence-only answer labels are schema-restricted to indecisive in both arms; semantic
explanation correctness must still be reviewed independently. Ordinary fallback stays
available. Local compact input/deadline exhaustion yields, but an in-flight provider
abort can still stop the experiment conservatively for unknown billing.

Measure ingestion/indexing, every model call, each local tool execution,
delegation wall time, fallback calls and full task wall time. Nested Jev calls
are inside delegation wall time: do not add them twice. Preflight/catalog work
is recorded separately as shared setup. Local CPU has measured time but no
invented dollar rate. Provider charges and catalog-equivalent cost are separate.
Main-model cumulative input usage includes repeated history; cached input is
separate. Tool-result bytes/chars are exact; `bytes/4` is only a token proxy,
not Terra-tokenizer ground truth. Do not call all non-oracle source irrelevant.

The automatic score distinguishes final label agreement, required source-span
delivery, required citation coverage and valid citations into received lines.
Evidence-mode enum violations are separate from wrong decisive binary answers.
It does not judge prose
correctness: a blinded source-based semantic review is needed, especially for
evidence-only cases. No final answer is a failure, not a correct abstention.
Ordinary tools stay available after Jev, so report Jev's intermediate result
separately from final Terra accuracy. Keep each failure and fallback in totals.