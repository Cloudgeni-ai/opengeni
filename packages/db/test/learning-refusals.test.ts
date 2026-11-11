import { describe, expect, test } from "bun:test";
import {
  classifyLearningRefusal,
  LEARNING_REFUSAL_MESSAGES,
  learningRefusalClass,
  learningSaveCorrection,
  nestedAuthorityRefusalMessage,
} from "../src/learning-refusals";

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
      "Knowledge requires exact workspace authority",
      "Skill write requires exact live attempt",
      "Instruction changes require exact tenant scope",
    ]) {
      expect(learningRefusalClass(message)).toEqual({ kind: "fence" });
      expect(classifyLearningRefusal({ destination: "knowledge", message })).toBe(null);
    }
  });

  test("corrections the agent can make itself are not a refusal to show", () => {
    for (const [message, correction] of [
      ["Instruction evidence is unavailable to workspace readers", "evidence_not_shared"],
      ["Knowledge reference would widen source access", "evidence_not_shared"],
      // A private file cited as the source of a shared entry: save it in the
      // personal scope, cite a source readers can open, or drop the file.
      ["File source requires its authorized scope", "source_not_shared"],
      ["Knowledge source would widen document access", "source_not_shared"],
      ["Source file unavailable", "source_not_shared"],
      ["Knowledge reference unavailable", "reference_unavailable"],
      ["Task note is expired, archived or outside this task tree", "reference_unavailable"],
      ["Skill scope differs from the requested scope", "scope_kept"],
      ["Knowledge scope is unavailable or immutable", "scope_kept"],
      ["Agent Knowledge stays in its accepted scope", "scope_kept"],
    ] as const) {
      expect(learningSaveCorrection(message)).toBe(correction);
      for (const destination of ["knowledge", "instruction", "skill"] as const)
        expect(classifyLearningRefusal({ destination, message })).toBe(null);
    }
    // An unknown refusal is still shown: none is ever lost silently.
    expect(learningSaveCorrection("Some new policy refusal")).toBe(null);
    expect(learningRefusalClass("Some new policy refusal")).toEqual({
      kind: "refusal",
      reason: "not_permitted",
    });
  });

  test("every listed message has one well-formed meaning", () => {
    const corrections = new Set([
      "evidence_not_shared",
      "source_not_shared",
      "reference_unavailable",
      "scope_kept",
    ]);
    for (const [message, value] of LEARNING_REFUSAL_MESSAGES) {
      expect(message).toBe(message.trim());
      expect(message).not.toContain("%");
      if (value.kind === "correction") expect(corrections.has(value.correction)).toBe(true);
      if (value.kind === "refusal")
        expect(["learning_off", "not_permitted"]).toContain(value.reason);
    }
    // Only these are the person's Agent learning setting.
    expect(
      [...LEARNING_REFUSAL_MESSAGES]
        .filter(([, value]) => value.kind === "refusal" && value.reason === "learning_off")
        .map(([message]) => message)
        .sort(),
    ).toEqual([
      "Instruction learning is Off",
      "Knowledge learning is Off for this task",
      "Learning is Off; durable Skill changes are refused",
      "governed-learning source is off",
    ]);
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
