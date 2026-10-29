import { expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

import { isPaymentRequiredError, paymentRefusalCode } from "./model-access";

function refusal(details: Record<string, unknown> | undefined, status = 402) {
  return new OpenGeniApiError(
    status,
    JSON.stringify({
      error: {
        status,
        code: "payment_required",
        message: "Add credits to use your own key.",
        retryable: false,
        ...(details ? { details } : {}),
      },
    }),
  );
}

test("a payment refusal names the credit it needs only when the server says so", () => {
  const ownKey = refusal({ code: "byok_paid_credit_required", action: { type: "add_credits" } });
  expect(isPaymentRequiredError(ownKey)).toBe(true);
  expect(paymentRefusalCode(ownKey)).toBe("byok_paid_credit_required");
  expect(paymentRefusalCode(refusal({ code: "api_credits_required" }))).toBe(
    "api_credits_required",
  );
  expect(paymentRefusalCode(refusal({ code: "insufficient_credits" }))).toBeNull();
  expect(paymentRefusalCode(refusal(undefined))).toBeNull();
  expect(paymentRefusalCode(refusal({ code: "byok_paid_credit_required" }, 403))).toBeNull();
  expect(paymentRefusalCode(new Error("Add credits to use your own key."))).toBeNull();
});
