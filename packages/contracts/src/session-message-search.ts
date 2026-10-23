import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

/** Literal Unicode case-insensitive search, without trimming or normalization. */
export const SessionMessageSearchRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      query: z.string().min(1).max(200),
      sessionId: primitives.optionalUuid,
      groupBy: z.literal("session").optional(),
      archiveStatus: z.enum(["active", "archived", "all"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().min(1).max(4096).optional(),
    })
    .strict()
    .refine((request) => !request.groupBy || !request.sessionId, {
      message: "groupBy=session is only supported for workspace search without sessionId",
      path: ["groupBy"],
    }),
);
export type SessionMessageSearchRequest = z.infer<typeof SessionMessageSearchRequest>;

export const SessionMessageSearchMatch = /* @__PURE__ */ defineSchema(() =>
  z.object({
    sessionId: primitives.uuid,
    sessionTitle: primitives.nullableString,
    eventId: primitives.uuid,
    sequence: primitives.positiveInteger,
    turnId: primitives.nullableUuid,
    role: z.enum(["user", "assistant"]),
    messageId: primitives.nullableString,
    /** All offsets are zero-based UTF-16 code units; ends are exclusive. */
    messageMatchOffset: primitives.nonnegativeInteger,
    snippet: z.object({
      text: primitives.string,
      matchStart: primitives.nonnegativeInteger,
      matchEnd: primitives.nonnegativeInteger,
    }),
  }),
);
export type SessionMessageSearchMatch = z.infer<typeof SessionMessageSearchMatch>;

/** A bounded scan page, not necessarily a full page of matches. Continue even
 * after an empty page while hasMore is true. Counts describe this live traversal,
 * not a frozen snapshot; restart to reflect concurrent changes. All non-overlapping
 * literal occurrences in user messages and completed assistant messages.
 * With groupBy=session, matches and both matched counts describe one first-hit
 * representative per matching session, not full message/occurrence totals.
 */
export const SessionMessageSearchResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    matches: z.array(SessionMessageSearchMatch).max(50),
    nextCursor: primitives.nullableString,
    hasMore: primitives.boolean,
    scannedMessages: primitives.nonnegativeInteger,
    matchedMessageCount: primitives.nonnegativeInteger,
    matchedOccurrenceCount: primitives.nonnegativeInteger,
    countIsExact: primitives.boolean,
  }),
);
export type SessionMessageSearchResponse = z.infer<typeof SessionMessageSearchResponse>;
