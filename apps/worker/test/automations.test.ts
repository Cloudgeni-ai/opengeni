import { describe, expect, mock, test } from "bun:test";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { AutomationAuthorityRevokedError, type AutomationRunExecution } from "@opengeni/db";
import { createAutomationActivities } from "../src/activities/automations";
import type { ActivityServices } from "../src/activities/types";

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
      observability: { info: mock(() => undefined), warn: mock(() => undefined) } as never,
    }) as ActivityServices;
}

describe("automation dispatch activity", () => {
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
    });
    expect(createInput).not.toHaveProperty("requestedSessionId");
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
          model: "codex/gpt-5.6-sol",
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
      model: "codex/gpt-5.6-sol",
      requestedAgentRuns: 1,
    });
    expect(createInput).toMatchObject({
      model: "codex/gpt-5.6-sol",
      turnExecutionPolicy: {
        productModelId: "codex/gpt-5.6-sol",
        requestedModelId: "codex/gpt-5.6-sol",
        modelSource: "explicit",
        credentialSource: { kind: "connected_subscription", provider: "codex" },
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
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
});
