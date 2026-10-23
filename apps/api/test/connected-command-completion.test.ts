import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AgentEvent,
  AgentEventAck,
  OpExit,
  ExecResponse,
  OpLostReason,
  OpState,
  type ControlRequest,
} from "@opengeni/agent-proto";
import type { EventBus } from "@opengeni/events";
import { subjectFor, type ControlRpc, type OpStreamExecClient } from "@opengeni/runtime/sandbox";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  adoptConnectedMachineSessionBackgroundCommand,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSandboxEnrollment,
  createSession,
  createWorkspace,
  initializeSessionStartAtomically,
  listSessionEvents,
  settleConnectedMachineSessionBackgroundCommand,
  settleCollectedConnectedMachineBackgroundCommand,
  settleClaimedConnectedMachineBackgroundCommand,
} from "@opengeni/db";
import { CONNECTED_COMMAND_CHILD_CLEANUP_NOTICE } from "@opengeni/contracts";
import {
  getSessionBackgroundCommand,
  locateConnectedCommandCompletion,
  readSessionBackgroundCommandOutput,
  claimPushedConnectedCommandCompletion,
  deferConnectedMachineBackgroundCommandReconciliation,
  recordConnectedMachineBackgroundCommandProof,
} from "@opengeni/db/session-background-commands";
import { createConnectedCommandOutputCapture } from "@opengeni/db/session-command-output";
import { handleAgentEventPayload } from "../src/sandbox/metrics-ingestion";
import { ingestConnectedCommandCompletion } from "../src/sandbox/command-completion";

function reader(
  exitCode: number | OpExit,
  chunk = "final output\n",
): Pick<OpStreamExecClient, "readExisting"> {
  const exit = typeof exitCode === "number" ? OpExit.fromPartial({ exitCode }) : exitCode;
  return {
    readExisting: async (_opId, _yieldMs, capture) => {
      await capture([{ sequence: "1", stream: "stdout", chunk }]);
      return {
        status: "completed",
        replaySequence: "2",
        outputReceipt: { exitSeq: "2", attachGeneration: "1" },
        outcome: {
          response: ExecResponse.fromPartial({ exitCode: exit.exitCode, timedOut: exit.timedOut }),
          terminalExit: exit,
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
}, 180_000);

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
  await ingestConnectedCommandCompletion(
    client.db,
    ids(command),
    completed,
    bus,
    reader(completed.exit),
  );
  const result = await getSessionBackgroundCommand(client.db, command);
  expect(result).toMatchObject({ state: "exited", exitCode: -1, settlementReason: "op_cancelled" });
  await ingestConnectedCommandCompletion(
    client.db,
    ids(command),
    completed,
    bus,
    reader(completed.exit),
  );
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
      reader(exit ?? -1),
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
  // Model a reaper claim already in flight before the first exit notification.
  await shared.admin`update session_background_commands set completion_notified_at = null,
    reconcile_claimed_at = now() - interval '1 second' where id = ${command.commandId}`;
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

test("repeated delivery cannot bypass failed-collection backoff and delivery ACK does not claim custody", async () => {
  const command = await fixture();
  const completed = { opId: command.opId, exit: OpExit.fromPartial({ exitCode: 0 }) };
  const acknowledgements: AgentEventAck[] = [];
  const bus = Object.assign(new MemoryEventBus(), {
    getOpStreamConnection: () =>
      ({
        publish: (subject: string, bytes: Uint8Array) => {
          expect(subject).toBe(
            `agent.${command.controlWorkspaceId}.${command.enrollmentId}.connection.${command.connectionInstanceId}.ack`,
          );
          acknowledgements.push(AgentEventAck.decode(bytes));
        },
      }) as unknown as ReturnType<NonNullable<EventBus["getOpStreamConnection"]>>,
  });
  let reads = 0;
  const failed: Pick<OpStreamExecClient, "readExisting"> = {
    readExisting: async () => {
      reads++;
      expect(acknowledgements.length).toBeGreaterThan(0);
      throw new Error("retained replay unavailable");
    },
  };
  await expect(
    ingestConnectedCommandCompletion(client.db, ids(command), completed, bus, failed),
  ).rejects.toThrow("retained replay unavailable");
  for (let retry = 0; retry < 5; retry++)
    await ingestConnectedCommandCompletion(client.db, ids(command), completed, bus, failed);
  expect(reads).toBe(1);
  expect(acknowledgements[0]?.ack).toEqual({
    $case: "operationCompleted",
    operationCompleted: { opId: command.opId },
  });
  const [deferred] =
    await shared.admin`select reconcile_after > now() as backed_off, completion_notified_at,
    output_consumed_at, state from session_background_commands where id = ${command.commandId}`;
  expect(deferred).toMatchObject({
    backed_off: true,
    completion_notified_at: expect.any(Date),
    output_consumed_at: null,
    state: "running",
  });
  await shared.admin`update session_background_commands set reconcile_after = now() where id = ${command.commandId}`;
  await expect(
    ingestConnectedCommandCompletion(client.db, ids(command), completed, bus, failed),
  ).rejects.toThrow("retained replay unavailable");
  expect(reads).toBe(2);
  const [retry] =
    await shared.admin`select reconcile_after > now() + interval '50 seconds' as increased from session_background_commands where id = ${command.commandId}`;
  expect(retry.increased).toBe(true);
});

test("verified replay supplies the exit proof, not a disagreeing event payload", async () => {
  const command = await fixture();
  await ingestConnectedCommandCompletion(
    client.db,
    ids(command),
    {
      opId: command.opId,
      exit: OpExit.fromPartial({ exitCode: 9, cancelled: true, failureCode: "STALE" }),
    },
    undefined,
    reader(0),
  );
  expect(await getSessionBackgroundCommand(client.db, command)).toMatchObject({
    state: "exited",
    exitCode: 0,
    settlementReason: "op_exit",
  });
});

test("an attached owner winning settlement is benign and the collector keeps its output receipt", async () => {
  const command = await fixture();
  const claim = await claimPushedConnectedCommandCompletion(client.db, {
    ...command,
    claimTtlMs: 300_000,
  });
  await createConnectedCommandOutputCapture(client.db, command)(command.commandId, [
    { sequence: "1", stream: "stdout", chunk: "captured" },
  ]);
  await settleConnectedMachineSessionBackgroundCommand(client.db, {
    ...command,
    outcome: "exited",
    exitCode: 0,
    reason: "op_exit",
  });
  expect(
    await settleCollectedConnectedMachineBackgroundCommand(client.db, {
      claim: claim!,
      proof: { outcome: "exited", exitCode: 0, reason: "op_exit", observedAt: new Date() },
      receipt: { exitSeq: "2", attachGeneration: "1" },
    }),
  ).toBe(false);
  const [row] =
    await shared.admin`select output_consumed_at from session_background_commands where id = ${command.commandId}`;
  expect(row.output_consumed_at).not.toBeNull();
  expect(
    (await listSessionEvents(client.db, command.workspaceId, command.sessionId)).filter(
      (event) => event.type === "session.command.finished",
    ),
  ).toHaveLength(1);
});

test("custody checkpoint failure cannot suppress already committed terminal fanout", async () => {
  const command = await fixture();
  const claim = await claimPushedConnectedCommandCompletion(client.db, {
    ...command,
    claimTtlMs: 300_000,
  });
  let published = 0;
  await expect(
    settleCollectedConnectedMachineBackgroundCommand(client.db, {
      claim: claim!,
      proof: { outcome: "exited", exitCode: 0, reason: "op_exit", observedAt: new Date() },
      receipt: { exitSeq: "invalid", attachGeneration: "1" },
      publish: async (events) => {
        published += events.filter((event) => event.type === "session.command.finished").length;
      },
    }),
  ).rejects.toThrow("invalid frontier");
  expect(published).toBe(1);
  expect(await getSessionBackgroundCommand(client.db, command)).toMatchObject({ state: "exited" });
});

test("only observed child cleanup adds a durable final result notice", async () => {
  for (const stopped of [false, true]) {
    const command = await fixture();
    await settleConnectedMachineSessionBackgroundCommand(client.db, {
      ...command,
      outcome: "exited",
      exitCode: 0,
      reason: "op_exit",
      backgroundChildrenStopped: stopped,
    });
    const [update] =
      await shared.admin`select payload from session_system_updates where session_id = ${command.sessionId} and kind = 'background_command_result'`;
    expect(update.payload.notice).toBe(
      stopped ? CONNECTED_COMMAND_CHILD_CLEANUP_NOTICE : undefined,
    );
    for (let read = 0; read < 2; read++) {
      const result = await readSessionBackgroundCommandOutput(client.db, command);
      expect(result.notice).toBe(stopped ? CONNECTED_COMMAND_CHILD_CLEANUP_NOTICE : undefined);
      expect(result.chunks).toEqual([]);
      if (!stopped) expect(Object.keys(result)).not.toContain("notice");
    }
  }
});

test("pushed cleanup notice comes from verified retained output, not notification text", async () => {
  for (const stopped of [false, true]) {
    const command = await fixture();
    await ingestConnectedCommandCompletion(
      client.db,
      ids(command),
      {
        opId: command.opId,
        exit: OpExit.fromPartial({ exitCode: 0, backgroundChildrenStopped: !stopped }),
      },
      undefined,
      reader(OpExit.fromPartial({ exitCode: 0, backgroundChildrenStopped: stopped })),
    );
    const result = await readSessionBackgroundCommandOutput(client.db, command);
    expect(result.notice).toBe(stopped ? CONNECTED_COMMAND_CHILD_CLEANUP_NOTICE : undefined);
    expect(result.chunks[0]?.chunk).toBe("final output\n");
  }
});

test("reconciled cleanup evidence remains positive across settlement", async () => {
  const command = await fixture();
  const claim = {
    ...command,
    claimId: crypto.randomUUID(),
    state: "running" as const,
    reconcileAttempts: 1,
    proof: null,
  };
  await shared.admin`update session_background_commands set reconcile_claim_id = ${claim.claimId}, reconcile_claimed_at = now() where id = ${command.commandId}`;
  await recordConnectedMachineBackgroundCommandProof(client.db, {
    claim,
    proof: {
      outcome: "exited",
      exitCode: 0,
      reason: "op_exit",
      observedAt: new Date(),
      backgroundChildrenStopped: true,
    },
  });
  await settleClaimedConnectedMachineBackgroundCommand(client.db, { claim });
  expect((await readSessionBackgroundCommandOutput(client.db, command)).notice).toBe(
    CONNECTED_COMMAND_CHILD_CLEANUP_NOTICE,
  );
});

/** The command's runner (the agent of the session's compute sandbox),
 * enrolled and live on the command's own connection instance, with the
 * capabilities its Hello advertised. */
async function liveRunner(
  command: Awaited<ReturnType<typeof fixture>>,
  capabilities: Record<string, boolean>,
  kind: "sandbox" | "machine" = "sandbox",
) {
  const [session] =
    await shared.admin`select sandbox_group_id from sessions where id=${command.sessionId}`;
  await createSandboxEnrollment(client.db, {
    accountId: command.accountId,
    workspaceId: command.controlWorkspaceId,
    enrollmentId: command.enrollmentId,
    sandboxGroupId: session!.sandbox_group_id,
    hasDisplay: false,
    workspaceRoot: "/workspace",
  });
  await shared.admin`update enrollments set connection_instance_id=${command.connectionInstanceId},
    connection_lease_expires_at=now()+interval '1 hour',
    agent_capabilities=${JSON.stringify(capabilities)}::jsonb where id=${command.enrollmentId}`;
  // A Connected Machine: its agent may predate OpRelease.
  if (kind === "machine")
    await shared.admin`update enrollments set kind='machine', sandbox_group_id=null, link_epoch=null,
      pubkey=${`test-key-${command.enrollmentId}`} where id=${command.enrollmentId}`;
  return command;
}

/** The runner's answers to OpRelease: `answer` decides each one. */
function releaseRunner(answer: (request: ControlRequest) => "released" | "complete" | "offline") {
  const requests: Array<{ subject: string; request: ControlRequest }> = [];
  const rpc: ControlRpc = {
    request: async (subject, request) => {
      requests.push({ subject, request });
      const opId = request.op?.$case === "opRelease" ? request.op.opRelease.opId : "";
      const outcome = answer(request);
      if (outcome === "offline") throw new Error("synthetic: no responder");
      return {
        requestId: request.requestId,
        error: undefined,
        result: {
          $case: "opStatus",
          opStatus:
            outcome === "released"
              ? {
                  opId,
                  state: OpState.OP_STATE_LOST,
                  nextSeq: "0",
                  writeOffset: "0",
                  exit: undefined,
                  lostReason: OpLostReason.OP_LOST_REASON_RELEASED,
                }
              : {
                  opId,
                  state: OpState.OP_STATE_COMPLETE,
                  nextSeq: "3",
                  writeOffset: "0",
                  exit: OpExit.fromPartial({ exitCode: 0 }),
                  lostReason: OpLostReason.OP_LOST_REASON_UNSPECIFIED,
                },
        },
      };
    },
  };
  return { rpc, requests };
}

async function storedCustody(commandId: string) {
  return (
    await shared.admin`select output_consumed_at, output_release_observed_at, last_reconcile_outcome,
      reconcile_after <= now() as output_due from session_background_commands where id = ${commandId}`
  )[0]!;
}

test("a runner serving OpRelease has a pushed command's output released where it is stored, in one exchange", async () => {
  const command = await liveRunner(await fixture(), { opRelease: true });
  const runner = releaseRunner(() => "released");
  const completed = { opId: command.opId, exit: OpExit.fromPartial({ exitCode: 0 }) };
  await ingestConnectedCommandCompletion(
    client.db,
    ids(command),
    completed,
    new MemoryEventBus(),
    reader(completed.exit),
    runner.rpc,
  );
  expect(await getSessionBackgroundCommand(client.db, command)).toMatchObject({
    state: "exited",
    exitCode: 0,
  });
  // One OpRelease for exactly the stored exit frame, at the runner's own
  // address; its answer settles the release.
  expect(runner.requests).toHaveLength(1);
  expect(runner.requests[0]!.subject).toBe(
    subjectFor(command.controlWorkspaceId, command.enrollmentId, command.connectionInstanceId),
  );
  expect(runner.requests[0]!.request.op).toEqual({
    $case: "opRelease",
    opRelease: { opId: command.opId, exitSeq: "2" },
  });
  expect(await storedCustody(command.commandId)).toMatchObject({
    output_consumed_at: expect.any(Date),
    output_release_observed_at: expect.any(Date),
    last_reconcile_outcome: "output_released",
  });
  // A duplicate push changes nothing and sends nothing.
  await ingestConnectedCommandCompletion(
    client.db,
    ids(command),
    completed,
    new MemoryEventBus(),
    reader(completed.exit),
    runner.rpc,
  );
  expect(runner.requests).toHaveLength(1);
});

test("a runner without OpRelease, or a release that fails, leaves the stored output to the reconciler", async () => {
  const completed = (opId: string) => ({ opId, exit: OpExit.fromPartial({ exitCode: 0 }) });
  // A Connected Machine without the capability: no release is sent.
  const legacy = await liveRunner(await fixture(), { opStream: true }, "machine");
  const quiet = releaseRunner(() => "released");
  await ingestConnectedCommandCompletion(
    client.db,
    ids(legacy),
    completed(legacy.opId),
    new MemoryEventBus(),
    reader(0),
    quiet.rpc,
  );
  expect(quiet.requests).toHaveLength(0);
  expect(await storedCustody(legacy.commandId)).toMatchObject({
    output_consumed_at: expect.any(Date),
    output_release_observed_at: null,
    output_due: true,
  });

  // The runner answers the op still retained (another frontier): nothing is
  // recorded, and the reconciler keeps the obligation.
  const disagreeing = await liveRunner(await fixture(), { opRelease: true });
  const complete = releaseRunner(() => "complete");
  await ingestConnectedCommandCompletion(
    client.db,
    ids(disagreeing),
    completed(disagreeing.opId),
    new MemoryEventBus(),
    reader(0),
    complete.rpc,
  );
  expect(complete.requests).toHaveLength(1);
  expect(await storedCustody(disagreeing.commandId)).toMatchObject({
    output_release_observed_at: null,
    output_due: true,
  });

  // The runner went away between storing and releasing: the command is
  // settled all the same, and the reconciler recovers the release.
  const gone = await liveRunner(await fixture(), { opRelease: true });
  const offline = releaseRunner(() => "offline");
  await ingestConnectedCommandCompletion(
    client.db,
    ids(gone),
    completed(gone.opId),
    new MemoryEventBus(),
    reader(0),
    offline.rpc,
  );
  expect(offline.requests).toHaveLength(1);
  expect(await getSessionBackgroundCommand(client.db, gone)).toMatchObject({ state: "exited" });
  expect(await storedCustody(gone.commandId)).toMatchObject({
    output_consumed_at: expect.any(Date),
    output_release_observed_at: null,
    output_due: true,
  });
});
