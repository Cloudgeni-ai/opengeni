import { z } from "zod";
import type { SessionEvent, SessionEventType } from "@opengeni/contracts";
import type {
  SessionEventSliceOptions,
  SessionEventSlicePage,
} from "@opengeni/db/session-event-slices";

export const SESSION_EVENT_VIEW_MAX_BYTES = 16 * 1024;
const selectionSchema = z.object({
  sessionId: z.string().uuid(),
  view: z.enum(["conversation", "results", "tools"]),
  includeArguments: z.boolean(),
  includeOutput: z.boolean(),
  callId: z
    .string()
    .max(512)
    .refine(
      (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 2048,
      "callId exceeds the encoded cursor budget",
    )
    .nullable(),
  direction: z.enum(["before", "after"]),
  after: z.number().int().nonnegative(),
  before: z.number().int().positive().nullable(),
});
const cursorSchema = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  selection: selectionSchema,
  sequence: z.number().int().positive().nullable(),
  offset: z.number().int().nonnegative().max(2_147_483_647),
});
type Selection = z.infer<typeof selectionSchema>;
export type SessionEventViewInput = {
  sessionId: string;
  view?: Selection["view"] | undefined;
  after?: number | undefined;
  before?: number | undefined;
  direction?: Selection["direction"] | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  callId?: string | undefined;
  includeArguments?: boolean | undefined;
  includeOutput?: boolean | undefined;
};
type Item = { sequence: number; turnId?: string; role?: string; text?: string } & Record<
  string,
  unknown
>;
type ReadPage = (options: SessionEventSliceOptions) => Promise<SessionEventSlicePage>;
const types: Record<Selection["view"], SessionEventType[]> = {
  conversation: ["user.message", "agent.message.completed"],
  // Final turn output is authoritative: do not repeat message.completed text.
  results: ["turn.completed", "turn.failed", "goal.completed", "goal.paused", "tool.auth_needed"],
  tools: ["agent.toolCall.created", "agent.toolCall.output"],
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
const encode = (selection: Selection, sequence: number | null = null, offset = 0, v = 2) =>
  Buffer.from(JSON.stringify({ v, selection, sequence, offset })).toString("base64url");

/** A cursor is a bounded selector, never authority. The caller reauthorizes every read. */
export function resolveSessionEventView(input: SessionEventViewInput) {
  let continuation: z.infer<typeof cursorSchema> | null = null;
  if (input.cursor !== undefined) {
    if (input.cursor.length > 4096)
      throw new Error("session_events cursor exceeds 4096 characters");
    try {
      continuation = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString()),
      );
    } catch {
      throw new Error("Invalid session_events cursor");
    }
    const previous = continuation.selection;
    for (const key of [
      "sessionId",
      "view",
      "includeArguments",
      "includeOutput",
      "callId",
      "direction",
      "after",
      "before",
    ] as const) {
      if (input[key] !== undefined && input[key] !== previous[key]) {
        throw new Error(`session_events cursor cannot change ${key}`);
      }
    }
  }
  const selection =
    continuation?.selection ??
    selectionSchema.parse({
      sessionId: input.sessionId,
      view: input.view ?? "conversation",
      includeArguments: input.includeArguments ?? false,
      includeOutput: input.includeOutput ?? false,
      callId: input.callId ?? null,
      direction:
        input.direction ??
        (input.before !== undefined || input.after === undefined ? "before" : "after"),
      after: input.after ?? 0,
      before: input.before ?? null,
    });
  if (
    selection.view !== "tools" &&
    (selection.callId || selection.includeArguments || selection.includeOutput)
  ) {
    throw new Error("callId/includeArguments/includeOutput require view=tools");
  }
  if (
    continuation &&
    ((continuation.sequence === null && continuation.offset !== 0) ||
      (continuation.sequence !== null &&
        (continuation.sequence <= selection.after ||
          (selection.before !== null && continuation.sequence >= selection.before))))
  )
    throw new Error("Invalid session_events cursor position");
  return { selection, continuation };
}

function project(event: SessionEvent, selection: Selection): Item | null {
  if (event.duplicateOfEventId || (event.turnAssociation && event.turnAssociation !== "current"))
    return null;
  const p = record(event.payload);
  const base = { sequence: event.sequence, ...(event.turnId ? { turnId: event.turnId } : {}) };
  if (selection.view === "conversation") {
    return typeof p.text === "string" && p.text.length > 0
      ? { ...base, role: event.type === "user.message" ? "user" : "assistant", text: p.text }
      : null;
  }
  if (selection.view === "results") {
    if (event.type === "turn.completed" && ("maintenance" in p || "segmentLimit" in p)) return null;
    const value = event.type === "turn.completed" ? (p.output ?? p.result) : p;
    if (value === undefined || value === "") return null;
    return {
      ...base,
      type: event.type,
      text: typeof value === "string" ? value : JSON.stringify(value),
    };
  }
  const callId = p.callId ?? p.call_id ?? p.id;
  if (selection.callId !== null && selection.callId !== callId) return null;
  const output = event.type === "agent.toolCall.output";
  // Choose one canonical slot. Never ship the raw receipt beside its parsed copy.
  const value = output ? p.output : (p.arguments ?? p.args);
  return {
    ...base,
    callId,
    kind: output ? "result" : "call",
    ...(typeof p.name === "string" ? { name: p.name } : {}),
    ...(p.identityOmitted === true ? { identityOmitted: true } : {}),
    ...(p.isError === true || record(value).isError === true ? { isError: true } : {}),
    ...((output ? selection.includeOutput : selection.includeArguments) && value !== undefined
      ? {
          text: typeof value === "string" ? value : JSON.stringify(value),
          encoding: typeof value === "string" ? "text" : "json",
        }
      : {}),
  };
}

/** Read-only projection over the existing RLS/audit query. No command observations. */
export async function readSessionEventView(input: SessionEventViewInput, read: ReadPage) {
  const { selection, continuation } = resolveSessionEventView(input);
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  let after =
    continuation?.sequence && selection.direction === "after"
      ? continuation.sequence - 1
      : selection.after;
  let before =
    continuation?.sequence && selection.direction === "before"
      ? continuation.sequence + 1
      : selection.before;
  const events: Item[] = [];
  let hasMore = false;
  let nextCursor: string | null = null;
  let sourceExact = true;
  let edge: number | null = null;
  let legacyActive = continuation?.v === 1 && continuation.sequence !== null;
  const page = () => ({
    view: selection.view,
    direction: selection.direction,
    events,
    nextAfter: selection.direction === "after" ? (edge ?? selection.after) : null,
    nextBefore: selection.direction === "before" ? (edge ?? selection.before) : null,
    hasMore,
    nextCursor,
    sourceExact,
    ...(!sourceExact
      ? {
          sourceLoss: {
            reason: "structured_value_exceeds_budget" as const,
            completeTextAvailable: false as const,
            message:
              "An oversized structured value was omitted. Scalar text remains retrievable through continuation; omitted structured values are not complete JSON results.",
          },
        }
      : {}),
    maxBytes: SESSION_EVENT_VIEW_MAX_BYTES,
  });
  const resume = (sequence: number, offset = 0) => {
    hasMore = true;
    nextCursor = encode(
      { ...selection, after, before },
      sequence,
      offset,
      legacyActive && sequence === continuation?.sequence ? 1 : 2,
    );
  };
  // Bound work even when a sparse exact callId lookup matches nothing. The
  // returned cursor advances the scan without claiming the lookup is exhausted.
  for (let scan = 0; scan < 64; scan += 1) {
    const source = await read({
      after,
      ...(before === null ? {} : { before }),
      direction: selection.direction,
      limit: 8,
      includeTypes: types[selection.view],
      payloadMode: "full",
      excludeUnclaimedHumanPrompts: true,
      maxBytes: 1024 * 1024,
      legacyUtf16: legacyActive,
      view: selection.view,
      includeArguments: selection.includeArguments,
      includeOutput: selection.includeOutput,
      ...(continuation?.sequence
        ? { sourceSequence: continuation.sequence, sourceOffset: continuation.offset }
        : {}),
    });
    sourceExact &&= source.fullPayloadsExact;
    const ordered = selection.direction === "before" ? [...source.events].reverse() : source.events;
    for (const event of ordered) {
      const slice = source.slices?.[event.sequence];
      const item = project(event, selection);
      if (item) {
        const offset = continuation?.sequence === event.sequence ? continuation.offset : 0;
        if (slice?.omitted) {
          delete item.text;
          item.sourceOmitted = { reason: "structured_value_exceeds_budget", complete: false };
        }
        const advance = (text: string) =>
          slice?.unit === "codepoint" ? Array.from(text).length : text.length;
        if (!slice && offset > (item.text?.length ?? 0))
          throw new Error("Invalid message continuation offset");
        if (
          !slice &&
          offset > 0 &&
          item.text &&
          /[\uD800-\uDBFF]/.test(item.text[offset - 1]!) &&
          /[\uDC00-\uDFFF]/.test(item.text[offset] ?? "")
        ) {
          throw new Error("Invalid message continuation offset: splits a surrogate pair");
        }
        if (!slice && offset > 0 && item.text) item.text = item.text.slice(offset);
        events.push(item);
        // Reserve enough for the bounded cursor and fragment facts.
        if (bytes(page()) > SESSION_EVENT_VIEW_MAX_BYTES - 4096) {
          events.pop();
          if (events.length > 0) {
            resume(event.sequence, offset);
            if (selection.direction === "before") events.reverse();
            return page();
          }
          if (!item.text) throw new Error("Session event identity exceeds page budget");
          const text = item.text;
          let low = 0;
          let high = text.length;
          while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (bytes({ ...item, text: text.slice(0, mid) }) <= SESSION_EVENT_VIEW_MAX_BYTES - 6000)
              low = mid;
            else high = mid - 1;
          }
          // Do not split a UTF-16 surrogate pair (UTF-8 remains lossless).
          if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low -= 1;
          if (low === 0) throw new Error("Session event identity exceeds page budget");
          events.push({
            ...item,
            text: text.slice(0, low),
            fragment: {
              offset,
              nextOffset: offset + advance(text.slice(0, low)),
              complete: false,
              unit: slice?.unit ?? "utf16",
            },
          });
          resume(event.sequence, offset + advance(text.slice(0, low)));
          return page();
        }
        const nextOffset = offset + advance(item.text ?? "");
        if (slice && !slice.omitted && nextOffset < slice.total) {
          item.fragment = { offset, nextOffset, complete: false, unit: slice.unit };
          resume(event.sequence, nextOffset);
          if (selection.direction === "before") events.reverse();
          return page();
        }
        if (offset > 0)
          item.fragment = {
            offset,
            nextOffset,
            complete: true,
            unit: slice?.unit ?? "utf16",
          };
      }
      edge = event.sequence;
      legacyActive = false;
      if (selection.direction === "after") after = event.sequence;
      else before = event.sequence;
      if (events.length >= limit) {
        hasMore = source.hasMore || event !== ordered.at(-1);
        nextCursor = hasMore ? encode({ ...selection, after, before }) : null;
        if (selection.direction === "before") events.reverse();
        return page();
      }
    }
    // Metadata selection can advance over stale/duplicate rows without a
    // projected payload. Use its covered edge rather than repeating the page.
    if (source.coveredSequence) {
      if (selection.direction === "after") after = Math.max(after, source.coveredSequence.last);
      else before = Math.min(before ?? Infinity, source.coveredSequence.first);
    }
    if (!source.hasMore) {
      hasMore = false;
      nextCursor = null;
      if (selection.direction === "before") events.reverse();
      return page();
    }
    hasMore = true;
    nextCursor = encode({ ...selection, after, before });
  }
  if (selection.direction === "before") events.reverse();
  return page();
}
