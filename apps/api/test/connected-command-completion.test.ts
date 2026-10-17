import { afterAll, beforeAll, expect, test } from "bun:test";
import { AgentEvent, OpExit, ExecResponse } from "@opengeni/agent-proto";
import type { OpStreamExecClient } from "@opengeni/runtime/sandbox";
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
  claimPushedConnectedCommandCompletion,
  deferConnectedMachineBackgroundCommandReconciliation,
} from "@opengeni/db/session-background-commands";
import { handleAgentEventPayload } from "../src/sandbox/metrics-ingestion";
import { ingestConnectedCommandCompletion } from "../src/sandbox/command-completion";

function reader(
  exitCode: number,
  chunk = "final output\n",
): Pick<OpStreamExecClient, "readExisting"> {
  return {
    readExisting: async (_opId, _yieldMs, capture) => {
      await capture([{ sequence: "1", stream: "stdout", chunk }]);
      return {
        status: "completed",
        replaySequence: "2",
        outputReceipt: { exitSeq: "2", attachGeneration: "1" },
        outcome: {
          response: ExecResponse.fromPartial({ exitCode }),
          heals: 0,
          startRetries: 0,
          replyBytes: chunk.length,
        },
      };
    },
  };
}

function ids(command: Awaited<ReturnType<typeof fixture>>) {
  return {
    workspaceId: command.controlWorkspaceId,
    agentId: command.enrollmentId,
    connectionInstanceId: command.connectionInstanceId,
  };
}

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
  // An event without an available output transport cannot create a terminal row.
  await handleAgentEventPayload(client.db, undefined, payload, subject);
  expect(await getSessionBackgroundCommand(client.db, command)).toMatchObject({ state: "running" });
  const completed = {
    opId: command.opId,
    exit: OpExit.fromPartial({ exitCode: -1, cancelled: true }),
  };
  await ingestConnectedCommandCompletion(client.db, ids(command), completed, bus, reader(-1));
  const result = await getSessionBackgroundCommand(client.db, command);
  expect(result).toMatchObject({ state: "exited", exitCode: -1, settlementReason: "op_cancelled" });
  await ingestConnectedCommandCompletion(client.db, ids(command), completed, bus, reader(-1));
  expect(
    (await listSessionEvents(client.db, command.workspaceId, command.sessionId)).filter(
      (event) => event.type === "session.command.finished",
    ),
  ).toHaveLength(1);
  const [custody] =
    await shared.admin`select output_consumed_at, output_release_observed_at, reconcile_after <= now() as output_due from session_background_commands where id = ${command.commandId}`;
  expect(custody).toEqual({
    output_consumed_at: expect.any(Date),
    output_release_observed_at: null,
    output_due: true,
  });
  const page = await readSessionBackgroundCommandOutput(client.db, command);
  expect(page?.chunks.map((chunk) => chunk.chunk).join("")).toBe("final output\n");
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
    if (!exit) await handleAgentEventPayload(client.db, undefined, payload, subject);
    await ingestConnectedCommandCompletion(
      client.db,
      ids(command),
      { opId: command.opId, exit },
      undefined,
      reader(-1),
    );
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

test("completion stays running until output capture finishes, and failed replay cannot publish terminal state", async () => {
  const command = await fixture();
  const completed = { opId: command.opId, exit: OpExit.fromPartial({ exitCode: 0 }) };
  let finish!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const slow: Pick<OpStreamExecClient, "readExisting"> = {
    readExisting: async (...args) => {
      entered();
      await gate;
      return reader(0).readExisting(...args);
    },
  };
  const pending = ingestConnectedCommandCompletion(
    client.db,
    ids(command),
    completed,
    undefined,
    slow,
  );
  await started;
  expect(await getSessionBackgroundCommand(client.db, command)).toMatchObject({ state: "running" });
  expect(
    (await listSessionEvents(client.db, command.workspaceId, command.sessionId)).filter(
      (event) => event.type === "session.command.finished",
    ),
  ).toHaveLength(0);
  finish();
  await pending;
  expect(await getSessionBackgroundCommand(client.db, command)).toMatchObject({ state: "exited" });
  expect((await readSessionBackgroundCommandOutput(client.db, command))?.chunks[0]?.chunk).toBe(
    "final output\n",
  );

  const failed = await fixture();
  await expect(
    ingestConnectedCommandCompletion(
      client.db,
      ids(failed),
      { ...completed, opId: failed.opId },
      undefined,
      {
        readExisting: async () => {
          throw new Error("capture failed");
        },
      },
    ),
  ).rejects.toThrow("capture failed");
  expect(await getSessionBackgroundCommand(client.db, failed)).toMatchObject({ state: "running" });
});

test("push cannot steal an active collector and preserves its wake through a concurrent defer", async () => {
  const command = await fixture();
  const claim = await claimPushedConnectedCommandCompletion(client.db, {
    ...command,
    claimTtlMs: 300_000,
  });
  expect(claim).not.toBeNull();
  expect(
    await claimPushedConnectedCommandCompletion(client.db, { ...command, claimTtlMs: 300_000 }),
  ).toBeNull();
  await deferConnectedMachineBackgroundCommandReconciliation(client.db, {
    claim: claim!,
    outcome: "provider_running",
    retryAfterMs: 300_000,
  });
  const [row] =
    await shared.admin`select reconcile_after <= now() as due from session_background_commands where id = ${command.commandId}`;
  expect(row.due).toBe(true);
});
