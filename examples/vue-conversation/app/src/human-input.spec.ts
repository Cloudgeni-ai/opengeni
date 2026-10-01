import { expect, test } from "bun:test";
import type { SessionHumanInputRequest } from "@opengeni/sdk";
import { validateAnswers } from "./human-input";

const request = {
  questions: [
    {
      id: "q",
      prompt: "Activities?",
      kind: "multi_select",
      required: true,
      allowOther: true,
      options: [
        { id: "walk", label: "Walk" },
        { id: "museum", label: "Museum" },
      ],
      validation: { minSelections: 1, maxSelections: 1 },
    },
  ],
  expiresAt: null,
} as SessionHumanInputRequest;
test("validates required, known options and min/max while allowing Other", () => {
  expect(validateAnswers(request, [])).not.toBeNull();
  expect(validateAnswers(request, [{ questionId: "q", values: ["invalid"] }])).not.toBeNull();
  expect(
    validateAnswers(request, [{ questionId: "q", values: ["walk", "museum"] }]),
  ).not.toBeNull();
  expect(validateAnswers(request, [{ questionId: "q", values: ["walk"] }])).toBeNull();
  expect(validateAnswers(request, [{ questionId: "q", values: [], other: "Garden" }])).toBeNull();
});
test("expired input is not silently submitted", () => {
  expect(
    validateAnswers({ ...request, expiresAt: "2020-01-01T00:00:00Z" }, [
      { questionId: "q", values: ["walk"] },
    ]),
  ).toContain("expired");
});
