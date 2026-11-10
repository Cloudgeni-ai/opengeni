import {
  recordSettledTurnFailureOrigin,
  settledTurnFailureOrigin,
  turnFailureOriginMetricFields,
} from "../src/activities/agent-turn/failure-attribution";
import { expect, test } from "bun:test";
import { APIError } from "openai";
import { failureOrigin, createObservability, type FailureOrigin } from "@opengeni/observability";
import { CompactionProviderResponseError } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing/settings";
import {
  agentRunFailurePayload,
  compactionFailureTurnEventPayload,
} from "../src/activities/agent-turn/errors";
import {
  runtimeMetricsHooksForObservability,
  TurnLifecycleMetrics,
} from "../src/observability-metrics";

test("production quota payload excludes customer quota but keeps deployment quota and uncertain transport", () => {
  const quota = agentRunFailurePayload({
    status: 429,
    message: "Rate limit exceeded: free-models-per-day",
  });
  expect(quota.code).toBe("provider_quota_exhausted");
  expect(failureOrigin({ customerManaged: true, outcome: "failed", code: quota.code })).toBe(
    "customer_provider",
  );
  expect(failureOrigin({ customerManaged: false, outcome: "failed", code: quota.code })).toBe(
    "platform",
  );
  for (const error of [
    new Error("Connection error."),
    new Error("Request timed out."),
    { status: 400, message: "Invalid tool name" },
  ]) {
    const payload = agentRunFailurePayload(error);
    expect(failureOrigin({ customerManaged: true, outcome: "failed", code: payload.code })).toBe(
      "platform",
    );
  }
});

test("model response instrumentation separates customer HTTP quota from platform defects", async () => {
  const obs = createObservability(testSettings(), { component: "worker" });
  const hooks = runtimeMetricsHooksForObservability(obs);
  for (const [provider, httpStatus] of [
    ["organization-openrouter", 429],
    ["azure-sol", 429],
    ["organization-openrouter", 400],
  ] as const) {
    hooks.onModelCall!({ provider, outcome: "failed", httpStatus, durationSeconds: 1 });
  }
  const lines = (await obs.prometheusMetrics())
    .split("\n")
    .filter((line) => line.startsWith("opengeni_model_calls_total{"));
  expect(lines).toHaveLength(3);
  expect(lines.filter((line) => line.includes('failure_origin="customer_provider"'))).toHaveLength(
    1,
  );
  expect(lines.filter((line) => line.includes('failure_origin="platform"'))).toHaveLength(2);
});

test("settlement uses frozen payer rather than external metering and actual terminal evidence", () => {
  const events = [{ type: "turn.failed", payload: { code: "provider_quota_exhausted" } }];
  for (const metering of ["external", "opengeni_credits"] as const) {
    expect(
      settledTurnFailureOrigin({ upstreamPayer: "deployment", metering }, "failed", events),
    ).toBe("platform");
  }
  for (const upstreamPayer of ["workspace", "organization", "connected_subscription"] as const) {
    const billing = { upstreamPayer, metering: "external" as const };
    expect(settledTurnFailureOrigin(billing, "failed", events)).toBe("customer_provider");
    expect(settledTurnFailureOrigin(billing, "failed", [])).toBe("platform");
    expect(settledTurnFailureOrigin(billing, "completed", events)).toBe("none");
    expect(
      settledTurnFailureOrigin(billing, "failed", [
        { type: "turn.failed", payload: { code: "provider_unavailable" } },
      ]),
    ).toBe("platform");
  }
});

// The production OpenRouter refusal for an account restricted to its own provider keys.
const BYOK_MESSAGE =
  "No endpoints found that can be served by your own provider keys. This workspace is restricted to BYOK capacity and has no provider key eligible for this request. Add provider keys at https://openrouter.ai/workspaces/default/byok";
const openRouter404 = (message: string) =>
  APIError.generate(404, { error: { message, code: 404 } }, undefined, new Headers());
const customerBilling = { upstreamPayer: "organization", metering: "external" } as const;
const deploymentBilling = { upstreamPayer: "deployment", metering: "external" } as const;

test("an OpenRouter BYOK-only restriction is a customer-provider failure; other 404s and request faults stay platform", () => {
  const restricted = agentRunFailurePayload(openRouter404(BYOK_MESSAGE));
  // Copy, code and retry decision are unchanged; only the closed marker is added.
  expect(restricted.error).toContain("No endpoints found that can be served");
  expect(restricted.code).toBeUndefined();
  expect(restricted.retryable).not.toBe(true);
  expect(restricted.providerAccountRefusal).toBe("byok_capacity_restricted");
  const failed = (payload: unknown) => [{ type: "turn.failed", payload }];
  expect(settledTurnFailureOrigin(customerBilling, "failed", failed(restricted))).toBe(
    "customer_provider",
  );
  expect(settledTurnFailureOrigin(deploymentBilling, "failed", failed(restricted))).toBe(
    "platform",
  );
  for (const error of [
    openRouter404("No endpoints found for some/model."),
    openRouter404("No endpoints found that support tool use."),
    APIError.generate(
      400,
      { error: { message: "Invalid schema for function 'x'", code: "invalid_request_error" } },
      undefined,
      new Headers(),
    ),
    new Error("Connection error."),
  ]) {
    const payload = agentRunFailurePayload(error);
    expect(payload.providerAccountRefusal).toBeUndefined();
    expect(settledTurnFailureOrigin(customerBilling, "failed", failed(payload))).toBe("platform");
  }
  // A forged or unknown marker value is not evidence.
  expect(
    settledTurnFailureOrigin(
      customerBilling,
      "failed",
      failed({ providerAccountRefusal: "anything_else" }),
    ),
  ).toBe("platform");
});

test("the matching compaction failure is attributed the same way, and so is a compaction quota refusal", () => {
  const compaction = compactionFailureTurnEventPayload(
    new CompactionProviderResponseError({ httpStatus: 404 }, openRouter404(BYOK_MESSAGE)),
  );
  expect(compaction.code).toBe("context_compaction_failed");
  expect(compaction.providerAccountRefusal).toBe("byok_capacity_restricted");
  const failed = (payload: unknown) => [{ type: "turn.failed", payload }];
  expect(settledTurnFailureOrigin(customerBilling, "failed", failed(compaction))).toBe(
    "customer_provider",
  );
  expect(settledTurnFailureOrigin(deploymentBilling, "failed", failed(compaction))).toBe(
    "platform",
  );
  const generic = compactionFailureTurnEventPayload(
    new CompactionProviderResponseError({ httpStatus: 404 }, openRouter404("Not Found")),
  );
  expect(generic.providerAccountRefusal).toBeUndefined();
  expect(settledTurnFailureOrigin(customerBilling, "failed", failed(generic))).toBe("platform");
  const quota = compactionFailureTurnEventPayload(
    new CompactionProviderResponseError(
      { httpStatus: 402 },
      APIError.generate(
        402,
        { error: { message: "Insufficient funds.", type: "insufficient_funds" } },
        undefined,
        new Headers(),
      ),
    ),
  );
  expect(quota.quotaScope).toBe("credits");
  expect(settledTurnFailureOrigin(customerBilling, "failed", failed(quota))).toBe(
    "customer_provider",
  );
  expect(settledTurnFailureOrigin(deploymentBilling, "failed", failed(quota))).toBe("platform");
});

test("Vercel AI Gateway credit and budget refusals on a customer's gateway are customer-provider failures", () => {
  for (const type of ["insufficient_funds", "quota_for_entity_exceeded"]) {
    const payload = agentRunFailurePayload(
      APIError.generate(402, { error: { message: "Refused.", type } }, undefined, new Headers()),
    );
    expect(payload.code).toBe("provider_quota_exhausted");
    const events = [{ type: "turn.failed", payload }];
    expect(settledTurnFailureOrigin(customerBilling, "failed", events)).toBe("customer_provider");
    expect(settledTurnFailureOrigin(deploymentBilling, "failed", events)).toBe("platform");
  }
  const verification = agentRunFailurePayload(
    APIError.generate(
      403,
      { error: { message: "Add a payment method.", type: "customer_verification_required" } },
      undefined,
      new Headers(),
    ),
  );
  expect(verification.providerAccountRefusal).toBe("customer_verification_required");
  // OpenRouter refuses a customer's own key at the limit the customer set on it.
  const keyLimit = agentRunFailurePayload(
    APIError.generate(
      403,
      { error: { message: "Key limit exceeded (total limit)", code: 403 } },
      undefined,
      new Headers(),
    ),
  );
  expect(keyLimit.retryable).not.toBe(true);
  expect(keyLimit.providerAccountRefusal).toBe("key_limit_exceeded");
  const keyLimitEvents = [{ type: "turn.failed", payload: keyLimit }];
  expect(settledTurnFailureOrigin(customerBilling, "failed", keyLimitEvents)).toBe(
    "customer_provider",
  );
  expect(settledTurnFailureOrigin(deploymentBilling, "failed", keyLimitEvents)).toBe("platform");
});

test("model-call metrics exclude a customer's BYOK restriction only on customer providers", async () => {
  const obs = createObservability(testSettings(), { component: "worker" });
  const hooks = runtimeMetricsHooksForObservability(obs);
  hooks.onModelCall!({
    provider: "organization-openrouter",
    outcome: "failed",
    httpStatus: 404,
    providerAccountRefusal: "byok_capacity_restricted",
    durationSeconds: 1,
  });
  hooks.onModelCall!({
    provider: "openrouter",
    outcome: "failed",
    httpStatus: 404,
    providerAccountRefusal: "byok_capacity_restricted",
    durationSeconds: 1,
  });
  hooks.onModelCall!({
    provider: "workspace-gateway",
    outcome: "failed",
    httpStatus: 404,
    durationSeconds: 1,
  });
  const lines = (await obs.prometheusMetrics())
    .split("\n")
    .filter((line) => line.startsWith("opengeni_model_calls_total{"));
  expect(lines).toHaveLength(3);
  const origin = (provider: string) =>
    /failure_origin="([a-z_]+)"/.exec(
      lines.find((line) => line.includes(`provider="${provider}"`)) ?? "",
    )?.[1];
  expect(origin("organization-openrouter")).toBe("customer_provider");
  expect(origin("openrouter")).toBe("platform");
  expect(origin("workspace-gateway")).toBe("platform");
});

test("settlement attribution reaches the terminal turn counter through the turn control", async () => {
  const observability = createObservability(testSettings(), { component: "worker" });
  const tracker = new TurnLifecycleMetrics(observability);
  const byok = compactionFailureTurnEventPayload(
    new CompactionProviderResponseError(
      { httpStatus: 404 },
      APIError.generate(
        404,
        {
          error: {
            message:
              "No endpoints found that can be served by your own provider keys. This workspace is restricted to BYOK capacity.",
          },
        },
        undefined,
        new Headers(),
      ),
    ),
  );
  const events = [{ type: "turn.failed", payload: byok }];
  const cases = [
    { attemptId: "customer", upstreamPayer: "organization" as const },
    { attemptId: "deployment", upstreamPayer: "deployment" as const },
  ];
  for (const { attemptId, upstreamPayer } of cases) {
    const control: { turnFailureOrigin?: FailureOrigin } = {};
    tracker.start({ attemptId });
    recordSettledTurnFailureOrigin(
      control,
      { upstreamPayer, metering: "external" },
      "failed",
      events,
    );
    tracker.finish({ attemptId, outcome: "failed", ...turnFailureOriginMetricFields(control) });
  }
  const lines = (await observability.prometheusMetrics())
    .split("\n")
    .filter(
      (line) => line.startsWith("opengeni_turns_total{") && line.includes('outcome="failed"'),
    );
  expect(lines.filter((line) => line.includes('failure_origin="customer_provider"'))).toEqual([
    expect.stringMatching(/ 1$/),
  ]);
  expect(lines.filter((line) => line.includes('failure_origin="platform"'))).toEqual([
    expect.stringMatching(/ 1$/),
  ]);
});
