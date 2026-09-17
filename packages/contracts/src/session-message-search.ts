import { z } from "zod";

/** Literal Unicode case-insensitive search, without trimming or normalization. */
export const SessionMessageSearchRequest = z
  .object({
    query: z.string().min(1).max(200),
    sessionId: z.string().uuid().optional(),
    archiveStatus: z.enum(["active", "archived", "all"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type SessionMessageSearchRequest = z.infer<typeof SessionMessageSearchRequest>;

export const SessionMessageSearchMatch = z.object({
  sessionId: z.string().uuid(),
  sessionTitle: z.string().nullable(),
  eventId: z.string().uuid(),
  sequence: z.number().int().positive(),
  turnId: z.string().uuid().nullable(),
  role: z.enum(["user", "assistant"]),
  messageId: z.string().nullable(),
  /** All offsets are zero-based UTF-16 code units; ends are exclusive. */
  messageMatchOffset: z.number().int().nonnegative(),
  snippet: z.object({
    text: z.string(),
    matchStart: z.number().int().nonnegative(),
    matchEnd: z.number().int().nonnegative(),
  }),
});
export type SessionMessageSearchMatch = z.infer<typeof SessionMessageSearchMatch>;

/** A bounded scan page, not necessarily a full page of matches. Continue even
 * after an empty page while hasMore is true. Counts describe this live traversal,
 * not a frozen snapshot; restart to reflect concurrent changes. All non-overlapping
 * literal occurrences in user messages and completed assistant messages.
 */
export const SessionMessageSearchResponse = z.object({
  matches: z.array(SessionMessageSearchMatch).max(50),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  scannedMessages: z.number().int().nonnegative(),
  matchedMessageCount: z.number().int().nonnegative(),
  matchedOccurrenceCount: z.number().int().nonnegative(),
  countIsExact: z.boolean(),
});
export type SessionMessageSearchResponse = z.infer<typeof SessionMessageSearchResponse>;
