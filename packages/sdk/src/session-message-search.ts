/** Literal Unicode case-insensitive substring. Whitespace is significant. */
export type SessionMessageSearchRequest = {
  query: string;
  sessionId?: string | undefined;
  archiveStatus?: "active" | "archived" | "all" | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

export type SessionMessageSearchMatch = {
  sessionId: string;
  sessionTitle: string | null;
  eventId: string;
  sequence: number;
  turnId: string | null;
  role: "user" | "assistant";
  messageId: string | null;
  /** Zero-based UTF-16 offset in the complete visible message. */
  messageMatchOffset: number;
  /** Zero-based UTF-16 offsets in text; matchEnd is exclusive. */
  snippet: { text: string; matchStart: number; matchEnd: number };
};

export type SessionMessageSearchResponse = {
  matches: SessionMessageSearchMatch[];
  nextCursor: string | null;
  /** Empty advancing pages are valid. Continue until false. */
  hasMore: boolean;
  /** Cumulative distinct messages visited in this live traversal. */
  scannedMessages: number;
  /** Cumulative matching messages, not occurrences. */
  matchedMessageCount: number;
  /** Cumulative non-overlapping literal occurrences. */
  matchedOccurrenceCount: number;
  /** True only on exhaustion. Concurrent mutations require a fresh traversal. */
  countIsExact: boolean;
};
