import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, waitFor, type SharedTestDatabase } from "@opengeni/testing";
import { createDb, rawRows, withRlsContext } from "../src/database";
import { DatabaseTransactionError } from "../src/persistence-errors";
import { postClaimDatabaseRecoveryFailure } from "../../../apps/worker/src/activities/agent-turn/errors";

let shared: SharedTestDatabase;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("database-transaction-provenance");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 60_000);
const scope = { accountId: crypto.randomUUID() };
function recovery(error: unknown) {
  return postClaimDatabaseRecoveryFailure({
    error,
    turnId: crypto.randomUUID(),
    triggerEventId: crypto.randomUUID(),
    executionGeneration: 1,
    requireDatabaseProvenance: true,
  });
}

test("real raw transaction admission failure supplies own-client provenance without entering the callback", async () => {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const client = createDb(`postgres://fixture:fixture@127.0.0.1:${port}/fixture`, { max: 1 });
  let entered = false;
  try {
    const error = await withRlsContext(client.db, scope, async () => {
      entered = true;
    }).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(entered).toBe(false);
    expect(error).toBeInstanceOf(DatabaseTransactionError);
    expect((error as DatabaseTransactionError).stage).toBe("admission");
    expect((error as Error).cause).toMatchObject({ code: "ECONNREFUSED" });
    expect(recovery(error)?.type).toBe("OpenGeniPostClaimDatabaseRecovery");
  } finally {
    await client.close();
  }
}, 10_000);

test("a real own transaction closure is classified even when no ORM query owns the failure", async () => {
  const client = createDb(shared.appUrl, { max: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let owner: number | undefined;
  const operation = withRlsContext(client.db, scope, async (db) => {
    const [row] = await rawRows<{ pid: number }>(db, sql`select pg_backend_pid() as pid`);
    owner = row!.pid;
    await gate;
  }).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await waitFor(() => owner !== undefined, { timeoutMs: 1000, intervalMs: 5 });
    const [terminated] = await shared.admin`
      select pg_terminate_backend(pid) as terminated from pg_stat_activity
      where pid = ${owner!} and datname = current_database()
        and usename = ${new URL(shared.appUrl).username}
    `;
    expect(terminated?.terminated).toBe(true);
    const error = await operation;
    expect(error).toBeInstanceOf(DatabaseTransactionError);
    expect((error as DatabaseTransactionError).stage).toBe("settlement");
    expect((error as Error).cause).toMatchObject({ code: "CONNECTION_CLOSED" });
    expect(recovery(error)?.type).toBe("OpenGeniPostClaimDatabaseRecovery");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The old callback's eventual COMMIT cannot write on its closed socket.
    expect(
      await withRlsContext(client.db, scope, (db) => rawRows(db, sql`select 1 as value`)),
    ).toMatchObject([{ value: 1 }]);
  } finally {
    release();
    await client.close();
  }
}, 10_000);

test("successful rollback never brands an application/provider callback error", async () => {
  const client = createDb(shared.appUrl, { max: 1 });
  try {
    for (const code of ["ECONNRESET", "CONNECT_TIMEOUT", "CONNECTION_CLOSED"]) {
      const provider = Object.assign(new Error("provider failure"), { code });
      const error = await withRlsContext(client.db, scope, async () => {
        throw provider;
      }).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBe(provider);
      expect(recovery(error)).toBeNull();
    }
  } finally {
    await client.close();
  }
}, 10_000);
