import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  registerDbBinding,
  withWorkspaceRls,
} from "@opengeni/db";
import { rawRows, type Database } from "../../../packages/db/src/database";
import { lockSessionEventWriteRows } from "../../../packages/db/src/session-control";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../../../packages/db/src/lossless-json";

let shared: SharedTestDatabase;
let native: ReturnType<typeof createDb>;
let pool: Pool;
let db: Database;
let observer: postgres.Sql;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("event-lock-node-pg");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  native = createDb(shared.appUrl);
  pool = new Pool({
    connectionString: shared.appUrl,
    max: 1,
    application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
  });
  db = drizzle(pool) as Database;
  registerDbBinding(db, { rlsStrategy: "force" });
  observer = postgres(shared.adminUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await pool?.end();
  await native?.close();
  await observer?.end();
  await shared?.release();
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("injected node-postgres preserves ordered locking, fresh reads and savepoint recovery", async () => {
  const id = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(native.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Injected driver",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Injected driver",
      subjectId: id,
    })
  ).workspaceGrants[0]!;
  const session = await createSession(native.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "probe",
    metadata: {},
    resources: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const held = gate(),
    release = gate(),
    started = gate();
  const title = `later-${id}`;
  const holding = shared.admin.begin(async (tx) => {
    await tx`select id from workspaces where id = ${grant.workspaceId} for update`;
    held.release();
    await release.promise;
    await tx`update sessions set title=${title}, title_source='user' where id=${session.id}`;
  });
  await held.promise;
  let pid = 0;
  const input = {
    workspaceId: grant.workspaceId,
    sessionIds: [session.id],
    controlLock: "none" as const,
  };
  const operation = withWorkspaceRls(db, grant.workspaceId, async (tx) => {
    await tx.execute(sql`set local statement_timeout='5s'`);
    pid = (await rawRows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`))[0]!.pid;
    started.release();
    return await lockSessionEventWriteRows(tx, input);
  });
  void operation.catch(() => {});
  try {
    await started.promise;
    let blocked = false;
    for (let i = 0; i < 500; i++) {
      const [state] = await observer`select wait_event_type from pg_stat_activity where pid=${pid}`;
      if (state?.wait_event_type === "Lock") {
        blocked = true;
        break;
      }
      await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    await observer.begin(
      (tx) => tx`select id from sessions where id=${session.id} for update nowait`,
    );
    release.release();
    await holding;
    const result = await operation;
    expect(result.sessions[0]!.title).toBe(title);
    await withWorkspaceRls(db, grant.workspaceId, async (parent) => {
      let caught: any;
      try {
        await withWorkspaceRls(parent, grant.workspaceId, (tx) =>
          lockSessionEventWriteRows(tx, { ...input, sessionIds: ["invalid-uuid"] }),
        );
      } catch (error) {
        caught = error;
      }
      while (caught?.cause) caught = caught.cause;
      expect(caught?.code).toBe("22P02");
      const scope = await rawRows<{ workspace: string }>(
        parent,
        sql`select current_setting('opengeni.workspace_id') as workspace`,
      );
      expect(scope[0]!.workspace).toBe(grant.workspaceId);
      expect((await lockSessionEventWriteRows(parent, input)).sessions[0]!.id).toBe(session.id);
    });
  } finally {
    release.release();
    await holding;
    await operation.catch(() => {});
  }
}, 20_000);
