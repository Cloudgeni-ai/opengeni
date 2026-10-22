import { expect, test } from "bun:test";
import { PrefixedMcpServer, mcpTransportErrorWithRetryMetadata } from "@opengeni/runtime";
import {
  MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE,
  agentRunFailurePayload,
  postClaimDatabaseRecoveryFailure,
  providerRecoveryCode,
  providerRecoveryLimit,
  providerRecoveryResult,
} from "../src/activities/agent-turn/errors";
import {
  FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
  MCP_SERVICE_UNAVAILABLE_RECOVERY_WINDOW_MS,
} from "../src/activities/agent-turn/provider-recovery-policy";

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

test("required internal MCP setup waits through an outage then reconnects without a tool replay", async () => {
  let available = false;
  let calls = 0;
  let connects = 0;
  const source = Object.assign(new Error("connect ECONNREFUSED 10.0.189.129:8000"), {
    code: "ECONNREFUSED",
  });
  const server = new PrefixedMcpServer(
    {
      name: "internal-api",
      cacheToolsList: false,
      async connect() {
        connects++;
        if (!available) throw source;
      },
      async close() {},
      async listTools() {
        return [];
      },
      async callTool() {
        calls++;
        return [];
      },
    },
    "opengeni",
    undefined,
    false,
    undefined,
    "opengeni",
    true,
  );
  const publicError = await server.connect().catch((error) => error);
  const exact = server.unwrapLifecycleError(publicError, "connect");
  expect(exact).toBe(source);
  const failure = agentRunFailurePayload(exact);
  const code = providerRecoveryCode(exact, failure);
  expect(code).toBe(FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE);
  expect(providerRecoveryLimit(code)).toBeUndefined();
  // A restart preserves the durable count; neither the old five-retry ceiling
  // nor the external server's ten-minute window may terminalize internal setup.
  for (const attemptNumber of [1, 6, 31, 121, 2881]) {
    expect(
      providerRecoveryResult({
        failureCode: code,
        attemptNumber,
        recoveryStartedAt: 0,
        now: 86_400_000,
      }),
    ).toEqual({ status: "recovering", continueDelayMs: 30_000 });
  }
  available = true;
  await server.connect();
  expect(await server.listTools()).toEqual([]);
  expect(connects).toBe(2);
  expect(calls).toBe(0);
});

test("external/tool-call failures and forged markers cannot acquire the internal setup wait", () => {
  for (const raw of [
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
      recoverySafeSetup: true,
      firstPartyMcpSetupUnavailable: true,
    }),
  ]) {
    const error = mcpTransportErrorWithRetryMetadata(raw);
    expect(providerRecoveryCode(error, agentRunFailurePayload(error))).toBe(
      "mcp_transport_unavailable",
    );
  }
  for (const raw of [
    Object.assign(new Error("denied"), { status: 401 }),
    Object.assign(new Error("denied"), {
      status: 403,
      cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    }),
    new TypeError("invalid protocol"),
    new Error("invalid tool schema"),
    Object.assign(new Error("denied marker"), {
      mcpTransportFailureKind: "connectivity_unavailable",
      status: 403,
      cause: { code: "ECONNREFUSED" },
    }),
    Object.assign(new Error("route missing"), { status: 404 }),
  ]) {
    const error = mcpTransportErrorWithRetryMetadata(raw, { recoverySafeSetup: true });
    expect(providerRecoveryCode(error, agentRunFailurePayload(error))).not.toBe(
      FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
    );
  }
});

test("internal setup wait preserves its count and pacing through a checkpoint database outage", () => {
  const input = {
    error: Object.assign(new Error("database reset"), { code: "ECONNRESET" }),
    turnId: "turn",
    triggerEventId: "trigger",
    executionGeneration: 3,
    providerRecovery: {
      failureCode: FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
      providerRecoveryCount: 121,
      continueDelayMs: 30_000,
    },
  };
  expect(postClaimDatabaseRecoveryFailure(input)).toMatchObject({
    details: [
      {
        providerFailureCode: FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
        providerRecoveryCount: 121,
        providerRecoveryContinueDelayMs: 30_000,
      },
    ],
  });
  for (const continueDelayMs of [undefined, 0, 1, 29_999, Infinity]) {
    expect(
      postClaimDatabaseRecoveryFailure({
        ...input,
        providerRecovery: { ...input.providerRecovery, continueDelayMs },
      }),
    ).toBeNull();
  }
});
