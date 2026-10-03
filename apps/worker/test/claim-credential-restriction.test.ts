import { describe, expect, spyOn, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  metadataWithTurnExecutionPolicyV1,
  TurnExecutionPolicyV1,
  verifyDelegatedAccessToken,
} from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { claimTurnAttempt, type ClaimTurnDeps } from "../src/activities/agent-turn/claim";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";
import {
  prepareRunCredentials,
  type PrepareRunCredentialsDeps,
} from "../src/activities/agent-turn/run-credentials";
import * as capabilities from "../src/activities/capabilities";

const settings = testSettings({ sandboxBackend: "none" });
const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
};
const ordinaryPolicy = resolveTurnExecutionPolicyV1(settings, {
  modelId: settings.openaiModel,
  requestedModelId: null,
  modelSource: "continuation",
  reasoningEffort: "low",
  reasoningSource: "continuation",
  latencyMode: "standard",
  latencyModeSource: "continuation",
});
const restrictedPolicy = { ...ordinaryPolicy, credentialRestriction: "developer_setup" as const };

describe("worker accepted-turn credential restriction installation", () => {
  test.each([
    {
      name: "server-frozen source-only restriction",
      initiatorContext: { credentialRestriction: "developer_setup" },
      expected: "developer_setup",
    },
    {
      name: "trusted initial-session restriction",
      sessionMetadata: metadataWithTurnExecutionPolicyV1({}, restrictedPolicy),
      expected: "developer_setup",
    },
    {
      name: "already-frozen setup policy",
      turnMetadata: metadataWithTurnExecutionPolicyV1({}, restrictedPolicy),
      expected: "developer_setup",
    },
    {
      name: "already-frozen ordinary policy",
      turnMetadata: metadataWithTurnExecutionPolicyV1({}, ordinaryPolicy),
      expected: undefined,
    },
    { name: "legacy absence", expected: undefined },
    {
      name: "spoofed ordinary metadata",
      turnMetadata: { credentialRestriction: "developer_setup" },
      sessionMetadata: { credentialRestriction: "developer_setup" },
      expected: undefined,
    },
  ] as const)("preserves $name at the actual claim installer boundary", async (fixture) => {
    const options = fixture as {
      initiatorContext?: Record<string, unknown>;
      sessionMetadata?: Record<string, unknown>;
      turnMetadata?: Record<string, unknown>;
      expected: "developer_setup" | undefined;
    };
    const context = createTurnContext({ settings, cancellationRequestedAt: null });
    const stopAfterCapture = new Error("fixture stopped after accepted-policy capture");
    let candidate: TurnExecutionPolicyV1 | null = null;
    const spies = [
      spyOn(core, "resolveCatalogSettings").mockResolvedValue({ settings } as Awaited<
        ReturnType<typeof core.resolveCatalogSettings>
      >),
      spyOn(db, "claimSessionWorkForAttempt").mockResolvedValue({
        action: "claimed",
        turn: {
          id: scope.turnId,
          sessionId: scope.sessionId,
          executionGeneration: 1,
          triggerEventId: "66666666-6666-4666-8666-666666666666",
          source: "system",
          initiator: { kind: "service", subjectId: "internal-update" },
          initiatorContext: options.initiatorContext ?? {},
          metadata: options.turnMetadata ?? {},
          model: settings.openaiModel,
          reasoningEffort: "low",
          latencyMode: "standard",
        },
      } as Awaited<ReturnType<typeof db.claimSessionWorkForAttempt>>),
      spyOn(db, "requireSession").mockResolvedValue({
        id: scope.sessionId,
        metadata: options.sessionMetadata ?? {},
      } as Awaited<ReturnType<typeof db.requireSession>>),
      spyOn(db, "workspaceCodexSubscriptionActive").mockResolvedValue(false),
      spyOn(capabilities, "settingsWithEnabledCapabilityMcpServers").mockResolvedValue(settings),
      spyOn(capabilities, "settingsWithCodexCredential").mockResolvedValue(settings),
      spyOn(capabilities, "settingsWithWorkspaceGatewayCredential").mockResolvedValue(settings),
      spyOn(capabilities, "settingsWithWorkspaceOpenRouterCredential").mockResolvedValue(settings),
      spyOn(capabilities, "settingsWithOrganizationProviderCredentials").mockResolvedValue(
        settings,
      ),
      spyOn(db, "installOrReadTurnExecutionPolicyForAttempt").mockImplementation(
        async (_db, input) => {
          expect(input).toMatchObject({
            ...scope,
            executionGeneration: 1,
          });
          candidate = TurnExecutionPolicyV1.parse(input.policyForAbsent);
          throw stopAfterCapture;
        },
      ),
    ];
    try {
      await expect(
        claimTurnAttempt({
          ...context,
          settings,
          catalogSourceSettings: settings,
          db: {},
          input: {
            ...scope,
            workflowId: "fixture-workflow",
            workflowRunId: "fixture-workflow-run",
            trigger: { kind: "next" },
          },
          dispatchId: "fixture-dispatch",
          leases: { codex: { holderId: null } },
        } as ClaimTurnDeps),
      ).rejects.toBe(stopAfterCapture);
      expect(candidate).not.toBeNull();
      const frozen = candidate as unknown as TurnExecutionPolicyV1;
      expect(frozen.credentialRestriction).toBe(options.expected);
      expect(Object.hasOwn(frozen, "credentialRestriction")).toBe(!!options.expected);
      expect(JSON.parse(JSON.stringify(frozen)).credentialRestriction).toBe(options.expected);
      const { credentialRestriction: _restriction, ...ordinary } = frozen;
      expect(ordinary).toEqual(ordinaryPolicy);
      // Feed the exact candidate captured at the claim boundary through the
      // production worker preparation, rather than copying its flag into a
      // hand-built token payload or mint options.
      const tokenSettings = { ...settings, sandboxBackend: "selfhosted" as const };
      const credentials = await prepareRunCredentials({
        ...context,
        input: {
          ...scope,
          workflowId: "fixture-workflow",
          workflowRunId: "fixture-workflow-run",
          trigger: { kind: "next" },
        },
        settings: tokenSettings,
        db: {},
        observability: createObservability(tokenSettings, { component: "worker" }),
        turn: {
          id: scope.turnId,
          executionGeneration: 1,
          resources: [],
          mcpAccountBindings: [],
          personalConnectionDelegations: [],
        },
        session: {
          id: scope.sessionId,
          mcpServers: [],
          metadata: options.sessionMetadata ?? {},
        },
        turnExecutionPolicy: frozen,
        fileAuthoritySubjectId: null,
        runSettings: tokenSettings,
        workspaceVariableSet: null,
        turnResources: [],
        turnTools: [],
        requiredGeneratedVideoFiles: [],
        machinePrimary: true,
        activeSandboxBackend: "selfhosted",
        groupBoxBackend: "selfhosted",
        sandboxCreationBackend: "selfhosted",
        effectiveRunCredentialBackend: "selfhosted",
        sandboxWorkspaceEnvironmentValues: {},
        connectionScope: scope,
      } as PrepareRunCredentialsDeps);
      try {
        const bearer = await verifyDelegatedAccessToken(
          settings.delegationSecret!,
          credentials.sandboxCodemodeToken!,
        );
        expect(bearer.credentialRestriction).toBe(options.expected);
        expect(Object.hasOwn(bearer, "credentialRestriction")).toBe(!!options.expected);
        expect(bearer.permissions).toEqual(["codemode:call"]);
      } finally {
        credentials.runMcpCredentials.close();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
