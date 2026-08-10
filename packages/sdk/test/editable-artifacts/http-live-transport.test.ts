import { expect, test } from "bun:test";
import {
  decodeEditableArtifactLiveClientWireFrame,
  encodeEditableArtifactLiveServerWireFrame,
} from "@opengeni/contracts/editable-artifact-live";
import {
  createEditableArtifactHttpLiveTransport,
  type EditableArtifactWebSocketCloseEvent,
  type EditableArtifactWebSocketLike,
  type EditableArtifactWebSocketMessageEvent,
} from "../../src/editable-artifacts/http-live-transport";
import type { EditableArtifactLiveMessage } from "../../src/editable-artifacts/types";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "../../src/types";
import {
  testCommand,
  testCommitted,
  testPending,
  testStableId,
  testStateHash,
} from "./protocol-fixtures";

const ARTIFACT_ID = "10000000000000000000000000000001";
const REPLICA_ID = "0000000000000001";
const STATE_ZERO = testStateHash("transport-state-zero");
const DIGEST_ZERO = testStateHash("transport-digest-zero");

test("serialized resume requires cursor/hash/native revision as one exact tuple", async () => {
  let sockets = 0;
  const transport = createEditableArtifactHttpLiveTransport({
    baseUrl: "https://api.example.test",
    workspaceId: "workspace-1",
    protocolVersion: 1,
    kernelVersion: "artifact-kernel-test",
    modelSchemaVersion: 1,
    webSocketFactory: () => {
      sockets += 1;
      throw new Error("resume validation must run before socket creation");
    },
  });
  const ticket = {
    artifactId: ARTIFACT_ID,
    modality: "document",
    replicaId: REPLICA_ID,
    token: "one_use_serialized_resume_ticket",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    protocolVersion: 1,
  } as const;
  const signal = new AbortController().signal;

  await expect(
    transport.openLive({
      ticket,
      after: 0,
      stateHash: null,
      resume: { modality: "document", nativeRevision: 0 },
      requireSnapshot: true,
      signal,
      onMessage: () => undefined,
    }),
  ).rejects.toThrow("present together");
  await expect(
    transport.openLive({
      ticket,
      after: 0,
      stateHash: STATE_ZERO,
      resume: { modality: "document", nativeRevision: null },
      requireSnapshot: false,
      signal,
      onMessage: () => undefined,
    }),
  ).rejects.toThrow("present together");
  expect(sockets).toBe(0);
});

test("fails before sending a ticket when the WebSocket subprotocol is not negotiated", async () => {
  const socket = new FakeSocket("wss://api.example.test/v1/editable-artifacts/live", "");
  const transport = createEditableArtifactHttpLiveTransport({
    baseUrl: "https://api.example.test",
    workspaceId: "workspace-1",
    protocolVersion: 1,
    kernelVersion: "artifact-kernel-test",
    modelSchemaVersion: 1,
    webSocketFactory: () => socket,
  });
  const abort = new AbortController();
  const opening = transport.openLive({
    ticket: {
      artifactId: ARTIFACT_ID,
      modality: "spreadsheet",
      replicaId: REPLICA_ID,
      token: "one_use_ticket_bad_protocol",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      protocolVersion: 1,
    },
    after: 0,
    stateHash: STATE_ZERO,
    resume: { modality: "spreadsheet", causalFrontier: [] },
    requireSnapshot: false,
    signal: abort.signal,
    onMessage: () => undefined,
  });
  socket.open();
  await expect(opening).rejects.toThrow("required subprotocol");
  expect(socket.sent).toHaveLength(0);
});

test("bounds the full open/bootstrap handshake instead of hanging after server open", async () => {
  const socket = new FakeSocket(
    "wss://api.example.test/v1/editable-artifacts/live",
    "opengeni-artifact-v1",
  );
  const transport = createEditableArtifactHttpLiveTransport({
    baseUrl: "https://api.example.test",
    workspaceId: "workspace-1",
    protocolVersion: 1,
    kernelVersion: "artifact-kernel-test",
    modelSchemaVersion: 1,
    handshakeTimeoutMs: 5,
    webSocketFactory: () => socket,
  });
  const abort = new AbortController();
  const opening = transport.openLive({
    ticket: {
      artifactId: ARTIFACT_ID,
      modality: "spreadsheet",
      replicaId: REPLICA_ID,
      token: "one_use_ticket_stalled_bootstrap",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      protocolVersion: 1,
    },
    after: 0,
    stateHash: STATE_ZERO,
    resume: { modality: "spreadsheet", causalFrontier: [] },
    requireSnapshot: false,
    signal: abort.signal,
    onMessage: () => undefined,
  });
  socket.open();
  socket.server({
    type: "open",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-stalled",
    writable: true,
    headSequence: 0,
    minimumReplaySequence: 1,
    maxClientFrameBytes: 8 * 1024 * 1024 + 64 * 1024,
    maxCommandBytes: 4 * 1024 * 1024,
    maxIntentBytes: 5 * 1024 * 1024,
    maxCommittedTransactionBytes: 8 * 1024 * 1024,
    maxSnapshotBytes: 64 * 1024 * 1024,
    maxInFlightTransactions: 1,
    maxInFlightBytes: 8 * 1024 * 1024,
  });
  const connection = await opening;
  await expect(
    connection.readBootstrap({
      localCursor: 0,
      localStateHash: STATE_ZERO,
      resume: { modality: "spreadsheet", localCausalFrontier: [] },
      requireSnapshot: false,
      signal: abort.signal,
    }),
  ).rejects.toThrow("handshake timed out");
});

test("public transport keeps auth in HTTP/ticket bytes and maps one exact binary live epoch", async () => {
  const sockets: FakeSocket[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const transport = createEditableArtifactHttpLiveTransport({
    baseUrl: "https://api.example.test/opengeni-api",
    workspaceId: "workspace-1",
    protocolVersion: 1,
    kernelVersion: "artifact-kernel-test",
    modelSchemaVersion: 1,
    apiKey: "long-lived-http-key",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return Response.json({
        artifactId: ARTIFACT_ID,
        modality: "spreadsheet",
        replicaId: REPLICA_ID,
        token: "one_use_ticket_1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        protocolVersion: 1,
      });
    }) as typeof fetch,
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
  });
  const abort = new AbortController();
  const ticket = await transport.mintTicket({
    artifactId: ARTIFACT_ID,
    replicaId: REPLICA_ID,
    signal: abort.signal,
  });
  expect(requests[0]?.url).toBe(
    `https://api.example.test/opengeni-api/v1/workspaces/workspace-1/editable-artifacts/${ARTIFACT_ID}/live-ticket`,
  );
  expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
    "Bearer long-lived-http-key",
  );
  expect(new Headers(requests[0]?.init.headers).get(OPENGENI_API_CONTRACT_HEADER)).toBe(
    OPENGENI_API_CONTRACT_REVISION,
  );

  const messages: EditableArtifactLiveMessage[] = [];
  const opening = transport.openLive({
    ticket,
    after: 0,
    stateHash: null,
    resume: { modality: "spreadsheet", causalFrontier: [] },
    requireSnapshot: true,
    signal: abort.signal,
    onMessage: (message) => messages.push(message),
  });
  const socket = sockets[0]!;
  expect(socket.url).toBe("wss://api.example.test/opengeni-api/v1/editable-artifacts/live");
  expect(socket.url).not.toContain(ticket.token);
  expect(socket.url).not.toContain("long-lived-http-key");
  expect(socket.protocol).toBe("opengeni-artifact-v1");
  socket.open();
  const clientOpen = decodeEditableArtifactLiveClientWireFrame(socket.sent[0]!);
  expect(clientOpen).toMatchObject({
    type: "open",
    token: ticket.token,
    artifactId: ARTIFACT_ID,
    resume: { requireSnapshot: true },
  });
  socket.server({
    type: "open",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-1",
    writable: true,
    headSequence: 0,
    minimumReplaySequence: 1,
    maxClientFrameBytes: 8 * 1024 * 1024 + 64 * 1024,
    maxCommandBytes: 4 * 1024 * 1024,
    maxIntentBytes: 5 * 1024 * 1024,
    maxCommittedTransactionBytes: 8 * 1024 * 1024,
    maxSnapshotBytes: 64 * 1024 * 1024,
    maxInFlightTransactions: 256,
    maxInFlightBytes: 32 * 1024 * 1024,
  });
  const connection = await opening;
  expect(connection.streamEpoch).toBe("epoch-1");
  expect(connection.limits.maxIntentBytes).toBe(5 * 1024 * 1024);

  const bootstrapping = connection.readBootstrap({
    localCursor: null,
    localStateHash: null,
    resume: { modality: "spreadsheet", localCausalFrontier: [] },
    requireSnapshot: true,
    signal: abort.signal,
  });
  socket.server({
    type: "snapshot",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-1",
    sequence: 0,
    stateHash: STATE_ZERO,
    causalFrontier: [],
    digest: DIGEST_ZERO,
    kernelVersion: "artifact-kernel-test",
    modelSchemaVersion: 1,
    offset: 0,
    totalBytes: 1,
    final: true,
    bytes: new Uint8Array([0]),
  });
  socket.server({
    type: "barrier",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-1",
    sequence: 0,
    stateHash: STATE_ZERO,
  });
  expect(await bootstrapping).toMatchObject({
    headSequence: 0,
    headStateHash: STATE_ZERO,
    writable: true,
    snapshot: { bytes: new Uint8Array([0]) },
  });

  const pending = testPending({
    artifactId: ARTIFACT_ID,
    clientTransactionId: "client.transport.1",
    replicaId: REPLICA_ID,
    replicaCounter: 1,
    observedHeadSequence: 0,
    commandBytes: testCommand(new Uint8Array([7])),
    createdAt: 1,
  });
  const submitting = connection.submit({ transaction: pending, signal: abort.signal });
  expect(decodeEditableArtifactLiveClientWireFrame(socket.sent.at(-1)!)).toMatchObject({
    type: "mutation",
    requestHash: pending.requestHash,
  });
  const committed = testCommitted({
    artifactId: ARTIFACT_ID,
    transactionId: testStableId("transport-server-transaction"),
    requestHash: pending.requestHash,
    startSequence: 1,
    endSequence: 1,
    priorStateHash: STATE_ZERO,
    stateHash: testStateHash("transport-state-one"),
    causalFrontier: [{ replicaId: REPLICA_ID, counter: 1 }],
  });
  socket.server({
    type: "mutationAccepted",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-1",
    requestHash: pending.requestHash,
    clientTransactionId: pending.clientTransactionId,
    transactionId: committed.transactionId,
    startSequence: 1,
    endSequence: 1,
    stateHash: committed.stateHash,
  });
  socket.server({
    type: "transaction",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-1",
    transaction: committed,
  });
  const receipt = await submitting;
  expect(receipt).toMatchObject({
    clientTransactionId: pending.clientTransactionId,
    transactionId: committed.transactionId,
    requestHash: pending.requestHash,
  });
  expect(receipt.committed.committedTransactionBytes).toEqual(committed.committedTransactionBytes);
  expect(messages.some((message) => message.type === "transaction.committed")).toBe(true);

  await connection.acknowledge({
    sequence: 1,
    stateHash: committed.stateHash,
    signal: abort.signal,
  });
  expect(decodeEditableArtifactLiveClientWireFrame(socket.sent.at(-1)!)).toMatchObject({
    type: "applied",
    sequence: 1,
    stateHash: committed.stateHash,
  });
  connection.close();
  expect(await connection.closed).toEqual({ reason: "closed" });
});

test("streamed commits become bounded replay pages and advance only after exact applied ACKs", async () => {
  const socket = new FakeSocket(
    "wss://api.example.test/v1/editable-artifacts/live",
    "opengeni-artifact-v1",
  );
  const transport = createEditableArtifactHttpLiveTransport({
    baseUrl: "https://api.example.test",
    workspaceId: "workspace-1",
    protocolVersion: 1,
    kernelVersion: "artifact-kernel-test",
    modelSchemaVersion: 1,
    fetch: globalThis.fetch,
    webSocketFactory: () => socket,
  });
  const abort = new AbortController();
  const messages: EditableArtifactLiveMessage[] = [];
  const opening = transport.openLive({
    ticket: {
      artifactId: ARTIFACT_ID,
      modality: "spreadsheet",
      replicaId: REPLICA_ID,
      token: "one_use_ticket_2",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      protocolVersion: 1,
    },
    after: 0,
    stateHash: STATE_ZERO,
    resume: { modality: "spreadsheet", causalFrontier: [] },
    requireSnapshot: false,
    signal: abort.signal,
    onMessage: (message) => messages.push(message),
  });
  socket.open();
  socket.server({
    type: "open",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-2",
    writable: true,
    headSequence: 2,
    minimumReplaySequence: 1,
    maxClientFrameBytes: 8 * 1024 * 1024 + 64 * 1024,
    maxCommandBytes: 4 * 1024 * 1024,
    maxIntentBytes: 5 * 1024 * 1024,
    maxCommittedTransactionBytes: 8 * 1024 * 1024,
    maxSnapshotBytes: 64 * 1024 * 1024,
    maxInFlightTransactions: 1,
    maxInFlightBytes: 8 * 1024 * 1024,
  });
  const connection = await opening;
  const retriedPending = testPending({
    artifactId: ARTIFACT_ID,
    clientTransactionId: "client.transport.retried",
    replicaId: REPLICA_ID,
    replicaCounter: 1,
    observedHeadSequence: 0,
    commandBytes: testCommand(new Uint8Array([4])),
    createdAt: 1,
  });
  const first = testCommitted({
    artifactId: ARTIFACT_ID,
    transactionId: testStableId("transport-replay-one"),
    requestHash: retriedPending.requestHash,
    startSequence: 1,
    endSequence: 1,
    priorStateHash: STATE_ZERO,
    stateHash: testStateHash("transport-replay-state-one"),
    causalFrontier: [{ replicaId: REPLICA_ID, counter: 1 }],
  });
  const bootstrapping = connection.readBootstrap({
    localCursor: 0,
    localStateHash: STATE_ZERO,
    resume: { modality: "spreadsheet", localCausalFrontier: [] },
    requireSnapshot: false,
    signal: abort.signal,
  });
  socket.server({
    type: "transaction",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-2",
    transaction: first,
  });
  expect(await bootstrapping).toMatchObject({
    headSequence: 0,
    headStateHash: STATE_ZERO,
    snapshot: null,
  });
  expect(messages.filter((message) => message.type === "transaction.committed")).toHaveLength(0);
  const firstPage = await connection.replay({
    after: 0,
    through: 2,
    limit: 1,
    signal: abort.signal,
  });
  expect(firstPage.transactions.map((transaction) => transaction.transactionId)).toEqual([
    first.transactionId,
  ]);
  await connection.acknowledge({ sequence: 1, stateHash: first.stateHash, signal: abort.signal });

  // The original unknown-outcome commit was replayed and ACKed before the WAL
  // retry. Its idempotent response repeats exact OGACO evidence before mapping
  // the client identity, so no heuristic transaction history is required.
  const retrying = connection.submit({ transaction: retriedPending, signal: abort.signal });
  socket.server({
    type: "transaction",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-2",
    transaction: first,
  });
  socket.server({
    type: "mutationAccepted",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-2",
    requestHash: retriedPending.requestHash,
    clientTransactionId: retriedPending.clientTransactionId,
    transactionId: first.transactionId,
    startSequence: first.startSequence,
    endSequence: first.endSequence,
    stateHash: first.stateHash,
  });
  expect(await retrying).toMatchObject({
    clientTransactionId: retriedPending.clientTransactionId,
    transactionId: first.transactionId,
    committed: { committedTransactionBytes: first.committedTransactionBytes },
  });

  const second = testCommitted({
    artifactId: ARTIFACT_ID,
    transactionId: testStableId("transport-replay-two"),
    requestHash: testStateHash("transport-replay-request-two"),
    startSequence: 2,
    endSequence: 2,
    priorStateHash: first.stateHash,
    stateHash: testStateHash("transport-replay-state-two"),
    causalFrontier: [{ replicaId: REPLICA_ID, counter: 2 }],
  });
  socket.server({
    type: "transaction",
    protocolVersion: 1,
    artifactId: ARTIFACT_ID,
    streamEpoch: "epoch-2",
    transaction: second,
  });
  const secondPage = await connection.replay({
    after: 1,
    through: 2,
    limit: 1,
    signal: abort.signal,
  });
  expect(secondPage.transactions.map((transaction) => transaction.transactionId)).toEqual([
    second.transactionId,
  ]);
  expect(messages.filter((message) => message.type === "transaction.committed")).toHaveLength(2);
  connection.close();
});

class FakeSocket implements EditableArtifactWebSocketLike {
  binaryType = "blob";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  private readonly listeners = {
    open: new Set<() => void>(),
    message: new Set<(event: EditableArtifactWebSocketMessageEvent) => void>(),
    error: new Set<() => void>(),
    close: new Set<(event: EditableArtifactWebSocketCloseEvent) => void>(),
  };

  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {}

  send(data: Uint8Array | ArrayBuffer): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.sent.push(bytes.slice());
  }

  close(_code?: number, reason = "closed"): void {
    this.readyState = 3;
    for (const listener of this.listeners.close) listener({ reason });
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.open) listener();
  }

  server(frame: Parameters<typeof encodeEditableArtifactLiveServerWireFrame>[0]): void {
    const bytes = encodeEditableArtifactLiveServerWireFrame(frame);
    const buffer = bytes.slice().buffer;
    for (const listener of this.listeners.message) listener({ data: buffer });
  }

  addEventListener(type: "open" | "message" | "error" | "close", listener: never): void {
    (this.listeners[type] as Set<never>).add(listener);
  }

  removeEventListener(type: "open" | "message" | "error" | "close", listener: never): void {
    (this.listeners[type] as Set<never>).delete(listener);
  }
}
