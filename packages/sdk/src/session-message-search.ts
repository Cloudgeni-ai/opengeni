/** Literal Unicode case-insensitive substring. Whitespace is significant. */
export type SessionMessageSearchRequest = {
  query: string;
  sessionId?: string | undefined;
  /** Workspace-only first hit per session; cannot combine with sessionId. */
  groupBy?: "session" | undefined;
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
  /** Cumulative matching messages, or session representatives with groupBy=session. */
  matchedMessageCount: number;
  /** Cumulative occurrences, or session representatives with groupBy=session. */
  matchedOccurrenceCount: number;
  /** True only on exhaustion. Concurrent mutations require a fresh traversal. */
  countIsExact: boolean;
};

/** Exact selected event reference from a search match; no payload fields are read. */
export type SessionMessagePreviewReference = { eventId: string; sequence: number };

/** A complete visible message, or an explicit over-12,000-UTF-16-unit result. */
export type SessionMessagePreview =
  | { status: "available"; text: string }
  | { status: "unavailable" };
