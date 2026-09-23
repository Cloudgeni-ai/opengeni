import { describe, expect, test } from "bun:test";
import { assertNativeMcpConnectionRef } from "../src";

describe("native MCP connection admission", () => {
  const hostRef = {
    authoritySource: "host" as const,
    connectionId: "opaque-host-binding",
    providerDomain: "host.example.test",
  };

  test("rejects retired explicit host authority", () => {
    expect(() => assertNativeMcpConnectionRef(hostRef)).toThrow(
      /host-owned MCP connection refs are no longer supported/,
    );
  });

  test("does not interfere with ordinary native connection selection", () => {
    expect(() =>
      assertNativeMcpConnectionRef({
        connectionId: crypto.randomUUID(),
        providerDomain: "tools.example.test",
      }),
    ).not.toThrow();
    expect(() => assertNativeMcpConnectionRef(undefined)).not.toThrow();
  });
});
