import { describe, expect, test } from "bun:test";
import {
  interactionDriverDiagnostic,
  parseInteractionDriverDiagnostic,
  redactInteractionDriverMessage,
} from "../src";

describe("interaction driver diagnostics", () => {
  test.each([
    ["CUA returned no exact window capture", "CUA returned no exact window capture"],
    [
      "CUA stopped the batch at action 3: the window Payroll 2026 closed",
      "CUA stopped the batch at action 3: [redacted]",
    ],
    [
      "native window 'Inbox (12) — Mail' is not on screen",
      "native window [redacted] is not on screen",
    ],
    ['JSON Parse error: Unexpected identifier "Inbox"', "JSON Parse error: [redacted]"],
    [
      "undefined is not an object (evaluating 'window.title')",
      "undefined is not an object (evaluating [redacted])",
    ],
    ["open /Users/user/Documents/plan.pdf failed", "open [redacted] failed"],
    ["fetch https://example.test/private?q=1 failed", "fetch [redacted] failed"],
    ["Fenêtre introuvable", "Fen[redacted]tre introuvable"],
  ])("redacts %s", (message, expected) => {
    expect(redactInteractionDriverMessage(message)).toBe(expected);
    expect(redactInteractionDriverMessage(expected)).toBe(expected);
  });

  test("bounds a long message", () => {
    expect(redactInteractionDriverMessage("x".repeat(1_000))).toHaveLength(200);
  });

  test("names the error class and its innermost named function, never its message", () => {
    class ComputerBackendError extends Error {
      override name = "ComputerBackendError";
    }
    function captureWindow(): never {
      throw new ComputerBackendError("window Secret Plans is hidden");
    }
    let thrown: unknown;
    try {
      captureWindow();
    } catch (error) {
      thrown = error;
    }
    const diagnostic = interactionDriverDiagnostic(thrown);
    expect(diagnostic).toEqual({ errorClass: "ComputerBackendError", frame: "captureWindow" });
    expect(JSON.stringify(diagnostic)).not.toContain("Secret");
    expect(interactionDriverDiagnostic("Secret Plans")).toEqual({ errorClass: "NonError" });
  });

  test("accepts only code names from another process", () => {
    expect(
      parseInteractionDriverDiagnostic({ errorClass: "TypeError", frame: "Backend.observe" }),
    ).toEqual({ errorClass: "TypeError", frame: "Backend.observe" });
    expect(
      parseInteractionDriverDiagnostic({ errorClass: "TypeError", frame: "/Users/user/b c" }),
    ).toEqual({ errorClass: "TypeError" });
    expect(parseInteractionDriverDiagnostic({ errorClass: "Secret Plans" })).toBeNull();
    expect(parseInteractionDriverDiagnostic(["TypeError"])).toBeNull();
  });
});
