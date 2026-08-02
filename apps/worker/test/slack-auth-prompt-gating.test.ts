import { describe, expect, test } from "bun:test";
import { shouldPublishToolAuthNeededForTurn } from "../src/activities/agent-turn";

const setupAuthNeeded = {
  providerDomain: "slack.com",
  toolName: null,
};
const directHumanTurn = {
  source: "user" as const,
  initiator: { kind: "subject" as const, subjectId: "human-alice" },
  initiatorContext: {},
};
const serviceTurn = {
  source: "system" as const,
  initiator: { kind: "service" as const, subjectId: "system" },
  initiatorContext: {},
};

describe("Slack auth prompt gating", () => {
  test.each([
    "Connect Slack",
    "Please post this update in Slack.",
    "Can you summarize the latest Slack thread?",
  ])("allows setup-time prompts for explicit Slack intent: %s", (text) => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        setupAuthNeeded,
        {
          type: "user.message",
          payload: { text },
        },
        directHumanTurn,
      ),
    ).toBe(true);
  });

  test.each([
    "Summarize this Terraform plan.",
    "What is the weather today?",
    "Draft a concise project update.",
  ])("suppresses setup-time Slack prompts for unrelated chat: %s", (text) => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        setupAuthNeeded,
        {
          type: "user.message",
          payload: { text },
        },
        directHumanTurn,
      ),
    ).toBe(false);
  });

  test("suppresses setup-time Slack prompts for non-human continuation turns", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        setupAuthNeeded,
        {
          type: "system.update.delivered",
          payload: {},
        },
        serviceTurn,
      ),
    ).toBe(false);
  });

  test("suppresses setup-time Slack prompts for service-initiated user messages", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        setupAuthNeeded,
        { type: "user.message", payload: { text: "Post this update in Slack." } },
        { ...serviceTurn, source: "user" },
      ),
    ).toBe(false);
  });

  test("allows setup-time prompts for direct authenticated API commands", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        setupAuthNeeded,
        { type: "user.message", payload: { text: "Post this update in Slack." } },
        {
          source: "api",
          initiator: directHumanTurn.initiator,
          initiatorContext: {},
        },
      ),
    ).toBe(true);
  });

  test("suppresses agent-created user turns that inherit a human ancestor", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        setupAuthNeeded,
        { type: "user.message", payload: { text: "Post this update in Slack." } },
        {
          source: "user",
          initiator: directHumanTurn.initiator,
          initiatorContext: {
            via: [
              {
                kind: "agent",
                sessionId: "parent-session",
                turnId: "parent-turn",
                attemptId: "parent-attempt",
                executionGeneration: 1,
              },
            ],
          },
        },
      ),
    ).toBe(false);
  });

  test("suppresses agent-sent user messages that inherit a human ancestor", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        setupAuthNeeded,
        { type: "user.message", payload: { text: "Post this update in Slack." } },
        {
          source: "api",
          initiator: directHumanTurn.initiator,
          initiatorContext: {
            via: [
              {
                kind: "agent",
                sessionId: "source-session",
                turnId: "source-turn",
                attemptId: "source-attempt",
                executionGeneration: 3,
              },
            ],
          },
        },
      ),
    ).toBe(false);
  });

  test.each([
    {
      name: "delegated service",
      turn: {
        source: "api" as const,
        initiator: { kind: "service" as const, subjectId: "embedding-service" },
        initiatorContext: { occurrenceId: "occurrence-1" },
      },
    },
    {
      name: "system turn with a spoofed user.message trigger",
      turn: {
        source: "system" as const,
        initiator: { kind: "service" as const, subjectId: "system" },
        initiatorContext: {},
      },
    },
    {
      name: "malformed inherited provenance",
      turn: {
        source: "user" as const,
        initiator: directHumanTurn.initiator,
        initiatorContext: { via: "spoofed-agent-shape" },
      },
    },
  ])("suppresses setup-time Slack prompts for $name", ({ turn }) => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        setupAuthNeeded,
        { type: "user.message", payload: { text: "Post this update in Slack." } },
        turn,
      ),
    ).toBe(false);
  });

  test("preserves a concrete Slack tool-call auth prompt", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        { providerDomain: "slack.com", toolName: "search" },
        { type: "system.update.delivered", payload: {} },
        serviceTurn,
      ),
    ).toBe(true);
  });

  test("does not change setup-time prompts for other providers", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        { providerDomain: "linear.app", toolName: null },
        { type: "user.message", payload: { text: "Summarize this Terraform plan." } },
        serviceTurn,
      ),
    ).toBe(true);
  });
});
