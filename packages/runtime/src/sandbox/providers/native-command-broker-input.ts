import { createHash } from "node:crypto";
import { z } from "zod";
import {
  encodeNativeBrokerFrame,
  NativeBrokerFrameDecoder,
  type NativeBrokerFrame,
} from "./native-command-broker-wire";

// modal@0.9.0 SandboxStdinWrite encodes index as uint32, not a JS safe integer.
export const NATIVE_BROKER_PROVIDER_INPUT_MAX_INDEX = 0xffff_ffff;
const index = z.number().int().min(0).max(NATIVE_BROKER_PROVIDER_INPUT_MAX_INDEX);
const epoch = z.number().int().positive().safe();
const identity = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const pendingSchema = z
  .object({
    providerInputIndex: index.refine((value) => value > 0),
    frameBase64: z.string().max(16 * 1024),
    frameSha256: z.string().regex(/^[0-9a-f]{64}$/),
    phase: z.enum(["reserved", "dispatch_intent", "provider_acknowledged"]),
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    brokerId: identity,
    revision: z.number().int().nonnegative().safe(),
    writerEpoch: epoch,
    acceptedWriterEpoch: z.number().int().nonnegative().safe(),
    lastReservedInputIndex: index,
    lastAcceptedInputIndex: index,
    pending: pendingSchema.nullable(),
  })
  .strict();

export type NativeBrokerInputSnapshot = z.infer<typeof snapshotSchema>;
export type NativeBrokerRequest = Omit<
  Extract<NativeBrokerFrame, { direction: "request" }>,
  "direction" | "brokerId" | "ownerEpoch" | "sequence"
>;
type RequestFrame = Extract<NativeBrokerFrame, { direction: "request" }>;

function invalid(): never {
  // Frames may contain environment values or stdin. Never expose them here.
  throw new Error("Native broker input transition is invalid or fenced");
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function pendingFrame(state: NativeBrokerInputSnapshot): {
  frame: RequestFrame;
  bytes: Uint8Array;
} {
  if (!state.pending) invalid();
  const bytes = Buffer.from(state.pending.frameBase64, "base64");
  if (
    bytes.toString("base64") !== state.pending.frameBase64 ||
    hash(bytes) !== state.pending.frameSha256
  )
    invalid();
  const decoder = new NativeBrokerFrameDecoder(state.brokerId);
  const frames = decoder.push(bytes);
  decoder.finish();
  const frame = frames[0];
  if (
    frames.length !== 1 ||
    !frame ||
    frame.direction !== "request" ||
    frame.sequence !== state.pending.providerInputIndex ||
    frame.ownerEpoch > state.writerEpoch
  )
    invalid();
  if (frame.kind === "fence") {
    if (
      frame.commandId !== null ||
      frame.offset !== 0 ||
      frame.payload.length ||
      frame.ownerEpoch <= state.acceptedWriterEpoch
    )
      invalid();
  } else if (frame.ownerEpoch !== state.acceptedWriterEpoch) invalid();
  return { frame, bytes };
}
function parse(snapshot: NativeBrokerInputSnapshot): NativeBrokerInputSnapshot {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) invalid();
  const state = parsed.data;
  if (
    state.acceptedWriterEpoch > state.writerEpoch ||
    state.lastAcceptedInputIndex > state.lastReservedInputIndex ||
    state.lastReservedInputIndex - state.lastAcceptedInputIndex !== (state.pending ? 1 : 0) ||
    (state.lastAcceptedInputIndex === 0) !== (state.acceptedWriterEpoch === 0)
  )
    invalid();
  if (state.pending) {
    if (state.pending.providerInputIndex !== state.lastReservedInputIndex) invalid();
    pendingFrame(state);
  }
  return state;
}

export const validateNativeBrokerInputSnapshot = parse;
function writer(state: NativeBrokerInputSnapshot, expectedWriterEpoch: number): void {
  if (expectedWriterEpoch !== state.writerEpoch) invalid();
}
function advance(state: NativeBrokerInputSnapshot): NativeBrokerInputSnapshot {
  if (state.revision === Number.MAX_SAFE_INTEGER) invalid();
  state.revision += 1;
  return parse(state);
}

/** Pure transition rules, NOT a persistence or authorization adapter.
 * The caller must lock/CAS the exact scoped physical broker row, check its live
 * writer authority, and COMMIT each returned snapshot before dispatching bytes.
 * Request IDs additionally need a durable unique outbox constraint across all
 * completed requests. A JS object, revision, epoch or provider acknowledgement
 * alone is never command admission, replay permission or physical settlement.
 */
export function initialNativeBrokerInput(brokerId: string): NativeBrokerInputSnapshot {
  return parse({
    version: 1,
    brokerId,
    revision: 0,
    writerEpoch: 1,
    acceptedWriterEpoch: 0,
    lastReservedInputIndex: 0,
    lastAcceptedInputIndex: 0,
    pending: null,
  });
}

/** The lease transaction, not a caller assertion, authorizes this takeover.
 * Preserve an ambiguous old write verbatim. It must be accepted before the new
 * writer can append its own fence, so the provider's high-water index cannot
 * silently discard the pending operation.
 */
export function advanceNativeBrokerWriter(
  snapshot: NativeBrokerInputSnapshot,
  expectedWriterEpoch: number,
): NativeBrokerInputSnapshot {
  const state = parse(snapshot);
  writer(state, expectedWriterEpoch);
  if (state.writerEpoch === Number.MAX_SAFE_INTEGER) invalid();
  state.writerEpoch += 1;
  return advance(state);
}

export function reserveNativeBrokerInput(
  snapshot: NativeBrokerInputSnapshot,
  expectedWriterEpoch: number,
  request: NativeBrokerRequest,
): NativeBrokerInputSnapshot {
  const state = parse(snapshot);
  writer(state, expectedWriterEpoch);
  if (state.pending) invalid();
  if (state.lastReservedInputIndex === NATIVE_BROKER_PROVIDER_INPUT_MAX_INDEX) invalid();
  if (
    state.acceptedWriterEpoch !== state.writerEpoch
      ? request.kind !== "fence"
      : request.kind === "fence"
  )
    invalid();
  if (
    request.kind === "fence" &&
    (request.commandId !== null || request.offset !== 0 || request.payload.length)
  )
    invalid();
  const nextIndex = state.lastReservedInputIndex + 1;
  const bytes = encodeNativeBrokerFrame({
    ...request,
    direction: "request",
    brokerId: state.brokerId,
    ownerEpoch: state.writerEpoch,
    sequence: nextIndex,
  });
  state.lastReservedInputIndex = nextIndex;
  state.pending = {
    providerInputIndex: nextIndex,
    frameBase64: Buffer.from(bytes).toString("base64"),
    frameSha256: hash(bytes),
    phase: "reserved",
  };
  return advance(state);
}

/** Must be durably committed before calling SandboxStdinWrite. A transport
 * failure leaves this intent pending; it never creates another index or body.
 */
export function markNativeBrokerInputDispatchIntent(
  snapshot: NativeBrokerInputSnapshot,
  expectedWriterEpoch: number,
): NativeBrokerInputSnapshot {
  const state = parse(snapshot);
  writer(state, expectedWriterEpoch);
  if (!state.pending) invalid();
  if (state.pending.phase !== "reserved") return state;
  state.pending.phase = "dispatch_intent";
  return advance(state);
}

/** Provider ACK records only receipt of an RPC; it cannot unblock the next
 * input. Modal may acknowledge an index whose body it ignored.
 */
export function markNativeBrokerProviderAcknowledged(
  snapshot: NativeBrokerInputSnapshot,
  expectedWriterEpoch: number,
): NativeBrokerInputSnapshot {
  const state = parse(snapshot);
  writer(state, expectedWriterEpoch);
  if (!state.pending || state.pending.phase === "reserved") invalid();
  if (state.pending.phase === "provider_acknowledged") return state;
  state.pending.phase = "provider_acknowledged";
  return advance(state);
}

/** Only for an authenticated initial-process frame already committed by the
 * durable output inbox. No raw TaskExec/child output may enter this transition.
 * Acceptance acknowledges this input, not a native quiescence receipt or exit.
 */
export function acceptNativeBrokerInput(
  snapshot: NativeBrokerInputSnapshot,
  expectedWriterEpoch: number,
  accepted: NativeBrokerFrame,
): NativeBrokerInputSnapshot {
  const state = parse(snapshot);
  writer(state, expectedWriterEpoch);
  if (!state.pending || state.pending.phase === "reserved") invalid();
  const { frame } = pendingFrame(state);
  // Validate the frame through the same closed wire contract, even for callers
  // that obtained the value through JSON or an unsafe cast.
  encodeNativeBrokerFrame(accepted);
  if (
    accepted.direction !== "response" ||
    accepted.kind !== "accepted" ||
    accepted.brokerId !== state.brokerId ||
    accepted.ownerEpoch !== frame.ownerEpoch ||
    accepted.requestId !== frame.requestId ||
    accepted.commandId !== frame.commandId ||
    accepted.offset !== frame.sequence ||
    accepted.payload.length !== 0
  )
    invalid();
  state.lastAcceptedInputIndex = state.pending.providerInputIndex;
  if (frame.kind === "fence") state.acceptedWriterEpoch = frame.ownerEpoch;
  state.pending = null;
  return advance(state);
}

/** The persistence adapter must reload the committed row and recheck writer
 * authority before calling this. EOF is NEVER attached to an input RPC: closing
 * the initial process's stdin would close the whole broker, not one command.
 */
export function pendingNativeBrokerProviderWrite(
  snapshot: NativeBrokerInputSnapshot,
  expectedWriterEpoch: number,
): { index: number; input: Uint8Array; eof: false } {
  const state = parse(snapshot);
  writer(state, expectedWriterEpoch);
  if (!state.pending || state.pending.phase === "reserved") invalid();
  return { index: state.pending.providerInputIndex, input: pendingFrame(state).bytes, eof: false };
}
