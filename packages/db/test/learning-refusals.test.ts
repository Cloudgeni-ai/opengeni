import { describe, expect, test } from "bun:test";
import { classifyLearningRefusal, nestedAuthorityRefusalMessage } from "../src/learning-refusals";

describe("classifyLearningRefusal", () => {
  test("names the reason a person can act on", () => {
    expect(
      classifyLearningRefusal({
        destination: "skill",
        message: "Agents cannot review Skills or install workspace plugins from personal learning",
      }),
    ).toEqual({ destination: "skill", reason: "personal_chat" });
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

  test("a Skill scope mismatch names a personal Skill as such", () => {
    const skillId = crypto.randomUUID();
    const mismatch = (skillScope: "user" | "workspace" | "organization" | null) =>
      classifyLearningRefusal({
        destination: "skill",
        message: "Skill outside accepted learning scope",
        skillId,
        skillScope,
      });
    expect(mismatch("user")).toEqual({
      destination: "skill",
      reason: "personal_target",
      skillId,
    });
    // A personal-learning chat can change a workspace Skill; an organization
    // Skill is out of every agent's reach.
    expect(mismatch("organization")?.reason).toBe("not_permitted");
    expect(mismatch(null)?.reason).toBe("not_permitted");
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
