import { describe, expect, test } from "bun:test";
import { canonicalSkillReviewQuestion, HumanInputQuestion } from "../src/index";
import { skillReviewHumanInput } from "../src/skills";

const choice = {
  id: "send",
  kind: "single_select" as const,
  prompt: "Send the summary to Sam now?",
  options: [
    { id: "send", label: "Send it" },
    { id: "draft", label: "Keep it as a draft" },
  ],
};

describe("richer human-input questions", () => {
  test("an option can be recommended and carry a preview", () => {
    const parsed = HumanInputQuestion.parse({
      ...choice,
      options: [
        { id: "iso", label: "ISO", recommended: true, preview: "2026-10-27" },
        { id: "long", label: "Written out", recommended: null, preview: null },
      ],
    });
    expect(parsed.options[0]).toMatchObject({ recommended: true, preview: "2026-10-27" });
  });

  test("confirm is a single choice between exactly two options", () => {
    expect(HumanInputQuestion.safeParse({ ...choice, confirm: true }).success).toBe(true);
    expect(HumanInputQuestion.safeParse({ ...choice, confirm: null }).success).toBe(true);
    expect(
      HumanInputQuestion.safeParse({ ...choice, kind: "multi_select", confirm: true }).success,
    ).toBe(false);
    expect(
      HumanInputQuestion.safeParse({
        ...choice,
        confirm: true,
        options: [...choice.options, { id: "later", label: "Ask me later" }],
      }).success,
    ).toBe(false);
  });

  test("strict-schema nulls and false do not make a Skill review question non-canonical", () => {
    const canonical = skillReviewHumanInput({
      sourceOperationId: "8f3a7c1e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
      skillId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
      revisionId: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
      expectedRevisionId: null,
      expectedScopeVersion: 3,
    }).questions[0]!;
    const sent = HumanInputQuestion.parse({
      ...canonical,
      helpText: canonical.helpText,
      label: canonical.label,
      confirm: false,
      validation: null,
      options: canonical.options.map((option) => ({
        ...option,
        description: null,
        recommended: false,
        preview: null,
      })),
    });
    expect(canonicalSkillReviewQuestion(sent)).toEqual(canonical);
    const altered = HumanInputQuestion.parse({
      ...canonical,
      options: canonical.options.map((option, index) => ({
        ...option,
        recommended: index === 0,
      })),
    });
    expect(canonicalSkillReviewQuestion(altered)).toBeNull();
  });
});
