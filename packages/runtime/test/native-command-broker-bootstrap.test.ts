import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyNativeBrokerBootstrap } from "../src/sandbox/providers/native-command-broker-bootstrap";
import type { NativeBrokerFrame } from "../src/sandbox/providers/native-command-broker-wire";

const brokerId = "54f6dfdf-ae52-469c-b926-253f49213288";
const binary = Buffer.alloc(10000, 23);
const pin = {
  artifactSha256: createHash("sha256").update(binary).digest("hex"),
  byteSize: binary.length,
  target: "linux-amd64" as const,
};
const hello = {
  protocol: "native-command-broker-v1",
  sealedExec: "execveat",
  pipeCapability: "native-subreaper-broker-channel-v1",
  ptyCapability: "native-subreaper-broker-channel-pty-v1",
  artifact: { byteSize: binary.length, target: pin.target, seals: 15, device: "5", inode: "20" },
};
function frames(): NativeBrokerFrame[] {
  return [
    { kind: "hello", offset: 0, payload: Buffer.from(JSON.stringify(hello)) },
    { kind: "artifact", offset: 0, payload: binary.subarray(0, 8192) },
    { kind: "artifact", offset: 8192, payload: binary.subarray(8192) },
  ].map((frame, index) => ({
    direction: "response",
    brokerId,
    ownerEpoch: 1,
    sequence: index + 1,
    requestId: brokerId,
    commandId: null,
    ...frame,
  })) as NativeBrokerFrame[];
}
test("ongoing broker bootstrap verifies actual bytes, exact identity and protocol without claiming admission", () => {
  const result = verifyNativeBrokerBootstrap(brokerId, pin, frames());
  expect(result).toMatchObject({
    protocol: "native-command-broker-v1",
    artifactSha256: pin.artifactSha256,
    byteSize: 10000,
    device: "5",
    inode: "20",
    seals: 15,
    lastSequence: 3,
    commandAdmission: false,
  });
  expect(result.transcriptSha256).toMatch(/^[a-f0-9]{64}$/);
});
test("incomplete, substituted and extra transcripts cannot establish bootstrap", () => {
  expect(() => verifyNativeBrokerBootstrap(brokerId, pin, frames().slice(0, 2))).toThrow();
  expect(() =>
    verifyNativeBrokerBootstrap(brokerId, { ...pin, artifactSha256: "f".repeat(64) }, frames()),
  ).toThrow();
  expect(() => verifyNativeBrokerBootstrap(brokerId, pin, [...frames(), frames()[2]!])).toThrow();
  expect(() => verifyNativeBrokerBootstrap(crypto.randomUUID(), pin, frames())).toThrow();
});
test.each([
  { sequence: 5 },
  { ownerEpoch: 2 },
  { requestId: "5030d92e-429e-4ccf-b661-d82691327953" },
  { commandId: brokerId },
  { kind: "stdout" },
  { offset: 1 },
  { payload: Buffer.alloc(0) },
])("changed artifact frame fails: %j", (change) => {
  const values = frames();
  values[1] = { ...values[1]!, ...change } as NativeBrokerFrame;
  expect(() => verifyNativeBrokerBootstrap(brokerId, pin, values)).toThrow();
});
test.each([
  { protocol: "native-command-broker-preflight-v1" },
  { sealedExec: "path" },
  { pipeCapability: "native-subreaper-v1" },
  { ptyCapability: "native-subreaper-pty-v1" },
  { artifact: { ...hello.artifact, seals: 7 } },
  { artifact: { ...hello.artifact, inode: "0" } },
  { artifact: { ...hello.artifact, inode: "18446744073709551616" } },
  { artifact: { ...hello.artifact, target: "linux-arm64" } },
  { artifact: { ...hello.artifact, byteSize: binary.length - 1 } },
  { extra: true },
])("unknown or incompatible hello facts fail: %j", (change) => {
  const values = frames();
  values[0]!.payload = Buffer.from(JSON.stringify({ ...hello, ...change }));
  expect(() => verifyNativeBrokerBootstrap(brokerId, pin, values)).toThrow();
});
