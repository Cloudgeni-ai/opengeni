import { expect, test } from "bun:test";
import { BrowserAccountsClient } from "../src/accounts";
import { OpenGeniClient } from "../src/client";
import { SESSION_SCOPE_HEADER } from "../src/message-links";
import {
  type ClientAuthConfig,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_BROWSER_REQUEST_HEADERS,
  OPENGENI_CORRELATION_HEADER,
  OPENGENI_SDK_VERSION_HEADER,
} from "../src/types";

// Hosts copy OPENGENI_BROWSER_REQUEST_HEADERS into their CORS allow-list. A header
// the browser sends that is missing there fails every preflight, so this sweep
// calls every method of the browser clients and refuses any header outside it.

const ID = "11111111-1111-4111-8111-111111111111";
const allowed = new Set<string>(OPENGENI_BROWSER_REQUEST_HEADERS);

const OPTIONS = [
  { range: "bytes=0-1", format: "csv", limit: 1, after: 1, cursor: "c" },
  { range: "bytes=0-1", format: "json", operationId: ID, expectedGeneration: "1" },
];
const ARGUMENTS: unknown[][] = [
  [],
  [ID, ID, ID, ID],
  ...OPTIONS.flatMap((options) => [
    [options],
    [ID, options],
    [ID, ID, options],
    [ID, ID, ID, options],
    [ID, ID, ID, ID, options],
  ]),
];

function methodNames(target: object): string[] {
  const names = new Set<string>();
  for (
    let prototype = Object.getPrototypeOf(target);
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) names.add(name);
  }
  names.delete("constructor");
  return [...names].sort();
}

/** Calls every method with each argument shape; returns header name -> first method. */
async function sweep(
  build: (fetch: typeof globalThis.fetch) => object,
  respond: () => Response,
): Promise<Map<string, string>> {
  const sent = new Map<string, string>();
  let current = "";
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    for (const name of request.headers.keys()) if (!sent.has(name)) sent.set(name, current);
    return respond();
  }) as typeof globalThis.fetch;
  const target = build(fetch) as Record<string, unknown>;
  for (const name of methodNames(target)) {
    for (const args of ARGUMENTS) {
      current = name;
      try {
        const method = target[name];
        if (typeof method !== "function") continue;
        const result: unknown = method.apply(target, args);
        if (result instanceof Promise) {
          await Promise.race([
            result.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 20)),
          ]);
        }
      } catch {
        // Invalid synthetic arguments are expected; only sent headers matter.
      }
    }
  }
  return sent;
}

function outsideList(sent: Map<string, string>): string[] {
  return [...sent]
    .filter(([name]) => !allowed.has(name))
    .map(([name, method]) => `${name} (first sent by ${method})`);
}

test("the list is lower-case, unique, and names the SDK's own header constants", () => {
  for (const name of OPENGENI_BROWSER_REQUEST_HEADERS) {
    expect(name.toLowerCase() === name).toBe(true);
  }
  expect(allowed.size).toBe(OPENGENI_BROWSER_REQUEST_HEADERS.length);
  // The headers a deployment's advertised client auth mode asks browsers to send.
  type AuthHeader = Extract<ClientAuthConfig, { headerName: string }>["headerName"];
  const authHeaders: Record<AuthHeader, true> = {
    "x-opengeni-access-key": true,
    authorization: true,
  };
  for (const name of [
    OPENGENI_API_CONTRACT_HEADER,
    OPENGENI_CORRELATION_HEADER,
    OPENGENI_SDK_VERSION_HEADER,
    SESSION_SCOPE_HEADER,
    ...Object.keys(authHeaders),
  ]) {
    expect(allowed.has(name)).toBe(true);
  }
});

test("OpenGeniClient sends only headers in OPENGENI_BROWSER_REQUEST_HEADERS", async () => {
  const sent = await sweep(
    (fetch) =>
      new OpenGeniClient({
        baseUrl: "https://api.example.test",
        apiKey: "browser-token",
        headers: () => ({ "x-opengeni-access-key": "deployment-key" }),
        fetch,
      }).withHeaders({ [SESSION_SCOPE_HEADER]: ID }),
    () => Response.json({}),
  );
  expect(outsideList(sent)).toEqual([]);
  // The sweep reaches the always-sent and the option-gated headers.
  for (const name of [
    "authorization",
    "range",
    OPENGENI_SDK_VERSION_HEADER,
    OPENGENI_API_CONTRACT_HEADER,
    OPENGENI_CORRELATION_HEADER,
    SESSION_SCOPE_HEADER,
  ]) {
    expect(sent.has(name)).toBe(true);
  }
});

test("BrowserAccountsClient sends only headers in OPENGENI_BROWSER_REQUEST_HEADERS", async () => {
  const projection = {
    mode: "dual",
    generation: "1",
    actorEpoch: "1",
    csrfToken: "c".repeat(43),
    selectedSlotId: null,
    state: "ready",
    slots: [],
  };
  const sent = await sweep(
    (fetch) => new BrowserAccountsClient({ baseUrl: "https://api.example.test", fetch }),
    () => Response.json(projection),
  );
  expect(outsideList(sent)).toEqual([]);
  expect(sent.has("x-opengeni-session-csrf")).toBe(true);
  expect(sent.has("x-opengeni-actor-epoch")).toBe(true);
});
