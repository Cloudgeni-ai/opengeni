import { expect, test } from "bun:test";
import { failedSessionCopy } from "./failed-session-copy";

const summary = { failedAt: null, consecutiveRecoveryCount: null };
test("only explicit model availability evidence suggests another model", () => {
  for (const reason of [
    "The model is not supported with this account.",
    "The model `example` is not available.",
    "The 'example' model does not exist.",
    "Fixture model unavailable before execution",
  ]) {
    expect(failedSessionCopy({ ...summary, reason }, false, false, true)).toEqual({
      reason: "This model isn’t available. Choose another below.",
      unavailableModel: true,
    });
  }
  for (const reason of [
    "The model connection is unavailable.",
    "The model service is not available.",
    "Connection failed.",
    "An unknown response was received.",
  ]) {
    expect(failedSessionCopy({ ...summary, reason })).toEqual({ reason, unavailableModel: false });
  }
});
test("unusable picker does not receive unavailable-model guidance", () => {
  expect(failedSessionCopy({ ...summary, reason: "The model is not supported." }).reason).toBe(
    "This model isn’t available.",
  );
});
test("long recorded errors are bounded without inventing a recovery diagnosis", () => {
  const result = failedSessionCopy({ ...summary, reason: "Connection interrupted. ".repeat(100) });
  expect(result.reason.length).toBeLessThanOrEqual(160);
  expect(result.reason.endsWith("…")).toBe(true);
  expect(failedSessionCopy({ ...summary, reason: null }).reason).toBe("This session failed.");
});

const openAiKey =
  "401 Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.";
const openRouterCredits =
  "402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1200. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account";
const orgVerification =
  "400 Your organization must be verified to use the model `gpt-image-1`. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.";

test("known provider failures get plain copy with the exact recorded text as detail", () => {
  const credentials = failedSessionCopy({
    ...summary,
    reason:
      "The model provider rejected this deployment's engine credentials. Sending messages won't help until the deployment's engine configuration is fixed.",
    recordedDetail: openAiKey,
  });
  expect(credentials).toEqual({
    reason: "The model provider rejected the credentials for this model.",
    unavailableModel: false,
    retryUnhelpful: true,
    detail: openAiKey,
  });
  expect(
    failedSessionCopy(
      { ...summary, reason: openAiKey, recordedDetail: openAiKey },
      false,
      false,
      true,
    ).reason,
  ).toBe("The model provider rejected the credentials for this model. Choose another model below.");
  expect(
    failedSessionCopy(
      { ...summary, reason: openAiKey, recordedDetail: openAiKey },
      false,
      true,
      true,
    ).reason,
  ).toBe("The model provider rejected the credentials for this model.");

  // Billing, access and limits can clear (a top-up, verification, a reset), so
  // they keep Retry and only point at the model picker.
  for (const [recorded, reason] of [
    [openRouterCredits, "The model provider account for this model is out of credits."],
    [orgVerification, "The model provider denied access to this model."],
  ] as const) {
    const copy = failedSessionCopy({ ...summary, reason: recorded, recordedDetail: recorded });
    expect(copy).toEqual({
      reason,
      unavailableModel: false,
      retryUnhelpful: false,
      detail: recorded,
    });
    expect(
      failedSessionCopy(
        { ...summary, reason: recorded, recordedDetail: recorded },
        false,
        false,
        true,
      ).reason,
    ).toBe(`${reason} Choose another model below.`);
  }
});

test("a bare HTTP status classifies only 401, 402, 403 and 429", () => {
  expect(failedSessionCopy({ ...summary, reason: "403 Forbidden" })).toMatchObject({
    reason: "The model provider denied access to this model.",
    retryUnhelpful: false,
  });
  expect(failedSessionCopy({ ...summary, reason: "429 Too Many Requests" }).reason).toBe(
    "The model provider is rate limiting requests. Try again in a minute.",
  );
  // Other statuses say nothing about the cause, so the recorded text stays.
  for (const reason of [
    "400 Invalid 'input[12].name': string too long. See https://platform.openai.com/docs",
    "404 Not Found",
    "409 Conflict: the resource changed",
    "413 Payload Too Large",
  ]) {
    expect(failedSessionCopy({ ...summary, reason, recordedDetail: reason })).toEqual({
      reason,
      unavailableModel: false,
    });
  }
});

test("provider rate limits separate daily limits and quota from transient throttling", () => {
  const coded = (detail: string) => ({
    ...summary,
    reason: `Model provider rate limit hit. Try again in a minute or lower the reasoning effort. ${detail}`,
    recordedDetail: `Model provider rate limit hit. Try again in a minute or lower the reasoning effort.\n${detail}`,
    failureCode: "provider_rate_limited",
  });
  expect(
    failedSessionCopy(
      coded("429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock more."),
    ),
  ).toMatchObject({ reason: "This model's daily limit has been reached.", retryUnhelpful: false });
  // Quota and 402 billing are the same "no budget" state: both keep Retry.
  expect(
    failedSessionCopy(coded("429 You exceeded your current quota, please check your plan.")),
  ).toMatchObject({
    reason: "The model provider's usage quota for this model is used up.",
    retryUnhelpful: false,
  });
  expect(failedSessionCopy(coded("429 Too Many Requests"))).toMatchObject({
    reason: "The model provider is rate limiting requests. Try again in a minute.",
    retryUnhelpful: false,
  });
});

test("an exhausted provider quota is terminal copy that points at the model picker", () => {
  // The worker's turn.failed payload: authored copy in `error`, provider text in `detail`.
  const exhausted = (error: string, detail: string) => ({
    ...summary,
    reason: `${error} ${detail}`,
    recordedDetail: `${error}\n${detail}`,
    failureCode: "provider_quota_exhausted",
  });
  const daily = exhausted(
    "This model's daily limit at the model provider has been reached, so automatic retries stopped. Choose another model, or try again after the limit resets.",
    "429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
  );
  expect(failedSessionCopy(daily, false, false, true)).toEqual({
    reason: "This model's daily limit has been reached. Choose another model below.",
    unavailableModel: false,
    retryUnhelpful: false,
    detail: daily.recordedDetail,
  });
  // Once another model is chosen the hint is dropped; Retry stays available.
  expect(failedSessionCopy(daily, false, true, true)).toMatchObject({
    reason: "This model's daily limit has been reached.",
    retryUnhelpful: false,
  });

  const monthly = exhausted(
    "This model's monthly limit at the model provider has been reached, so automatic retries stopped. Choose another model, or try again after the limit resets.",
    "429 Quota exceeded for this deployment. Please retry after 20 days.",
  );
  expect(failedSessionCopy(monthly, false, false, true).reason).toBe(
    "The model provider's usage quota for this model is used up. Choose another model below.",
  );

  const credits = exhausted(
    "The model provider account for this model is out of credits, so automatic retries stopped. Choose another model, or add credits with the provider and try again.",
    "429 Your team has either used all available credits or reached its monthly spending limit.",
  );
  expect(failedSessionCopy(credits, false, false, true)).toMatchObject({
    reason:
      "The model provider account for this model is out of credits. Choose another model below.",
    retryUnhelpful: false,
  });

  const quota = exhausted(
    "The model provider's usage quota for this model is used up, so automatic retries stopped. Choose another model, or try again after the quota resets.",
    "429 You exceeded your current quota, please check your plan and billing details.",
  );
  expect(failedSessionCopy(quota, false, false, true).reason).toBe(
    "The model provider's usage quota for this model is used up. Choose another model below.",
  );
});

test("authored worker copy and OpenGeni credit failures keep their own wording", () => {
  const codex = "Your ChatGPT/Codex subscription usage limit has been reached. Access resets soon.";
  expect(
    failedSessionCopy({
      ...summary,
      reason: codex,
      recordedDetail: `${codex}\n429 You exceeded your current quota`,
      failureCode: "codex_usage_limit_reached",
    }),
  ).toEqual({ reason: codex, unavailableModel: false });
  const credits = "Insufficient OpenGeni credits for this turn";
  expect(failedSessionCopy({ ...summary, reason: credits, recordedDetail: credits })).toEqual({
    reason: credits,
    unavailableModel: false,
  });
  expect(
    failedSessionCopy({
      ...summary,
      reason: "Connection interrupted.",
      recordedDetail: "Connection interrupted.",
    }),
  ).toEqual({ reason: "Connection interrupted.", unavailableModel: false });
});
