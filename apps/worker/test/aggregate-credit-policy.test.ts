import { afterEach, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  aggregateCreditPolicyRevision,
  recordModelUsageAndDebitCredits,
} from "../src/activities/agent-turn/model-usage";

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of restores.splice(0).reverse()) spy.mockRestore();
});

function observeBilling() {
  const usage = spyOn(db, "recordUsageEvent").mockResolvedValue(undefined);
  const debit = spyOn(db, "applyCreditDebitUpToBalance").mockImplementation(async (_, input) => ({
    debitedMicros: input.requestedAmountMicros,
    balance: {
      accountId: "account",
      balanceMicros: 100_000_000,
      currency: "usd",
      updatedAt: new Date().toISOString(),
    },
  }));
  restores.push(usage, debit);
  return { usage, debit };
}

async function settleAggregate(input: {
  revisions: Array<number | undefined>;
  lastAdmittedRevision: number;
  externallyBilled?: boolean;
  tokens?: number;
}) {
  const totalTokens = input.tokens ?? 1_000;
  const externallyBilled = input.externallyBilled ?? false;
  const creditPolicyRevision = aggregateCreditPolicyRevision({
    responseRevisions: new Set(input.revisions),
    lastAdmittedRevision: input.lastAdmittedRevision,
    chargesOpenGeniCredits: !externallyBilled,
    totalTokens,
  });
  return await recordModelUsageAndDebitCredits(
    testSettings({ billingMode: "stripe" }),
    {} as db.Database,
    {
      accountId: "account",
      workspaceId: "workspace",
      sessionId: "session",
      turnId: "turn",
      turnAttemptId: "attempt",
      model: "gpt-5.6-sol",
      externallyBilled,
      creditPolicyRevision,
      usage: { inputTokens: totalTokens, outputTokens: 0, totalTokens },
      sourceKey: "aggregate",
    },
  );
}

test.each([0, 4, undefined])(
  "aggregate debit retains its completed response policy %s after later admission changes",
  async (revision) => {
    const { debit } = observeBilling();
    await settleAggregate({ revisions: [revision], lastAdmittedRevision: 9 });
    expect(debit).toHaveBeenCalledTimes(1);
    expect(debit.mock.calls[0]?.[1]).toMatchObject({
      modelId: "gpt-5.6-sol",
      creditPolicyRevision: revision,
    });
  },
);

test("aggregate across different admitted policies cannot debit either balance", async () => {
  const { debit, usage } = observeBilling();
  await expect(settleAggregate({ revisions: [0, 1], lastAdmittedRevision: 1 })).rejects.toThrow(
    "Aggregate model usage spans different credit policy revisions",
  );
  expect(debit).not.toHaveBeenCalled();
  expect(usage).not.toHaveBeenCalled();
});

test("legacy runtime without response callbacks uses its admitted policy", async () => {
  const { debit } = observeBilling();
  await settleAggregate({ revisions: [], lastAdmittedRevision: 3 });
  expect(debit.mock.calls[0]?.[1].creditPolicyRevision).toBe(3);
});

test("zero-cost and externally funded aggregates never debit despite policy changes", async () => {
  const { debit } = observeBilling();
  await settleAggregate({ revisions: [0, 1], lastAdmittedRevision: 1, tokens: 0 });
  await settleAggregate({ revisions: [0, 1], lastAdmittedRevision: 1, externallyBilled: true });
  expect(debit).not.toHaveBeenCalled();
});
