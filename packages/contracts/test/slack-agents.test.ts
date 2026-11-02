import { describe, expect, test } from "bun:test";
import { slackAgentHandle, slackAgentNameKey, slackAgentNameProblem } from "../src/slack-agents";

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
    expect(slackAgentNameProblem("A")).toBeNull();
  });
});
