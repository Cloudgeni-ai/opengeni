import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimCodemodeOperation,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getCodemodeOperation,
  initializeSessionStartAtomically,
  markCodemodeOperationExecutionStarted,
  nestedPostgresSqlState,
  persistAttemptToolCatalog,
  settleCodemodeOperationWithOutput,
  submitCodemodeOperation,
} from "../src";
import { withRlsContext, type Database } from "../src/database";
import { lockTurnAttemptWriteFenceTx } from "../src/session-attempt-fence";

// Production deadlock (SQLSTATE 40P01) on POST /codemode/calls: the worker's
// terminal settlement updated the journal row BEFORE taking the canonical
// session prefix, while the Codemode client's periodic re-submit of the same
// operation id held that prefix (sessions FOR NO KEY UPDATE) and then asked for
// the journal row FOR UPDATE. Both sides now take the prefix first.

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("codemode-settlement-lock-order");
  if (!shared) {
    available = false;
    console.warn("[codemode-settlement-lock-order] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function runningOperation() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `codemode-lock-account-${suffix}`,
    accountName: "Codemode lock order",
    workspaceExternalSource: "test",
    workspaceExternalId: `codemode-lock-workspace-${suffix}`,
    workspaceName: "Codemode lock order",
    subjectId: `codemode-lock-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
  const catalog = createAttemptToolEnvironment({
    scope,
    generation: 1,
    createdAt: new Date("2026-10-05T00:00:00.000Z"),
    definitions: [
      {
        identity: { serverId: "docs", toolName: "search" },
        modelName: "docs__search",
        description: "Run search",
        inputSchema: { type: "object", additionalProperties: true },
        source: "docs",
        approval: "none",
        execute: async () => ({ content: [] }),
      },
    ],
  }).catalog;
  await persistAttemptToolCatalog(client.db, catalog);
  const operations: Array<{ call: ReturnType<typeof codemodeCall>; claimId: string }> = [];
  const call = codemodeCall(catalog.digest);
  await submitCodemodeOperation(client.db, { ...scope, call });
  const claimId = crypto.randomUUID();
  const claim = await claimCodemodeOperation(client.db, {
    ...scope,
    catalogDigest: catalog.digest,
    operationId: call.operationId,
    claimId,
  });
  expect(claim.status).toBe("claimed");
  expect(
    await markCodemodeOperationExecutionStarted(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      attemptId,
      operationId: call.operationId,
      claimId,
    }),
  ).toBe(true);
  operations.push({ call, claimId });
  return { scope, catalog, call, claimId };
}

function codemodeCall(catalogDigest: string, operationId = crypto.randomUUID()) {
  return {
    operationId,
    catalogDigest,
    identity: { serverId: "docs", toolName: "search" },
    arguments: { query: "hello" },
    caller: { kind: "codemode" as const, subjectId: "agent:test" },
  };
}

function settle(env: Awaited<ReturnType<typeof runningOperation>>, text = "done") {
  return settleCodemodeOperationWithOutput(client.db, {
    ...env.scope,
    operationId: env.call.operationId,
    claimId: env.claimId,
    producerId: "agent:test",
    settlement: { state: "completed", result: { content: [{ type: "text", text }] } },
  });
}

describe("Codemode terminal settlement lock order", () => {
  test("settlement waits on the session prefix without holding the journal row", async () => {
    if (!available) return;
    const env = await runningOperation();
    let releasePrefix!: () => void;
    const prefixReleased = new Promise<void>((resolve) => (releasePrefix = resolve));
    let prefixHeld!: () => void;
    const prefixAcquired = new Promise<void>((resolve) => (prefixHeld = resolve));

    // Exactly the re-submit's critical section: canonical prefix (including
    // sessions FOR NO KEY UPDATE), then the journal row FOR UPDATE.
    const resubmit = withRlsContext(
      client.db,
      { accountId: env.scope.accountId, workspaceId: env.scope.workspaceId },
      async (tx) => {
        const fence = await lockTurnAttemptWriteFenceTx(tx, env.scope);
        expect(fence.allowed).toBe(true);
        prefixHeld();
        await prefixReleased;
        // A settlement that already locked the row would make this wait; the bound
        // is below deadlock_timeout so the detector cannot hide the inversion.
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        const rows = await tx.execute(
          sql`select state from session_attempt_codemode_calls where operation_id = ${env.call.operationId} for update`,
        );
        return rows;
      },
    );
    await prefixAcquired;
    const settlement = settle(env);
    // Let settlement reach its first blocking lock while the prefix is held.
    await waitForBlockedSettlement(env.call.operationId);
    releasePrefix();

    const [rows, settled] = await Promise.all([
      resubmit.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, sqlState: nestedPostgresSqlState(error) }),
      ),
      settlement,
    ]);
    expect(rows).toMatchObject({ ok: true });
    expect(settled.committed).toBe(true);
    expect(settled.accepted).toBe(true);
    expect(
      await getCodemodeOperation(client.db, {
        accountId: env.scope.accountId,
        workspaceId: env.scope.workspaceId,
        attemptId: env.scope.attemptId,
        operationId: env.call.operationId,
      }),
    ).toMatchObject({ state: "completed" });
  }, 60_000);

  test("parallel re-submits, event appends, and settlement of one operation never deadlock", async () => {
    if (!available) return;
    for (let round = 0; round < 4; round += 1) {
      const env = await runningOperation();
      const resubmits = Array.from({ length: 12 }, () =>
        submitCodemodeOperation(client.db, { ...env.scope, call: env.call }),
      );
      const appends = Array.from({ length: 6 }, (_, index) =>
        appendSessionEventsForTurnAttempt(
          client.db,
          env.scope.workspaceId,
          env.scope.sessionId,
          env.scope.turnId,
          env.scope.executionGeneration,
          env.scope.attemptId,
          [
            {
              type: "agent.message.delta",
              turnId: env.scope.turnId,
              turnGeneration: env.scope.executionGeneration,
              turnAttemptId: env.scope.attemptId,
              payload: { delta: `chunk-${round}-${index}` },
            },
          ],
        ),
      );
      const results = await Promise.allSettled([settle(env), ...resubmits, ...appends]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => nestedPostgresSqlState(result.reason) ?? String(result.reason));
      expect(failures).toEqual([]);
    }
  }, 120_000);
});

/** Poll until a backend is durably waiting on an ungranted lock (the settlement). */
async function waitForBlockedSettlement(operationId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const rows = (await client.db.execute(sql`
      select a.pid, left(a.query, 160) as query, l.locktype, l.mode,
        l.relation::regclass::text as relation
      from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where not l.granted and a.pid <> pg_backend_pid()
    `)) as unknown as Array<Record<string, unknown>>;
    consecutive = rows.length > 0 ? consecutive + 1 : 0;
    if (consecutive >= 3) {
      if (process.env.DEBUG_LOCKS) console.log(JSON.stringify(rows, null, 1));
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`settlement for ${operationId} never blocked on the held prefix`);
}

export type { Database };
