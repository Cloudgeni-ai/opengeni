import { z } from "zod";
import {
  initialNativeBrokerInput,
  advanceNativeBrokerWriter,
  reserveNativeBrokerInput,
  markNativeBrokerInputDispatchIntent,
  markNativeBrokerProviderAcknowledged,
  pendingNativeBrokerProviderWrite,
  acceptNativeBrokerInput,
  validateNativeBrokerInputSnapshot,
  type NativeBrokerInputSnapshot,
  type NativeBrokerRequest,
} from "./native-command-broker-input";
import {
  initialNativeBrokerOutput,
  planNativeBrokerOutputCapture,
  validateNativeBrokerOutputSnapshot,
  type NativeBrokerOutputSnapshot,
  type NativeBrokerOutputPage,
} from "./native-command-broker-output";
import { NativeBrokerFrameDecoder, type NativeBrokerFrame } from "./native-command-broker-wire";

type EntryKind = "request" | "frame" | "page" | "eof" | "control_reply";
type Entry = {
  kind: EntryKind;
  key: string;
  sequence: number | null;
  sha256: string;
  value: string;
};
type Writer = { id: string | null; epoch: number; live: boolean };
/** Exact existing stdin admission, supplied by the trusted process route. The
 * admission UUID is also the immutable request UUID: one payload per admission. */
export type NativeBrokerRetainedInput = {
  sessionId: string;
  processId: string;
  admissionId: string;
  commandId: string;
};
/** Implemented by the scoped DB adapter. All state/receipt writes in a callback
 * commit atomically, or none do. No callback performs provider I/O. */
export type NativeBrokerTransportPort = {
  transaction<T>(
    operation: (tx: {
      state: unknown;
      writer: Writer;
      currentInstance: boolean;
      read(kind: EntryKind, key: string): Promise<Entry | null>;
      framesAfter(sequence: number, limit: number): Promise<Entry[]>;
      insert(entry: Omit<Entry, "sha256">): Promise<Entry>;
      claimWriter(id: string): Writer;
      requireWriter(id: string, epoch: number): void;
      save(state: unknown): void;
    }) => Promise<T>,
  ): Promise<T>;
  retainedInputTransaction?<T>(
    input: NativeBrokerRetainedInput,
    operation: (
      tx: NativeBrokerTransportTransaction & {
        reserveInput(byteLength: number): Promise<number>;
      },
    ) => Promise<T>,
  ): Promise<T>;
};
type NativeBrokerTransportTransaction = Parameters<
  Parameters<NativeBrokerTransportPort["transaction"]>[0]
>[0];
type Identity = { brokerId: string; sandboxId: string; taskId: string };
export type NativeBrokerTransportState = {
  version: 1;
  input: NativeBrokerInputSnapshot;
  output: NativeBrokerOutputSnapshot;
};
function invalid(): never {
  throw new Error("Native broker durable transport is inconsistent or fenced");
}
const stateSchema = z
  .object({ version: z.literal(1), input: z.unknown(), output: z.unknown() })
  .strict();
function validate(raw: unknown, identity: Identity): NativeBrokerTransportState {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) invalid();
  const input = validateNativeBrokerInputSnapshot(parsed.data.input as NativeBrokerInputSnapshot);
  const output = validateNativeBrokerOutputSnapshot(
    parsed.data.output as NativeBrokerOutputSnapshot,
  );
  if (
    input.brokerId !== identity.brokerId ||
    output.brokerId !== identity.brokerId ||
    output.sandboxId !== identity.sandboxId ||
    output.taskId !== identity.taskId
  )
    invalid();
  return { version: 1, input, output };
}
function requestFromWire(value: string, identity: Identity) {
  const decoder = new NativeBrokerFrameDecoder(identity.brokerId);
  const frames = decoder.push(Buffer.from(value));
  decoder.finish();
  if (frames.length !== 1 || frames[0]?.direction !== "request") invalid();
  return frames[0];
}
export function initialNativeBrokerTransportState(identity: Identity): NativeBrokerTransportState {
  return {
    version: 1,
    input: initialNativeBrokerInput(identity.brokerId),
    output: initialNativeBrokerOutput({
      brokerId: identity.brokerId,
      sandboxId: identity.sandboxId,
      taskId: identity.taskId,
    }),
  };
}

/** This adapter persists transport custody, not command authority. Its caller
 * still owns authenticated bootstrap/output provenance, exact workspace and
 * command admissions, the qualified artifact, and physical provider dispatch.
 * Only `dispatchIntent` returns provider bytes, after the DB commit resolves.
 */
export function durableNativeBrokerTransport(store: NativeBrokerTransportPort, identity: Identity) {
  const reserve = async (
    tx: NativeBrokerTransportTransaction,
    writerId: string,
    epoch: number,
    request: NativeBrokerRequest,
  ) => {
    tx.requireWriter(writerId, epoch);
    const state = validate(tx.state, identity);
    if (state.output.providerEof || state.input.writerEpoch !== epoch) invalid();
    const old = await tx.read("request", request.requestId);
    if (old) {
      const frame = requestFromWire(old.value, identity);
      if (
        frame.requestId !== request.requestId ||
        frame.kind !== request.kind ||
        frame.commandId !== request.commandId ||
        frame.offset !== request.offset ||
        !Buffer.from(frame.payload).equals(request.payload) ||
        old.sequence !== frame.sequence
      )
        invalid();
      return { index: frame.sequence, alreadyReserved: true };
    }
    state.input = reserveNativeBrokerInput(state.input, epoch, request);
    const pending = state.input.pending!;
    await tx.insert({
      kind: "request",
      key: request.requestId,
      sequence: pending.providerInputIndex,
      value: Buffer.from(pending.frameBase64, "base64").toString("ascii"),
    });
    tx.save(state);
    return { index: pending.providerInputIndex, alreadyReserved: false };
  };
  const dispatchIntent = async (
    tx: NativeBrokerTransportTransaction,
    writerId: string,
    epoch: number,
    requestId: string,
    stdin?: NativeBrokerRetainedInput,
  ) => {
    tx.requireWriter(writerId, epoch);
    const state = validate(tx.state, identity);
    if (state.output.providerEof) invalid();
    const entry = await tx.read("request", requestId);
    if (!entry) invalid();
    const frame = requestFromWire(entry.value, identity);
    if (
      stdin
        ? frame.kind !== "stdin" ||
          frame.commandId !== stdin.commandId ||
          frame.requestId !== stdin.admissionId
        : frame.kind === "stdin"
    )
      invalid();
    if (entry.sequence! <= state.input.lastAcceptedInputIndex) return null;
    if (
      !state.input.pending ||
      entry.sequence !== state.input.pending.providerInputIndex ||
      Buffer.from(state.input.pending.frameBase64, "base64").toString("ascii") !== entry.value
    )
      invalid();
    state.input = markNativeBrokerInputDispatchIntent(state.input, epoch);
    tx.save(state);
    return pendingNativeBrokerProviderWrite(state.input, epoch);
  };
  return {
    async claimWriter(id: string) {
      return store.transaction(async (tx) => {
        const state = validate(tx.state, identity);
        if (state.output.providerEof) invalid();
        if (tx.writer.epoch !== state.input.writerEpoch) invalid();
        const writer = tx.claimWriter(id);
        if (writer.epoch !== state.input.writerEpoch) {
          state.input = advanceNativeBrokerWriter(state.input, state.input.writerEpoch);
          if (writer.epoch !== state.input.writerEpoch) invalid();
        }
        tx.save(state);
        return writer;
      });
    },
    async reserve(writerId: string, epoch: number, request: NativeBrokerRequest) {
      if (request.kind === "stdin") invalid();
      return store.transaction((tx) => reserve(tx, writerId, epoch, request));
    },
    async reserveRetainedStdin(
      writerId: string,
      epoch: number,
      input: NativeBrokerRetainedInput,
      payload: Uint8Array,
    ) {
      if (!store.retainedInputTransaction || !payload.length) invalid();
      input = { ...input };
      const bytes = Buffer.from(payload);
      return store.retainedInputTransaction(input, async (tx) => {
        const old = await tx.read("request", input.admissionId);
        const offset = old
          ? requestFromWire(old.value, identity).offset
          : await tx.reserveInput(bytes.length);
        const reserved = await reserve(tx, writerId, epoch, {
          requestId: input.admissionId,
          commandId: input.commandId,
          kind: "stdin",
          offset,
          payload: bytes,
        });
        return { ...reserved, offset };
      });
    },
    async dispatchIntent(writerId: string, epoch: number, requestId: string) {
      return store.transaction((tx) => dispatchIntent(tx, writerId, epoch, requestId));
    },
    async dispatchRetainedStdinIntent(
      writerId: string,
      epoch: number,
      input: NativeBrokerRetainedInput,
    ) {
      if (!store.retainedInputTransaction) invalid();
      input = { ...input };
      return store.retainedInputTransaction(input, (tx) =>
        dispatchIntent(tx, writerId, epoch, input.admissionId, input),
      );
    },
    async providerAcknowledged(writerId: string, epoch: number, requestId: string) {
      return store.transaction(async (tx) => {
        tx.requireWriter(writerId, epoch);
        const state = validate(tx.state, identity);
        const entry = await tx.read("request", requestId);
        if (!entry) invalid();
        if (entry.sequence! <= state.input.lastAcceptedInputIndex) return;
        if (!state.input.pending || entry.sequence !== state.input.pending.providerInputIndex)
          invalid();
        state.input = markNativeBrokerProviderAcknowledged(state.input, epoch);
        tx.save(state);
      });
    },
    async captureOutput(requestedCursor: string, page: NativeBrokerOutputPage) {
      return store.transaction(async (tx) => {
        const state = validate(tx.state, identity);
        const plan = await planNativeBrokerOutputCapture(state.output, requestedCursor, page, {
          entrySha256: async (key) => (await tx.read("page", key))?.sha256 ?? null,
          frameSha256: async (sequence) =>
            (await tx.read("frame", String(sequence)))?.sha256 ?? null,
        });
        for (const entry of plan.frames) {
          const saved = await tx.insert({
            kind: "frame",
            key: String(entry.sequence),
            sequence: entry.sequence,
            value: Buffer.from(entry.wireBase64, "base64").toString("ascii"),
          });
          if (saved.sha256 !== entry.sha256) invalid();
          if (entry.frame.kind === "accepted") {
            state.input = acceptNativeBrokerInput(
              state.input,
              state.input.writerEpoch,
              entry.frame,
            );
          }
          // A control response is separately indexed for bounded reconnect
          // reconciliation. Acceptance alone does not prove that the private
          // control channel accepted the action. Store the exact response in
          // the SAME transaction as its frame and provider cursor.
          if (entry.frame.kind === "status" || entry.frame.kind === "error") {
            const request = await tx.read("request", entry.frame.requestId);
            if (request) {
              const original = requestFromWire(request.value, identity);
              if (original.kind === "control") {
                if (
                  original.sequence > state.input.lastAcceptedInputIndex ||
                  original.commandId !== entry.frame.commandId ||
                  original.ownerEpoch !== entry.frame.ownerEpoch ||
                  entry.frame.offset !== 0
                )
                  invalid();
                await tx.insert({
                  kind: "control_reply",
                  key: original.requestId,
                  sequence: entry.frame.sequence,
                  value: saved.value,
                });
              }
            }
          }
        }
        if (plan.page) {
          const saved = await tx.insert({
            kind: "page",
            key: plan.page.entryId,
            sequence: null,
            value: JSON.stringify(page),
          });
          if (saved.sha256 !== plan.page.sha256) invalid();
        }
        if (plan.eofObservationSha256) {
          const saved = await tx.insert({
            kind: "eof",
            key: "stdout",
            sequence: null,
            value: JSON.stringify(page),
          });
          if (saved.sha256 !== plan.eofObservationSha256) invalid();
        }
        state.output = plan.snapshot;
        tx.save(state);
        return {
          cursor: state.output.cursor,
          capturedFrames: plan.frames.length,
          providerEof: state.output.providerEof,
        };
      });
    },
    async read() {
      return store.transaction(async (tx) => validate(tx.state, identity));
    },
    /** Returned bytes have already committed, including late output from an
     * obsolete physical instance. This is not command settlement or authority. */
    async framesAfter(sequence: number, limit = 64) {
      if (
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 128
      )
        invalid();
      return store.transaction(async (tx) => {
        const state = validate(tx.state, identity);
        if (sequence > state.output.lastSequence) invalid();
        const entries = await tx.framesAfter(sequence, limit);
        const frames: NativeBrokerFrame[] = [];
        for (const entry of entries) {
          const decoder = new NativeBrokerFrameDecoder(identity.brokerId);
          const decoded = decoder.push(Buffer.from(entry.value));
          decoder.finish();
          const frame = decoded[0];
          if (
            decoded.length !== 1 ||
            !frame ||
            frame.direction !== "response" ||
            frame.sequence !== sequence + frames.length + 1 ||
            entry.kind !== "frame" ||
            entry.key !== String(frame.sequence) ||
            entry.sequence !== frame.sequence ||
            frame.sequence > state.output.lastSequence
          )
            invalid();
          frames.push(frame);
        }
        if (frames.length < limit && sequence + frames.length !== state.output.lastSequence)
          invalid();
        return {
          frames,
          lastSequence: state.output.lastSequence,
          providerEof: state.output.providerEof,
        };
      });
    },
    async request(requestId: string) {
      return store.transaction(async (tx) => {
        const state = validate(tx.state, identity);
        const entry = await tx.read("request", requestId);
        if (!entry) return null;
        const frame = requestFromWire(entry.value, identity);
        if (entry.sequence !== frame.sequence) invalid();
        const accepted = frame.sequence <= state.input.lastAcceptedInputIndex;
        const pending = state.input.pending;
        if (
          !accepted &&
          (!pending ||
            pending.providerInputIndex !== frame.sequence ||
            Buffer.from(pending.frameBase64, "base64").toString("ascii") !== entry.value)
        )
          invalid();
        return { frame, accepted, phase: accepted ? ("accepted" as const) : pending!.phase };
      });
    },
    async controlReply(requestId: string) {
      return store.transaction(async (tx) => {
        const state = validate(tx.state, identity);
        const entry = await tx.read("control_reply", requestId);
        if (!entry) return null;
        const request = await tx.read("request", requestId);
        if (!request) invalid();
        const original = requestFromWire(request.value, identity);
        const decoder = new NativeBrokerFrameDecoder(identity.brokerId);
        const frames = decoder.push(Buffer.from(entry.value));
        decoder.finish();
        const frame = frames[0];
        if (
          frames.length !== 1 ||
          !frame ||
          frame.direction !== "response" ||
          !["status", "error"].includes(frame.kind) ||
          frame.requestId !== requestId ||
          original.kind !== "control" ||
          original.commandId !== frame.commandId ||
          original.ownerEpoch !== frame.ownerEpoch ||
          original.sequence > state.input.lastAcceptedInputIndex ||
          frame.offset !== 0 ||
          entry.sequence !== frame.sequence ||
          frame.sequence > state.output.lastSequence
        )
          invalid();
        const canonical = await tx.read("frame", String(frame.sequence));
        if (!canonical || canonical.value !== entry.value || canonical.sha256 !== entry.sha256)
          invalid();
        return frame;
      });
    },
  };
}

export type DurableNativeBrokerTransport = ReturnType<typeof durableNativeBrokerTransport>;
