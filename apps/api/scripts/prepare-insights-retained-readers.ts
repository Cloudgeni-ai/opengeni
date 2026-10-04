/** Copy-only read-definition update; never execute or register a migration. */
import { createHash } from "node:crypto";
import postgres from "postgres";
import { acquireSharedTestDatabase } from "@opengeni/testing";

const receiptPath = process.env.INSIGHTS_DAILY_COPY_RECEIPT;
const out = process.env.INSIGHTS_DAILY_PREPARE_OUT;
if (
  !receiptPath?.startsWith("/workspace/") ||
  !out?.startsWith("/workspace/") ||
  (await Bun.file(out).exists()) ||
  process.env.OPENGENI_TEST_PG_NATIVE !== "1" ||
  process.env.OPENGENI_REQUIRE_REAL_DB !== "1" ||
  process.env.OPENGENI_TEST_PG_URL !== "postgres://postgres:x@127.0.0.1:61440/postgres"
)
  throw new Error("New local output and the required native fixture are required; no replay");
const copy = await Bun.file(receiptPath).json();
const fixture = await Bun.file("/workspace/insights-raw-http-fixture.json").json();
if (
  fixture.database !== "og_insights_http_scale_1a6870920e21" ||
  !fixture.seeded ||
  copy.originalDatabase !== fixture.database ||
  !copy.copyCreated ||
  !copy.countsAndForceEqual ||
  copy.lineage?.kind !== "completed-dirty-benchmark-physical-copy" ||
  copy.lineage.inheritedLabWrites !== 42 ||
  copy.after?.counts?.facts !== "838042" ||
  copy.after?.counts?.usage !== "4170042" ||
  !/^og_insights_daily_http_[a-f0-9]{12}$/.test(copy.database) ||
  copy.database === copy.template
)
  throw new Error("An attested new descendant copy with its unchanged 42 lab records is required");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const head = () =>
  Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
const sourceHead = head();
const replacementNames = ["insights_charge_window", "insights_rollup_amount_inputs"];
type Routine = {
  name: string;
  signature: string;
  definition: string;
  oid: number;
  owner: string;
  security: Record<string, unknown>;
};
const inventory = async (db: postgres.Sql): Promise<Routine[]> =>
  await db`select p.proname as name,pg_get_function_identity_arguments(p.oid) as signature,
    pg_get_functiondef(p.oid) as definition,p.oid::int as oid,pg_get_userbyid(p.proowner) as owner,
    jsonb_build_object('owner',p.proowner,'acl',p.proacl,'securityDefiner',p.prosecdef,
      'config',p.proconfig,'volatility',p.provolatile,'language',p.prolang) as security
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='opengeni_private' and p.proname like 'insights_%'
    order by p.proname,signature`;
const snapshot = async (db: postgres.Sql) => ({
  counts: (
    await db`select
      (select count(*)::text from model_call_facts) facts,
      (select count(*)::text from usage_events) usage,
      (select count(*)::text from usage_events where event_type='sandbox.warm_seconds') warm,
      (select count(*)::text from credit_ledger_entries) ledger,
      (select count(*)::text from sessions) sessions,
      (select sum(priced_cost_micros)::text from model_call_facts) requested,
      (select sum(estimated_provider_cost_micros)::text from model_call_facts) list,
      (select sum(amount_micros)::text from credit_ledger_entries) actual`
  )[0],
  force: [
    ...(await db`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where oid in('model_call_facts'::regclass,'usage_events'::regclass,
        'credit_ledger_entries'::regclass,'sessions'::regclass) order by relname`),
  ],
  history: [...(await db`select name from schema_migrations order by name`)],
});
const pending = async (db: postgres.Sql) => [
  ...(await db`select workspace_id,count(*)::int as marks
    from opengeni_private.insights_rollup_invalidations where account_id=${fixture.accountId}
    group by workspace_id order by workspace_id`),
];
const summarize = (routines: Routine[]) =>
  routines.map(({ definition, ...metadata }) => ({
    ...metadata,
    definitionSha256: sha256(definition),
  }));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const target = postgres(`postgres://postgres:x@127.0.0.1:61440/${copy.database}`, { max: 1 });
const original = postgres(`postgres://postgres:x@127.0.0.1:61440/${fixture.database}`, { max: 1 });
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  sourceHead,
  scriptSha256: sha256(await Bun.file(import.meta.path).text()),
  database: copy.database,
  receiptSha256: sha256(await Bun.file(receiptPath).text()),
  inheritedLabWrites: 42,
  seedOrMigrationReplay: false,
  schemaMigrationHistoryMutation: false,
  ownerReconciliationBudget: 10_000_000,
  completed: false,
};
const persist = () => Bun.write(out, JSON.stringify(evidence, null, 2));
let reference: Awaited<ReturnType<typeof acquireSharedTestDatabase>> = null;
try {
  const before = await snapshot(target);
  const originalBefore = await snapshot(original);
  if (!same(before, copy.after)) throw new Error("New copy source data changed before preparation");
  const prior = await inventory(target);
  reference = await acquireSharedTestDatabase("insights-reader-definition-reference");
  if (!reference) throw new Error("Required real PostgreSQL reference schema unavailable");
  const expected = await inventory(reference.admin);
  if (
    prior.length !== 25 ||
    expected.length !== prior.length ||
    !same(
      prior.map(({ name, signature }) => ({ name, signature })),
      expected.map(({ name, signature }) => ({ name, signature })),
    ) ||
    prior.some(
      (routine, index) =>
        !replacementNames.includes(routine.name) &&
        routine.definition !== expected[index]!.definition,
    )
  )
    throw new Error("Only the two approved reader definitions may differ from the source fixture");
  const replacements = expected.filter((routine) => replacementNames.includes(routine.name));
  if (
    replacements.length !== 2 ||
    replacements.some(
      ({ signature, definition }) =>
        signature !==
          "a uuid, w uuid, lo timestamp with time zone, hi timestamp with time zone, granularity text" ||
        !definition.startsWith("CREATE OR REPLACE FUNCTION opengeni_private.insights_"),
    )
  )
    throw new Error("Expected exact native reader definitions and signatures");
  const owner = prior.find((routine) => routine.name === replacementNames[0])!.owner;
  if (owner !== fixture.ownerRole || !/^[a-z0-9_]+$/.test(owner))
    throw new Error("Only the preserved schema owner may replace copied readers");
  evidence.before = before;
  evidence.routinesBefore = summarize(prior);
  evidence.referenceRoutines = summarize(expected);
  evidence.pendingBefore = await pending(target);
  await persist();
  const replaceStarted = performance.now();
  await target.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${owner}"`);
    await tx`set local lock_timeout='5s'`;
    for (const routine of replacements) await tx.unsafe(routine.definition);
  });
  evidence.readerDefinitionsReplaced = replacements.map(({ name }) => name);
  evidence.replaceElapsedMs = performance.now() - replaceStarted;
  const installed = await inventory(target);
  evidence.securityPreserved = prior.every(
    (routine, index) =>
      routine.oid === installed[index]!.oid && same(routine.security, installed[index]!.security),
  );
  evidence.otherRoutinesUnchanged = prior.every(
    (routine, index) =>
      replacementNames.includes(routine.name) ||
      routine.definition === installed[index]!.definition,
  );
  evidence.allDefinitionsMatchSource = expected.every(
    (routine, index) => routine.definition === installed[index]!.definition,
  );
  if (
    !evidence.securityPreserved ||
    !evidence.otherRoutinesUnchanged ||
    !evidence.allDefinitionsMatchSource
  )
    throw new Error("Copied reader provenance or security did not remain exact");
  await persist();
  const marks = await pending(target);
  if (marks.some((row) => row.workspace_id !== fixture.workspaceId))
    throw new Error("Unexpected pending scope; no broader reconciliation authorized");
  const reconcileStarted = performance.now();
  evidence.reconciliationStartedAt = new Date().toISOString();
  await persist();
  evidence.reconciliation = await target.begin("isolation level repeatable read", async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${owner}"`);
    await tx`set local statement_timeout='10min'`;
    await tx`set local lock_timeout='5s'`;
    return await tx`select opengeni_private.insights_reconcile_rollups(
      ${fixture.accountId},${fixture.workspaceId},10000000) as consumed_marks`;
  });
  evidence.reconciliationElapsedMs = performance.now() - reconcileStarted;
  evidence.pendingAfter = await pending(target);
  evidence.after = await snapshot(target);
  evidence.routinesAfter = summarize(await inventory(target));
  evidence.sourceDataUnchanged = same(before, evidence.after);
  evidence.originalUnchanged = same(originalBefore, await snapshot(original));
  evidence.sourceEndHead = head();
  if (
    !evidence.sourceDataUnchanged ||
    !evidence.originalUnchanged ||
    !same(evidence.pendingAfter, []) ||
    evidence.sourceEndHead !== sourceHead
  )
    throw new Error(
      "Source, history, original or exact-head checks failed after copy-only preparation",
    );
  evidence.completed = true;
  evidence.completedAt = new Date().toISOString();
  await persist();
  console.log(
    JSON.stringify({
      database: copy.database,
      completed: true,
      replaceElapsedMs: evidence.replaceElapsedMs,
      reconciliationElapsedMs: evidence.reconciliationElapsedMs,
      sourceDataUnchanged: true,
      originalUnchanged: true,
    }),
  );
} catch (error) {
  evidence.failure = { message: (error as Error).message, at: new Date().toISOString() };
  await persist();
  throw error;
} finally {
  await reference?.release();
  await target.end();
  await original.end();
}
