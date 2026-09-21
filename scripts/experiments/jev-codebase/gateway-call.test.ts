import { test, expect } from "bun:test";
import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";
import { meteredGatewayCall, type CallOptions } from "./gateway-call";
import { budgetState, withTransientDelegationFallback, type LedgerRow } from "./iteration-ledger";

const config = (rows: LedgerRow[]): CallOptions => ({
  model: "typesafe-ai/jev",
  stage: "test",
  runId: "offline",
  attribution: {},
  price: { input: 0.000001, output: 0, cached: 0.000001 },
  maxUsd: 10,
  maxRequests: 400,
  maxOutput: 10,
  retries: 1,
  retryDelayMs: 0,
  history: () => rows,
  append: (r) => {
    rows.push(r);
  },
});
const success = () =>
  Promise.resolve({
    usage: { inputTokens: 10, outputTokens: 1 },
    providerMetadata: { gateway: { cost: "0.00001", generationId: "gen-offline" } },
  });
test("real SDK 503s yield safely; reservations and fallback share the cumulative limit", async () => {
  const rows: LedgerRow[] = Array.from({ length: 397 }, (_, i) => [
    { id: String(i), kind: "started", reservedUsd: 0.01 },
    { id: String(i), kind: "completed", reportedUsd: 0, nominalUsd: 0 },
  ]).flat();
  let transports = 0;
  const gateway = createGateway({
    apiKey: "offline-not-a-secret",
    fetch: Object.assign(
      async () => {
        transports++;
        return new Response(
          JSON.stringify({
            error: {
              type: "service_unavailable_error",
              message: "Service temporarily unavailable.",
            },
          }),
          {
            status: 503,
            headers: { "content-type": "application/json", "x-vercel-id": "offline-correlation" },
          },
        );
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const payload = {
    state: { ok: true },
    questions: {
      result: {
        type: "choice" as const,
        instructions: "Is ok true?",
        criteria: { yes: "true", no: "false" },
      },
    },
  };
  const result = await withTransientDelegationFallback(() =>
    meteredGatewayCall(config(rows), payload, () =>
      evaluate({ model: gateway.evaluationModel("typesafe-ai/jev"), ...payload, maxRetries: 0 }),
    ),
  );
  expect(result).toMatchObject({
    answer: "indecisive",
    evidence: [],
    reasonCode: "jev_temporarily_unavailable",
  });
  expect(transports).toBe(2);
  const failures = rows.filter((r) => r.kind === "failed");
  expect(failures).toHaveLength(2);
  expect(failures[0].diagnostics.headers["x-vercel-id"]).toBe("offline-correlation");
  expect(failures[0].id).not.toBe(failures[1].id);
  expect(failures[0].payloadHash).toBe(failures[1].payloadHash);
  await meteredGatewayCall(
    { ...config(rows), model: "terra", retries: 0 },
    { fallback: true },
    success,
  );
  expect(budgetState(rows).attempts).toBe(400);
  expect(budgetState(rows).used).toBeGreaterThan(0.016);
  let invoked = false;
  await expect(
    meteredGatewayCall(config(rows), {}, async () => {
      invoked = true;
      return success();
    }),
  ).rejects.toThrow("experiment_budget_exhausted");
  expect(invoked).toBe(false);
});
test("authentication and missing cost fail closed without transient fallback", async () => {
  for (const invoke of [
    async () => {
      throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    },
    async () => ({ usage: { inputTokens: 1, outputTokens: 0 } }),
  ]) {
    const rows: LedgerRow[] = [];
    await expect(
      withTransientDelegationFallback(() => meteredGatewayCall(config(rows), {}, invoke)),
    ).rejects.toThrow("provider_or_usage_failure");
    expect(rows.filter((r) => r.kind === "started")).toHaveLength(1);
    expect(rows.some((r) => r.kind === "transient_reserved")).toBe(false);
    expect(() => budgetState(rows)).toThrow("failed_ledger_requires_authorization");
  }
});

test("incremental budget rejects excess attempts and missing baseline before transport", async () => {
  const rows: LedgerRow[] = [];
  let invoked = false;
  for (const passBudget of [
    { baselineAttempts: 0, baselineUsd: 0, maxAdditionalAttempts: 0, maxAdditionalUsd: 1 },
    { baselineAttempts: 1, baselineUsd: 0, maxAdditionalAttempts: 40, maxAdditionalUsd: 1 },
    { baselineAttempts: 0, baselineUsd: 0, maxAdditionalAttempts: 40, maxAdditionalUsd: 0 },
  ])
    await expect(
      meteredGatewayCall({ ...config(rows), passBudget }, {}, async () => {
        invoked = true;
        return success();
      }),
    ).rejects.toThrow();
  expect(invoked).toBe(false);
  expect(rows).toEqual([]);
});
