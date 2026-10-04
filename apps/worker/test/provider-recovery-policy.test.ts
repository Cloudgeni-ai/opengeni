import { expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { buildOpenAIClientFromSettings, ResponsesStreamingTerminalError } from "@opengeni/runtime";
import {
  agentRunFailurePayload,
  providerRecoveryResult,
  providerRecoveryJitterMs,
} from "../src/activities/agent-turn/errors";
import {
  providerRecoveryCause,
  readProviderRecoveryObservation,
  recordProviderRecoveryOutcome,
} from "../src/activities/agent-turn/provider-recovery-metrics";

test("spread only adds to the existing provider delay and never changes the retry budget", () => {
  for (const failureCode of [
    "provider_rate_limited",
    "provider_unavailable",
    "upstream_connectivity_unavailable",
  ]) {
    for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber += 1) {
      const base = providerRecoveryResult({ failureCode, attemptNumber, retryAfterMs: 80_000 });
      if (base.status !== "recovering") throw new Error("Expected recovery");
      for (const jitterSample of [0, 0.2, 0.9, 1, -1, NaN, Infinity]) {
        const spread = providerRecoveryResult({
          failureCode,
          attemptNumber,
          retryAfterMs: 80_000,
          jitterSample,
        });
        if (spread.status !== "recovering") throw new Error("Expected recovery");
        expect(spread.continueDelayMs).toBeGreaterThanOrEqual(base.continueDelayMs);
        expect(spread.continueDelayMs).toBeLessThanOrEqual(base.continueDelayMs + 5_000);
      }
    }
    expect(providerRecoveryResult({ failureCode, attemptNumber: 6, jitterSample: 1 }).status).toBe(
      "exhausted",
    );
  }
  expect(providerRecoveryJitterMs(2_000, 1)).toBe(400);
  expect(
    new Set(Array.from({ length: 100 }, (_, i) => providerRecoveryJitterMs(60_000, i / 100))).size,
  ).toBe(100);
  expect(
    providerRecoveryResult({
      failureCode: "mcp_transport_timeout",
      attemptNumber: 1,
      jitterSample: 1,
    }),
  ).toEqual({ status: "recovering", continueDelayMs: 2_000 });
});

test("an SDK wrapper cannot turn a definitive HTTP refusal into an automatic retry", () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const cause = Object.assign(new Error("rate limit / overloaded / connection error"), {
      status,
    });
    const wrapped = new Error("rate limit / overloaded / connection error", { cause });
    expect(agentRunFailurePayload(wrapped).retryable).not.toBe(true);
  }
  for (const [status, code] of [
    [429, "provider_rate_limited"],
    [503, "provider_unavailable"],
  ] as const) {
    expect(
      agentRunFailurePayload(
        new Error("SDK wrapper", {
          cause: Object.assign(new Error("Provider refused"), { status }),
        }),
      ),
    ).toMatchObject({ code, retryable: true });
  }
  expect(
    agentRunFailurePayload(
      Object.assign(new Error("overloaded"), {
        status: 403,
        cause: Object.assign(new Error("inner"), { status: 503 }),
      }),
    ).retryable,
  ).not.toBe(true);
});

test("worker retry settings issue one physical Azure request per failed attempt", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      return Response.json(
        { error: { code: "rate_limit_exceeded", message: "Busy" } },
        {
          status: 429,
          headers: { "retry-after-ms": "1" },
        },
      );
    },
  });
  try {
    const client = buildOpenAIClientFromSettings(
      testSettings({
        openaiProvider: "azure",
        azureOpenaiBaseUrl: `${server.url}openai/v1`,
        azureOpenaiApiKey: "fixture",
        openaiMaxRetries: 0,
      }),
    );
    let failure: unknown;
    try {
      await client.responses.create({ model: "fixture", input: "Hello" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 429 });
    expect(requests).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("stream failures and successful recovery emit structural model metrics", async () => {
  const observation = readProviderRecoveryObservation({
    providerRecoveryReason: "provider_rate_limited",
    providerRecoveryStartedAt: "2026-01-01T00:00:00Z",
  });
  expect(observation).toEqual({
    cause: "rate_limited",
    startedAt: Date.parse("2026-01-01T00:00:00Z"),
  });
  expect(
    readProviderRecoveryObservation({ providerRecoveryReason: "mcp_transport_timeout" }),
  ).toBeUndefined();
  const streamError = new ResponsesStreamingTerminalError("response.failed", {
    code: "rate_limit_exceeded",
    message: "synthetic provider diagnostic",
  });
  const cause = providerRecoveryCause(agentRunFailurePayload(streamError).code);
  expect(cause).toBe("rate_limited");
  const observability = createObservability(testSettings(), { component: "worker-turn" });
  const route = { provider: "fixture", model: "fixture/model" };
  recordProviderRecoveryOutcome(observability, {
    route,
    cause: cause!,
    outcome: "scheduled",
    delayMs: 62_000,
  });
  recordProviderRecoveryOutcome(observability, {
    route,
    cause: cause!,
    outcome: "recovered",
    elapsedMs: 68_000,
  });
  const metrics = await observability.prometheusMetrics();
  expect(metrics).toMatch(/opengeni_model_recovery_total\{[^}]*outcome="scheduled"[^}]*\} 1/);
  expect(metrics).toMatch(/opengeni_model_recovery_total\{[^}]*outcome="recovered"[^}]*\} 1/);
  expect(metrics).toMatch(/opengeni_model_recovery_delay_seconds_sum\{[^}]*\} 62/);
  expect(metrics).toMatch(/opengeni_model_recovery_duration_seconds_sum\{[^}]*\} 68/);
  expect(metrics).not.toMatch(/synthetic provider diagnostic|session_id|workspace_id|request_id/);
});
