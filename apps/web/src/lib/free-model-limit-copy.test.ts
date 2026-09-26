import { expect, test } from "bun:test";
import { freeModelDailyLimitReason } from "./free-model-limit-copy";

const all = {
  modelChanged: false,
  canBuyCredits: true,
  canConnectModel: true,
  canChooseModel: true,
};

test("names the free model and every remedy the viewer can use", () => {
  expect(freeModelDailyLimitReason(all)).toBe(
    "The free model has reached its daily limit. Add OpenGeni credits, connect ChatGPT or SuperGrok, or pick another model to keep going.",
  );
});

test("lists only the remedies this viewer can act on", () => {
  expect(freeModelDailyLimitReason({ ...all, canBuyCredits: false })).toBe(
    "The free model has reached its daily limit. Connect ChatGPT or SuperGrok, or pick another model to keep going.",
  );
  expect(freeModelDailyLimitReason({ ...all, canConnectModel: false })).toBe(
    "The free model has reached its daily limit. Add OpenGeni credits, or pick another model to keep going.",
  );
  expect(
    freeModelDailyLimitReason({
      ...all,
      canBuyCredits: false,
      canConnectModel: false,
    }),
  ).toBe("The free model has reached its daily limit. Pick another model to keep going.");
  expect(
    freeModelDailyLimitReason({
      ...all,
      canBuyCredits: false,
      canConnectModel: false,
      canChooseModel: false,
    }),
  ).toBe("The free model has reached its daily limit. Try again after it resets.");
});

test("drops the remedies once another model is selected", () => {
  expect(freeModelDailyLimitReason({ ...all, modelChanged: true })).toBe(
    "The free model has reached its daily limit.",
  );
});
