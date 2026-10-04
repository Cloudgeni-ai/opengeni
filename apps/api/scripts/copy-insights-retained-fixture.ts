/** One-shot isolated physical copy, or explicitly requested read-only reattestation. */
import postgres from "postgres";
import { createHash } from "node:crypto";

const fixture = await Bun.file("/workspace/insights-raw-http-fixture.json").json();
const out = process.env.INSIGHTS_DAILY_COPY_RECEIPT;
const template =
  process.env.INSIGHTS_DAILY_COPY_TEMPLATE ?? "og_insights_daily_bootstrap_1a6870920e21";
const parentPath = process.env.INSIGHTS_DAILY_COPY_COMPLETED_DIRTY_RECEIPT;
const parentSha256 = process.env.INSIGHTS_DAILY_COPY_COMPLETED_DIRTY_SHA256;
const parentText = parentPath ? await Bun.file(parentPath).text() : null;
const parent = parentText ? JSON.parse(parentText) : null;
const retainedTemplates = [
  "og_insights_daily_bootstrap_1a6870920e21",
  "og_insights_http_cache_1a6870920e21",
];
const attest = process.argv.includes("--attest-after-migrations");
if (
  parent &&
  (!parentPath?.startsWith("/workspace/") ||
    !/^[a-f0-9]{64}$/.test(parentSha256 ?? "") ||
    createHash("sha256").update(parentText!).digest("hex") !== parentSha256 ||
    !parent.completed ||
    parent.mode !== "dirty" ||
    !parent.originalUnchanged ||
    !parent.copyExactDeliberateDirtyDelta ||
    !/^[a-f0-9]{40}$/.test(parent.measuredEndHead ?? "") ||
    parent.measuredStartHead !== parent.measuredEndHead ||
    JSON.stringify(parent.sourceStart) !== JSON.stringify(parent.sourceEnd) ||
    parent.physicalCopy?.database !== template ||
    parent.physicalCopy.originalDatabase !== fixture.database ||
    !retainedTemplates.includes(parent.physicalCopy.template) ||
    !parent.physicalCopy.countsAndForceEqual ||
    !/^og_insights_daily_http_[a-f0-9]{12}$/.test(template) ||
    parent.before?.counts?.facts !== "838000" ||
    parent.before?.counts?.usage !== "4170000" ||
    parent.dirtyWrites?.length !== 42 ||
    parent.dirtyWrites.some(
      (write: {
        committed?: boolean;
        requestedMicros?: number;
        recordedListMicros?: number;
        actualDebitMicros?: number;
        warmUsageQuantity?: number;
      }) =>
        write.committed !== true ||
        write.requestedMicros !== 101 ||
        write.recordedListMicros !== 73 ||
        write.actualDebitMicros !== 1 ||
        write.warmUsageQuantity !== 1,
    ) ||
    parent.cases?.length !== 2 ||
    parent.cases.some(
      (entry: { successfulRequests?: number; errors?: number; subsequentSamples?: number }) =>
        entry.successfulRequests !== 21 || entry.errors !== 0 || entry.subsequentSamples !== 20,
    ))
)
  throw new Error("A hash-verified completed 42-write retained-volume benchmark is required");
if (
  !out?.startsWith("/workspace/") ||
  fixture.database !== "og_insights_http_scale_1a6870920e21" ||
  !fixture.seeded ||
  fixture.ownerRole !== `${fixture.database}_owner` ||
  (!retainedTemplates.includes(template) && !parent)
)
  throw new Error("Exact retained fixture, allowed template and workspace receipt required");
if ((await Bun.file(out).exists()) !== attest)
  throw new Error(
    "Existing copy/output is not permission to replay cloning; use explicit read-only attestation",
  );
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
    where oid in('model_call_facts'::regclass,'usage_events'::regclass,'credit_ledger_entries'::regclass,'sessions'::regclass)
    order by relname`),
  ],
  history: [...(await db`select name from schema_migrations order by name`)],
});
const root = postgres("postgres://postgres:x@127.0.0.1:61440/postgres", { max: 1 });
const source = postgres(`postgres://postgres:x@127.0.0.1:61440/${template}`, { max: 1 });
let target: postgres.Sql | undefined;
const saved = attest
  ? await Bun.file(out).json()
  : {
      originalDatabase: fixture.database,
      template,
      database: `og_insights_daily_http_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      createdAt: new Date().toISOString(),
      copyCreated: false,
      countsAndForceEqual: false,
      ...(parent
        ? {
            lineage: {
              kind: "completed-dirty-benchmark-physical-copy",
              parentReceiptSha256: parentSha256,
              parentMeasuredHead: parent.measuredEndHead,
              rootTemplate: parent.physicalCopy.template,
              inheritedLabWrites: 42,
              originalBaseCounts: parent.before.counts,
              expectedCounts: parent.after.counts,
            },
          }
        : {}),
    };
if (
  saved.template !== template ||
  saved.originalDatabase !== fixture.database ||
  !/^og_insights_daily_http_[a-f0-9]{12}$/.test(saved.database)
)
  throw new Error("Receipt targets a different database; no writes allowed");
try {
  if (!attest) {
    const before = await snapshot(source);
    const expectedCounts = parent ? { ...parent.before.counts } : null;
    if (expectedCounts) {
      for (const [field, delta] of Object.entries({
        facts: 42,
        usage: 42,
        warm: 42,
        ledger: 42,
        requested: 4242,
        list: 3066,
        actual: -42,
      }))
        expectedCounts[field] = String(BigInt(expectedCounts[field]) + BigInt(delta));
    }
    if (
      (parent
        ? JSON.stringify(expectedCounts) !== JSON.stringify(parent.after.counts) ||
          JSON.stringify(before) !== JSON.stringify(parent.after)
        : before.counts?.facts !== "838000" ||
          before.counts?.usage !== "4170000" ||
          before.counts?.warm !== "2870000") ||
      before.force.some((row) => !row.relrowsecurity || !row.relforcerowsecurity)
    )
      throw new Error("Expected retained staging-sized counts and FORCE posture required");
    saved.before = before;
    await source.end();
    const connected = await root`select pid from pg_stat_activity where datname=${template}`;
    if (connected.length)
      throw new Error("Template has active connections; none will be terminated");
    const existing = await root`select datname from pg_database where datname=${saved.database}`;
    if (existing.length) throw new Error("Generated target exists; no overwrite or replay");
    await Bun.write(out, JSON.stringify(saved, null, 2));
    const start = performance.now();
    await root.unsafe(
      `CREATE DATABASE "${saved.database}" WITH TEMPLATE "${template}" OWNER "${fixture.ownerRole}"`,
    );
    saved.copyCreated = true;
    saved.cloneElapsedMs = performance.now() - start;
  } else if (!saved.copyCreated) {
    throw new Error("Incomplete clone requires exact-state recovery, not attestation or replay");
  }
  target = postgres(`postgres://postgres:x@127.0.0.1:61440/${saved.database}`, { max: 1 });
  const after = await snapshot(target);
  if (
    JSON.stringify(saved.before.counts) !== JSON.stringify(after.counts) ||
    JSON.stringify(saved.before.force) !== JSON.stringify(after.force)
  )
    throw new Error("Copied source amounts/counts/FORCE changed");
  saved.after = after;
  saved.countsAndForceEqual = true;
  saved.attestedAt = new Date().toISOString();
  if (attest)
    (saved.reattestations ??= []).push({
      at: saved.attestedAt,
      kind: "read-only-after-explicit-migrations",
    });
  await Bun.write(out, JSON.stringify(saved, null, 2));
  console.log(
    JSON.stringify({
      database: saved.database,
      template,
      cloneElapsedMs: saved.cloneElapsedMs,
      countsAndForceEqual: saved.countsAndForceEqual,
      attest,
    }),
  );
} catch (error) {
  saved.failure = { message: (error as Error).message, at: new Date().toISOString() };
  await Bun.write(out, JSON.stringify(saved, null, 2));
  throw error;
} finally {
  await target?.end();
  await source.end();
  await root.end();
}
