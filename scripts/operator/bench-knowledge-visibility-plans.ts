/** Local, disposable real-PostgreSQL comparison; never point at production. */
import postgres from "postgres";
import {
  listingDatabase,
  seedListingFixture,
} from "../../packages/db/test/fixtures/knowledge-collection-listing";
import { installKnowledgeVisibilityPlanBaseline } from "../../packages/db/test/fixtures/knowledge-visibility-plan-baseline";

const shared = await listingDatabase();
const planMode = process.env.OPENGENI_BENCH_PLAN_MODE ?? "auto";
if (!["auto", "force_custom_plan", "force_generic_plan"].includes(planMode))
  throw new Error("Invalid benchmark plan mode");
const app = postgres(shared.appUrl, {
  max: 1,
  prepare: false,
  connection: { plan_cache_mode: planMode },
});
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  await installKnowledgeVisibilityPlanBaseline(shared.admin, shared.appUrl);
  for (const members of [0, 1, 240]) {
    const fixture = await seedListingFixture(shared.admin, members);
    for (const [shape, request] of [
      ["list", { operation: "list", limit: 20 }],
      ["roots", { operation: "list", rootOnly: true, limit: 20 }],
      ["collection", { operation: "list", groupId: fixture.groupId, limit: 20 }],
    ] as const) {
      const times = { base: [] as number[], candidate: [] as number[] };
      const cpus = { base: [] as number[], candidate: [] as number[] };
      let reference: string | undefined;
      for (let sample = -3; sample < 30; sample++) {
        for (const variant of sample % 2 === 0
          ? (["base", "candidate"] as const)
          : (["candidate", "base"] as const)) {
          const cpu = process.cpuUsage();
          const start = performance.now();
          const value = await app.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.account_id',${fixture.accountId},true),set_config('opengeni.workspace_id',${fixture.workspaceId},true),
              set_config('opengeni.subject_id',${fixture.subjectId},true),set_config('opengeni.principal_kind','human_session',true)`;
            const [row] =
              variant === "base"
                ? await tx`SELECT knowledge_entry_read_before_plan(${fixture.accountId},${fixture.workspaceId},${tx.json(fixture.actor)},${tx.json(request)}) AS result`
                : await tx`SELECT knowledge_entry_read(${fixture.accountId},${fixture.workspaceId},${tx.json(fixture.actor)},${tx.json(request)}) AS result`;
            return row!.result;
          });
          const elapsed = performance.now() - start;
          const used = process.cpuUsage(cpu);
          const serialized = JSON.stringify(value);
          if (reference === undefined) reference = serialized;
          if (reference !== serialized)
            throw new Error(`Different results: ${members} ${shape} ${variant}`);
          if (sample >= 0) {
            times[variant].push(elapsed);
            cpus[variant].push((used.user + used.system) / 1000);
          }
        }
      }
      console.log(
        JSON.stringify({
          members,
          planMode,
          shape,
          samples: 30,
          equalResults: true,
          medianMs: { base: median(times.base), candidate: median(times.candidate) },
          clientCpuMs: { base: median(cpus.base), candidate: median(cpus.candidate) },
          decodedJsonBytes: Buffer.byteLength(reference!),
        }),
      );
    }
  }
} finally {
  await app.end();
  await shared.release();
}
