import { describe, expect, test } from "bun:test";
import {
  MemorySlackPublicationDistribution,
  UpdateMemorySlackPublicationConfigurationRequest,
} from "../src";

describe("Memory Slack delivery contracts", () => {
  test("accepts bounded workspace-only distribution intent", () => {
    expect(
      MemorySlackPublicationDistribution.parse({
        importance: "major",
        audience: "workspace",
        slackMode: "auto",
        shareSummary: "Adopt the durable publication outbox.",
      }),
    ).toEqual({
      importance: "major",
      audience: "workspace",
      slackMode: "auto",
      shareSummary: "Adopt the durable publication outbox.",
    });
    expect(
      MemorySlackPublicationDistribution.safeParse({
        importance: "major",
        audience: "organization",
        slackMode: "auto",
        shareSummary: "Too broad",
      }).success,
    ).toBe(false);
  });

  test("requires a complete enabled destination and disjoint importance policies", () => {
    const base = {
      expectedRevision: 0,
      enabled: true,
      connectionId: "11111111-1111-4111-8111-111111111111",
      slackChannelId: "C123",
      slackChannelName: "decisions",
      autoImportances: ["major"] as const,
      reviewImportances: ["normal"] as const,
    };
    expect(UpdateMemorySlackPublicationConfigurationRequest.safeParse(base).success).toBe(true);
    expect(
      UpdateMemorySlackPublicationConfigurationRequest.safeParse({
        ...base,
        slackChannelId: null,
      }).success,
    ).toBe(false);
    expect(
      UpdateMemorySlackPublicationConfigurationRequest.safeParse({
        ...base,
        reviewImportances: ["major"],
      }).success,
    ).toBe(false);
  });
});
