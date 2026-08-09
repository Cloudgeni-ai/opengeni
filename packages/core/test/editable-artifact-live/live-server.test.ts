import { describe, expect, test } from "bun:test";
import { encodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import {
  EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES,
  hashEditableArtifactMutationIntent,
} from "@opengeni/contracts/editable-artifacts";
import type { EditableArtifactAuthorizationPort } from "../../src/domain/editable-artifacts/ports";
import type { EditableArtifactService } from "../../src/domain/editable-artifacts/service";
import {
  editableArtifactCausalFrontier,
  editableArtifactId,
  editableArtifactRequestHash,
  editableArtifactReplicaId,
  editableArtifactStateHash,
  editableArtifactTransactionId,
  type EditableArtifactActor,
  type EditableArtifactPermission,
} from "../../src/domain/editable-artifacts/types";
import {
  EditableArtifactLiveServer,
  type EditableArtifactLiveAuthorizationInvalidationPort,
  type EditableArtifactLiveBootstrap,
  type EditableArtifactLiveClockPort,
  type EditableArtifactLiveClose,
  type EditableArtifactLiveCommittedTransaction,
  type EditableArtifactLiveHead,
  type EditableArtifactLiveHintPort,
  type EditableArtifactLiveReadPort,
  type EditableArtifactLiveSchedulerPort,
  type EditableArtifactLiveServerFrame,
  type EditableArtifactLiveSinkPort,
  type EditableArtifactLiveTicketRecord,
  type EditableArtifactLiveTicketStorePort,
  type EditableArtifactLiveTokenPort,
} from "../../src/editable-artifact-live";
import {
  editableArtifactTestCommandBytes,
  encodeSerializedTestReceipt,
  encodeTestCommittedTransaction,
} from "../editable-artifacts/fixtures";

const artifactId = editableArtifactId("00000000000000010000000000000001");
const scope = Object.freeze({
  accountId: "account-a",
  workspaceId: "workspace-a",
});
const actor: EditableArtifactActor = Object.freeze({
  kind: "human",
  subjectId: "user:one",
  replicaId: editableArtifactReplicaId("0000000000000001"),
});
const emptyFrontier = editableArtifactCausalFrontier([]);

describe("editable artifact live server", () => {
  test("cannot advertise snapshots that supported browser clients cannot open", () => {
    expect(() =>
      liveHarness({
        maxSnapshotBytes: EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES + 1,
      }),
    ).toThrow("browser-compatible product limit");
  });

  test("never defaults a missing durable ticket modality", async () => {
    const harness = liveHarness();
    await expect(harness.server.mintTicket({ scope, artifactId, actor } as never)).rejects.toThrow(
      "modality",
    );
  });

  test.each(["document", "presentation"] as const)(
    "streams exact serialized %s commits under durable ticket modality",
    async (modality) => {
      const harness = liveHarness({}, modality);
      const committed = harness.reader.appendSerialized(1);
      const session = await harness.open();
      expect(harness.sink.frames.find((frame) => frame.type === "open")).toMatchObject({
        type: "open",
        modality,
      });
      expect(transactionFrames(harness.sink)).toEqual([
        expect.objectContaining({
          transaction: expect.objectContaining({
            modality,
            priorNativeRevision: 0,
            nativeRevision: 1,
            commitProtocolVersion: 1,
            committedTransactionBytes: committed.committedTransactionBytes,
          }),
        }),
      ]);
      await session.close();
    },
  );

  test("recovers a lost final hint by periodically reconciling durable head", async () => {
    const harness = liveHarness({
      reconcileIntervalMs: 100,
      ackTimeoutMs: 10_000,
    });
    const session = await harness.open();
    harness.reader.append(1, 1);

    expect(transactionFrames(harness.sink)).toHaveLength(0);
    await harness.scheduler.advance(99);
    expect(transactionFrames(harness.sink)).toHaveLength(0);
    await harness.scheduler.advance(1);
    expect(transactionFrames(harness.sink).map((frame) => frame.transaction.endSequence)).toEqual([
      1,
    ]);

    harness.hints.emit(1);
    harness.hints.reconnect();
    await flushTurns();
    expect(transactionFrames(harness.sink)).toHaveLength(1);
    await session.close();
  });

  test("subscribes before reading head and closes the bootstrap race contiguously", async () => {
    const harness = liveHarness();
    const ticket = await harness.server.mintTicket({
      scope,
      artifactId,
      modality: "spreadsheet",
      actor,
      allowEdit: true,
    });
    harness.trace.length = 0;
    const gate = deferred<void>();
    harness.reader.bootstrapGate = gate.promise;
    const opening = harness.server.openLive({
      token: ticket.token,
      artifactId,
      protocolVersion: 1,
      resume: resumeAtZero(),
      sink: harness.sink,
    });
    await until(() => harness.trace.includes("read:bootstrap"));
    harness.reader.append(1, 1);
    harness.hints.emit(1);
    gate.resolve();
    const session = await opening;

    expect(harness.trace.slice(0, 5)).toEqual([
      "ticket:consume",
      "authorize:read",
      "hints:subscribe",
      "invalidations:subscribe",
      "authorize:read",
    ]);
    expect(harness.trace.indexOf("hints:subscribe")).toBeLessThan(
      harness.trace.indexOf("read:bootstrap"),
    );
    expect(transactionFrames(harness.sink).map((frame) => frame.transaction.endSequence)).toEqual([
      1,
    ]);
    await session.close();
  });

  test("releases a subscription acquired after the caller aborts opening", async () => {
    const harness = liveHarness();
    const ticket = await harness.server.mintTicket({
      scope,
      artifactId,
      modality: "spreadsheet",
      actor,
      allowEdit: true,
    });
    const gate = deferred<void>();
    harness.hints.subscribeGate = gate.promise;
    const abort = new AbortController();
    const opening = harness.server.openLive({
      token: ticket.token,
      artifactId,
      protocolVersion: 1,
      resume: resumeAtZero(),
      sink: harness.sink,
      signal: abort.signal,
    });
    await until(() => harness.trace.includes("hints:subscribe"));

    abort.abort();
    gate.resolve();

    await expect(opening).rejects.toMatchObject({ code: "closed" });
    expect(harness.hints.activeSubscriptions).toBe(0);
    expect(harness.trace).toContain("hints:release");
    expect(harness.trace).not.toContain("invalidations:subscribe");
    expect(harness.sink.closeValue?.reason).toBe("closed");
  });

  test("treats duplicate and reordered fanout only as hints and gap-fills durable truth", async () => {
    const harness = liveHarness();
    const session = await harness.open();
    harness.reader.append(1, 2);
    harness.reader.append(3, 3);
    harness.hints.emit(3);
    harness.hints.emit(1);
    harness.hints.emit(3);
    harness.hints.emit(2);
    await flushTurns(12);

    expect(
      transactionFrames(harness.sink).map((frame) => [
        frame.transaction.startSequence,
        frame.transaction.endSequence,
      ]),
    ).toEqual([
      [1, 2],
      [3, 3],
    ]);
    expect(harness.trace.filter((entry) => entry === "read:head")).toHaveLength(2);
    await session.close();
  });

  test("fails closed when retained history can no longer fill the next gap", async () => {
    const harness = liveHarness();
    const session = await harness.open();
    harness.reader.append(1, 1);
    harness.reader.append(2, 2);
    harness.reader.minimumReplaySequence = 2;
    harness.hints.emit(2);
    const closed = await session.closed;

    expect(closed.reason).toBe("retention_gap");
    expect(closed.requiresSnapshot).toBe(true);
    expect(harness.sink.frames.some((frame) => frame.type === "resyncRequired")).toBe(true);
    expect(transactionFrames(harness.sink)).toHaveLength(0);
  });

  test("rejects tickets at the exact expiry boundary and atomically prevents replay", async () => {
    const expired = liveHarness({ ticketTtlMs: 1_000 });
    const ticket = await expired.server.mintTicket({
      scope,
      artifactId,
      modality: "spreadsheet",
      actor,
      allowEdit: true,
    });
    expired.clock.advance(1_000);
    await expect(
      expired.server.openLive({
        token: ticket.token,
        artifactId,
        protocolVersion: 1,
        resume: resumeAtZero(),
        sink: expired.sink,
      }),
    ).rejects.toMatchObject({ code: "ticket_expired" });

    const concurrent = liveHarness();
    const shared = await concurrent.server.mintTicket({
      scope,
      artifactId,
      modality: "spreadsheet",
      actor,
      allowEdit: true,
    });
    const firstSink = new TestSink();
    const secondSink = new TestSink();
    const attempts = await Promise.allSettled([
      concurrent.server.openLive({
        token: shared.token,
        artifactId,
        protocolVersion: 1,
        resume: resumeAtZero(),
        sink: firstSink,
      }),
      concurrent.server.openLive({
        token: shared.token,
        artifactId,
        protocolVersion: 1,
        resume: resumeAtZero(),
        sink: secondSink,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find((attempt) => attempt.status === "rejected");
    expect((rejection as PromiseRejectedResult).reason).toMatchObject({
      code: "ticket_replayed",
    });
    for (const attempt of attempts) {
      if (attempt.status === "fulfilled") await attempt.value.close();
    }
  });

  test("reauthorizes on invalidation and stops artifact bytes after read revocation", async () => {
    const harness = liveHarness();
    const session = await harness.open();
    harness.authorization.deny("read");
    harness.invalidations.emit();
    const closed = await session.closed;
    expect(closed.reason).toBe("permission_changed");
    harness.reader.append(1, 1);
    harness.hints.emit(1);
    await flushTurns();
    expect(transactionFrames(harness.sink)).toHaveLength(0);
  });

  test("closes an unacknowledging client with bounded ACK backpressure", async () => {
    const harness = liveHarness({
      ackTimeoutMs: 100,
      reconcileIntervalMs: 1_000,
      reauthorizeIntervalMs: 1_000,
      maxInFlightTransactions: 1,
    });
    const session = await harness.open();
    harness.reader.append(1, 1);
    harness.reader.append(2, 2);
    harness.hints.emit(2);
    await flushTurns();
    expect(transactionFrames(harness.sink).map((frame) => frame.transaction.endSequence)).toEqual([
      1,
    ]);

    await harness.scheduler.advance(100);
    const closed = await session.closed;
    expect(closed).toEqual({
      reason: "slow_client",
      retryable: true,
      requiresSnapshot: true,
    });
    expect(transactionFrames(harness.sink)).toHaveLength(1);
  });

  test("advances the replica lease only after an epoch-bound verified apply ACK", async () => {
    const harness = liveHarness({ maxInFlightTransactions: 1 });
    const session = await harness.open();
    harness.reader.append(1, 1);
    harness.reader.append(2, 2);
    harness.hints.emit(2);
    await flushTurns();
    expect(transactionFrames(harness.sink).map((frame) => frame.transaction.endSequence)).toEqual([
      1,
    ]);

    await session.receive(
      encodeClient({
        type: "applied",
        protocolVersion: 1,
        artifactId,
        streamEpoch: session.streamEpoch,
        sequence: 1,
        stateHash: hash(1),
      }),
    );
    expect(harness.reader.acknowledgements).toHaveLength(1);
    expect(harness.reader.acknowledgements[0]).toMatchObject({
      streamEpoch: session.streamEpoch,
      sequence: 1,
      stateHash: hash(1),
    });
    expect(harness.sink.frames).toContainEqual(
      expect.objectContaining({
        type: "applied",
        streamEpoch: session.streamEpoch,
        sequence: 1,
      }),
    );
    expect(transactionFrames(harness.sink).map((frame) => frame.transaction.endSequence)).toEqual([
      1, 2,
    ]);
    await session.close();
  });

  test("accepts only the exact genesis snapshot ACK and persists non-genesis snapshot ACKs", async () => {
    const genesis = liveHarness();
    genesis.reader.snapshotSequence = 0;
    const genesisSession = await genesis.open();
    await genesisSession.receive(
      encodeClient({
        type: "applied",
        protocolVersion: 1,
        artifactId,
        streamEpoch: genesisSession.streamEpoch,
        sequence: 0,
        stateHash: hash(0),
      }),
    );
    expect(genesis.sink.closeValue).toBeNull();
    expect(genesis.reader.acknowledgements).toHaveLength(0);
    expect(genesis.sink.frames).toContainEqual(
      expect.objectContaining({ type: "applied", sequence: 0, stateHash: hash(0) }),
    );
    await genesisSession.close();

    const mismatched = liveHarness();
    mismatched.reader.snapshotSequence = 0;
    const mismatchedSession = await mismatched.open();
    await mismatchedSession.receive(
      encodeClient({
        type: "applied",
        protocolVersion: 1,
        artifactId,
        streamEpoch: mismatchedSession.streamEpoch,
        sequence: 0,
        stateHash: editableArtifactStateHash(`sha256:${"f".repeat(64)}`),
      }),
    );
    expect((await mismatchedSession.closed).reason).toBe("invalid_ack");
    expect(mismatched.reader.acknowledgements).toHaveLength(0);

    const retained = liveHarness();
    retained.reader.append(1, 1);
    retained.reader.snapshotSequence = 1;
    const retainedSession = await retained.open();
    await retainedSession.receive(
      encodeClient({
        type: "applied",
        protocolVersion: 1,
        artifactId,
        streamEpoch: retainedSession.streamEpoch,
        sequence: 1,
        stateHash: hash(1),
      }),
    );
    expect(retained.reader.acknowledgements).toHaveLength(1);
    expect(retained.reader.acknowledgements[0]).toMatchObject({
      streamEpoch: retainedSession.streamEpoch,
      sequence: 1,
      stateHash: hash(1),
    });
    await retainedSession.close();
  });

  test("periodic authorization catches a lost permission invalidation hint", async () => {
    const harness = liveHarness({
      reauthorizeIntervalMs: 100,
      reconcileIntervalMs: 10_000,
      ackTimeoutMs: 10_000,
    });
    const session = await harness.open();
    harness.authorization.deny("read");
    await harness.scheduler.advance(100);
    expect((await session.closed).reason).toBe("permission_changed");
  });

  test("fences stale epochs before an ACK can advance a replica lease", async () => {
    const harness = liveHarness();
    const first = await harness.open();
    const oldEpoch = first.streamEpoch;
    await first.close();
    harness.sink = new TestSink();
    const second = await harness.open();
    const bytes = encodeClient({
      type: "applied",
      protocolVersion: 1,
      artifactId,
      streamEpoch: oldEpoch,
      sequence: 0,
      stateHash: hash(0),
    });
    await expect(second.receive(bytes)).rejects.toMatchObject({
      code: "stale_epoch",
    });
    expect((await second.closed).reason).toBe("stale_epoch");
    expect(harness.reader.acknowledgements).toHaveLength(0);
  });

  test("rejects oversized bytes before decode or domain mutation", async () => {
    const harness = liveHarness({ maxClientFrameBytes: 256 });
    const session = await harness.open();
    await expect(session.receive(new Uint8Array(257))).rejects.toMatchObject({
      code: "oversized_frame",
    });
    expect((await session.closed).reason).toBe("oversized_frame");
    expect(harness.domainCalls).toHaveLength(0);
  });

  test("never truncates an oversized canonical outbound transaction", async () => {
    const harness = liveHarness({
      maxOutboundFrameBytes: 300_000,
      maxInFlightBytes: 400_000,
      replayPageBytes: 400_000,
    });
    const session = await harness.open();
    harness.reader.append(1, 1, 300_000);
    harness.hints.emit(1);
    expect((await session.closed).reason).toBe("oversized_frame");
    expect(transactionFrames(harness.sink)).toHaveLength(0);
    expect(harness.sink.frames).toContainEqual(
      expect.objectContaining({
        type: "resyncRequired",
        reason: "oversized_frame",
      }),
    );
  });

  test("closes instead of growing an adapter send queue past its byte budget", async () => {
    const harness = liveHarness({ maxSocketBufferedBytes: 4_096 });
    const session = await harness.open();
    harness.sink.buffered = 4_096;
    harness.reader.append(1, 1);
    harness.hints.emit(1);
    expect((await session.closed).reason).toBe("slow_client");
    expect(transactionFrames(harness.sink)).toHaveLength(0);
  });

  test("passes exact owned intent bytes through the domain service and returns durable receipt", async () => {
    const harness = liveHarness();
    const session = await harness.open();
    const transaction = harness.reader.append(1, 1);
    const clientTransactionId = "client-live-1" as never;
    harness.domainHandler = async () =>
      ({
        receipt: {
          modality: "spreadsheet",
          serverTransactionId: transaction.transactionId,
          clientTransactionId,
          requestHash: transaction.requestHash,
          sequenceStart: transaction.startSequence,
          sequenceEnd: transaction.endSequence,
          stateHash: transaction.stateHash,
        },
        replayed: false,
      }) as never;
    const intentBytes = new Uint8Array([0x4f, 0x47, 0x41, 0x54, 1, 2, 3]);

    const receipt = await session.submitIntent({
      protocolVersion: 1,
      artifactId,
      streamEpoch: session.streamEpoch,
      requestHash: transaction.requestHash,
      intentBytes,
    });

    expect(harness.domainCalls).toHaveLength(1);
    expect(harness.domainCalls[0]).toMatchObject({ scope, artifactId, actor });
    expect(harness.domainCalls[0]!.request.requestHash).toBe(transaction.requestHash);
    expect(harness.domainCalls[0]!.request.intentBytes).toEqual(intentBytes);
    expect(harness.domainCalls[0]!.request.intentBytes).not.toBe(intentBytes);
    expect(receipt).toMatchObject({
      clientTransactionId,
      requestHash: transaction.requestHash,
      transaction: { endSequence: 1, stateHash: transaction.stateHash },
    });
    expect(receipt.transaction).not.toBe(transaction);
    expect(transactionFrames(harness.sink)).toHaveLength(1);
    await session.close();
  });

  test("rejects a mutation after edit revocation without tearing down readable live sync", async () => {
    const harness = liveHarness();
    const session = await harness.open();
    harness.authorization.deny("edit");
    await expect(
      session.submitIntent({
        protocolVersion: 1,
        artifactId,
        streamEpoch: session.streamEpoch,
        requestHash: editableArtifactRequestHash(`sha256:${"f".repeat(64)}`),
        intentBytes: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: "permission_changed" });
    expect(harness.domainCalls).toHaveLength(0);
    expect(harness.sink.closeValue).toBeNull();
    expect(harness.sink.frames).toContainEqual(
      expect.objectContaining({
        type: "authorizationChanged",
        writable: false,
      }),
    );
    await session.close();
  });

  test("reauthorizes a queued submit before it reaches the domain", async () => {
    const harness = liveHarness();
    const session = await harness.open();
    const transaction = harness.reader.append(1, 1);
    const gate = deferred<void>();
    harness.domainHandler = async () => {
      await gate.promise;
      return {
        receipt: {
          modality: "spreadsheet",
          serverTransactionId: transaction.transactionId,
          clientTransactionId: "client-live-queued" as never,
          requestHash: transaction.requestHash,
          sequenceStart: transaction.startSequence,
          sequenceEnd: transaction.endSequence,
          stateHash: transaction.stateHash,
        },
        replayed: false,
      } as never;
    };
    const first = session.submitIntent({
      protocolVersion: 1,
      artifactId,
      streamEpoch: session.streamEpoch,
      requestHash: transaction.requestHash,
      intentBytes: new Uint8Array([1]),
    });
    await until(() => harness.domainCalls.length === 1);
    const second = session.submitIntent({
      protocolVersion: 1,
      artifactId,
      streamEpoch: session.streamEpoch,
      requestHash: editableArtifactRequestHash(`sha256:${"e".repeat(64)}`),
      intentBytes: new Uint8Array([2]),
    });
    harness.authorization.deny("edit");
    gate.resolve();

    await first;
    await expect(second).rejects.toMatchObject({ code: "permission_changed" });
    expect(harness.domainCalls).toHaveLength(1);
    expect(harness.sink.closeValue).toBeNull();
    await session.close();
  });

  test("never re-enables writes from a stale allowed authorization revision", async () => {
    const harness = liveHarness();
    const session = await harness.open();
    harness.authorization.deny("edit");
    harness.invalidations.emit();
    await until(() =>
      harness.sink.frames.some((frame) => frame.type === "authorizationChanged" && !frame.writable),
    );
    harness.authorization.respondNext("edit", { allowed: true, revision: 1 }, 2);

    await expect(
      session.submitIntent({
        protocolVersion: 1,
        artifactId,
        streamEpoch: session.streamEpoch,
        requestHash: editableArtifactRequestHash(`sha256:${"d".repeat(64)}`),
        intentBytes: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: "permission_changed" });

    expect(harness.domainCalls).toHaveLength(0);
    expect(harness.sink.closeValue).toBeNull();
    expect(
      harness.sink.frames.filter(
        (frame) => frame.type === "authorizationChanged" && frame.writable,
      ),
    ).toHaveLength(0);
    await session.close();
  });
});

type HarnessOptions = ConstructorParameters<typeof EditableArtifactLiveServer>[1];

function liveHarness(
  options: HarnessOptions = {},
  modality: "document" | "spreadsheet" | "presentation" = "spreadsheet",
) {
  const trace: string[] = [];
  const clock = new ManualClock();
  const scheduler = new ManualScheduler(clock);
  const authorization = new MutableAuthorization(trace);
  const tickets = new TestTicketStore(trace);
  const tokens = new DeterministicTokens();
  const hints = new TestHints(trace);
  const invalidations = new TestInvalidations(trace);
  const reader = new TestReader(trace, modality);
  const domainCalls: Array<{
    scope: typeof scope;
    artifactId: typeof artifactId;
    actor: EditableArtifactActor;
    request: { intentBytes: Uint8Array; requestHash: string };
  }> = [];
  let domainHandler: ((input: unknown) => Promise<unknown>) | null = null;
  const domain = {
    async applyTransaction(input: (typeof domainCalls)[number]) {
      domainCalls.push(input);
      if (domainHandler) return await domainHandler(input);
      throw new Error("mutation fixture is not configured");
    },
  } as unknown as EditableArtifactService;
  const server = new EditableArtifactLiveServer(
    {
      authorization,
      domain,
      tickets,
      tokens,
      clock,
      scheduler,
      read: reader,
      hints,
      invalidations,
    },
    options,
  );
  let sink = new TestSink();
  return {
    trace,
    clock,
    scheduler,
    authorization,
    tickets,
    hints,
    invalidations,
    reader,
    server,
    get sink() {
      return sink;
    },
    set sink(value: TestSink) {
      sink = value;
    },
    domainCalls,
    set domainHandler(value: ((input: unknown) => Promise<unknown>) | null) {
      domainHandler = value;
    },
    get domainHandler() {
      return domainHandler;
    },
    async open() {
      const ticket = await server.mintTicket({
        scope,
        artifactId,
        modality,
        actor,
        allowEdit: true,
      });
      expect(ticket.replicaId).toBe(actor.replicaId);
      return server.openLive({
        token: ticket.token,
        artifactId,
        protocolVersion: 1,
        resume: resumeAtZero(modality),
        sink,
      });
    },
  };
}

class ManualClock implements EditableArtifactLiveClockPort {
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

  constructor(private readonly clock: ManualClock) {}

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

class MutableAuthorization implements EditableArtifactAuthorizationPort {
  private readonly denied = new Set<EditableArtifactPermission>();
  private readonly queued = new Map<
    EditableArtifactPermission,
    Array<{ allowed: boolean; revision: number }>
  >();
  private revision = 1;

  constructor(private readonly trace: string[]) {}

  deny(permission: EditableArtifactPermission): void {
    this.denied.add(permission);
    this.revision += 1;
  }

  respondNext(
    permission: EditableArtifactPermission,
    decision: { allowed: boolean; revision: number },
    count = 1,
  ): void {
    const queued = this.queued.get(permission) ?? [];
    for (let index = 0; index < count; index += 1) queued.push({ ...decision });
    this.queued.set(permission, queued);
  }

  async authorize(
    input: Parameters<EditableArtifactAuthorizationPort["authorize"]>[0],
  ): ReturnType<EditableArtifactAuthorizationPort["authorize"]> {
    this.trace.push(`authorize:${input.permission}`);
    const queued = this.queued.get(input.permission);
    const override = queued?.shift();
    if (override) return Promise.resolve(override);
    return Promise.resolve({
      allowed: !this.denied.has(input.permission),
      revision: this.revision,
    });
  }
}

class TestTicketStore implements EditableArtifactLiveTicketStorePort {
  private readonly records = new Map<string, EditableArtifactLiveTicketRecord>();

  constructor(private readonly trace: string[]) {}

  async put(record: EditableArtifactLiveTicketRecord): Promise<void> {
    this.trace.push("ticket:put");
    this.records.set(record.tokenDigest, record);
  }

  async consume(tokenDigest: string): Promise<EditableArtifactLiveTicketRecord | null> {
    this.trace.push("ticket:consume");
    const record = this.records.get(tokenDigest) ?? null;
    if (record) this.records.delete(tokenDigest);
    return record;
  }
}

class DeterministicTokens implements EditableArtifactLiveTokenPort {
  private counter = 0;

  randomOpaqueToken(): string {
    this.counter += 1;
    return `token_${this.counter.toString(16).padStart(8, "0")}_${"x".repeat(32)}`;
  }

  async digestOpaqueToken(token: string): Promise<string> {
    const bytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
}

class TestHints implements EditableArtifactLiveHintPort {
  private onHint: ((hint: { artifactId: typeof artifactId; headSequence: number }) => void) | null =
    null;
  private onReconnect: (() => void) | null = null;
  subscribeGate: Promise<void> | null = null;
  activeSubscriptions = 0;

  constructor(private readonly trace: string[]) {}

  async subscribe(
    input: Parameters<EditableArtifactLiveHintPort["subscribe"]>[0],
  ): Promise<() => void> {
    this.trace.push("hints:subscribe");
    this.activeSubscriptions += 1;
    if (this.subscribeGate) await this.subscribeGate;
    this.onHint = input.onHint;
    this.onReconnect = input.onReconnect;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSubscriptions -= 1;
      this.trace.push("hints:release");
      this.onHint = null;
      this.onReconnect = null;
    };
  }

  emit(headSequence: number): void {
    this.onHint?.({ artifactId, headSequence });
  }

  reconnect(): void {
    this.onReconnect?.();
  }
}

class TestInvalidations implements EditableArtifactLiveAuthorizationInvalidationPort {
  private callback: (() => void) | null = null;

  constructor(private readonly trace: string[]) {}

  async subscribe(
    input: Parameters<EditableArtifactLiveAuthorizationInvalidationPort["subscribe"]>[0],
  ): Promise<() => void> {
    this.trace.push("invalidations:subscribe");
    this.callback = input.onInvalidated;
    return () => {
      this.trace.push("invalidations:release");
      this.callback = null;
    };
  }

  emit(): void {
    this.callback?.();
  }
}

class TestReader implements EditableArtifactLiveReadPort {
  readonly transactions: EditableArtifactLiveCommittedTransaction[] = [];
  readonly acknowledgements: Array<
    Parameters<EditableArtifactLiveReadPort["acknowledgeReplica"]>[0]
  > = [];
  readonly hashes = new Map<number, ReturnType<typeof hash>>([[0, hash(0)]]);
  minimumReplaySequence = 1;
  bootstrapGate: Promise<void> | null = null;
  snapshotSequence: number | null = null;

  constructor(
    private readonly trace: string[],
    private readonly modality: "document" | "spreadsheet" | "presentation",
  ) {}

  append(
    startSequence: number,
    endSequence: number,
    operationByteLength = 2,
  ): EditableArtifactLiveCommittedTransaction {
    if (this.modality !== "spreadsheet") {
      throw new Error("spreadsheet transaction appended to serialized reader");
    }
    const prior = this.hashes.get(startSequence - 1);
    if (!prior) throw new Error(`missing fixture hash at ${startSequence - 1}`);
    const stateHash = hash(endSequence);
    const transaction: EditableArtifactLiveCommittedTransaction = Object.freeze({
      modality: "spreadsheet",
      artifactId,
      transactionId: editableArtifactTransactionId(
        `0000000000000002${endSequence.toString(16).padStart(16, "0")}`,
      ),
      requestHash: editableArtifactRequestHash(
        `sha256:${(endSequence + 100).toString(16).padStart(64, "0")}`,
      ),
      startSequence,
      endSequence,
      priorStateHash: prior,
      stateHash,
      causalFrontier: emptyFrontier,
      operationProtocolVersion: 1,
      committedTransactionBytes:
        operationByteLength === 2
          ? encodeTestCommittedTransaction({
              transactionId: `0000000000000002${endSequence.toString(16).padStart(16, "0")}`,
              dot: { replicaId: actor.replicaId, counter: endSequence },
              resolvedCausalBase: emptyFrontier,
              operationIds: Array.from(
                { length: endSequence - startSequence + 1 },
                (_, index) =>
                  `0000000000000003${(startSequence + index).toString(16).padStart(16, "0")}`,
              ),
              priorStateHash: prior,
              resultingCausalFrontier: emptyFrontier,
              stateHash,
            })
          : new Uint8Array(operationByteLength),
    });
    this.transactions.push(transaction);
    this.hashes.set(endSequence, stateHash);
    return transaction;
  }

  appendSerialized(
    sequence: number,
  ): Extract<EditableArtifactLiveCommittedTransaction, { modality: "document" | "presentation" }> {
    if (this.modality === "spreadsheet") {
      throw new Error("serialized transaction appended to spreadsheet reader");
    }
    const priorStateHash = this.hashes.get(sequence - 1);
    if (!priorStateHash) {
      throw new Error(`missing fixture hash at ${sequence - 1}`);
    }
    const stateHash = hash(sequence);
    const transactionId = editableArtifactTransactionId(
      `0000000000000002${sequence.toString(16).padStart(16, "0")}`,
    );
    const intent = hashEditableArtifactMutationIntent({
      envelopeVersion: 1,
      protocolVersion: 1,
      modelSchemaVersion: 1,
      commandProtocolVersion: 1,
      artifactId,
      clientTransactionId: `serialized-${this.modality}-${sequence}` as never,
      replicaId: actor.replicaId,
      replicaCounter: sequence,
      previousLocalTransactionId: null,
      observedHeadSequence: sequence - 1,
      causalBase: emptyFrontier,
      selectiveUndoOperationIds: [],
      commandBytes: editableArtifactTestCommandBytes(this.modality),
    });
    const nativeReceiptBytes = encodeSerializedTestReceipt(this.modality, sequence, 1);
    const committedTransactionBytes = encodeEditableArtifactSerializedCommit({
      modality: this.modality,
      transactionId,
      parentHeadSequence: sequence - 1,
      resultHeadSequence: sequence,
      priorNativeRevision: sequence - 1,
      priorStateHash,
      stateHash,
      intentBytes: intent.bytes,
      nativeReceiptBytes,
    });
    const transaction = Object.freeze({
      modality: this.modality,
      artifactId,
      transactionId,
      requestHash: editableArtifactRequestHash(intent.requestHash),
      startSequence: sequence,
      endSequence: sequence,
      priorStateHash,
      stateHash,
      priorNativeRevision: sequence - 1,
      nativeRevision: sequence,
      commitProtocolVersion: 1,
      committedTransactionBytes,
    });
    this.transactions.push(transaction);
    this.hashes.set(sequence, stateHash);
    return transaction;
  }

  async readBootstrap(
    input: Parameters<EditableArtifactLiveReadPort["readBootstrap"]>[0],
  ): Promise<EditableArtifactLiveBootstrap> {
    this.trace.push("read:bootstrap");
    const captured = this.head();
    if (this.bootstrapGate) await this.bootstrapGate;
    const cursor = input.resume.localCursor ?? 0;
    const resumeHash = this.hashes.get(cursor) ?? hash(0);
    const snapshotSequence = this.snapshotSequence;
    const snapshot =
      snapshotSequence === null
        ? null
        : this.modality === "spreadsheet"
          ? {
              modality: this.modality,
              artifactId,
              sequence: snapshotSequence,
              stateHash: this.hashes.get(snapshotSequence)!,
              causalFrontier: emptyFrontier,
              operationProtocolVersion: 1,
              digest: `sha256:${"a".repeat(64)}` as const,
              kernelVersion: "test-kernel",
              modelSchemaVersion: 1,
              bytes: new Uint8Array([1]),
            }
          : {
              modality: this.modality,
              artifactId,
              sequence: snapshotSequence,
              stateHash: this.hashes.get(snapshotSequence)!,
              nativeRevision: snapshotSequence,
              digest: `sha256:${"a".repeat(64)}` as const,
              kernelVersion: "test-kernel",
              modelSchemaVersion: 1,
              bytes: new Uint8Array([1]),
            };
    return {
      ...captured,
      resumeAccepted:
        snapshot === null &&
        !input.resume.requireSnapshot &&
        input.resume.localStateHash === resumeHash &&
        cursor <= captured.headSequence,
      resumeSequence: cursor,
      resumeStateHash: resumeHash,
      snapshot,
    };
  }

  async readHead(): Promise<EditableArtifactLiveHead> {
    this.trace.push("read:head");
    return this.head();
  }

  async readTransactions(input: Parameters<EditableArtifactLiveReadPort["readTransactions"]>[0]) {
    this.trace.push(`read:transactions:${input.after}:${input.through}`);
    const transactions: EditableArtifactLiveCommittedTransaction[] = [];
    let bytes = 0;
    for (const transaction of this.transactions) {
      if (transaction.startSequence <= input.after || transaction.endSequence > input.through)
        continue;
      if (
        transactions.length >= input.maxCount ||
        bytes + transaction.committedTransactionBytes.byteLength > input.maxBytes
      )
        break;
      transactions.push(transaction);
      bytes += transaction.committedTransactionBytes.byteLength;
    }
    return {
      transactions,
      headSequence: this.head().headSequence,
      minimumReplaySequence: this.minimumReplaySequence,
    };
  }

  async readCommittedTransaction(
    input: Parameters<EditableArtifactLiveReadPort["readCommittedTransaction"]>[0],
  ) {
    return (
      this.transactions.find((transaction) => transaction.transactionId === input.transactionId) ??
      null
    );
  }

  async acknowledgeReplica(
    input: Parameters<EditableArtifactLiveReadPort["acknowledgeReplica"]>[0],
  ): Promise<void> {
    this.acknowledgements.push(input);
  }

  private head(): EditableArtifactLiveHead {
    const headSequence = this.transactions.at(-1)?.endSequence ?? 0;
    const common = {
      headSequence,
      stateHash: this.hashes.get(headSequence)!,
      minimumReplaySequence: this.minimumReplaySequence,
    } as const;
    return this.modality === "spreadsheet"
      ? { ...common, modality: this.modality, causalFrontier: emptyFrontier }
      : { ...common, modality: this.modality, nativeRevision: headSequence };
  }
}

class TestSink implements EditableArtifactLiveSinkPort {
  readonly frames: EditableArtifactLiveServerFrame[] = [];
  closeValue: EditableArtifactLiveClose | null = null;
  buffered = 0;

  async send(frame: EditableArtifactLiveServerFrame): Promise<void> {
    this.frames.push(frame);
  }

  bufferedBytes(): number {
    return this.buffered;
  }

  close(close: EditableArtifactLiveClose): void {
    this.closeValue = close;
  }
}

function transactionFrames(sink: TestSink) {
  return sink.frames.filter(
    (frame): frame is Extract<EditableArtifactLiveServerFrame, { type: "transaction" }> =>
      frame.type === "transaction",
  );
}

function resumeAtZero(modality: "document" | "spreadsheet" | "presentation" = "spreadsheet") {
  return Object.freeze(
    modality === "spreadsheet"
      ? {
          localCursor: 0,
          localStateHash: hash(0),
          localCausalFrontier: emptyFrontier,
          requireSnapshot: false,
        }
      : {
          modality,
          localCursor: 0,
          localStateHash: hash(0),
          localNativeRevision: 0,
          requireSnapshot: false,
        },
  );
}

function hash(value: number) {
  return editableArtifactStateHash(`sha256:${value.toString(16).padStart(64, "0")}`);
}

function encodeClient(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
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
