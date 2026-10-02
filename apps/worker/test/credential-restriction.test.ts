import { describe, expect, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import { metadataWithTurnExecutionPolicyV1, verifyDelegatedAccessToken } from "@opengeni/contracts";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { turnCredentialRestriction } from "../src/activities/agent-turn/credential-restriction";
import {
  prepareRunCredentials,
  type PrepareRunCredentialsDeps,
} from "../src/activities/agent-turn/run-credentials";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
};

const settings = testSettings({ sandboxBackend: "selfhosted" });
const policy = resolveTurnExecutionPolicyV1(settings, {
  modelId: settings.openaiModel,
  requestedModelId: null,
  modelSource: "session",
  reasoningEffort: "low",
  reasoningSource: "session",
});
const setupPolicy = { ...policy, credentialRestriction: "developer_setup" as const };

describe("trusted worker credential restriction", () => {
  test("uses only validated frozen policies, not ordinary metadata or initiator shape", () => {
    expect(turnCredentialRestriction(policy, undefined)).toBeUndefined();
    expect(
      turnCredentialRestriction(policy, {
        credentialRestriction: "developer_setup",
        initiator: { kind: "api_key", access: "developer_setup" },
      }),
    ).toBeUndefined();
    expect(turnCredentialRestriction(setupPolicy, {})).toBe("developer_setup");
    expect(
      turnCredentialRestriction(policy, metadataWithTurnExecutionPolicyV1({}, setupPolicy)),
    ).toBe("developer_setup");
    expect(() =>
      turnCredentialRestriction(policy, {
        turnExecutionPolicyV1: { credentialRestriction: "developer_setup" },
      }),
    ).toThrow("Malformed turn execution policy");
  });

  test.each(["none", "accepted", "initial"] as const)(
    "production Codemode preparation and renewal preserve %s provenance",
    async (source) => {
      const context = createTurnContext({ settings, cancellationRequestedAt: null });
      context.attempt.turnId = scope.turnId;
      context.attempt.executionGeneration = 1;
      const prepared = await prepareRunCredentials({
        ...context,
        input: {
          ...scope,
          workflowId: "fixture-workflow",
          workflowRunId: "fixture-workflow-run",
          trigger: { kind: "next" },
        },
        settings,
        db: {},
        observability: createObservability(settings, { component: "worker" }),
        connectionCredentials: undefined,
        personalGitHubCredentials: undefined,
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
          metadata: source === "initial" ? metadataWithTurnExecutionPolicyV1({}, setupPolicy) : {},
        },
        turnExecutionPolicy: source === "accepted" ? setupPolicy : policy,
        fileAuthoritySubjectId: null,
        runSettings: settings,
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
        runWorkspaceMutationForSandbox: async (_sandbox, _operation, mutation) => await mutation(),
      } as PrepareRunCredentialsDeps);
      try {
        const expected = source === "none" ? undefined : "developer_setup";
        const initial = await verifyDelegatedAccessToken(
          settings.delegationSecret!,
          prepared.sandboxCodemodeToken!,
        );
        expect(initial.credentialRestriction).toBe(expected);
        expect(prepared.codemodeAuthority.credentialRestriction).toBe(expected);
        expect(Object.hasOwn(initial, "credentialRestriction")).toBe(source !== "none");
        // Force the production renewal path without waiting for an expiry timer.
        await prepared.attachCodemodeTokenRenewal(undefined, new Date(0));
        const renewed = await verifyDelegatedAccessToken(
          settings.delegationSecret!,
          prepared.transientCodemodeEnvironment!().OPENGENI_CODEMODE_TOKEN!,
        );
        expect(renewed.credentialRestriction).toBe(expected);
        expect(renewed.permissions).toEqual(["codemode:call"]);
      } finally {
        await context.renewals.codemodeTokenRenewal?.stop();
        prepared.runMcpCredentials.close();
      }
    },
  );
});
