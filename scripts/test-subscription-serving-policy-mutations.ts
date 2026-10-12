/** C1 targeted mutation evidence. Run in an otherwise idle checkout:
 * OPENGENI_REQUIRE_REAL_DB=1 OPENGENI_TEST_PG_URL=<local test cluster>
 * bun scripts/test-subscription-serving-policy-mutations.ts <evidence-directory>
 *
 * Mechanical, exact-anchor mutations only; each source is restored in finally.
 * The RLS mutation changes only the disposable test database's schema, through
 * fixture setup, never a migration or an assertion. No external model calls.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const output = process.argv[2];
const url = new URL(process.env.OPENGENI_TEST_PG_URL ?? "postgres://invalid");
if (
  !output ||
  process.env.OPENGENI_REQUIRE_REAL_DB !== "1" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
) {
  throw new Error("Specify an evidence directory and a real LOCAL PostgreSQL test cluster");
}
const outputDirectory = resolve(output);
mkdirSync(outputDirectory, { recursive: true });
const contract = "packages/contracts/src/turn-serving-policy.ts";
const configuration = "packages/config/src/index.ts";
const writer = "packages/db/src/subscription-core/serving-policy.ts";
const projection = "apps/worker/src/activities/run-input.ts";
const contractTests = "packages/contracts/test/turn-serving-policy.test.ts";
const configTests = "packages/config/test/turn-serving-policy.test.ts";
const dbTests = "packages/db/test/subscription-core-serving-policy-postgres.test.ts";
const projectionTests = "apps/worker/test/run-input-serving-policy.test.ts";

type Mutation = {
  id: string;
  file: string;
  before: string;
  after: string;
  testFile: string;
  testName: string;
};
const mutations: Mutation[] = [
  {
    id: "malformed-pending-is-absent",
    file: contract,
    before: 'if (!parsed.success) throw new Error("Malformed pending serving policy");',
    after: "if (!parsed.success) return null;",
    testFile: contractTests,
    testName: "D-37 pending validation:",
  },
  {
    id: "pending-target-not-consumed",
    file: writer,
    before: "if (pending) delete metadata[TURN_PENDING_SERVING_POLICY_METADATA_KEY];",
    after: "",
    testFile: dbTests,
    testName: "D-37 pending target is fenced",
  },
  {
    id: "ignore-held-provider-refusals",
    file: writer,
    before: "return count;",
    after: "return 0;",
    testFile: dbTests,
    testName: "D-39 prospective budget",
  },
  {
    id: "schema-extra-fields",
    file: contract,
    before: ".strict()\n  .superRefine((revision, context)",
    after: ".passthrough()\n  .superRefine((revision, context)",
    testFile: contractTests,
    testName: "D-37 schema:",
  },
  {
    id: "duplicate-generations",
    file: contract,
    before: "current.executionGeneration <= previous.executionGeneration",
    after: "current.executionGeneration < previous.executionGeneration",
    testFile: contractTests,
    testName: "D-37 reader:",
  },
  {
    id: "count-every-receipt",
    file: contract,
    before: "return count;",
    after: "return revisions.length;",
    testFile: contractTests,
    testName: "SUB-FAIL-11 D-39:",
  },
  {
    id: "default-on",
    file: configuration,
    before: "subscriptionCrossProviderFailoverEnabled: EnvBoolean.default(false)",
    after: "subscriptionCrossProviderFailoverEnabled: EnvBoolean.default(true)",
    testFile: configTests,
    testName: "D-43 deployment gate",
  },
  {
    id: "skip-definition-check",
    file: configuration,
    before: "return assertTurnExecutionPolicyMatchesConfigV1(settings, policy, {",
    after:
      "return { policy, provider: undefined as never, model: undefined as never };\n  return assertTurnExecutionPolicyMatchesConfigV1(settings, policy, {",
    testFile: configTests,
    testName: "D-37 config checks",
  },
  {
    id: "skip-config-restriction",
    file: configuration,
    before: "if (TurnExecutionPolicyV1.parse(acceptedPolicy).credentialRestriction !== undefined)",
    after: "if (false)",
    testFile: configTests,
    testName: "D-37 configuration refuses",
  },
  {
    id: "inclusive-provenance-boundary",
    file: projection,
    before: "revision.historyPosition >= row.position",
    after: "revision.historyPosition > row.position",
    testFile: projectionTests,
    testName: "SUB-FAIL-08 D-37:",
  },
  {
    id: "ignore-reactive-invalidation",
    file: projection,
    before: "return projectRejectedProviderArtifacts([row]);",
    after: "return [row.item];",
    testFile: projectionTests,
    testName: "SUB-FAIL-08: unattributable",
  },
  {
    id: "project-while-disabled",
    file: projection,
    before: "if (options.enabled !== true) return projectRejectedProviderArtifacts(rows);",
    after: "",
    testFile: projectionTests,
    testName: "D-43: disabled or omitted",
  },
  {
    id: "ignore-requested-generation",
    file: writer,
    before: "const fence = await lockTurnAttemptWriteFenceTx(tx, input);",
    after:
      "input = { ...input, executionGeneration: 1 };\n    const fence = await lockTurnAttemptWriteFenceTx(tx, input);",
    testFile: dbTests,
    testName: "D-37 stale generation",
  },
  {
    id: "retry-reported-as-new",
    file: writer,
    before: "installed: false,",
    after: "installed: true,",
    testFile: dbTests,
    testName: "D-37 idempotent retry",
  },
  {
    id: "count-reclaims-in-db-reader",
    file: writer,
    before: 'return countTurnServingPolicyChangesV1(read.kind === "valid" ? read.revisions : []);',
    after: 'return read.kind === "valid" ? read.revisions.length : 0;',
    testFile: dbTests,
    testName: "SUB-FAIL-11 retried recording",
  },
  {
    id: "hidden-turn-is-zero",
    file: writer,
    before: "if (read === null) return null;",
    after: "if (read === null) return 0;",
    testFile: dbTests,
    testName: "D-37 RLS isolates",
  },
  {
    id: "disable-disposable-rls",
    file: dbTests,
    before: "for (const foreign of [second, otherAccount]) {",
    after:
      "await shared.admin`alter table session_turns disable row level security`;\n    for (const foreign of [second, otherAccount]) {",
    testFile: dbTests,
    testName: "D-37 RLS isolates",
  },
  {
    id: "skip-concurrent-dedupe",
    file: writer,
    before: "if (existing) {",
    after: "if (false) {",
    testFile: dbTests,
    testName: "D-39 concurrent writers",
  },
  {
    id: "ignore-accepted-restriction",
    file: writer,
    before: "if (accepted.policy.credentialRestriction !== undefined)",
    after: "if (false)",
    testFile: dbTests,
    testName: "D-37 restriction and missing",
  },
  {
    id: "write-while-disabled",
    file: writer,
    before:
      'if (input.crossProviderFailoverEnabled !== true) return { accepted: false, reason: "disabled" };',
    after: "",
    testFile: dbTests,
    testName: "D-43 disabled writer",
  },
  {
    id: "allow-placement-transaction",
    file: writer,
    before:
      'if (isTransactionHandle(db))\n    throw new Error("Serving revisions must be recorded outside the placement transaction");',
    after: "",
    testFile: dbTests,
    testName: "D-37 lock order:",
  },
];

async function runTest(testFile: string, testName?: string) {
  const process = Bun.spawn(
    ["bun", "test", `./${testFile}`, ...(testName ? ["--test-name-pattern", testName] : [])],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, text: `${stdout}\n${stderr}` };
}

async function restoreMutation(
  file: ReturnType<typeof Bun.file>,
  original: string,
  mutated: string,
) {
  if ((await file.text()) !== mutated)
    throw new Error("Concurrent edit detected: refusing to overwrite mutation source");
  await Bun.write(file, original);
}

// A passing baseline prevents unavailable fixtures/import errors counting as kills.
for (const testFile of [contractTests, configTests, projectionTests, dbTests]) {
  const result = await runTest(testFile);
  await Bun.write(
    resolve(outputDirectory, `baseline-${testFile.replaceAll("/", "-")}.log`),
    result.text,
  );
  if (result.exitCode !== 0) throw new Error(`Baseline failed: ${testFile}`);
}
const results: Array<{ id: string; testName: string; killed: boolean }> = [];
for (const mutation of mutations) {
  const file = Bun.file(mutation.file);
  const original = await file.text();
  if (original.split(mutation.before).length !== 2)
    throw new Error(`Mutation anchor is not unique: ${mutation.id}`);
  const mutated = original.replace(mutation.before, mutation.after);
  try {
    await Bun.write(file, mutated);
    const result = await runTest(mutation.testFile, mutation.testName);
    await Bun.write(resolve(outputDirectory, `${mutation.id}.log`), result.text);
    const killed =
      result.exitCode !== 0 &&
      result.text
        .split("\n")
        .some((line) => line.includes("(fail)") && line.includes(mutation.testName));
    results.push({ id: mutation.id, testName: mutation.testName, killed });
    console.log(`${killed ? "KILLED" : "SURVIVED"} ${mutation.id}: ${mutation.testName}`);
    if (!killed)
      throw new Error(`Targeted mutation survived (or unrelated failure): ${mutation.id}`);
  } finally {
    await restoreMutation(file, original, mutated);
  }
}
await Bun.write(resolve(outputDirectory, "results.json"), JSON.stringify(results, null, 2));
console.log(
  `${results.length}/${mutations.length} targeted mutations killed; source bytes restored.`,
);
