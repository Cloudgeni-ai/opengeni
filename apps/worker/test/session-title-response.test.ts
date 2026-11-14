import { expect, test } from "bun:test";
import { modelResponseUsageFromResponse, normalizeModelCallUsage } from "@opengeni/runtime";
import {
  SessionTitleResponse,
  sessionTitleFailureDiagnostic,
} from "../src/activities/session-title-route";

test("retained title usage preserves every billing field", () => {
  const value = {
    title: "Harbor lighting history",
    usage: {
      responseId: "response-fixture",
      serviceTier: "priority",
      webSearchRequests: 2,
      gatewayBilling: { finalProvider: "fixture", inferenceCostUsd: "0.00032" },
      usage: {
        inputTokens: 50,
        outputTokens: 12,
        totalTokens: 62,
        inputTokensDetails: [{ cached_tokens: 23 }],
        outputTokensDetails: { reasoning_tokens: 2 },
        requestUsageEntries: [
          {
            input_tokens: 50,
            output_tokens: 12,
            total_tokens: 62,
            input_tokens_details: { cached_tokens: 23 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        ],
      },
    },
  };
  expect(SessionTitleResponse.parse(value)).toEqual(value);
  expect(SessionTitleResponse.parse({ title: null, usage: null })).toEqual({
    title: null,
    usage: null,
  });
  // A non-finite count is never retained; it is dropped rather than failing the title.
  expect(
    SessionTitleResponse.parse({ ...value, usage: { usage: { inputTokens: Infinity } } }).usage
      ?.usage.inputTokens,
  ).toBeUndefined();
});

test("retains a chat completion whose usage details carry null entries", () => {
  // Chat-compatible routes report unset detail counters as null.
  const usage = modelResponseUsageFromResponse({
    id: "chatcmpl-fixture",
    usage: {
      prompt_tokens: 40,
      completion_tokens: 9,
      total_tokens: 49,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: null },
      completion_tokens_details: {
        reasoning_tokens: 5,
        audio_tokens: null,
        accepted_prediction_tokens: null,
        rejected_prediction_tokens: null,
      },
    },
  });
  const retained = SessionTitleResponse.parse({ title: "Harbor lighting", usage });
  expect(retained.usage?.usage).toEqual({
    inputTokens: 40,
    outputTokens: 9,
    totalTokens: 49,
    inputTokensDetails: { cached_tokens: 0 },
    outputTokensDetails: { reasoning_tokens: 5 },
  });
  expect(normalizeModelCallUsage(retained.usage!.usage).telemetry).toEqual(
    normalizeModelCallUsage(usage!.usage).telemetry,
  );
  expect(
    SessionTitleResponse.parse({
      title: null,
      usage: { usage: { inputTokens: 1, inputTokensDetails: null, outputTokensDetails: "n/a" } },
    }).usage?.usage,
  ).toEqual({ inputTokens: 1 });
});

test("retained title usage drops each unusable value without failing the title", () => {
  const raw = {
    inputTokens: Number.NaN,
    outputTokens: 4,
    inputTokensDetails: [{ cached_tokens: 1 }, null],
    requestUsageEntries: [{ input_tokens: 3, output_tokens: null }, null],
  };
  const retained = SessionTitleResponse.parse({ title: "x", usage: { usage: raw } }).usage!.usage;
  expect(retained).toEqual({
    outputTokens: 4,
    inputTokensDetails: [{ cached_tokens: 1 }, {}],
    requestUsageEntries: [{ input_tokens: 3 }, {}],
  });
  expect(normalizeModelCallUsage(retained).telemetry).toEqual(
    normalizeModelCallUsage(raw as never).telemetry,
  );
});

test("a failed title reports a bounded, content-free reason", () => {
  const providerError = Object.assign(new Error("secret prompt text"), {
    name: "BadRequestError",
    status: 400,
    code: "invalid_request_error",
    type: "invalid_request_error",
  });
  expect(sessionTitleFailureDiagnostic(providerError, "provider_request")).toEqual({
    errorClass: "IndependentSessionTitleError",
    errorCode: "independent_session_title_provider_request_failed",
    origin: "worker",
    sessionTitleErrorName: "BadRequestError",
    status: 400,
    providerErrorCode: "invalid_request_error",
    providerErrorType: "invalid_request_error",
  });
  const unsafe = Object.assign(new Error("x"), { name: "has spaces\n", code: "a\nb", status: 9 });
  expect(sessionTitleFailureDiagnostic(unsafe, "response")).toEqual({
    errorClass: "IndependentSessionTitleError",
    errorCode: "independent_session_title_response_failed",
    origin: "worker",
  });
  expect(JSON.stringify(sessionTitleFailureDiagnostic(providerError, "billing"))).not.toContain(
    "secret",
  );
});
