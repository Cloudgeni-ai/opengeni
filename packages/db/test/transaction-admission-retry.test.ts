import { expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { retryRlsPersistence, withRlsContext, type Database } from "../src/database";
import { DatabaseTransactionError, SessionEventPersistenceError } from "../src/persistence-errors";

const context = { accountId: "account", workspaceId: "workspace" };
const driverError = (code: string) => Object.assign(new Error("driver failure"), { code });

function fixture(options: {
  errors?: Error[];
  setupError?: Error;
  commitError?: Error;
  nested?: boolean;
}) {
  let admissions = 0;
  let setups = 0;
  const tx = {
    execute: async () => {
      setups += 1;
      if (options.setupError) throw options.setupError;
      return [
        {
          resolved_account_id: context.accountId,
          account_id: context.accountId,
          workspace_id: context.workspaceId,
        },
      ];
    },
  } as unknown as Database;
  const db = {
    ...(options.nested ? { rollback() {} } : {}),
    transaction: async (work: (tx: Database) => Promise<unknown>) => {
      const error = options.errors?.[admissions];
      admissions += 1;
      if (error) throw error;
      const result = await work(tx);
      if (options.commitError) throw options.commitError;
      return result;
    },
  } as unknown as Database;
  return { db, admissions: () => admissions, setups: () => setups };
}

test("history and event persistence ride out refused admission without replaying work", async () => {
  for (const stage of ["session_history_append", "session_events.append_for_turn_attempt"]) {
    for (const code of ["53300", "57P03", "ECONNREFUSED", "ECONNRESET", "CONNECTION_CLOSED"]) {
      const source = driverError(code);
      const pool = fixture({ errors: [source] });
      let writes = 0;
      const result = await retryRlsPersistence(pool.db, context, { stage }, async () => ++writes);
      expect(result).toBe(1);
      expect(writes).toBe(1);
      expect(pool.admissions()).toBe(2);
      expect(pool.setups()).toBe(1);
    }
  }
});

test("persistent exhaustion is bounded and retains the driver cause for workflow recovery", async () => {
  const source = driverError("53300");
  const pool = fixture({ errors: Array(8).fill(source) });
  let writes = 0;
  const failure = await retryRlsPersistence(
    pool.db,
    context,
    { stage: "session_history_append" },
    async () => ++writes,
  ).catch((error) => error);
  expect(pool.admissions()).toBe(8);
  expect(writes).toBe(0);
  expect(failure).toBeInstanceOf(SessionEventPersistenceError);
  expect(failure.details.sqlState).toBe("53300");
  expect(failure.cause).toBeInstanceOf(DatabaseTransactionError);
  expect(failure.cause.stage).toBe("admission");
  expect(failure.cause.cause).toBe(source);
}, 30_000);

test("data, permission, authentication and schema errors are not admission retries", async () => {
  for (const code of [
    "23505",
    "23503",
    "42501",
    "28P01",
    "42601",
    "42P01",
    "40003",
    "53200",
    "53100",
  ]) {
    const pool = fixture({ errors: [driverError(code)] });
    await expect(withRlsContext(pool.db, context, async () => {})).rejects.toBeInstanceOf(
      DatabaseTransactionError,
    );
    expect(pool.admissions()).toBe(1);
  }
});

test("a lost connection after callback entry or uncertain COMMIT never replays the transaction", async () => {
  for (const options of [
    { setupError: new DrizzleQueryError("select 1", [], driverError("ECONNRESET")) },
    { commitError: driverError("CONNECTION_CLOSED") },
  ]) {
    const pool = fixture(options);
    let writes = 0;
    await expect(withRlsContext(pool.db, context, async () => ++writes)).rejects.toBeInstanceOf(
      Error,
    );
    expect(pool.admissions()).toBe(1);
    expect(writes).toBe(options.commitError ? 1 : 0);
  }
  const pool = fixture({});
  const provider = driverError("ECONNRESET");
  await expect(
    withRlsContext(pool.db, context, async () => {
      throw provider;
    }),
  ).rejects.toBe(provider);
  expect(pool.admissions()).toBe(1);
});

test("a failed savepoint propagates rather than retrying a dead parent connection", async () => {
  const pool = fixture({ nested: true, errors: [driverError("ECONNRESET")] });
  await expect(withRlsContext(pool.db, context, async () => {})).rejects.toBeInstanceOf(
    DatabaseTransactionError,
  );
  expect(pool.admissions()).toBe(1);
});
