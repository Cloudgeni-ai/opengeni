import { createHash } from "node:crypto";
import { z } from "zod";
import type { NativeBrokerRetainedInput } from "./native-command-broker-transport";
import { NATIVE_BROKER_PAYLOAD_MAX_BYTES } from "./native-command-broker-wire";

// Match the API JSON body's absolute ceiling rather than the native frame's
// 8 KiB transport granularity. No bytes are silently truncated at either bound.
export const NATIVE_BROKER_STDIN_MAX_BYTES = 32 * 1024 * 1024;
export const NATIVE_BROKER_STDIN_PAGE_BYTES = 64 * 1024;
const Plan = z
  .object({
    version: z.literal(1),
    sessionId: z.uuid(),
    processId: z.uuid(),
    admissionId: z.uuid(),
    commandId: z.uuid(),
    offset: z.number().int().nonnegative().safe(),
    byteLength: z
      .number()
      .int()
      .min(NATIVE_BROKER_PAYLOAD_MAX_BYTES + 1)
      .max(NATIVE_BROKER_STDIN_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type NativeBrokerStdinPlan = z.infer<typeof Plan>;
export function parseNativeBrokerStdinPlan(value: unknown, input: NativeBrokerRetainedInput) {
  const plan = Plan.parse(value);
  if (
    !Number.isSafeInteger(plan.offset + plan.byteLength) ||
    plan.sessionId !== input.sessionId ||
    plan.processId !== input.processId ||
    plan.admissionId !== input.admissionId ||
    plan.commandId !== input.commandId
  )
    throw new Error("Native broker stdin plan changed its original admission");
  return plan;
}
export function createNativeBrokerStdinPlan(
  input: NativeBrokerRetainedInput,
  offset: number,
  bytes: Uint8Array,
) {
  return parseNativeBrokerStdinPlan(
    {
      ...input,
      version: 1,
      offset,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    input,
  );
}
export function nativeBrokerStdinChunkRequestId(admissionId: string, offset: number) {
  if (
    !z.uuid().safeParse(admissionId).success ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= NATIVE_BROKER_STDIN_MAX_BYTES ||
    offset % NATIVE_BROKER_PAYLOAD_MAX_BYTES
  )
    throw new Error("Invalid native broker stdin chunk identity");
  const bytes = createHash("sha256")
    .update(JSON.stringify(["native-broker-stdin-chunk-v1", admissionId, offset]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x80;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function nativeBrokerStdinChunk(plan: NativeBrokerStdinPlan, offset: number, page: string) {
  const requestId = nativeBrokerStdinChunkRequestId(plan.admissionId, offset);
  const pageOffset =
    Math.floor(offset / NATIVE_BROKER_STDIN_PAGE_BYTES) * NATIVE_BROKER_STDIN_PAGE_BYTES;
  const bytes = Buffer.from(page, "base64");
  if (
    offset >= plan.byteLength ||
    bytes.toString("base64") !== page ||
    bytes.length !== Math.min(NATIVE_BROKER_STDIN_PAGE_BYTES, plan.byteLength - pageOffset)
  )
    throw new Error("Native broker stdin page does not match its retained plan");
  return {
    requestId,
    commandId: plan.commandId,
    kind: "stdin" as const,
    offset: plan.offset + offset,
    payload: bytes.subarray(
      offset - pageOffset,
      Math.min(bytes.length, offset - pageOffset + NATIVE_BROKER_PAYLOAD_MAX_BYTES),
    ),
  };
}
