import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const dispatchSource = await Bun.file(
  new URL("../src/rig-verification-dispatch.ts", import.meta.url),
).text();

function sourceBlock(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`missing source block: ${start}`);
  return source.slice(startIndex, endIndex);
}

describe("Rig verification Temporal dispatch policy", () => {
  test("uses generation-specific reject-duplicate runs without widening automation handling", () => {
    const automation = sourceBlock("triggerAutomationRun: async", "signalUserMessage: async");
    const rigVerification = sourceBlock("startRigVerification: async", "check: async");

    expect(automation).toContain('workflowIdReusePolicy: "REJECT_DUPLICATE"');
    expect(automation).not.toContain("ALLOW_DUPLICATE_FAILED_ONLY");
    expect(rigVerification).toContain('workflowIdReusePolicy: "REJECT_DUPLICATE"');
    expect(rigVerification).not.toContain("ALLOW_DUPLICATE_FAILED_ONLY");
    expect(dispatchSource).toContain("rigVerificationClosedStatusRequiresNewGeneration(status)");
    for (const status of ["FAILED", "CANCELED", "CANCELLED", "TERMINATED", "TIMED_OUT"]) {
      expect(dispatchSource).toContain(`normalized === "${status}"`);
    }
    expect(dispatchSource).toContain("advanceExecutionGeneration");
  });
});
