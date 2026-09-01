import { describe, expect, test } from "bun:test";
import type { HumanInputQuestion } from "@opengeni/sdk";
import { answersFromHumanInputDrafts } from "@opengeni/sdk/session";
import { humanInputResponse } from "../src/human-input";

const questions: HumanInputQuestion[] = [
  {
    id: "summary",
    kind: "text",
    prompt: "What should happen?",
    options: [],
    required: false,
    allowOther: false,
  },
  {
    id: "targets",
    kind: "multi_select",
    prompt: "Where?",
    options: [
      { id: "staging", label: "Staging" },
      { id: "production", label: "Production" },
    ],
    required: true,
    allowOther: true,
    validation: { minSelections: 2, maxSelections: 2 },
  },
];

describe("native Svelte human-input contract", () => {
  test("uses the framework-neutral validator and omits unanswered optional questions", () => {
    expect(
      answersFromHumanInputDrafts(questions, {
        targets: {
          values: ["staging"],
          other: "  canary  ",
          otherSelected: true,
        },
      }),
    ).toEqual({
      answers: [
        {
          questionId: "targets",
          values: ["staging"],
          other: "  canary  ",
        },
      ],
      errors: {},
    });
  });

  test("enforces selection bounds and prioritizes an empty selected Other", () => {
    expect(
      answersFromHumanInputDrafts(questions, {
        targets: { values: ["staging"], other: "", otherSelected: false },
      }).errors.targets,
    ).toBe("Choose at least 2 options.");
    expect(
      answersFromHumanInputDrafts(questions, {
        targets: { values: [], other: "", otherSelected: true },
      }).errors.targets,
    ).toBe("Enter a value for Other.");
  });

  test("builds the exact SDK response and rejects an invalid first question", () => {
    expect(
      humanInputResponse(questions, {
        targets: {
          values: ["staging", "production"],
          other: "",
          otherSelected: false,
        },
      }),
    ).toEqual({
      outcome: "answered",
      answers: [{ questionId: "targets", values: ["staging", "production"] }],
    });
    expect(() => humanInputResponse(questions, {})).toThrow("This question is required.");
  });
});
