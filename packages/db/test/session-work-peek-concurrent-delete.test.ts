import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createSession, peekSessionWork } from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-work-peek-concurrent-delete");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function seedSession() {
  const id = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Peek concurrent delete",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Peek concurrent delete",
      subjectId: `peek-delete-${id}`,
    })
  ).workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "hello",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { grant, session };
}

for (const observer of [true, false]) {
  test(`a session deleted while the peek waits for workspace control is observed as absent (observer=${observer})`, async () => {
    const { grant, session } = await seedSession();
    const lockKey = `workspace-control:${grant.workspaceId}`;
    let peek: Promise<unknown> | undefined;
    // A deletion holds the workspace-control key exclusively until it commits.
    // The peek reads the session row first, then waits on that key, so the
    // session it just saw is gone when its control read runs.
    await shared.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      peek = peekSessionWork(
        client.db,
        grant.workspaceId,
        session.id,
        true,
        observer ? grant.accountId : undefined,
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [waiting] = await shared.admin`
          select count(*)::int as count from pg_locks
          where locktype = 'advisory' and not granted`;
        if (waiting!.count > 0) break;
        if (Date.now() > deadline) throw new Error("peek never waited for workspace control");
        await Bun.sleep(20);
      }
      await tx`delete from sessions where workspace_id = ${grant.workspaceId} and id = ${session.id}`;
    });
    const outcome = (await peek!) as { value?: unknown; error?: unknown };
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({ kind: observer ? "unavailable" : "idle" });
  }, 60_000);
}
