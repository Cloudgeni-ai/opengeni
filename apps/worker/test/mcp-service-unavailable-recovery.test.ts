import { expect, test } from "bun:test";
import { mcpTransportErrorWithRetryMetadata } from "@opengeni/runtime";
import {
  MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE,
  providerRecoveryCode,
  providerRecoveryLimit,
  providerRecoveryResult,
} from "../src/activities/agent-turn/errors";
import { MCP_SERVICE_UNAVAILABLE_RECOVERY_WINDOW_MS } from "../src/activities/agent-turn/provider-recovery-policy";

class HttpStatusError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

const unavailable = { code: "mcp_transport_unavailable", retryable: true };

test("an MCP server answering 503 is waited out, other unreachable servers keep the short budget", () => {
  const maintenance = mcpTransportErrorWithRetryMetadata(
    new HttpStatusError(503, 'Error POSTing to endpoint (HTTP 503): {"error":"maintenance"}'),
  );
  expect(providerRecoveryCode(maintenance, unavailable)).toBe(
    MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE,
  );
  const badGateway = mcpTransportErrorWithRetryMetadata(
    new HttpStatusError(502, "Error POSTing to endpoint (HTTP 502)"),
  );
  expect(providerRecoveryCode(badGateway, unavailable)).toBe("mcp_transport_unavailable");
  // A 503 that was not classified as an MCP connectivity failure is not ours to reinterpret.
  expect(
    providerRecoveryCode(new HttpStatusError(503, "provider said no"), {
      code: "provider_unavailable",
      retryable: true,
    }),
  ).toBe("provider_unavailable");
  expect(providerRecoveryLimit(MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE)).toBeGreaterThan(
    MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  );
});

test("a 503'ing MCP server is retried at a steady pace until ten minutes have passed", () => {
  const startedAt = 1_000_000;
  let now = startedAt;
  const delays: number[] = [];
  for (let attemptNumber = 1; attemptNumber <= 60; attemptNumber += 1) {
    const result = providerRecoveryResult({
      failureCode: MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE,
      attemptNumber,
      recoveryStartedAt: startedAt,
      now,
    });
    if (result.status === "exhausted") {
      expect(result.providerRecoveryExhaustedReason).toBe("deadline");
      break;
    }
    delays.push(result.continueDelayMs);
    now += result.continueDelayMs;
  }
  expect(delays.slice(0, 5)).toEqual([5_000, 10_000, 15_000, 30_000, 30_000]);
  expect(now - startedAt).toBeLessThan(MCP_SERVICE_UNAVAILABLE_RECOVERY_WINDOW_MS);
  expect(now - startedAt).toBeGreaterThanOrEqual(
    MCP_SERVICE_UNAVAILABLE_RECOVERY_WINDOW_MS - 30_000,
  );
  expect(delays.length).toBeGreaterThan(MAX_AUTOMATIC_PROVIDER_RECOVERIES);
});

test("Retry-After from a 503'ing MCP server is never shortened", () => {
  const result = providerRecoveryResult({
    failureCode: MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE,
    attemptNumber: 1,
    retryAfterMs: 45_000,
    recoveryStartedAt: 0,
    now: 0,
  });
  expect(result).toMatchObject({ status: "recovering", continueDelayMs: 45_000 });
});
