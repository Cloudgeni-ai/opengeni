import { expect, test } from "bun:test";
import {
  NATIVE_BROKER_PROVIDER_INPUT_MAX_INDEX,
  acceptNativeBrokerInput,
  advanceNativeBrokerWriter,
  initialNativeBrokerInput,
  markNativeBrokerInputDispatchIntent,
  markNativeBrokerProviderAcknowledged,
  pendingNativeBrokerProviderWrite,
  reserveNativeBrokerInput,
  type NativeBrokerInputSnapshot,
  type NativeBrokerRequest,
} from "../src/sandbox/providers/native-command-broker-input";
import {
  NativeBrokerFrameDecoder,
  type NativeBrokerFrame,
} from "../src/sandbox/providers/native-command-broker-wire";

const broker = "18b5623a-1b82-4d0f-937c-9f494bf01d23";
const command = "28b5623a-1b82-4d0f-937c-9f494bf01d23";
const requestId = "38b5623a-1b82-4d0f-937c-9f494bf01d23";
function request(kind: NativeBrokerRequest["kind"] = "fence"): NativeBrokerRequest {
  return {
    requestId,
    commandId: kind === "fence" ? null : command,
    kind,
    offset: 0,
    payload: kind === "fence" ? new Uint8Array() : Buffer.from("sensitive input\0\xff"),
  };
}
function ack(state: NativeBrokerInputSnapshot): NativeBrokerFrame {
  const decoder = new NativeBrokerFrameDecoder(broker);
  const [frame] = decoder.push(Buffer.from(state.pending!.frameBase64, "base64"));
  decoder.finish();
  return {
    ...frame!,
    direction: "response",
    kind: "accepted",
    sequence: 49,
    offset: frame!.sequence,
    payload: new Uint8Array(),
  };
}
function ready(): NativeBrokerInputSnapshot {
  const reserved = reserveNativeBrokerInput(initialNativeBrokerInput(broker), 1, request());
  const dispatched = markNativeBrokerInputDispatchIntent(reserved, 1);
  return acceptNativeBrokerInput(dispatched, 1, ack(dispatched));
}

test("initial owner must fence before command input and a reservation cannot be dispatched", () => {
  const initial = initialNativeBrokerInput(broker);
  expect(() => reserveNativeBrokerInput(initial, 1, request("launch"))).toThrow();
  const reserved = reserveNativeBrokerInput(initial, 1, request());
  expect(initial.pending).toBeNull();
  expect(reserved.revision).toBe(1);
  expect(() => pendingNativeBrokerProviderWrite(reserved, 1)).toThrow();
  expect(() => markNativeBrokerProviderAcknowledged(reserved, 1)).toThrow();
  expect(() => acceptNativeBrokerInput(reserved, 1, ack(reserved))).toThrow();
  const dispatched = markNativeBrokerInputDispatchIntent(reserved, 1);
  expect(pendingNativeBrokerProviderWrite(dispatched, 1).index).toBe(1);
  expect(pendingNativeBrokerProviderWrite(dispatched, 1).eof).toBe(false);
});

test("provider RPC acknowledgement never unblocks another index", () => {
  const reserved = reserveNativeBrokerInput(ready(), 1, request("stdin"));
  const sent = markNativeBrokerInputDispatchIntent(reserved, 1);
  const providerAck = markNativeBrokerProviderAcknowledged(sent, 1);
  expect(providerAck.pending?.phase).toBe("provider_acknowledged");
  expect(providerAck.lastAcceptedInputIndex).toBe(1);
  expect(() => reserveNativeBrokerInput(providerAck, 1, request("stdin"))).toThrow();
  const accepted = acceptNativeBrokerInput(providerAck, 1, ack(providerAck));
  expect(accepted.lastAcceptedInputIndex).toBe(2);
  expect(accepted.pending).toBeNull();
  expect(accepted.acceptedWriterEpoch).toBe(1);
});

test("uncertain dispatch and reconnect preserve the original exact bytes and index", () => {
  const sent = markNativeBrokerInputDispatchIntent(
    reserveNativeBrokerInput(ready(), 1, request("launch")),
    1,
  );
  const original = pendingNativeBrokerProviderWrite(sent, 1);
  const restored = JSON.parse(JSON.stringify(sent));
  const replay = pendingNativeBrokerProviderWrite(restored, 1);
  expect(replay).toEqual(original);
  replay.input.fill(0);
  expect(pendingNativeBrokerProviderWrite(restored, 1)).toEqual(original);
  expect(markNativeBrokerInputDispatchIntent(restored, 1)).toEqual(sent);
  expect(() => reserveNativeBrokerInput(restored, 1, request("control"))).toThrow();
});

test.each(["reserved", "dispatch_intent", "provider_acknowledged"] as const)(
  "takeover preserves pending %s input before a new epoch fence",
  (phase) => {
    let state = reserveNativeBrokerInput(ready(), 1, request("stdin"));
    if (phase !== "reserved") state = markNativeBrokerInputDispatchIntent(state, 1);
    if (phase === "provider_acknowledged") state = markNativeBrokerProviderAcknowledged(state, 1);
    const pending = structuredClone(state.pending);
    state = advanceNativeBrokerWriter(state, 1);
    expect(state.writerEpoch).toBe(2);
    expect(state.pending).toEqual(pending);
    expect(() => reserveNativeBrokerInput(state, 2, request())).toThrow();
    state = markNativeBrokerInputDispatchIntent(state, 2);
    const replay = pendingNativeBrokerProviderWrite(state, 2);
    expect(Buffer.from(replay.input).toString()).toContain(`\t${broker}\t1\t2\t`);
    expect(() => pendingNativeBrokerProviderWrite(state, 1)).toThrow();
    state = acceptNativeBrokerInput(state, 2, ack(state));
    expect(state.acceptedWriterEpoch).toBe(1);
    expect(() => reserveNativeBrokerInput(state, 2, request("launch"))).toThrow();
    state = markNativeBrokerInputDispatchIntent(reserveNativeBrokerInput(state, 2, request()), 2);
    expect(state.pending?.providerInputIndex).toBe(3);
    state = acceptNativeBrokerInput(state, 2, ack(state));
    expect(state.acceptedWriterEpoch).toBe(2);
    expect(reserveNativeBrokerInput(state, 2, request("launch")).pending?.providerInputIndex).toBe(
      4,
    );
  },
);

test("takeover during an unaccepted fence does not replace its request or skip the old fence", () => {
  let state = markNativeBrokerInputDispatchIntent(
    reserveNativeBrokerInput(initialNativeBrokerInput(broker), 1, request()),
    1,
  );
  const original = pendingNativeBrokerProviderWrite(state, 1);
  state = advanceNativeBrokerWriter(state, 1);
  state = advanceNativeBrokerWriter(state, 2);
  expect(pendingNativeBrokerProviderWrite(state, 3)).toEqual(original);
  state = acceptNativeBrokerInput(state, 3, ack(state));
  expect(state.acceptedWriterEpoch).toBe(1);
  state = markNativeBrokerInputDispatchIntent(reserveNativeBrokerInput(state, 3, request()), 3);
  state = acceptNativeBrokerInput(state, 3, ack(state));
  expect(state.acceptedWriterEpoch).toBe(3);
});

test("stale writers cannot reserve, mark, accept or obtain dispatch bytes", () => {
  let state = markNativeBrokerInputDispatchIntent(
    reserveNativeBrokerInput(ready(), 1, request("stdin")),
    1,
  );
  const accepted = ack(state);
  state = advanceNativeBrokerWriter(state, 1);
  for (const operation of [
    () => advanceNativeBrokerWriter(state, 1),
    () => reserveNativeBrokerInput(state, 1, request()),
    () => markNativeBrokerInputDispatchIntent(state, 1),
    () => markNativeBrokerProviderAcknowledged(state, 1),
    () => acceptNativeBrokerInput(state, 1, accepted),
    () => pendingNativeBrokerProviderWrite(state, 1),
  ])
    expect(operation).toThrow();
});

test("only exact broker acceptance, not status/output/another command, clears pending input", () => {
  const state = markNativeBrokerInputDispatchIntent(
    reserveNativeBrokerInput(ready(), 1, request("launch")),
    1,
  );
  const accepted = ack(state);
  for (const patch of [
    { kind: "status" },
    { kind: "stdout" },
    { brokerId: command },
    { requestId: command },
    { commandId: broker },
    { ownerEpoch: 2 },
    { offset: 1 },
    { offset: 3 },
    { payload: Buffer.from("quiescent") },
    { direction: "request" },
    { sequence: 0 },
  ])
    expect(() =>
      acceptNativeBrokerInput(state, 1, { ...accepted, ...patch } as NativeBrokerFrame),
    ).toThrow();
  expect(state.pending?.phase).toBe("dispatch_intent");
});

test("malformed or tampered durable snapshots never yield dispatch bytes", () => {
  const state = markNativeBrokerInputDispatchIntent(
    reserveNativeBrokerInput(ready(), 1, request("launch")),
    1,
  );
  for (const patch of [
    { revision: -1 },
    { writerEpoch: 0 },
    { acceptedWriterEpoch: 2 },
    { lastReservedInputIndex: 3 },
    { lastAcceptedInputIndex: 0 },
    { lastAcceptedInputIndex: 3 },
    { pending: null },
    { unexpected: true },
    { pending: { ...state.pending, providerInputIndex: 1 } },
    { pending: { ...state.pending, frameSha256: "0".repeat(64) } },
    { pending: { ...state.pending, frameBase64: state.pending!.frameBase64 + "\n" } },
  ])
    expect(() =>
      pendingNativeBrokerProviderWrite({ ...state, ...patch } as NativeBrokerInputSnapshot, 1),
    ).toThrow();
});

test("provider uint32 index and epoch/revision exhaustion refuse instead of wrapping", () => {
  const high = {
    ...ready(),
    lastReservedInputIndex: NATIVE_BROKER_PROVIDER_INPUT_MAX_INDEX - 1,
    lastAcceptedInputIndex: NATIVE_BROKER_PROVIDER_INPUT_MAX_INDEX - 1,
  };
  let state = markNativeBrokerInputDispatchIntent(
    reserveNativeBrokerInput(high, 1, request("control")),
    1,
  );
  expect(pendingNativeBrokerProviderWrite(state, 1).index).toBe(0xffff_ffff);
  state = acceptNativeBrokerInput(state, 1, ack(state));
  expect(() => reserveNativeBrokerInput(state, 1, request("control"))).toThrow();
  expect(() =>
    advanceNativeBrokerWriter(
      { ...ready(), writerEpoch: Number.MAX_SAFE_INTEGER },
      Number.MAX_SAFE_INTEGER,
    ),
  ).toThrow();
  expect(() =>
    reserveNativeBrokerInput(
      { ...ready(), revision: Number.MAX_SAFE_INTEGER },
      1,
      request("stdin"),
    ),
  ).toThrow();
});

test("fences have an empty broker-only body and cannot substitute for command EOF", () => {
  for (const patch of [{ commandId: command }, { offset: 1 }, { payload: Buffer.from("payload") }])
    expect(() =>
      reserveNativeBrokerInput(initialNativeBrokerInput(broker), 1, { ...request(), ...patch }),
    ).toThrow();
  expect(() => reserveNativeBrokerInput(ready(), 1, request())).toThrow();
  const state = markNativeBrokerInputDispatchIntent(
    reserveNativeBrokerInput(ready(), 1, { ...request("eof"), payload: new Uint8Array() }),
    1,
  );
  expect(pendingNativeBrokerProviderWrite(state, 1).eof).toBe(false);
});

test("request mutation after reservation cannot alter replay, and errors do not expose input", () => {
  const input = request("stdin");
  const reserved = reserveNativeBrokerInput(ready(), 1, input);
  input.payload.fill(42);
  input.requestId = command;
  const state = markNativeBrokerInputDispatchIntent(reserved, 1);
  expect(Buffer.from(pendingNativeBrokerProviderWrite(state, 1).input).toString()).toContain(
    requestId,
  );
  try {
    reserveNativeBrokerInput(state, 1, request("stdin"));
  } catch (error) {
    expect(String(error)).not.toContain("sensitive");
    expect(String(error)).not.toContain(requestId);
  }
});
