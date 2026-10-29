import { expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { useNoSessionUsageLimitForFakeDatabases } from "@opengeni/testing/session-usage-limits";
import { ensureRunAllowed, recordModelUsageAndDebitCredits } from "../src/activities/agent-turn";
// Fake databases have no per-task usage limit state.
useNoSessionUsageLimitForFakeDatabases();

// OPE-929: the admission time is what lets only calls admitted before a
// promotion hold settle against held funding. The PostgreSQL suites prove the
// ledger rule; this pins the turn's hand-off from admission to settlement.
const ACCOUNT = "acct-hold";
const WORKSPACE = "ws-hold";
const ADMITTED_AT = "2026-10-29T10:35:00.123456Z";
const db = {} as Database;
const settings = testSettings({
  billingMode: "stripe",
  usageLimitsMode: "managed",
  modelPricingJson: JSON.stringify({
    "scripted-model": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0 },
  }),
});

test("turn admission returns the database admission time only when the balance carries one", async () => {
  const allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
  const balance = spyOn(opengeniDb, "getSpendableCreditBalance");
  try {
    const read = {
      accountId: ACCOUNT,
      balanceMicros: 1_000,
      currency: "usd" as const,
      updatedAt: new Date().toISOString(),
      creditPolicyRevision: 4,
    };
    balance.mockResolvedValueOnce({ ...read, fundingAdmittedAt: ADMITTED_AT });
    expect(
      await ensureRunAllowed(settings, db, ACCOUNT, WORKSPACE, false, undefined, true, false),
    ).toEqual({ creditPolicyRevision: 4, fundingAdmittedAt: ADMITTED_AT });
    // Admitted while promotional funding is held: no time, so no held funds.
    balance.mockResolvedValueOnce({ ...read, promotionDecision: "held" });
    expect(
      await ensureRunAllowed(settings, db, ACCOUNT, WORKSPACE, false, undefined, true, false),
    ).toEqual({ creditPolicyRevision: 4 });
  } finally {
    balance.mockRestore();
    allowance.mockRestore();
  }
});

test("turn usage settlement forwards the admission time to the credit debit", async () => {
  const recordSpy = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
  const debits: Array<Record<string, unknown>> = [];
  const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
    async (_db, input) => {
      debits.push(input);
      return {
        balance: {
          accountId: ACCOUNT,
          balanceMicros: 0,
          currency: "usd",
          updatedAt: new Date().toISOString(),
        },
        debitedMicros: input.requestedAmountMicros,
        grantDebitedMicros: 0,
      };
    },
  );
  try {
    for (const fundingAdmittedAt of [ADMITTED_AT, undefined]) {
      await recordModelUsageAndDebitCredits(settings, db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-hold",
        turnId: "turn-hold",
        turnAttemptId: "attempt-hold",
        model: "scripted-model",
        externallyBilled: false,
        creditPolicyRevision: 4,
        fundingAdmittedAt,
        usage: { inputTokens: 1_000, outputTokens: 0, totalTokens: 1_000 },
        sourceKey: `response-${fundingAdmittedAt ?? "held"}`,
      });
    }
    expect(debits).toHaveLength(2);
    expect(debits[0]).toMatchObject({
      requestedAmountMicros: 1_000,
      fundingAdmittedAt: ADMITTED_AT,
    });
    expect(debits[1]!.fundingAdmittedAt).toBeUndefined();
  } finally {
    recordSpy.mockRestore();
    debitSpy.mockRestore();
  }
});
