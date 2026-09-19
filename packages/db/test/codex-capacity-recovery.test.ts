import { describe, expect, test } from "bun:test";
import {
  CODEX_CAPACITY_RECOVERY_KEY,
  clearCodexCapacityRecovery,
  codexFalseResumptionBackoffMs,
  readCodexCapacityRecovery,
} from "../src/codex-capacity-recovery";
import { unresolvedCodexCredentialFailures } from "../src/codex-failure-eligibility";

describe("durable false-capacity recovery", () => {
  test("jitter is bounded, exponential and capped independently of wait duration", () => {
    for (let count = 1; count <= 10; count++) {
      const min = codexFalseResumptionBackoffMs(count, 0);
      const max = codexFalseResumptionBackoffMs(count, 1);
      expect(min).toBe(max / 2);
      expect(max).toBeLessThanOrEqual(900_000);
      expect(codexFalseResumptionBackoffMs(count, 0.5)).toBe((min + max) / 2);
    }
    expect(codexFalseResumptionBackoffMs(1, 1)).toBe(60_000);
    expect(codexFalseResumptionBackoffMs(2, 1)).toBe(120_000);
    expect(codexFalseResumptionBackoffMs(10, 1)).toBe(900_000);
  });

  test("JSON restart preserves the counter, fence and deadline; clearing preserves other metadata", () => {
    const recovery = {
      falseResumptions: 9,
      resumeGeneration: 47,
      retryNotBefore: "2026-09-20T01:00:00.000Z",
    };
    const metadata = { policy: "unchanged", [CODEX_CAPACITY_RECOVERY_KEY]: recovery };
    expect(readCodexCapacityRecovery(JSON.parse(JSON.stringify(metadata)))).toEqual(recovery);
    expect(clearCodexCapacityRecovery(metadata)).toEqual({ policy: "unchanged" });
    expect(readCodexCapacityRecovery({}).falseResumptions).toBe(0);
    for (const invalid of [
      null,
      {},
      { ...recovery, falseResumptions: -1 },
      { ...recovery, resumeGeneration: 0 },
      { ...recovery, retryNotBefore: "invalid" },
    ]) {
      expect(() => readCodexCapacityRecovery({ [CODEX_CAPACITY_RECOVERY_KEY]: invalid })).toThrow();
    }
  });

  test("only a newer verified clear recovers a failed credential; legacy and backpressure remain excluded", () => {
    const metadata = {
      codexCredentialFailedIds: ["a"],
      codexCredentialFailureCooldownRevisions: { a: 3 },
    };
    const account = {
      id: "a",
      status: "active",
      exhaustedUntil: null,
      exhaustedKind: null,
      exhaustedRevision: 4,
    };
    expect(unresolvedCodexCredentialFailures(metadata, [account])).toEqual([]);
    expect(
      unresolvedCodexCredentialFailures(metadata, [{ ...account, exhaustedRevision: 3 }]),
    ).toEqual(["a"]);
    expect(
      unresolvedCodexCredentialFailures(metadata, [{ ...account, exhaustedKind: "rate_limit" }]),
    ).toEqual(["a"]);
    expect(
      unresolvedCodexCredentialFailures({ codexCredentialFailedIds: ["a"] }, [account]),
    ).toEqual(["a"]);
    expect(
      unresolvedCodexCredentialFailures(
        { ...metadata, codexCredentialFailureCooldownRevisions: { a: null } },
        [account],
      ),
    ).toEqual(["a"]);
  });
});
