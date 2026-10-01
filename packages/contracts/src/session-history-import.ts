import { z } from "zod";
import { Session } from "./index";
import type { SessionEventType } from "./index";

/** Import is a server-side migration boundary, not an execution/history API. */
export const SESSION_HISTORY_IMPORT_MAX_EVENTS = 100;
export const SESSION_HISTORY_IMPORT_MAX_BODY_BYTES = 1_048_576;
export const SESSION_HISTORY_IMPORT_MAX_EVENT_BYTES = 262_144;

/** Historical facts only: no approval, credential, control or execution inputs. */
export const ARCHIVED_SESSION_IMPORT_EVENT_TYPES = [
  "user.message",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.toolCall.created",
  "agent.toolCall.output",
  "artifact.created",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
  "goal.set",
  "goal.updated",
  "goal.progress",
  "goal.completed",
  "goal.paused",
  "goal.resumed",
  "goal.cleared",
] as const satisfies readonly SessionEventType[];

export const SessionImportedArchive = /* @__PURE__ */ z
  .object({
    importId: z.string().min(1).max(200),
    importedAt: z.iso.datetime({ offset: true }),
    readOnly: z.literal(true),
  })
  .strict();
export type SessionImportedArchive = z.infer<typeof SessionImportedArchive>;

/** JS/SQL session seams preserve millisecond precision; never silently truncate. */
const sourceTimestamp = /* @__PURE__ */ z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{4}/u.test(value), "Source timestamp supports at most milliseconds");

/** Validate JSON without coercing dates, dropping undefined, or rewriting text. */
function isImportJson(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++nodes > 100_000 || entry.depth > 64) return false;
    const current = entry.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) return false;
      continue;
    }
    if (typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        if (!Object.hasOwn(current, index)) return false;
        pending.push({ value: current[index], depth: entry.depth + 1 });
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return false;
        pending.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
      if (Object.getOwnPropertySymbols(current).length > 0) return false;
    }
  }
  return true;
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export const ArchivedSessionImportEvent = /* @__PURE__ */ z
  .object({
    type: z.enum(ARCHIVED_SESSION_IMPORT_EVENT_TYPES),
    createdAt: sourceTimestamp,
    /** Source turn identity is presentation correlation; no execution row is created. */
    turnId: z.string().uuid().nullable().optional(),
    payload: z.record(z.string(), z.unknown()).refine(isImportJson, "Payload must be bounded JSON"),
  })
  .strict()
  .refine(
    (event) => isImportJson(event) && jsonBytes(event) <= SESSION_HISTORY_IMPORT_MAX_EVENT_BYTES,
    "Imported event exceeds its JSON or byte limit",
  );
export type ArchivedSessionImportEvent = z.infer<typeof ArchivedSessionImportEvent>;

const importEvents = /* @__PURE__ */ z
  .array(ArchivedSessionImportEvent)
  .max(SESSION_HISTORY_IMPORT_MAX_EVENTS);

export const ImportArchivedSessionRequest = /* @__PURE__ */ z
  .object({
    importId: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    createdAt: sourceTimestamp,
    /** The authenticated asUser actor supplies creator/owner, never a display label. */
    visibility: z.enum(["workspace_shared", "user_private"]).optional(),
    events: importEvents.default([]),
  })
  .strict()
  .refine(
    (request) => jsonBytes(request) <= SESSION_HISTORY_IMPORT_MAX_BODY_BYTES,
    "Import request exceeds its byte limit",
  );
export type ImportArchivedSessionRequest = z.input<typeof ImportArchivedSessionRequest>;

export const AppendArchivedSessionEventsRequest = /* @__PURE__ */ z
  .object({
    batchId: z.string().min(1).max(200),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .refine((value) => !Object.is(value, -0)),
    events: importEvents.min(1),
  })
  .strict()
  .refine(
    (request) => jsonBytes(request) <= SESSION_HISTORY_IMPORT_MAX_BODY_BYTES,
    "Import batch exceeds its byte limit",
  );
export type AppendArchivedSessionEventsRequest = z.infer<typeof AppendArchivedSessionEventsRequest>;

// Lazy to preserve the root contracts initialization order; SDK uses types only.
export const ImportArchivedSessionResponse = /* @__PURE__ */ z.object({
  session: /* @__PURE__ */ z.lazy(() => Session),
  importId: z.string(),
  created: z.boolean(),
  nextOffset: z.number().int().nonnegative(),
});
export type ImportArchivedSessionResponse = z.infer<typeof ImportArchivedSessionResponse>;

export const AppendArchivedSessionEventsResponse = /* @__PURE__ */ z.object({
  sessionId: z.string().uuid(),
  importId: z.string(),
  nextOffset: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export type AppendArchivedSessionEventsResponse = z.infer<
  typeof AppendArchivedSessionEventsResponse
>;
