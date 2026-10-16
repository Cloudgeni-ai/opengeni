# Test shard timing profiles

`run-test-shard.ts` uses deterministic longest-first placement, then runs each
shard's files serially in path order. Timing weights affect placement only: they
never change the impact plan, test assertions, engine matrix, four-shard ceiling,
or the 720-second E2E deadline.

`e2e-shard-profile.json` records completed CI file durations. Its evidence names
the exact source and jobs; a duration includes every browser engine and child
startup/teardown. Do not use a killed file's partial time as its full cost. The
initial startup weight comes from an earlier successful job with identical test
content, not the later aggregate timeout. These are planning observations, not
performance guarantees or cross-source efficacy claims.

The profile is used only when its complete discovered file set, per-file hashes,
platform/architecture, Bun runtime/pin, dependency lock and browser runner match.
A missing, malformed or stale profile falls back to deterministic source-byte
weights and reports the reason. Integration retains its existing service-image
fence. Neither profile is execution or release authority.

To refresh, retain the CI file profiles (or timestamped job logs), record only
successful complete file intervals from file start through the next start or
shard completion, and update the source/job provenance, integer millisecond
weights and corresponding hashes together. Validate with the profile tests and
`run-test-shard.ts --plan <impact-plan> --tier e2e --shard 0 --shards 4 --list-json`;
repeat listing for every shard and confirm the selected union is unchanged.
Re-run the affected complete shard under the unchanged deadline. The wrapper
buffers browser child output, so silence after a file marker alone is not proof
that its build or first test is stuck; inspect the aggregate profile deadline.
