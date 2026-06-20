import { describe, expect, test } from "bun:test";
import { Session, SessionTurn } from "@opengeni/contracts";

// Pure (no-postgres) spec for the 0018 read-side shape: the contract Session
// carries sandboxOs (enum, default linux) + sandboxGroupId (uuid), and
// SessionTurn carries a NULLable sandboxOs override. mapSession/mapSessionTurn
// (packages/db/src/index.ts) map exactly these onto the contract; the migration
// test covers the live DB write->read, this pins the wire shape they target.

const id = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";

function baseSession() {
  return {
    id,
    workspaceId,
    accountId,
    status: "queued" as const,
    initialMessage: "hi",
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt",
    sandboxBackend: "modal" as const,
    sandboxOs: "linux" as const,
    sandboxGroupId: id,
    environmentId: null,
    firstPartyMcpPermissions: null,
    parentSessionId: null,
    createIdempotencyKey: null,
    temporalWorkflowId: null,
    activeTurnId: null,
    lastInputTokens: null,
    lastSequence: 0,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

describe("Session sandbox OS + group (0018 read-side contract)", () => {
  test("singleton group: sandboxGroupId == id, sandboxOs linux round-trips", () => {
    const parsed = Session.parse(baseSession());
    expect(parsed.sandboxOs).toBe("linux");
    expect(parsed.sandboxGroupId).toBe(id);
  });

  test("shared group: sandboxGroupId points at an ancestor's id", () => {
    const groupId = "44444444-4444-4444-8444-444444444444";
    const parsed = Session.parse({ ...baseSession(), sandboxGroupId: groupId, sandboxOs: "macos" });
    expect(parsed.sandboxGroupId).toBe(groupId);
    expect(parsed.sandboxOs).toBe("macos");
  });

  test("rejects an out-of-enum sandboxOs", () => {
    expect(() => Session.parse({ ...baseSession(), sandboxOs: "solaris" })).toThrow();
  });

  test("requires sandboxGroupId (no implicit default in the wire shape)", () => {
    const { sandboxGroupId: _omit, ...withoutGroup } = baseSession();
    expect(() => Session.parse(withoutGroup)).toThrow();
  });

  test("SessionTurn sandboxOs is a NULLable override", () => {
    const baseTurn = {
      id,
      workspaceId,
      sessionId: id,
      triggerEventId: "55555555-5555-4555-8555-555555555555",
      temporalWorkflowId: "wf",
      status: "queued" as const,
      source: "user" as const,
      position: 1,
      prompt: "go",
      resources: [],
      tools: [],
      model: "gpt",
      reasoningEffort: "medium" as const,
      sandboxBackend: "modal" as const,
      sandboxOs: null,
      metadata: {},
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    };
    expect(SessionTurn.parse(baseTurn).sandboxOs).toBeNull();
    expect(SessionTurn.parse({ ...baseTurn, sandboxOs: "windows" }).sandboxOs).toBe("windows");
    expect(() => SessionTurn.parse({ ...baseTurn, sandboxOs: "bad" })).toThrow();
  });
});
