import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import type { ComposerDraft, SessionGoal, SessionTurn } from "@opengeni/sdk";
import type { SessionClientLike } from "../src/client";

export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const SESSION_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Structural fake for `SessionClientLike`: implement only the methods the
 * hook under test calls; everything else throws with a clear message.
 */
export function fakeClient(partial: Partial<SessionClientLike>): SessionClientLike {
  const emptyDraft: ComposerDraft = {
    revision: 0,
    text: "",
    resources: [],
    model: "model-x",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: null,
  };
  const target = {
    getClientConfig: async () =>
      ({
        deploymentRevision: "test",
        apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
        defaultModel: "model-x",
        allowedModels: ["model-x"],
        models: [],
        defaultReasoningEffort: "medium",
        allowedReasoningEfforts: ["medium"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 0 },
        productAccessMode: "local",
        auth: { mode: "none" },
        structuredServices: {
          fileSystem: false,
          git: false,
          terminalEvents: false,
        },
      }) as never,
    getComposerDraft: async () => emptyDraft,
    listEvents: async () => [],
    listSiteAuthConnections: async () => ({ revision: 0, connections: [] }),
    saveComposerDraft: async (_workspaceId: string, _sessionId: string, request: any) => ({
      ...emptyDraft,
      ...request,
      revision: request.expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    }),
    submitComposerDraft: async (workspaceId: string, sessionId: string, request: any) => {
      const result =
        request.delivery === "steer"
          ? await target.steerMessage(workspaceId, sessionId, request)
          : {
              accepted: await target.sendMessage(workspaceId, sessionId, request),
              turn: fakeTurn({ prompt: request.text }),
            };
      return {
        ...result,
        draft: {
          revision: request.expectedDraftRevision + 1,
          text: "",
          annotations: [],
          resources: [],
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          latencyMode: request.latencyMode,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: new Date().toISOString(),
        },
        interruptionCount: "interruptionCount" in result ? (result.interruptionCount ?? 0) : 0,
        replay: "replay" in result ? (result.replay ?? false) : false,
      };
    },
    ...partial,
  } as SessionClientLike;
  if (!partial.fsListBatch) {
    target.fsListBatch = async (workspaceId, sessionId, request, options) => ({
      results: await Promise.all(
        request.requests.map(
          async (item) => await target.fsList(workspaceId, sessionId, item, options),
        ),
      ),
    });
  }
  if (!partial.gitReadBatch) {
    target.gitReadBatch = async (workspaceId, sessionId, request, options) => ({
      results: await Promise.all(
        request.requests.map(async (item) => ({
          status: await target.gitStatus(workspaceId, sessionId, item.status, options),
          ...(item.diff
            ? {
                diff: await target.gitDiff(workspaceId, sessionId, item.diff, options),
              }
            : {}),
        })),
      ),
    });
  }
  return new Proxy(target, {
    get(clientTarget, property) {
      const value = (clientTarget as Record<PropertyKey, unknown>)[property];
      if (value === undefined && typeof property === "string") {
        return () => {
          throw new Error(`fake client: ${property} is not implemented in this test`);
        };
      }
      return value;
    },
  });
}

export function fakeTurn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    id: crypto.randomUUID(),
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: "wf-1",
    status: "queued",
    source: "user",
    position: 1,
    prompt: "queued work",
    resources: [],
    tools: [],
    toolsProvided: false,
    model: "model-x",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    sandboxOs: null,
    metadata: {},
    version: 1,
    executionGeneration: 0,
    activeAttemptId: null,
    lineage: {},
    initiator: { kind: "subject", subjectId: "user:test" },
    initiatorContext: {},
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

export function fakeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: crypto.randomUUID(),
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    status: "active",
    text: "Keep deploys green",
    successCriteria: null,
    evidence: null,
    rationale: null,
    pausedReason: null,
    createdBy: "api",
    version: 1,
    objectiveRevision: 1,
    mutationPolicy: "preserve_intent",
    autoContinuations: 3,
    noProgressStreak: 1,
    maxAutoContinuations: null,
    metadata: {},
    continuation: {
      state: "running",
      reason: "goal_turn_running",
      wakeRevision: 1,
      observedRevision: 1,
      nextAttemptAt: null,
      lastError: null,
    },
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
    rootConstraints: overrides.rootConstraints ?? [],
  };
}
