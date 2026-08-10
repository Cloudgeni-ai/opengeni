import { describe, expect, test } from "bun:test";
import type { MemorySlackPublication } from "@opengeni/contracts";
import { sanitizeMemorySlackPublicationHistory } from "../src/routes/memory-slack-publications";

function publication(summary: string): MemorySlackPublication {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    configurationRevision: 1,
    connectionId: "33333333-3333-4333-8333-333333333333",
    slackTeamId: "T1",
    slackChannelId: "C1",
    sourceType: "workspace_memory",
    sourceId: "44444444-4444-4444-8444-444444444444",
    sourceVersion: "1",
    importance: "major",
    deliveryMode: "review",
    state: "review_pending",
    summary,
    sourceLabel: "Workspace Memory",
    authoritativePath: "/workspaces/22222222-2222-4222-8222-222222222222/memory",
    initiatorKind: "service",
    initiatorSubjectId: "goal-continuation",
    initiatingHumanSubjectId: "human:causal-owner",
    attemptCount: 0,
    retryAt: null,
    lastErrorCode: null,
    slackMessageTimestamp: null,
    deliveredAt: null,
    terminalAt: null,
    createdAt: "2026-08-10T09:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    receipts: [],
  };
}

describe("Memory Slack delivery history projection", () => {
  test("omits credential-shaped text from legacy rows without changing causal identity", () => {
    const syntheticCredential = `github_pat_${"H".repeat(32)}`;
    const source = publication(`Legacy api_key=${syntheticCredential}`);
    const projected = sanitizeMemorySlackPublicationHistory(source);

    expect(source.summary).toContain(syntheticCredential);
    expect(projected.summary).not.toContain(syntheticCredential);
    expect(projected.summary).toContain("[credential omitted]");
    expect(projected.initiatorKind).toBe("service");
    expect(projected.initiatorSubjectId).toBe("goal-continuation");
    expect(projected.initiatingHumanSubjectId).toBe("human:causal-owner");
  });

  test("preserves object identity when the bounded summary is already safe", () => {
    const source = publication("Adopt the governed delivery adapter.");
    expect(sanitizeMemorySlackPublicationHistory(source)).toBe(source);
  });
});
