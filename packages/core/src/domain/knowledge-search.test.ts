import { afterAll, expect, mock, test } from "bun:test";
import type { Settings } from "@opengeni/config";
const list = mock(
  async (_db: unknown, _context: unknown, _request: unknown, _embedding?: unknown) => {
    if (failNextRetrieval) {
      failNextRetrieval = false;
      throw new Error("retrieval unavailable");
    }
    return { entries: [], nextCursor: null };
  },
);
let balance = 0;
let usedChunks = 0;
let queryRateBytes = 0;
let queryRateMicros = 0;
let failNextRetrieval = false;
let failSettlement = false;
const debits = mock(async (_db: unknown, input: { amountMicros: number }) => {
  if (failSettlement) throw new Error("settlement unavailable");
  balance -= input.amountMicros;
  return { balance: { balanceMicros: balance }, debitedMicros: input.amountMicros };
});
const usage = mock(
  async (_db: unknown, _input: { quantity: number; eventType: string }) => undefined,
);
mock.module("@opengeni/db", () => ({
  listKnowledgeEntries: list,
  getBillingBalance: async () => ({ balanceMicros: balance }),
  applyCreditDebitAfterUse: debits,
  recordUsageEvent: usage,
  withKnowledgeQueryAccountLock: async (
    _db: unknown,
    _account: unknown,
    _workspace: unknown,
    fn: (db: unknown) => Promise<unknown>,
  ) => fn(_db),
  isCodexBilledTurn: async () => false,
  sumUsageQuantity: async (_db: unknown, input: { eventType: string }) =>
    input.eventType === "document.query_embedding_bytes"
      ? queryRateBytes
      : input.eventType === "document.query_embedding_cost"
        ? queryRateMicros
        : usedChunks,
  countScheduledTasksForWorkspace: async () => 0,
  countWorkspacesForAccount: async () => 0,
  countActiveApiKeysForWorkspace: async () => 0,
  countActiveOrganizationApiKeysForAccount: async () => 0,
}));
const { searchKnowledgeEntries } = await import("./knowledge-search");
const { checkLimit } = await import("../billing/limits");
afterAll(() => mock.restore());
const unavailable = () => {
  throw new Error("embedding unavailable");
};
test("hybrid fallback keeps lexical recall and passes the exact scope and cursor", async () => {
  const result = await searchKnowledgeEntries(
    {} as never,
    {} as never,
    {
      query: "Acme renewal renew contract expiration renewal date",
      scope: "workspace",
      cursor: "page-2",
    },
    unavailable,
  );
  expect(result.searchMode).toBe("keyword");
  expect(result.fallbackReason).toBe("provider_unavailable");
  expect(list.mock.calls.at(-1)?.[2]).toMatchObject({
    query: '"Acme" OR "renewal" OR "renew" OR "contract" OR "expiration" OR "date"',
    mode: "keyword",
    scope: "workspace",
    cursor: "page-2",
  });
});
test("keyword and explicit search syntax remain unchanged", async () => {
  for (const query of ['"Acme renewal"', "Acme -expired", "Acme OR renewal"]) {
    await searchKnowledgeEntries({} as never, {} as never, { query }, unavailable);
    expect(list.mock.calls.at(-1)?.[2]).toMatchObject({ query });
  }
  await searchKnowledgeEntries(
    {} as never,
    {} as never,
    { query: "Acme renewal", mode: "keyword" },
    unavailable,
  );
  expect(list.mock.calls.at(-1)?.[2]).toMatchObject({ query: "Acme renewal", mode: "keyword" });
});

test("paid vector queries check funding, debit post-use, and preserve hybrid keyword fallback", async () => {
  const settings = {
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  const context = { accountId: "account", workspaceId: "workspace" } as never;
  let embedded = 0;
  const provider = () =>
    ({
      model: "test",
      dimensions: 3,
      embedQuery: async () => {
        embedded++;
        return [1, 0, 0];
      },
    }) as never;
  balance = 0;
  const unfunded = await searchKnowledgeEntries(
    {} as never,
    context,
    { query: "paid" },
    provider,
    settings,
  );
  expect(unfunded.searchMode).toBe("keyword");
  expect(unfunded.fallbackReason).toBe("awaiting_funding");
  await expect(
    searchKnowledgeEntries(
      {} as never,
      context,
      { query: "paid", mode: "vector" },
      provider,
      settings,
    ),
  ).rejects.toMatchObject({ code: "knowledge_vector_funding_required" });
  expect(embedded).toBe(0);
  balance = 1;
  const paid = await searchKnowledgeEntries(
    {} as never,
    context,
    { query: "paid", mode: "vector" },
    provider,
    settings,
  );
  expect(paid.searchMode).toBe("vector");
  expect(embedded).toBe(1);
  expect(debits.mock.calls.at(-1)?.[1]).toMatchObject({
    amountMicros: 4,
    sourceType: "knowledge_query",
  });
  expect(balance).toBe(-3);
  const priorUsage = usage.mock.calls.length;
  await searchKnowledgeEntries(
    {} as never,
    context,
    { query: "paid", mode: "keyword" },
    provider,
    settings,
  );
  expect(embedded).toBe(1);
  expect(usage.mock.calls.length).toBe(priorUsage);
});

test("shadow query usage meters bytes without checking or consuming credits", async () => {
  const settings = {
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "shadow",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  balance = 0;
  const before = debits.mock.calls.length;
  const found = await searchKnowledgeEntries(
    {} as never,
    { accountId: "account", workspaceId: "workspace" } as never,
    { query: "é", mode: "vector" },
    () => ({ model: "test", dimensions: 3, embedQuery: async () => [1, 0, 0] }) as never,
    settings,
  );
  expect(found.searchMode).toBe("vector");
  expect(usage.mock.calls.at(-1)?.[1]).toMatchObject({
    quantity: 2,
    eventType: "document.query_embedding_bytes",
  });
  expect(debits.mock.calls.length).toBe(before);
});

test("paid query does not debit when vector retrieval fails after embedding", async () => {
  const settings = {
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  balance = 1;
  const debitsBefore = debits.mock.calls.length;
  failNextRetrieval = true;
  await expect(
    searchKnowledgeEntries(
      {} as never,
      { accountId: "account", workspaceId: "workspace" } as never,
      { query: "paid", mode: "vector" },
      () => ({ model: "test", dimensions: 3, embedQuery: async () => [1, 0, 0] }) as never,
      settings,
    ),
  ).rejects.toThrow("retrieval unavailable");
  expect(debits.mock.calls.length).toBe(debitsBefore);
});

test("paid semantic pagination fails closed before provider use", async () => {
  let embedded = 0;
  const before = debits.mock.calls.length;
  await expect(
    searchKnowledgeEntries(
      {} as never,
      { accountId: "account", workspaceId: "workspace" } as never,
      { query: "paid", mode: "vector", cursor: "next-page" },
      () =>
        ({
          model: "test",
          dimensions: 3,
          embedQuery: async () => {
            embedded++;
            return [1, 0, 0];
          },
        }) as never,
      {
        documentEmbeddingProvider: "openai",
        documentEmbeddingBillingMode: "credits",
        documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
      } as Settings,
    ),
  ).rejects.toThrow("pagination is unavailable");
  expect(embedded).toBe(0);
  expect(debits.mock.calls.length).toBe(before);
});

test("paid query rate ceiling falls back for hybrid and rejects vector without using the provider", async () => {
  queryRateBytes = 64 * 1024;
  balance = 1;
  let embedded = 0;
  const provider = () =>
    ({
      model: "test",
      dimensions: 3,
      embedQuery: async () => {
        embedded++;
        return [1, 0, 0];
      },
    }) as never;
  const settings = {
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  try {
    expect(
      (
        await searchKnowledgeEntries(
          {} as never,
          { accountId: "account", workspaceId: "workspace" } as never,
          { query: "paid" },
          provider,
          settings,
        )
      ).searchMode,
    ).toBe("keyword");
    await expect(
      searchKnowledgeEntries(
        {} as never,
        { accountId: "account", workspaceId: "workspace" } as never,
        { query: "paid", mode: "vector" },
        provider,
        settings,
      ),
    ).rejects.toThrow("rate limit reached");
    expect(embedded).toBe(0);
  } finally {
    queryRateBytes = 0;
  }
});

test("paid micro-cost ceiling blocks repeated tiny queries before embedding", async () => {
  balance = 1;
  queryRateMicros = 10_000;
  let embedded = 0;
  try {
    const result = await searchKnowledgeEntries(
      {} as never,
      { accountId: "account", workspaceId: "workspace" } as never,
      { query: "tiny" },
      () =>
        ({
          model: "test",
          dimensions: 3,
          embedQuery: async () => {
            embedded++;
            return [1, 0, 0];
          },
        }) as never,
      {
        documentEmbeddingProvider: "openai",
        documentEmbeddingBillingMode: "credits",
        documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
      } as Settings,
    );
    expect(result.searchMode).toBe("keyword");
    expect(embedded).toBe(0);
  } finally {
    queryRateMicros = 0;
  }
});

test("paid settlement failure propagates without a fallback", async () => {
  balance = 1;
  failSettlement = true;
  const before = list.mock.calls.length;
  try {
    await expect(
      searchKnowledgeEntries(
        {} as never,
        { accountId: "account", workspaceId: "workspace" } as never,
        { query: "paid" },
        () => ({ model: "test", dimensions: 3, embedQuery: async () => [1, 0, 0] }) as never,
        {
          documentEmbeddingProvider: "openai",
          documentEmbeddingBillingMode: "credits",
          documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
        } as Settings,
      ),
    ).rejects.toThrow("settlement unavailable");
    expect(list.mock.calls.length).toBe(before + 1);
  } finally {
    failSettlement = false;
  }
});

test("deterministic embeddings remain unpriced even with credits mode selected", async () => {
  balance = 0;
  const before = debits.mock.calls.length;
  const found = await searchKnowledgeEntries(
    {} as never,
    { accountId: "account", workspaceId: "workspace" } as never,
    { query: "local", mode: "vector" },
    () => ({ model: "local", dimensions: 3, embedQuery: async () => [1, 0, 0] }) as never,
    {
      documentEmbeddingProvider: "deterministic",
      documentEmbeddingBillingMode: "credits",
      documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
    } as Settings,
  );
  expect(found.searchMode).toBe("vector");
  expect(debits.mock.calls.length).toBe(before);
});

test("unpriced document source admission ignores zero credits but preserves the monthly chunk quota", async () => {
  balance = 0;
  usedChunks = 1;
  const deps = {
    db: {} as never,
    settings: {
      billingMode: "stripe",
      usageLimitsMode: "static",
      staticUsageLimitsJson: JSON.stringify({ maxDocumentIndexedChunksPerWorkspace: 2 }),
    } as Settings,
  };
  expect(
    await checkLimit(deps, {
      accountId: "account",
      workspaceId: "workspace",
      action: "document:index",
      quantity: 0,
    }),
  ).toMatchObject({ allowed: true });
  usedChunks = 2;
  expect(
    await checkLimit(deps, {
      accountId: "account",
      workspaceId: "workspace",
      action: "document:index",
      quantity: 1,
    }),
  ).toMatchObject({ allowed: false, code: "max_document_indexed_chunks_per_workspace" });
});
