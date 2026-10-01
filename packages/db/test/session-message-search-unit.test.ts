import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SessionMessageSearchRequest, SessionMessageSearchResponse } from "@opengeni/contracts";
import {
  scanSessionMessages,
  SessionMessageSearchCursorError,
  sessionMessageLiteralPattern,
  sessionMessageSearchSnippet,
} from "../src/session-message-search";
import type { Database } from "../src/database";

test("literal metacharacters and wildcard characters are never interpreted", () => {
  for (const query of ["%", "_", "\\", ".*", "[abc]", "a+b?", "$^(){}|"]) {
    expect(sessionMessageLiteralPattern(query).exec(`prefix ${query} suffix`)?.[0]).toBe(query);
    expect(sessionMessageLiteralPattern(query).test("unrelated text")).toBe(false);
  }
});

test("Unicode simple folding preserves original UTF-16 offsets", () => {
  const text = "🙂İI Kelvin Σςσ café CAFÉ e\u0301";
  for (const query of ["i", "kelvin", "σ", "CAFÉ", "e\u0301", "🙂"]) {
    const match = sessionMessageLiteralPattern(query).exec(text)!;
    expect(match).not.toBeNull();
    const snippet = sessionMessageSearchSnippet(text, match.index, match[0].length);
    expect(snippet.text.slice(snippet.matchStart, snippet.matchEnd)).toBe(match[0]);
    expect(text.slice(match.index, match.index + match[0].length)).toBe(match[0]);
  }
  expect(sessionMessageLiteralPattern("i").exec(text)?.index).toBe(3);
  expect(sessionMessageLiteralPattern("é").test("e\u0301")).toBe(false);
  expect(sessionMessageLiteralPattern("ss").test("ß")).toBe(false);
});

test("literal whitespace, NUL, lone UTF-16 and emoji remain searchable", () => {
  for (const query of [" ", "\n", "\u0000", "\ud800", "🙂界"]) {
    expect(sessionMessageLiteralPattern(query).test(`a${query}b`)).toBe(true);
  }
});

test("snippet boundaries do not split surrogate pairs", () => {
  const text = "🙂".repeat(200) + "MATCH" + "🙂".repeat(200);
  const snippet = sessionMessageSearchSnippet(text, 400, 5);
  expect(snippet.text.slice(snippet.matchStart, snippet.matchEnd)).toBe("MATCH");
  expect(new TextDecoder().decode(new TextEncoder().encode(snippet.text))).toBe(snippet.text);
  expect(snippet.text.length).toBeLessThanOrEqual(247);
});

test("strict bounded request and explicit advancing empty response", () => {
  for (const request of [
    { query: "" },
    { query: "x", limit: 51 },
    { query: "x", includeTools: true },
    { query: "x", cursor: "x".repeat(4097) },
    { query: "x", groupBy: "message" },
    { query: "x", groupBy: "session", sessionId: "11111111-1111-4111-8111-111111111111" },
  ]) {
    expect(SessionMessageSearchRequest.safeParse(request).success).toBe(false);
  }
  expect(SessionMessageSearchRequest.parse({ query: "  " }).query).toBe("  ");
  expect(SessionMessageSearchRequest.parse({ query: "x", groupBy: "session" }).groupBy).toBe(
    "session",
  );
  expect(
    SessionMessageSearchResponse.parse({
      matches: [],
      nextCursor: "continuation",
      hasMore: true,
      scannedMessages: 32,
      matchedMessageCount: 0,
      matchedOccurrenceCount: 0,
      countIsExact: false,
    }).hasMore,
  ).toBe(true);
});

test("parent cursor scopes are fenced in every direction before candidate reads", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const authority = ["user:search", null];
  let reads = 0;
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: async () => {
      reads++;
      const identity = {
        sessionId,
        eventId: "33333333-3333-4333-8333-333333333333",
        sequence: 1,
        turnId: null,
        type: "user.message",
        sessionTitle: null,
        messageId: null,
        codec: null,
        smallText: "needle needle",
      };
      return [identity, { ...identity, sessionId: "44444444-4444-4444-8444-444444444444" }];
    },
  };
  const db = { select: () => query } as unknown as Database;
  const scopes = [undefined, null, workspaceId, sessionId];
  for (const groupBy of [undefined, "session" as const]) {
    for (const parentSessionId of scopes) {
      const request = {
        query: "needle",
        limit: 1,
        ...(groupBy ? { groupBy } : {}),
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      };
      const page = await scanSessionMessages(db, workspaceId, request, [], authority);
      expect(page.nextCursor).not.toBeNull();
      if (parentSessionId === undefined) {
        const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
        const legacyBinding = createHash("sha256")
          .update(
            JSON.stringify([
              workspaceId,
              authority,
              "needle",
              null,
              "active",
              ...(groupBy ? [{ groupBy }] : []),
            ]),
          )
          .digest("hex");
        expect(cursor.binding).toBe(legacyBinding);
      }
      // The same scope can continue, even with a different page size.
      await scanSessionMessages(
        db,
        workspaceId,
        { ...request, limit: 2, cursor: page.nextCursor! },
        [],
        authority,
      );
      for (const nextParent of scopes) {
        if (nextParent === parentSessionId) continue;
        const readsBefore = reads;
        await expect(
          scanSessionMessages(
            db,
            workspaceId,
            {
              query: "needle",
              ...(groupBy ? { groupBy } : {}),
              ...(nextParent !== undefined ? { parentSessionId: nextParent } : {}),
              cursor: page.nextCursor!,
            },
            [],
            authority,
          ),
        ).rejects.toBeInstanceOf(SessionMessageSearchCursorError);
        expect(reads).toBe(readsBefore);
      }
    }
  }
});
