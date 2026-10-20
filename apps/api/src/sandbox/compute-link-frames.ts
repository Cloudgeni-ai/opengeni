/**
 * The agent link's frames (compute/docs/agent-link.md section 4). Each binary
 * WebSocket message is one frame: a JSON header, one `\n` byte, then the
 * payload bytes. Version 1; anything this does not understand is a protocol
 * error, never a guess.
 */

export const AGENT_LINK_PROTOCOL = "opengeni.agent-link.v1";
export const AGENT_LINK_VERSION = 1;

/** A frame header is small; a larger one is a protocol error. */
const MAX_HEADER_BYTES = 64 * 1024;

export type AgentLinkHeaders = Array<[string, string]>;

/** A subscription id is the host's own, echoed back on each `msg`. */
export type AgentLinkSid = string | number;

export type HostFrame =
  | { t: "open"; s: number; sandbox: string; ticket: string; connection: string }
  | { t: "sub"; s: number; sid: AgentLinkSid; subject: string; queue?: string }
  | { t: "unsub"; s: number; sid: AgentLinkSid }
  | {
      t: "pub";
      s: number;
      subject: string;
      reply?: string;
      headers?: AgentLinkHeaders;
      payload: Uint8Array;
    }
  | { t: "state"; s: number; state: "awake" | "asleep" }
  | { t: "close"; s: number };

export type AgentLinkRelay = { url: string; token: string; expires_at_ms: number };

export type RefusedCode =
  | "invalid_ticket"
  | "stale_epoch"
  | "unknown_agent"
  | "revoked"
  | "duplicate"
  | "unavailable";
export type ClosedCode = "revoked" | "superseded" | "lost";
export type ErrorCode = "permission" | "too_large";

export type GatewayFrame =
  | { t: "hello"; version: number; max_payload: number }
  | { t: "opened"; s: number; scope: string; relay: AgentLinkRelay }
  | { t: "refused"; s: number; code: RefusedCode; message: string }
  | {
      t: "msg";
      s: number;
      sid: AgentLinkSid;
      subject: string;
      reply?: string;
      headers?: AgentLinkHeaders;
      payload: Uint8Array;
    }
  | ({ t: "relay"; s: number } & AgentLinkRelay)
  | { t: "closed"; s: number; code: ClosedCode; message: string }
  | { t: "error"; s: number; code: ErrorCode; message: string; sid?: AgentLinkSid };

export class AgentLinkProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLinkProtocolError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const EMPTY = new Uint8Array(0);

/** Encode one frame: its fields as the JSON header, its payload after `\n`. */
export function encodeFrame(frame: GatewayFrame | HostFrame): Uint8Array {
  const { payload, ...header } = frame as { payload?: Uint8Array } & Record<string, unknown>;
  const head = encoder.encode(JSON.stringify(header));
  const body = payload ?? EMPTY;
  const bytes = new Uint8Array(head.byteLength + 1 + body.byteLength);
  bytes.set(head, 0);
  bytes[head.byteLength] = 0x0a;
  bytes.set(body, head.byteLength + 1);
  return bytes;
}

/** Split one frame into its parsed JSON header and its payload. */
export function splitFrame(bytes: Uint8Array): {
  header: Record<string, unknown>;
  payload: Uint8Array;
} {
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) throw new AgentLinkProtocolError("frame has no header terminator");
  if (newline > MAX_HEADER_BYTES) throw new AgentLinkProtocolError("frame header is too large");
  let header: unknown;
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(0, newline)));
  } catch {
    throw new AgentLinkProtocolError("frame header is not JSON");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new AgentLinkProtocolError("frame header is not an object");
  }
  return { header: header as Record<string, unknown>, payload: bytes.subarray(newline + 1) };
}

function sessionOf(header: Record<string, unknown>): number {
  const s = header.s;
  if (typeof s !== "number" || !Number.isSafeInteger(s) || s < 0) {
    throw new AgentLinkProtocolError("frame has no valid session number");
  }
  return s;
}

function stringField(header: Record<string, unknown>, name: string, maxLength = 4096): string {
  const value = header[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new AgentLinkProtocolError(`frame field ${name} is missing or invalid`);
  }
  return value;
}

function optionalString(
  header: Record<string, unknown>,
  name: string,
  maxLength = 4096,
): string | undefined {
  if (header[name] === undefined || header[name] === null) return undefined;
  return stringField(header, name, maxLength);
}

function sidField(header: Record<string, unknown>): AgentLinkSid {
  const sid = header.sid;
  if (typeof sid === "string" && sid.length > 0 && sid.length <= 128) return sid;
  if (typeof sid === "number" && Number.isSafeInteger(sid) && sid >= 0) return sid;
  throw new AgentLinkProtocolError("frame field sid is missing or invalid");
}

const MAX_HEADER_PAIRS = 64;

function headersField(header: Record<string, unknown>): AgentLinkHeaders | undefined {
  const value = header.headers;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_HEADER_PAIRS) {
    throw new AgentLinkProtocolError("frame field headers is invalid");
  }
  const pairs: AgentLinkHeaders = [];
  for (const pair of value) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string" ||
      pair[0].length === 0 ||
      pair[0].length > 256 ||
      pair[1].length > 4096 ||
      /[\s:]/u.test(pair[0]) ||
      /[\r\n]/u.test(pair[1])
    ) {
      throw new AgentLinkProtocolError("frame field headers is invalid");
    }
    pairs.push([pair[0], pair[1]]);
  }
  return pairs.length > 0 ? pairs : undefined;
}

/** Decode one host-to-gateway frame, or throw {@link AgentLinkProtocolError}. */
export function decodeHostFrame(bytes: Uint8Array): HostFrame {
  const { header, payload } = splitFrame(bytes);
  const t = header.t;
  if (t !== "pub" && payload.byteLength > 0) {
    throw new AgentLinkProtocolError(`frame ${String(t)} carries no payload`);
  }
  switch (t) {
    case "open":
      return {
        t,
        s: sessionOf(header),
        sandbox: stringField(header, "sandbox", 256),
        ticket: stringField(header, "ticket", 16 * 1024),
        connection: stringField(header, "connection", 128),
      };
    case "sub": {
      const queue = optionalString(header, "queue", 256);
      return {
        t,
        s: sessionOf(header),
        sid: sidField(header),
        subject: stringField(header, "subject", 1024),
        ...(queue ? { queue } : {}),
      };
    }
    case "unsub":
      return { t, s: sessionOf(header), sid: sidField(header) };
    case "pub": {
      const reply = optionalString(header, "reply", 1024);
      const headers = headersField(header);
      return {
        t,
        s: sessionOf(header),
        subject: stringField(header, "subject", 1024),
        ...(reply ? { reply } : {}),
        ...(headers ? { headers } : {}),
        payload,
      };
    }
    case "state": {
      const state = header.state;
      if (state !== "awake" && state !== "asleep") {
        throw new AgentLinkProtocolError("frame field state is invalid");
      }
      return { t, s: sessionOf(header), state };
    }
    case "close":
      return { t, s: sessionOf(header) };
    default:
      throw new AgentLinkProtocolError(`unknown frame type ${JSON.stringify(t)}`);
  }
}

/** Decode one gateway-to-host frame (the host side; tests use it). */
export function decodeGatewayFrame(bytes: Uint8Array): GatewayFrame {
  const { header, payload } = splitFrame(bytes);
  const t = header.t;
  if (t === "msg") {
    return { ...(header as Omit<Extract<GatewayFrame, { t: "msg" }>, "payload">), payload };
  }
  if (
    t === "hello" ||
    t === "opened" ||
    t === "refused" ||
    t === "relay" ||
    t === "closed" ||
    t === "error"
  ) {
    return header as GatewayFrame;
  }
  throw new AgentLinkProtocolError(`unknown frame type ${JSON.stringify(t)}`);
}

const SUBJECT_TOKEN = /^[^\s.*>]+$/u;

/** Whether `subject` is a well-formed NATS subject: dot-separated tokens with
 * no whitespace or empty token; `*` as a whole token and `>` as the last
 * token only where `wildcards` allows them. */
export function validSubject(subject: string, wildcards: boolean): boolean {
  if (subject.length === 0 || subject.length > 1024) return false;
  const tokens = subject.split(".");
  for (const [index, token] of tokens.entries()) {
    if (SUBJECT_TOKEN.test(token)) continue;
    if (wildcards && token === "*") continue;
    if (wildcards && token === ">" && index === tokens.length - 1) continue;
    return false;
  }
  return true;
}

/** Whether `subject` lies within `prefix.>`: it starts with the literal
 * prefix and names at least one more token. A wildcard in the prefix's
 * positions can never match, so a subscription cannot widen past it. */
export function subjectWithin(subject: string, prefix: string): boolean {
  return subject.startsWith(`${prefix}.`) && subject.length > prefix.length + 1;
}

/** The subjects one sandbox's session may use, as the NATS callout grants a
 * Connected Machine (workspaceAgentPermissions): subscribe within the scope;
 * publish within the scope or `_INBOX.>`. A reply subject must lie within
 * the scope, the only place the agent can hear an answer. */
export function maySubscribe(scope: string, subject: string): boolean {
  return validSubject(subject, true) && subjectWithin(subject, scope);
}

export function mayPublish(scope: string, subject: string): boolean {
  return (
    validSubject(subject, false) &&
    (subjectWithin(subject, scope) || subjectWithin(subject, "_INBOX"))
  );
}

export function mayReplyTo(scope: string, reply: string): boolean {
  return validSubject(reply, false) && subjectWithin(reply, scope);
}
