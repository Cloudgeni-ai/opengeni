import { afterEach, describe, expect, jest, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import { verifyDelegatedAccessToken } from "@opengeni/contracts";
import { createObservability } from "@opengeni/observability";
import { buildManifest, buildOpenGeniAgent } from "@opengeni/runtime";
import { CODEMODE_TOKEN_TTL_SECONDS } from "@opengeni/runtime/sandbox";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import {
  runEagerOwnedSandboxSetup,
  type EagerOwnedSandboxSetupDeps,
} from "../src/activities/agent-turn/owned-sandbox-setup";
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
const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
const policy = resolveTurnExecutionPolicyV1(settings, {
  modelId: settings.openaiModel,
  requestedModelId: null,
  modelSource: "session",
  reasoningEffort: "low",
  reasoningSource: "session",
});
const MINUTE_MS = 60_000;
const TOKEN_LIFETIME_MS = CODEMODE_TOKEN_TTL_SECONDS * 1_000;

/** Let the renewal's signing and file write settle after a timer fires. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A managed box that only remembers what its Codemode token file holds. */
function tokenFileBox(environment: Record<string, string>) {
  const writes: Array<{ token: string; atMs: number }> = [];
  const box = {
    state: { manifest: buildManifest(settings, [], environment) },
    exec: async (args: { cmd: string }) => {
      const seed = /OPENGENI_CODEMODE_TOKEN_SEED='([^']+)'/.exec(args.cmd)?.[1];
      if (seed) writes.push({ token: seed, atMs: Date.now() });
      return { exitCode: 0, output: "" };
    },
    createEditor: () => ({
      createFile: async () => undefined,
      deleteFile: async () => undefined,
    }),
  };
  return {
    box,
    writes,
    current: (): string | undefined => writes.at(-1)?.token,
  };
}

afterEach(() => {
  jest.useRealTimers();
});

describe("a managed attempt's Codemode bearer lasts the whole attempt", () => {
  test("eager setup renews the bearer and a later stream's setup never reseeds an expired one", async () => {
    const startedAt = Date.parse("2026-01-05T08:53:45.000Z");
    jest.useFakeTimers({ now: startedAt });
    const context = createTurnContext({ settings, cancellationRequestedAt: null });
    context.attempt.turnId = scope.turnId;
    context.attempt.executionGeneration = 2;
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
        executionGeneration: 2,
        resources: [],
        mcpAccountBindings: [],
        personalConnectionDelegations: [],
      },
      session: { id: scope.sessionId, mcpServers: [], metadata: {} },
      turnExecutionPolicy: policy,
      fileAuthoritySubjectId: null,
      runSettings: settings,
      workspaceVariableSet: null,
      turnResources: [],
      turnTools: [],
      requiredGeneratedVideoFiles: [],
      machinePrimary: false,
      activeSandboxBackend: "modal",
      groupBoxBackend: "modal",
      sandboxCreationBackend: "modal",
      // Run credentials are not under test here.
      effectiveRunCredentialBackend: "none",
      connectionScope: scope,
      runWorkspaceMutationForSandbox: async (_sandbox, _operation, mutation) => await mutation(),
    } as PrepareRunCredentialsDeps);
    const buildTimeToken = prepared.sandboxCodemodeToken!;
    expect(prepared.sandboxCodemodeTokenExpiresAt!.getTime()).toBe(startedAt + TOKEN_LIFETIME_MS);

    const { box, writes, current } = tokenFileBox(prepared.sandboxEnvironment);
    // The agent carries the bearer minted when the attempt started.
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: prepared.sandboxEnvironment,
      codemodeTokenSeed: buildTimeToken,
      codemodeTokenSessionId: scope.sessionId,
    });
    const resolvedSandbox = {
      leaseEpoch: 1,
      established: { instanceId: "box-a", session: box },
    };
    const deps = {
      agent,
      input: { sessionId: scope.sessionId },
      attempt: context.attempt,
      observability: createObservability(settings, { component: "worker" }),
      sandboxState: { resolvedSandbox, lazyOwnedSandbox: null, setupBoxSession: null },
      eventing: {
        publish: async () => undefined,
        publishInBackground: () => undefined,
        toolCancellationFenceRef: { current: null },
      },
      leases: { renewServing: async () => undefined, servingLost: () => false },
      turnExecutionPolicy: { providerId: "openai" },
      activeSandboxBackend: "modal",
      groupBoxBackend: "modal",
      runSettings: settings,
      sandboxEnvironment: prepared.sandboxEnvironment,
      initialRunCredentialMaterial: null,
      initialGitCredentials: undefined,
      fileResourceDownloads: [],
      runWorkspaceMutationForSandbox: async (
        _sandbox: unknown,
        _operation: string,
        mutation: () => Promise<unknown>,
      ) => await mutation(),
      attachRunCredentialRenewal: async () => null,
      attachGitCredentialRenewal: async () => undefined,
      prepareCodemodeTokenSeed: prepared.prepareCodemodeTokenSeed,
      attachCodemodeTokenRenewal: prepared.attachCodemodeTokenRenewal,
    } as unknown as EagerOwnedSandboxSetupDeps;

    // What the Codemode API does with the bearer a fresh client reads now.
    const accepted = async (token: string | undefined) =>
      token
        ? await verifyDelegatedAccessToken(
            settings.delegationSecret!,
            token,
            Math.floor(Date.now() / 1_000),
          )
        : null;
    const runPastMinutes = async (minutes: number): Promise<void> => {
      for (let minute = 0; minute < minutes; minute += 1) {
        jest.advanceTimersByTime(MINUTE_MS);
        await settle();
        const payload = await accepted(current());
        if (!payload) {
          throw new Error(
            `the box's Codemode bearer was rejected ${Math.round((Date.now() - startedAt) / MINUTE_MS)} minutes into the attempt`,
          );
        }
        // Renewal never widens authority: the bearer stays bound to this exact
        // attempt and never outlives one token lifetime from now.
        expect(payload.attemptId).toBe(scope.attemptId);
        expect(payload.turnId).toBe(scope.turnId);
        expect(payload.executionGeneration).toBe(2);
        expect(payload.exp * 1_000).toBeLessThanOrEqual(Date.now() + TOKEN_LIFETIME_MS);
      }
    };

    try {
      // First model stream: setup seeds the attempt-start bearer.
      await runEagerOwnedSandboxSetup(deps, { fileDownloadsMaterialized: true });
      expect(current()).toBe(buildTimeToken);

      // A long Codemode run: well past the old one-hour lifetime.
      await runPastMinutes(95);
      expect(current()).not.toBe(buildTimeToken);

      // A later stream of the same attempt (as after a context compaction)
      // runs setup again. It must write the newest bearer, not the expired
      // attempt-start one, and keep renewing it.
      const writesBeforeSecondStream = writes.length;
      await runEagerOwnedSandboxSetup(deps, { fileDownloadsMaterialized: true });
      const reseeded = writes.slice(writesBeforeSecondStream);
      expect(reseeded.length).toBeGreaterThan(0);
      for (const write of reseeded) {
        expect(write.token).not.toBe(buildTimeToken);
        expect(await accepted(write.token)).not.toBeNull();
      }
      await runPastMinutes(95);

      // Every bearer ever written was valid when the box received it.
      for (const write of writes) {
        const payload = await verifyDelegatedAccessToken(
          settings.delegationSecret!,
          write.token,
          Math.floor(write.atMs / 1_000),
        );
        expect(payload).not.toBeNull();
      }
    } finally {
      context.renewals.codemodeTokenRenewalClosed = true;
      await context.renewals.codemodeTokenRenewal?.stop();
      prepared.runMcpCredentials.close();
    }
  });
});
