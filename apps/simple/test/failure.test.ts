import { expect, test } from "bun:test";
import { failureView } from "../src/lib/failure";

test("a used-up ChatGPT limit says when it resets and offers no retry", () => {
  const view = failureView({
    code: "codex_usage_limit_reached",
    retryable: false,
    error:
      "Your ChatGPT/Codex subscription usage limit has been reached. Access resets in about 2h 5m. Opengeni will try again then.",
  });
  expect(view).toEqual({
    kind: "limit",
    message: "ChatGPT's usage limit is reached. It resets in about 2h 5m.",
    retry: false,
  });
});

test("a limit without a reset time still says what happened", () => {
  expect(failureView({ code: "subscription_failover_exhausted" }).message).toBe(
    "ChatGPT's usage limit is reached. Try again later.",
  );
});

test("lost credentials ask to reconnect instead of retrying", () => {
  const view = failureView({ code: "codex_credential_lease_lost", retryable: true });
  expect(view.retry).toBe(false);
  expect(view.reconnect).toBe(true);
});

test("refusals, plans and long chats never offer a retry", () => {
  for (const code of [
    "provider_safety_refusal",
    "codex_plan_entitlement",
    "context_length_exceeded",
    "context_compaction_failed",
  ]) {
    expect(failureView({ code }).retry).toBe(false);
  }
});

test("temporary trouble can be retried", () => {
  expect(failureView({ code: "codex_response_timeout" })).toMatchObject({
    kind: "temporary",
    retry: true,
  });
});

test("an unknown failure offers no retry button", () => {
  expect(failureView({ code: "something_new" }).retry).toBe(false);
  expect(failureView(null).message).toBe("Something went wrong. Send a message to carry on.");
});

test("a plan rejection, a used-up allowance or a quota scope never offer a retry", () => {
  expect(failureView({ code: "codex_request_rejected" }).kind).toBe("plan");
  expect(failureView({ code: "insufficient_credits" }).kind).toBe("budget");
  expect(failureView({ code: "provider_error", quotaScope: "daily" }).kind).toBe("limit");
});

test("another service's 401 or a disk quota is not a ChatGPT problem", () => {
  expect(failureView({ error: "GitHub MCP returned 401 Unauthorized" }).reconnect).toBeUndefined();
  expect(failureView({ error: "disk quota exceeded" }).kind).toBe("unknown");
});

test("a fractional reset time is kept whole", () => {
  expect(
    failureView({
      code: "codex_usage_limit_reached",
      error: "Codex usage limit reached. It resets in 2.5 hours.",
    }).message,
  ).toBe("ChatGPT's usage limit is reached. It resets in 2.5 hours.");
});

test("no internal detail reaches the message", () => {
  const view = failureView({
    code: "pre_claim_failure",
    error: "duplicate key value violates unique constraint session_turns_pkey",
  });
  expect(view.message).not.toContain("constraint");
});

test("a short rate limit is temporary even when it says rate-limited", () => {
  expect(
    failureView({ code: "provider_rate_limited", error: "You are being rate-limited" }).retry,
  ).toBe(true);
});
