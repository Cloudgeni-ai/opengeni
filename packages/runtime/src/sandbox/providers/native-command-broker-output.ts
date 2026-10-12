import { createHash } from "node:crypto";
import { z } from "zod";
import {
  encodeNativeBrokerFrame,
  NativeBrokerFrameDecoder,
  NATIVE_BROKER_FRAME_MAX_BYTES,
  type NativeBrokerFrame,
} from "./native-command-broker-wire";

const MAX_PAGE_BYTES = 1024 * 1024;
const identity = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const locator = z.string().min(1).max(200);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const snapshotSchema = z
  .object({
    version: z.literal(1),
    brokerId: identity,
    sandboxId: locator,
    taskId: locator,
    revision: z.number().int().nonnegative().safe(),
    cursor: z.string().min(1).max(200),
    lastPageSha256: digest.nullable(),
    lastSequence: z.number().int().nonnegative().safe(),
    partialBase64: z.string().max(16 * 1024),
    providerEof: z.boolean(),
    providerEofSha256: digest.nullable(),
  })
  .strict();
const pageSchema = z
  .object({
    sandboxId: locator,
    taskId: locator,
    requestedFileDescriptor: z.literal(1),
    entryId: z.string().max(200),
    items: z
      .array(
        z
          .object({
            fileDescriptor: z.union([z.literal(1), z.literal(2)]),
            data: z.string().max(MAX_PAGE_BYTES),
          })
          .strict(),
      )
      .max(4096),
    eof: z.boolean(),
  })
  .strict();
export type NativeBrokerOutputSnapshot = z.infer<typeof snapshotSchema>;
export type NativeBrokerOutputPage = z.infer<typeof pageSchema>;
export type NativeBrokerInboxFrame = {
  sequence: number;
  sha256: string;
  frame: NativeBrokerFrame;
  wireBase64: string;
};
export type NativeBrokerOutputPlan = {
  previousRevision: number;
  snapshot: NativeBrokerOutputSnapshot;
  page: { entryId: string; sha256: string } | null;
  frames: NativeBrokerInboxFrame[];
  duplicateSequences: number[];
  eofObservationSha256: string | null;
};
export type NativeBrokerOutputLookup = {
  // These reads must share the eventual commit's locked/CAS transaction and
  // exact account/workspace/physical-broker scope. Never consult a sandbox file.
  entrySha256(entryId: string): Promise<string | null>;
  frameSha256(sequence: number): Promise<string | null>;
};
function invalid(): never {
  throw new Error("Native broker output is conflicting, incomplete or outside its bound");
}
function sha(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function parse(snapshot: NativeBrokerOutputSnapshot): NativeBrokerOutputSnapshot {
  const result = snapshotSchema.safeParse(snapshot);
  if (!result.success) invalid();
  const state = result.data;
  const partial = Buffer.from(state.partialBase64, "base64");
  if (
    partial.toString("base64") !== state.partialBase64 ||
    partial.length >= NATIVE_BROKER_FRAME_MAX_BYTES ||
    (state.providerEof && partial.length) ||
    state.providerEof !== (state.providerEofSha256 !== null) ||
    (state.lastPageSha256 === null &&
      (state.cursor !== "0-0" || state.lastSequence !== 0 || partial.length))
  )
    invalid();
  const decoder = new NativeBrokerFrameDecoder(state.brokerId, partial);
  decoder.snapshot();
  return state;
}

export function initialNativeBrokerOutput(input: {
  brokerId: string;
  sandboxId: string;
  taskId: string;
}): NativeBrokerOutputSnapshot {
  return parse({
    ...input,
    version: 1,
    revision: 0,
    cursor: "0-0",
    lastPageSha256: null,
    lastSequence: 0,
    partialBase64: "",
    providerEof: false,
    providerEofSha256: null,
  });
}

/** Plan one complete authenticated initial-process log page. This is NOT the
 * durable inbox implementation: the caller must atomically insert page and
 * frame receipts AND the suffix/cursor snapshot before acknowledging anything
 * to the broker. A lost transaction replays from its old cursor. The provider's
 * page/cursor and EOF never prove command output EOF, exit or quiescence.
 *
 * All broker command streams share this one protocol stream/cursor. Initial
 * stderr is not child stderr (child bytes belong inside encoded frames). Its
 * separate observer must fence admission on nonempty diagnostics; neither its
 * cursor nor its EOF may advance this stdout protocol stream.
 */
export async function planNativeBrokerOutputCapture(
  snapshot: NativeBrokerOutputSnapshot,
  requestedCursor: string,
  input: NativeBrokerOutputPage,
  lookup: NativeBrokerOutputLookup,
): Promise<NativeBrokerOutputPlan> {
  const state = parse(snapshot);
  const result = pageSchema.safeParse(input);
  if (!result.success || requestedCursor !== state.cursor) invalid();
  const page = result.data;
  if (page.sandboxId !== state.sandboxId || page.taskId !== state.taskId) invalid();
  let size = 0;
  for (const item of page.items) {
    size += Buffer.byteLength(item.data, "utf8");
    if (size > MAX_PAGE_BYTES || item.fileDescriptor !== 1) invalid();
  }
  const plan: NativeBrokerOutputPlan = {
    previousRevision: state.revision,
    snapshot: state,
    page: null,
    frames: [],
    duplicateSequences: [],
    eofObservationSha256: null,
  };
  const pageHash = sha(JSON.stringify(page));
  // Real Modal V1 ends with an empty, cursor-less EOF batch. Keep that separate
  // observation without inventing a provider cursor or command settlement.
  if (!page.entryId) {
    if (size) invalid();
    if (page.eof) {
      const decoder = new NativeBrokerFrameDecoder(
        state.brokerId,
        Buffer.from(state.partialBase64, "base64"),
      );
      decoder.finish();
      if (state.providerEof) {
        if (state.providerEofSha256 !== pageHash) invalid();
      } else {
        if (state.revision === Number.MAX_SAFE_INTEGER) invalid();
        state.providerEof = true;
        state.providerEofSha256 = pageHash;
        state.revision += 1;
        plan.eofObservationSha256 = pageHash;
      }
    }
    return plan;
  }
  const knownPage = await lookup.entrySha256(page.entryId);
  if (knownPage !== null) {
    if (
      !digest.safeParse(knownPage).success ||
      knownPage !== pageHash ||
      page.entryId !== state.cursor ||
      pageHash !== state.lastPageSha256
    )
      invalid();
    return plan;
  }
  if (
    page.entryId === state.cursor ||
    state.providerEof ||
    state.revision === Number.MAX_SAFE_INTEGER
  )
    invalid();
  const decoder = new NativeBrokerFrameDecoder(
    state.brokerId,
    Buffer.from(state.partialBase64, "base64"),
  );
  const newlySeen = new Map<number, string>();
  for (const item of page.items) {
    if (item.fileDescriptor !== 1) continue;
    const bytes = Buffer.from(item.data, "utf8");
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      for (const frame of decoder.push(bytes.subarray(offset, offset + 64 * 1024))) {
        if (frame.direction !== "response") invalid();
        const wire = encodeNativeBrokerFrame(frame);
        const hash = sha(wire);
        if (frame.sequence <= state.lastSequence) {
          const known = newlySeen.get(frame.sequence) ?? (await lookup.frameSha256(frame.sequence));
          if (known !== hash) invalid();
          plan.duplicateSequences.push(frame.sequence);
          continue;
        }
        if (
          state.lastSequence === Number.MAX_SAFE_INTEGER ||
          frame.sequence !== state.lastSequence + 1
        )
          invalid();
        // Also detect an inconsistent or partially committed durable inbox.
        if ((await lookup.frameSha256(frame.sequence)) !== null) invalid();
        newlySeen.set(frame.sequence, hash);
        state.lastSequence = frame.sequence;
        plan.frames.push({
          sequence: frame.sequence,
          sha256: hash,
          frame,
          wireBase64: Buffer.from(wire).toString("base64"),
        });
      }
    }
  }
  if (page.eof) decoder.finish();
  state.partialBase64 = Buffer.from(decoder.snapshot()).toString("base64");
  state.cursor = page.entryId;
  state.lastPageSha256 = pageHash;
  state.providerEof = page.eof;
  state.providerEofSha256 = page.eof ? pageHash : null;
  plan.eofObservationSha256 = page.eof ? pageHash : null;
  state.revision += 1;
  plan.page = { entryId: page.entryId, sha256: pageHash };
  return plan;
}
