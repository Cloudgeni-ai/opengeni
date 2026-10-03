import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  recordUsageEvent,
} from "../src/index";
import postgres from "postgres";

let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("usage-lock-order");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  app = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
});

test("usage waits for the workspace before holding execution rows needed by lifecycle writers", async () => {
  const subjectId = `usage-lock:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "usage-lock-test",
    accountExternalId: subjectId,
    accountName: "Usage lock test",
    workspaceExternalSource: "usage-lock-test",
    workspaceExternalId: subjectId,
    workspaceName: "Usage lock test",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(app.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "lock regression",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
  });
  const started = await initializeSessionStartAtomically(app.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  const turnId = started.turn!.id;
  const pool = postgres(shared.adminUrl, { max: 1 });
  const workspaceWriter = await pool.reserve();
  let usage: ReturnType<typeof recordUsageEvent> | undefined;
  const waitForBlocked = async (predicate: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await shared.admin.unsafe(
        `select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and ${predicate}`,
      );
      if (rows.length) return;
      await Bun.sleep(10);
    }
    throw new Error(`Expected blocked query: ${predicate}`);
  };
  const input = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId,
    eventType: "model.input_tokens",
    quantity: 17,
    unit: "tokens",
    idempotencyKey: `usage-lock:${crypto.randomUUID()}`,
  };
  try {
    await workspaceWriter`begin`;
    await workspaceWriter`select id from workspaces where id=${workspaceId} for update`;
    usage = recordUsageEvent(app.db, input);
    // Attach rejection handling before the intentionally conflicting operation.
    void usage.catch(() => undefined);
    await waitForBlocked("query like 'insert into \"usage_events\"%'");
    // Before 0541, usage already holds this turn's KEY SHARE: the two
    // transactions form a deadlock. The fixed trigger has no child locks yet.
    await workspaceWriter`set local lock_timeout='2s'`;
    await workspaceWriter`select id from session_turns where id=${turnId} for update`;
    await workspaceWriter`commit`;
    const recorded = await usage;
    expect(recorded.quantity).toBe(17);
    expect((await recordUsageEvent(app.db, input)).id).toBe(recorded.id);
    await expect(
      recordUsageEvent(app.db, {
        ...input,
        idempotencyKey: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
  } finally {
    await workspaceWriter`rollback`;
    await Promise.allSettled([usage]);
    workspaceWriter.release();
    await pool.end();
  }
}, 180_000);
