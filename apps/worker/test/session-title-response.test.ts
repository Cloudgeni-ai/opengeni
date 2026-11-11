import { expect, test } from "bun:test";
import { SessionTitleResponse } from "../src/activities/session-title-route";

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
  expect(() =>
    SessionTitleResponse.parse({ ...value, usage: { usage: { inputTokens: Infinity } } }),
  ).toThrow();
});
