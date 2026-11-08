import { expect, spyOn, test } from "bun:test";
import { parseSync } from "oxc-parser";
import { OpenGeniClient } from "../src/client";
import {
  OPENGENI_BROWSER_RESPONSE_HEADERS,
  OPENGENI_BROWSER_REQUEST_HEADERS,
  OPENGENI_SESSION_CHAT_ACCEPT,
} from "../src/index";
import { OPENGENI_BROWSER_RESPONSE_HEADERS as browserHeaders } from "../src/browser";
import { makeEvent, SESSION_ID, WORKSPACE_ID } from "./helpers";

const headers = {
  "X-OpenGeni-Has-More": "true",
  "X-OpenGeni-Next-Before": "42",
  "X-OpenGeni-Covered-First": "42",
  "X-OpenGeni-Covered-Last": "42",
  "X-OpenGeni-Page-Bytes": "200",
  "X-OpenGeni-Page-Max-Bytes": "1048576",
  "X-OpenGeni-Page-Truncated": "true",
  "X-OpenGeni-Event-Mode": "forensic",
  "X-OpenGeni-Event-Direction": "before",
  "X-OpenGeni-Payload-Mode": "full",
  "X-OpenGeni-Forensic-Exact": "false",
  "X-OpenGeni-Conversation-Filter": "2",
};

test("all literal response header reads stay in the exported browser contract", async () => {
  expect(browserHeaders).toBe(OPENGENI_BROWSER_RESPONSE_HEADERS);
  expect(new Set(browserHeaders).size).toBe(browserHeaders.length);
  for (const file of ["client.ts", "document-authority-client.ts"]) {
    const source = await Bun.file(new URL(`../src/${file}`, import.meta.url)).text();
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const node = value as Record<string, any>;
      if (
        node.type === "CallExpression" &&
        ((node.callee?.type === "MemberExpression" &&
          node.callee.property?.name === "get" &&
          (node.callee.object?.property?.name === "headers" ||
            node.callee.object?.name === "headers")) ||
          node.callee?.name === "integerHeader") &&
        typeof node.arguments?.[0]?.value === "string"
      ) {
        expect(browserHeaders as readonly string[]).toContain(
          node.arguments[0].value.toLowerCase(),
        );
      }
      Object.values(node).forEach(visit);
    };
    visit(parseSync(file, source).program);
  }
});

test("paging metadata works when the relay exposes the shared list", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const client = new OpenGeniClient({
      baseUrl: "https://relay.example.test",
      fetch: async () => Response.json([makeEvent(42)], { headers }),
    });
    const page = await client.listEventPage(WORKSPACE_ID, SESSION_ID, {
      presentedToolCalls: "include",
    });
    expect(page).toMatchObject({
      hasMore: true,
      nextBefore: 42,
      conversationFilter: 2,
      coveredSequence: { first: 42, last: 42 },
      bytes: 200,
    });
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("missing or CORS-hidden headers warn once per client, not silently", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const client = new OpenGeniClient({
      baseUrl: "https://relay.example.test",
      fetch: async () => Response.json([makeEvent(42)]),
    });
    for (let n = 0; n < 2; n++)
      await client.listEventPage(WORKSPACE_ID, SESSION_ID, { presentedToolCalls: "include" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("OPENGENI_BROWSER_RESPONSE_HEADERS");
    expect(warn.mock.calls[0]![0]).toContain("Access-Control-Expose-Headers");
    expect(warn.mock.calls[0]![0]).toContain("X-OpenGeni-Has-More");
  } finally {
    warn.mockRestore();
  }
});

test("empty terminal pages do not require optional coverage or cursor headers", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const empty = new Headers(headers);
    for (const name of [
      "X-OpenGeni-Covered-First",
      "X-OpenGeni-Covered-Last",
      "X-OpenGeni-Next-Before",
    ])
      empty.delete(name);
    empty.set("X-OpenGeni-Has-More", "false");
    const client = new OpenGeniClient({
      baseUrl: "https://relay.example.test",
      fetch: async () => Response.json([], { headers: empty }),
    });
    expect((await client.listEventPage(WORKSPACE_ID, SESSION_ID)).hasMore).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("configuration is an explicit read and does not populate the ordinary session cache", async () => {
  const paths: string[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async (url, init) => {
      expect(new Headers(init?.headers).get("accept")).toBe(OPENGENI_SESSION_CHAT_ACCEPT);
      paths.push(String(url));
      return Response.json(
        String(url).endsWith("/configuration")
          ? { id: SESSION_ID, instructions: "operator only", skills: [] }
          : { id: SESSION_ID },
      );
    },
  });
  expect((await client.getSessionConfiguration(WORKSPACE_ID, SESSION_ID)).instructions).toBe(
    "operator only",
  );
  expect((await client.getSession(WORKSPACE_ID, SESSION_ID)).instructions).toBeUndefined();
  expect(paths).toHaveLength(2);
  expect(OPENGENI_BROWSER_REQUEST_HEADERS).toContain("accept");
});
