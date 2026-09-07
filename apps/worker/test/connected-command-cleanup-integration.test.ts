import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createDb, createEnrollment, createSession } from "@opengeni/db";
import { ErrorCode, ExecRequest } from "@opengeni/agent-proto";
import type { OpStreamConnection } from "@opengeni/events";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
  SelfhostedControlError,
  subjectFor,
  type ControlRpc,
} from "@opengeni/runtime/sandbox";
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
  // The sweep freezes a JavaScript millisecond due frontier. The database's
  // clock_timestamp() default is evaluated per row at finer precision, so a
  // fresh batch can straddle that frontier. Seed every fixture row as due.
  await shared.admin`insert into session_background_commands(account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,connection_instance_id,op_id,reconcile_after)
 select ${accountId},${workspaceId!},${session.id},'connected_machine','running',${workspaceId!},${enrollment.id},'launch',gen_random_uuid()::text,'2000-01-01T00:00:00Z'::timestamptz from generate_series(1,25)`;
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
  const commands =
    await shared.admin`select control_workspace_id,enrollment_id,op_id from session_background_commands where session_id=${sessionId}`;
  const identity = commands[0]!;
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    workspaceId: identity.control_workspace_id,
    agentId: identity.enrollment_id,
    connectionInstanceId: "launch",
    transport,
  });
  const subject = subjectFor(identity.control_workspace_id, identity.enrollment_id, "launch");
  for (const command of commands) {
    runner.script(command.op_id, { frames: [{ channel: "stdout", bytes: "retained output" }] });
    await runner.request(
      subject,
      {
        requestId: command.op_id,
        epoch: 0,
        op: {
          $case: "opStart",
          opStart: {
            op: { $case: "exec", exec: ExecRequest.fromPartial({ command: ["work"] }) },
            windowBytes: "65536",
            deadlineMs: "0",
            originId: sessionId,
          },
        },
      },
      { timeoutMs: 1000 },
    );
  }
  const replayBus = {
    ...bus,
    getOpStreamConnection: () => opStreamConnectionFor(transport),
  } as Parameters<typeof reconcile>[3];
  let queries = 0;
  let attaches = 0;
  const rpc: ControlRpc = {
    request: async (requestSubject, request, options) => {
      const op = request.op!;
      if (op.$case === "opQuery") queries++;
      else if (op.$case === "opAttach") attaches++;
      else throw new Error("Cleanup must only query or attach existing operations");
      return await runner.request(requestSubject, request, options);
    },
  };
  await reconcile(client.db, settings, observability, replayBus, rpc);
  expect(warnings).toEqual([]);
  expect(queries).toBe(25);
  expect(attaches).toBe(25);
  const [output] =
    await shared.admin`select count(*)::int n from session_events where session_id=${sessionId} and type='sandbox.command.output.delta'`;
  expect(output!.n).toBe(25);
  expect([...runner.runs.values()].every((run) => run.startCount === 1 && !run.finalAcked)).toBe(
    true,
  );
  const [row] =
    await shared.admin`select count(*)::int n from session_background_commands where session_id=${sessionId} and state='exited'`;
  expect(row!.n).toBe(25);
  const [updates] =
    await shared.admin`select count(*)::int n from session_system_updates where session_id=${sessionId} and kind='background_command_result'`;
  expect(updates!.n).toBe(25);
  await reconcile(client.db, settings, observability, replayBus, rpc);
  expect(queries).toBe(25);
  expect(attaches).toBe(25);
});

/** Same async-iterator adapter as the routing integration fixture: production
 * NatsOpStreamTransport consumes frames from the canonical fake runner. */
function opStreamConnectionFor(transport: InMemoryOpStreamTransport): OpStreamConnection {
  return {
    subscribe(subject) {
      const values: Array<{ data: Uint8Array }> = [];
      const readers: Array<(result: IteratorResult<{ data: Uint8Array }>) => void> = [];
      let done = false;
      let release: (() => void) | undefined;
      void transport
        .subscribe(subject, (data) => {
          const reader = readers.shift();
          if (reader) reader({ done: false, value: { data } });
          else values.push({ data });
        })
        .then((subscription) => {
          if (done) subscription.unsubscribe();
          else release = subscription.unsubscribe;
        });
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              const value = values.shift();
              if (value) return Promise.resolve({ done: false as const, value });
              if (done) return Promise.resolve({ done: true as const, value: undefined });
              return new Promise<IteratorResult<{ data: Uint8Array }>>((resolve) =>
                readers.push(resolve),
              );
            },
          };
        },
        unsubscribe() {
          if (done) return;
          done = true;
          release?.();
          for (const reader of readers.splice(0)) reader({ done: true, value: undefined });
        },
      };
    },
    publish(subject, payload) {
      void transport.publish(subject, payload);
    },
    async flush() {},
  };
}
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
  expect(queries).toBe(1);
  const [row] =
    await shared.admin`select count(*)::int n,min(reconcile_attempts)::int attempts,max(reconcile_attempts)::int max_attempts from session_background_commands where session_id=${sessionId} and state='running'`;
  expect(row!.n).toBe(25);
  expect(row!.attempts).toBe(1);
  expect(row!.max_attempts).toBe(1);
});
