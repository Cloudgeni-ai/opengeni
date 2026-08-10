import { describe, expect, test } from "bun:test";
import type { ClaimedMemorySlackPublication } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { formatMemorySlackPublicationMessage } from "../src/memory-slack-delivery";

function publication(
  overrides: Partial<ClaimedMemorySlackPublication> = {},
): ClaimedMemorySlackPublication {
  const now = new Date("2026-08-10T05:00:00.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    configurationId: "44444444-4444-4444-8444-444444444444",
    configurationRevision: 3,
    connectionId: "55555555-5555-4555-8555-555555555555",
    slackTeamId: "T1",
    slackChannelId: "C1",
    sourceType: "workspace_memory",
    sourceId: "66666666-6666-4666-8666-666666666666",
    sourceVersion: "2",
    sourceIdempotencyKey: "memory:v2",
    projection: {
      summary: "Adopt immutable publication receipts.",
      changeKind: "corrected",
      ownerLabel: "Platform council",
      occurredAt: now.toISOString(),
      rawText: "must-not-appear",
    },
    projectionSha256: "a".repeat(64),
    importance: "major",
    deliveryMode: "auto",
    state: "delivering",
    operationId: "77777777-7777-4777-8777-777777777777",
    initiatorKind: "human",
    initiatorSubjectId: "subject-1",
    initiatingHumanSubjectId: "subject-1",
    sessionId: null,
    turnId: null,
    attemptId: null,
    claimHolderId: "88888888-8888-4888-8888-888888888888",
    claimExpiresAt: new Date(now.getTime() + 30_000),
    attemptCount: 1,
    retryAt: null,
    lastErrorCode: null,
    slackMessageTimestamp: null,
    deliveredAt: null,
    terminalAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Memory Slack delivery projection", () => {
  test("formats bounded notification copy with an authoritative application link", () => {
    const text = formatMemorySlackPublicationMessage(
      { settings: testSettings({ webBaseUrl: "https://app.example.test" }) },
      publication(),
    );
    expect(text).toContain("Workspace Memory corrected");
    expect(text).toContain("Adopt immutable publication receipts.");
    expect(text).toContain("Importance: major");
    expect(text).toContain("https://app.example.test/workspaces/");
    expect(text).not.toContain("must-not-appear");
    expect(text).not.toContain("subject-1");
    expect(text.length).toBeLessThanOrEqual(3_500);
  });

  test("uses governed-learning outcome metadata without treating Slack as authority", () => {
    const text = formatMemorySlackPublicationMessage(
      { settings: testSettings({ publicBaseUrl: "https://opengeni.example.test" }) },
      publication({
        sourceType: "durable_learning",
        sourceId: "attempt-1",
        projection: {
          summary: "The governed write completed.",
          outcome: "committed",
          destination: "workspace_memory",
        },
      }),
    );
    expect(text).toContain("Governed learning committed");
    expect(text).toContain("Surface: workspace_memory");
    expect(text).toContain("/workspace-state");
  });

  test("neutralizes Slack control sequences in governed projection fields", () => {
    const text = formatMemorySlackPublicationMessage(
      { settings: testSettings() },
      publication({
        projection: {
          summary: "Notify <@U123> and <!channel> & owners",
          changeKind: "corrected <unsafe>",
          ownerLabel: "<@U456>",
        },
      }),
    );
    expect(text).not.toContain("<@U123>");
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;@U123&gt;");
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&amp; owners");
  });
});
