import { expect, test } from "bun:test";
import * as root from "../src/index";
import {
  humanizeModelSlug,
  isRawModelLabel,
  modelDisplayName,
  modelSlug,
  modelVendor,
} from "../src/model-display";

test("published model display helpers remain available from the SDK root and leaf", () => {
  const helpers = { humanizeModelSlug, isRawModelLabel, modelDisplayName, modelSlug, modelVendor };
  for (const [name, helper] of Object.entries(helpers)) {
    expect((root as unknown as Record<string, unknown>)[name], name).toBe(helper);
  }
});

test("account schema types do not become root runtime exports", () => {
  for (const name of [
    "SubscriptionAccountSummary",
    "SubscriptionPoolSettings",
    "ClaudeSubscriptionSetupTokenRequest",
    "ClaudeSubscriptionAccount",
    "ClaudeSubscriptionAccountsResponse",
  ]) {
    expect(Object.hasOwn(root, name), name).toBe(false);
  }
});
