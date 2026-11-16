import { describe, expect, test } from "bun:test";
import { isMcpRequestNotSentError, isMcpServerUnreachableError } from "../src/index";
import { guardedMcpFetch, mcpFetchFailedBeforeSending } from "../src/mcp-network";

// "Nothing was sent" is decided only at the MCP transport's physical request:
// a POST whose fetch rejected while connecting. The same code from anywhere
// else never makes a call safe to run again.
const settings = { environment: "test", integrationsAllowPrivateNetworkTargets: true };
const local = { dnsLookup: async () => [{ address: "127.0.0.1", family: 4 as const }] };
const failure = (fields: Record<string, unknown>) =>
  Object.assign(new TypeError("fetch failed"), fields);
const wrapped = (cause: unknown) => Object.assign(new Error("MCP tool call failed"), { cause });

/** The error a guarded MCP request rejects with when its fetch fails this way. */
async function rejected(method: "POST" | "GET", fetchError: unknown): Promise<unknown> {
  const guarded = guardedMcpFetch(
    settings,
    async () => {
      throw fetchError;
    },
    { ...local, pinResolvedDestination: false },
  );
  return await guarded("http://127.0.0.1:9/mcp", {
    method,
    ...(method === "POST"
      ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) }
      : {}),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("an MCP request that was never sent", () => {
  test("a refused POST from the real transport is not-sent, also when wrapped", async () => {
    const guarded = guardedMcpFetch(settings, fetch, { ...local, pinResolvedDestination: false });
    const refused = await guarded("http://127.0.0.1:9/mcp", { method: "POST", body: "{}" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeDefined();
    expect(isMcpRequestNotSentError(refused)).toBe(true);
    expect(isMcpRequestNotSentError(wrapped(refused))).toBe(true);
    expect(isMcpServerUnreachableError(refused)).toBe(true);
  });

  test("connect-time codes at the transport are not-sent; a GET never is", async () => {
    for (const fetchError of [
      failure({ code: "ECONNREFUSED" }),
      failure({ cause: { code: "ECONNREFUSED", syscall: "connect" } }),
      failure({ code: "ENOTFOUND", syscall: "getaddrinfo" }),
      failure({ cause: { code: "EHOSTUNREACH", syscall: "connect" } }),
    ]) {
      expect(isMcpRequestNotSentError(await rejected("POST", fetchError))).toBe(true);
    }
    expect(isMcpRequestNotSentError(await rejected("GET", failure({ code: "ECONNREFUSED" })))).toBe(
      false,
    );
  });

  test("a read EHOSTUNREACH on an open socket may have been sent", async () => {
    const read = failure({ cause: { code: "EHOSTUNREACH", syscall: "read" } });
    expect(mcpFetchFailedBeforeSending(read)).toBe(false);
    expect(isMcpRequestNotSentError(await rejected("POST", read))).toBe(false);
    // Without a syscall it can't be told apart either.
    expect(mcpFetchFailedBeforeSending(failure({ code: "ENETUNREACH" }))).toBe(false);
    // A reset after connecting is never not-sent.
    expect(isMcpRequestNotSentError(await rejected("POST", failure({ code: "ECONNRESET" })))).toBe(
      false,
    );
  });

  test("the same code from anywhere but the transport is not proof", () => {
    // A database refusing a connection inside a call, as postgres.js reports it.
    const database = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "127.0.0.1",
      port: 5432,
    });
    expect(isMcpRequestNotSentError(database)).toBe(false);
    expect(isMcpRequestNotSentError(wrapped(database))).toBe(false);
    expect(isMcpRequestNotSentError(new Error("connect ECONNREFUSED 127.0.0.1:9"))).toBe(false);
    expect(isMcpRequestNotSentError(null)).toBe(false);
  });

  test("a destination refused at DNS is not-sent; other policy refusals are not proof", async () => {
    const dns = Object.assign(new Error("no address"), {
      name: "DestinationPolicyError",
      reason: "dns_failed",
    });
    expect(isMcpRequestNotSentError(await rejected("POST", dns))).toBe(true);
    expect(
      isMcpRequestNotSentError(
        await rejected("POST", Object.assign(new Error("x"), { ...dns, reason: "private" })),
      ),
    ).toBe(false);
  });

  test("a timeout is unreachable but may have been sent", () => {
    const timeout = Object.assign(new Error("Request timed out"), { code: -32_001 });
    expect(isMcpServerUnreachableError(timeout)).toBe(true);
    expect(isMcpRequestNotSentError(timeout)).toBe(false);
  });
});
