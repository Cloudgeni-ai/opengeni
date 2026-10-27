import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  evaluateSessionControl,
  listSessionTurns,
  mutateSessionControlInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src";
import * as schema from "../src/schema";
import { withSiteRuntimeAdmission } from "../src/site-runtime-admission";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("prompt-locked-session-reuse");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Prompt row reuse",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Prompt row reuse",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { grant, session };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type PromptInput = Parameters<typeof submitHumanPromptInTransaction>[1];

function send(
  f: Fixture,
  options: Partial<
    Pick<PromptInput, "delivery" | "operationKey" | "controlEtag" | "beforeFreshPromptCommit">
  > = {},
  db = client.db,
) {
  return withWorkspaceSubjectSessionActivityRls(db, f.grant.workspaceId, f.grant.subjectId, (tx) =>
    submitHumanPromptInTransaction(tx, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.session.id,
      subjectId: f.grant.subjectId,
      actor: { type: "human", subjectId: f.grant.subjectId },
      delivery: "send",
      operationKey: crypto.randomUUID(),
      text: "A fresh prompt",
      resources: [],
      reasoningEffortFallback: "medium",
      source: "user",
      ...options,
    }),
  );
}

for (const delivery of ["send", "steer"] as const) {
  test(`${delivery} reuses the canonical cursor while retaining fresh visibility and idempotency`, async () => {
    const f = await fixture();
    const queries: string[] = [];
    const connection = postgres(shared.appUrl, {
      max: 1,
      prepare: false,
      debug: (_connection, query) => {
        queries.push(query);
      },
    });
    const db = drizzle(connection, { schema });
    try {
      const operationKey = crypto.randomUUID();
      const accepted = await send(f, { delivery, operationKey }, db);
      expect(accepted.replay).toBe(false);
      const lockedCursorReads = queries.filter(
        (query) => query.includes('from "session_event_cursors"') && query.includes("for update"),
      );
      expect(lockedCursorReads).toHaveLength(1);
      // Access is still evaluated after receipt reservation, independently of
      // the retained row; the optimization is not an authorization cache.
      const receiptIndex = queries.findIndex((query) =>
        query.includes('insert into "session_command_receipts"'),
      );
      const lateVisibility = queries.findIndex(
        (query, index) =>
          index > receiptIndex &&
          query.includes('select "id" from "sessions"') &&
          query.includes("for no key update"),
      );
      expect(lateVisibility).toBeGreaterThan(receiptIndex);
      const replay = await send(f, { delivery, operationKey }, db);
      expect(replay.replay).toBe(true);
      expect(await listSessionTurns(client.db, f.grant.workspaceId, f.session.id)).toHaveLength(1);
    } finally {
      await connection.end();
    }
  });
}

test("a stale control ETag still refuses admission after an intervening Pause", async () => {
  const f = await fixture();
  const before = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    f.grant.workspaceId,
    f.grant.subjectId,
    (db) => evaluateSessionControl(db, f.grant.workspaceId, f.session.id),
  );
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    f.grant.workspaceId,
    f.grant.subjectId,
    (db) =>
      mutateSessionControlInTransaction(db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        sessionId: f.session.id,
        actor: { type: "human", subjectId: f.grant.subjectId },
        action: "pause",
        operationKey: crypto.randomUUID(),
      }),
  );
  await expect(send(f, { controlEtag: before.controlEtag })).rejects.toThrow();
  expect(await listSessionTurns(client.db, f.grant.workspaceId, f.session.id)).toHaveLength(0);
  await send(f, { delivery: "steer" });
  const after = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    f.grant.workspaceId,
    f.grant.subjectId,
    (db) => evaluateSessionControl(db, f.grant.workspaceId, f.session.id),
  );
  expect(after.state).toBe("active");
});

test("expired Site admission remains fail closed before prompt acceptance", async () => {
  const f = await fixture();
  await expect(
    withSiteRuntimeAdmission(
      {
        workspaceId: f.grant.workspaceId,
        sessionId: f.session.id,
        admissionId: crypto.randomUUID(),
      },
      () => send(f),
    ),
  ).rejects.toThrow("Site conversation admission expired");
  expect(await listSessionTurns(client.db, f.grant.workspaceId, f.session.id)).toHaveLength(0);
});

for (const corruption of ["missing", "regressed"] as const) {
  test(`the original canonical lock still rejects a ${corruption} cursor`, async () => {
    const f = await fixture();
    // Owner-only corruption of this isolated fixture, never a production path.
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      if (corruption === "missing") {
        await tx`delete from session_event_cursors where session_id = ${f.session.id}`;
      } else {
        await tx`update sessions set last_sequence = last_sequence + 1 where id = ${f.session.id}`;
      }
    });
    await expect(send(f)).rejects.toThrow(
      corruption === "missing"
        ? "cursor lock set was incomplete"
        : "cursor is behind session projection",
    );
    expect(await listSessionTurns(client.db, f.grant.workspaceId, f.session.id)).toHaveLength(0);
  });
}

test("held session and cursor locks prevent semantic writes and event append sequence races", async () => {
  const f = await fixture();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let admitted!: () => void;
  const admission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const pending = send(f, {
    beforeFreshPromptCommit: async () => {
      admitted();
      await released;
    },
  });
  let append: ReturnType<typeof appendSessionEvents> | undefined;
  try {
    await admission;
    const [locks] = await shared.admin`
      select
        exists(select 1 from sessions where id=${f.session.id} for no key update skip locked) as semantic_available,
        exists(select 1 from sessions where id=${f.session.id} for key share skip locked) as identity_available,
        exists(select 1 from session_event_cursors where session_id=${f.session.id} for update skip locked) as cursor_available
    `;
    expect(locks?.semantic_available).toBe(false);
    // A raw writer may hold compatible session identity, but cannot advance
    // its cursor until this Send commits.
    expect(locks?.identity_available).toBe(true);
    expect(locks?.cursor_available).toBe(false);
    let appendFinished = false;
    append = appendSessionEvents(client.db, f.grant.workspaceId, f.session.id, [
      {
        type: "session.title_set",
        payload: { title: "Concurrent title" },
      },
    ]);
    void append.then(
      () => {
        appendFinished = true;
      },
      () => {
        appendFinished = true;
      },
    );
    // Confirm actual database contention, rather than interpreting a slow
    // promise as proof that it is waiting for the lock.
    let blocked = false;
    for (let count = 0; count < 100; count += 1) {
      const [row] = await shared.admin`
        select exists(select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'
          and query like '%sessions%') as blocked
      `;
      if (row?.blocked) {
        blocked = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    expect(appendFinished).toBe(false);
  } finally {
    release();
    await pending;
    await append;
  }
  const rows = await shared.admin`
    select sequence from session_events where session_id=${f.session.id} order by sequence
  `;
  const sequences = rows.map((row) => Number(row.sequence));
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index + 1));
  const [cursor] = await shared.admin`
    select last_sequence from session_event_cursors where session_id=${f.session.id}
  `;
  expect(Number(cursor?.last_sequence)).toBe(sequences.at(-1)!);
}, 30_000);
