import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { configuredModels } from "@opengeni/config";
import type { AccessGrant, LatencyMode } from "@opengeni/contracts";
import { bootstrapWorkspace, claimSessionWorkForAttempt, createDb, getSession } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps } from "../src";
import { acceptSessionUserMessage, createSessionForRequest } from "../src/domain/sessions";
import { sendAgentSessionMessage } from "../src/application/session-commands";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-create-latency");
  if (!acquired) throw new Error("Session latency regression requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(parentLatency: LatencyMode = "fast", exactAttempt = true) {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "child-latency-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Child latency fixture",
    workspaceExternalSource: "child-latency-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Child latency fixture",
    subjectId: `user:child-latency:${crypto.randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  const noop = async () => undefined;
  const capabilities = configuredModels(testSettings())[0]!.capabilities;
  const deps = {
    db: client.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      sandboxBackend: "none",
      openaiAllowedModels: "scripted-model,gpt-6.1-sol,gpt-6-luna",
      openaiReasoningEffort: "low",
      modelProvidersJson: JSON.stringify([
        {
          id: "latency-fixture",
          kind: "anonymous",
          api: "responses",
          wireProfile: "openai",
          baseUrl: "https://latency.example.test/v1",
          models: [
            {
              id: "fixture/all-latencies",
              upstreamModelId: "all-latencies",
              capabilities: {
                ...capabilities,
                latencyModes: ["standard", "priority", "fast"].map((id) => ({
                  id,
                  upstream: "supported",
                  runnable: true,
                })),
              },
            },
          ],
        },
      ]),
    }),
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: noop, requestSessionWorkflowWakeDispatch: noop },
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const parent = await createSessionForRequest(deps, grant, grant.workspaceId, {
    initialMessage: "Synthetic parent; never execute a model",
    model: parentLatency === "priority" ? "fixture/all-latencies" : "gpt-6.1-sol",
    reasoningEffort: "high",
    latencyMode: parentLatency,
    sandboxBackend: "none",
  });
  let caller: AccessGrant = {
    ...grant,
    metadata: { ...grant.metadata, sessionId: parent.id },
  };
  if (exactAttempt) {
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: parent.id,
      workflowId: `session-${parent.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`Parent claim failed: ${claimed.reason}`);
    caller = {
      ...caller,
      principalKind: "agent_attempt",
      metadata: {
        ...caller.metadata,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
      },
    };
  }
  const create = (overrides: Record<string, unknown> = {}) =>
    createSessionForRequest(deps, caller, grant.workspaceId, {
      initialMessage: "Synthetic child; never execute a model",
      sandboxBackend: "none",
      ...overrides,
    });
  return { grant, deps, parent, caller, create };
}

async function turns(sessionId: string) {
  return await shared.admin<
    Array<{
      model: string;
      reasoningEffort: string;
      latencyMode: LatencyMode;
      metadata: Record<string, unknown>;
    }>
  >`select model, reasoning_effort as "reasoningEffort", latency_mode as "latencyMode", metadata
    from session_turns where session_id=${sessionId} order by position`;
}

describe("new session latency defaults", () => {
  for (const parentLatency of ["fast", "priority"] as const) {
    for (const model of [undefined, "gpt-6-luna"] as const) {
      test(`${parentLatency} caller with ${model ?? "inherited model"} creates standard child`, async () => {
        const { create, parent } = await fixture(parentLatency);
        const child = await create(model ? { model } : {});
        expect(child.model).toBe(model ?? parent.model);
        expect(child.reasoningEffort).toBe("high");
        expect(child.latencyMode).toBe("standard");
        const [initial] = await turns(child.id);
        expect(initial).toMatchObject({
          model: child.model,
          reasoningEffort: "high",
          latencyMode: "standard",
          metadata: {
            turnExecutionPolicyV1: {
              modelSource: model ? "explicit" : "continuation",
              reasoningSource: "continuation",
              latencyMode: "standard",
              latencyModeSource: "deployment",
            },
          },
        });
        expect(await turns(parent.id)).toHaveLength(1);
        expect((await turns(parent.id))[0]!.latencyMode).toBe(parentLatency);
      }, 30_000);
    }
  }

  test("legacy session-bound creation also defaults to standard without resetting model/reasoning", async () => {
    const { create, parent } = await fixture("fast", false);
    const child = await create();
    expect(child.model).toBe(parent.model);
    expect(child.reasoningEffort).toBe(parent.reasoningEffort);
    expect(child.latencyMode).toBe("standard");
  }, 30_000);

  for (const latencyMode of ["standard", "priority", "fast"] as const) {
    test(`explicit ${latencyMode} persists in the child and initial policy`, async () => {
      const { create } = await fixture();
      const child = await create({
        latencyMode,
        reasoningEffort: "medium",
        ...(latencyMode === "priority" ? { model: "fixture/all-latencies" } : {}),
      });
      expect(child).toMatchObject({ latencyMode, reasoningEffort: "medium" });
      expect((await turns(child.id))[0]).toMatchObject({
        latencyMode,
        reasoningEffort: "medium",
        metadata: {
          turnExecutionPolicyV1: {
            latencyMode,
            latencyModeSource: "explicit",
            reasoningSource: "explicit",
          },
        },
      });
    }, 30_000);
  }

  for (const latencyMode of ["priority", "fast"] as const) {
    test(`unsupported explicit ${latencyMode} still rejects before child creation`, async () => {
      const { create, grant } = await fixture();
      const before =
        await shared.admin`select id from sessions where workspace_id=${grant.workspaceId}`;
      await expect(create({ model: "scripted-model", latencyMode })).rejects.toThrow(
        "latency mode",
      );
      const after =
        await shared.admin`select id from sessions where workspace_id=${grant.workspaceId}`;
      expect(after).toEqual(before);
    }, 30_000);
  }

  test("keyed replay returns the original explicit fast session without rewriting accepted settings", async () => {
    const { create } = await fixture();
    const request = { idempotencyKey: crypto.randomUUID(), latencyMode: "fast" };
    const first = await create(request);
    const before = await turns(first.id);
    const replay = await create({ idempotencyKey: request.idempotencyKey });
    expect(replay).toMatchObject({ id: first.id, latencyMode: "fast" });
    expect(await turns(first.id)).toEqual(before);
  }, 30_000);

  test("repair of a committed keyed shell preserves its original fast policy", async () => {
    const { create, grant } = await fixture();
    const idempotencyKey = crypto.randomUUID();
    const trigger = `fail_child_latency_${crypto.randomUUID().replaceAll("-", "")}`;
    await shared.admin.unsafe(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${grant.workspaceId}'::uuid AND NEW.type = 'user.message' THEN RAISE EXCEPTION 'injected initialization failure'; END IF; RETURN NEW; END $$`,
    );
    await shared.admin.unsafe(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON session_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      await expect(create({ idempotencyKey, latencyMode: "fast" })).rejects.toMatchObject({
        cause: { message: "injected initialization failure" },
      });
    } finally {
      await shared.admin.unsafe(`DROP TRIGGER ${trigger} ON session_events`);
      await shared.admin.unsafe(`DROP FUNCTION ${trigger}()`);
    }
    const [shell] = await shared.admin<{ id: string; latencyMode: LatencyMode }[]>`
      select id, latency_mode as "latencyMode" from sessions
      where workspace_id=${grant.workspaceId} and create_idempotency_key=${idempotencyKey}`;
    expect(shell!.latencyMode).toBe("fast");
    expect(await turns(shell!.id)).toHaveLength(0);
    const repaired = await create({ idempotencyKey });
    expect(repaired.id).toBe(shell!.id);
    expect(repaired.latencyMode).toBe("fast");
    expect((await turns(repaired.id))[0]).toMatchObject({
      latencyMode: "fast",
      metadata: {
        turnExecutionPolicyV1: { latencyMode: "fast", latencyModeSource: "explicit" },
      },
    });
  }, 30_000);

  test("an ordinary new top-level session remains standard", async () => {
    const { deps, grant } = await fixture();
    const created = await createSessionForRequest(deps, grant, grant.workspaceId, {
      initialMessage: "New ordinary session",
      model: "gpt-6-luna",
      sandboxBackend: "none",
    });
    expect(created.latencyMode).toBe("standard");
    expect((await turns(created.id))[0]).toMatchObject({
      latencyMode: "standard",
      metadata: { turnExecutionPolicyV1: { latencyModeSource: "deployment" } },
    });
  }, 30_000);

  for (const latencyMode of ["standard", "fast"] as const) {
    test(`fast caller follow-up preserves child's explicit ${latencyMode} default`, async () => {
      const { create, deps, grant, caller } = await fixture();
      const child = await create({ latencyMode });
      const initial = await turns(child.id);
      await acceptSessionUserMessage(deps, caller, grant.workspaceId, child.id, {
        text: "Continue using the recipient defaults",
        resources: [],
        clientEventId: crypto.randomUUID(),
      });
      expect((await getSession(client.db, grant.workspaceId, child.id))!.latencyMode).toBe(
        latencyMode,
      );
      const after = await turns(child.id);
      expect(after).toHaveLength(2);
      expect(after[0]).toEqual(initial[0]);
      expect(after[1]).toMatchObject({
        model: child.model,
        reasoningEffort: child.reasoningEffort,
        latencyMode,
        metadata: { turnExecutionPolicyV1: { latencyModeSource: "session" } },
      });
    }, 30_000);
  }

  test("MCP agent-message admission never resets the recipient's defaults", async () => {
    const { create, deps, grant, caller } = await fixture();
    const child = await create({ latencyMode: "standard" });
    const before = await turns(child.id);
    await sendAgentSessionMessage(
      deps,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: caller.subjectId,
        callerSessionId: caller.metadata!.sessionId as string,
        callerTurnId: caller.metadata!.turnId as string,
        callerAttemptId: caller.metadata!.attemptId as string,
        callerExecutionGeneration: caller.metadata!.executionGeneration as number,
      },
      {
        targetSessionId: child.id,
        text: "Continue without inheriting the sender's fast mode",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect((await getSession(client.db, grant.workspaceId, child.id))!.latencyMode).toBe(
      "standard",
    );
    expect(await turns(child.id)).toEqual(before);
  }, 30_000);
});
