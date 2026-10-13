import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { ModalBrokerProviderCommand, type CommandSupervisionReceipt } from "@opengeni/contracts";
import { decodePage } from "./modal-legacy-command-control";
import type { DurableNativeBrokerTransport } from "./native-command-broker-transport";

const integer = z.number().int().nonnegative().safe();
const bindingSchema = z
  .object({
    brokerId: z.uuid(),
    commandId: z.uuid(),
    launchRequestId: z.uuid(),
    launchEpoch: z.number().int().positive().safe(),
    mode: z.enum(["pipe", "pty"]),
  })
  .strict();
const receiptSchema = z
  .object({
    protocol: z.enum([
      "native-subreaper-broker-channel-v1",
      "native-subreaper-broker-channel-pty-v1",
    ]),
    invocationId: z.uuid(),
    receiptId: z.uuid(),
    leaderExitCode: z.number().int().min(0).max(255),
  })
  .strict();
const streamSchema = z
  .object({
    byteOffset: integer,
    utf8Remainder: z.string().max(8),
    eof: z.boolean(),
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    binding: bindingSchema,
    lastSequence: integer,
    streams: z.object({ stdout: streamSchema, stderr: streamSchema }).strict(),
    receipt: receiptSchema.nullable(),
    receiptAckObserved: z.boolean(),
    supervisorExitCode: z.literal(0).nullable(),
  })
  .strict();
export type NativeBrokerCommandBinding = z.infer<typeof bindingSchema>;
export type NativeBrokerCommandSnapshot = z.infer<typeof snapshotSchema>;
export type NativeBrokerCommandReceipt = z.infer<typeof receiptSchema>;

function invalid(): never {
  throw new Error("Native broker command evidence is incomplete, conflicting or out of scope");
}
function parse(raw: unknown) {
  const value = snapshotSchema.safeParse(raw);
  if (!value.success) invalid();
  const state = value.data;
  for (const stream of Object.values(state.streams)) {
    const remainder = Buffer.from(stream.utf8Remainder, "base64");
    if (
      remainder.toString("base64") !== stream.utf8Remainder ||
      remainder.length > 3 ||
      (stream.eof && remainder.length) ||
      decodePage("", [remainder], false).remainder !== stream.utf8Remainder
    )
      invalid();
  }
  if (state.receipt) {
    if (
      state.receipt.invocationId !== state.binding.commandId ||
      state.receipt.protocol !==
        (state.binding.mode === "pty"
          ? "native-subreaper-broker-channel-pty-v1"
          : "native-subreaper-broker-channel-v1")
    )
      invalid();
  }
  if (
    (state.receiptAckObserved && !state.receipt) ||
    (state.supervisorExitCode !== null &&
      (!state.receiptAckObserved || !state.streams.stdout.eof || !state.streams.stderr.eof))
  )
    invalid();
  return state;
}

export function initialNativeBrokerCommandSnapshot(
  binding: NativeBrokerCommandBinding,
  beforeLaunchSequence: number,
): NativeBrokerCommandSnapshot {
  return parse({
    version: 1,
    binding,
    lastSequence: beforeLaunchSequence,
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false },
    },
    receipt: null,
    receiptAckObserved: false,
    supervisorExitCode: null,
  });
}

/** Rehydrate the projection only from the retained locator and independently
 * persisted native receipt. A descriptor is not launch or release authority. */
export function retainedNativeBrokerCommandSnapshot(
  input: ModalBrokerProviderCommand,
  receipt: CommandSupervisionReceipt | null,
): NativeBrokerCommandSnapshot {
  const command = ModalBrokerProviderCommand.parse(input);
  return parse({
    version: 1,
    binding: {
      brokerId: command.supervision.brokerId,
      commandId: command.execId,
      launchRequestId: command.supervision.launchRequestId,
      launchEpoch: command.supervision.launchEpoch,
      mode: command.pty ? "pty" : "pipe",
    },
    lastSequence: command.capture.sequence,
    streams: Object.fromEntries(
      Object.entries(command.streams).map(([name, stream]) => [
        name,
        {
          byteOffset: stream.byteOffset,
          utf8Remainder: stream.utf8Remainder,
          eof: stream.eof,
        },
      ]),
    ),
    receipt,
    receiptAckObserved: command.capture.receiptAckObserved,
    supervisorExitCode: command.streams.stdout.exitCode,
  });
}

/** The same immutable execution, with only its committed-frame projection
 * advanced. The caller atomically captures this locator with the output text;
 * native receipt persistence and physical ACK remain separate operations. */
export function nativeBrokerCommandFromSnapshot(
  input: ModalBrokerProviderCommand,
  value: NativeBrokerCommandSnapshot,
): ModalBrokerProviderCommand {
  const command = ModalBrokerProviderCommand.parse(input);
  const snapshot = parse(value);
  const original = retainedNativeBrokerCommandSnapshot(command, snapshot.receipt);
  if (
    !isDeepStrictEqual(original.binding, snapshot.binding) ||
    snapshot.lastSequence < original.lastSequence
  )
    invalid();
  return ModalBrokerProviderCommand.parse({
    ...command,
    capture: { sequence: snapshot.lastSequence, receiptAckObserved: snapshot.receiptAckObserved },
    streams: Object.fromEntries(
      Object.entries(snapshot.streams).map(([name, stream]) => [
        name,
        {
          ...stream,
          exitCode: snapshot.supervisorExitCode,
        },
      ]),
    ),
  });
}

/** Bounded per-command projection from COMMITTED initial-process frames. Child
 * text is never inspected for protocol markers. Controls are joined to exact
 * immutable accepted requests; output/EOF/exit belongs to the original launch.
 *
 * Caller must atomically persist the resulting snapshot and output, and must
 * persist the native receipt in canonical process custody before sending ACK.
 * This function neither sends ACK nor settles a workspace admission/holder.
 * Initial-process EOF never becomes a per-command EOF or quiescence receipt. */
export async function projectNativeBrokerCommand(
  journal: DurableNativeBrokerTransport,
  previous: NativeBrokerCommandSnapshot,
  limit = 64,
) {
  const state = parse(previous);
  const physical = await journal.read();
  if (physical.input.brokerId !== state.binding.brokerId) invalid();
  const page = await journal.framesAfter(state.lastSequence, limit);
  const chunks: { stream: "stdout" | "stderr"; byteOffset: number; text: string }[] = [];
  const receipts: NativeBrokerCommandReceipt[] = [];
  const responses: { requestId: string; kind: "status" | "error"; payload: unknown }[] = [];
  const requests = new Map<string, Awaited<ReturnType<DurableNativeBrokerTransport["request"]>>>();
  for (const frame of page.frames) {
    if (frame.brokerId !== state.binding.brokerId || frame.sequence !== state.lastSequence + 1)
      invalid();
    state.lastSequence = frame.sequence;
    if (frame.commandId !== state.binding.commandId) continue;
    if (frame.kind === "accepted") continue; // Transport already validates exact acceptance.
    if (!requests.has(frame.requestId))
      requests.set(frame.requestId, await journal.request(frame.requestId));
    const request = requests.get(frame.requestId);
    if (
      !request?.accepted ||
      request.frame.commandId !== state.binding.commandId ||
      request.frame.ownerEpoch !== frame.ownerEpoch
    )
      invalid();
    const launch =
      frame.requestId === state.binding.launchRequestId &&
      frame.ownerEpoch === state.binding.launchEpoch &&
      request.frame.kind === "launch";
    if (frame.kind === "stdout" || frame.kind === "stderr") {
      const stream = state.streams[frame.kind];
      if (
        !launch ||
        stream.eof ||
        state.supervisorExitCode !== null ||
        !frame.payload.length ||
        frame.offset !== stream.byteOffset ||
        !Number.isSafeInteger(stream.byteOffset + frame.payload.length)
      )
        invalid();
      const decoded = decodePage(stream.utf8Remainder, [frame.payload], false);
      chunks.push({ stream: frame.kind, byteOffset: stream.byteOffset, text: decoded.text });
      stream.byteOffset += frame.payload.length;
      stream.utf8Remainder = decoded.remainder;
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
    } catch {
      invalid();
    }
    if (frame.kind === "exit") {
      if (
        !launch ||
        frame.offset ||
        state.supervisorExitCode !== null ||
        !state.receipt ||
        !state.receiptAckObserved ||
        !state.streams.stdout.eof ||
        !state.streams.stderr.eof ||
        !z
          .object({
            supervisorExitCode: z.literal(0),
            stdoutEof: z.literal(true),
            stderrEof: z.literal(true),
          })
          .strict()
          .safeParse(payload).success
      )
        invalid();
      state.supervisorExitCode = 0;
      continue;
    }
    if (frame.kind !== "status" && frame.kind !== "error") invalid();
    const eof = z
      .object({ stream: z.enum(["stdout", "stderr"]), eof: z.literal(true) })
      .strict()
      .safeParse(payload);
    if (eof.success) {
      const stream = state.streams[eof.data.stream];
      if (frame.kind !== "status" || !launch || stream.eof || frame.offset !== stream.byteOffset)
        invalid();
      const decoded = decodePage(stream.utf8Remainder, [], true);
      if (decoded.text)
        chunks.push({ stream: eof.data.stream, byteOffset: stream.byteOffset, text: decoded.text });
      stream.utf8Remainder = "";
      stream.eof = true;
      continue;
    }
    if (frame.kind === "status" && request.frame.kind === "control") {
      const quiescent = z
        .object({ state: z.literal("quiescent"), receipt: receiptSchema })
        .strict()
        .safeParse(payload);
      if (quiescent.success) {
        if (
          frame.offset ||
          quiescent.data.receipt.invocationId !== state.binding.commandId ||
          quiescent.data.receipt.protocol !==
            (state.binding.mode === "pty"
              ? "native-subreaper-broker-channel-pty-v1"
              : "native-subreaper-broker-channel-v1") ||
          (state.receipt && !isDeepStrictEqual(state.receipt, quiescent.data.receipt))
        )
          invalid();
        const action = Buffer.from(request.frame.payload).toString("ascii");
        if (action.startsWith("ack\t")) {
          // An ACK response cannot introduce its own previously unseen receipt.
          if (!state.receipt || action !== `ack\t${state.receipt.receiptId}`) invalid();
          state.receiptAckObserved = true;
        } else if (!["status", "release", "cancel"].includes(action)) invalid();
        if (!state.receipt) receipts.push(quiescent.data.receipt);
        state.receipt = quiescent.data.receipt;
      } else if (payload && typeof payload === "object" && "receipt" in payload) invalid();
    } else if (payload && typeof payload === "object" && "receipt" in payload) invalid();
    responses.push({ requestId: frame.requestId, kind: frame.kind, payload });
  }
  const snapshot = parse(state);
  return {
    snapshot,
    chunks,
    receipts,
    responses,
    exitCode: snapshot.supervisorExitCode === 0 ? snapshot.receipt!.leaderExitCode : null,
    providerEof: page.providerEof,
    hasMore: snapshot.lastSequence < page.lastSequence,
  };
}
