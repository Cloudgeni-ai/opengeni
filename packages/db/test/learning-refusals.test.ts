import { describe, expect, test } from "bun:test";
import { classifyLearningRefusal, nestedAuthorityRefusalMessage } from "../src/learning-refusals";

describe("classifyLearningRefusal", () => {
  test("names the reason a person can act on", () => {
    expect(
      classifyLearningRefusal({
        destination: "skill",
        message: "Learning is Off; durable Skill changes are refused",
      }),
    ).toEqual({ destination: "skill", reason: "learning_off" });
    expect(
      classifyLearningRefusal({
        destination: "instruction",
        message: "Instruction learning is Off",
      }),
    ).toEqual({ destination: "instruction", reason: "learning_off" });
    expect(
      classifyLearningRefusal({
        destination: "knowledge",
        message: "Knowledge learning is Off for this task",
      }),
    ).toEqual({ destination: "knowledge", reason: "learning_off" });
    expect(
      classifyLearningRefusal({ destination: "knowledge", message: "Some other policy refusal" }),
    ).toEqual({ destination: "knowledge", reason: "not_permitted" });
  });

  test("a Skill no chat may change is a plain refusal", () => {
    const skillId = crypto.randomUUID();
    expect(
      classifyLearningRefusal({
        destination: "skill",
        message: "Skill outside accepted learning scope",
        skillId,
      }),
    ).toEqual({ destination: "skill", reason: "not_permitted", skillId });
  });

  test("transient fences are not a refusal to show", () => {
    for (const message of [
      "Knowledge attempt is stale",
      "Knowledge attempt is interrupted",
      "Learning scope changed after acceptance",
    ]) {
      expect(classifyLearningRefusal({ destination: "knowledge", message })).toBe(null);
    }
  });

  test("finds the authority refusal inside a wrapped driver error", () => {
    const wrapped = {
      message: "Failed query: select ...",
      cause: { code: "42501", message: "Instruction learning is Off" },
    };
    expect(nestedAuthorityRefusalMessage(wrapped)).toBe("Instruction learning is Off");
    expect(nestedAuthorityRefusalMessage({ code: "40001", message: "retry" })).toBe(null);
  });
});
