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
    tools: [],
    model: "model-x",
    reasoningEffort: "medium",
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: null,
  };
  const target = {
    getClientConfig: async () =>
      ({
        deploymentRevision: "test",
        apiContractRevision: "2026-07-turn-instructions-v1",
        defaultModel: "model-x",
        allowedModels: ["model-x"],
        models: [],
        defaultReasoningEffort: "medium",
        allowedReasoningEfforts: ["medium"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 0 },
        productAccessMode: "local",
        auth: { mode: "none" },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      }) as never,
    getComposerDraft: async () => emptyDraft,
    saveComposerDraft: async (_workspaceId: string, _sessionId: string, request: any) => ({
      ...emptyDraft,
      ...request,
      revision: request.expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    }),
    ...partial,
  } as SessionClientLike;
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
    model: "model-x",
    reasoningEffort: "medium",
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
    autoContinuations: 3,
    noProgressStreak: 1,
    maxAutoContinuations: null,
    metadata: {},
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}
