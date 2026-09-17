import { expect, test } from "bun:test";
import { OpenGeniBrowserClient } from "../src/browser";
import { OpenGeniClient } from "../src/index";
import {
  SessionMessageSearchRequest,
  SessionMessageSearchResponse,
  SessionMessageSearchMatch,
} from "@opengeni/contracts";
import type * as SDK from "../src/session-message-search";
import type * as Browser from "../src/browser";
import type * as Root from "../src/index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const requestParity: Equal<SDK.SessionMessageSearchRequest, SessionMessageSearchRequest> = true;
const responseParity: Equal<SDK.SessionMessageSearchResponse, SessionMessageSearchResponse> = true;
const matchParity: Equal<SDK.SessionMessageSearchMatch, SessionMessageSearchMatch> = true;
const browserParity: Equal<Browser.SessionMessageSearchResponse, SDK.SessionMessageSearchResponse> =
  true;
const rootParity: Equal<Root.SessionMessageSearchResponse, SDK.SessionMessageSearchResponse> = true;
test("contracts, root SDK and browser exports stay aligned", () => {
  expect([requestParity, responseParity, matchParity, browserParity, rootParity]).toEqual([
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(typeof OpenGeniClient.prototype.searchSessionMessages).toBe("function");
});

test("browser sends literal query, filters, opaque cursor and cancellation without fetching history", async () => {
  const controller = new AbortController();
  const page = {
    matches: [],
    nextCursor: "next",
    hasMore: true,
    scannedMessages: 32,
    matchedMessageCount: 0,
    matchedOccurrenceCount: 0,
    countIsExact: false,
  };
  const calls: URL[] = [];
  const client = new OpenGeniBrowserClient({
    baseUrl: "https://example.test",
    apiKey: "test",
    fetch: async (input, init) => {
      calls.push(new URL(String(input)));
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify(page), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  expect(
    await client.searchSessionMessages(
      "workspace",
      {
        query: " %_\\🙂 ",
        sessionId: "session",
        archiveStatus: "all",
        limit: 5,
        cursor: "opaque/+?",
      },
      { signal: controller.signal },
    ),
  ).toEqual(page);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.pathname).toBe("/v1/workspaces/workspace/session-message-search");
  expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({
    query: " %_\\🙂 ",
    sessionId: "session",
    archiveStatus: "all",
    limit: "5",
    cursor: "opaque/+?",
  });
});

test("unsupported servers fail explicitly rather than falling back to titles or browser history scans", async () => {
  let calls = 0;
  const client = new OpenGeniBrowserClient({
    baseUrl: "https://example.test",
    apiKey: "test",
    fetch: async () => {
      calls++;
      return new Response("Not found", { status: 404 });
    },
  });
  await expect(client.searchSessionMessages("workspace", { query: "needle" })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("workspace grouping is explicitly serialized without changing default Find", async () => {
  const requests: URL[] = [];
  const client = new OpenGeniBrowserClient({
    baseUrl: "https://example.test",
    apiKey: "test",
    fetch: async (input) => {
      requests.push(new URL(String(input)));
      return new Response(
        JSON.stringify({
          matches: [],
          nextCursor: null,
          hasMore: false,
          scannedMessages: 0,
          matchedMessageCount: 0,
          matchedOccurrenceCount: 0,
          countIsExact: true,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  await client.searchSessionMessages("workspace", { query: "x", groupBy: "session" });
  await client.searchSessionMessages("workspace", { query: "x", sessionId: "session" });
  expect(requests[0]!.searchParams.get("groupBy")).toBe("session");
  expect(requests[1]!.searchParams.has("groupBy")).toBe(false);
});
