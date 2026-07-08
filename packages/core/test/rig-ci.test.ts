import { describe, expect, test } from "bun:test";
import { appendRigSetupCommand, classifyRigVerificationOutcome } from "../src/rigs";

describe("rig CI promotion decisions", () => {
  test.each([
    ["setup_append", true, false, "merged", "auto_promote"],
    ["definition_edit", true, false, "proposed", "await_manage_promote"],
    ["setup_append", false, false, "rejected", "reject"],
    ["definition_edit", false, false, "rejected", "reject"],
    ["setup_append", true, true, "failed", "retryable_failure"],
    ["definition_edit", false, true, "failed", "retryable_failure"],
  ] as const)("%s passed=%p infra=%p -> %s/%s", (kind, passed, infraError, status, action) => {
    expect(classifyRigVerificationOutcome({ kind, passed, infraError })).toEqual({
      status,
      action,
    });
  });

  test("setup_append version composition appends the verified command", () => {
    expect(appendRigSetupCommand("mkdir -p /opt/x\n", "touch /opt/x/tool")).toBe(
      "mkdir -p /opt/x\ntouch /opt/x/tool",
    );
    expect(appendRigSetupCommand(null, "touch /opt/x/tool")).toBe("touch /opt/x/tool");
  });
});
