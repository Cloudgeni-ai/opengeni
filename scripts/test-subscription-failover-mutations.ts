/** B1 no-network/local-PostgreSQL mutation evidence. Mechanical mutations
 * restore exact source bytes in finally. Run only in an idle checkout:
 * OPENGENI_REQUIRE_REAL_DB=1 OPENGENI_TEST_PG_URL=<local cluster>
 * bun scripts/test-subscription-failover-mutations.ts <evidence-directory>
 * The full PostgreSQL file preserves its rolling-index fixture sequence.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const output = process.argv[2];
const url = new URL(process.env.OPENGENI_TEST_PG_URL ?? "postgres://invalid");
if (
  !output ||
  process.env.OPENGENI_REQUIRE_REAL_DB !== "1" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
)
  throw new Error("Specify an evidence directory and a real LOCAL PostgreSQL cluster");
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
const world = "packages/db/src/subscription-core/failover-world.ts";
const placement = "packages/db/src/subscription-core/failover.ts";
const readiness = "packages/db/src/subscription-core/failover-readiness.ts";
const requests = "packages/db/src/subscription-core/requests.ts";
const pg = "packages/db/test/subscription-core-failover-postgres.test.ts";
const unit = "packages/db/test/subscription-core-failover.test.ts";
type Mutation = {
  id: string;
  file: string;
  before: string;
  after: string;
  testName: string;
  unit?: boolean;
};
const mutations: Mutation[] = [
  {
    id: "ignore-first-insert-serialization",
    file: world,
    before: "if (lockBindings)\n      await tx.execute(sql`select pg_advisory_xact_lock",
    after: "if (false)\n      await tx.execute(sql`select pg_advisory_xact_lock",
    testName: "D-33 first-insert serialization",
  },
  {
    id: "uncertain-catalog-is-ready",
    file: readiness,
    before: "rows[0]!.known === true",
    after: "rows[0]!.known !== true",
    testName: "D-46 catalog uncertainty",
    unit: true,
  },
  {
    id: "ignore-default-off",
    file: world,
    before: 'if (request.crossProviderFailoverEnabled !== true) return { status: "home_only" };',
    after: "",
    testName: "D-43 disabled failover world",
    unit: true,
  },
  {
    id: "ignore-attempt-generation",
    file: placement,
    before: "Number(row.execution_generation) === request.executionGeneration",
    after: "true",
    testName: "D-33 attempt-fence parity",
    unit: true,
  },
  {
    id: "ignore-live-route",
    file: readiness,
    before: "return (await readSubscriptionCoreProviderRoute(scoped, {",
    after: "return provider;\n      return (await readSubscriptionCoreProviderRoute(scoped, {",
    testName: "D-34 no receipt",
  },
  {
    id: "ignore-kind",
    file: readiness,
    before: "rows[0]!.connection_kind !== subscriptionCoreConnectionKind(provider)",
    after: "false",
    testName: "D-34 unreadable readiness",
  },
  {
    id: "ignore-rolling-index",
    file: readiness,
    before: "rows[0]!.blocked === false",
    after: "true",
    testName: "D-46 rolling uniqueness",
  },
  {
    id: "ignore-only-model",
    file: world,
    before: "(!binding?.onlyThisModel || binding.modelId === model.id)",
    after: "true",
    testName: "D-46 target pin filters",
  },
  {
    id: "ignore-target-pin",
    file: world,
    before: "binding.connectionId === connection.id,",
    after: "true,",
    testName: "D-46 target pin filters",
  },
  {
    id: "ignore-frozen-pool",
    file: world,
    before: "const frozenRows = unrestricted",
    after: "const frozenRows = true",
    testName: "D-42 frozen target shared pools",
  },
  {
    id: "ignore-personal-fallback",
    file: world,
    before: "if (!personalFallbackActive(input))",
    after: "if (false)",
    testName: "D-12/D-28 personal home precedes",
  },
  {
    id: "ignore-model-entitlement",
    file: world,
    before: "connection.observedModelSlugs!.includes(model.upstreamModelId)",
    after: "true",
    testName: "D-35 per-model upstream entitlement",
  },
  {
    id: "ignore-current-turn-continuity",
    file: placement,
    before: "serving.thisTurn &&",
    after: "false &&",
    testName: "D-36 current-turn serving revision",
  },
  {
    id: "ignore-previous-turn-continuity",
    file: world,
    before: "if (!previous) return home;",
    after: "return home;\n  if (!previous) return home;",
    testName: "D-36 continuity keeps warm fallback",
  },
  {
    id: "ignore-foreign-live-lease",
    file: placement,
    before:
      'return existing.live ? { kind: "lease_busy", leasedUntil: existing.leasedUntil } : null;',
    after: "return null;",
    testName: "D-33 older foreign lease",
  },
  {
    id: "ignore-refusal-count",
    file: placement,
    before: "return count;",
    after: "return 0;",
    testName: "D-39 refusal count",
  },
  {
    id: "ignore-health-deadline",
    file: placement,
    before: "return deadlines.length ? new Date(Math.min(...deadlines)) : null;",
    after: "return null;",
    testName: "D-41 reports earliest reset",
  },
  {
    id: "ignore-commit-clock-cas",
    file: placement,
    before: "(seen.lastModelCallAt?.getTime() ?? 0) === decided.lastModelCallAt",
    after: "true",
    testName: "D-33 parity copies preserve",
  },
  {
    id: "ignore-context-clear",
    file: world,
    before: "type = 'session.context.cleared'",
    after: "type = 'session.context.never'",
    testName: "D-33 parity copies preserve",
  },
  {
    id: "typed-closed-source-exemption",
    file: requests,
    before: "and request.provider = ${providerId} and attempt.state = 'closed'",
    after: "and attempt.state = 'closed'",
    testName: "D-38 unresolved source requests",
  },
  {
    id: "sql-closed-source-exemption",
    file: pg,
    before: "fixture = failoverFixture(shared, [home, target], models);",
    after: `fixture = failoverFixture(shared, [home, target], models);
  const [mutatedRoutine] = await shared.admin<{ definition: string }[]>\
    \`select pg_get_functiondef('opengeni_private.guard_subscription_disconnect_admission()'::regprocedure) as definition\`;
  const anchor = "AND prior.provider = NEW.provider AND attempt.state = 'closed'";
  if (mutatedRoutine!.definition.split(anchor).length !== 2) throw new Error('SQL mutation anchor drift');
  await shared.admin.unsafe(mutatedRoutine!.definition.replace(anchor, "AND attempt.state = 'closed'"));`,
    testName: "D-38 unresolved source requests",
  },
];

async function run(testFile: string) {
  const child = Bun.spawn(["bun", "test", `./${testFile}`], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, text: `${stdout}\n${stderr}` };
}
async function restore(file: ReturnType<typeof Bun.file>, original: string, mutated: string) {
  if ((await file.text()) !== mutated)
    throw new Error("Concurrent source edit: refusing restoration");
  await Bun.write(file, original);
}
for (const file of [unit, pg]) {
  const result = await run(file);
  await Bun.write(resolve(directory, `baseline-${file.split("/").at(-1)}.log`), result.text);
  if (result.exitCode !== 0) throw new Error(`Baseline failed: ${file}`);
}
const results: Array<{ id: string; testName: string; killed: boolean }> = [];
for (const mutation of mutations) {
  const file = Bun.file(mutation.file);
  const original = await file.text();
  if (original.split(mutation.before).length !== 2)
    throw new Error(`Nonunique mutation anchor: ${mutation.id}`);
  const mutated = original.replace(mutation.before, mutation.after);
  try {
    await Bun.write(file, mutated);
    const result = await run(mutation.unit ? unit : pg);
    await Bun.write(resolve(directory, `${mutation.id}.log`), result.text);
    const killed =
      result.exitCode !== 0 &&
      result.text
        .split("\n")
        .some((line) => line.includes("(fail)") && line.includes(mutation.testName));
    results.push({ id: mutation.id, testName: mutation.testName, killed });
    console.log(`${killed ? "KILLED" : "SURVIVED"} ${mutation.id}: ${mutation.testName}`);
    if (!killed)
      throw new Error(`Mutation survived or failed outside intended case: ${mutation.id}`);
  } finally {
    await restore(file, original, mutated);
  }
}
await Bun.write(resolve(directory, "results.json"), JSON.stringify(results, null, 2));
