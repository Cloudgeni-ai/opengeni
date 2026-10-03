import { describe, expect, mock, test } from "bun:test";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { AutomationAuthorityRevokedError, type AutomationRunExecution } from "@opengeni/db";
import { createAutomationActivities } from "../src/activities/automations";
import type { ActivityServices } from "../src/activities/types";
import { runAutomationRunWorkflow } from "../src/workflows/automations";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const triggerId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const runId = "66666666-6666-4666-8666-666666666666";
const sessionId = "77777777-7777-4777-8777-777777777777";

const run: AutomationRunExecution = {
  id: runId,
  accountId,
  workspaceId,
  sourceId,
  triggerId,
  triggerRevision: 4,
  eventId,
  occurrenceKey: "repo:change:abc123",
  status: "dispatching",
  sessionId: null,
  errorCode: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  acceptedExecution: {
    version: 1,
    accountId,
    workspaceId,
    sourceId,
    sourceVersion: 3,
    triggerId,
    triggerRevision: 4,
    eventId,
    adapterId: "signed-json.v1",
    occurrenceKey: "repo:change:abc123",
    initialMessage: "Investigate the accepted event.",
    sessionTemplate: {
      prompt: "Investigate",
      instructions: "Complete only this automation.",
      resources: [],
      skills: [],
      tools: [],
      firstPartyMcpTools: [],
      firstPartyMcpPermissions: [],
      model: null,
      reasoningEffort: null,
      sandboxBackend: "none",
      policyRole: "automation",
      metadata: {},
    },
    serviceSubjectId: `automation:${triggerId}`,
    serviceLabel: "Test automation",
    provenance: { eventId },
  },
};

function services(): () => Promise<ActivityServices> {
  return async () =>
    ({
      settings: testSettings({ sandboxBackend: "none" }),
      db: {} as never,
      bus: new MemoryEventBus(),
      wakeSessionWorkflow: null,
      entitlements: null,
      observability: {
        info: mock(() => undefined),
        warn: mock(() => undefined),
      } as never,
    }) as ActivityServices;
}

describe("automation dispatch activity", () => {
  test("setup-restricted accepted templates freeze the marker into generated turn policy", async () => {
    const restrictedRun: AutomationRunExecution = {
      ...run,
      acceptedExecution: {
        ...run.acceptedExecution,
        sessionTemplate: {
          ...run.acceptedExecution.sessionTemplate,
          credentialRestriction: "developer_setup",
          metadata: {
            credentialRestriction: "none",
            turnExecutionPolicyV1: { credentialRestriction: "none" },
          },
        },
      },
    };
    let createInput: Record<string, unknown> | null = null;
    const activity = createAutomationActivities(services(), {
      claim: async () => restrictedRun,
      settle: async () => undefined,
      admit: async () => null,
      assertModelPolicy: async () => undefined,
      assertAuthority: async () => undefined,
      recordUsage: async () => undefined,
      readWorkspace: async () => ({ settings: {} }) as never,
      createSession: (async (input) => {
        createInput = input as unknown as Record<string, unknown>;
        return {
          session: { id: sessionId },
          outcome: "created",
          replay: false,
          changed: true,
        } as never;
      }) as typeof import("@opengeni/core").createAndStartSessionWithOutcome,
    });
    expect(await activity.dispatchAutomationRun({ accountId, workspaceId, runId })).toEqual({
      action: "started",
      sessionId,
    });
    expect(createInput).toMatchObject({
      turnExecutionPolicy: { credentialRestriction: "developer_setup" },
      firstPartyMcpPermissions: [],
      firstPartyMcpTools: [],
    });
  });

  test("restricted accepted templates cannot delegate forbidden explicit key/secret/organization scopes", async () => {
    const settle = mock(async () => undefined);
    const createSession = mock(async () => {
      throw new Error("forbidden template must not create a session");
    });
    for (const permission of [
      "api_keys:manage",
      "secrets:read",
      "account:admin",
      "billing:manage",
      "workspace:create",
    ] as const) {
      const activity = createAutomationActivities(services(), {
        claim: async () => ({
          ...run,
          acceptedExecution: {
            ...run.acceptedExecution,
            sessionTemplate: {
              ...run.acceptedExecution.sessionTemplate,
              credentialRestriction: "developer_setup",
              firstPartyMcpPermissions: [permission],
            },
          },
        }),
        settle,
        createSession: createSession as never,
      });
      expect(await activity.dispatchAutomationRun({ accountId, workspaceId, runId })).toEqual({
        action: "failed",
        reason: "credential_restriction_violation",
      });
    }
    expect(createSession).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(5);
  });

  test("atomically binds an ordinary idempotent session to the exact accepted authority", async () => {
    const assertAuthority = mock(async () => undefined);
    const settle = mock(async () => undefined);
    const recordUsage = mock(async () => undefined);
    let createInput: Record<string, unknown> | null = null;
    const activity = createAutomationActivities(services(), {
      claim: async () => run,
      settle,
      admit: async () => null,
      assertModelPolicy: async () => undefined,
      assertAuthority,
      recordUsage,
      readWorkspace: async () => ({ settings: {} }) as never,
      createSession: (async (input) => {
        createInput = input as unknown as Record<string, unknown>;
        await input.beforeCreateCommit?.({} as never, sessionId);
        return {
          session: {
            id: sessionId,
            createdBy: {
              kind: "service",
              subjectId: run.acceptedExecution.serviceSubjectId,
              label: run.acceptedExecution.serviceLabel,
            },
            createdByContext: run.acceptedExecution.provenance,
          },
          outcome: "created",
          replay: false,
          changed: true,
        } as never;
      }) as never,
    });

    expect(await activity.dispatchAutomationRun({ accountId, workspaceId, runId })).toEqual({
      action: "started",
      sessionId,
    });
    expect(createInput).toMatchObject({
      createIdempotencyKey: `automation-run:${runId}`,
      initialMessage: run.acceptedExecution.initialMessage,
      subjectId: run.acceptedExecution.serviceSubjectId,
      sandboxBackend: "none",
      surface: "automation",
    });
    expect(createInput).not.toHaveProperty("requestedSessionId");
    expect(createInput?.["turnExecutionPolicy"]).not.toHaveProperty("credentialRestriction");
    expect(assertAuthority).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      runId,
      triggerId,
      triggerRevision: 4,
      sourceId,
      sourceVersion: 3,
      sessionId,
    });
    expect(settle).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  test("preserves an explicit Codex subscription model through admission and session creation", async () => {
    const codexRun: AutomationRunExecution = {
      ...run,
      acceptedExecution: {
        ...run.acceptedExecution,
        sessionTemplate: {
          ...run.acceptedExecution.sessionTemplate,
          model: "codex/gpt-6-sol",
        },
      },
    };
    const admit = mock(async () => null);
    let createInput: Record<string, unknown> | null = null;
    const activity = createAutomationActivities(
      async () => {
        const service = await services()();
        return {
          ...service,
          settings: testSettings({
            sandboxBackend: "none",
            codexSubscriptionEnabled: true,
          }),
        };
      },
      {
        claim: async () => codexRun,
        settle: async () => undefined,
        admit,
        assertModelPolicy: async () => undefined,
        assertAuthority: async () => undefined,
        recordUsage: async () => undefined,
        readWorkspace: async () => ({ settings: {} }) as never,
        createSession: (async (input) => {
          createInput = input as unknown as Record<string, unknown>;
          return {
            session: {
              id: sessionId,
              createdBy: {
                kind: "service",
                subjectId: codexRun.acceptedExecution.serviceSubjectId,
                label: codexRun.acceptedExecution.serviceLabel,
              },
              createdByContext: codexRun.acceptedExecution.provenance,
            },
            outcome: "created",
            replay: false,
            changed: true,
          } as never;
        }) as never,
      },
    );

    expect(await activity.dispatchAutomationRun({ accountId, workspaceId, runId })).toEqual({
      action: "started",
      sessionId,
    });
    expect(admit).toHaveBeenCalledWith(expect.anything(), {
      accountId,
      workspaceId,
      model: "codex/gpt-6-sol",
      requestedAgentRuns: 1,
    });
    expect(createInput).toMatchObject({
      model: "codex/gpt-6-sol",
      turnExecutionPolicy: {
        productModelId: "codex/gpt-6-sol",
        requestedModelId: "codex/gpt-6-sol",
        modelSource: "explicit",
        credentialSource: { kind: "connected_subscription", provider: "codex" },
        billing: {
          upstreamPayer: "connected_subscription",
          metering: "external",
        },
      },
    });
  });

  test("settles a run as skipped when live authority is revoked before session commit", async () => {
    const settle = mock(async () => undefined);
    const activity = createAutomationActivities(services(), {
      claim: async () => run,
      settle,
      admit: async () => null,
      assertModelPolicy: async () => undefined,
      assertAuthority: async () => {
        throw new AutomationAuthorityRevokedError();
      },
      recordUsage: async () => undefined,
      readWorkspace: async () => ({ settings: {} }) as never,
      createSession: (async (input) => {
        await input.beforeCreateCommit?.({} as never, sessionId);
        throw new Error("unreachable");
      }) as never,
    });

    expect(await activity.dispatchAutomationRun({ accountId, workspaceId, runId })).toEqual({
      action: "skipped",
      reason: "authority_revoked",
    });
    expect(settle).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      runId,
      status: "skipped",
      errorCode: "authority_revoked",
    });
  });

  test("terminally settles deterministic model failures after claim", async () => {
    const settle = mock(async () => undefined);
    const activity = createAutomationActivities(services(), {
      claim: async () => ({
        ...run,
        acceptedExecution: {
          ...run.acceptedExecution,
          sessionTemplate: {
            ...run.acceptedExecution.sessionTemplate,
            model: "missing/provider-model",
          },
        },
      }),
      settle,
    });

    expect(await activity.dispatchAutomationRun({ accountId, workspaceId, runId })).toEqual({
      action: "failed",
      reason: "dispatch_failed",
    });
    expect(settle).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      runId,
      status: "failed",
      errorCode: "dispatch_failed",
    });
  });

  test("rethrows transient model-policy failures so Temporal can retry the accepted run", async () => {
    const settle = mock(async () => undefined);
    const activity = createAutomationActivities(services(), {
      claim: async () => run,
      settle,
      assertModelPolicy: async () => {
        throw new Error("temporary database outage");
      },
    });

    await expect(activity.dispatchAutomationRun({ accountId, workspaceId, runId })).rejects.toThrow(
      "temporary database outage",
    );
    expect(settle).not.toHaveBeenCalled();
  });

  test("terminally settles a run after the bounded dispatch retry window exhausts", async () => {
    const settle = mock(async () => undefined);
    const activity = createAutomationActivities(services(), { settle });

    await expect(
      activity.settleAutomationRunFailure({ accountId, workspaceId, runId }),
    ).resolves.toBeUndefined();
    expect(settle).toHaveBeenCalledWith(expect.anything(), {
      workspaceId,
      runId,
      status: "failed",
      errorCode: "dispatch_failed",
    });
  });

  test("replays a durably failed run without reclaiming it", async () => {
    const settle = mock(async () => undefined);
    const activity = createAutomationActivities(services(), {
      claim: async () => ({
        ...run,
        status: "failed",
        errorCode: "dispatch_failed",
      }),
      settle,
    });

    expect(await activity.dispatchAutomationRun({ accountId, workspaceId, runId })).toEqual({
      action: "failed",
      reason: "dispatch_failed",
    });
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("automation agent configuration", () => {
  function agentRun(agent: unknown): AutomationRunExecution {
    return {
      ...run,
      acceptedExecution: {
        ...run.acceptedExecution,
        sessionTemplate: {
          ...run.acceptedExecution.sessionTemplate,
          firstPartyMcpTools: ["wait_for_input", "goal_set", "knowledge_search"],
          tools: [{ kind: "mcp", id: "acme" }],
          ...(agent === undefined ? {} : { agent }),
        } as never,
      },
    };
  }

  async function dispatch(
    execution: AutomationRunExecution,
  ): Promise<{ createInput: Record<string, unknown> | null; settle: ReturnType<typeof mock> }> {
    let createInput: Record<string, unknown> | null = null;
    const settle = mock(async () => undefined);
    const readWorkspace = mock(async () => ({ settings: {} }) as never);
    const activity = createAutomationActivities(
      async () => ({
        ...(await services()()),
        settings: testSettings({ sandboxBackend: "none" }),
      }),
      {
        claim: async () => execution,
        settle,
        admit: async () => null,
        assertModelPolicy: async () => undefined,
        assertAuthority: async () => undefined,
        recordUsage: async () => undefined,
        readWorkspace,
        createSession: (async (input) => {
          createInput = input as unknown as Record<string, unknown>;
          return {
            session: { id: sessionId, createdBy: {}, createdByContext: {} },
            outcome: "created",
            replay: false,
            changed: true,
          } as never;
        }) as never,
      },
    );
    await activity.dispatchAutomationRun({ accountId, workspaceId, runId });
    return { createInput, settle };
  }

  test("an omitted template agent resolves all and keeps the template tools", async () => {
    const { createInput } = await dispatch(agentRun(undefined));
    expect(createInput).toMatchObject({
      agentConfig: { from: "all", source: "deployment_default" },
      firstPartyMcpTools: ["wait_for_input", "goal_set", "knowledge_search"],
      tools: [{ kind: "mcp", id: "acme" }],
      instructions: "Complete only this automation.",
    });
  });

  test("a template agent resolves and narrows the template's own tools", async () => {
    const { createInput } = await dispatch(
      agentRun({ capabilities: { from: "none", goals: true }, identity: "Ops bot" }),
    );
    expect(createInput).toMatchObject({
      agentConfig: { from: "none", identity: "Ops bot", source: "request" },
      firstPartyMcpTools: ["wait_for_input", "goal_set"],
      tools: [{ kind: "mcp", id: "acme" }],
    });
  });
});

describe("automation run workflow", () => {
  test("invokes durable failure settlement after dispatch retries exhaust", async () => {
    const dispatchAutomationRun = mock(async () => {
      throw new Error("dispatch retries exhausted");
    });
    const settleAutomationRunFailure = mock(async () => undefined);
    const input = { accountId, workspaceId, runId };

    await expect(
      runAutomationRunWorkflow(input, {
        dispatchAutomationRun,
        settleAutomationRunFailure,
      }),
    ).resolves.toBeUndefined();
    expect(dispatchAutomationRun).toHaveBeenCalledWith(input);
    expect(settleAutomationRunFailure).toHaveBeenCalledWith(input);
  });
});
