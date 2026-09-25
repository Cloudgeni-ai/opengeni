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
    reason: "The model provider rejected this model's credentials.",
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
  ).toBe("The model provider rejected this model's credentials. Choose another model below.");
  expect(
    failedSessionCopy(
      { ...summary, reason: openAiKey, recordedDetail: openAiKey },
      false,
      true,
      true,
    ).reason,
  ).toBe("The model provider rejected this model's credentials.");

  for (const [recorded, reason, retryUnhelpful] of [
    [openRouterCredits, "The model provider account for this model is out of credits.", true],
    [orgVerification, "The model provider denied access to this model.", true],
    [
      "400 Invalid 'input[12].name': string too long. See https://platform.openai.com/docs",
      "The model provider rejected this request.",
      false,
    ],
  ] as const) {
    const copy = failedSessionCopy({ ...summary, reason: recorded, recordedDetail: recorded });
    expect(copy).toEqual({ reason, unavailableModel: false, retryUnhelpful, detail: recorded });
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
  ).toMatchObject({ reason: "This model's daily limit has been reached.", retryUnhelpful: true });
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
