import { z } from "zod";
import {
  assistantMessagePhase,
  type SessionEvent,
  type SessionEventType,
} from "@opengeni/contracts";
import type {
  SessionEventSliceOptions,
  SessionEventSlicePage,
} from "@opengeni/db/session-event-slices";

export const SESSION_EVENT_VIEW_MAX_BYTES = 16 * 1024;
/**
 * toolName with includeOutput reads each named call's result through the exact
 * callId path, so one page carries at most this many call/result pairs inside
 * the same 16 KiB envelope. An omitted limit means the newest (or oldest) one.
 */
export const SESSION_EVENT_NAMED_OUTPUT_MAX_CALLS = 3;
const directionSchema = z.enum(["before", "after"]);
// A fragment continuation issued by a named-output page carries the named
// stream's next position, so finishing the fragment returns to that stream.
const namedResumeSchema = z.object({
  toolName: z.string().min(1).max(256),
  includeArguments: z.boolean(),
  limit: z.number().int().min(1).max(SESSION_EVENT_NAMED_OUTPUT_MAX_CALLS),
  direction: directionSchema,
  after: z.number().int().nonnegative(),
  before: z.number().int().positive().nullable(),
  more: z.boolean(),
});
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
  toolName: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 512,
      "toolName exceeds the encoded cursor budget",
    )
    .nullable()
    .default(null),
  limit: z.number().int().min(1).max(50).optional(),
  direction: directionSchema,
  after: z.number().int().nonnegative(),
  before: z.number().int().positive().nullable(),
  named: namedResumeSchema.optional(),
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
  toolName?: string | undefined;
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

const MAX_CURSOR_LENGTH = 4096;
// Below this many bytes an output read could not return a useful fragment.
const NAMED_OUTPUT_MIN_BUDGET = 2048;

const exampleCall = (args: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(args).filter(([, value]) => value != null)));

/**
 * Agents sometimes retype the opaque cursor and corrupt it. Read whatever
 * position survives in the readable part so the refusal can name the exact
 * cursor-free call. Recovered values are advice, never a continuation.
 */
function recoverCursorPosition(cursor: string): Record<string, unknown> | null {
  const text = cursor.trimStart().startsWith("{")
    ? cursor
    : Buffer.from(cursor, "base64url").toString("utf8");
  const pick = (pattern: RegExp) => pattern.exec(text)?.[1];
  const number = (pattern: RegExp) => {
    const value = pick(pattern);
    return value === undefined || value.length > 15 ? undefined : Number(value);
  };
  const string = (key: string) => {
    const value = pick(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,256})"`));
    if (value === undefined) return undefined;
    try {
      return JSON.parse(`"${value}"`) as string;
    } catch {
      return undefined;
    }
  };
  const view = pick(/"view"\s*:\s*"(conversation|results|tools)"/);
  const direction = pick(/"direction"\s*:\s*"(before|after)"/) as
    | Selection["direction"]
    | undefined;
  const sequence = number(/"seq[a-z]*"\s*:\s*(\d+)/i);
  const after = number(/"after"\s*:\s*(\d+)/);
  const before = number(/"before"\s*:\s*(\d+)/);
  const limit = number(/"limit"\s*:\s*(\d+)/);
  const resolvedDirection = direction ?? (before !== undefined ? "before" : undefined);
  const position =
    resolvedDirection === "after"
      ? sequence !== undefined
        ? { after: Math.max(0, sequence - 1) }
        : after !== undefined
          ? { after }
          : null
      : resolvedDirection === "before"
        ? sequence !== undefined
          ? { before: sequence + 1 }
          : before !== undefined
            ? { before }
            : null
        : null;
  if (!position) return null;
  return {
    ...(view ? { view } : {}),
    ...(string("toolName") ? { toolName: string("toolName") } : {}),
    ...(string("callId") ? { callId: string("callId") } : {}),
    ...(/"includeArguments"\s*:\s*true/.test(text) ? { includeArguments: true } : {}),
    ...(/"includeOutput"\s*:\s*true/.test(text) ? { includeOutput: true } : {}),
    direction: resolvedDirection,
    ...position,
    ...(limit !== undefined && limit >= 1 && limit <= 50 ? { limit } : {}),
  };
}

function invalidCursorError(input: SessionEventViewInput): Error {
  const recovered = recoverCursorPosition(input.cursor ?? "");
  const prefix =
    "Invalid session_events cursor: it was not issued by session_events or was altered when copied. Pass nextCursor byte-for-byte or not at all; never retype or build one.";
  if (recovered) {
    return new Error(
      `${prefix} Its readable part names a position, so continue without a cursor: ${exampleCall({
        sessionId: input.sessionId,
        ...recovered,
      })} (check the position against the previous page's nextBefore/nextAfter).`,
    );
  }
  return new Error(
    `${prefix} Continue without a cursor: repeat the previous call with the same view and selectors plus the last page's position, e.g. ${exampleCall(
      {
        sessionId: input.sessionId,
        view: input.view,
        direction: "before",
        before: "<nextBefore>",
      },
    )} or ${exampleCall({ sessionId: input.sessionId, view: input.view, direction: "after", after: "<nextAfter>" })}.`,
  );
}

/** A cursor is a bounded selector, never authority. The caller reauthorizes every read. */
export function resolveSessionEventView(input: SessionEventViewInput) {
  let continuation: z.infer<typeof cursorSchema> | null = null;
  if (input.cursor !== undefined) {
    if (input.cursor.length > MAX_CURSOR_LENGTH)
      throw new Error("session_events cursor exceeds 4096 characters");
    try {
      continuation = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString()),
      );
    } catch {
      throw invalidCursorError(input);
    }
    const previous = continuation.selection;
    for (const key of [
      "sessionId",
      "view",
      "includeArguments",
      "includeOutput",
      "callId",
      "toolName",
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
      toolName: input.toolName ?? null,
      direction:
        input.direction ??
        (input.before !== undefined || input.after === undefined ? "before" : "after"),
      after: input.after ?? 0,
      before: input.before ?? null,
    });
  let notice: string | undefined;
  if (
    selection.view !== "tools" &&
    (selection.callId ||
      selection.toolName ||
      selection.includeArguments ||
      selection.includeOutput)
  ) {
    // callId and toolName name tool calls, which only view=tools returns, so
    // the intent is unambiguous: read them there and say so.
    if (!continuation && (selection.callId || selection.toolName)) {
      notice = `view=${selection.view} does not return tool calls; this page is view=tools because callId/toolName select tool calls.`;
      selection.view = "tools";
    } else {
      throw new Error(
        `includeArguments/includeOutput only apply to view=tools. For a tool's result call ${exampleCall(
          {
            sessionId: selection.sessionId,
            view: "tools",
            toolName: "<exact tool name>",
            includeOutput: true,
            limit: 1,
          },
        )}; view=${selection.view} already returns complete text, so drop them: ${exampleCall({
          sessionId: selection.sessionId,
          view: selection.view,
        })}.`,
      );
    }
  }
  const namedOutputs = selection.toolName !== null && selection.includeOutput;
  // Named outputs read one exact result per call, so the page size is the
  // number of calls and is clamped rather than refused; effectiveLimit and
  // nextCursor report the clamp.
  selection.limit = z
    .number()
    .int()
    .min(1)
    .max(50)
    .transform((value) =>
      namedOutputs ? Math.min(value, SESSION_EVENT_NAMED_OUTPUT_MAX_CALLS) : value,
    )
    .parse(input.limit ?? selection.limit ?? (namedOutputs ? 1 : 10));
  if (namedOutputs && continuation && continuation.sequence !== null)
    throw new Error("Invalid session_events cursor position");
  if (
    continuation &&
    ((continuation.sequence === null && continuation.offset !== 0) ||
      (continuation.sequence !== null &&
        (continuation.sequence <= selection.after ||
          (selection.before !== null && continuation.sequence >= selection.before))))
  )
    throw new Error("Invalid session_events cursor position");
  return { selection, continuation, notice };
}

function project(event: SessionEvent, selection: Selection): Item | null {
  if (event.duplicateOfEventId || (event.turnAssociation && event.turnAssociation !== "current"))
    return null;
  const p = record(event.payload);
  const base = { sequence: event.sequence, ...(event.turnId ? { turnId: event.turnId } : {}) };
  if (selection.view === "conversation") {
    // Commentary stays in the conversation, labelled so a reader can tell a
    // progress note from an answer.
    const phase = event.type === "agent.message.completed" ? assistantMessagePhase(p) : null;
    return typeof p.text === "string" && p.text.length > 0
      ? {
          ...base,
          role: event.type === "user.message" ? "user" : "assistant",
          ...(phase ? { phase } : {}),
          text: p.text,
        }
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
  if (
    selection.toolName &&
    (event.type !== "agent.toolCall.created" || p.name !== selection.toolName)
  )
    return null;
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
  const { selection, continuation, notice } = resolveSessionEventView(input);
  const scanned =
    selection.toolName !== null && selection.includeOutput
      ? await readNamedCallOutputs(selection, read)
      : await scanSessionEventView(selection, continuation, read);
  const page = selection.named ? returnToNamedStream(scanned, selection) : scanned;
  return notice === undefined ? page : { ...page, notice };
}

type Continuation = ReturnType<typeof resolveSessionEventView>["continuation"];
type ViewPage = Awaited<ReturnType<typeof scanSessionEventView>>;
type NamedResume = z.infer<typeof namedResumeSchema>;
// An omitted structured value is final; only a text fragment continues.
const incompleteFragment = (item: Item) => record(item.fragment).complete === false;

const namedSelection = (selection: Selection, named: NamedResume): Selection => ({
  sessionId: selection.sessionId,
  view: "tools",
  includeArguments: named.includeArguments,
  includeOutput: true,
  callId: null,
  toolName: named.toolName,
  limit: named.limit,
  direction: named.direction,
  after: named.after,
  before: named.before,
});

/**
 * A fragment continuation issued by a named-output page reports the named
 * stream's position, and once the fragment is complete its nextCursor returns
 * to that stream instead of ending the read.
 */
function returnToNamedStream(page: ViewPage, selection: Selection): ViewPage {
  const named = selection.named!;
  const position = {
    view: "tools" as const,
    effectiveLimit: named.limit,
    direction: named.direction,
    nextAfter: named.direction === "after" ? named.after : null,
    nextBefore: named.direction === "before" ? named.before : null,
  };
  if (page.events.some(incompleteFragment)) return { ...page, ...position };
  return {
    ...page,
    ...position,
    hasMore: named.more,
    nextCursor: named.more ? encode(namedSelection(selection, named)) : null,
  };
}

/** Re-issue a fragment cursor so it carries the named stream it came from. */
function withNamedResume(cursor: string, named: NamedResume, limit?: number): string | null {
  const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
  const encoded = encode(
    { ...decoded.selection, ...(limit === undefined ? {} : { limit }), named },
    decoded.sequence,
    decoded.offset,
    decoded.v,
  );
  return encoded.length <= MAX_CURSOR_LENGTH ? encoded : null;
}

/**
 * toolName plus includeOutput: list the named calls, then read each call's
 * result through the exact callId path. One call whose arguments or result do
 * not fit keeps that path's lossless fragment continuation, which returns to
 * the named stream when complete; later calls resume from a positional cursor
 * instead of being dropped.
 */
async function readNamedCallOutputs(selection: Selection, read: ReadPage): Promise<ViewPage> {
  const calls = await scanSessionEventView({ ...selection, includeOutput: false }, null, read);
  const ordered = selection.direction === "before" ? [...calls.events].reverse() : calls.events;
  const events: Item[] = [];
  let sourceLoss = calls.sourceLoss;
  let stop: { position: number; cursor: string | null } | null = null;
  const envelope = (items: Item[]) => bytes({ ...calls, events: items, nextCursor: null });
  const empty = envelope([]);
  // The named stream continues past `sequence`, the call just returned.
  const resumePast = (sequence: number, more: boolean): NamedResume => ({
    toolName: selection.toolName!,
    includeArguments: selection.includeArguments,
    limit: selection.limit!,
    direction: selection.direction,
    after: selection.direction === "after" ? sequence : selection.after,
    before: selection.direction === "before" ? sequence : selection.before,
    more,
  });
  // stop.position is the first named call not yet returned (inclusive).
  const pastCall = (call: Item) =>
    selection.direction === "before" ? call.sequence - 1 : call.sequence + 1;
  for (const [index, call] of ordered.entries()) {
    const later = index + 1 < ordered.length || calls.hasMore;
    const lookup = selectionSchema.safeParse({
      sessionId: selection.sessionId,
      view: "tools",
      includeArguments: false,
      includeOutput: true,
      callId: typeof call.callId === "string" ? call.callId : null,
      toolName: null,
      limit: 1,
      direction: "after",
      after: call.sequence,
      before: null,
    });
    const readOutput =
      lookup.success && lookup.data.callId !== null
        ? { readOutput: { view: "tools", callId: lookup.data.callId, includeOutput: true } }
        : {};
    if (incompleteFragment(call)) {
      if (index > 0) {
        stop = { position: call.sequence, cursor: null };
        break;
      }
      // Arguments larger than a page continue losslessly one call at a time
      // and then return to the named stream; the result is one exact read.
      events.push({ ...call, ...readOutput });
      stop = {
        position: pastCall(call),
        cursor:
          withNamedResume(calls.nextCursor!, resumePast(call.sequence, true), 1) ??
          calls.nextCursor,
      };
      break;
    }
    if (!lookup.success || lookup.data.callId === null) {
      events.push({
        ...call,
        outputUnavailable:
          call.identityOmitted === true || typeof call.callId !== "string"
            ? "call_identity_omitted"
            : "call_id_exceeds_lookup_budget",
      });
      continue;
    }
    const used = envelope([...events, call]) - empty;
    // The result repeats the call's identity, so budget for it plus some text.
    const { text: _arguments, ...identity } = call;
    if (SESSION_EVENT_VIEW_MAX_BYTES - 6000 - used < NAMED_OUTPUT_MIN_BUDGET + bytes(identity)) {
      if (index > 0) {
        stop = { position: call.sequence, cursor: null };
        break;
      }
      // Huge arguments leave no room: return the call and name the exact read.
      events.push({ ...call, ...readOutput });
      stop = { position: pastCall(call), cursor: null };
      break;
    }
    const output = await scanSessionEventView(lookup.data, null, read, used);
    sourceLoss ??= output.sourceLoss;
    const result = output.events.find((item) => item.kind === "result");
    if (!result) {
      events.push({ ...call, outputFound: false, ...(output.hasMore ? readOutput : {}) });
      continue;
    }
    if (incompleteFragment(result)) {
      if (index > 0) {
        stop = { position: call.sequence, cursor: null };
        break;
      }
      // The rest of this result continues through its exact callId cursor,
      // which returns to the named stream when the result is complete.
      const cursor = withNamedResume(output.nextCursor!, resumePast(call.sequence, later));
      events.push(...(cursor ? [call, result] : [{ ...call, ...readOutput }]));
      stop = { position: pastCall(call), cursor };
      break;
    }
    events.push(call, result);
  }
  events.sort((a, b) => a.sequence - b.sequence);
  const position = stop
    ? selection.direction === "before"
      ? { after: selection.after, before: stop.position + 1 }
      : { after: Math.max(0, stop.position - 1), before: selection.before }
    : selection.direction === "before"
      ? { after: selection.after, before: calls.nextBefore }
      : { after: calls.nextAfter ?? selection.after, before: selection.before };
  const hasMore = stop !== null || calls.hasMore;
  const { sourceLoss: _callsLoss, ...base } = calls;
  return {
    ...base,
    events,
    nextAfter: selection.direction === "after" ? position.after : null,
    nextBefore: selection.direction === "before" ? position.before : null,
    hasMore,
    nextCursor: stop?.cursor ?? (hasMore ? encode({ ...selection, ...position }) : null),
    sourceExact: sourceLoss === undefined,
    ...(sourceLoss ? { sourceLoss } : {}),
  };
}

async function scanSessionEventView(
  selection: Selection,
  continuation: Continuation,
  read: ReadPage,
  // Bytes a caller already holds for the same envelope (named outputs).
  reservedBytes = 0,
) {
  const limit = selection.limit!;
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
    effectiveLimit: limit,
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
      includeTypes: selection.toolName ? ["agent.toolCall.created"] : types[selection.view],
      ...(selection.toolName ? { toolName: selection.toolName } : {}),
      ...(selection.callId ? { callId: selection.callId } : {}),
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
        if (bytes(page()) > SESSION_EVENT_VIEW_MAX_BYTES - 4096 - reservedBytes) {
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
            if (
              bytes({ ...item, text: text.slice(0, mid) }) <=
              SESSION_EVENT_VIEW_MAX_BYTES - 6000 - reservedBytes
            )
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
