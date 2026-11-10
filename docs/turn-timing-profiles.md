# Turn timing profiles

Every finished agent turn gets one row in `turn_timing_profiles` that says
where its wall time went, from the moment the turn was created to the moment it
finished. The row is computed from the turn's session event log after the turn
has settled, so nothing is added to the turn's own path, and it is kept as long
as the turn: deleting a chat deletes its profiles.

## How it is computed

The control maintenance schedule (the file upload reaper workflow, every 15
minutes) runs `recordRecentTurnTimingProfiles` after its other sweeps. For each
workspace it pages the turns that finished in the last two hours, skipping the
newest ten minutes so late events land first, that have no profile yet and
whose chat is not archived. It reads each page's attempts and a content-free
projection of the events the profile needs (phases, durations, ids, tool
names and families; never prompts, arguments or outputs), computes the
profiles in memory with `computeTurnTimingProfile` and writes them under the
workspace's row-level security. A run uses the same run budget and lookback as
the model call fact reconciler; a turn one run leaves behind is picked up by a
later run inside the lookback, and older history is filled in by the backfill
script.

The computation is a timeline sweep. Each step (attempt, startup phase, model
request, tool call, hosted web search, sandbox operation, wait) covers an
interval; where steps overlap the highest rank wins and steps of equal rank
share the overlap equally:

1. human and capacity waits
2. hosted web search
3. model requests
4. sandbox operations
5. tool calls
6. pre-dispatch work

Time no step covers is named by what came before it. The segments are whole
milliseconds that always add up to `wall_ms` exactly.

| Column | Meaning |
| --- | --- |
| `queue_ms` | Created until the turn started (or the first attempt began). |
| `turn_start_ms` | Startup phases before the first model request. |
| `dispatch_ms` | Work before a model request reached the provider: request build, routing, and the pre-dispatch time a usage receipt reports. |
| `model_inference_ms` | The provider's own inference time, from its server timing. |
| `model_provider_other_ms` | Provider time outside inference (queueing, pre-inference). |
| `model_network_ms` | The rest of a request with server timing: transport and streaming. |
| `model_unsplit_ms` | Model requests whose provider sent no server timing. |
| `model_stalled_ms` | Failed, timed-out or unfinished model requests. |
| `web_search_ms` | Hosted web search calls. |
| `mcp_tool_ms` | Remote MCP tool calls (connected integrations and custom MCP servers). |
| `sandbox_tool_ms` | Shell, file patch and code mode tools. |
| `own_tool_ms` | Opengeni's own tools. |
| `sandbox_setup_ms` | Sandbox operations outside a tool call (start, resume, attach). |
| `human_wait_ms` | Approvals, questions to a person and handoffs. |
| `capacity_wait_ms` | Waiting for provider capacity. |
| `after_model_ms` | Gaps after a model request before the next step. |
| `after_tool_ms` | Gaps after a tool call before the next step. |
| `recovery_ms` | Time between attempts of a recovered turn. |
| `turn_end_ms` | After the last step until the turn finished. |

The row also stores the turn's frozen dimensions (`status`, `model`,
`provider`, `reasoning_effort`, `latency_mode`, `surface`, `source`,
`created_at`, `started_at`, `finished_at`), counts (`attempts`,
`model_requests`, `tool_calls`), `version` (the computation version) and
`steps`, a JSON array of every step with `kind`, `category`, ISO `start` and
`end`, `ms`, `exclusiveMs` (the part it was charged after overlaps) and, by
kind, `callId`, `name`, `family`, `outcome`, `requestId`, `provider`, `model`
and the model request split. A remote MCP call's step carries its call id,
tool name, start, end and outcome, so a product can join it with its own
server logs.

## Querying

The table is ordinary SQL under the same workspace and session visibility as
the event log.

One turn:

```sql
select * from turn_timing_profiles where workspace_id = $1 and turn_id = $2;
```

Where the time went by model and reasoning effort per day:

```sql
select date_trunc('day', finished_at) as day, model, reasoning_effort,
  count(*) as turns,
  sum(wall_ms) / 1000.0 as wall_s,
  sum(model_inference_ms + model_provider_other_ms + model_network_ms
    + model_unsplit_ms + model_stalled_ms)::float / nullif(sum(wall_ms), 0) as model_share,
  sum(mcp_tool_ms)::float / nullif(sum(wall_ms), 0) as mcp_share,
  percentile_cont(0.95) within group (order by wall_ms) as p95_wall_ms
from turn_timing_profiles
where finished_at >= now() - interval '7 days'
group by 1, 2, 3
order by 1, 2, 3;
```

Slowest tools:

```sql
select step->>'category' as category, step->>'name' as tool,
  count(*) as calls,
  percentile_cont(0.5) within group (order by (step->>'ms')::bigint) as p50_ms,
  percentile_cont(0.95) within group (order by (step->>'ms')::bigint) as p95_ms
from turn_timing_profiles p, jsonb_array_elements(p.steps) step
where p.finished_at >= now() - interval '1 day' and step->>'kind' = 'tool'
group by 1, 2
order by p95_ms desc;
```

Session metadata joins through `session_id`:

```sql
select s.metadata->>'product_area' as area, avg(p.wall_ms) as avg_wall_ms
from turn_timing_profiles p
join sessions s on s.workspace_id = p.workspace_id and s.id = p.session_id
group by 1;
```

## Metrics

Each newly stored profile adds to:

- `opengeni_turn_timing_seconds_total{category,status,model,reasoning_effort}`:
  seconds per category. Divide one category's rate by the sum over categories
  for its share of turn time.
- `opengeni_turn_wall_seconds{status,model}`: a histogram of turn wall time.
- `opengeni_turn_timing_profile_failures_total`: turns whose profile could not
  be computed or stored (each is also logged with its turn id).

`model` uses the same closed label as the other model metrics (configured
models, otherwise `custom`); unknown statuses and efforts are `other`. Metrics
are counted when a profile is first stored, about ten to twenty-five minutes
after the turn finished.

## Backfill

`bun run db:backfill-turn-timing-profiles` profiles every finished turn that
has none, across all workspaces, from the event log. It is idempotent and can
be stopped and restarted. `--workspace <id>` limits it to one workspace and
`--since` / `--until` (ISO dates) to a finish-time window. Archived chats are
skipped because their events have moved to the archive. It does not emit
metrics.

## Cost

Nothing runs on a turn's own path. The sweep reads each finished turn's
attempts and projected events once and writes one row: computing a profile
takes about 1 to 2 ms, and loading, computing and writing measured about 10 ms
per turn against a local database, including a 331-event, fifteen-minute turn.
The finished-turn index (`session_turns_workspace_finished_idx`) keeps the
candidate scan to the recent window.
