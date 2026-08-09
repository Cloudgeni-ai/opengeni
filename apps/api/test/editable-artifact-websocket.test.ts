import { describe, expect, test } from "bun:test";
import {
  EDITABLE_ARTIFACT_INTENT_VERSION,
  hashEditableArtifactMutationIntent,
} from "@opengeni/contracts/editable-artifacts";
import {
  editableArtifactId,
  editableArtifactRequestHash,
  editableArtifactStateHash,
  editableArtifactTransactionId,
  decodeEditableArtifactLiveClientWireFrame,
  decodeEditableArtifactLiveServerWireFrame,
  encodeEditableArtifactLiveAppliedWireFrame,
  encodeEditableArtifactLiveMutationWireFrame,
  encodeEditableArtifactLiveOpenWireFrame,
  inspectEditableArtifactLiveWireEnvelope,
  type EditableArtifactApplicationPort,
  type EditableArtifactLiveSession,
} from "@opengeni/core";

import {
  EDITABLE_ARTIFACT_LIVE_WEBSOCKET_MAX_MESSAGE_BYTES,
  EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PATH,
  EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PROTOCOL,
  EditableArtifactWebSocketConnection,
  EditableArtifactWebSocketTransport,
  type EditableArtifactWebSocketLike,
} from "../src/editable-artifact-websocket";

const artifactId = editableArtifactId("00000000000000010000000000000001");
const transactionId = editableArtifactTransactionId("00000000000000020000000000000002");
const requestHash = editableArtifactRequestHash(`sha256:${"4".repeat(64)}`);
const zeroHash = editableArtifactStateHash(`sha256:${"0".repeat(64)}`);
const oneHash = editableArtifactStateHash(`sha256:${"1".repeat(64)}`);

describe("editable artifact WebSocket transport", () => {
  test("rejects oversized input before copying or decoding it", async () => {
    const harness = fixture();
    const connection = new EditableArtifactWebSocketConnection(harness.application);
    const socket = new TestSocket(connection);
    connection.attach(socket);
    const oversized = new Uint8Array(EDITABLE_ARTIFACT_LIVE_WEBSOCKET_MAX_MESSAGE_BYTES + 1);
    Object.defineProperty(oversized, Symbol.iterator, {
      value: () => {
        throw new Error("oversized bytes were copied");
      },
    });
    expect(() => connection.receive(oversized)).not.toThrow();
    await settle();
    expect(socket.closed).toMatchObject({ reason: "oversized_frame" });
  });

  test("requires the binary subprotocol and never accepts a ticket in the URL", () => {
    const application = fixture().application;
    const transport = new EditableArtifactWebSocketTransport(application);
    const calls: unknown[] = [];
    const server = {
      upgrade: (...input: unknown[]) => {
        calls.push(input);
        return true;
      },
    };
    const missing = transport.upgrade(
      new Request(`http://api.test${EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PATH}`),
      server as never,
    );
    expect(missing?.status).toBe(426);
    expect(calls).toHaveLength(0);

    const request = new Request(`http://api.test${EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PATH}`, {
      headers: {
        "sec-websocket-protocol": EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PROTOCOL,
      },
    });
    expect(transport.upgrade(request, server as never)).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(request.url).not.toContain("ticket");
  });

  test("keeps HTTP serving while an uncomposed live engine fails closed", () => {
    const transport = new EditableArtifactWebSocketTransport(undefined);
    let upgradeCalls = 0;
    const response = transport.upgrade(
      new Request(`http://api.test${EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PATH}`, {
        headers: {
          "sec-websocket-protocol": EDITABLE_ARTIFACT_LIVE_WEBSOCKET_PROTOCOL,
        },
      }),
      {
        upgrade() {
          upgradeCalls += 1;
          return true;
        },
      },
    );
    expect(response?.status).toBe(503);
    expect(upgradeCalls).toBe(0);
  });

  test("opens once, forwards exact OGATX bytes, emits transaction then acceptance, and applies ACK", async () => {
    const harness = fixture();
    const connection = new EditableArtifactWebSocketConnection(harness.application);
    const socket = new TestSocket(connection);
    connection.attach(socket);

    connection.receive(
      encodeEditableArtifactLiveOpenWireFrame({
        type: "open",
        protocolVersion: 1,
        artifactId,
        token: "t".repeat(43),
        resume: {
          localCursor: 0,
          localStateHash: zeroHash,
          localCausalFrontier: [],
          requireSnapshot: false,
        },
      }),
    );
    await settle();
    expect(harness.openCalls).toHaveLength(1);
    expect(harness.openCalls[0]).toMatchObject({
      token: "t".repeat(43),
      artifactId,
    });

    const authored = hashEditableArtifactMutationIntent({
      envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
      protocolVersion: 1,
      modelSchemaVersion: 1,
      commandProtocolVersion: 1,
      artifactId,
      clientTransactionId: "client-1",
      replicaId: "0000000000000001",
      replicaCounter: 1,
      previousLocalTransactionId: null,
      observedHeadSequence: 0,
      causalBase: [],
      selectiveUndoOperationIds: [],
      commandBytes: new Uint8Array([7, 8, 9]),
    });
    connection.receive(
      encodeEditableArtifactLiveMutationWireFrame({
        type: "mutation",
        protocolVersion: 1,
        artifactId,
        streamEpoch: "live_epoch_1",
        requestHash: editableArtifactRequestHash(authored.requestHash),
        intentBytes: authored.bytes,
      }),
    );
    await settle();
    expect(harness.submissions).toHaveLength(1);
    expect(harness.submissions[0]!.intentBytes).toEqual(authored.bytes);
    expect(harness.submissions[0]!.intentBytes).not.toBe(authored.bytes);
    const responseFrames = socket.sent.slice(-2).map(decodeEditableArtifactLiveServerWireFrame);
    expect(responseFrames.map((frame) => frame.type)).toEqual(["transaction", "mutationAccepted"]);
    expect(responseFrames[0]).toMatchObject({
      type: "transaction",
      transaction: {
        transactionId,
        requestHash: authored.requestHash,
        committedTransactionBytes: new Uint8Array([1]),
      },
    });
    const accepted = socket.sent
      .map(inspectEditableArtifactLiveWireEnvelope)
      .find((frame) => frame.metadata.type === "mutationAccepted");
    expect(accepted?.metadata).toMatchObject({
      requestHash: authored.requestHash,
      transactionId,
      startSequence: 1,
      endSequence: 1,
    });

    connection.receive(
      encodeEditableArtifactLiveAppliedWireFrame({
        type: "applied",
        protocolVersion: 1,
        artifactId,
        streamEpoch: "live_epoch_1",
        sequence: 1,
        stateHash: oneHash,
      }),
    );
    await settle();
    expect(harness.acks).toEqual([{ sequence: 1, stateHash: oneHash }]);
  });

  test.each(["document", "presentation"] as const)(
    "preserves exact %s OGAST evidence and native revision fields",
    async (modality) => {
      const ogastBytes = new TextEncoder().encode(`OGAST001-exact-${modality}-durable-evidence`);
      const harness = fixture({
        modality,
        committedTransactionBytes: ogastBytes,
      });
      const connection = new EditableArtifactWebSocketConnection(harness.application);
      const socket = new TestSocket(connection);
      connection.attach(socket);
      connection.receive(
        encodeEditableArtifactLiveOpenWireFrame({
          type: "open",
          protocolVersion: 1,
          artifactId,
          token: "t".repeat(43),
          resume: {
            modality,
            localCursor: 0,
            localStateHash: zeroHash,
            localNativeRevision: 0,
            requireSnapshot: false,
          },
        }),
      );
      await settle();
      expect(harness.openCalls[0]).toMatchObject({
        resume: { modality, localNativeRevision: 0 },
      });

      connection.receive(mutationFrame());
      await settle();
      const frames = socket.sent.map(decodeEditableArtifactLiveServerWireFrame);
      expect(frames.map((frame) => frame.type)).toEqual(["transaction", "mutationAccepted"]);
      expect(frames[0]).toMatchObject({
        type: "transaction",
        transaction: {
          modality,
          priorNativeRevision: 0,
          nativeRevision: 1,
          commitProtocolVersion: 1,
          committedTransactionBytes: ogastBytes,
        },
      });
    },
  );

  test("resends exact transaction evidence when replay and ACK preceded an idempotent retry", async () => {
    const harness = fixture();
    const connection = new EditableArtifactWebSocketConnection(harness.application);
    const socket = new TestSocket(connection);
    connection.attach(socket);
    connection.receive(openFrame());
    await settle();

    const mutation = mutationFrame();
    const request = decodeEditableArtifactLiveClientWireFrame(mutation);
    if (request.type !== "mutation") throw new Error("test mutation did not decode");
    await connection.send({
      type: "transaction",
      protocolVersion: 1,
      artifactId,
      streamEpoch: "live_epoch_1",
      transaction: committed(request.requestHash),
    });
    connection.receive(
      encodeEditableArtifactLiveAppliedWireFrame({
        type: "applied",
        protocolVersion: 1,
        artifactId,
        streamEpoch: "live_epoch_1",
        sequence: 1,
        stateHash: oneHash,
      }),
    );
    await settle();

    connection.receive(mutation);
    await settle();
    const frames = socket.sent.map(decodeEditableArtifactLiveServerWireFrame);
    expect(frames.map((frame) => frame.type)).toEqual([
      "transaction",
      "transaction",
      "mutationAccepted",
    ]);
    expect(harness.acks).toEqual([{ sequence: 1, stateHash: oneHash }]);
    expect(
      frames
        .filter((frame) => frame.type === "transaction")
        .map((frame) => frame.transaction.committedTransactionBytes),
    ).toEqual([new Uint8Array([1]), new Uint8Array([1])]);
  });

  test("closes on response backpressure without misreporting a durable submit as rejected", async () => {
    const harness = fixture();
    const connection = new EditableArtifactWebSocketConnection(harness.application);
    const socket = new TestSocket(connection, 2);
    connection.attach(socket);
    connection.receive(openFrame());
    await settle();
    connection.receive(mutationFrame());
    await settle();

    expect(
      socket.sent.map(decodeEditableArtifactLiveServerWireFrame).map((frame) => frame.type),
    ).toEqual(["transaction"]);
    expect(socket.closed).toMatchObject({ reason: "closed" });
  });

  test("keeps a request-scoped mutation rejection on the live socket", async () => {
    const harness = fixture();
    harness.rejectMutation = true;
    const connection = new EditableArtifactWebSocketConnection(harness.application);
    const socket = new TestSocket(connection);
    connection.attach(socket);
    connection.receive(openFrame());
    await settle();
    connection.receive(mutationFrame());
    await settle();

    expect(socket.closed).toBeNull();
    expect(socket.sent.map(inspectEditableArtifactLiveWireEnvelope).at(-1)?.metadata).toMatchObject(
      {
        type: "mutationRejected",
        code: "unavailable",
        retryable: true,
      },
    );
    expect(
      socket.sent.map(decodeEditableArtifactLiveServerWireFrame).map((frame) => frame.type),
    ).toEqual(["mutationRejected"]);
  });
});

function fixture(
  options: Readonly<{
    modality?: "document" | "spreadsheet" | "presentation";
    committedTransactionBytes?: Uint8Array;
  }> = {},
) {
  const modality = options.modality ?? "spreadsheet";
  const committedTransactionBytes =
    options.committedTransactionBytes?.slice() ?? new Uint8Array([1]);
  const openCalls: Array<Record<string, unknown>> = [];
  const submissions: Array<{ intentBytes: Uint8Array }> = [];
  const acks: Array<{ sequence: number; stateHash: string }> = [];
  let rejectMutation = false;
  const closed = new Promise<never>(() => undefined);
  const session: EditableArtifactLiveSession = {
    artifactId,
    modality,
    streamEpoch: "live_epoch_1",
    closed,
    receive: async () => undefined,
    acknowledge: async (frame) => {
      acks.push({ sequence: frame.sequence, stateHash: frame.stateHash });
    },
    submitIntent: async (input) => {
      submissions.push({ intentBytes: input.intentBytes.slice() });
      if (rejectMutation) throw new Error("transient persistence outage");
      return {
        clientTransactionId: "client-1" as never,
        requestHash: input.requestHash,
        transaction: committed(input.requestHash, modality, committedTransactionBytes),
      };
    },
    reconcileNow: async () => undefined,
    reauthorizeNow: async () => undefined,
    close: async () => undefined,
  };
  const application = {
    createArtifact: async () => {
      throw new Error("unused");
    },
    readArtifact: async () => {
      throw new Error("unused");
    },
    mintLiveTicket: async () => {
      throw new Error("unused");
    },
    openLive: async (input: Record<string, unknown>) => {
      openCalls.push(input);
      return session;
    },
  } as unknown as EditableArtifactApplicationPort;
  return {
    application,
    openCalls,
    submissions,
    acks,
    get rejectMutation() {
      return rejectMutation;
    },
    set rejectMutation(value: boolean) {
      rejectMutation = value;
    },
  };
}

class TestSocket implements EditableArtifactWebSocketLike {
  readonly sent: Uint8Array[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readonly bufferedAmount = 0;

  private sendCount = 0;

  constructor(
    readonly data: EditableArtifactWebSocketConnection,
    private readonly rejectSendNumber: number | null = null,
  ) {}

  send(data: Uint8Array): number {
    this.sendCount += 1;
    if (this.sendCount === this.rejectSendNumber) return 0;
    this.sent.push(data.slice());
    return data.byteLength;
  }

  close(code?: number, reason?: string): void {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason ? { reason } : {}),
    };
  }
}

function committed(
  hash: typeof requestHash,
  modality: "document" | "spreadsheet" | "presentation" = "spreadsheet",
  bytes: Uint8Array = new Uint8Array([1]),
) {
  const common = {
    artifactId,
    transactionId,
    requestHash: hash,
    startSequence: 1,
    endSequence: 1,
    priorStateHash: zeroHash,
    stateHash: oneHash,
    committedTransactionBytes: bytes.slice(),
  };
  return modality === "spreadsheet"
    ? {
        ...common,
        modality,
        causalFrontier: [],
        operationProtocolVersion: 1,
      }
    : {
        ...common,
        modality,
        priorNativeRevision: 0,
        nativeRevision: 1,
        commitProtocolVersion: 1,
      };
}

function openFrame(): Uint8Array {
  return encodeEditableArtifactLiveOpenWireFrame({
    type: "open",
    protocolVersion: 1,
    artifactId,
    token: "t".repeat(43),
    resume: {
      localCursor: 0,
      localStateHash: zeroHash,
      localCausalFrontier: [],
      requireSnapshot: false,
    },
  });
}

function mutationFrame(): Uint8Array {
  const authored = hashEditableArtifactMutationIntent({
    envelopeVersion: EDITABLE_ARTIFACT_INTENT_VERSION,
    protocolVersion: 1,
    modelSchemaVersion: 1,
    commandProtocolVersion: 1,
    artifactId,
    clientTransactionId: "client-1",
    replicaId: "0000000000000001",
    replicaCounter: 1,
    previousLocalTransactionId: null,
    observedHeadSequence: 0,
    causalBase: [],
    selectiveUndoOperationIds: [],
    commandBytes: new Uint8Array([1]),
  });
  return encodeEditableArtifactLiveMutationWireFrame({
    type: "mutation",
    protocolVersion: 1,
    artifactId,
    streamEpoch: "live_epoch_1",
    requestHash: editableArtifactRequestHash(authored.requestHash),
    intentBytes: authored.bytes,
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

void requestHash;
