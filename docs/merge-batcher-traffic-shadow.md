# Merged-traffic shadow

`scripts/ci/batch-traffic-shadow.ts` samples actual recently merged PR traffic while
agents adopt the normal batcher readiness signal. This is **not queue admission**:
`mergedAt` is explicitly a FIFO readiness proxy, not an assertion that tests or
independent review existed at that time. It never changes the active batcher.

This is a **fixed-count historical composition experiment, not an arrival/service-
time queue simulation**. A cohort can span hours. Observed PR heads may already
contain main landings newer than the pre-cohort base; conflicts or tree differences
from such heads are replay artifacts, not measurements of live queue feasibility,
batch-size throughput or failing PRs. Use a separate empirical discrete-event
simulation for queue latency/capacity questions.

## Read-only replay

```sh
bun scripts/ci/batch-traffic-shadow.ts --once --lookback-hours 24 --max-prs 128 \
  --cap 16 --output ./traffic-shadow --git-dir ./traffic-shadow/objects.git
```

Use Bun 1.4.4 and Git 2.38+. Runtime dependencies are built-ins and Git only. The
existing `GH_TOKEN`/`GITHUB_TOKEN` or GitHub App authentication works through
`GitHubReader`/`GitHubAuth`; never put credentials in output, Git URLs or images.
Default execution is read-only even when `BATCHER_MODE=active` is inherited. The
explicit `--ci-shadow` switch is the only publication opt-in.

Without `--once`, poll at `max(60, BATCHER_POLL_SECONDS)` seconds. SIGINT/SIGTERM stop
polling without cancelling hosted runs. Options have environment equivalents:

| Option | Environment | Default |
| --- | --- | --- |
| `--lookback-hours` | `TRAFFIC_SHADOW_LOOKBACK_HOURS` |24, maximum720 |
| `--cap` | `TRAFFIC_SHADOW_CAP` |16, maximum16 |
| `--max-prs` | `TRAFFIC_SHADOW_MAX_PRS` |128, maximum1000 |
| `--output` | `TRAFFIC_SHADOW_OUTPUT` |`./traffic-shadow` |
| `--git-dir` | `TRAFFIC_SHADOW_GIT_DIR` |`<output>/objects.git` |
| `--once` | `TRAFFIC_SHADOW_ONCE=true` |poll |

`BATCHER_REPOSITORY` selects the repository; only main history is supported.
The bare cache is disposable, owned by this process and rebuildable. For a large
repository it can first be seeded by a **local fetch** from an existing clone;
the program still fetches remote main before replay. Do not point it at another
agent's writable repository/cache. No checkout or historical source execution
occurs: candidates use the existing `GitStore` merge-tree/commit-tree builder.

## Collection and interpretation

- Paginate closed PRs ordered by update time until the lookback boundary; select
  merged main PRs by exact `merged_at`. This is not Search and does not use its
  1,000-result limit. Incomplete pagination fails explicitly. Keep the most recent
  `max-prs`, then sort FIFO; report how many were omitted by this bound.
  Updated-descending pagination is not a consistent snapshot: concurrent PR updates
  can move rows between pages. Cross-check against retained first-parent main commits
  in the committer-time window, report unrepresented commits and selected SHAs absent
  from main, and distinguish known intentionally capped merges when collected metadata
  permits. Unrepresented commits are explicit possible collection gaps, not silently
  treated as complete input; they can also be direct/batch commits or timestamp skew.
  Commit-subject PR numbers are hints, not authoritative associations.
- Preserve PR number, exact observed head, head ref, provider merge SHA, creation
  and merge time. Same-time merges are ordered by actual main first-parent
  position, then PR number. Deduplicate identical records, reject inconsistent
  projections. A reused/changed historical head can cause a disagreement; it is
  not silently replaced with the squash commit.
- Cohorts have at most 16 members. Version PRs are singleton barriers. Actual
  main commits changing any `ADAPTER_PATHS` entry (including the entire `scripts`
  tree) are also singleton barriers: preserve the changing PR in the report,
  but do not let it poison otherwise eligible adjacent FIFO segments. A change
  in an unselected intervening main commit starts a new segment and remains
  visible in collection coverage. Missing/unretained projections are isolated,
  never dropped. This is selection only: every synthetic candidate still passes
  the same unchanged-adapter guard; actual landing bytes are not substituted for
  its observed PR head. Reconstruct
  the base from the first actual merge's first parent, not today's main. Compare
  every synthetic member tree with its actual merge tree and the whole tip with
  the last actual merge. Single-parent landings are labelled squash-or-rebase:
  topology alone does not distinguish them.
- `treeEqual` requires identical tree OIDs. `equivalent` additionally requires
  complete, ordered contiguous first-parent composition and each intermediate
  tree to match. An omitted/direct commit, missing object, unsupported projection,
  conflict or differing tree is reported, never called equivalent. Synthetic
  commit identities are deliberately different from historical landings.
- `historicalHeads` records each observed head's exact main ancestors newer than
  the cohort base. For heads with this temporal leakage, also try merge-tree on
  their actual historical first parent and record whether it is clean and matches
  the actual landed tree. This differentiates packed-history disagreement from
  actual-parent composition without inventing the unavailable historical ready head.
  Even `equivalent=true` only describes the compared trees/composition, not temporal
  validity or a simulated queue admission/service schedule.
- The conflict step identifies where composition failed, **not a unique culprit**.
  Record that exact PR/head as an excluded direct member, then rebuild the viable
  remainder from the original pre-cohort base, repeating if another conflict
  occurs. This is not proof that an excluded PR's changes are absent from later
  dependent heads. Any exclusion makes historical composition non-equivalent,
  even if the final tree happens to match. No bisection/code attribution is invented. Historical CI cancellation and
  infrastructure failures are never treated as a failing PR verdict.
- Query main `ci.yml` push runs by each exact historical merge SHA. Missing runs
  remain missing (including coalesced intermediate tips). Read current-attempt
  jobs for actual start/end bounds, not run `updated_at` as completion. These are
  observed workflow outcomes, not verified Full CI/release-admission receipts.
  Matching trees do not equate batch-selected coverage with historical full CI.

Each observation writes timestamped JSON plus atomically replaced `latest.json`:
input/proxy metadata, candidates/manifests, per-member/tree comparisons, main CI
runs, actual build/collection durations, stage counts, disagreements and optional
publication comparisons. No readiness-to-CI latency is claimed from `mergedAt`.

Each built cohort includes `adapterCheck`: exact base/tip SHAs and the first
failed path, object IDs and reason (changed/invalid, non-tree or unavailable).
The whole-scripts guard deliberately also rejects changed tests/operator helpers.
Segmentation preserves this conservative coverage; it does not promise that every
window has an eligible cohort or that historical composition represents a live queue.

For continuous service retention, the separately reviewed supervisor integration
emits `trafficEvidenceRecords` through its existing structured stdout log sink.
The child output alone is insufficient: that supervisor discards subprocess stdout.
Each successful cycle emits canonical full report JSON as indexed base64 chunks
of at most 64 KiB raw bytes, with a common SHA-256 `reportDigest`, total count and
byte length. Decode chunks individually, concatenate in index order, then verify
SHA-256 of the canonical decoded JSON. Missing chunks mean incomplete evidence,
not a complete retained report. Limit: 2 MiB raw report per cycle (at most 32 chunks);
larger reports emit one explicit `traffic_report_overflow` record and are not
claimed durably retained. No credentials/environment or raw provider responses
are added. Existing provider log retention applies; there is no new cloud store
or API writer. Local JSON remains the full report, with the supervisor's existing
64-file retention. This requires the reviewed wrapper patch in the same-source
image; adding the helper alone does not change a previously deployed supervisor.

`traffic-cache` retains checksummed local GET snapshots (five-minute TTL), completed
attempt job pages only after the exact attempt is terminal, and exact verified
result receipts by batch/tip/run/attempt. These observations can lag; current
capacity checks bypass the cache. At most 200 GitHub API requests per cycle and
600 per hour per controller/cache are allowed, with a shared-token remaining
quota floor of 1,000. Rate/permission responses honor Retry-After and bounded
exponential backoff. The budget persists across restarts. General observation
failures also back off and write `observation-failure.json`; the previous report
then remains historical, not a current green observation. The cache is pruned to
2,048 data entries. Run one polling process per cache; these are not organization-
wide quota reservations. Other shared-token users can still exhaust quota.

Core manifests currently allow only `auto-merge` or `queue-ready` binding enums.
Traffic replay uses `queue-ready` **only as a synthetic transport placeholder**:
its event ID begins `traffic-shadow:merged-at-proxy:`, evidence ID is explicitly
`NOT-ADMISSION-OR-REVIEW-EVIDENCE`, and the report records the real proxy type. Do
not feed these manifests into live admission or represent them as ready labels.

## Optional hosted CI shadow — explicit configuration

```sh
# This command WRITES queue/state refs. It was not run against GitHub in this task.
# Set TRAFFIC_SHADOW_RUNNER_BUDGET and TRAFFIC_SHADOW_MAIN_RESERVE to measured,
# operator-allocated repository capacity and full-main demand, respectively.
# Optional: TRAFFIC_SHADOW_PROVIDER_JOB_LIMIT (default 60) and
# TRAFFIC_SHADOW_OTHER_REPOSITORY_ALLOWANCE (default 28); invalid values hold.
bun scripts/ci/batch-traffic-shadow.ts --ci-shadow --once --lookback-hours 24 \
  --cap 16 --output ./traffic-shadow --git-dir ./traffic-shadow/objects.git
```

The existing `QueueOnlyPublisher` and `AtomicGitWriter` perform one atomic update:

- Create-only `refs/heads/queue/shadow-traffic/<batchId>`.
- Append-only CAS-fenced `refs/heads/batcher-shadow-traffic-state` ledger recording
published batch IDs, proxy bindings, discovery deadlines and terminal records. This is separate from queue/live and
  the normal shadow-ci state ref. An inherited branch-prefix override is ignored.

No main, PR comments, labels, readiness, cancellations, deletions or reruns are
exposed by this path. There is one hosted traffic slot, including the time between
publication and workflow discovery. At most 32 unsettled refs are inspected per
observation; deferred scans prevent publication. Immutable settled SHA tombstones
skip historical API queries; only 32 detailed terminal records/comparisons are
retained. Tombstones and binding deduplication remain in the Git ledger. Ref names
and manifests that cannot be parsed are quarantined/reported rather than blocking
all viable cohorts forever. Known unresolved publications still hold the slot
when inspection fails or their refs disappear/change. Absent runs or any
nonterminal attempt hold the slot. CAS handles concurrent
publishers. Failed/ambiguous pushes are reconciled on the next observation from
remote refs/state; do not blindly retry an external mutation.

After 600 seconds without a discovered run, a publication becomes an explicit
infrastructure block, not an automatic retry/cancellation. An operator must
verify infrastructure is idle, restore a missing/retargeted known ref if needed,
then invoke this explicit one-shot recovery (which records CAS state only):

```sh
bun scripts/ci/batch-traffic-shadow.ts --ci-shadow --recover-no-run <batchId> \
  --recovery-reason 'Verified infrastructure idle; workflow never started' \
  --output ./traffic-shadow --git-dir ./traffic-shadow/objects.git
```

Recovery requires an expired no-run hold, an explicit reason, and fresh headroom;
it cannot recover a nonterminal run or publish another candidate in the same
observation. A later observation may publish new traffic, never resubmit the same
proxy bindings. This acknowledgement is not proof that GitHub cannot deliver a
delayed workflow; investigate the infrastructure before recovery. State-only CAS
updates also persist terminal observations and scan progress.

Publication is disabled unless both runner-budget variables are positive integers.
Fresh bounded run/job queries must show room for the full-main reserve plus current
other workflow demand and 18 conservative candidate slots. Demand is the count of
`queued`, `in_progress` and `requested` jobs; approval-waiting, concurrency-pending
and completed jobs and runs without jobs reserve nothing, and an unrecognized job
status holds. The scan is shared with the batcher (see the headroom section of
[merge-batcher.md](merge-batcher.md)): every active status is listed twice,
runs listed as `completed` are skipped (a `completed` Batch CI listing no longer
blocks publication), runs proven approval-only (`waiting` in every listing, at
least one `waiting` job, all other jobs `pending` or `completed`) are excluded
from the 32-run cap, which still applies to every other active run, and at most
64 active runs are scanned per observation within a 120-second deadline; larger
backlogs hold. One observation costs up to 74 uncached requests (10 run-list plus
64 job pages) against the 200-per-cycle and 600-per-hour read budgets above;
exhausting them backs off and holds. Any active Batch CI or incomplete capacity
scan blocks publication,
and unpublished or no-run traffic candidates keep their own occupancy hold. The
budget is an operator allocation, not a discovered GitHub/custom quota; reserve for
other organization consumers outside this repository separately.

The traffic reader applies the same pool checks as the batcher (see the
headroom section of [merge-batcher.md](merge-batcher.md)). It holds while any active
full-main run is before its fan-out (at most the 3 pre-plan jobs and not proven
approval-only) or has jobs `queued` or `requested`. It also requires observed
repository demand plus the other-repository allowance (default 28, a measured
maximum, not an observation of other repositories) plus 18 to fit the hosted job
limit (default 60). The report's `publication.headroom.capacity` records the
limit, allowance, required total, hold reason, `mainQueuedJobs`,
`preFanoutMainRuns` and newest-main queue waits.

Actions
scheduling is not transactionally fenced by the Git CAS, so this observation is
not a provider capacity reservation. Waiting, pending and job-less runs can start
requesting runners after observation; that race is bounded by the same caveat.

The candidate's **pre-cohort base must already contain the Batch CI adapter**.
Pin the entire `scripts` tree (all merge-batcher core, impact, profile, shard and
transitive script files), the Batch CI workflow, `.bun-version`, `package.json`
and `bun.lock` unchanged in the candidate. This deliberately conservative guard
also blocks unrelated script changes. `adapterCoverage` states its boundary:
workspace package sources, other configuration and third-party action/image bytes
are not an exhaustive pinned execution closure. The program never
overlays today's verifier on a historical tree. Viable rebuilt remainders may
publish, but their historical outcomes remain explicitly non-comparable. Before the adapter lands on main, this intentionally reports a wait;
read-only historical replay still produces useful candidates. The shipped
`.github/workflows/batch-ci.yml` `queue/**` trigger handles this namespace.

No exact candidate or previously published proxy binding is automatically
published again after a restart or rolling-window regrouping. A cohort partly
overlapping already published traffic is skipped rather than charging hosted CI
twice. Completed candidates are compared through `GitHubReader.runs`, which uses
the existing exact batch-result artifact verifier (batch ID, tip, run and attempt).
Wrong/missing receipts cannot be green. Only exact trusted success/code-failure
results and equivalent trees permit a coarse comparison with one unambiguous
historical success/failure run; this is not proof of identical coverage or PR blame.

The one-slot guarantee covers coordinated traffic publishers. Manual external
reruns or writers outside the state-ref protocol are not atomically fenced by
GitHub Actions; do not operate competing writers/reruns in this namespace. Queue
publication/App/ruleset permissions remain an operator prerequisite, not something
the tool grants itself. Explicit state/prefix configuration establishes parity, not
additional authority or an extra approval workflow. No cloud service or database is required.

## Tests

```sh
bun test scripts/ci/batch-traffic-shadow.test.ts --max-concurrency=2
```

Real bare-Git fixtures cover squash/true-merge replay, conflicts, gaps, FIFO/proxy
semantics, provider pagination/CI job timing, immutable read-only refs, restart
deduplication, CAS races, namespace restrictions, old-adapter waits and exact
outcome comparison. All publication tests use local bare remotes, never GitHub.
Additional regressions cover exact-head exclusion/rebuild, quarantine, durable
no-run deadlines and recovery, active-run preservation, lost push acknowledgements,
bounded scan progress, missing refs, full-main headroom, persistent rate backoff,
and terminal-attempt versus mutable observation caching. Compare cap16 (default)
with an explicit cap8 replay of the same retained input and frozen main snapshot;
do not interpret different sampling windows as batching improvements.

The default core `queue/` reader must ignore nested `queue/shadow-traffic/` refs;
the core worker owns that exact/direct-prefix fix. To test interoperability with
an available core implementation without editing it, set
`TRAFFIC_SHADOW_CORE_MODULES` to a directory containing its `controller.ts`,
`git.ts`, `github.ts` and dependencies. The opt-in integration test uses local bare
Git only, checks default-prefix exclusion and explicit-traffic-prefix recognition,
and performs no provider reads/writes. Until that core fix is integrated, traffic
publication can disrupt the old normal reader and must remain off.
