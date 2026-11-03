import { describe, expect, test } from "bun:test";
import {
  slackAgentCallText,
  slackAgentDescriptionSentence,
  slackAgentHandle,
  slackAgentIntroLines,
  slackAgentMessageMrkdwn,
  slackAgentMessagePlainText,
  slackAgentNameFormatProblem,
  slackAgentNameKey,
  slackAgentNameProblem,
  slackAgentNameProblemText,
  slackAgentNameWarning,
  UpdateSlackAgentRequest,
  CreateSlackAgentRequest,
} from "../src/slack-agents";

describe("Slack agent names", () => {
  test("compare without case, spaces or hyphens", () => {
    expect(slackAgentNameKey("Data Team")).toBe("datateam");
    expect(slackAgentNameKey("data-team")).toBe("datateam");
    expect(slackAgentHandle(" Data  Team ")).toBe("data-team");
  });

  test("reserved words are refused", () => {
    for (const name of ["Help", "in", "Open-geni", "EVERYONE"]) {
      expect(slackAgentNameProblem(name)).toBe("reserved");
    }
  });

  test("start and end with a letter or digit, so a name ends where people stop typing it", () => {
    expect(slackAgentNameProblem("Acme Inc.")).toBe("invalid");
    expect(slackAgentNameProblem("-Ops")).toBe("invalid");
    expect(slackAgentNameProblem("<@U1>")).toBe("invalid");
    expect(slackAgentNameProblem("Acme Inc")).toBeNull();
    expect(slackAgentNameProblem("O'Neil Desk")).toBeNull();
    expect(slackAgentNameProblem("42 Ops")).toBeNull();
    expect(slackAgentNameProblem("Ab")).toBeNull();
  });

  test("names too short, without letters, or that start ordinary sentences are refused", () => {
    expect(slackAgentNameProblem("A")).toBe("too_short");
    expect(slackAgentNameProblem("42")).toBe("too_short");
    expect(slackAgentNameProblem("7 8")).toBe("too_short");
    for (const name of ["What", "how", "Please", "Hi", "hey", "Thanks", "I", "The", "Test", "OK"]) {
      expect(slackAgentNameProblem(name)).not.toBeNull();
    }
    expect(slackAgentNameProblem("Test")).toBe("sentence_starter");
    expect(slackAgentNameProblemText("Test", "sentence_starter")).toBe(
      'Messages starting with "Test" would go to this agent. Choose another name.',
    );
    // Two words starting with one is fine: only the whole name is compared.
    expect(slackAgentNameProblem("Test runner")).toBeNull();
    // Older names keep saving: the format rules alone accept them.
    expect(slackAgentNameFormatProblem("Test")).toBeNull();
  });

  test("a new agent needs every rule; an edit checks only the format", () => {
    const create = {
      connectionId: "11111111-1111-4111-8111-111111111111",
      name: "Hi",
      description: "Says hi.",
      avatar: { kind: "emoji", emoji: "👋", hue: 10 },
    };
    expect(CreateSlackAgentRequest.safeParse(create).success).toBe(false);
    expect(CreateSlackAgentRequest.safeParse({ ...create, name: "Hi team" }).success).toBe(true);
    expect(UpdateSlackAgentRequest.safeParse({ expectedVersion: 1, name: "Hi" }).success).toBe(
      true,
    );
    expect(UpdateSlackAgentRequest.safeParse({ expectedVersion: 1, name: "-x" }).success).toBe(
      false,
    );
  });

  test("a one-word name gets a warning, not an error", () => {
    expect(slackAgentNameWarning("Data")).toBe(
      'Messages starting with "Data …" go to this agent. Two words, like "Data team", are safer.',
    );
    expect(slackAgentNameWarning("Data team")).toBeNull();
    expect(slackAgentNameWarning("data-team")).toBeNull();
  });
});

describe("how people see an agent", () => {
  test("one way to show how to ask it, with the name as written", () => {
    expect(slackAgentCallText("Data team")).toBe("@Opengeni Data team");
    expect(slackAgentCallText(" Data   team ", "<@U1>")).toBe("<@U1> Data team");
  });

  test("a description reads as a sentence", () => {
    expect(slackAgentDescriptionSentence("answers questions about metrics")).toBe(
      "Answers questions about metrics.",
    );
    expect(slackAgentDescriptionSentence("Answers questions?")).toBe("Answers questions?");
    expect(slackAgentDescriptionSentence("Runs (and fixes) builds.")).toBe(
      "Runs (and fixes) builds.",
    );
    expect(slackAgentDescriptionSentence("  ")).toBe("");
  });

  test("the intro is the same text in Slack and in the preview", () => {
    const lines = slackAgentIntroLines({
      name: "Data team",
      description: "answers questions about metrics",
      addedBy: { slackUserId: "U0ADMIN", name: "Bendik" },
    });
    expect(slackAgentMessagePlainText(lines)).toBe(
      "Hi, I'm Data team, an Opengeni agent. Answers questions about metrics.\nAsk me in any channel: @Opengeni Data team, then your question.\nAdded by @Bendik",
    );
    expect(slackAgentMessageMrkdwn(lines, { botUserId: "U0BOT" })).toBe(
      "Hi, I'm *Data team*, an Opengeni agent. Answers questions about metrics.\nAsk me in any channel: <@U0BOT> Data team, then your question.\n_Added by <@U0ADMIN>_",
    );
    // Unknown ids fall back to plain names, and text is escaped for Slack.
    expect(
      slackAgentMessageMrkdwn(
        slackAgentIntroLines({
          name: "R&D",
          description: "Uses <b>",
          addedBy: { slackUserId: null, name: "Kim" },
        }),
        { botUserId: null },
      ),
    ).toBe(
      "Hi, I'm *R&amp;D*, an Opengeni agent. Uses &lt;b&gt;.\nAsk me in any channel: @Opengeni R&amp;D, then your question.\n_Added by @Kim_",
    );
  });
});
