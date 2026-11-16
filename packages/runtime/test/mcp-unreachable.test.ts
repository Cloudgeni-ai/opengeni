import { describe, expect, test } from "bun:test";
import { isMcpRequestNotSentError, isMcpServerUnreachableError } from "../src/index";

// An unreachable tool server is a typed answer: "nothing was sent" only when a
// socket or DNS code proves it, never from free text or after a response.
const withCause = (message: string, cause: unknown) => Object.assign(new Error(message), { cause });

describe("MCP server reachability", () => {
  test("a refused connection from fetch proves nothing was sent", async () => {
    const refused = await fetch("http://127.0.0.1:9/mcp", { method: "POST", body: "{}" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeDefined();
    expect(isMcpRequestNotSentError(refused)).toBe(true);
    expect(isMcpServerUnreachableError(refused)).toBe(true);
    // Wrapped by a transport, the typed code still decides.
    expect(isMcpRequestNotSentError(withCause("fetch failed", refused))).toBe(true);
  });

  test("typed socket and DNS codes are not-sent; other codes and plain text are not", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"])
      expect(isMcpRequestNotSentError(withCause("fetch failed", { code }))).toBe(true);
    expect(isMcpRequestNotSentError(withCause("fetch failed", { code: "ECONNRESET" }))).toBe(false);
    expect(isMcpRequestNotSentError(new Error("connect ECONNREFUSED 127.0.0.1:9"))).toBe(false);
    expect(isMcpRequestNotSentError(null)).toBe(false);
  });

  test("a destination refused at DNS is not-sent", () => {
    const blocked = Object.assign(new Error("no address"), {
      name: "DestinationPolicyError",
      reason: "dns_failed",
    });
    expect(isMcpRequestNotSentError(blocked)).toBe(true);
    expect(
      isMcpRequestNotSentError(
        Object.assign(new Error("private"), { ...blocked, reason: "private" }),
      ),
    ).toBe(false);
  });

  test("a timeout is unreachable but may have been sent", () => {
    const timeout = Object.assign(new Error("Request timed out"), { code: -32_001 });
    expect(isMcpServerUnreachableError(timeout)).toBe(true);
    expect(isMcpRequestNotSentError(timeout)).toBe(false);
  });
});
