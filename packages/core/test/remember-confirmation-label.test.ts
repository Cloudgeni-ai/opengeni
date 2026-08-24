import { describe, expect, test } from "bun:test";
import { HumanInputQuestion } from "@opengeni/contracts";
import { rememberConfirmationLabel } from "@opengeni/core";

/**
 * The confirmation card has to make the cost of a durable write visible before
 * a human agrees to it. The canonical `prompt`, `helpText`, and `options` are
 * byte-verified by the human-confirmed activation capability, so the cost note
 * lives on `label`, which those capabilities deliberately do not constrain.
 */
describe("remember confirmation label", () => {
  test("a mandatory rule says it lands in every session prompt, with its length", () => {
    expect(rememberConfirmationLabel({ lane: "instruction_policy", contentChars: 1_912 })).toBe(
      "Remember (1912 chars, in every session prompt)",
    );
  });

  test("a role-scoped rule does not overstate its reach", () => {
    expect(
      rememberConfirmationLabel({
        lane: "instruction_policy",
        contentChars: 240,
        policyScope: "role",
      }),
    ).toBe("Remember (240 chars, in every prompt for this role)");
  });

  test("a preference is honest that only its summary is always composed", () => {
    expect(rememberConfirmationLabel({ lane: "preference", contentChars: 240 })).toBe(
      "Remember (240 chars, summary in every prompt)",
    );
  });

  test("knowledge is honest that it is retrieval, not standing prompt text", () => {
    expect(rememberConfirmationLabel({ lane: "knowledge", contentChars: 64 })).toBe(
      "Remember (64 chars, retrieved when relevant)",
    );
  });

  test("reads as a card heading, because that is where the form renders it", () => {
    // `HumanInputForm` uses a single question's label as the title and its
    // prompt as the sub-text, so a sentence here would demote the question.
    for (const lane of ["instruction_policy", "preference", "knowledge"] as const) {
      const label = rememberConfirmationLabel({ lane, contentChars: 612 });
      expect(label.startsWith("Remember (")).toBe(true);
      expect(label.endsWith(")")).toBe(true);
      expect(label.length).toBeLessThanOrEqual(56);
    }
  });

  test("stays inside the human-input label bound for every lane and length", () => {
    for (const lane of ["instruction_policy", "preference", "knowledge"] as const) {
      for (const contentChars of [1, 600, 4_000, 262_144]) {
        const label = rememberConfirmationLabel({ lane, contentChars });
        expect(label.length).toBeLessThanOrEqual(128);
        expect(
          HumanInputQuestion.safeParse({
            id: "remember:00000000-0000-4000-8000-000000000001",
            kind: "single_select",
            prompt: "Save this as a mandatory workspace rule for everyone in this workspace?",
            label,
            helpText: "content",
            options: [
              { id: "save", label: "Save" },
              { id: "skip", label: "Don't save" },
            ],
            required: true,
            allowOther: false,
          }).success,
        ).toBe(true);
      }
    }
  });
});
