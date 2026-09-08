import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AttemptToolApprovalRequiredError,
  codemodeDispatchSubject,
  createAttemptToolEnvironment,
  decodeCodemodeDispatchAck,
  encodeCodemodeDispatchRequest,
  type AttemptToolDefinition,
} from "@opengeni/codemode";
import {
  bootstrapWorkspace,
  claimCodemodeOperation,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getCodemodeOperation,
  initializeSessionStartAtomically,
  listSessionEvents,
  markCodemodeOperationExecutionStarted,
  persistAttemptToolCatalog,
  submitCodemodeOperation,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced } from "@opengeni/events";
import {
  MemoryEventBus,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  CodemodeAttemptDispatcher,
  codemodeToolCallCreatedClientEventId,
} from "../src/activities/codemode-dispatcher";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("codemode-dispatcher");
  if (!shared) {
    available = false;
    console.warn("[codemode-dispatcher] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture(
  execute: (signal: AbortSignal | undefined) => Promise<string>,
  inputSchema: AttemptToolDefinition["inputSchema"] = { type: "object" },
  lifecycle?: AttemptToolDefinition["lifecycle"],
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `dispatcher-account-${suffix}`,
    accountName: "Codemode dispatcher test",
    workspaceExternalSource: "test",
    workspaceExternalId: `dispatcher-workspace-${suffix}`,
    workspaceName: "Codemode dispatcher test",
    subjectId: `dispatcher-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
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
  const environment = createAttemptToolEnvironment({
    scope,
    generation: 1,
    definitions: [
      {
        identity: { serverId: "docs", toolName: "search" },
        modelName: "docs__search",
        inputSchema,
        source: "docs",
        approval: "none",
        ...(lifecycle ? { lifecycle } : {}),
        execute: async (_arguments, context) => ({
          content: [{ type: "text", text: await execute(context.signal) }],
        }),
      },
    ],
  });
  await persistAttemptToolCatalog(client.db, environment.catalog);
  return { scope, environment };
}

async function waitForTerminal(
  scope: Awaited<ReturnType<typeof fixture>>["scope"],
  operationId: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const operation = await getCodemodeOperation(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      attemptId: scope.attemptId,
      operationId,
    });
    if (
      operation &&
      ["completed", "failed", "outcome_unknown", "cancelled"].includes(operation.state)
    ) {
      return operation;
    }
    await Bun.sleep(20);
  }
  throw new Error("Codemode operation did not settle");
}

async function waitForToolEventCount(
  scope: Awaited<ReturnType<typeof fixture>>["scope"],
  count: number,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = await listSessionEvents(client.db, scope.workspaceId, scope.sessionId, 0, 100);
    const toolEvents = events.filter((event) => event.type.startsWith("agent.toolCall."));
    if (toolEvents.length >= count) return toolEvents;
    await Bun.sleep(20);
  }
  throw new Error("Codemode tool events did not settle");
}

describe("CodemodeAttemptDispatcher", () => {
  test("executes one durable call through the exact attempt environment", async () => {
    if (!available) return;
    let executions = 0;
    const { scope, environment } = await fixture(async () => {
      executions += 1;
      return "found";
    });
    const operationId = crypto.randomUUID();
    await submitCodemodeOperation(client.db, {
      ...scope,
      call: {
        operationId,
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "docs", toolName: "search" },
        arguments: { query: "hello" },
        caller: { kind: "codemode", subjectId: "sandbox:test" },
      },
    });
    const bus = new MemoryEventBus();
    const dispatcher = new CodemodeAttemptDispatcher(client.db, bus, environment, scope);
    dispatcher.start();
    try {
      const request = encodeCodemodeDispatchRequest({
        version: 1,
        operationId,
        catalogDigest: environment.catalog.digest,
      });
      expect(
        decodeCodemodeDispatchAck(
          (
            await bus.request(
              codemodeDispatchSubject(scope.workspaceId, scope.attemptId),
              request,
              {
                timeoutMs: 1_000,
              },
            )
          ).data,
        ).status,
      ).toBe("accepted");
      expect(await waitForTerminal(scope, operationId)).toMatchObject({
        state: "completed",
        result: { content: [{ type: "text", text: "found" }] },
      });
      expect(executions).toBe(1);
      expect(
        decodeCodemodeDispatchAck(
          (
            await bus.request(
              codemodeDispatchSubject(scope.workspaceId, scope.attemptId),
              request,
              {
                timeoutMs: 1_000,
              },
            )
          ).data,
        ).status,
      ).toBe("terminal");
      expect(executions).toBe(1);
      const toolEvents = await waitForToolEventCount(scope, 2);
      expect(toolEvents.map((event) => event.type)).toEqual([
        "agent.toolCall.created",
        "agent.toolCall.output",
      ]);
      expect(toolEvents[0]?.clientEventId).toBe(codemodeToolCallCreatedClientEventId(operationId));
      expect(
        toolEvents.map((event) => (event.payload as { subjectId?: string } | undefined)?.subjectId),
      ).toEqual(["sandbox:test", "sandbox:test"]);
    } finally {
      await dispatcher.close();
    }
  });

  test("reuses the durable created event when an expired pre-execution claim is reclaimed", async () => {
    if (!available) return;
    let executions = 0;
    const { scope, environment } = await fixture(async () => {
      executions += 1;
      return "reclaimed";
    });
    const operationId = crypto.randomUUID();
    await submitCodemodeOperation(client.db, {
      ...scope,
      call: {
        operationId,
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "docs", toolName: "search" },
        arguments: { query: "reclaim" },
        caller: { kind: "codemode", subjectId: "sandbox:test" },
      },
    });
    const expiredClaimId = crypto.randomUUID();
    expect(
      await claimCodemodeOperation(client.db, {
        ...scope,
        catalogDigest: environment.catalog.digest,
        operationId,
        claimId: expiredClaimId,
        now: new Date(Date.now() - 5_000),
        claimLeaseMs: 1_000,
      }),
    ).toMatchObject({ status: "claimed", claimId: expiredClaimId });
    const bus = new MemoryEventBus();
    expect(
      (
        await appendAndPublishTurnEventsFenced(
          client.db,
          bus,
          scope.workspaceId,
          scope.sessionId,
          scope.turnId,
          scope.executionGeneration,
          scope.attemptId,
          [
            {
              type: "agent.toolCall.created",
              turnId: scope.turnId,
              turnGeneration: scope.executionGeneration,
              turnAttemptId: scope.attemptId,
              producerId: "sandbox:test",
              payload: {
                id: operationId,
                name: environment.catalog.entries[0]!.modelName,
                arguments: { query: "reclaim" },
                origin: "codemode",
                subjectId: "sandbox:test",
                raw: {
                  type: "codemode_call",
                  serverId: "docs",
                  toolName: "search",
                  catalogDigest: environment.catalog.digest,
                },
              },
            },
          ],
        )
      ).accepted,
    ).toBe(true);

    const dispatcher = new CodemodeAttemptDispatcher(client.db, bus, environment, scope);
    dispatcher.start();
    try {
      expect(
        decodeCodemodeDispatchAck(
          (
            await bus.request(
              codemodeDispatchSubject(scope.workspaceId, scope.attemptId),
              encodeCodemodeDispatchRequest({
                version: 1,
                operationId,
                catalogDigest: environment.catalog.digest,
              }),
              { timeoutMs: 1_000 },
            )
          ).data,
        ).status,
      ).toBe("accepted");
      expect(await waitForTerminal(scope, operationId)).toMatchObject({
        state: "completed",
        result: { content: [{ type: "text", text: "reclaimed" }] },
      });
      expect(executions).toBe(1);
      const toolEvents = await waitForToolEventCount(scope, 2);
      expect(toolEvents.map((event) => event.type)).toEqual([
        "agent.toolCall.created",
        "agent.toolCall.output",
      ]);
    } finally {
      await dispatcher.close();
    }
  });

  test("renews the durable claim while provider preparation is still running", async () => {
    if (!available) return;
    let signalPreparationStarted!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      signalPreparationStarted = resolve;
    });
    let releasePreparation!: () => void;
    const preparationBlocked = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let executions = 0;
    const { scope, environment } = await fixture(
      async () => {
        executions += 1;
        return "prepared";
      },
      { type: "object" },
      {
        prepare: async () => {
          signalPreparationStarted();
          await preparationBlocked;
        },
      },
    );
    const operationId = crypto.randomUUID();
    await submitCodemodeOperation(client.db, {
      ...scope,
      call: {
        operationId,
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "docs", toolName: "search" },
        arguments: {},
        caller: { kind: "codemode", subjectId: "sandbox:test" },
      },
    });
    const bus = new MemoryEventBus();
    const dispatcher = new CodemodeAttemptDispatcher(
      client.db,
      bus,
      environment,
      scope,
      undefined,
      1,
      { claimLeaseMs: 1_000, claimHeartbeatMs: 100 },
    );
    dispatcher.start();
    const request = async () =>
      decodeCodemodeDispatchAck(
        (
          await bus.request(
            codemodeDispatchSubject(scope.workspaceId, scope.attemptId),
            encodeCodemodeDispatchRequest({
              version: 1,
              operationId,
              catalogDigest: environment.catalog.digest,
            }),
            { timeoutMs: 1_000 },
          )
        ).data,
      ).status;
    try {
      expect(await request()).toBe("accepted");
      await preparationStarted;
      await Bun.sleep(1_200);
      expect(await request()).toBe("already_running");
      releasePreparation();
      expect(await waitForTerminal(scope, operationId)).toMatchObject({
        state: "completed",
      });
      expect(executions).toBe(1);
    } finally {
      releasePreparation();
      await dispatcher.close();
    }
  });

  test("records outcome unknown when an active call is aborted after execution starts", async () => {
    if (!available) return;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { scope, environment } = await fixture(async (signal) => {
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return "unreachable";
    });
    const operationId = crypto.randomUUID();
    await submitCodemodeOperation(client.db, {
      ...scope,
      call: {
        operationId,
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "docs", toolName: "search" },
        arguments: {},
        caller: { kind: "codemode", subjectId: "sandbox:test" },
      },
    });
    const bus = new MemoryEventBus();
    const dispatcher = new CodemodeAttemptDispatcher(client.db, bus, environment, scope);
    dispatcher.start();
    await bus.request(
      codemodeDispatchSubject(scope.workspaceId, scope.attemptId),
      encodeCodemodeDispatchRequest({
        version: 1,
        operationId,
        catalogDigest: environment.catalog.digest,
      }),
      { timeoutMs: 1_000 },
    );
    await started;
    await dispatcher.close("test interruption");
    expect(await waitForTerminal(scope, operationId)).toMatchObject({
      state: "outcome_unknown",
      errorCode: "attempt_cancelled_during_execution",
    });
    const toolEvents = await waitForToolEventCount(scope, 2);
    expect(toolEvents.map((event) => event.type)).toEqual([
      "agent.toolCall.created",
      "agent.toolCall.output",
    ]);
    expect(toolEvents[1]?.payload).toMatchObject({
      id: operationId,
      error: true,
      output: {
        isError: true,
        _meta: {
          codemodeState: "outcome_unknown",
          errorCode: "attempt_cancelled_during_execution",
        },
      },
    });
  });

  test("closes the timeline when an expired post-execution claim loses its worker", async () => {
    if (!available) return;
    const { scope, environment } = await fixture(async () => "must not execute twice");
    const operationId = crypto.randomUUID();
    await submitCodemodeOperation(client.db, {
      ...scope,
      call: {
        operationId,
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "docs", toolName: "search" },
        arguments: { query: "already dispatched" },
        caller: { kind: "codemode", subjectId: "sandbox:test" },
      },
    });
    const claimId = crypto.randomUUID();
    const startedAt = new Date(Date.now() - 5_000);
    expect(
      await claimCodemodeOperation(client.db, {
        ...scope,
        catalogDigest: environment.catalog.digest,
        operationId,
        claimId,
        now: startedAt,
        claimLeaseMs: 1_000,
      }),
    ).toMatchObject({ status: "claimed", claimId });
    const bus = new MemoryEventBus();
    const created = await appendAndPublishTurnEventsFenced(
      client.db,
      bus,
      scope.workspaceId,
      scope.sessionId,
      scope.turnId,
      scope.executionGeneration,
      scope.attemptId,
      [
        {
          type: "agent.toolCall.created",
          turnId: scope.turnId,
          turnGeneration: scope.executionGeneration,
          turnAttemptId: scope.attemptId,
          producerId: "sandbox:test",
          payload: {
            id: operationId,
            name: environment.catalog.entries[0]!.modelName,
            arguments: { query: "already dispatched" },
            origin: "codemode",
            subjectId: "sandbox:test",
          },
        },
      ],
    );
    expect(created.accepted).toBe(true);
    expect(
      await markCodemodeOperationExecutionStarted(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        attemptId: scope.attemptId,
        operationId,
        claimId,
        now: startedAt,
        claimLeaseMs: 1_000,
      }),
    ).toBe(true);

    const dispatcher = new CodemodeAttemptDispatcher(client.db, bus, environment, scope);
    dispatcher.start();
    try {
      expect(
        decodeCodemodeDispatchAck(
          (
            await bus.request(
              codemodeDispatchSubject(scope.workspaceId, scope.attemptId),
              encodeCodemodeDispatchRequest({
                version: 1,
                operationId,
                catalogDigest: environment.catalog.digest,
              }),
              { timeoutMs: 1_000 },
            )
          ).data,
        ).status,
      ).toBe("terminal");
      expect(await waitForTerminal(scope, operationId)).toMatchObject({
        state: "outcome_unknown",
        errorCode: "worker_lost_during_execution",
      });
      const toolEvents = await waitForToolEventCount(scope, 2);
      expect(toolEvents.map((event) => event.type)).toEqual([
        "agent.toolCall.created",
        "agent.toolCall.output",
      ]);
      expect(toolEvents[1]?.payload).toMatchObject({
        id: operationId,
        error: true,
        output: {
          isError: true,
          _meta: {
            codemodeState: "outcome_unknown",
            errorCode: "worker_lost_during_execution",
          },
        },
      });
    } finally {
      await dispatcher.close();
    }
  });

  test("fails invalid arguments before crossing the execution boundary", async () => {
    if (!available) return;
    let executions = 0;
    const { scope, environment } = await fixture(
      async () => {
        executions += 1;
        return "unreachable";
      },
      {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    );
    const operationId = crypto.randomUUID();
    await submitCodemodeOperation(client.db, {
      ...scope,
      call: {
        operationId,
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "docs", toolName: "search" },
        arguments: { query: 42 },
        caller: { kind: "codemode", subjectId: "sandbox:test" },
      },
    });
    const bus = new MemoryEventBus();
    const dispatcher = new CodemodeAttemptDispatcher(client.db, bus, environment, scope);
    dispatcher.start();
    try {
      expect(
        decodeCodemodeDispatchAck(
          (
            await bus.request(
              codemodeDispatchSubject(scope.workspaceId, scope.attemptId),
              encodeCodemodeDispatchRequest({
                version: 1,
                operationId,
                catalogDigest: environment.catalog.digest,
              }),
              { timeoutMs: 1_000 },
            )
          ).data,
        ).status,
      ).toBe("accepted");
      expect(await waitForTerminal(scope, operationId)).toMatchObject({
        state: "failed",
        errorCode: "invalid_tool_arguments",
        executionStartedAt: null,
      });
      expect(executions).toBe(0);
      const toolEvents = await waitForToolEventCount(scope, 2);
      expect(toolEvents.map((event) => event.type)).toEqual([
        "agent.toolCall.created",
        "agent.toolCall.output",
      ]);
    } finally {
      await dispatcher.close();
    }
  });

  test("fails connector approval during prepare before marking execution started", async () => {
    if (!available) return;
    let executions = 0;
    const { scope, environment } = await fixture(
      async () => {
        executions += 1;
        return "unreachable";
      },
      { type: "object" },
      {
        prepare: async () => {
          throw new AttemptToolApprovalRequiredError();
        },
      },
    );
    const operationId = crypto.randomUUID();
    await submitCodemodeOperation(client.db, {
      ...scope,
      call: {
        operationId,
        catalogDigest: environment.catalog.digest,
        identity: { serverId: "docs", toolName: "search" },
        arguments: {},
        caller: { kind: "codemode", subjectId: "sandbox:test" },
      },
    });
    const bus = new MemoryEventBus();
    const dispatcher = new CodemodeAttemptDispatcher(client.db, bus, environment, scope);
    dispatcher.start();
    try {
      expect(
        decodeCodemodeDispatchAck(
          (
            await bus.request(
              codemodeDispatchSubject(scope.workspaceId, scope.attemptId),
              encodeCodemodeDispatchRequest({
                version: 1,
                operationId,
                catalogDigest: environment.catalog.digest,
              }),
              { timeoutMs: 1_000 },
            )
          ).data,
        ).status,
      ).toBe("accepted");
      expect(await waitForTerminal(scope, operationId)).toMatchObject({
        state: "failed",
        errorCode: "approval_required",
        executionStartedAt: null,
      });
      expect(executions).toBe(0);
    } finally {
      await dispatcher.close();
    }
  });

  test("bounds concurrent execution without claiming work it cannot start", async () => {
    if (!available) return;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const { scope, environment } = await fixture(async () => {
      calls += 1;
      if (calls === 1) await firstBlocked;
      return `result-${calls}`;
    });
    const operationIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const operationId of operationIds) {
      await submitCodemodeOperation(client.db, {
        ...scope,
        call: {
          operationId,
          catalogDigest: environment.catalog.digest,
          identity: { serverId: "docs", toolName: "search" },
          arguments: {},
          caller: { kind: "codemode", subjectId: "sandbox:test" },
        },
      });
    }
    const bus = new MemoryEventBus();
    const dispatcher = new CodemodeAttemptDispatcher(
      client.db,
      bus,
      environment,
      scope,
      undefined,
      1,
    );
    dispatcher.start();
    const request = async (operationId: string) =>
      decodeCodemodeDispatchAck(
        (
          await bus.request(
            codemodeDispatchSubject(scope.workspaceId, scope.attemptId),
            encodeCodemodeDispatchRequest({
              version: 1,
              operationId,
              catalogDigest: environment.catalog.digest,
            }),
            { timeoutMs: 1_000 },
          )
        ).data,
      ).status;
    try {
      expect(await request(operationIds[0]!)).toBe("accepted");
      expect(await request(operationIds[1]!)).toBe("unavailable");
      expect(
        await getCodemodeOperation(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          attemptId: scope.attemptId,
          operationId: operationIds[1]!,
        }),
      ).toMatchObject({ state: "queued", claimedAt: null, executionStartedAt: null });
      releaseFirst();
      await waitForTerminal(scope, operationIds[0]!);
      let secondStatus = await request(operationIds[1]!);
      const acceptanceDeadline = Date.now() + 2_000;
      while (secondStatus === "unavailable" && Date.now() < acceptanceDeadline) {
        await Bun.sleep(10);
        secondStatus = await request(operationIds[1]!);
      }
      expect(secondStatus).toBe("accepted");
      expect(await waitForTerminal(scope, operationIds[1]!)).toMatchObject({
        state: "completed",
      });
      expect(calls).toBe(2);
    } finally {
      releaseFirst();
      await dispatcher.close();
    }
  });
});
