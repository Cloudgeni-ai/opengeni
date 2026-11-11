import { afterAll, expect, mock, test } from "bun:test";

const realDb = await import("@opengeni/db");
// mock.module is process-wide and survives mock.restore(), so the replacement
// only intercepts this file's fake database; later files in the same worker
// process keep writing real history.
const realDbFns = {
  appendSessionHistoryItems: realDb.appendSessionHistoryItems,
  appendSessionHistoryItemsInTransaction: realDb.appendSessionHistoryItemsInTransaction,
  upsertSandboxSessionEnvelope: realDb.upsertSandboxSessionEnvelope,
};
const fakeDb = {};
const fakeTx = { transaction: async (work: (tx: unknown) => Promise<unknown>) => work(fakeTx) };
const appendInTransaction = mock(async (_input: { items: Array<{ position: number }> }) => ({
  jsonBytes: 10,
  rows: 1,
  jsonNodes: 1,
  jsonProperties: 1,
}));
const append = mock(async (_db: unknown, _input: { items: Array<{ position: number }> }) => true);
mock.module("@opengeni/db", () => ({
  ...realDb,
  appendSessionHistoryItemsInTransaction: (
    tx: Parameters<typeof realDbFns.appendSessionHistoryItemsInTransaction>[0],
    input: Parameters<typeof realDbFns.appendSessionHistoryItemsInTransaction>[1],
    fence: Parameters<typeof realDbFns.appendSessionHistoryItemsInTransaction>[2],
  ) =>
    tx === fakeTx
      ? appendInTransaction(input)
      : realDbFns.appendSessionHistoryItemsInTransaction(tx, input, fence),
  appendSessionHistoryItems: (
    db: unknown,
    input: Parameters<typeof realDbFns.appendSessionHistoryItems>[1],
  ) =>
    db === fakeDb
      ? append(db, input)
      : realDbFns.appendSessionHistoryItems(
          db as Parameters<typeof realDbFns.appendSessionHistoryItems>[0],
          input,
        ),
  upsertSandboxSessionEnvelope: async (
    db: unknown,
    input: Parameters<typeof realDbFns.upsertSandboxSessionEnvelope>[1],
  ) =>
    db === fakeDb
      ? undefined
      : await realDbFns.upsertSandboxSessionEnvelope(
          db as Parameters<typeof realDbFns.upsertSandboxSessionEnvelope>[0],
          input,
        ),
}));
const { createTurnHistorySink } = await import("../src/activities/agent-turn/history-sink");
type Deps = import("../src/activities/agent-turn/history-sink").TurnHistorySinkDeps;
afterAll(() => mock.restore());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const state = { history: [{ type: "message", role: "user", content: "start" }] };
  const sink = createTurnHistorySink({
    db: fakeDb,
    accountId: "account",
    workspaceId: "workspace",
    sessionId: "session",
    attemptId: "attempt",
    getTurnId: () => "turn",
    getExecutionGeneration: () => 1,
    getStream: () => ({ state }),
    getModelRunSettings: () => ({}),
    media: {
      retainNativeGeneratedImagesFromHistory: async () => {},
      retainedScreenshotReceiptsByCallId: new Map(),
      generatedImageReceiptsByProviderItemId: new Map(),
    },
  } as unknown as Deps);
  sink.seedHistory([], 0);
  return { sink, state };
}

test("overlapping stream and provider checkpoints append each position once", async () => {
  append.mockClear();
  const entered = deferred();
  const release = deferred();
  append.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  const { sink, state } = fixture();
  const first = sink.reconcileConversationTruth({ requireDurable: true });
  await entered.promise;
  state.history = [...state.history, { type: "message", role: "assistant", content: "answer" }];
  const second = sink.reconcileConversationTruth({ requireDurable: true });
  // Let both callers reach any asynchronous retention/write boundary.
  await new Promise<void>((resolve) => setImmediate(resolve));
  release.resolve();
  await Promise.all([first, second]);
  expect(append.mock.calls.map((call) => call[1].items.map((row) => row.position))).toEqual([
    [0],
    [1],
  ]);
  expect(sink.persistedHistoryCount).toBe(2);
  expect(sink.nextHistoryPosition).toBe(2);
});

test("a combined checkpoint acknowledges history only after the outer commit succeeds", async () => {
  appendInTransaction.mockClear();
  const { sink } = fixture();
  await expect(
    sink.reconcileConversationTruth({
      requireDurable: true,
      persist: async (history) => {
        await history(fakeTx as never, { allowed: true } as never);
        throw new Error("commit acknowledgement failed");
      },
    }),
  ).rejects.toThrow();
  expect(sink.persistedHistoryCount).toBe(0);
  expect(sink.nextHistoryPosition).toBe(0);
  await sink.reconcileConversationTruth({
    requireDurable: true,
    persist: async (history) => {
      await history(fakeTx as never, { allowed: true } as never);
      return true;
    },
  });
  expect(
    appendInTransaction.mock.calls.map(([input]) => input.items.map((row) => row.position)),
  ).toEqual([[0], [0]]);
  expect(sink.persistedHistoryCount).toBe(1);
});

test("an audit-only duplicate cannot acknowledge an unapplied prepared history", async () => {
  const { sink } = fixture();
  await sink.reconcileConversationTruth({ requireDurable: true, persist: async () => false });
  expect(sink.persistedHistoryCount).toBe(0);
  expect(sink.nextHistoryPosition).toBe(0);
});

test("history SQL failure preserves the outer result commit but cannot advance the watermark", async () => {
  appendInTransaction.mockImplementationOnce(async () => {
    throw new Error("history SQL failure");
  });
  const { sink } = fixture();
  let committed = false;
  await expect(
    sink.reconcileConversationTruth({
      requireDurable: true,
      persist: async (history) => {
        await history(fakeTx as never, { allowed: true } as never);
        committed = true;
        return true;
      },
    }),
  ).rejects.toThrow();
  expect(committed).toBe(true);
  expect(sink.persistedHistoryCount).toBe(0);
});

test("prefix failure still commits the result without acknowledging the changed history", async () => {
  const { sink, state } = fixture();
  sink.seedHistory(state.history, 1);
  state.history = [{ type: "message", role: "user", content: "changed" }];
  let committed = false;
  await expect(
    sink.reconcileConversationTruth({
      requireDurable: true,
      persist: async (history) => {
        expect(await history(fakeTx as never, { allowed: true } as never)).toBe(true);
        committed = true;
        return true;
      },
    }),
  ).rejects.toThrow();
  expect(committed).toBe(true);
  expect(sink.persistedHistoryCount).toBe(1);
});

test("a failed checkpoint does not poison a queued durable checkpoint", async () => {
  append.mockClear();
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  append.mockImplementation(async () => {
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
      throw new Error("synthetic storage failure");
    }
    return true;
  });
  const { sink } = fixture();
  const first = sink.reconcileConversationTruth({ requireDurable: true });
  const failure = first.catch((error: unknown) => error);
  await entered.promise;
  const second = sink.reconcileConversationTruth({ requireDurable: true });
  release.resolve();
  expect(await failure).toBeInstanceOf(Error);
  await second;
  expect(sink.persistedHistoryCount).toBe(1);
  expect(append).toHaveBeenCalledTimes(2);
});

test("identical queued checkpoints do not retry an already acknowledged append", async () => {
  append.mockClear();
  append.mockImplementation(async () => true);
  const { sink } = fixture();
  await Promise.all([
    sink.reconcileConversationTruth(),
    sink.reconcileConversationTruth({ requireDurable: true }),
    sink.reconcileConversationTruth({ requireDurable: true }),
  ]);
  expect(append).toHaveBeenCalledTimes(1);
  expect(sink.nextHistoryPosition).toBe(1);
});

test("a skipped input-only checkpoint cannot satisfy a queued durable checkpoint", async () => {
  append.mockClear();
  append.mockImplementation(async () => true);
  const { sink } = fixture();
  await Promise.all([
    sink.reconcileConversationTruth({ skipInputOnlyRows: true }),
    sink.reconcileConversationTruth({ requireDurable: true }),
  ]);
  expect(append).toHaveBeenCalledTimes(1);
  expect(sink.persistedHistoryCount).toBe(1);
});

test("queued checkpoints verify the newly acknowledged prefix before writing", async () => {
  append.mockClear();
  const entered = deferred();
  const release = deferred();
  append.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  const { sink, state } = fixture();
  const first = sink.reconcileConversationTruth({ requireDurable: true });
  await entered.promise;
  state.history = [{ type: "message", role: "user", content: "changed" }];
  const second = sink.reconcileConversationTruth({ requireDurable: true });
  const failure = second.catch((error: unknown) => error);
  release.resolve();
  await first;
  expect(await failure).toBeInstanceOf(Error);
  expect(append).toHaveBeenCalledTimes(1);
});
