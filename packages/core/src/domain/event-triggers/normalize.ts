import {
  EVENT_DATA_MAX_BYTES,
  EVENT_SUBJECT_MAX_LENGTH,
  EVENT_SUMMARY_MAX_LENGTH,
  EVENT_TYPE_MAX_LENGTH,
  type EventActor,
} from "@opengeni/contracts";

/** One event as an adapter reads it, before it is bounded and stored. */
export type NormalizedEventInput = {
  /** The sender's own id for this event, when it has one. */
  externalId: string | null;
  /** The stream inside a source the event arrived on, such as an MCP subscription. */
  streamKey?: string;
  type: string;
  occurredAt: Date;
  subject: string | null;
  summary: string;
  url: string | null;
  actor: EventActor;
  data: unknown;
  gapBefore?: boolean;
};

/** An event ready to store: every field fits its column. */
export type BoundedEvent = Omit<NormalizedEventInput, "data" | "streamKey"> & {
  streamKey: string;
  data: Record<string, unknown>;
  dataTruncated: boolean;
  gapBefore: boolean;
};

const URL_MAX_BYTES = 2048;
const EXTERNAL_ID_MAX_BYTES = 512;
const ACTOR_NAME_MAX_LENGTH = 200;
const utf8 = new TextEncoder();

export function jsonUtf8Bytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value) ?? "").byteLength;
}

/** Cut text to a character budget, marking the cut with an ellipsis. */
export function truncateText(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

/** One line: whitespace runs, including newlines, become single spaces. */
export function oneLine(value: string, maxLength: number): string {
  return truncateText(value.replace(/\s+/gu, " ").trim(), maxLength);
}

type ShrinkLimits = { strings: number; arrays: number; depth: number; keys: number };

const SHRINK_STEPS: readonly ShrinkLimits[] = [
  { strings: 4000, arrays: 100, depth: 12, keys: 200 },
  { strings: 1000, arrays: 25, depth: 8, keys: 100 },
  { strings: 200, arrays: 10, depth: 4, keys: 50 },
];

function shrink(value: unknown, limits: ShrinkLimits, depth: number): unknown {
  if (typeof value === "string") return truncateText(value, limits.strings);
  if (value === null || typeof value !== "object") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  if (depth >= limits.depth) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) {
    return value.slice(0, limits.arrays).map((entry) => shrink(entry, limits, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, limits.keys)) {
    if (entry === undefined || typeof entry === "function") continue;
    result[key] = shrink(entry, limits, depth + 1);
  }
  return result;
}

/**
 * Fit event data into `maxBytes` of JSON. Data that already fits is kept as
 * is; otherwise long strings, arrays and deep nesting are cut in steps, and as
 * a last resort only short top-level scalars remain.
 */
export function boundEventData(
  data: unknown,
  maxBytes = EVENT_DATA_MAX_BYTES,
): { data: Record<string, unknown>; truncated: boolean } {
  const object: Record<string, unknown> =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : data === undefined
        ? {}
        : { value: data };
  const plain = JSON.parse(JSON.stringify(object) ?? "{}") as Record<string, unknown>;
  if (jsonUtf8Bytes(plain) <= maxBytes) return { data: plain, truncated: false };
  for (const limits of SHRINK_STEPS) {
    const candidate = shrink(plain, limits, 0) as Record<string, unknown>;
    if (jsonUtf8Bytes(candidate) <= maxBytes) return { data: candidate, truncated: true };
  }
  const scalars: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(plain)) {
    if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) {
      const next = {
        ...scalars,
        [key]: typeof entry === "string" ? truncateText(entry, 200) : entry,
      };
      if (jsonUtf8Bytes(next) > maxBytes) break;
      Object.assign(scalars, next);
    }
  }
  return { data: scalars, truncated: true };
}

function boundedBytes(value: string | null, maxBytes: number): string | null {
  if (value === null) return null;
  return utf8.encode(value).byteLength <= maxBytes ? value : null;
}

function validTimestamp(value: Date, fallback: Date): Date {
  return Number.isFinite(value.getTime()) ? value : fallback;
}

/** Bound every field of an adapter's event so it can be stored. */
export function boundEvent(input: NormalizedEventInput, receivedAt: Date): BoundedEvent {
  const { data, truncated } = boundEventData(input.data);
  const summary = oneLine(input.summary, EVENT_SUMMARY_MAX_LENGTH) || oneLine(input.type, 200);
  const subject = input.subject === null ? null : oneLine(input.subject, EVENT_SUBJECT_MAX_LENGTH);
  return {
    externalId: boundedBytes(input.externalId, EXTERNAL_ID_MAX_BYTES),
    streamKey: input.streamKey ?? "",
    type: truncateText(input.type, EVENT_TYPE_MAX_LENGTH),
    occurredAt: validTimestamp(input.occurredAt, receivedAt),
    subject: subject || null,
    summary,
    url:
      input.url && /^https?:\/\//u.test(input.url) ? boundedBytes(input.url, URL_MAX_BYTES) : null,
    actor: {
      kind: input.actor.kind,
      name: input.actor.name ? oneLine(input.actor.name, ACTOR_NAME_MAX_LENGTH) : null,
    },
    data,
    dataTruncated: truncated,
    gapBefore: input.gapBefore ?? false,
  };
}

/** Read a dotted path such as `issue.title` from untrusted JSON. */
export function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The first path that holds a non-empty string or a number, as text. */
export function firstText(value: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    const found = readPath(value, path);
    if (typeof found === "string" && found.trim()) return found.trim();
    if (typeof found === "number" && Number.isFinite(found)) return String(found);
  }
  return null;
}

/** Parse an ISO time or a Unix time in seconds or milliseconds. */
export function parseEventTime(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}
