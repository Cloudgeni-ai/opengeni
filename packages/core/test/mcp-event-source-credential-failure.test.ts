import { describe, expect, test } from "bun:test";
import {
  connectionCredentialFailure,
  McpEventSourceUnavailableError,
} from "../src/domain/event-triggers/mcp-event-source-client";

const reconnect = "Reconnect Orders MCP to keep its events coming";
const refreshFailed = {
  status: "auth_needed" as const,
  reason: "refresh_failed" as const,
  providerDomain: "orders.example",
  connectionId: "00000000-0000-4000-8000-000000000001",
};

describe("event source sign-in failures", () => {
  test("a refresh that failed while the connection stays active is an outage, not a reconnect", async () => {
    const failure = await connectionCredentialFailure(refreshFailed, reconnect, async () => true);
    expect(failure).not.toBeInstanceOf(McpEventSourceUnavailableError);
  });

  test("a refresh the provider rejected asks the person to reconnect", async () => {
    const failure = await connectionCredentialFailure(refreshFailed, reconnect, async () => false);
    expect(failure).toBeInstanceOf(McpEventSourceUnavailableError);
    expect((failure as McpEventSourceUnavailableError).reason.code).toBe("reconnect");
  });

  test("a missing or revoked connection, or an unreadable status, asks to reconnect", async () => {
    for (const [result, active] of [
      [{ ...refreshFailed, reason: "missing_connection" as const }, async () => true],
      [{ ...refreshFailed, reason: "expired" as const }, async () => true],
      [refreshFailed, async () => Promise.reject(new Error("db down"))],
    ] as const) {
      const failure = await connectionCredentialFailure(result, reconnect, active);
      expect(failure).toBeInstanceOf(McpEventSourceUnavailableError);
    }
  });
});
