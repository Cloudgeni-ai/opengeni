import { afterAll, expect, mock, test } from "bun:test";
import type { CreditDebitAttribution } from "@opengeni/db";
import type { ControlActivityServices } from "../src/activities/types";

let attribution: CreditDebitAttribution = { kind: "service" };
let refusal: { message: string } | null = null;
const debit = mock(async (_db: unknown, _input: unknown) => undefined);
const preflight = mock(async (_db: unknown, _input: unknown) => refusal);
const defer = mock(async () => undefined);
const embed = mock(async () => [[1, 0, 0]]);
mock.module("@opengeni/core", () => ({
  paidDocumentEmbedding: () => true,
  documentEmbeddingCostMicros: () => 20,
}));
mock.module("@opengeni/documents", () => ({
  knowledgeIndexChunks: function* () {
    yield { index: 0, field: "content", start: 0, end: 4, text: "test", embeddingInput: "test" };
  },
}));
mock.module("@opengeni/db", () => ({
  claimKnowledgeIndexJobs: async () => [
    {
      accountId: "account",
      revisionId: "revision",
      generation: 1,
      model: "embedding",
      billingAttribution: attribution,
    },
  ],
  readKnowledgeIndexSource: async () => ({
    billingWorkspaceId: "workspace",
    nextIndex: 0,
    entry: {},
  }),
  withWorkspaceUsageLock: async (
    _db: unknown,
    _workspace: string,
    fn: (db: unknown) => Promise<unknown>,
  ) => fn(_db),
  freezeKnowledgeIndexBillingMode: async () => ({ mode: "credits", rateMicrosPerMillionBytes: 1 }),
  getBillingBalance: async () => ({ balanceMicros: 100 }),
  checkWorkspaceAllowance: preflight,
  guardPaidKnowledgeIndexPublication: async () => "published",
  appendKnowledgeIndexChunks: async () => ({ status: "running" }),
  recordUsageEvent: async () => undefined,
  applyCreditDebitAfterUse: debit,
  completeKnowledgeIndexJob: async () => ({ status: "ready" }),
  continueKnowledgeIndexJob: async () => undefined,
  deferKnowledgeIndexJob: defer,
  waitKnowledgeIndexForFunding: async () => undefined,
  sumUsageQuantity: async () => 0,
  knowledgeIndexBillingActivationTime: async () => new Date(),
  creditDebitAttributionMetadata: (value: CreditDebitAttribution) =>
    value.kind === "turn"
      ? {
          turnId: value.turnId,
          ...(value.initiatingHumanSubjectId
            ? { initiatingHumanSubjectId: value.initiatingHumanSubjectId }
            : {}),
        }
      : value.kind === "human"
        ? { initiatingHumanSubjectId: value.initiatingHumanSubjectId }
        : {},
}));
const { createKnowledgeIndexingActivities } = await import("../src/activities/knowledge-indexing");
afterAll(() => mock.restore());

function worker() {
  return createKnowledgeIndexingActivities(
    async () =>
      ({
        db: {},
        settings: {
          documentEmbeddingProvider: "openai",
          documentEmbeddingBillingMode: "credits",
          documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z",
          usageLimitsMode: "none",
        },
        observability: { warn: () => undefined },
      }) as unknown as ControlActivityServices,
    async () => ({ embedder: { model: "embedding", dimensions: 3, embedMany: embed } }) as never,
  );
}

test("index debit/preflight reuse claimed frozen initiator, never the async worker or latest session", async () => {
  const turnId = crypto.randomUUID();
  for (const [value, human, metadata] of [
    [
      { kind: "turn", turnId, initiatingHumanSubjectId: "human:root" },
      "human:root",
      { turnId, initiatingHumanSubjectId: "human:root" },
    ],
    [
      { kind: "human", initiatingHumanSubjectId: "human:upload" },
      "human:upload",
      { initiatingHumanSubjectId: "human:upload" },
    ],
    [{ kind: "service" }, null, {}],
  ] as const) {
    attribution = value;
    expect((await worker().indexKnowledge()).completed).toBe(1);
    expect(preflight.mock.calls.at(-1)?.[1]).toMatchObject({ subjectId: human });
    expect(debit.mock.calls.at(-1)?.[1]).toMatchObject({
      metadata: { ...metadata, model: "embedding", bytes: 4, chunks: 1 },
    });
  }
});

test("unknown attribution and exhausted allowance defer before paid provider use", async () => {
  const calls = embed.mock.calls.length;
  const debits = debit.mock.calls.length;
  attribution = { kind: "unknown" };
  expect((await worker().indexKnowledge()).deferred).toBe(1);
  attribution = { kind: "human", initiatingHumanSubjectId: "human:root" };
  refusal = { message: "Member allowance exhausted" };
  try {
    expect((await worker().indexKnowledge()).deferred).toBe(1);
    expect(embed.mock.calls.length).toBe(calls);
    expect(debit.mock.calls.length).toBe(debits);
    expect(defer).toHaveBeenCalled();
  } finally {
    refusal = null;
  }
});
