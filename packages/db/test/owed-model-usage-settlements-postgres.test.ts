import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listOwedModelUsageSettlements,
} from "../src/index";

setDefaultTimeout(180_000);

// Owed model usage settlement runs at every idle, failure and worker-death
// boundary of every session, and before each attempt's first model request.
// It is a best-effort repair, so its cost must depend on the session's own
// recorded responses, never on how many ledger rows the deployment holds.
// Under the runtime role's row-level security PostgreSQL uses a join clause as
// an index condition only when it is leakproof; a completion key read out of
// the event's JSON is not, which turned each anti-join into a scan of every
// usage row (with its row policy) per event. These tests run the real read
// as the runtime role, with and without generic plans, over a large ledger.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const LEDGER_ROWS = 100_000;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("owed-model-usage-settlements");
  if (!acquired) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL is required for the owed settlement plan regression");
    }
    return;
  }
  shared = acquired;
  // One connection, so statistics flushes and plan caching stay on one backend.
  client = createDb(shared.appUrl, { max: 1 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function scope() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "owed settlements",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "owed settlements",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, sessionId: session.id };
}
type Scope = Awaited<ReturnType<typeof scope>>;

function usagePayload(sourceKey: string, completionKey: string) {
  return {
    sourceKey,
    model: "scripted-model",
    inputTokens: 10,
    outputTokens: 2,
    settlement: { version: 1, charges: { completionKey } },
  };
}

async function insertEvent(
  seed: postgres.Sql,
  base: Scope,
  event: {
    turnId: string;
    type: "agent.model.usage" | "turn.event.rejected_late";
    association: "current" | "late_rejected";
    payload: unknown;
    createdAt?: Date;
  },
): Promise<string> {
  const createdAt = event.createdAt ?? new Date();
  const [row] = await seed<{ id: string }[]>`
    insert into session_events (
      account_id, workspace_id, session_id, turn_id, turn_association,
      sequence, type, payload, occurred_at, created_at
    ) values (
      ${base.accountId}, ${base.workspaceId}, ${base.sessionId}, ${event.turnId},
      ${event.association},
      (select coalesce(max(sequence), 0) + 1 from session_events
        where workspace_id = ${base.workspaceId} and session_id = ${base.sessionId}),
      ${event.type}, ${seed.json(event.payload as never)}, ${createdAt}, ${createdAt}
    ) returning id`;
  return row!.id;
}

async function seedSession() {
  const base = await scope();
  // Seed on a connection of its own and close it: a backend reports its
  // table statistics on exit, so the scans below count only the reads.
  const seed = postgres(shared.adminUrl, { max: 1 });
  const turnId = crypto.randomUUID();
  const current = (sourceKey: string, completionKey: string, createdAt?: Date) =>
    insertEvent(seed, base, {
      turnId,
      type: "agent.model.usage",
      association: "current",
      payload: usagePayload(sourceKey, completionKey),
      ...(createdAt ? { createdAt } : {}),
    });
  const key = (name: string) => `${base.sessionId}:${name}`;
  const settledByUsage = await current("usage-settled", key("usage-settled"));
  const settledByCredit = await current("credit-settled", key("credit-settled"));
  const owed = await current("owed", key("owed"));
  const owedYesterday = await current(
    "owed-yesterday",
    key("owed-yesterday"),
    new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  );
  // A usage event that is not the turn's current record is not owed itself.
  await insertEvent(seed, base, {
    turnId,
    type: "agent.model.usage",
    association: "late_rejected",
    payload: usagePayload("late", key("late")),
  });
  // A fenced attempt's usage is owed through its rejected audit row.
  const rejected = await insertEvent(seed, base, {
    turnId,
    type: "turn.event.rejected_late",
    association: "late_rejected",
    payload: {
      rejectedType: "agent.model.usage",
      rejectedPayload: usagePayload("rejected", key("rejected")),
    },
  });

  // A large ledger of the same account and session, as in production: every
  // row is visible to the runtime role and passes its row policy.
  await seed`
    insert into usage_events (
      account_id, workspace_id, session_id, event_type, quantity, unit,
      idempotency_key, occurred_at, recorded_at
    )
    select ${base.accountId}, ${base.workspaceId}, ${base.sessionId}, 'model.tokens', n, 'count',
      ${base.sessionId} || ':history:' || n::text, now(), now()
    from generate_series(1, ${LEDGER_ROWS}::integer) fixture(n)`;
  await seed`
    insert into usage_events (
      account_id, workspace_id, session_id, event_type, quantity, unit,
      idempotency_key, occurred_at, recorded_at
    ) values (
      ${base.accountId}, ${base.workspaceId}, ${base.sessionId}, 'model.tokens', 1, 'count',
      ${key("usage-settled")}, now(), now()
    )`;
  await seed`
    insert into credit_ledger_entries (
      account_id, workspace_id, type, amount_micros, source_type, source_id, idempotency_key
    )
    select ${base.accountId}, ${base.workspaceId}, 'adjustment', 1, 'test', n::text,
      ${base.sessionId} || ':credit-history:' || n::text
    from generate_series(1, ${LEDGER_ROWS / 4}::integer) fixture(n)`;
  await seed`
    insert into credit_ledger_entries (
      account_id, workspace_id, type, amount_micros, source_type, source_id, idempotency_key
    ) values (
      ${base.accountId}, ${base.workspaceId}, 'adjustment', 1, 'test', 'settled',
      ${key("credit-settled")}
    )`;
  await seed`analyze usage_events`;
  await seed`analyze credit_ledger_entries`;
  await seed`analyze session_events`;
  await seed.end();
  return {
    base,
    ids: { settledByUsage, settledByCredit, owed, owedYesterday, rejected },
  };
}

type Seeded = Awaited<ReturnType<typeof seedSession>>;

/** Sequential scans of the ledger tables by this database since the last call. */
async function ledgerSequentialScans(db: ReturnType<typeof createDb>): Promise<number> {
  // Statistics reach shared memory when the backend goes idle; ask the
  // runtime connection to flush on its next idle instead of waiting for it.
  await db.db.execute(sql`select pg_stat_force_next_flush()`);
  await Bun.sleep(50);
  const [row] = await shared.admin<{ scans: string }[]>`
    select coalesce(sum(seq_scan), 0)::text as scans from pg_stat_user_tables
    where relname in ('usage_events', 'credit_ledger_entries')`;
  return Number(row!.scans);
}

async function expectOwed(db: ReturnType<typeof createDb>, seeded: Seeded) {
  const { base, ids } = seeded;
  const all = await listOwedModelUsageSettlements(db.db, base.workspaceId, {
    sessionId: base.sessionId,
  });
  expect(all.map((row) => [row.id, row.rejected])).toEqual([
    [ids.owed, false],
    [ids.owedYesterday, false],
    [ids.rejected, true],
  ]);
  // The audit row's usage payload is unwrapped for settlement.
  expect(all[2]!.payload).toEqual(
    usagePayload("rejected", `${base.sessionId}:rejected`) as unknown as (typeof all)[2]["payload"],
  );
  const recent = await listOwedModelUsageSettlements(db.db, base.workspaceId, {
    sessionId: base.sessionId,
    since: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  expect(recent.map((row) => row.id)).toEqual([ids.owed, ids.rejected]);
}

test("owed settlements probe the ledger by key under runtime RLS instead of scanning it", async () => {
  if (!shared) return;
  const seeded = await seedSession();
  // Warm the connection's statement cache past PostgreSQL's custom-plan
  // trials, so both the custom and the cached generic plan are exercised.
  const before = await ledgerSequentialScans(client);
  for (let run = 0; run < 8; run += 1) await expectOwed(client, seeded);
  expect(await ledgerSequentialScans(client)).toBe(before);
});

test("owed settlements stay key probes when the connection always uses generic plans", async () => {
  if (!shared) return;
  const seeded = await seedSession();
  const database = new URL(shared.appUrl).pathname.slice(1);
  await shared.admin.unsafe(
    `alter database "${database.replaceAll('"', '""')}" set plan_cache_mode = force_generic_plan`,
  );
  const generic = createDb(shared.appUrl, { max: 1 });
  try {
    const [mode] = await generic.db.execute<{ plan_cache_mode: string }>(
      sql`select current_setting('plan_cache_mode') as plan_cache_mode`,
    );
    expect(mode?.plan_cache_mode).toBe("force_generic_plan");
    const before = await ledgerSequentialScans(generic);
    for (let run = 0; run < 3; run += 1) await expectOwed(generic, seeded);
    expect(await ledgerSequentialScans(generic)).toBe(before);
  } finally {
    await generic.close();
    await shared.admin.unsafe(
      `alter database "${database.replaceAll('"', '""')}" reset plan_cache_mode`,
    );
  }
});
