# PR browser and E2E selection

`pr-fast-plan.ts` also chooses which of Batch's E2E files and browser
acceptance lanes PR CI runs (`docs/main-ci.md`, "PR CI"). It starts from the
impact plan, so the PR never runs a test Batch would not, and records its
choice in the plan's `prBrowserE2e` summary:

- authored tests first: a changed E2E or browser acceptance test, or one that
  imports (transitively, through relative imports outside workspaces) a
  changed helper or fixture. They select their browser acceptance lanes, and
  E2E files use up to `PR_E2E_BUDGET_SECONDS`;
- then E2E tests whose own or declared workspaces a changed file belongs to,
  cheapest first, within `PR_E2E_DIRECT_BUDGET_SECONDS` (about one shard);
- shard count is the estimate over `PR_E2E_SHARD_TARGET_SECONDS`, at most
  `PR_E2E_SHARD_CAP`. Estimates come from `e2e-shard-profile.json`; without
  a usable profile a file counts as one minute.

Batch impact is transitive, so most product PRs select nearly every browser
test there. Running all of them on each PR push would add about eleven jobs
per run; this selection keeps the PR cost near one job per run. Tests that
do not fit are listed as deferred and still run in Batch.

# Test shard timing profiles

`run-test-shard.ts` uses deterministic longest-first placement, then runs each
shard's files serially in path order. Timing weights affect placement only: they
never change the impact plan, test assertions, engine matrix, eight-shard ceiling,
or the 720-second E2E deadline.

`e2e-shard-profile.json` records completed CI file durations. Its evidence names
the exact source and jobs; a duration includes every browser engine and child
startup/teardown. Do not use a killed file's partial time as its full cost. The
current weights pool every successful shard job on main or a merge-batcher batch
with identical file
content, dependency lock, Bun pin and browser runner; each file's weight is its
lower-median observed interval, and `fileSources` names the job that observed
it. These are planning observations, not performance guarantees or
cross-source efficacy claims.

The profile is used only when its schema, tier, units and platform/architecture
match; a missing or malformed profile falls back to deterministic source-byte
weights and reports the reason. A Bun runtime/pin, dependency lock, browser
runner or service-image change keeps the measured times and reports what
drifted: those changes shift file times a little, while source-byte weights put
the slowest suites together and overrun the shard deadline. Test files are
fenced one by one: a file whose content changed keeps its last measured time,
a new file is estimated from its size at
the profile's median milliseconds per byte, and a removed file is ignored, so
ordinary test edits never discard every other file's timing. Refresh the
profile when many files or the toolchain have drifted. Neither profile is
execution or release authority.

To refresh, retain the CI file profiles (or timestamped job logs), record only
successful complete file intervals from file start through the next start or
shard completion, and update the source/job provenance, integer millisecond
weights and corresponding hashes together. Validate with the profile tests and
`run-test-shard.ts --plan <impact-plan> --tier e2e --shard 0 --shards 8 --list-json`;
repeat listing for every shard and confirm the selected union is unchanged.
Re-run the affected complete shard under the unchanged deadline. The wrapper
buffers browser child output, so silence after a file marker alone is not proof
that its build or first test is stuck; inspect the aggregate profile deadline.
