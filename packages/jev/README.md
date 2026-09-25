# `@opengeni/jev`

`@opengeni/jev` holds OpenGeni's client for TypeSafe Jev, a fast judge model, and the Jev-ranked
`code_search` engine behind the worker's `code_search` agent tool. The package has no runtime
dependencies. It uses global `fetch`, runs under Node 18+ and Bun, and makes no filesystem or process
calls of its own.

## Jev client

```ts
const jev = new JevClient({ apiKey });
const r = await jev.ask(state, { urgent: noul("Does this convey urgency?") }, { signal });
r.answers.urgent.probability; // 0..1
r.costUsd; // $0.042 per 1M input tokens; output is free
```

The client calls `POST {baseUrl}/v1/systemone` with `{state, model, questions}`. When the state plus
the longest question would exceed 32k tokens, or the state plus all questions would exceed 64k tokens,
it splits the questions across several requests. It runs those requests concurrently (16 at a time by
default) and merges the answers.

Answers are normalized as follows:

- A noul answer becomes `{type: "noul", probability}`.
- A choice answer becomes `{type: "choice", option, probabilities?, confidence?}`.
- A score answer is passed through unchanged.

Retries and errors work like this:

- The client retries only network errors (including the per-attempt timeout), HTTP 429 and 5xx. The
  backoff is bounded, and a `retry-after` hint is honoured up to `maxRetryAfterMs` (2 s by default).
- `JevUnavailableError` covers network errors, timeouts, 5xx, 429 after the last retry, and 401, 402
  or 403 (auth or billing, never retried). `status` carries the HTTP status.
- `JevRequestError` covers every other 4xx (including `400 max_tokens_exceeded`) and a state too large
  to fit the limits (`code: "state_too_large"`). These are never retried.
- The caller's `AbortSignal` cancels queued and in-flight requests, and the call rejects with the
  signal's reason.

`JevCircuitBreaker` is an in-process breaker, and the worker keeps one per process:

- 3 consecutive `JevUnavailableError`s open it for 5 minutes. If the failure that opens it is a 401,
  402 or 403, it opens for 30 minutes instead.
- After the cooldown the breaker is half-open. One more unavailable failure reopens it at once, and a
  success closes it.
- Other errors are ignored.

## code_search

`runCodeSearch({question, keywords, subQuestions?, paths?, workspace, jev, signal?, budgetTokens?})`
ports the validated research tool scout-0.3.1. The ranking, thresholds and defaults
(`DEFAULT_CODE_SEARCH_CONFIG`) are unchanged. The pipeline has five stages:

1. **Recall:** one ripgrep pass over the keyword variants, then IDF scoring per file.
2. **Wave 1:** Jev triages the candidate files, with a lexical guard that keeps the top lexical files.
3. **Wave 2:** Jev verifies line-numbered passages, including coverage of each sub-question.
4. **Wave 3:** Jev scores one round of leads (definitions referenced by the evidence), and the chosen
   definitions are verified the same way.
5. **Pack:** the verified passages are packed within the token budget (12,000 by default), and one
   Jev sufficiency check sets the status.

`text` is the rendered pack. Its first line is a status header such as
`code_search: status=partial (overall 0.55; s1 0.81) | 9 passages from 6 files, ~7.9k tokens | 3.1s`.
`status` gives the label and scores, and `stats` gives wall time, stage times, counts, workspace calls
and Jev requests, tokens and cost.

A Jev failure makes the whole search throw. There is no keyword-only fallback, because it lowered
answer quality in the study. The one exception is a failure of the final sufficiency check: the
fully Jev-scored pack is still returned, with `status=unknown (sufficiency check failed)` and the
error in `statusCheckError`.

### Workspace contract

All file and process access goes through `CodeSearchWorkspace`: `ripgrep`, `readText` and
`pathKinds`, all with workspace-relative paths.

The engine passes ripgrep only these flags, so an adapter can enforce an allowlist: `--files`,
`--null`, `--line-number`, `--with-filename`, `--no-heading`, `--color never`, `-i`, `-w`,
`--no-require-git`, `--hidden`, `-m N`, `--max-columns N`, `--max-filesize N`, `-g GLOB` and
`-e PATTERN`. These are followed by `--` and then `.` or workspace-relative paths.

If ripgrep output is `truncated` or `timedOut`, the search continues with what it got, and the header
reports it, for example `code_search (partial search: ...)`.

An adapter reports problems as follows:

- `readText` returns `null` for a missing file. Per-file problems should also be returned as `null`
  rather than thrown.
- An adapter throws `CodeSearchWorkspaceError` when the workspace is unreachable. When ripgrep is
  missing, it throws `CodeSearchRipgrepMissingError`, or a `CodeSearchWorkspaceError` whose message
  says ripgrep is not installed.

### Tool surface

The package exports the pieces the worker needs to register the tool:

- `CODE_SEARCH_TOOL_NAME`, `CODE_SEARCH_TOOL_DESCRIPTION` and `codeSearchInputSchema`.
- `parseCodeSearchArguments`, which trims, dedupes and normalizes paths, and rejects absolute paths,
  `..` and unknown keys.
- `renderCodeSearchError`, which turns a failure into short model-facing text.

### Changes from scout-0.3.1

- There is no lexical judge and no whole-run lexical fallback.
- There are no Jev caches, file traces, CPU accounting or CLI. The optional `onStage` callback
  replaces the trace.
- The header names `code_search` instead of `scout`, and the footer notes say "paths" instead of `-p`.
- Truncated or timed-out ripgrep output is reported in the header.
- File reads and binary checks run in parallel (8 at a time) through the workspace. Selecting
  candidates gives the same result as the original sequential scan.

## Tests

```bash
bun test ./packages/jev/test
```

The tests use a fixture repository, a `LocalCodeSearchWorkspace` (local `rg` via `Bun.spawn`, with the
ripgrep allowlist enforced) and a deterministic fake Jev. They never call the real API.
