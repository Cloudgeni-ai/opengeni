import { describe, expect, test } from "bun:test";
import {
  CODEX_CAPACITY_RECOVERY_KEY,
  clearCodexCapacityRecovery,
  codexFalseResumptionBackoffMs,
  readCodexCapacityRecovery,
} from "../src/codex-capacity-recovery";
import { unresolvedCodexCredentialFailures } from "../src/codex-failure-eligibility";

describe("durable false-capacity recovery", () => {
  test("typed rate limits recover only after a fenced deadline; status refusals require a newer repaired version", () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const account = {
      id: "a",
      status: "active",
      exhaustedUntil: null as Date | null,
      exhaustedKind: null as string | null,
      exhaustedRevision: 3,
      credentialVersion: 7,
    };
    const failure = (receipt: Record<string, unknown>) => ({
      codexCredentialFailedIds: ["a"],
      codexCredentialFailureEvidenceV1: { a: receipt },
    });
    const status = failure({ kind: "status", credentialVersion: 7 });
    expect(unresolvedCodexCredentialFailures(status, [account], now)).toEqual(["a"]);
    expect(
      unresolvedCodexCredentialFailures(status, [{ ...account, credentialVersion: 8 }], now),
    ).toEqual([]);
    expect(
      unresolvedCodexCredentialFailures(
        status,
        [{ ...account, status: "needs_relogin", credentialVersion: 8 }],
        now,
      ),
    ).toEqual(["a"]);
    const rateLimit = failure({ kind: "rate_limit", cooldownRevision: 3 });
    const limited = {
      ...account,
      exhaustedKind: "rate_limit",
      exhaustedUntil: new Date(now.getTime() + 1),
    };
    expect(unresolvedCodexCredentialFailures(rateLimit, [limited], now)).toEqual(["a"]);
    expect(
      unresolvedCodexCredentialFailures(rateLimit, [limited], new Date(now.getTime() + 2)),
    ).toEqual([]);
    expect(
      unresolvedCodexCredentialFailures(
        rateLimit,
        [{ ...limited, exhaustedRevision: 2 }],
        new Date(now.getTime() + 2),
      ),
    ).toEqual(["a"]);
    expect(
      unresolvedCodexCredentialFailures(
        rateLimit,
        [{ ...limited, exhaustedKind: "quota" }],
        new Date(now.getTime() + 2),
      ),
    ).toEqual(["a"]);
  });
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

  test("legacy numeric quota requires a newer clear; ID-only stays excluded; explicit status evidence recovers", () => {
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
    ).toEqual([]);
    expect(
      unresolvedCodexCredentialFailures(
        { ...metadata, codexCredentialFailureCooldownRevisions: { a: null } },
        [{ ...account, status: "needs_relogin" }],
      ),
    ).toEqual(["a"]);
    expect(
      unresolvedCodexCredentialFailures(metadata, [
        {
          ...account,
          exhaustedKind: "rate_limit",
          exhaustedRevision: 3,
          exhaustedUntil: new Date(0),
        },
      ]),
    ).toEqual([]);
  });
});
