import { describe, expect, test } from "bun:test";
import { handleRigVersionVerificationActivityFailure } from "../src/activities/rig-verification";

describe("Rig version verification settlement", () => {
  test("an audit failure after successful completion never invokes failure settlement", async () => {
    const auditError = new Error("passed audit unavailable");
    let failureSettlements = 0;
    let failureAudits = 0;
    await expect(
      handleRigVersionVerificationActivityFailure({
        error: auditError,
        terminalStateCommitted: true,
        failVerification: async () => {
          failureSettlements += 1;
          return { applied: true, stale: false };
        },
        recordFailureAudit: async () => {
          failureAudits += 1;
        },
      }),
    ).rejects.toBe(auditError);
    expect(failureSettlements).toBe(0);
    expect(failureAudits).toBe(0);
  });

  test("a pre-settlement activity error fails and audits only an applied current attempt", async () => {
    const activityError = new Error("sandbox setup failed");
    const details: string[] = [];
    await expect(
      handleRigVersionVerificationActivityFailure({
        error: activityError,
        terminalStateCommitted: false,
        failVerification: async (detail) => {
          details.push(`fail:${detail}`);
          return { applied: true, stale: false };
        },
        recordFailureAudit: async (detail) => {
          details.push(`audit:${detail}`);
        },
      }),
    ).rejects.toBe(activityError);
    expect(details).toEqual(["fail:sandbox setup failed", "audit:sandbox setup failed"]);
  });
});
