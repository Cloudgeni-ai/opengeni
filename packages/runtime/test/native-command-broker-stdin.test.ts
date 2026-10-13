import { expect, test } from "bun:test";
import {
  createNativeBrokerStdinPlan,
  parseNativeBrokerStdinPlan,
  nativeBrokerStdinChunk,
  nativeBrokerStdinChunkRequestId,
  NATIVE_BROKER_STDIN_PAGE_BYTES,
} from "../src/sandbox/providers/native-command-broker-stdin";
const input = () => ({
  sessionId: crypto.randomUUID(),
  processId: crypto.randomUUID(),
  admissionId: crypto.randomUUID(),
  commandId: crypto.randomUUID(),
});

test("chunked stdin preserves complete binary and split UTF-8 bytes across storage and frame boundaries", () => {
  const scope = input();
  const bytes = Buffer.concat([Buffer.from("€🌍\0".repeat(10_000)), Buffer.from([0xff, 0xc0, 0])]);
  const plan = createNativeBrokerStdinPlan(scope, 37, bytes);
  const chunks = [];
  const ids = new Set<string>();
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    const start =
      Math.floor(offset / NATIVE_BROKER_STDIN_PAGE_BYTES) * NATIVE_BROKER_STDIN_PAGE_BYTES;
    const part = nativeBrokerStdinChunk(
      plan,
      offset,
      bytes.subarray(start, start + NATIVE_BROKER_STDIN_PAGE_BYTES).toString("base64"),
    );
    expect(part.offset).toBe(37 + offset);
    expect(part.payload.length).toBeLessThanOrEqual(8192);
    expect(part.requestId).not.toBe(scope.admissionId);
    expect(part.requestId).toBe(nativeBrokerStdinChunkRequestId(scope.admissionId, offset));
    ids.add(part.requestId);
    chunks.push(part.payload);
  }
  expect(ids.size).toBe(chunks.length);
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(plan.byteLength).toBe(bytes.length);
});

test("plans bind the original scope, range and finite size; malformed chunks cannot truncate bytes", () => {
  const scope = input(),
    bytes = Buffer.alloc(9000, 0x61);
  const plan = createNativeBrokerStdinPlan(scope, 0, bytes);
  for (const name of ["sessionId", "processId", "admissionId", "commandId"] as const)
    expect(() =>
      parseNativeBrokerStdinPlan(plan, { ...scope, [name]: crypto.randomUUID() }),
    ).toThrow("admission");
  for (const byteLength of [0, 8192, 32 * 1024 * 1024 + 1, Number.NaN])
    expect(() => parseNativeBrokerStdinPlan({ ...plan, byteLength }, scope)).toThrow();
  expect(() => createNativeBrokerStdinPlan(scope, Number.MAX_SAFE_INTEGER, bytes)).toThrow();
  for (const offset of [-1, 1, 9000, 16384, Number.NaN])
    expect(() => nativeBrokerStdinChunk(plan, offset, bytes.toString("base64"))).toThrow();
  for (const value of [
    bytes.subarray(1).toString("base64"),
    bytes.toString("base64") + "\n",
    "invalid",
  ])
    expect(() => nativeBrokerStdinChunk(plan, 0, value)).toThrow();
});
