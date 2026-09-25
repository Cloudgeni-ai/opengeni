# Code search (`code_search`)

`code_search` is an optional agent tool for questions about the code in a
session's workspace: where something is implemented, configured or decided.
The agent gives one question and 6-15 keywords. The tool returns the most
relevant source passages, verbatim with paths and line numbers, plus an evidence
rating for those passages. That replaces a chain of separate searches and file reads, each of
which would otherwise cost a model request.

Ranking uses Jev, TypeSafe's fast judge model. Jev answers many yes/no
questions in parallel in about 0.4 s per request at $0.042 per million input
tokens. It never writes text, so the agent still writes the answer.

## Measured effect

- **Investigation questions, in OpenGeni.** 26 real code questions from
  staging, answered twice per arm by the OpenGeni agent (gpt-6-astra) on a
  Connected Machine, with the tool on and off in parallel, graded blind by two
  graders. With the current wording: cost -6.6% (95% CI 2-12%), wall time -9.1%
  (5-13%), 1.4 fewer model requests per question, answer quality at parity.
  Jev added about $0.006 per question.
- **The wording matters.** An earlier version, which labelled packs
  `sufficient`/`partial` and said to search further only for reported gaps,
  saved 15% but lost a few answers to questions like "does anything skip this
  validation?". Blind re-grading showed the agent stopping at a pack that
  covered only one side. The current rating wording fixed that.
- **Stand-alone agent.** The same engine in a plain Codex CLI harness saved 16%
  cost and 11% time; that harness loads `AGENTS.md` automatically, so fewer
  requests were left to save.
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
   check gives the packed passages an evidence rating. The rating cannot see
   evidence the search missed, so the header, the tool description and the
   directive all steer follow-up searches outside the pack: other entry points,
   defaults, flags and exceptions. An earlier `sufficient`/`partial` label read
   as permission to stop and cost answer completeness in testing.

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
  reported as partial. If the temporary directory is full, the call fails
  with a message saying so rather than returning partial results.
- `codeSearchPathKinds` and `fsRead` check path filters and read the selected
  files.

None of these writes to the workspace (only to the box's temporary directory),
so none takes workspace mutation admission. The Jev key stays on the server,
in the API and worker processes, and never reaches a sandbox or Connected Machine. The worker uses it to call
Jev; the API reads it only to report whether the deployment offers the tool.
The tool works on every sandbox backend and Connected Machine that has `rg` and
`bash`; both stock sandbox images include them. Windows Connected Machines do
not get the tool, because its search commands are POSIX shell scripts.

## Turning it on and off

| Level | Setting | Effect |
| --- | --- | --- |
| Deployment | `OPENGENI_JEV_API_KEY` | Required. Without a usable key, every Jev feature is off. |
| Deployment | `OPENGENI_CODE_SEARCH_MODE` | `off` (default) never offers the tool. `opt_in` offers it where the workspace turns it on. `default_on` gives it to every workspace that has not turned it off. `experiment` gives it to a fixed half of sessions in workspaces without their own setting. |
| Workspace | `settings.codeSearchEnabled` | Settings → Session defaults → **Fast code search**: Default, On or Off. `true` or `false` overrides the deployment default for new sessions; `null` or absent follows it. `false` also switches the tool off in running sessions. The row is hidden when the deployment does not offer the tool. |
| Worker process | Circuit breaker | Three consecutive Jev outages make `code_search` calls on that worker fail at once for 5 minutes, or 30 minutes after an auth or billing error (401/402/403). After the cooldown one trial call runs at a time; others are refused until it ends or has run for 10 minutes. A search that never needed Jev neither closes nor reopens it. The breaker never hides the tool. |

`OPENGENI_JEV_BASE_URL`, `OPENGENI_JEV_MODEL` and
`OPENGENI_JEV_REQUEST_TIMEOUT_MS` default to the native TypeSafe API,
`jev-latest` and 10 s.

### The decision is frozen per session

The tool's schema and its instruction line are part of the start of every
model request, so adding or removing them makes the provider's prompt cache
miss for the whole conversation. To keep a session's prompt stable:

- A root session decides once, when it is created, from the deployment mode,
  the workspace setting and (in `experiment` mode) its id. The decision is
  stored in `sessions.code_search_enabled` (migration 0520). A child session
  keeps its parent's decision, so one session tree stays in one arm. A fork
  and every session created before 0520 are off.
- Later changes never turn the tool on for a session created without it:
  turning the mode on, adding the key, switching a workspace to On, or moving
  from `experiment` to `default_on` affect new sessions only.
- Three deliberate switch-offs still reach running sessions on their next
  turn, because they stop repository content going to Jev: mode `off`,
  removing the key, and a workspace Off. Undoing one gives the tool back to
  sessions that were created with it. Each change costs every affected running
  session one prompt-cache miss. Change the mode or key in one rollout; while
  old and new workers overlap, sessions can alternate between them.
- Transient Jev health never changes the tool list. The breaker is per worker
  process, and sessions move between workers, so it only refuses calls.

A session without compute (`backend: none`) never gets the tool, and neither
does a turn on a Windows Connected Machine. Moving a session to such a route,
or back, is a deliberate route change that also changes its other tools.

### Measuring it on real work

In `experiment` mode a root session's half is chosen from its id
(`codeSearchSessionInExperiment` in `@opengeni/contracts/code-search`: 32-bit
FNV-1a, low bit 0 gets the tool), and its children share it. The stored
`sessions.code_search_enabled` (also `codeSearchEnabled` on the session API
object) records the decision frozen at creation. Limit arm analysis to root,
non-fork sessions in workspaces whose own setting is unset: workspaces with an
explicit On or Off are not randomized, and forks are always off. Each
attempt's persisted tool catalog (`session_attempt_tool_catalogs`) shows
whether `code_search` was actually offered on that attempt. Compare cost, wall
time, model requests and prompt cache hit rate per session tree between the
halves, and grade a sample of answers for quality.

A typical path: run `experiment` in staging, check the result, then set
`default_on` in production. Any workspace can still choose Off.

## Failures

The tool reports problems to the agent instead of degrading silently:

- **Jev is down, rate-limited, out of credit or rejects a request.** The tool
  returns an error telling the agent to search with `exec_command` instead.
  Repeated outages trip the breaker, and calls on that worker then fail at once
  with the same advice.
- **Only the final status check fails.** The tool still returns the Jev-scored
  pack with `evidence rating unknown (check failed)`. An outage there counts toward the breaker.
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
