import { expect, test } from "bun:test";
import { SessionMessageSearchRequest, SessionMessageSearchResponse } from "@opengeni/contracts";
import {
  sessionMessageLiteralPattern,
  sessionMessageSearchSnippet,
} from "../src/session-message-search";

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
  ]) {
    expect(SessionMessageSearchRequest.safeParse(request).success).toBe(false);
  }
  expect(SessionMessageSearchRequest.parse({ query: "  " }).query).toBe("  ");
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
