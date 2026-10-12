import { expect, test } from "bun:test";
import {
  encodeNativeBrokerFrame,
  NativeBrokerFrameDecoder,
  NATIVE_BROKER_FRAME_MAX_BYTES,
  NATIVE_BROKER_INPUT_MAX_BYTES,
  NATIVE_BROKER_PAYLOAD_MAX_BYTES,
  type NativeBrokerFrame,
} from "../src/sandbox/providers/native-command-broker-wire";

const brokerId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const commandId = "33333333-3333-4333-8333-333333333333";
function frame(payload: Uint8Array = new Uint8Array()): NativeBrokerFrame {
  return {
    direction: "response",
    kind: "stdout",
    brokerId,
    requestId,
    commandId,
    ownerEpoch: 1,
    sequence: 1,
    offset: 0,
    payload,
  };
}
function rewrite(index: number, value: string): Uint8Array {
  const fields = Buffer.from(encodeNativeBrokerFrame(frame())).toString().trimEnd().split("\t");
  // The payload field is intentionally empty in this fixture.
  while (fields.length < 12) fields.push("");
  fields[index] = value;
  return Buffer.from(`${fields.join("\t")}\n`);
}

test("broker frames preserve arbitrary binary output without interpreting child text", () => {
  const payload = Buffer.from([0, 255, 128, 13, 10, 9, 34]);
  const value = frame(payload);
  const decoded = new NativeBrokerFrameDecoder(brokerId).push(encodeNativeBrokerFrame(value));
  expect(decoded).toEqual([value]);
  const forged = frame(Buffer.from('OGB1\tresponse\n{"state":"quiescent"}'));
  expect(
    new NativeBrokerFrameDecoder(brokerId).push(encodeNativeBrokerFrame(forged))[0]?.kind,
  ).toBe("stdout");
});

test("every byte boundary may split a frame and the bounded suffix survives reconnect", () => {
  const bytes = encodeNativeBrokerFrame(frame(Buffer.from("α\n🦎\u0000")));
  for (let split = 0; split < bytes.length; split++) {
    const first = new NativeBrokerFrameDecoder(brokerId);
    expect(first.push(bytes.subarray(0, split))).toEqual([]);
    const recovered = new NativeBrokerFrameDecoder(brokerId, first.snapshot());
    expect(recovered.push(bytes.subarray(split))).toEqual([frame(Buffer.from("α\n🦎\u0000"))]);
    recovered.finish();
  }
});

test("many frames and a partial suffix remain distinct from durable cursor acknowledgement", () => {
  const one = encodeNativeBrokerFrame(frame(Buffer.from("one")));
  const two = encodeNativeBrokerFrame({ ...frame(Buffer.from("two")), sequence: 2, offset: 3 });
  const decoder = new NativeBrokerFrameDecoder(brokerId);
  expect(decoder.push(Buffer.concat([one, two.subarray(0, 17)]))).toEqual([
    frame(Buffer.from("one")),
  ]);
  expect(decoder.snapshot()).toEqual(two.subarray(0, 17));
  expect(decoder.push(two.subarray(17))[0]?.sequence).toBe(2);
  decoder.finish();
});

test("framing exposes exact replays instead of silently discarding their evidence", () => {
  const bytes = encodeNativeBrokerFrame(frame());
  expect(new NativeBrokerFrameDecoder(brokerId).push(Buffer.concat([bytes, bytes]))).toHaveLength(
    2,
  );
});

test.each([
  [0, "OGB2"],
  [1, "user"],
  [2, commandId],
  [3, "0"],
  [3, "01"],
  [3, "1e2"],
  [4, "-1"],
  [4, "9007199254740992"],
  [5, "not-a-uuid"],
  [6, "bad-command"],
  [7, "launch"],
  [8, "-1"],
  [9, "1"],
  [10, "utf8"],
  [11, "===="],
  [11, "\r"],
])("malformed closed header field %s is rejected and poisons the decoder", (index, value) => {
  const decoder = new NativeBrokerFrameDecoder(brokerId);
  expect(() => decoder.push(rewrite(index as number, value as string))).toThrow(
    "invalid or exceeds",
  );
  expect(() => decoder.push(encodeNativeBrokerFrame(frame()))).toThrow("invalid or exceeds");
  expect(() => decoder.snapshot()).toThrow();
});

test("noncanonical base64 pad bits and embedded whitespace are refused", () => {
  const valid = Buffer.from(encodeNativeBrokerFrame(frame(Buffer.from("a")))).toString();
  for (const payload of ["YR==", "YQ", "Y Q==", "YQ===", "YQ==\t"]) {
    expect(() =>
      new NativeBrokerFrameDecoder(brokerId).push(Buffer.from(valid.replace("YQ==", payload))),
    ).toThrow();
  }
});

test("exact binary payload bound passes and larger payload never allocates a wire frame", () => {
  const bytes = new Uint8Array(NATIVE_BROKER_PAYLOAD_MAX_BYTES).fill(255);
  expect(
    new NativeBrokerFrameDecoder(brokerId).push(encodeNativeBrokerFrame(frame(bytes)))[0]?.payload,
  ).toEqual(bytes);
  expect(() =>
    encodeNativeBrokerFrame(frame(new Uint8Array(NATIVE_BROKER_PAYLOAD_MAX_BYTES + 1))),
  ).toThrow();
});

test("offset arithmetic cannot overflow safe integer precision", () => {
  expect(() =>
    encodeNativeBrokerFrame({ ...frame(Buffer.from("x")), offset: Number.MAX_SAFE_INTEGER }),
  ).toThrow();
  const value = { ...frame(Buffer.from("x")), offset: Number.MAX_SAFE_INTEGER - 1 };
  expect(new NativeBrokerFrameDecoder(brokerId).push(encodeNativeBrokerFrame(value))).toEqual([
    value,
  ]);
});

test("input and incomplete-frame bounds fail closed without scanning to a later marker", () => {
  expect(() =>
    new NativeBrokerFrameDecoder(brokerId).push(new Uint8Array(NATIVE_BROKER_INPUT_MAX_BYTES + 1)),
  ).toThrow();
  const decoder = new NativeBrokerFrameDecoder(brokerId);
  expect(() => decoder.push(Buffer.alloc(NATIVE_BROKER_FRAME_MAX_BYTES, 65))).toThrow();
  expect(() => decoder.push(encodeNativeBrokerFrame(frame()))).toThrow();
});

test("partial state is copied and never aliases caller memory", () => {
  const original = Buffer.from("OGB1");
  const decoder = new NativeBrokerFrameDecoder(brokerId, original);
  original.fill(0);
  const snapshot = decoder.snapshot();
  expect(Buffer.from(snapshot).toString()).toBe("OGB1");
  snapshot.fill(0);
  expect(Buffer.from(decoder.snapshot()).toString()).toBe("OGB1");
});

test("line breaks, non-ASCII and incomplete EOF cannot be mistaken for valid frames", () => {
  for (const bytes of [Buffer.from("\n"), Buffer.from([128]), Buffer.from("OGB1\r")]) {
    expect(() => new NativeBrokerFrameDecoder(brokerId).push(bytes)).toThrow();
  }
  const decoder = new NativeBrokerFrameDecoder(brokerId);
  decoder.push(Buffer.from("OGB1"));
  expect(() => decoder.finish()).toThrow();
  expect(() => decoder.push(encodeNativeBrokerFrame(frame()))).toThrow();
});

test("request and response kind sets are closed independently", () => {
  const request: NativeBrokerFrame = {
    ...frame(),
    direction: "request",
    kind: "fence",
    commandId: null,
  };
  expect(new NativeBrokerFrameDecoder(brokerId).push(encodeNativeBrokerFrame(request))).toEqual([
    request,
  ]);
  expect(() => encodeNativeBrokerFrame({ ...request, kind: "stdout" } as never)).toThrow();
});
