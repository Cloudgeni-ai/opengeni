/** Initial-sandbox-channel framing only. Parsing does not authenticate a
 * keeper, admit a command, settle an outcome, or advance a provider cursor.
 * The eventual transport must commit every frame plus the partial suffix
 * before advancing its shared log cursor. No TaskExec output enters here.
 */
export const NATIVE_BROKER_WIRE_VERSION = "OGB1";
export const NATIVE_BROKER_PAYLOAD_MAX_BYTES = 8192;
export const NATIVE_BROKER_FRAME_MAX_BYTES = 12 * 1024;
export const NATIVE_BROKER_INPUT_MAX_BYTES = 64 * 1024;

const requestKinds = [
  "hello",
  "fence",
  "prepare",
  "definition",
  "launch",
  "stdin",
  "eof",
  "resize",
  "control",
  "ack",
  "replay",
] as const;
const responseKinds = [
  "hello",
  "artifact",
  "accepted",
  "status",
  "stdout",
  "stderr",
  "exit",
  "error",
] as const;
type Fields = {
  brokerId: string;
  ownerEpoch: number;
  sequence: number;
  requestId: string;
  commandId: string | null;
  offset: number;
  payload: Uint8Array;
};
export type NativeBrokerFrame = Fields &
  (
    | { direction: "request"; kind: (typeof requestKinds)[number] }
    | { direction: "response"; kind: (typeof responseKinds)[number] }
  );

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const decimal = /^(?:0|[1-9][0-9]*)$/;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalid(): never {
  // A frame may contain stdin or credentials. Never include any part in errors.
  throw new Error("Native broker frame is invalid or exceeds its bound");
}

function integer(text: string, minimum = 0): number {
  if (!decimal.test(text)) return invalid();
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum) return invalid();
  return value;
}

function validAscii(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 9 || (byte >= 32 && byte <= 126));
}

function parse(line: Uint8Array, expectedBrokerId: string): NativeBrokerFrame {
  if (line.length + 1 > NATIVE_BROKER_FRAME_MAX_BYTES || !validAscii(line)) return invalid();
  const fields = Buffer.from(line).toString("ascii").split("\t");
  if (fields.length !== 12) return invalid();
  const [
    version,
    direction,
    brokerId,
    epoch,
    sequence,
    requestId,
    commandId,
    kind,
    offset,
    size,
    encoding,
    payload,
  ] = fields;
  if (
    version !== NATIVE_BROKER_WIRE_VERSION ||
    (direction !== "request" && direction !== "response") ||
    brokerId !== expectedBrokerId ||
    !uuid.test(brokerId!) ||
    !uuid.test(requestId!) ||
    (commandId !== "-" && !uuid.test(commandId!)) ||
    encoding !== "base64"
  )
    return invalid();
  const kinds: readonly string[] = direction === "request" ? requestKinds : responseKinds;
  if (!kinds.includes(kind!)) return invalid();
  const byteSize = integer(size!);
  if (byteSize > NATIVE_BROKER_PAYLOAD_MAX_BYTES || !base64.test(payload!)) return invalid();
  const decoded = Buffer.from(payload!, "base64");
  if (decoded.length !== byteSize || decoded.toString("base64") !== payload) return invalid();
  const byteOffset = integer(offset!);
  if (byteOffset > Number.MAX_SAFE_INTEGER - byteSize) return invalid();
  return {
    direction,
    kind,
    brokerId,
    ownerEpoch: integer(epoch!, 1),
    sequence: integer(sequence!, 1),
    requestId,
    commandId: commandId === "-" ? null : commandId,
    offset: byteOffset,
    payload: decoded,
  } as NativeBrokerFrame;
}

export function encodeNativeBrokerFrame(frame: NativeBrokerFrame): Uint8Array {
  if (
    !(frame.payload instanceof Uint8Array) ||
    frame.payload.length > NATIVE_BROKER_PAYLOAD_MAX_BYTES
  )
    return invalid();
  const encoded = [
    NATIVE_BROKER_WIRE_VERSION,
    frame.direction,
    frame.brokerId,
    frame.ownerEpoch,
    frame.sequence,
    frame.requestId,
    frame.commandId ?? "-",
    frame.kind,
    frame.offset,
    frame.payload.length,
    "base64",
    Buffer.from(frame.payload).toString("base64"),
  ].join("\t");
  const bytes = Buffer.from(encoded, "utf8");
  parse(bytes, frame.brokerId);
  return Buffer.concat([bytes, Buffer.from("\n")]);
}

/** Bounded partial framing state. This is not an output acknowledgement.
 * Callers own durable deduplication and exact shared-cursor transactions.
 * Any malformed input poisons this decoder; it cannot skip forward to a
 * plausible next frame or turn an observation gap into command EOF.
 */
export class NativeBrokerFrameDecoder {
  private partial: Uint8Array;
  private failed = false;

  constructor(
    private readonly brokerId: string,
    partial: Uint8Array = new Uint8Array(),
  ) {
    if (
      !uuid.test(brokerId) ||
      partial.length >= NATIVE_BROKER_FRAME_MAX_BYTES ||
      !validAscii(partial)
    )
      invalid();
    this.partial = Uint8Array.from(partial);
  }

  snapshot(): Uint8Array {
    if (this.failed) invalid();
    return Uint8Array.from(this.partial);
  }

  push(chunk: Uint8Array): NativeBrokerFrame[] {
    if (this.failed) invalid();
    try {
      if (!(chunk instanceof Uint8Array) || chunk.length > NATIVE_BROKER_INPUT_MAX_BYTES) invalid();
      const input = Buffer.concat([this.partial, chunk]);
      const frames: NativeBrokerFrame[] = [];
      let start = 0;
      for (let i = 0; i < input.length; i++) {
        if (input[i] !== 10) continue;
        frames.push(parse(input.subarray(start, i), this.brokerId));
        start = i + 1;
      }
      const suffix = input.subarray(start);
      if (suffix.length >= NATIVE_BROKER_FRAME_MAX_BYTES || !validAscii(suffix)) invalid();
      this.partial = Uint8Array.from(suffix);
      return frames;
    } catch (error) {
      this.failed = true;
      this.partial = new Uint8Array();
      throw error;
    }
  }

  finish(): void {
    if (this.failed || this.partial.length > 0) {
      this.failed = true;
      invalid();
    }
    // Even clean framing EOF is not a command-exit or native-drain receipt.
  }
}
