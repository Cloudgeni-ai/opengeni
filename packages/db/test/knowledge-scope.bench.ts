/** Disposable PostgreSQL only: bun packages/db/test/knowledge-scope.bench.ts [members=520] [flat|collection] */
import postgres from "postgres";
import {
  listingDatabase,
  readListing,
  seedListingFixture,
} from "./fixtures/knowledge-collection-listing";
import { installScopeBaseline, readScopeBaseline } from "./fixtures/knowledge-scope-baseline";

const members = Number(process.argv[2] ?? 520);
const shape = process.argv[3] ?? "flat";
if (
  !Number.isInteger(members) ||
  members < 1 ||
  members > 10000 ||
  !["flat", "collection"].includes(shape)
)
  throw new Error("Expected 1..10000 members and flat or collection");
const shared = await listingDatabase();
const app = postgres(shared.appUrl, { max: 1, prepare: false });
try {
  await installScopeBaseline(shared.admin, shared.appUrl);
  const fixture = await seedListingFixture(shared.admin, members, { flat: shape === "flat" });
  await app`SET plan_cache_mode=force_generic_plan`;
  for (const request of [
    { limit: 20 },
    { limit: 20, rootOnly: true },
    { limit: 20, query: "Member", mode: "keyword" },
    { limit: 20, query: "nonexistentterm", mode: "keyword" },
  ]) {
    const samples: Record<string, number[]> = { before: [], after: [] };
    let expected: string | undefined;
    for (let round = 0; round < 7; round++) {
      for (const variant of round % 2 ? ["after", "before"] : ["before", "after"]) {
        const start = performance.now();
        const rows =
          variant === "before"
            ? await readScopeBaseline(app, fixture, request)
            : await readListing(app, fixture, request);
        const ms = performance.now() - start;
        const actual = JSON.stringify(rows);
        expected ??= actual;
        if (expected !== actual) throw new Error("Exact Knowledge response changed");
        if (round > 1) samples[variant]!.push(ms);
      }
    }
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    console.log(
      JSON.stringify({
        members,
        shape,
        request,
        beforeMs: median(samples.before!),
        afterMs: median(samples.after!),
        samples,
      }),
    );
  }
} finally {
  await app.end();
  await shared.release();
}
