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
    const label = rememberConfirmationLabel({ lane: "instruction_policy", contentChars: 1_912 });
    expect(label).toBe(
      "Remember - 1912 characters, added to every session prompt in this workspace",
    );
  });

  test("a preference is honest that only its summary is always composed", () => {
    expect(rememberConfirmationLabel({ lane: "preference", contentChars: 240 })).toBe(
      "Remember - 240 characters, summary in every session prompt, full text on demand",
    );
  });

  test("knowledge is honest that it is retrieval, not standing prompt text", () => {
    expect(rememberConfirmationLabel({ lane: "knowledge", contentChars: 64 })).toBe(
      "Remember - 64 characters, retrieved when relevant, not always in the prompt",
    );
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
