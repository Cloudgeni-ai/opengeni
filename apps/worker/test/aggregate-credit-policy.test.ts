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
  const debits: db.ApplyCreditDebitInput[] = [];
  const usage = spyOn(db, "recordUsageEventsAndApplyCreditDebit").mockImplementation(
    async (_, input) => {
      if (input.creditDebit) debits.push(input.creditDebit);
      return {
        events: [],
        debit: input.creditDebit
          ? {
              debitedMicros: input.creditDebit.requestedAmountMicros,
              balance: {
                accountId: "account",
                balanceMicros: 100_000_000,
                currency: "usd",
                updatedAt: new Date().toISOString(),
              },
            }
          : null,
      };
    },
  );
  restores.push(usage);
  return { usage, debits };
}

async function settleAggregate(input: {
  revisions: Array<number | undefined>;
  admittedRevisions?: Array<number | undefined>;
  lastAdmittedRevision: number;
  externallyBilled?: boolean;
  tokens?: number;
}) {
  const totalTokens = input.tokens ?? 1_000;
  const externallyBilled = input.externallyBilled ?? false;
  const creditPolicyRevision = aggregateCreditPolicyRevision({
    responseRevisions: new Set(input.revisions),
    ...(input.admittedRevisions ? { admittedRevisions: input.admittedRevisions } : {}),
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
    const { debits } = observeBilling();
    await settleAggregate({ revisions: [revision], lastAdmittedRevision: 9 });
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      modelId: "gpt-5.6-sol",
      creditPolicyRevision: revision,
    });
  },
);

test("aggregate across different admitted policies cannot debit either balance", async () => {
  const { debits, usage } = observeBilling();
  await expect(settleAggregate({ revisions: [0, 1], lastAdmittedRevision: 1 })).rejects.toThrow(
    "Aggregate model usage spans different credit policy revisions",
  );
  expect(debits).toHaveLength(0);
  expect(usage).not.toHaveBeenCalled();
});

test("legacy runtime without response callbacks uses its admitted policy", async () => {
  const { debits } = observeBilling();
  await settleAggregate({ revisions: [], lastAdmittedRevision: 3 });
  expect(debits[0].creditPolicyRevision).toBe(3);
});

test("zero-cost and externally funded aggregates never debit despite policy changes", async () => {
  const { debits } = observeBilling();
  await settleAggregate({ revisions: [0, 1], lastAdmittedRevision: 1, tokens: 0 });
  await settleAggregate({ revisions: [0, 1], lastAdmittedRevision: 1, externallyBilled: true });
  expect(debits).toHaveLength(0);
});

test("aggregate-only runtime refuses different admitted policies without response callbacks", async () => {
  const { debits, usage } = observeBilling();
  await expect(
    settleAggregate({ revisions: [], admittedRevisions: [0, 1], lastAdmittedRevision: 1 }),
  ).rejects.toThrow("Aggregate model usage spans different credit policy revisions");
  expect(debits).toHaveLength(0);
  expect(usage).not.toHaveBeenCalled();
});

test("aggregate-only runtime uses its calls' common admitted policy over later revalidation", async () => {
  const { debits } = observeBilling();
  await settleAggregate({ revisions: [], admittedRevisions: [4, 4], lastAdmittedRevision: 9 });
  expect(debits[0]?.creditPolicyRevision).toBe(4);
});
