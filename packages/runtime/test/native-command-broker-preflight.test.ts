import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { NativeBrokerPreflightCollector } from "../src/sandbox/providers/native-command-broker-preflight";
import {
  encodeNativeBrokerFrame,
  type NativeBrokerFrame,
} from "../src/sandbox/providers/native-command-broker-wire";

const brokerId = "756fb5ab-6bd9-444a-aac2-b65c74e54d72";
const payload = Buffer.from(Array.from({ length: 10000 }, (_, index) => index % 256));
const expected = {
  artifactSha256: createHash("sha256").update(payload).digest("hex"),
  byteSize: payload.length,
  target: "linux-amd64" as const,
};
const hello = {
  protocol: "native-command-broker-preflight-v1",
  state: "preflight_only",
  sealedExec: "execveat",
  pipeCapability: "native-subreaper-v1",
  ptyCapability: "native-subreaper-pty-v1",
  artifact: {
    protocol: "native-artifact-keeper-v1",
    byteSize: payload.length,
    seals: 15,
    target: "linux-amd64",
    static: true,
    device: "5",
    inode: "123",
  },
};
const end = { preflightComplete: true, commandAdmission: false };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function frame(
  sequence: number,
  kind: "hello" | "artifact" | "exit",
  bytes: Uint8Array,
  offset = 0,
): NativeBrokerFrame {
  return {
    direction: "response",
    brokerId,
    ownerEpoch: 1,
    sequence,
    requestId: brokerId,
    commandId: null,
    kind,
    offset,
    payload: bytes,
  };
}
function frames(): NativeBrokerFrame[] {
  return [
    frame(1, "hello", json(hello)),
    frame(2, "artifact", payload.subarray(0, 8192)),
    frame(3, "artifact", payload.subarray(8192), 8192),
    frame(4, "exit", json(end)),
  ];
}
function transcript(items = frames()) {
  return Buffer.concat(items.map(encodeNativeBrokerFrame));
}
function feed(collector: NativeBrokerPreflightCollector, items = frames()) {
  collector.push("stdout", transcript(items));
}

test("preflight hashes exact artifact bytes, requires process exit, and grants no command admission", () => {
  const collector = new NativeBrokerPreflightCollector(brokerId, expected);
  feed(collector);
  const result = collector.finish(0);
  expect(result).toEqual({
    protocol: "native-command-broker-preflight-v1",
    brokerId,
    ...expected,
    device: "5",
    inode: "123",
    frameCount: 4,
    initialProcessExitCode: 0,
    commandAdmission: false,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(() => collector.push("stdout", new Uint8Array())).toThrow();
  expect(() => collector.finish(0)).toThrow();
});

test("every frame split, including UTF-8/base64 boundaries, preserves exact observation", () => {
  const bytes = transcript();
  for (const split of [1, 2, 3, 9, 67, 8191, 8192, bytes.length - 1]) {
    const collector = new NativeBrokerPreflightCollector(brokerId, expected);
    collector.push("stdout", bytes.subarray(0, split));
    collector.push("stderr", new Uint8Array());
    collector.push("stdout", bytes.subarray(split));
    expect(collector.finish(0).artifactSha256).toBe(expected.artifactSha256);
  }
});

test.each([null, 1, 125, 137, Number.NaN])(
  "log exit frame is insufficient without independently observed exit zero: %s",
  (exit) => {
    const collector = new NativeBrokerPreflightCollector(brokerId, expected);
    feed(collector);
    expect(() => collector.finish(exit)).toThrow();
    expect(() => collector.finish(0)).toThrow();
  },
);

test("pin is defensively copied; declared capability identity cannot replace the exact digest", () => {
  const pin = { ...expected, artifactSha256: "a".repeat(64) };
  const collector = new NativeBrokerPreflightCollector(brokerId, pin);
  pin.artifactSha256 = expected.artifactSha256;
  feed(collector);
  expect(() => collector.finish(0)).toThrow();
});

test.each([
  (items: NativeBrokerFrame[]) => {
    items[1]!.sequence = 3;
  },
  (items: NativeBrokerFrame[]) => {
    items[2]!.offset--;
  },
  (items: NativeBrokerFrame[]) => {
    items[2]!.offset++;
  },
  (items: NativeBrokerFrame[]) => {
    items[1]!.commandId = brokerId;
  },
  (items: NativeBrokerFrame[]) => {
    items[1]!.ownerEpoch = 2;
  },
  (items: NativeBrokerFrame[]) => {
    items[1]!.requestId = "2d01c847-bffd-4298-9c9a-8574e18dfb90";
  },
  (items: NativeBrokerFrame[]) => {
    items[1]!.payload = new Uint8Array();
  },
  (items: NativeBrokerFrame[]) => {
    items.splice(2, 1);
    items[2]!.sequence = 3;
  },
  (items: NativeBrokerFrame[]) => {
    items[3]!.payload = json({ ...end, commandAdmission: true });
  },
  (items: NativeBrokerFrame[]) => {
    items[3]!.payload = json({ ...end, receipt: "fabricated" });
  },
  (items: NativeBrokerFrame[]) => {
    items[3]!.offset = 1;
  },
  (items: NativeBrokerFrame[]) => {
    items[0]!.payload = json({ ...hello, artifact: { ...hello.artifact, static: false } });
  },
  (items: NativeBrokerFrame[]) => {
    items[0]!.payload = json({ ...hello, artifact: { ...hello.artifact, seals: 7 } });
  },
  (items: NativeBrokerFrame[]) => {
    items[0]!.payload = json({
      ...hello,
      artifact: { ...hello.artifact, inode: "18446744073709551616" },
    });
  },
  (items: NativeBrokerFrame[]) => {
    items[0]!.payload = json({ ...hello, artifact: { ...hello.artifact, target: "linux-arm64" } });
  },
  (items: NativeBrokerFrame[]) => {
    items[0]!.payload = json({ ...hello, artifact: { ...hello.artifact, byteSize: 10 } });
  },
])("malformed, mismatched or out-of-order preflight poisons the collector", (mutate) => {
  const collector = new NativeBrokerPreflightCollector(brokerId, expected);
  const items = frames();
  mutate(items);
  expect(() => feed(collector, items)).toThrow();
  expect(() => feed(collector)).toThrow();
  expect(() => collector.finish(0)).toThrow();
});

test("duplicate/replayed or additional frames cannot manufacture a clean transcript", () => {
  for (const items of [
    [...frames(), frame(5, "exit", json(end))],
    [frames()[0]!, ...frames()],
  ]) {
    const collector = new NativeBrokerPreflightCollector(brokerId, expected);
    expect(() => feed(collector, items)).toThrow();
  }
});

test("partial EOF, stderr contamination and payload substitution fail without leaking content", () => {
  const partial = new NativeBrokerPreflightCollector(brokerId, expected);
  partial.push("stdout", transcript().subarray(0, -1));
  expect(() => partial.finish(0)).toThrow();
  const stderr = new NativeBrokerPreflightCollector(brokerId, expected);
  expect(() => stderr.push("stderr", Buffer.from("private sentinel"))).toThrow(
    "Native broker preflight evidence is invalid or incomplete",
  );
  const corrupt = new NativeBrokerPreflightCollector(brokerId, expected);
  const items = frames();
  items[1]!.payload = Uint8Array.from(items[1]!.payload);
  items[1]!.payload[0] = 99;
  feed(corrupt, items);
  expect(() => corrupt.finish(0)).toThrow();
});

test("unbounded pins cannot allocate artifact retention", () => {
  for (const byteSize of [0, 63, 262145, Number.POSITIVE_INFINITY])
    expect(() => new NativeBrokerPreflightCollector(brokerId, { ...expected, byteSize })).toThrow();
});
