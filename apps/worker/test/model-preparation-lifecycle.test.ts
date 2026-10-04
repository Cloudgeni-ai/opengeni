import { describe, expect, test } from "bun:test";
import { SandboxLeaseTransitionError } from "@opengeni/db";
import { modelPreparationFailureEventPayload } from "../src/activities/agent-turn/errors";

describe("model preparation lifecycle diagnostics", () => {
  test("carries a typed rotation through SDK wrappers without copying sandbox identities", () => {
    const transition = new SandboxLeaseTransitionError(
      "3b1bf3a6-fbde-4c9f-b002-cf002e7a0714",
      5,
      "rotation_in_progress",
      "modal",
      "ca58c4d3-2919-4eac-8e3d-a4c54444cb91",
      "warm",
    );
    const error = new Error("Tool preparation interrupted", {
      cause: new AggregateError([transition], "Function-tool execution interrupted"),
    });
    expect(modelPreparationFailureEventPayload(error, 3_000.4)).toEqual({
      phase: "model_preparation",
      durationMs: 3_000,
      expectedTransition: true,
      failureCategory: "drain_capture_wait",
      failureStage: "lifecycle_wait",
      failureCode: "rotation_in_progress",
      retryable: true,
    });
  });

  test("model errors and lifecycle-looking text remain actual failures", () => {
    for (const error of [
      new Error("Model request rejected"),
      new Error("SandboxLeaseTransitionError: rotation_in_progress"),
      { name: "SandboxLeaseTransitionError", reason: "rotation_in_progress" },
    ]) {
      expect(modelPreparationFailureEventPayload(error, 12.6)).toEqual({
        phase: "model_preparation",
        durationMs: 13,
        expectedTransition: false,
      });
    }
  });

  test("the other typed lifecycle waits carry the same bounded classification", () => {
    for (const reason of ["capture_in_progress", "provider_recovery_in_progress"] as const) {
      const error = new SandboxLeaseTransitionError(
        "fa39b9a8-716c-4fda-b5d0-1aef4cb944f4",
        7,
        reason,
        "modal",
        "77f0d22b-bfca-420a-b4bd-4a9a5f8edaa4",
        "draining",
      );
      expect(modelPreparationFailureEventPayload(error, 1_000)).toMatchObject({
        expectedTransition: true,
        failureCategory: "drain_capture_wait",
        failureStage: "lifecycle_wait",
        failureCode: reason,
      });
    }
  });
});
