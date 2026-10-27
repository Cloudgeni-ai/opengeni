import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";

import { bootstrapWorkspace, createSession } from "../src";
import { createDb } from "../src/database";
import { errorMessage } from "@opengeni/contracts/values";

let shared: SharedTestDatabase;
let pool: ReturnType<typeof createDb>;
let accountId: string;
let workspaceId: string;
let sessionId: string;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-write-fences");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  pool = createDb(shared.appUrl, { max: 1 });
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(pool.db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Write fences",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Write fences",
    subjectId: `write-fences-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  accountId = grant.accountId;
  workspaceId = grant.workspaceId;
  const session = await createSession(pool.db, {
    accountId,
    workspaceId,
    initialMessage: "Write fences",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
}, 180_000);

afterAll(async () => {
  await pool?.close();
  await shared?.release();
}, 60_000);

const rollback = new Error("roll back the probe transaction");

type FenceProbe = { calls: number; error: string | null };

/** Run `statement` as the table owner in a rolled-back transaction and report
 * how often the MCP binding fence ran (function counts survive a failed
 * savepoint) and which error, if any, the write raised. */
async function probeBindingFence(statement: string): Promise<FenceProbe> {
  let probe: FenceProbe | undefined;
  await shared.admin
    .begin(async (tx) => {
      await tx`set local track_functions = 'pl'`;
      let error: string | null = null;
      await tx
        .savepoint((savepoint) => savepoint.unsafe(statement, [sessionId]))
        .catch((cause: unknown) => {
          error = errorMessage(cause);
        });
      const [row] = await tx<{ calls: number }[]>`
        select coalesce(pg_stat_get_xact_function_calls(
          'opengeni_private.fence_mcp_account_bindings()'::regprocedure), 0)::int as calls`;
      probe = { calls: row!.calls, error };
      throw rollback;
    })
    .catch((cause: unknown) => {
      if (cause !== rollback) throw cause;
    });
  if (!probe) throw new Error("probe transaction did not run");
  return probe;
}

test("session updates that cannot change accepted MCP bindings skip the binding fence", async () => {
  expect(await probeBindingFence("update sessions set title = 'renamed' where id = $1")).toEqual({
    calls: 0,
    error: null,
  });
  expect(
    await probeBindingFence(
      "update sessions set last_sequence = last_sequence, updated_at = now() where id = $1",
    ),
  ).toEqual({ calls: 0, error: null });
});

test("binding and visibility changes still run the fence", async () => {
  // A raising function call is not counted; its own error proves it ran.
  expect(
    (
      await probeBindingFence(
        "update sessions set initial_mcp_account_bindings = '[]'::jsonb where id = $1",
      )
    ).error,
  ).toBe("accepted MCP account bindings are immutable");
  expect(
    (await probeBindingFence("update sessions set visibility = 'private' where id = $1")).error,
  ).toBe("invalid MCP account visibility cleanup");
});

test("the tenancy fence still reads each row's workspace and requires its lock", async () => {
  const unfenced = await pool.db
    .transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.account_id', ${accountId}, true),
          set_config('opengeni.workspace_id', ${workspaceId}, true)`,
      );
      await tx.execute(sql`update sessions set last_input_tokens = 4141 where id = ${sessionId}`);
    })
    .then(
      () => null,
      (error: unknown) => error as { cause?: { message?: string } },
    );
  expect(unfenced?.cause?.message).toBe("session tenancy mutation requires the workspace fence");
  await pool.db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${workspaceId}, true),
        pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`,
    );
    await tx.execute(sql`update sessions set last_input_tokens = 4242 where id = ${sessionId}`);
  });
  const [row] = await shared.admin<{ tokens: number | null }[]>`
    select last_input_tokens as tokens from sessions where id = ${sessionId}`;
  expect(row?.tokens).toBe(4242);
});
