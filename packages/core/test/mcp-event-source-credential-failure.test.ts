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
  test("a refresh the sign-in service did not answer is an outage, not a reconnect", () => {
    const failure = connectionCredentialFailure(refreshFailed, reconnect, true);
    expect(failure).not.toBeInstanceOf(McpEventSourceUnavailableError);
  });

  test("a rejected or impossible refresh asks the person to reconnect", () => {
    const failure = connectionCredentialFailure(refreshFailed, reconnect, false);
    expect(failure).toBeInstanceOf(McpEventSourceUnavailableError);
    expect((failure as McpEventSourceUnavailableError).reason.code).toBe("reconnect");
  });

  test("a missing or expired connection asks to reconnect", () => {
    for (const reason of ["missing_connection", "expired"] as const) {
      const failure = connectionCredentialFailure({ ...refreshFailed, reason }, reconnect, true);
      expect(failure).toBeInstanceOf(McpEventSourceUnavailableError);
    }
  });
});
