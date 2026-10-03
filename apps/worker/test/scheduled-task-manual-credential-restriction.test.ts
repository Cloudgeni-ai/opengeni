import { describe, expect, spyOn, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  readTurnExecutionPolicyV1,
  ScheduledTask,
  ScheduledTaskRunAcceptedExecution,
  TurnExecutionPolicyV1,
} from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import * as admission from "../src/activities/agent-run-admission";
import {
  createScheduledTaskActivities,
  scheduledSessionExecutionPolicyMetadata,
  scheduledTaskRunExecutionPolicy,
} from "../src/activities/scheduled-tasks";
import type {
  ControlActivityServices,
  DispatchScheduledTaskRunInput,
} from "../src/activities/types";
import {
  scheduledTaskDispatchInput,
  type ScheduledTaskFireWorkflowInput,
} from "../src/workflows/scheduled-tasks";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  taskId: "33333333-3333-4333-8333-333333333333",
};
const sessionId = "44444444-4444-4444-8444-444444444444";
const settings = testSettings({ sandboxBackend: "none" });
const workflowInput: ScheduledTaskFireWorkflowInput = {
  ...scope,
  triggerType: "manual",
  agentRunUsageIdempotencyKey: "manual-fire-charge",
  initiator: { kind: "subject", subjectId: "setup-caller" },
};
const manualInput = scheduledTaskDispatchInput(workflowInput, "manual-fire-workflow");
const ordinaryPolicy = resolveTurnExecutionPolicyV1(settings, {
  modelId: settings.openaiModel,
  requestedModelId: null,
  modelSource: "session",
  reasoningEffort: "low",
  reasoningSource: "session",
});

describe("scheduled manual caller ceiling forwarding", () => {
  test.each(["manual", "initial", "provider_event", "retry", "repair"] as const)(
    "forwards the exact trusted %s ceiling without changing the charging identity",
    (triggerType) => {
      const input = {
        ...workflowInput,
        triggerType,
        credentialRestriction: "developer_setup" as const,
      };
      expect(scheduledTaskDispatchInput(input, "producer")).toEqual({
        workspaceId: scope.workspaceId,
        taskId: scope.taskId,
        producerKey: "producer",
        triggerType,
        agentRunUsageIdempotencyKey: input.agentRunUsageIdempotencyKey,
        initiator: input.initiator,
        credentialRestriction: "developer_setup",
      });
    },
  );

  test("absence and ordinary scheduled delivery preserve their exact wire shapes", () => {
    expect(manualInput).toEqual({
      workspaceId: scope.workspaceId,
      taskId: scope.taskId,
      producerKey: "manual-fire-workflow",
      triggerType: "manual",
      agentRunUsageIdempotencyKey: "manual-fire-charge",
      initiator: workflowInput.initiator,
    });
    const scheduled = scheduledTaskDispatchInput(
      { ...scope, triggerType: "scheduled" },
      "scheduled-producer",
    );
    expect(scheduled).toEqual({
      workspaceId: scope.workspaceId,
      taskId: scope.taskId,
      producerKey: "scheduled-producer",
      triggerType: "scheduled",
    });
    expect(scheduledTaskRunExecutionPolicy(ordinaryPolicy, scheduled)).toBe(ordinaryPolicy);
    expect(scheduledTaskRunExecutionPolicy(ordinaryPolicy, manualInput)).toBe(ordinaryPolicy);
  });

  test("a scheduled history cannot supply a manual caller ceiling", () => {
    const malformed = {
      ...scope,
      triggerType: "scheduled",
      credentialRestriction: "developer_setup",
    } as unknown as ScheduledTaskFireWorkflowInput;
    const forwarded = scheduledTaskDispatchInput(malformed, "producer");
    expect(Object.hasOwn(forwarded, "credentialRestriction")).toBe(false);
    expect(
      scheduledTaskRunExecutionPolicy(
        ordinaryPolicy,
        malformed as unknown as DispatchScheduledTaskRunInput,
      ),
    ).toBe(ordinaryPolicy);
  });
});

type AcceptanceOptions = {
  runMode?: "reusable_session" | "existing_session";
  manualRestriction?: "developer_setup";
  creatorRestriction?: "developer_setup";
  spoofMetadata?: boolean;
};

async function acceptanceFixture(
  options: AcceptanceOptions,
  verify: (fixture: {
    run: (input?: DispatchScheduledTaskRunInput) => Promise<void>;
    accepted: () => ScheduledTaskRunAcceptedExecution;
    sessionMetadata: () => Record<string, unknown>;
    recover: (input?: DispatchScheduledTaskRunInput) => Promise<void>;
    taskRead: ReturnType<typeof spyOn<typeof db, "getScheduledTask">>;
    creatorRead: ReturnType<typeof spyOn<typeof db, "getScheduledTaskCreatorPolicy">>;
  }) => Promise<void>,
) {
  const database = {} as db.Database;
  const task = ScheduledTask.parse({
    id: scope.taskId,
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    name: "Manual run ceiling fixture",
    ownerSubjectId: null,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: "manual-ceiling-fixture",
    runMode: options.runMode ?? "reusable_session",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Run fixture",
      model: settings.openaiModel,
      resources: [],
      tools: [],
      metadata: options.spoofMetadata ? { credentialRestriction: "developer_setup" } : {},
    },
    executionDigest: "a".repeat(64),
    reusableSessionId: null,
    targetSessionId: options.runMode === "existing_session" ? sessionId : null,
    metadata: options.spoofMetadata ? { credentialRestriction: "developer_setup" } : {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  const targetExecution: NonNullable<ScheduledTaskRunAcceptedExecution["targetSessionExecution"]> =
    {
      sessionId,
      visibility: "workspace_shared",
      authorityEpoch: 1,
      model: settings.openaiModel,
      reasoningEffort: "low",
      latencyMode: "standard",
      tools: [],
      sandboxBackend: "none",
      sandboxOs: "linux",
      firstPartyMcpTools: [],
      firstPartyMcpPermissions: null,
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      mcpServerIds: [],
      effectiveMcpServerIds: [],
      toolPolicyVersion: 1,
      variableSets: [],
      variableSetId: null,
      variableSetGeneration: null,
      rigId: null,
      rigVersionId: null,
      rigDefaultVariableSets: [],
      maxNestedAgentDepthOverride: null,
      effectiveMaxNestedAgentDepth: 3,
    };
  let accepted: ScheduledTaskRunAcceptedExecution | null = null;
  let createdMetadata: Record<string, unknown> | null = null;
  const stopAfterCapture = new Error("fixture stopped after worker acceptance capture");
  const runRow = {
    id: "55555555-5555-4555-8555-555555555555",
    workspaceId: scope.workspaceId,
    taskId: scope.taskId,
    actionKind: "agent_turn",
    status: "queued",
    sessionId: null,
    triggerEventId: null,
  } as Awaited<ReturnType<typeof db.createScheduledTaskRun>>;
  const priorRunRead = spyOn(db, "getScheduledTaskRunByProducerKey").mockResolvedValue(null);
  const taskRead = spyOn(db, "getScheduledTask").mockResolvedValue(task);
  const creatorRead = spyOn(db, "getScheduledTaskCreatorPolicy").mockResolvedValue(
    options.creatorRestriction
      ? ({ credentialRestriction: options.creatorRestriction } as db.ScheduledTaskCreatorPolicy)
      : null,
  );
  const acceptedRead = spyOn(db, "getScheduledTaskRunAcceptedExecution").mockResolvedValue(null);
  const spies = [
    priorRunRead,
    taskRead,
    creatorRead,
    acceptedRead,
    spyOn(db, "getScheduledTaskPersonalResourceAuthoritySubject").mockResolvedValue(null),
    spyOn(db, "getScheduledTaskRevisionAuthority").mockResolvedValue(null),
    spyOn(db, "getScheduledTargetSessionExecution").mockResolvedValue(targetExecution),
    spyOn(db, "requireSession").mockResolvedValue({
      id: sessionId,
      resources: [],
      tools: [],
      mcpServers: [],
      metadata: {},
      variableSetId: null,
    } as Awaited<ReturnType<typeof db.requireSession>>),
    spyOn(db, "requireWorkspace").mockResolvedValue({ settings: {} } as Awaited<
      ReturnType<typeof db.requireWorkspace>
    >),
    spyOn(db, "getNestedAgentDepthDeploymentPolicy").mockResolvedValue({
      maxNestedAgentDepth: 3,
      policySource: "deployment",
    } as Awaited<ReturnType<typeof db.getNestedAgentDepthDeploymentPolicy>>),
    spyOn(db, "listInstalledApiIntegrationServerIdsForDelegations").mockResolvedValue([]),
    spyOn(db, "getScheduledTaskXaiProviderAccountAuthoritySnapshot").mockResolvedValue({
      version: 1,
      scope: "workspace",
    }),
    spyOn(db, "getScheduledTaskClaudeProviderAccountAuthoritySnapshot").mockResolvedValue({
      version: 1,
      scope: "workspace",
    } as Awaited<ReturnType<typeof db.getScheduledTaskClaudeProviderAccountAuthoritySnapshot>>),
    spyOn(db, "getScheduledTaskRunPersonalResourceAuthority").mockResolvedValue(null),
    spyOn(db, "recordUsageEvent").mockResolvedValue(undefined),
    spyOn(core, "resolveWorkspaceCatalogSettings").mockResolvedValue({ settings } as Awaited<
      ReturnType<typeof core.resolveWorkspaceCatalogSettings>
    >),
    spyOn(core, "settingsWithEnabledCapabilityMcpServers").mockResolvedValue(settings),
    spyOn(core, "scheduledConnectionTools").mockResolvedValue([]),
    spyOn(core, "freezeConnectionAccounts").mockResolvedValue({
      personalConnectionDelegations: [],
      mcpAccountBindings: [],
    } as Awaited<ReturnType<typeof core.freezeConnectionAccounts>>),
    spyOn(admission, "agentRunAdmissionDenial").mockResolvedValue(null),
    spyOn(db, "createScheduledTaskRun").mockImplementation(async (_db, input) => {
      accepted = ScheduledTaskRunAcceptedExecution.parse(input.acceptedExecutionSnapshot);
      if (options.runMode === "existing_session") throw stopAfterCapture;
      return runRow;
    }),
    spyOn(db, "createSessionWithIdempotencyKeyResult").mockImplementation(async (_db, input) => {
      createdMetadata = input.metadata ?? {};
      throw stopAfterCapture;
    }),
  ];
  const activities = createScheduledTaskActivities(
    async () =>
      ({
        settings,
        db: database,
        bus: { publish: async () => {} },
      }) as ControlActivityServices,
  );
  const input: DispatchScheduledTaskRunInput = {
    ...manualInput,
    ...(options.manualRestriction ? { credentialRestriction: options.manualRestriction } : {}),
  };
  const run = async (supplied = input) => {
    await expect(activities.dispatchScheduledTaskRun(supplied)).rejects.toBe(stopAfterCapture);
  };
  try {
    await verify({
      run,
      accepted: () => accepted!,
      sessionMetadata: () => createdMetadata!,
      recover: async (supplied = manualInput) => {
        priorRunRead.mockResolvedValue(runRow);
        acceptedRead.mockResolvedValue(accepted);
        createdMetadata = null;
        await run(supplied);
      },
      taskRead,
      creatorRead,
    });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe("worker scheduled occurrence credential restriction acceptance", () => {
  test.each([
    { name: "manual-only", manualRestriction: "developer_setup", expected: "developer_setup" },
    { name: "creator-only", creatorRestriction: "developer_setup", expected: "developer_setup" },
    {
      name: "both ceilings",
      manualRestriction: "developer_setup",
      creatorRestriction: "developer_setup",
      expected: "developer_setup",
    },
    { name: "ordinary legacy", expected: undefined },
    { name: "spoofed task metadata", spoofMetadata: true, expected: undefined },
  ] as const)("freezes $name at the actual run admission boundary", async (options) => {
    await acceptanceFixture(options, async ({ run, accepted, sessionMetadata }) => {
      await run();
      const frozen = TurnExecutionPolicyV1.parse(accepted().turnExecutionPolicy);
      expect(frozen.credentialRestriction).toBe(options.expected);
      expect(Object.hasOwn(frozen, "credentialRestriction")).toBe(!!options.expected);
      expect(accepted().task).not.toHaveProperty("credentialRestriction");
      const initial = readTurnExecutionPolicyV1(sessionMetadata());
      const creatorRestriction = (options as AcceptanceOptions).creatorRestriction;
      expect(initial.kind).toBe(creatorRestriction ? "valid" : "absent");
      if (initial.kind === "valid") {
        expect(initial.policy).toEqual(frozen);
      }
    });
  });

  test("an existing-session run receives only the per-run caller ceiling", async () => {
    await acceptanceFixture(
      { runMode: "existing_session", manualRestriction: "developer_setup" },
      async ({ run, accepted, sessionMetadata }) => {
        await run();
        const frozen = TurnExecutionPolicyV1.parse(accepted().turnExecutionPolicy);
        expect(frozen.credentialRestriction).toBe("developer_setup");
        expect(frozen.modelSource).toBe("session");
        expect(accepted().targetSessionExecution?.sessionId).toBe(sessionId);
        expect(sessionMetadata()).toBeNull();
      },
    );
  });

  test("the next unrestricted fire does not inherit an earlier manual caller ceiling", async () => {
    await acceptanceFixture(
      { manualRestriction: "developer_setup" },
      async ({ run, accepted, sessionMetadata }) => {
        await run();
        expect(
          TurnExecutionPolicyV1.parse(accepted().turnExecutionPolicy).credentialRestriction,
        ).toBe("developer_setup");
        expect(readTurnExecutionPolicyV1(sessionMetadata()).kind).toBe("absent");
        await run(manualInput);
        expect(
          Object.hasOwn(
            TurnExecutionPolicyV1.parse(accepted().turnExecutionPolicy),
            "credentialRestriction",
          ),
        ).toBe(false);
        expect(readTurnExecutionPolicyV1(sessionMetadata()).kind).toBe("absent");
      },
    );
  });

  test.each([
    { name: "manual-only", manualRestriction: "developer_setup" },
    { name: "creator-only", creatorRestriction: "developer_setup" },
    { name: "ordinary accepted run" },
  ] as const)("recovery retains stored $name truth, not the redelivery flag", async (options) => {
    await acceptanceFixture(
      options,
      async ({ run, accepted, recover, sessionMetadata, taskRead }) => {
        await run();
        const frozen = TurnExecutionPolicyV1.parse(accepted().turnExecutionPolicy);
        taskRead.mockClear();
        // Deliberately change the transport flag on redelivery. The accepted
        // occurrence remains immutable; only its creator can taint initial metadata.
        await recover({ ...manualInput, credentialRestriction: "developer_setup" });
        expect(TurnExecutionPolicyV1.parse(accepted().turnExecutionPolicy)).toEqual(frozen);
        expect(taskRead).not.toHaveBeenCalled();
        const creatorRestriction = (options as AcceptanceOptions).creatorRestriction;
        expect(readTurnExecutionPolicyV1(sessionMetadata()).kind).toBe(
          creatorRestriction ? "valid" : "absent",
        );
      },
    );
  });

  test("session metadata keeps legacy absence and rejects malformed accepted policies", () => {
    expect(scheduledSessionExecutionPolicyMetadata(undefined, "developer_setup")).toEqual({});
    expect(scheduledSessionExecutionPolicyMetadata(null, "developer_setup")).toEqual({});
    expect(scheduledSessionExecutionPolicyMetadata(ordinaryPolicy, "developer_setup")).toEqual({});
    expect(() =>
      scheduledSessionExecutionPolicyMetadata({ credentialRestriction: "developer_setup" }),
    ).toThrow();
  });
});
