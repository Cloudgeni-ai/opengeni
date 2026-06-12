import type { SessionGoal, SessionTurn } from "@opengeni/sdk";
import type { SessionClientLike } from "../src/client";

export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const SESSION_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Structural fake for `SessionClientLike`: implement only the methods the
 * hook under test calls; everything else throws with a clear message.
 */
export function fakeClient(partial: Partial<SessionClientLike>): SessionClientLike {
  return new Proxy(partial as SessionClientLike, {
    get(target, property) {
      const value = (target as Record<PropertyKey, unknown>)[property];
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
    metadata: {},
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
