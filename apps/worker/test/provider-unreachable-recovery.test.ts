import { expect, test } from "bun:test";
import { ToolCallError } from "@openai/agents";
import { APIConnectionError } from "openai";
import {
  MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  PROVIDER_UNREACHABLE_RECOVERY_CODE,
  agentRunFailurePayload,
  modelSocketFallbackRecoveryLimit,
  providerRecoveryCode,
  providerRecoveryLimit,
  providerRecoveryResult,
} from "../src/activities/agent-turn/errors";
import {
  PROVIDER_UNREACHABLE_BACKOFF_MS,
  PROVIDER_UNREACHABLE_RECOVERY_WINDOW_MS,
} from "../src/activities/agent-turn/provider-recovery-policy";
import { providerRecoveryCause } from "../src/activities/agent-turn/provider-recovery-metrics";

function coded(message: string, code: string, name = "Error"): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, { code });
}

function recoveryCodeFor(error: unknown): string | undefined {
  return providerRecoveryCode(error, agentRunFailurePayload(error));
}

test("a provider that cannot be reached at all waits for the connection to return", () => {
  const offline = [
    // A name lookup with no working resolver behind it.
    coded("getaddrinfo EAI_AGAIN api.example.test", "EAI_AGAIN"),
    // The runtime's fetch with no route or nothing listening.
    coded(
      "ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
      "ECONNREFUSED",
      "TypeError",
    ),
    coded("Unable to connect. Is the computer able to access the url?", "ConnectionRefused"),
    coded("connect ENETUNREACH 192.0.2.1:443", "ENETUNREACH"),
    coded("connect EHOSTUNREACH 192.0.2.1:443", "EHOSTUNREACH"),
    coded("connect ENETDOWN 192.0.2.1:443", "ENETDOWN"),
    // The OpenAI SDK's wrapper around the same transport failures.
    new APIConnectionError({
      cause: coded("getaddrinfo EAI_AGAIN api.example.test", "EAI_AGAIN"),
    }),
    new APIConnectionError({
      cause: coded(
        "ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
        "ECONNREFUSED",
        "TypeError",
      ),
    }),
    // The SDK sometimes keeps no transport cause at all.
    new APIConnectionError({}),
  ];
  for (const error of offline) {
    const failure = agentRunFailurePayload(error);
    expect(failure.retryable).toBe(true);
    expect(["provider_unavailable", "upstream_connectivity_unavailable"]).toContain(failure.code);
    expect(providerRecoveryCode(error, failure)).toBe(PROVIDER_UNREACHABLE_RECOVERY_CODE);
  }
});

test("provider faults and slow or dropped connections keep the short budget", () => {
  const notOffline = [
    Object.assign(new Error("Service Unavailable"), { status: 503 }),
    Object.assign(new Error("Bad Gateway"), {
      status: 502,
      cause: coded("connect ECONNREFUSED 192.0.2.1:443", "ECONNREFUSED"),
    }),
    coded("read ECONNRESET", "ECONNRESET"),
    coded("connect ETIMEDOUT 192.0.2.1:443", "ETIMEDOUT"),
    new APIConnectionError({ cause: coded("read ECONNRESET", "ECONNRESET") }),
    new APIConnectionError({ cause: coded("getaddrinfo ENOTFOUND api.example.test", "ENOTFOUND") }),
    new APIConnectionError({
      cause: coded("unable to verify the first certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
    }),
    // A dropped open connection is not an offline machine.
    new Error(
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    ),
  ];
  for (const error of notOffline) {
    expect(recoveryCodeFor(error)).not.toBe(PROVIDER_UNREACHABLE_RECOVERY_CODE);
  }
  // A request that timed out says nothing about reachability.
  expect(
    providerRecoveryCode(new APIConnectionError({}), {
      code: "provider_unavailable",
      retryable: true,
      timeoutClass: "transport",
    }),
  ).toBe("provider_unavailable");
  // A tool's own unreachable upstream is the tool's failure, not the model's.
  const toolFailure = new ToolCallError(
    "Failed to run function tools",
    coded("getaddrinfo EAI_AGAIN tool.example.test", "EAI_AGAIN"),
  );
  expect(
    providerRecoveryCode(toolFailure, { code: "provider_unavailable", retryable: true }),
  ).not.toBe(PROVIDER_UNREACHABLE_RECOVERY_CODE);
  // Non-retryable failures are never reinterpreted.
  expect(
    providerRecoveryCode(new APIConnectionError({}), {
      code: "provider_unavailable",
      retryable: false,
    }),
  ).toBe("provider_unavailable");
});

test("an offline wait retries at a calm pace for about six hours", () => {
  const startedAt = 1_000_000;
  let now = startedAt;
  const delays: number[] = [];
  let exhaustedReason: string | undefined;
  for (let attemptNumber = 1; attemptNumber <= 200; attemptNumber += 1) {
    const result = providerRecoveryResult({
      failureCode: PROVIDER_UNREACHABLE_RECOVERY_CODE,
      attemptNumber,
      recoveryStartedAt: attemptNumber === 1 ? undefined : startedAt,
      now,
    });
    if (result.status === "exhausted") {
      exhaustedReason = result.providerRecoveryExhaustedReason;
      break;
    }
    delays.push(result.continueDelayMs);
    now += result.continueDelayMs;
  }
  expect(delays.slice(0, PROVIDER_UNREACHABLE_BACKOFF_MS.length)).toEqual([
    ...PROVIDER_UNREACHABLE_BACKOFF_MS,
  ]);
  expect(Math.max(...delays)).toBe(300_000);
  expect(exhaustedReason).toBe("deadline");
  expect(now - startedAt).toBeLessThan(PROVIDER_UNREACHABLE_RECOVERY_WINDOW_MS);
  expect(now - startedAt).toBeGreaterThanOrEqual(PROVIDER_UNREACHABLE_RECOVERY_WINDOW_MS - 300_000);
  expect(delays.length).toBeLessThanOrEqual(
    providerRecoveryLimit(PROVIDER_UNREACHABLE_RECOVERY_CODE)!,
  );
  expect(providerRecoveryLimit(PROVIDER_UNREACHABLE_RECOVERY_CODE)).toBeGreaterThan(
    MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  );
});

test("an offline wait that started as an ordinary failure keeps its first clock", () => {
  // The first failure was an ordinary dropped connection; the clock started then.
  const startedAt = 1_000_000;
  const result = providerRecoveryResult({
    failureCode: PROVIDER_UNREACHABLE_RECOVERY_CODE,
    attemptNumber: 4,
    recoveryStartedAt: startedAt,
    now: startedAt + PROVIDER_UNREACHABLE_RECOVERY_WINDOW_MS - 1_000,
  });
  expect(result).toMatchObject({
    status: "exhausted",
    providerRecoveryExhaustedReason: "deadline",
  });
});

test("a failing model socket still switches to HTTP at the usual recovery", () => {
  expect(modelSocketFallbackRecoveryLimit(PROVIDER_UNREACHABLE_RECOVERY_CODE)).toBe(
    MAX_AUTOMATIC_PROVIDER_RECOVERIES,
  );
  expect(modelSocketFallbackRecoveryLimit("provider_unavailable")).toBe(
    providerRecoveryLimit("provider_unavailable"),
  );
});

test("offline waits are reported as connectivity recoveries", () => {
  expect(providerRecoveryCause(PROVIDER_UNREACHABLE_RECOVERY_CODE)).toBe("connectivity");
});
