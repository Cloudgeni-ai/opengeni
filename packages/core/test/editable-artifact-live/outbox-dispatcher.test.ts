import { describe, expect, test } from "bun:test";
import {
  editableArtifactId,
  editableArtifactOutboxId,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
  editableArtifactTransactionId,
  type EditableArtifactLiveOutboxRecord,
} from "../../src/domain/editable-artifacts/types";
import {
  EditableArtifactHintEncodingError,
  EditableArtifactLiveOutboxDispatcher,
  SystemEditableArtifactLiveScheduler,
  editableArtifactLiveHintSubject,
  encodeEditableArtifactBrokerHint,
  type EditableArtifactHintBrokerPort,
  type EditableArtifactLiveSchedulerPort,
  type EditableArtifactOutboxDeadLetterErrorCode,
  type EditableArtifactOutboxDispatcherStorePort,
  type EditableArtifactOutboxMetricOutcome,
  type EditableArtifactOutboxMetricsPort,
  type EditableArtifactOutboxRetryErrorCode,
} from "../../src/editable-artifact-live";

const scope = Object.freeze({
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
});
const artifactId = editableArtifactId("00000000000000010000000000000001");
const scheduler = new SystemEditableArtifactLiveScheduler();

describe("editable artifact live outbox dispatcher", () => {
  test("publishes only a compact durable-head hint and marks after broker ACK", async () => {
    const clock = new MutableClock();
    const store = new MemoryOutboxStore(clock, [transactionRecord(1)]);
    const broker = new TestBroker(store.trace);
    const metrics = new TestMetrics();
    const dispatcher = createDispatcher(store, broker, clock, metrics);

    const summary = await dispatcher.dispatchOnce();

    expect(summary).toMatchObject({ claimed: 1, published: 1, retried: 0 });
    expect(store.state(1)).toBe("published");
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]!.subject).toBe(editableArtifactLiveHintSubject(scope, artifactId));
    const payload = decodePayload(broker.calls[0]!.payload);
    expect(payload).toEqual({
      kind: "head_advanced",
      schemaVersion: 1,
      modality: "spreadsheet",
      scope,
      artifactId,
      headSequence: 1,
      stateHash: hash(1),
      operationProtocolVersion: 1,
    });
    expect(JSON.stringify(payload)).not.toContain("causalFrontier");
    expect(JSON.stringify(payload)).not.toContain("operationBytes");
    expect(store.trace.indexOf("broker:ack:1")).toBeGreaterThanOrEqual(0);
    expect(store.trace.indexOf("broker:ack:1")).toBeLessThan(store.trace.indexOf("mark:1"));
    expect(metrics.counts.get("published")).toBe(1);
  });

  test("duplicates safely after crash-equivalent mark failure", async () => {
    const clock = new MutableClock();
    const store = new MemoryOutboxStore(clock, [transactionRecord(1)]);
    store.failMarks = 1;
    const broker = new TestBroker(store.trace);
    const first = createDispatcher(store, broker, clock);

    expect(await first.dispatchOnce()).toMatchObject({
      published: 0,
      markFailed: 1,
    });
    expect(broker.calls).toHaveLength(1);
    expect(store.state(1)).toBe("publishing");

    clock.advance(30_001);
    const second = createDispatcher(store, broker, clock, undefined, "dispatcher-b");
    expect(await second.dispatchOnce()).toMatchObject({ published: 1 });
    expect(broker.calls).toHaveLength(2);
    expect(store.state(1)).toBe("published");
  });

  test("recovers on a later pass after the dispatcher DB connection reconnects", async () => {
    const clock = new MutableClock();
    const store = new MemoryOutboxStore(clock, [transactionRecord(1)]);
    store.failClaims = 1;
    const broker = new TestBroker();
    const dispatcher = createDispatcher(store, broker, clock);

    expect(await dispatcher.dispatchOnce()).toMatchObject({
      claimFailed: true,
      claimed: 0,
    });
    expect(await dispatcher.dispatchOnce()).toMatchObject({
      claimFailed: false,
      published: 1,
    });
    expect(broker.calls).toHaveLength(1);
  });

  test("isolates poison and broker backpressure without blocking the batch", async () => {
    const clock = new MutableClock();
    const poison = {
      ...transactionRecord(1),
      event: { ...transactionRecord(1).event, schemaVersion: 2 },
    } as unknown as EditableArtifactLiveOutboxRecord;
    const store = new MemoryOutboxStore(clock, [
      poison,
      transactionRecord(2),
      transactionRecord(3),
    ]);
    const broker = new TestBroker();
    broker.failHeadSequence.set(2, "broker_backpressure");
    const dispatcher = createDispatcher(store, broker, clock, undefined, "dispatcher-a", {
      concurrency: 1,
    });

    const summary = await dispatcher.dispatchOnce();

    expect(summary).toMatchObject({
      claimed: 3,
      deadLettered: 1,
      retried: 1,
      published: 1,
    });
    expect(store.state(1)).toBe("dead_lettered");
    expect(store.state(2)).toBe("pending");
    expect(store.errorCode(2)).toBe("broker_backpressure");
    expect(store.state(3)).toBe("published");
  });

  test("atomically splits claims across multiple dispatchers", async () => {
    const clock = new MutableClock();
    const records = Array.from({ length: 12 }, (_, index) => transactionRecord(index + 1));
    const store = new MemoryOutboxStore(clock, records);
    const broker = new TestBroker();
    const first = createDispatcher(store, broker, clock, undefined, "dispatcher-a", {
      batchSize: 6,
      concurrency: 3,
    });
    const second = createDispatcher(store, broker, clock, undefined, "dispatcher-b", {
      batchSize: 6,
      concurrency: 3,
    });

    const summaries = await Promise.all([first.dispatchOnce(), second.dispatchOnce()]);

    expect(summaries.map((summary) => summary.claimed).sort()).toEqual([6, 6]);
    expect(broker.calls).toHaveLength(12);
    expect(new Set(broker.calls.map((call) => decodePayload(call.payload).headSequence)).size).toBe(
      12,
    );
    expect(records.every((_, index) => store.state(index + 1) === "published")).toBe(true);
  });

  test("graceful shutdown drains the bounded active batch without claiming more", async () => {
    const clock = new MutableClock();
    const store = new MemoryOutboxStore(clock, [transactionRecord(1), transactionRecord(2)]);
    const broker = new TestBroker();
    const gate = deferred<void>();
    broker.gate = gate.promise;
    const dispatcher = createDispatcher(store, broker, clock, undefined, "dispatcher-a", {
      batchSize: 1,
      concurrency: 1,
    });
    const abort = new AbortController();
    let settled = false;
    const running = dispatcher.run(abort.signal).finally(() => {
      settled = true;
    });
    await until(() => broker.calls.length === 1);

    abort.abort();
    await flushTurns();
    expect(settled).toBe(false);
    gate.resolve();
    await running;

    expect(store.state(1)).toBe("published");
    expect(store.state(2)).toBe("pending");
  });

  test("renews a live lease while waiting for broker acknowledgement", async () => {
    const clock = new MutableClock();
    const manualScheduler = new ManualScheduler(clock);
    const store = new MemoryOutboxStore(clock, [transactionRecord(1)]);
    const broker = new TestBroker();
    const gate = deferred<void>();
    broker.gate = gate.promise;
    const dispatcher = createDispatcher(
      store,
      broker,
      clock,
      undefined,
      "dispatcher-a",
      {
        leaseDurationMs: 5_000,
        leaseRenewIntervalMs: 1_000,
        publishTimeoutMs: 4_000,
      },
      manualScheduler,
    );
    const dispatching = dispatcher.dispatchOnce();
    await until(() => broker.calls.length === 1);

    await manualScheduler.advance(1_000);
    expect(store.trace).toContain("renew:1");
    gate.resolve();

    expect(await dispatching).toMatchObject({ published: 1, leaseLost: 0 });
    expect(store.trace.filter((entry) => entry === "renew:1")).toHaveLength(2);
  });

  test("permanently dead-letters a hint that exceeds the broker envelope", async () => {
    const clock = new MutableClock();
    const store = new MemoryOutboxStore(clock, [transactionRecord(1)]);
    const broker = new TestBroker();
    const dispatcher = createDispatcher(store, broker, clock, undefined, "dispatcher-a", {
      maxHintBytes: 64,
    });

    expect(await dispatcher.dispatchOnce()).toMatchObject({
      deadLettered: 1,
      published: 0,
    });
    expect(store.errorCode(1)).toBe("oversized_hint");
    expect(broker.calls).toHaveLength(0);
  });

  test("snapshot projection carries only replay-discovery metadata", () => {
    const encoded = encodeEditableArtifactBrokerHint(snapshotRecord(1));
    expect(decodePayload(encoded.payload)).toEqual({
      kind: "snapshot_available",
      schemaVersion: 1,
      modality: "spreadsheet",
      scope,
      artifactId,
      headSequence: 1,
      stateHash: hash(1),
      snapshotId: editableArtifactSnapshotId("00000000000000030000000000000001"),
      operationProtocolVersion: 1,
    });
    expect(() => encodeEditableArtifactBrokerHint(snapshotRecord(1), 32)).toThrow(
      EditableArtifactHintEncodingError,
    );
  });
});

function createDispatcher(
  store: MemoryOutboxStore,
  broker: TestBroker,
  clock: MutableClock,
  metrics?: TestMetrics,
  owner = "dispatcher-a",
  options: Partial<ConstructorParameters<typeof EditableArtifactLiveOutboxDispatcher>[1]> = {},
  schedulerOverride: EditableArtifactLiveSchedulerPort = scheduler,
) {
  return new EditableArtifactLiveOutboxDispatcher(
    {
      store,
      broker,
      clock,
      scheduler: schedulerOverride,
      random: { unit: () => 0 },
      ...(metrics ? { metrics } : {}),
    },
    {
      owner,
      batchSize: 16,
      concurrency: 4,
      ...options,
    },
  );
}

type InternalRecord = EditableArtifactLiveOutboxRecord & {
  state: "pending" | "publishing" | "published" | "dead_lettered";
  nextAttemptAt: number;
  lastErrorCode: string | null;
};

class MemoryOutboxStore implements EditableArtifactOutboxDispatcherStorePort {
  readonly trace: string[];
  private readonly records = new Map<string, InternalRecord>();
  failClaims = 0;
  failMarks = 0;

  constructor(
    private readonly clock: MutableClock,
    records: readonly EditableArtifactLiveOutboxRecord[],
    trace: string[] = [],
  ) {
    this.trace = trace;
    for (const record of records) {
      this.records.set(record.outboxId, {
        ...record,
        nextAttemptAt: this.clock.now().getTime(),
        lastErrorCode: null,
      } as InternalRecord);
    }
  }

  async claimLiveOutbox(input: {
    owner: string;
    leaseDurationMs: number;
    limit: number;
  }): Promise<readonly EditableArtifactLiveOutboxRecord[]> {
    if (this.failClaims > 0) {
      this.failClaims -= 1;
      throw new Error("database reconnecting");
    }
    const now = this.clock.now().getTime();
    const claimed: EditableArtifactLiveOutboxRecord[] = [];
    for (const [id, record] of this.records) {
      if (claimed.length >= input.limit) break;
      const leaseExpired =
        record.state === "publishing" && Date.parse(record.leaseExpiresAt ?? "") <= now;
      if (!(record.state === "pending" && record.nextAttemptAt <= now) && !leaseExpired) continue;
      const next = {
        ...record,
        state: "publishing" as const,
        attemptCount: record.attemptCount + 1,
        leaseOwner: input.owner,
        leaseExpiresAt: new Date(now + input.leaseDurationMs).toISOString(),
      } as InternalRecord;
      this.records.set(id, next);
      claimed.push(next);
      this.trace.push(`claim:${numericId(next)}`);
    }
    return claimed;
  }

  async renewLiveOutbox(input: {
    outboxId: ReturnType<typeof editableArtifactOutboxId>;
    owner: string;
    attemptCount: number;
    leaseDurationMs: number;
  }): Promise<void> {
    const record = this.assertLease(input);
    this.records.set(input.outboxId, {
      ...record,
      leaseExpiresAt: new Date(this.clock.now().getTime() + input.leaseDurationMs).toISOString(),
    });
    this.trace.push(`renew:${numericId(record)}`);
  }

  async markLiveOutboxPublished(input: {
    outboxId: ReturnType<typeof editableArtifactOutboxId>;
    owner: string;
    attemptCount: number;
  }): Promise<void> {
    const record = this.assertLease(input);
    if (this.failMarks > 0) {
      this.failMarks -= 1;
      throw new Error("crashed before mark commit");
    }
    this.records.set(input.outboxId, {
      ...record,
      state: "published",
      leaseOwner: null,
      leaseExpiresAt: null,
      publishedAt: this.clock.now().toISOString(),
    });
    this.trace.push(`mark:${numericId(record)}`);
  }

  async retryLiveOutbox(input: {
    outboxId: ReturnType<typeof editableArtifactOutboxId>;
    owner: string;
    attemptCount: number;
    retryDelayMs: number;
    errorCode: EditableArtifactOutboxRetryErrorCode;
  }): Promise<void> {
    const record = this.assertLease(input);
    this.records.set(input.outboxId, {
      ...record,
      state: "pending",
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: this.clock.now().getTime() + input.retryDelayMs,
      lastErrorCode: input.errorCode,
    });
    this.trace.push(`retry:${numericId(record)}`);
  }

  async deadLetterLiveOutbox(input: {
    outboxId: ReturnType<typeof editableArtifactOutboxId>;
    owner: string;
    attemptCount: number;
    errorCode: EditableArtifactOutboxDeadLetterErrorCode;
  }): Promise<void> {
    const record = this.assertLease(input);
    this.records.set(input.outboxId, {
      ...record,
      state: "dead_lettered",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: input.errorCode,
    });
    this.trace.push(`dead:${numericId(record)}`);
  }

  state(value: number): InternalRecord["state"] {
    return this.record(value).state;
  }

  errorCode(value: number): string | null {
    return this.record(value).lastErrorCode;
  }

  private assertLease(input: { outboxId: string; owner: string; attemptCount: number }) {
    const record = this.records.get(input.outboxId);
    if (
      !record ||
      record.state !== "publishing" ||
      record.leaseOwner !== input.owner ||
      record.attemptCount !== input.attemptCount ||
      Date.parse(record.leaseExpiresAt ?? "") <= this.clock.now().getTime()
    ) {
      throw new Error("outbox lease conflict");
    }
    return record;
  }

  private record(value: number): InternalRecord {
    const record = this.records.get(outboxId(value));
    if (!record) throw new Error("missing outbox fixture");
    return record;
  }
}

class TestBroker implements EditableArtifactHintBrokerPort {
  readonly calls: Array<{ subject: string; payload: Uint8Array }> = [];
  readonly failHeadSequence = new Map<number, EditableArtifactOutboxRetryErrorCode>();
  gate: Promise<void> | null = null;

  constructor(private readonly trace: string[] = []) {}

  async publish(input: {
    subject: string;
    payload: Uint8Array;
    signal: AbortSignal;
  }): Promise<void> {
    const payload = input.payload.slice();
    this.calls.push({ subject: input.subject, payload });
    const sequence = decodePayload(payload).headSequence;
    this.trace.push(`broker:publish:${sequence}`);
    const failure = this.failHeadSequence.get(sequence);
    if (failure) {
      this.failHeadSequence.delete(sequence);
      throw Object.assign(new Error(failure), { code: failure });
    }
    if (this.gate) await this.gate;
    if (input.signal.aborted) throw new Error("publish aborted");
    this.trace.push(`broker:ack:${sequence}`);
  }
}

class MutableClock {
  private milliseconds = Date.parse("2026-08-08T12:00:00.000Z");

  now(): Date {
    return new Date(this.milliseconds);
  }

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

class ManualScheduler implements EditableArtifactLiveSchedulerPort {
  private readonly waits = new Set<{
    due: number;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
  }>();

  constructor(private readonly clock: MutableClock) {}

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wait = {
        due: this.clock.now().getTime() + milliseconds,
        resolve,
        reject,
        signal,
      };
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      this.waits.add(wait);
      signal.addEventListener(
        "abort",
        () => {
          if (this.waits.delete(wait)) reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  async advance(milliseconds: number): Promise<void> {
    this.clock.advance(milliseconds);
    const now = this.clock.now().getTime();
    for (const wait of [...this.waits]) {
      if (wait.due <= now && this.waits.delete(wait)) wait.resolve();
    }
    await flushTurns(8);
  }
}

class TestMetrics implements EditableArtifactOutboxMetricsPort {
  readonly counts = new Map<EditableArtifactOutboxMetricOutcome, number>();

  increment(outcome: EditableArtifactOutboxMetricOutcome, count = 1): void {
    this.counts.set(outcome, (this.counts.get(outcome) ?? 0) + count);
  }

  observePublishSeconds(): void {}
}

function transactionRecord(value: number): EditableArtifactLiveOutboxRecord {
  return Object.freeze({
    outboxId: editableArtifactOutboxId(outboxId(value)),
    event: Object.freeze({
      kind: "transaction_committed",
      schemaVersion: 1,
      scope,
      artifactId,
      modality: "spreadsheet",
      serverTransactionId: editableArtifactTransactionId(
        `0000000000000002${value.toString(16).padStart(16, "0")}`,
      ),
      sequenceStart: value,
      sequenceEnd: value,
      stateHash: hash(value),
      operationProtocolVersion: 1,
      committedAt: "2026-08-08T12:00:00.000Z",
    }),
    state: "pending",
    attemptCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    publishedAt: null,
    createdAt: "2026-08-08T12:00:00.000Z",
  });
}

function snapshotRecord(value: number): EditableArtifactLiveOutboxRecord {
  return Object.freeze({
    ...transactionRecord(value),
    event: Object.freeze({
      kind: "snapshot_published",
      schemaVersion: 1,
      scope,
      artifactId,
      modality: "spreadsheet",
      snapshotId: editableArtifactSnapshotId(
        `0000000000000003${value.toString(16).padStart(16, "0")}`,
      ),
      coveredHeadSequence: value,
      stateHash: hash(value),
      operationProtocolVersion: 1,
      publishedAt: "2026-08-08T12:00:00.000Z",
    }),
  });
}

function hash(value: number) {
  return editableArtifactStateHash(`sha256:${value.toString(16).padStart(64, "0")}`);
}

function outboxId(value: number): string {
  return `0000000000000004${value.toString(16).padStart(16, "0")}`;
}

function numericId(record: EditableArtifactLiveOutboxRecord): number {
  return Number.parseInt(record.outboxId.slice(16), 16);
}

function decodePayload(payload: Uint8Array): Record<string, unknown> & { headSequence: number } {
  return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown> & {
    headSequence: number;
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushTurns(count = 6): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}
