/**
 * Real PostgreSQL before/after benchmark. Uses the normal shared Docker harness,
 * or an explicitly supplied disposable local DB via the two KNOWLEDGE_TEST URLs.
 * bun packages/db/test/knowledge-collection-listing.bench.ts [member-count=240] [runs=5] [all|group]
 * Outputs complete timings and EXPLAIN (ANALYZE, BUFFERS) evidence as JSON.
 */
import postgres from "postgres";
import {
  installListingBaseline,
  listingDatabase,
  readListing,
  seedListingFixture,
} from "./fixtures/knowledge-collection-listing";

const count = Number(process.argv[2] ?? 240);
const runs = Number(process.argv[3] ?? 5);
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 10000 ||
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 20
)
  throw new Error("Expected 1..10000 members and 1..20 runs");
const shared = await listingDatabase();
const app = postgres(shared.appUrl, { max: 1, prepare: false });
try {
  await installListingBaseline(shared.admin, shared.appUrl);
  const fixture = await seedListingFixture(shared.admin, count);
  const [server] =
    await app`SELECT version(),current_setting('jit') AS jit,current_setting('shared_buffers') AS shared_buffers`;
  console.log(
    JSON.stringify({ server, members: count, revisionsPerMember: 2, sourceBytes: 96000, runs }),
  );
  const requests = [
    { limit: 20, groupId: fixture.groupId },
    { limit: 20, rootOnly: true },
    { limit: 20 },
  ];
  for (const request of process.argv[4] === "group" ? requests.slice(0, 1) : requests) {
    let expected: unknown;
    for (const baseline of [true, false]) {
      const timesMs: number[] = [];
      for (let i = 0; i <= runs; i++) {
        const start = performance.now();
        const rows = await readListing(app, fixture, request, baseline);
        if (baseline) expected = rows;
        else if (JSON.stringify(rows) !== JSON.stringify(expected))
          throw new Error("Benchmark output parity failed");
        if (i > 0) timesMs.push(performance.now() - start);
      }
      const plan = await app.begin(async (tx) => {
        await tx`SELECT set_config('opengeni.account_id',${fixture.accountId},true),set_config('opengeni.workspace_id',${fixture.workspaceId},true),
          set_config('opengeni.subject_id',${fixture.subjectId},true),set_config('opengeni.principal_kind','human_session',true)`;
        return baseline
          ? tx`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT knowledge_entry_read_baseline(${fixture.accountId},${fixture.workspaceId},${tx.json(fixture.actor)},${tx.json(request)})`
          : tx`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT knowledge_entry_read(${fixture.accountId},${fixture.workspaceId},${tx.json(fixture.actor)},${tx.json(request)})`;
      });
      const sorted = [...timesMs].sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          request,
          baseline,
          timesMs,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          plan,
        }),
      );
    }
  }
} finally {
  await app.end();
  await shared.release();
}
