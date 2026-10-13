import { expect, test } from "bun:test";
import { NativeBrokerDiagnosticsOwner } from "../src/sandbox/providers/native-command-broker-diagnostics-owner";
import {
  NativeBrokerInitialDiagnosticsError,
  type NativeBrokerDiagnosticsChannel,
  type NativeBrokerDiagnosticsFault,
  type NativeBrokerDiagnosticsPage,
} from "../src/sandbox/providers/native-command-broker-diagnostics";
import {
  initialNativeBrokerTransportState,
  type DurableNativeBrokerTransport,
} from "../src/sandbox/providers/native-command-broker-transport";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function abortable(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function fixture() {
  const identity = {
    brokerId: crypto.randomUUID(),
    sandboxId: "sb-original",
    taskId: "ta-original",
  };
  const state = initialNativeBrokerTransportState(identity);
  let fault: NativeBrokerDiagnosticsFault | null = null;
  let queries = 0,
    active = 0,
    maxActive = 0,
    commits = 0;
  let observe: (signal: AbortSignal) => Promise<NativeBrokerDiagnosticsPage[]> = async () => [];
  let beforeCommit: () => Promise<void> = async () => {};
  const journal = {
    read: async () => state,
    diagnosticFault: async () => fault,
    recordDiagnosticFault: async (value: NativeBrokerDiagnosticsFault) => {
      await beforeCommit();
      commits++;
      return (fault ??= value);
    },
  } as unknown as DurableNativeBrokerTransport;
  const channel: NativeBrokerDiagnosticsChannel = {
    ...identity,
    async *diagnostics(cursor, signal) {
      expect(cursor).toBe("0-0");
      expect(signal).toBeInstanceOf(AbortSignal);
      queries++;
      maxActive = Math.max(maxActive, ++active);
      try {
        yield* await observe(signal!);
      } finally {
        active--;
      }
    },
  };
  const owner = new NativeBrokerDiagnosticsOwner(journal, channel);
  const diagnostic = (): NativeBrokerDiagnosticsPage => ({
    sandboxId: identity.sandboxId,
    taskId: identity.taskId,
    requestedFileDescriptor: 2,
    entryId: "1-0",
    eof: false,
    items: [{ fileDescriptor: 2, data: "later initial-process failure" }],
  });
  return {
    owner,
    diagnostic,
    journal,
    channel,
    observe: (fn: typeof observe) => {
      observe = fn;
    },
    beforeCommit: (fn: typeof beforeCommit) => {
      beforeCommit = fn;
    },
    counts: () => ({ queries, active, maxActive, commits }),
  };
}

test("overlapping checks share one query; aborting one waiter preserves its sibling", async () => {
  const f = fixture(),
    entered = deferred(),
    finish = deferred();
  let aborted = false;
  f.observe(async (signal) => {
    signal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    entered.resolve();
    await finish.promise;
    return [];
  });
  expect(f.counts().queries).toBe(0);
  const cancel = new AbortController();
  const first = f.owner.check(cancel.signal).catch((error) => error);
  const second = f.owner.check();
  await entered.promise;
  cancel.abort(new Error("first waiter stopped"));
  expect((await first).message).toBe("first waiter stopped");
  expect(aborted).toBe(false);
  finish.resolve();
  await second;
  await f.owner.close();
  expect(f.counts()).toEqual({ queries: 1, active: 0, maxActive: 1, commits: 0 });
});

test("last release joins the original query and a replacement owner never overlaps it", async () => {
  const f = fixture(),
    entered = deferred(),
    aborted = deferred(),
    cleanup = deferred();
  let first = true;
  f.observe(async (signal) => {
    if (!first) return [];
    first = false;
    entered.resolve();
    try {
      await abortable(signal);
    } finally {
      aborted.resolve();
      await cleanup.promise;
    }
    return [];
  });
  const release = f.owner.acquire();
  await entered.promise;
  let released = false;
  const joined = release().then(() => {
    released = true;
  });
  const duplicate = release();
  await aborted.promise;
  const replacement = f.owner.check();
  expect(released).toBe(false);
  expect(f.counts().queries).toBe(1);
  cleanup.resolve();
  await Promise.all([joined, duplicate, replacement]);
  await f.owner.close();
  expect(f.counts()).toEqual({ queries: 2, active: 0, maxActive: 1, commits: 0 });
});

test("diagnostic waiters are bounded before joining the input queue", async () => {
  const f = fixture(),
    entered = deferred(),
    finish = deferred();
  f.observe(async () => {
    entered.resolve();
    await finish.promise;
    return [];
  });
  const checks = Array.from({ length: 128 }, () => f.owner.check());
  await entered.promise;
  await expect(f.owner.check()).rejects.toThrow("queue is full");
  expect(f.counts().queries).toBe(1);
  finish.resolve();
  await Promise.all(checks);
  await f.owner.check();
  await f.owner.close();
  expect(f.counts().maxActive).toBe(1);
  expect(f.counts().active).toBe(0);
});

test("attached ownership observes a later fault without input and commits it before rejecting work", async () => {
  const f = fixture(),
    first = deferred(),
    committing = deferred(),
    committed = deferred();
  let reads = 0;
  f.observe(async () => {
    if (++reads === 1) {
      first.resolve();
      return [];
    }
    return [f.diagnostic()];
  });
  f.beforeCommit(async () => {
    committing.resolve();
    await committed.promise;
  });
  const release = f.owner.acquire();
  await first.promise;
  await committing.promise; // The paced live loop, not a work check, reads again.
  let rejected = false;
  const work = f.owner.check().catch((error) => {
    rejected = true;
    return error;
  });
  expect(rejected).toBe(false);
  expect(await f.journal.diagnosticFault()).toBeNull();
  committed.resolve();
  expect(await work).toBeInstanceOf(NativeBrokerInitialDiagnosticsError);
  expect((await f.journal.diagnosticFault())?.reason).toBe("diagnostics");
  const count = f.counts().queries;
  await expect(f.owner.check()).rejects.toThrow("diagnostics");
  expect(f.counts().queries).toBe(count);
  await release();
  await f.owner.close();
  expect(f.counts().active).toBe(0);
}, 10_000);

test("query uncertainty refuses that work, records no fault and never reuses old clean success", async () => {
  const f = fixture();
  const release = f.owner.acquire();
  await f.owner.check();
  const original = new Error("diagnostic transport unavailable");
  f.observe(async () => {
    throw original;
  });
  await expect(f.owner.check()).rejects.toBe(original);
  expect(await f.journal.diagnosticFault()).toBeNull();
  f.observe(async () => []);
  await f.owner.check();
  expect(f.counts().queries).toBe(3);
  await release();
  await f.owner.close();
});

test("failed fault retention cannot turn the observation into a clean work check", async () => {
  const f = fixture();
  f.observe(async () => [f.diagnostic()]);
  f.beforeCommit(async () => {
    throw new Error("fault commit unavailable");
  });
  await expect(f.owner.check()).rejects.toThrow("fault commit unavailable");
  expect(await f.journal.diagnosticFault()).toBeNull();
  f.beforeCommit(async () => {});
  await expect(f.owner.check()).rejects.toThrow("diagnostics");
  expect((await f.journal.diagnosticFault())?.reason).toBe("diagnostics");
  await f.owner.close();
});

test("close aborts and joins its provider query and refuses all future ownership", async () => {
  const f = fixture(),
    entered = deferred(),
    aborted = deferred(),
    cleanup = deferred();
  f.observe(async (signal) => {
    entered.resolve();
    try {
      await abortable(signal);
    } finally {
      aborted.resolve();
      await cleanup.promise;
    }
    return [];
  });
  const release = f.owner.acquire();
  await entered.promise;
  let closed = false;
  const close = f.owner.close().then(() => {
    closed = true;
  });
  await aborted.promise;
  expect(closed).toBe(false);
  expect(() => f.owner.acquire()).toThrow("closed");
  await expect(f.owner.check()).rejects.toThrow("closed");
  cleanup.resolve();
  await close;
  await release();
  expect(f.counts().active).toBe(0);
});

test("a final release leaves no periodic reads behind", async () => {
  const f = fixture();
  await f.owner.check();
  expect(f.counts().queries).toBe(1);
  await Bun.sleep(1_100);
  expect(f.counts().queries).toBe(1);
  expect(f.counts().active).toBe(0);
  await f.owner.close();
}, 5_000);
