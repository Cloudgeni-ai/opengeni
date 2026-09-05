import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createDb, createEnrollment, createSession } from "@opengeni/db";
import { ErrorCode, OpState } from "@opengeni/agent-proto";
import { SelfhostedControlError, type ControlRpc } from "@opengeni/runtime/sandbox";
import { reconcileConnectedMachineBackgroundCommands as reconcile } from "../src/activities/sandbox-lease";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("connected-command-cleanup");
  if (!db) throw new Error("PostgreSQL required");
  shared = db;
  client = createDb(db.appUrl);
}, 180000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60000);

async function seed() {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Cleanup",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Cleanup",
    subjectId: `subject-${id}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspaceId!,
    initialMessage: "Cleanup",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const enrollment = await createEnrollment(client.db, {
    accountId,
    workspaceId: workspaceId!,
    pubkey: `ed25519:${id}`,
  });
  await shared.admin`update enrollments set connection_instance_id='launch',connection_lease_expires_at=now()+interval '1 hour' where id=${enrollment.id}`;
  await shared.admin`insert into session_background_commands(account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,connection_instance_id,op_id)
 select ${accountId},${workspaceId!},${session.id},'connected_machine','running',${workspaceId!},${enrollment.id},'launch',gen_random_uuid()::text from generate_series(1,25)`;
  return session.id;
}
const settings = {
  sandboxLeaseReaperPeriodMs: 30000,
  sandboxSelfhostedControlTimeoutMs: 1000,
} as Parameters<typeof reconcile>[1];
const warnings: unknown[] = [];
const observability = {
  incrementCounter: () => {},
  warn: (...args: unknown[]) => warnings.push(args),
} as unknown as Parameters<typeof reconcile>[2];
const bus = {
  getRequestConnection: async () => null,
  publish: async () => {},
} as unknown as Parameters<typeof reconcile>[3];

test("one sweep settles more than one batch and emits each future completion only once", async () => {
  const sessionId = await seed();
  let queries = 0;
  const rpc: ControlRpc = {
    request: async (_subject, request) => {
      queries++;
      const op = request.op!;
      if (op.$case !== "opQuery") throw new Error("Expected query");
      return {
        requestId: request.requestId,
        error: undefined,
        result: {
          $case: "opStatus",
          opStatus: {
            opId: op.opQuery.opId,
            state: OpState.OP_STATE_COMPLETE,
            nextSeq: "1",
            lostReason: 0,
            exit: {
              exitCode: 0,
              cancelled: false,
              timedOut: false,
              durationMs: "1",
              digests: {},
              totals: {},
              failureCode: "",
              failureDetail: {},
            },
          },
        },
      };
    },
  };
  await reconcile(client.db, settings, observability, bus, rpc);
  expect(warnings).toEqual([]);
  expect(queries).toBe(25);
  const [row] =
    await shared.admin`select count(*)::int n from session_background_commands where session_id=${sessionId} and state='exited'`;
  expect(row!.n).toBe(25);
  const [updates] =
    await shared.admin`select count(*)::int n from session_system_updates where session_id=${sessionId} and kind='background_command_result'`;
  expect(updates!.n).toBe(25);
  await reconcile(client.db, settings, observability, bus, rpc);
  expect(queries).toBe(25);
});
test("offline commands remain tracked while one sweep shares failed connection observations", async () => {
  const sessionId = await seed();
  let queries = 0;
  const rpc: ControlRpc = {
    request: async () => {
      queries++;
      throw new SelfhostedControlError({
        message: "offline",
        code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
        agentOffline: true,
        reason: null,
        retryable: true,
      });
    },
  };
  await reconcile(client.db, settings, observability, bus, rpc);
  expect(queries).toBeGreaterThan(0);
  expect(queries).toBeLessThan(25);
  const [row] =
    await shared.admin`select count(*)::int n,min(reconcile_attempts)::int attempts from session_background_commands where session_id=${sessionId} and state='running'`;
  expect(row!.n).toBe(25);
  expect(row!.attempts).toBe(1);
});
