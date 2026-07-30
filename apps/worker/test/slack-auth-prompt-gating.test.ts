import { describe, expect, test } from "bun:test";
import { shouldPublishToolAuthNeededForTurn } from "../src/activities/agent-turn";

const setupAuthNeeded = {
  providerDomain: "slack.com",
  toolName: null,
};
const humanInitiator = { kind: "subject" as const };
const serviceInitiator = { kind: "service" as const };

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
        humanInitiator,
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
        humanInitiator,
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
        serviceInitiator,
      ),
    ).toBe(false);
  });

  test("suppresses setup-time Slack prompts for service-initiated user messages", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        setupAuthNeeded,
        { type: "user.message", payload: { text: "Post this update in Slack." } },
        serviceInitiator,
      ),
    ).toBe(false);
  });

  test("preserves a concrete Slack tool-call auth prompt", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        { providerDomain: "slack.com", toolName: "search" },
        { type: "system.update.delivered", payload: {} },
        serviceInitiator,
      ),
    ).toBe(true);
  });

  test("does not change setup-time prompts for other providers", () => {
    expect(
      shouldPublishToolAuthNeededForTurn(
        { providerDomain: "linear.app", toolName: null },
        { type: "user.message", payload: { text: "Summarize this Terraform plan." } },
        serviceInitiator,
      ),
    ).toBe(true);
  });
});
