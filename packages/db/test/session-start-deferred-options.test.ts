import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  getSessionGoal,
  initializeSessionStartAtomically,
  listSessionEvents,
  type DbClient,
} from "../src";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-start-deferred-options");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[session-start-deferred-options] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    console.warn(
      "[session-start-deferred-options] PostgreSQL unavailable, skipping live assertions",
    );
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function sessionFixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: `deferred-start-account-${suffix}`,
    accountName: "Deferred start test account",
    workspaceExternalSource: "test",
    workspaceExternalId: `deferred-start-workspace-${suffix}`,
    workspaceName: "Deferred start test workspace",
    subjectId: `deferred-start-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Initialize this session without an initial turn.",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  return { grant, session };
}

describe("atomic deferred session initialization options (real PostgreSQL)", () => {
  test("preserves the legacy idle/api defaults and replays idempotently", async () => {
    if (!client) return;
    const { grant, session } = await sessionFixture();
    const input = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low" as const,
      createdEventPayload: { source: "legacy-default-test" },
      goal: { text: "Preserve legacy deferred initialization." },
      deferInitialTurn: true,
    };

    const first = await initializeSessionStartAtomically(client.db, input);
    expect(first.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "session.created"],
      [2, "goal.set"],
    ]);
    expect(first.events[0]?.payload).toMatchObject({ status: "idle" });
    expect(first.events[1]?.payload).toMatchObject({ actor: "api" });
    expect(await getSession(client.db, grant.workspaceId, session.id)).toMatchObject({
      status: "idle",
    });
    expect(await getSessionGoal(client.db, grant.workspaceId, session.id)).toMatchObject({
      createdBy: "api",
    });

    const replay = await initializeSessionStartAtomically(client.db, input);
    expect(replay.changed).toBe(false);
    expect(replay.events).toEqual([]);
    expect(await listSessionEvents(client.db, grant.workspaceId, session.id)).toHaveLength(2);
  });

  test("supports queued/scheduled_task provenance and replays idempotently", async () => {
    if (!client) return;
    const { grant, session } = await sessionFixture();
    const input = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low" as const,
      createdEventPayload: { source: "scheduled-task-test" },
      goal: {
        text: "Resolve the scheduled occurrence.",
        createdBy: "scheduled_task" as const,
      },
      deferInitialTurn: true,
      deferredStatus: "queued" as const,
    };

    const first = await initializeSessionStartAtomically(client.db, input);
    expect(first.events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "session.created"],
      [2, "goal.set"],
    ]);
    expect(first.events[0]?.payload).toMatchObject({ status: "queued" });
    expect(first.events[1]?.payload).toMatchObject({ actor: "scheduled_task" });
    expect(await getSession(client.db, grant.workspaceId, session.id)).toMatchObject({
      status: "queued",
    });
    expect(await getSessionGoal(client.db, grant.workspaceId, session.id)).toMatchObject({
      createdBy: "scheduled_task",
    });

    const replay = await initializeSessionStartAtomically(client.db, input);
    expect(replay.changed).toBe(false);
    expect(replay.events).toEqual([]);
    const events = await listSessionEvents(client.db, grant.workspaceId, session.id);
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "session.created"],
      [2, "goal.set"],
    ]);
  });
});
