/** Compare exact current read responses with the old/new recursive visibility plan.
 * bun packages/db/test/knowledge-visibility.bench.ts [members=240] [runs=5]
 * Uses only the disposable PostgreSQL fixture, never a live application database.
 */
import postgres from "postgres";
import {
  listingDatabase,
  readListing,
  seedListingFixture,
} from "./fixtures/knowledge-collection-listing";
import {
  installVisibilityBaseline,
  readVisibilityBaseline,
} from "./fixtures/knowledge-visibility-baseline";

const members = Number(process.argv[2] ?? 240);
const runs = Number(process.argv[3] ?? 5);
if (
  !Number.isInteger(members) ||
  members < 1 ||
  members > 10000 ||
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 20
)
  throw new Error("Expected 1..10000 members and 1..20 runs");
const shared = await listingDatabase();
const app = postgres(shared.appUrl, { max: 1, prepare: false });
try {
  await installVisibilityBaseline(shared.admin, shared.appUrl);
  const fixture = await seedListingFixture(shared.admin, members);
  await app`SET plan_cache_mode = force_generic_plan`;
  for (const request of [
    { limit: 20 },
    { limit: 20, rootOnly: true },
    { limit: 20, groupId: fixture.groupId },
  ]) {
    const times: Record<string, number[]> = { before: [], after: [] };
    let expected: string | undefined;
    for (let iteration = 0; iteration <= runs; iteration++) {
      for (const variant of ["before", "after"]) {
        const start = performance.now();
        const rows =
          variant === "before"
            ? await readVisibilityBaseline(app, fixture, request)
            : await readListing(app, fixture, request);
        const elapsed = performance.now() - start;
        expected ??= JSON.stringify(rows);
        if (JSON.stringify(rows) !== expected) throw new Error("Knowledge response parity failed");
        if (iteration > 0) times[variant]!.push(elapsed);
      }
    }
    console.log(JSON.stringify({ members, request, runs, times }));
  }
} finally {
  await app.end();
  await shared.release();
}
