import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { CommandReadResult } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  settleConnectedMachineSessionBackgroundCommand,
  settleClaimedConnectedMachineBackgroundCommand,
  type DbClient,
} from "../src";
import { appendSessionCommandOutput } from "../src/session-command-output";
import {
  readSessionBackgroundCommandOutput,
  recordConnectedMachineBackgroundCommandProof,
} from "../src/session-background-commands";
import { fromPostgresLosslessJson } from "../src/lossless-json";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
} from "../../runtime/src/sandbox/selfhosted/op-testing";
import { SelfhostedSession } from "../../runtime/src/sandbox/selfhosted/session";
import { runWithToolCallCorrelation } from "../../runtime/src/sandbox/op-correlation";

let shared: SharedTestDatabase;
let client: DbClient;
let accountId: string, workspaceId: string, sessionId: string, sandboxGroupId: string;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-command-output");
  if (!acquired) throw new Error("Command output tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Output capture",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Output capture",
    subjectId: `test-${suffix}`,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Output capture",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
  sandboxGroupId = session.sandboxGroupId;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function connected(
  enrollmentId: string = crypto.randomUUID(),
  opId: string = crypto.randomUUID(),
) {
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
    connection_instance_id: "launch",
    op_id: opId,
  })}`;
  return { accountId, workspaceId, sessionId, commandId };
}

test("native zero-exit failure persists exact details in pending notification and a fresh reader", async () => {
  for (const failureCode of [
    "OP_OVERFLOW",
    "OP_PIPE_IO",
    "OP_SPOOL_IO",
    "OP.BAD:" + "x".repeat(140),
  ]) {
    const persistedCode = failureCode.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
    const enrollmentId = crypto.randomUUID();
    const correlation = crypto.randomUUID();
    const opId = `${correlation}:0`;
    const identity = await connected(enrollmentId, opId);
    const transport = new InMemoryOpStreamTransport();
    const runner = new FakeOpRunner({
      transport,
      workspaceId,
      agentId: enrollmentId,
      connectionInstanceId: "launch",
    });
    const detail = { retained_bytes: "268435456", stdout_bytes: "7" };
    runner.script(opId, {
      live: true,
      holdUntilCancel: true,
      frames: [{ channel: "stdout", bytes: "partial" }],
      exit: { exitCode: 0, failureCode, failureDetail: detail },
    });
    const session = new SelfhostedSession({
      workspaceId,
      workspaceRoot: "/home/user/project",
      agentId: enrollmentId,
      connectionInstanceId: "launch",
      controlRpc: runner,
      relay: { host: "relay.test" },
      timeoutMs: 2000,
      execTimeoutMs: 5000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      opStream: { transport },
      adoptBackgroundCommand: async () => ({ commandId: identity.commandId }),
      captureBackgroundCommandOutput: async (_id, frames) => {
        for (const frame of frames)
          await appendSessionCommandOutput(client.db, {
            ...identity,
            ...frame,
            chunkId: `op-frame:${frame.sequence}`,
          });
      },
      settleBackgroundCommand: async (command) => {
        await settleConnectedMachineSessionBackgroundCommand(client.db, {
          ...identity,
          ...command,
        });
      },
    });
    await runWithToolCallCorrelation(correlation, () =>
      session.execCommand({ cmd: "work", yieldTimeMs: 1 }),
    );
    runner.runs.get(opId)!.script.holdUntilCancel = false;
    await expect(session.refreshOwnedCommand(identity.commandId)).rejects.toMatchObject({
      detail: { failure_code: failureCode, ...detail },
    });
    const [notification] =
      await shared.admin`select classification, summary, payload, payload_codec_version, state from session_system_updates where session_id=${sessionId} and source_id=${identity.commandId} and kind='background_command_result'`;
    expect(notification).toMatchObject({ classification: "failure", state: "pending" });
    expect(notification!.summary).not.toContain("completed successfully");
    expect(
      fromPostgresLosslessJson(notification!.payload, notification!.payload_codec_version),
    ).toMatchObject({ failure: { code: persistedCode, detail, retryable: false } });
    const newClient = createDb(shared.appUrl, { max: 1 });
    try {
      const read = await readSessionBackgroundCommandOutput(newClient.db, identity);
      const parsed = CommandReadResult.parse({
        ...read,
        waitedMs: 0,
        timedOut: false,
        aborted: false,
        liveFanout: false,
      });
      expect(parsed).toMatchObject({
        exitCode: 0,
        terminal: true,
        failure: { code: persistedCode, detail, retryable: false },
      });
      expect(parsed.chunks.map((chunk) => chunk.chunk).join("")).toBe("partial");
    } finally {
      await newClient.close();
    }
  }
});

test("restored failure detail outside the application contract does not hide retained output", async () => {
  for (const detail of [{ count: 7 }, { text: "x".repeat(3000) }]) {
    const identity = await connected();
    await appendSessionCommandOutput(client.db, {
      ...identity,
      chunkId: "retained",
      stream: "stdout",
      chunk: "kept",
    });
    await shared.admin`update session_background_commands set state='exited', exit_code=0, settled_at=now(),
      runner_failure=${shared.admin.json({ code: "OP_OVERFLOW", retryable: false, detail })}
      where id=${identity.commandId}`;
    const result = await readSessionBackgroundCommandOutput(client.db, identity);
    expect(result?.failure).toMatchObject({
      code: "OP_OVERFLOW",
      retryable: false,
      detail: { metadata_error: expect.any(String) },
    });
    expect(result?.chunks.map((part) => part.chunk).join("")).toBe("kept");
  }
});

test("checkpointed runner details survive settlement recovery and conflicting proof fails closed", async () => {
  const enrollmentId = crypto.randomUUID();
  const opId = crypto.randomUUID();
  const identity = await connected(enrollmentId, opId);
  const claimId = crypto.randomUUID();
  await shared.admin`update session_background_commands set reconcile_claim_id=${claimId}, reconcile_claimed_at=now() where id=${identity.commandId}`;
  const claim = {
    ...identity,
    enrollmentId,
    opId,
    claimId,
    state: "running" as const,
    controlWorkspaceId: workspaceId,
    connectionInstanceId: "launch",
    reconcileAttempts: 1,
    proof: null,
  };
  const failure = {
    code: "OP_OVERFLOW",
    detail: { retained_bytes: "4096" },
    retryable: false as const,
  };
  const proof = {
    outcome: "exited" as const,
    exitCode: 0,
    reason: "op_failure_OP_OVERFLOW",
    failure,
    observedAt: new Date(),
  };
  await recordConnectedMachineBackgroundCommandProof(client.db, { claim, proof });
  await expect(
    recordConnectedMachineBackgroundCommandProof(client.db, {
      claim,
      proof: { ...proof, failure: { ...failure, detail: { retained_bytes: "8192" } } },
    }),
  ).rejects.toThrow("conflicts with durable proof");
  expect(
    await settleConnectedMachineSessionBackgroundCommand(client.db, {
      ...identity,
      controlWorkspaceId: workspaceId,
      enrollmentId,
      connectionInstanceId: "launch",
      opId,
      outcome: "exited",
      exitCode: 0,
      reason: proof.reason,
      failure: { ...failure, detail: { retained_bytes: "8192" } },
    }),
  ).toBeNull();
  const freshClient = createDb(shared.appUrl, { max: 1 });
  try {
    expect(
      (await settleClaimedConnectedMachineBackgroundCommand(freshClient.db, { claim })).settled,
    ).toBe(true);
    const [notification] =
      await shared.admin`select classification, payload, payload_codec_version from session_system_updates where session_id=${sessionId} and source_id=${identity.commandId} and kind='background_command_result'`;
    expect(notification!.classification).toBe("failure");
    expect(
      fromPostgresLosslessJson(notification!.payload, notification!.payload_codec_version),
    ).toMatchObject({ failure });
    expect((await readSessionBackgroundCommandOutput(freshClient.db, identity)).failure).toEqual(
      failure,
    );
  } finally {
    await freshClient.close();
  }
});

test("runner failure storage rejects malformed or oversized metadata without changing command state", async () => {
  const identity = await connected();
  for (const failure of [
    { retryable: false },
    { code: "OP_OVERFLOW", retryable: true },
    { code: "OP_OVERFLOW", retryable: false, detail: { bytes: "x".repeat(9000) } },
  ]) {
    await expect(
      (async () => {
        await shared.admin`update session_background_commands set runner_failure=${JSON.stringify(failure)}::jsonb where id=${identity.commandId}`;
      })(),
    ).rejects.toThrow("session_background_commands_runner_failure_check");
  }
  expect((await readSessionBackgroundCommandOutput(client.db, identity)).state).toBe("running");
});

test("captured frames are idempotent, pageable while running, and do not observe completion", async () => {
  const identity = await connected();
  const chunk = "prefix\0" + "🙂".repeat(20_000);
  const input = { ...identity, chunkId: "op-frame:1", stream: "stdout" as const, chunk };
  const receipts = await Promise.all([
    appendSessionCommandOutput(client.db, input),
    appendSessionCommandOutput(client.db, input),
  ]);
  expect(receipts.flat()).toHaveLength(3);
  expect(receipts.flat().every((event) => event.type === "sandbox.command.output.delta")).toBe(
    true,
  );
  let cursor: string | undefined;
  let recovered = "";
  do {
    const page = await readSessionBackgroundCommandOutput(client.db, {
      ...identity,
      ...(cursor ? { cursor } : {}),
      maxOutputBytes: 65536,
    });
    expect(page.terminal).toBe(false);
    expect(page.completionObservedAt).toBeNull();
    recovered += page.chunks.map((item) => item.chunk).join("");
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);
  expect(recovered).toBe(chunk);
  const [count] =
    await shared.admin`select count(*)::int as n from session_events where session_id=${sessionId} and type='sandbox.command.output.delta' and payload->>'commandId'=${identity.commandId}`;
  expect(count!.n).toBe(3);
});

test("unknown and cross-session command identities cannot publish output", async () => {
  const identity = await connected();
  await expect(
    appendSessionCommandOutput(client.db, {
      ...identity,
      commandId: crypto.randomUUID(),
      chunkId: "one",
      stream: "stdout",
      chunk: "no",
    }),
  ).rejects.toThrow("retained command identity");
  await expect(
    appendSessionCommandOutput(client.db, {
      ...identity,
      sessionId: crypto.randomUUID(),
      chunkId: "one",
      stream: "stdout",
      chunk: "no",
    }),
  ).rejects.toThrow();
});

test("already-settled zero-exit runner failures survive durable output read and public parsing", async () => {
  for (const failureCode of ["OP_OVERFLOW", "OP_PIPE_IO", "OP_SPOOL_IO", ""]) {
    const identity = await connected();
    const reason = failureCode ? `op_failure_${failureCode}` : "op_exit";
    await shared.admin`update session_background_commands set state='exited', exit_code=0, settlement_reason=${reason}, settled_at=now() where id=${identity.commandId}`;
    await appendSessionCommandOutput(client.db, {
      ...identity,
      chunkId: "op-frame:1",
      stream: "stdout",
      chunk: "retained partial",
    });
    const page = await readSessionBackgroundCommandOutput(client.db, identity);
    const parsed = CommandReadResult.parse({
      ...page,
      waitedMs: 0,
      timedOut: false,
      aborted: false,
      liveFanout: false,
    });
    expect(parsed).toMatchObject({ terminal: true, exitCode: 0, settlementReason: reason });
    expect(parsed.failure).toEqual(
      failureCode ? { code: failureCode, retryable: false } : undefined,
    );
    expect(parsed.chunks.map((chunk) => chunk.chunk).join("")).toBe("retained partial");
    expect(parsed.completionObservedAt).not.toBeNull();
  }
});

test("managed initial output persists before background adoption", async () => {
  const commandId = crypto.randomUUID(),
    leaseId = crypto.randomUUID(),
    admissionId = crypto.randomUUID(),
    actorId = crypto.randomUUID();
  await shared.admin`insert into sandbox_leases ${shared.admin({ id: leaseId, account_id: accountId, workspace_id: workspaceId, sandbox_group_id: sandboxGroupId, backend: "local", expires_at: new Date(Date.now() + 60_000) })}`;
  await shared.admin`insert into sandbox_lease_holders ${shared.admin({ account_id: accountId, workspace_id: workspaceId, lease_id: leaseId, kind: "process", holder_id: `process:${commandId}`, subject_id: sessionId })}`;
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin({ id: admissionId, account_id: accountId, workspace_id: workspaceId, lease_id: leaseId, sandbox_group_id: sandboxGroupId, session_id: sessionId, actor_kind: "direct", actor_id: actorId, holder_kind: "direct", holder_id: `direct:${actorId}`, lease_epoch: 0, provider_backend: "local", provider_instance_id: "test-instance", route_kind: "active", route_epoch: 0, workspace_generation: 1, operation: "terminalExec", provider_outcome: "retained" })}`;
  await shared.admin`insert into sandbox_retained_processes ${shared.admin({ id: commandId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, lease_id: leaseId, sandbox_group_id: sandboxGroupId, parent_admission_id: admissionId, holder_id: `process:${commandId}`, owner_actor_kind: "direct", owner_actor_id: actorId, lease_epoch: 0, provider_backend: "local", provider_instance_id: "test-instance", route_kind: "active", route_epoch: 0, provider_session_id: 1 })}`;
  await appendSessionCommandOutput(client.db, {
    accountId,
    workspaceId,
    sessionId,
    commandId,
    chunkId: "initial",
    stream: "stdout",
    chunk: "started\n",
  });
  await shared.admin`insert into session_background_commands ${shared.admin({ id: commandId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, provider: "managed", state: "running", retained_process_id: commandId })}`;
  const page = await readSessionBackgroundCommandOutput(client.db, {
    accountId,
    workspaceId,
    sessionId,
    commandId,
  });
  expect(page.chunks.map((item) => item.chunk).join("")).toBe("started\n");
  expect(page.completionObservedAt).toBeNull();
});
