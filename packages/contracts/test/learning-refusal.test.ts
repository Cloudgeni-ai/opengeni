import { describe, expect, test } from "bun:test";
import {
  LEARNING_REFUSAL_META_KEY,
  learningRefusalFromToolOutput,
  withLearningRefusalMeta,
} from "../src/learning-refusal";

const skillId = "21a78814-7662-4252-b40a-b57971b244e7";

describe("learning refusal fact", () => {
  test("is added to `_meta` without touching the model-visible result", () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: "Nothing was saved." }],
      _meta: { other: 1 },
    };
    const withFact = withLearningRefusalMeta(result, {
      destination: "skill",
      reason: "learning_off",
      skillId,
    });
    expect(withFact.content).toBe(result.content);
    expect(withFact._meta as Record<string, unknown>).toEqual({
      other: 1,
      [LEARNING_REFUSAL_META_KEY]: { destination: "skill", reason: "learning_off", skillId },
    });
    expect(learningRefusalFromToolOutput(withFact)).toEqual({
      destination: "skill",
      reason: "learning_off",
      skillId,
    });
  });

  test("rejects anything but the closed content-free shape when writing", () => {
    expect(() =>
      withLearningRefusalMeta({}, {
        destination: "skill",
        reason: "learning_off",
        message: "private text",
      } as never),
    ).toThrow();
    expect(() =>
      withLearningRefusalMeta({}, { destination: "skill", reason: "learning_off", skillId: "x" }),
    ).toThrow();
  });

  test("reads stored facts tolerantly: a newer reason is the generic refusal", () => {
    const output = (fact: unknown) => ({ _meta: { [LEARNING_REFUSAL_META_KEY]: fact } });
    expect(
      learningRefusalFromToolOutput(output({ destination: "instruction", reason: "future" })),
    ).toEqual({ destination: "instruction", reason: "not_permitted" });
    expect(learningRefusalFromToolOutput(output({ destination: "memory", reason: "x" }))).toBe(
      null,
    );
    expect(learningRefusalFromToolOutput("Nothing was saved.")).toBe(null);
    expect(learningRefusalFromToolOutput({ content: [] })).toBe(null);
  });
});
