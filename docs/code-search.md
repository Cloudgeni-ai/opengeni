# Code search (`code_search`)

`code_search` is an optional agent tool for questions about the code in a
session's workspace: where something is implemented, configured or decided.
The agent gives one question and 6-15 keywords. The tool returns the most
relevant source passages, verbatim with paths and line numbers, plus a coverage
status. That replaces a chain of separate searches and file reads, each of
which would otherwise cost a model request.

Ranking uses Jev, TypeSafe's fast judge model. Jev answers many yes/no
questions in parallel in about 0.4 s per request at $0.042 per million input
tokens. It never writes text, so the agent still writes the answer.

## Measured effect

- **Investigation questions.** 26 real code questions from staging, answered
  twice each by gpt-6-astra and graded blind by two graders. With the tool,
  cost fell 16% (95% CI 11-22%) and wall time 11% (6-15%), with no measurable
  quality change. Jev added about $0.006 per question.
- **Bug-fix tasks.** 12 Terminal-Bench and 12 SWE-rebench tasks showed no change
  in pass rate, cost or time. The agent called the tool about 0.4 times per
  task because it reads the failing test and goes straight to the code.
- **Keyword-only ranking** of the same pipeline lost 7.7 points of answer
  quality. That is why the tool never falls back to it.

Real sessions mix both kinds of work, so the tool ships off by default and is
switched on per deployment or workspace to measure it.

## How it works

1. **Recall.** One wide ripgrep pass over the workspace finds candidate files
   by keyword, weighted by how rare each keyword is.
2. **File triage.** Jev decides which candidate files are about the question.
3. **Passage check.** Jev scores the passages around each hit for relevance and
   for each sub-question.
4. **Leads.** The tool follows up to six definitions named in the best passages,
   one level deep.
5. **Pack.** Passages that pass are packed within a token budget. A final Jev
   check labels the pack `sufficient`, `partial` or `insufficient`, so the
   agent knows whether to search further.

The engine lives in `@opengeni/jev` and runs in the worker. The workspace sees
only read-only commands through `SandboxChannelAService`:

- `codeSearchRipgrep` accepts a closed set of ripgrep flags. Flags that run
  programs or read other files, such as `--pre` and `-z`, are rejected before
  a command is built. It adds `--no-config`, and paths must stay inside the
  workspace. A watchdog stops the search after its budget; it is portable to
  macOS, which has no GNU `timeout`. Output is compressed once in the box's
  temporary directory and fetched in 512 KiB chunks, because providers retain
  about 1 MiB per command output. The last fetch deletes the file, and files
  older than 15 minutes are swept on the next call. Up to 8 MiB of compressed
  output is fetched; anything beyond that is cut at a line boundary and
  reported as partial.
- `codeSearchPathKinds` and `fsRead` check path filters and read the selected
  files.

None of these writes to the workspace (only to the box's temporary directory),
so none takes workspace mutation admission. The Jev key stays on the server, in the API and worker processes,
and never reaches a sandbox or Connected Machine. The worker uses it to call
Jev; the API reads it only to report whether the deployment offers the tool.
The tool works on every sandbox backend and Connected Machine that has `rg` and
`bash`; both stock sandbox images include them. Windows Connected Machines do
not get the tool, because its search commands are POSIX shell scripts.

## Turning it on and off

| Level | Setting | Effect |
| --- | --- | --- |
| Deployment | `OPENGENI_JEV_API_KEY` | Required. Without a usable key, every Jev feature is off. |
| Deployment | `OPENGENI_CODE_SEARCH_MODE` | `off` (default) never offers the tool. `opt_in` offers it where the workspace turns it on. `default_on` gives it to every workspace that has not turned it off. `experiment` gives it to a fixed half of sessions in workspaces without their own setting. |
| Workspace | `settings.codeSearchEnabled` | Settings → Session defaults → **Fast code search**: Default, On or Off. `true` or `false` applies to every session; `null` or absent follows the deployment. The row is hidden when the deployment does not offer the tool. |
| Worker process | Circuit breaker | Three consecutive Jev outages hide the tool from new turns for 5 minutes, or 30 minutes after an auth or billing error (401/402/403). After the cooldown one trial call runs at a time; others are refused until Jev answers. A search that never needed Jev neither closes nor reopens it. |

`OPENGENI_JEV_BASE_URL`, `OPENGENI_JEV_MODEL` and
`OPENGENI_JEV_REQUEST_TIMEOUT_MS` default to the native TypeSafe API,
`jev-latest` and 10 s.

The decision is made when each turn attempt starts, so a change applies from
the next turn of every session. A session without compute (`backend: none`)
never gets the tool, and neither does a turn on a Windows Connected Machine.

### Measuring it on real work

In `experiment` mode the half is chosen from the session id
(`codeSearchSessionInExperiment` in `@opengeni/contracts`: 32-bit FNV-1a, low
bit 0 gets the tool). A session keeps its half for its whole life, so its
prompt prefix stays cache-stable, and analysis can recompute the half from the
id alone. Each attempt's persisted tool catalog
(`session_attempt_tool_catalogs`) also shows whether `code_search` was offered.
Compare cost, wall time and model requests per session between the halves, and
grade a sample of answers for quality.

A typical path: run `experiment` in staging, check the result, then set
`default_on` in production. Any workspace can still choose Off.

## Failures

The tool reports problems to the agent instead of degrading silently:

- **Jev is down, rate-limited, out of credit or rejects a request.** The tool
  returns an error telling the agent to search with `exec_command` instead.
  Repeated outages trip the breaker.
- **Only the final status check fails.** The tool still returns the Jev-scored
  pack with status `unknown`. An outage there counts toward the breaker.
- **ripgrep is missing** (possible on a Connected Machine). The tool returns an
  error saying so.
- **Partial search.** A cut or timed-out search is marked partial in the pack
  header.

## Cost

Jev runs on the deployment's TypeSafe key, so the tool works whatever the
workspace uses for its chat model: OpenGeni credits, its own subscription or
its own API keys. It costs about $0.006 per call. Every completed call records
two usage events against its workspace, session, turn and attempt:
`code_search.jev_input_tokens` (tokens) and `code_search.jev_cost`
(`usd_micros`). Nothing is debited from credits.

## Observability

- `opengeni_code_search_calls_total{outcome}`
- `opengeni_code_search_duration_seconds{outcome}`
- `opengeni_code_search_jev_requests_total`
- `opengeni_code_search_jev_cost_micro_usd_total`

Tool calls and results also appear in the session timeline like any other tool.
