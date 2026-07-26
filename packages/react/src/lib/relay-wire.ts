// Minimal HAND-MIRROR of the relay stream wire messages the desktop frame client
// needs (`StreamOpen` encode; `StreamOpenAck` + `StreamFrame` decode). It exists
// because the publish-closure guard (scripts/publish-closure-guard.ts) forbids
// `@opengeni/react` from depending on `@opengeni/agent-proto` — the published SDK
// closure may only reach `@opengeni/sdk` among `@opengeni/*` packages. So, exactly
// as the guard prescribes ("hand-mirror it"), we re-encode just these three
// messages against the third-party `@bufbuild/protobuf/wire` runtime (the same
// runtime `@opengeni/agent-proto` generates against), byte-compatible with the
// generated code. Field numbers copied verbatim from
// `packages/agent-proto/src/gen/opengeni_agent.ts`:
//   StreamChannel: channelId=1, workspaceId=2, agentId=3, kind=4(int32), port=5(uint32)
//   StreamOpen:    channel=1(msg), token=2, role=3(int32), resumeFromSeq=4(uint64, omitted when "0")
//   StreamOpenAck: accepted=1(bool), error=2(AgentError msg), resumeFromSeq=3
//   AgentError:    code=1, message=2, retryable=3, detail=4  (we read only message)
//   StreamFrame:   channelId=1, seq=2, data=3(bytes), producedAtMs=4  (we read only data)
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";

/** `StreamKind.STREAM_KIND_DESKTOP` (agent-proto enum value). */
export const STREAM_KIND_DESKTOP = 2;
/** `StreamRole.STREAM_ROLE_CLIENT` (agent-proto enum value). */
export const STREAM_ROLE_CLIENT = 2;

export interface RelayChannel {
  channelId: string;
  workspaceId: string;
  agentId: string;
  kind: number;
  port: number;
}

export interface RelayStreamOpen {
  channel: RelayChannel;
  token: string;
  role: number;
  resumeFromSeq: string;
}

function encodeChannel(message: RelayChannel, writer: BinaryWriter): BinaryWriter {
  if (message.channelId !== "") writer.uint32(10).string(message.channelId);
  if (message.workspaceId !== "") writer.uint32(18).string(message.workspaceId);
  if (message.agentId !== "") writer.uint32(26).string(message.agentId);
  if (message.kind !== 0) writer.uint32(32).int32(message.kind);
  if (message.port !== 0) writer.uint32(40).uint32(message.port);
  return writer;
}

/** Encode a `StreamOpen`, byte-compatible with `StreamOpen.encode(...).finish()`. */
export function encodeStreamOpen(message: RelayStreamOpen): Uint8Array {
  const writer = new BinaryWriter();
  encodeChannel(message.channel, writer.uint32(10).fork()).join();
  if (message.token !== "") writer.uint32(18).string(message.token);
  if (message.role !== 0) writer.uint32(24).int32(message.role);
  if (message.resumeFromSeq !== "0") writer.uint32(32).uint64(message.resumeFromSeq);
  return writer.finish();
}

/** The only `AgentError` field we surface from a rejected ack. */
function decodeAgentErrorMessage(reader: BinaryReader, length: number): { message?: string } {
  const end = reader.pos + length;
  let message: string | undefined;
  while (reader.pos < end) {
    const tag = reader.uint32();
    if (tag >>> 3 === 2 && tag === 18) {
      message = reader.string();
      continue;
    }
    if ((tag & 7) === 4 || tag === 0) break;
    reader.skip(tag & 7);
  }
  return message !== undefined ? { message } : {};
}

/** Decode a `StreamOpenAck` (we need `accepted` + the error message). */
export function decodeStreamOpenAck(bytes: Uint8Array): {
  accepted: boolean;
  error?: { message?: string };
} {
  const reader = new BinaryReader(bytes);
  const end = reader.len;
  let accepted = false;
  let error: { message?: string } | undefined;
  while (reader.pos < end) {
    const tag = reader.uint32();
    if (tag >>> 3 === 1 && tag === 8) {
      accepted = reader.bool();
      continue;
    }
    if (tag >>> 3 === 2 && tag === 18) {
      error = decodeAgentErrorMessage(reader, reader.uint32());
      continue;
    }
    if ((tag & 7) === 4 || tag === 0) break;
    reader.skip(tag & 7);
  }
  return error !== undefined ? { accepted, error } : { accepted };
}

/** Decode a `StreamFrame`, extracting only the `data` (framebuffer PNG) bytes. */
export function decodeStreamFrame(bytes: Uint8Array): { data: Uint8Array } {
  const reader = new BinaryReader(bytes);
  const end = reader.len;
  let data = new Uint8Array(0);
  while (reader.pos < end) {
    const tag = reader.uint32();
    if (tag >>> 3 === 3 && tag === 26) {
      // Copy into a fresh ArrayBuffer-backed view: BinaryReader.bytes() returns
      // `Uint8Array<ArrayBufferLike>` (a view into the message buffer), which both
      // narrows the type to `Uint8Array<ArrayBuffer>` and isolates just this frame.
      data = new Uint8Array(reader.bytes());
      continue;
    }
    if ((tag & 7) === 4 || tag === 0) break;
    reader.skip(tag & 7);
  }
  return { data };
}
