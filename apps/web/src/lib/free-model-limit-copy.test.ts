import { expect, test } from "bun:test";
import { freeModelConnectRemedy, freeModelDailyLimitReason } from "./free-model-limit-copy";

const both = { codex: true, supergrok: true };
const all = {
  modelChanged: false,
  canBuyCredits: true,
  canConnectModel: true,
  subscriptions: both,
  canChooseModel: true,
};
const headline = "The free model has reached its daily limit.";

test("names the free model and every remedy the viewer can use", () => {
  expect(freeModelDailyLimitReason(all)).toBe(
    `${headline} Buy OpenGeni credits, connect ChatGPT or SuperGrok, or pick another model to keep going.`,
  );
});

test("names only the subscriptions this deployment enables", () => {
  const cases = [
    [both, "connect ChatGPT or SuperGrok", "Connect a subscription"],
    [{ codex: true, supergrok: false }, "connect ChatGPT", "Connect ChatGPT"],
    [{ codex: false, supergrok: true }, "connect SuperGrok", "Connect SuperGrok"],
    [{ codex: false, supergrok: false }, "connect a model provider", "Connect a model"],
  ] as const;
  for (const [subscriptions, phrase, linkLabel] of cases) {
    expect(freeModelConnectRemedy(subscriptions)).toEqual({ phrase, linkLabel });
    expect(freeModelDailyLimitReason({ ...all, subscriptions })).toBe(
      `${headline} Buy OpenGeni credits, ${phrase}, or pick another model to keep going.`,
    );
  }
  // Without either subscription, the connect remedy never names one.
  expect(
    freeModelDailyLimitReason({
      ...all,
      canBuyCredits: false,
      canChooseModel: false,
      subscriptions: { codex: false, supergrok: false },
    }),
  ).toBe(`${headline} Connect a model provider to keep going.`);
});

test("lists only the remedies this viewer can act on", () => {
  expect(freeModelDailyLimitReason({ ...all, canBuyCredits: false })).toBe(
    `${headline} Connect ChatGPT or SuperGrok, or pick another model to keep going.`,
  );
  expect(freeModelDailyLimitReason({ ...all, canConnectModel: false })).toBe(
    `${headline} Buy OpenGeni credits, or pick another model to keep going.`,
  );
  expect(
    freeModelDailyLimitReason({
      ...all,
      canBuyCredits: false,
      canConnectModel: false,
    }),
  ).toBe(`${headline} Pick another model to keep going.`);
  expect(
    freeModelDailyLimitReason({
      ...all,
      canBuyCredits: false,
      canConnectModel: false,
      canChooseModel: false,
    }),
  ).toBe(`${headline} Try again after it resets.`);
});

test("drops the remedies once another model is selected", () => {
  expect(freeModelDailyLimitReason({ ...all, modelChanged: true })).toBe(headline);
});
