import { afterAll, beforeAll, expect, test } from "bun:test";
import { AgentEvent, OpExit } from "@opengeni/agent-proto";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  adoptConnectedMachineSessionBackgroundCommand,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createWorkspace,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import {
  getSessionBackgroundCommand,
  locateConnectedCommandCompletion,
  readSessionBackgroundCommandOutput,
} from "@opengeni/db/session-background-commands";
import { handleAgentEventPayload } from "../src/sandbox/metrics-ingestion";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("connected-command-completion");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(crossWorkspace = false) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Command completion",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Command completion",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const controlWorkspaceId = crossWorkspace
    ? (await createWorkspace(client.db, { accountId: grant.accountId, name: "Machine control" })).id
    : grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "Run command",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("fixture claim failed");
  const identity = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    commandId: crypto.randomUUID(),
    controlWorkspaceId,
    enrollmentId: crypto.randomUUID(),
    connectionInstanceId: crypto.randomUUID(),
    opId: crypto.randomUUID(),
  };
  await adoptConnectedMachineSessionBackgroundCommand(client.db, {
    ...identity,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    command: "sleep 30",
  });
  return identity;
}

test("pushed terminal proof settles the original command once despite route changes and reaper backoff", async () => {
  const command = await fixture(true);
  await shared.admin`update sessions set active_epoch = active_epoch + 3 where id = ${command.sessionId}`;
  await shared.admin`update session_background_commands set reconcile_after = now() + interval '5 minutes' where id = ${command.commandId}`;
  const payload = AgentEvent.encode({
    event: {
      $case: "operationCompleted",
      operationCompleted: {
        opId: command.opId,
        exit: OpExit.fromPartial({ exitCode: -1, cancelled: true }),
      },
    },
  }).finish();
  const subject = `agent.${command.controlWorkspaceId}.${command.enrollmentId}.connection.${command.connectionInstanceId}.events`;
  const bus = new MemoryEventBus();
  await handleAgentEventPayload(client.db, undefined, payload, subject, bus);
  const result = await getSessionBackgroundCommand(client.db, command);
  expect(result).toMatchObject({ state: "exited", exitCode: -1, settlementReason: "op_cancelled" });
  await handleAgentEventPayload(client.db, undefined, payload, subject, bus);
  expect(
    (await listSessionEvents(client.db, command.workspaceId, command.sessionId)).filter(
      (event) => event.type === "session.command.finished",
    ),
  ).toHaveLength(1);
  const [custody] =
    await shared.admin`select output_consumed_at, output_release_observed_at, reconcile_after <= now() as output_due from session_background_commands where id = ${command.commandId}`;
  expect(custody).toEqual({
    output_consumed_at: null,
    output_release_observed_at: null,
    output_due: true,
  });
  const read = await readSessionBackgroundCommandOutput(client.db, command);
  expect(read.scopeNotice).toContain("Any remaining background child processes were stopped");
  expect(read.scopeNotice).toContain("command_read/command_wait");
  expect(read.chunks).toEqual([]);
});

test("wrong process, enrollment, control workspace and operation cannot settle another command", async () => {
  const command = await fixture();
  for (const key of [
    "connectionInstanceId",
    "enrollmentId",
    "controlWorkspaceId",
    "opId",
  ] as const) {
    expect(
      await locateConnectedCommandCompletion(client.db, { ...command, [key]: crypto.randomUUID() }),
    ).toBeNull();
  }
  expect(await getSessionBackgroundCommand(client.db, command)).toMatchObject({
    state: "running",
    exitCode: null,
  });
  expect(
    (await readSessionBackgroundCommandOutput(client.db, command)).scopeNotice,
  ).toBeUndefined();
});

test("runner failures keep their typed detail and a missing exit is not terminal proof", async () => {
  const command = await fixture();
  const subject = `agent.${command.controlWorkspaceId}.${command.enrollmentId}.connection.${command.connectionInstanceId}.events`;
  for (const exit of [
    undefined,
    OpExit.fromPartial({
      exitCode: -1,
      failureCode: "OP_PIPE_IO",
      failureDetail: { error: "synthetic pipe failure" },
    }),
  ]) {
    const payload = AgentEvent.encode({
      event: { $case: "operationCompleted", operationCompleted: { opId: command.opId, exit } },
    }).finish();
    await handleAgentEventPayload(client.db, undefined, payload, subject);
    const result = await getSessionBackgroundCommand(client.db, command);
    expect(result?.state).toBe(exit ? "exited" : "running");
    if (exit)
      expect(result?.failure).toEqual({
        code: "OP_PIPE_IO",
        detail: { error: "synthetic pipe failure" },
        retryable: false,
      });
  }
});
