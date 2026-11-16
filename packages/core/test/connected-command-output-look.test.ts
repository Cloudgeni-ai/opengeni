// A Connected Machine command keeps running on its machine whatever its
// session does next. A later attempt (after the session moved to another
// machine and back, or in a later turn) reads its output from the machine its
// ledger names, not from the session's current machine.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { ExecRequest } from "@opengeni/agent-proto";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { OpStreamExecClient } from "@opengeni/runtime/sandbox";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
} from "../../runtime/src/sandbox/selfhosted/op-testing";
import { connectedCommandOutputLook } from "../src/sandbox/agent-background-commands";

let shared: SharedTestDatabase;
let client: DbClient;
let accountId: string, workspaceId: string, sessionId: string;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("connected-command-output-look");
  if (!acquired) throw new Error("Connected command output look tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Output look",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Output look",
    subjectId: `test-${suffix}`,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Output look",
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
  await client?.close();
  await shared?.release();
}, 60_000);

const CONNECTION = "launch-connection";

async function runningCommand(lines: string[]) {
  const enrollmentId = crypto.randomUUID();
  const opId = `${crypto.randomUUID()}:0`;
  const commandId = crypto.randomUUID();
  await shared.admin`insert into session_background_commands ${shared.admin({
    id: commandId,
    account_id: accountId,
    workspace_id: workspaceId,
    session_id: sessionId,
    provider: "connected_machine",
    state: "running",
    control_workspace_id: workspaceId,
    enrollment_id: enrollmentId,
    connection_instance_id: CONNECTION,
    op_id: opId,
  })}`;
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    transport,
    workspaceId,
    agentId: enrollmentId,
    connectionInstanceId: CONNECTION,
  });
  runner.script(opId, {
    runningRetained: true,
    frames: lines.map((bytes) => ({ channel: "stdout" as const, bytes })),
  });
  const rpcSubject = `agent.${workspaceId}.${enrollmentId}.connection.${CONNECTION}.rpc`;
  await runner.request(
    rpcSubject,
    {
      requestId: opId,
      epoch: 0,
      op: {
        $case: "opStart",
        opStart: {
          op: { $case: "exec", exec: ExecRequest.fromPartial({ command: ["work"] }) },
          windowBytes: "65536",
          deadlineMs: "0",
          originId: "launching-attempt",
        },
      },
    },
    { timeoutMs: 1000 },
  );
  const locators: Array<{ enrollmentId: string; connectionInstanceId: string }> = [];
  const readerFor = (locator: {
    controlWorkspaceId: string;
    enrollmentId: string;
    connectionInstanceId: string;
  }) => {
    locators.push(locator);
    return new OpStreamExecClient({
      workspaceId: locator.controlWorkspaceId,
      agentId: locator.enrollmentId,
      connectionInstanceId: locator.connectionInstanceId,
      epoch: 0,
      rpcSubject,
      transport,
      controlRpc: runner,
      controlTimeoutMs: 1000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      journal: { attachGeneration: () => String(Date.now()), persistSettled: () => {} },
    });
  };
  return { commandId, enrollmentId, opId, runner, readerFor, locators };
}

async function storedOutput(commandId: string) {
  const rows =
    await shared.admin`select payload->>'chunk' as chunk from session_events where session_id=${sessionId} and type='sandbox.command.output.delta' and payload->>'commandId'=${commandId} order by sequence`;
  return rows.map((row) => row.chunk as string).join("");
}

test("a later attempt reads a running command's output from the machine its ledger names", async () => {
  const lines = Array.from({ length: 600 }, (_, index) => `line ${index}\n`);
  const command = await runningCommand(lines);
  const look = connectedCommandOutputLook(
    client.db,
    new MemoryEventBus(),
    { accountId, workspaceId, sessionId },
    command.readerFor,
  );
  expect(await look(command.commandId)).toBe(true);
  expect(command.locators).toEqual([
    expect.objectContaining({
      enrollmentId: command.enrollmentId,
      connectionInstanceId: CONNECTION,
    }),
  ]);
  expect(await storedOutput(command.commandId)).toBe(lines.join(""));
  // The next look reuses its reader and continues from where it stopped.
  expect(await look(command.commandId)).toBe(true);
  expect(command.locators).toHaveLength(1);
  expect(await storedOutput(command.commandId)).toBe(lines.join(""));
});

test("a look answers false for commands it cannot read, and the stored output stands", async () => {
  const command = await runningCommand(["kept\n"]);
  const look = connectedCommandOutputLook(
    client.db,
    new MemoryEventBus(),
    { accountId, workspaceId, sessionId },
    command.readerFor,
  );
  expect(await look(crypto.randomUUID())).toBe(false);
  await shared.admin`update session_background_commands set state='exited', exit_code=0, settled_at=now() where id=${command.commandId}`;
  expect(await look(command.commandId)).toBe(false);
  expect(command.locators).toHaveLength(0);
  // A machine that no longer has the command.
  const lost = await runningCommand(["gone\n"]);
  lost.runner.lostOps.add(lost.opId);
  const lostLook = connectedCommandOutputLook(
    client.db,
    new MemoryEventBus(),
    { accountId, workspaceId, sessionId },
    lost.readerFor,
  );
  expect(await lostLook(lost.commandId)).toBe(false);
});
