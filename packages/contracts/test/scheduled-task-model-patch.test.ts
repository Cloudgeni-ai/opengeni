import { describe, expect, test } from "bun:test";
import { UpdateScheduledTaskRequest } from "../src";

describe("scheduled-task model patch", () => {
  test("retains only the explicitly supplied model settings without config defaults", () => {
    for (const agentConfigPatch of [
      { prompt: "Revised message" },
      { model: "scripted-model" },
      { reasoningEffort: "high" },
      { model: "scripted-model", reasoningEffort: "high" },
    ] as const) {
      expect(UpdateScheduledTaskRequest.parse({ agentConfigPatch })).toEqual({ agentConfigPatch });
    }
  });

  test.each([
    {},
    { prompt: "" },
    { model: "scripted-model", tools: [] },
    { model: "" },
    { model: "x".repeat(513) },
    { model: null },
    { reasoningEffort: "invalid" },
    { reasoningEffort: null },
  ])("rejects an empty, unrelated or invalid patch: %j", (agentConfigPatch) => {
    expect(UpdateScheduledTaskRequest.safeParse({ agentConfigPatch }).success).toBe(false);
  });

  test("rejects ambiguous replacement plus patch", () => {
    expect(
      UpdateScheduledTaskRequest.safeParse({
        agentConfig: { prompt: "replacement" },
        agentConfigPatch: { model: "scripted-model" },
      }).success,
    ).toBe(false);
  });

  test("keeps the existing complete replacement contract", () => {
    expect(UpdateScheduledTaskRequest.parse({ agentConfig: { prompt: "replacement" } })).toEqual({
      agentConfig: { prompt: "replacement", tools: [], resources: [], metadata: {} },
    });
    expect(
      UpdateScheduledTaskRequest.safeParse({ agentConfig: { model: "scripted-model" } }).success,
    ).toBe(false);
  });
});
