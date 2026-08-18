import { describe, expect, test } from "bun:test";

import { classifyEditableArtifactOpenFailure } from "../../src/editable-artifacts/open-failure";

describe("editable artifact open failure telemetry", () => {
  test("distinguishes bounded failure categories using codes only", () => {
    expect(classifyEditableArtifactOpenFailure(withCode("ARTIFACT_UNSUPPORTED_VERSION"))).toEqual({
      category: "unsupported_old_format",
      code: "artifact_unsupported_version",
    });
    expect(classifyEditableArtifactOpenFailure(withCode("ARTIFACT_CHECKSUM_MISMATCH"))).toEqual({
      category: "byte_corruption",
      code: "artifact_checksum_mismatch",
    });
    expect(classifyEditableArtifactOpenFailure(withCode("ARTIFACT_STATE_MISMATCH"))).toEqual({
      category: "authored_causal_mismatch",
      code: "artifact_state_mismatch",
    });
    expect(classifyEditableArtifactOpenFailure(withCode("runtime_identity_mismatch"))).toEqual({
      category: "runtime_package_mismatch",
      code: "runtime_identity_mismatch",
    });
    expect(
      classifyEditableArtifactOpenFailure(withCode("ARTIFACT_RUNTIME_UNSUPPORTED_TARGET")),
    ).toEqual({
      category: "runtime_package_mismatch",
      code: "artifact_runtime_unsupported_target",
    });
    expect(
      classifyEditableArtifactOpenFailure(withCode("ARTIFACT_RUNTIME_PROJECTION_PARITY")),
    ).toEqual({
      category: "projection_parity_ci_failure",
      code: "artifact_runtime_projection_parity",
    });
  });

  test("never copies workbook, formula, or arbitrary error text", () => {
    const sentinel = "=SECRET_FORMULA(never-log-this)";
    const event = classifyEditableArtifactOpenFailure(
      Object.assign(new Error(sentinel), {
        code: "ARTIFACT_INVALID_COLLABORATION_SNAPSHOT",
        workbook: sentinel,
      }),
    );
    expect(event).toEqual({
      category: "byte_corruption",
      code: "artifact_invalid_collaboration_snapshot",
    });
    expect(JSON.stringify(event)).not.toContain(sentinel);
    expect(classifyEditableArtifactOpenFailure(new Error(sentinel))).toBeNull();
  });

  test("never invokes an accessor while reading a telemetry code", () => {
    let getterCalls = 0;
    const error = Object.defineProperty(new Error("ignored"), "code", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "ARTIFACT_STATE_MISMATCH";
      },
    });
    expect(classifyEditableArtifactOpenFailure(error)).toBeNull();
    expect(getterCalls).toBe(0);
  });
});

function withCode(code: string): Error & { code: string } {
  return Object.assign(new Error("ignored content"), { code });
}
