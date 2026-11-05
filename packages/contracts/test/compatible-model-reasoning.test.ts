import { expect, test } from "bun:test";
import {
  CompatibleModelReasoning,
  DirectModelProviderMetadata,
  compatibleModelReasoningFromListing,
} from "../src";

test("a /models entry's published reasoning levels are read in Opengeni's order", () => {
  expect(
    compatibleModelReasoningFromListing({
      id: "acme/thinker",
      supported_reasoning_efforts: ["max", "high", "ultra", "none", "low", 7],
      reasoning_effort: "high",
    }),
  ).toEqual({ efforts: ["none", "low", "high", "max"], defaultEffort: "high" });
  // An explicit default wins over the request-style field.
  expect(
    compatibleModelReasoningFromListing({
      reasoning_efforts: ["low", "high"],
      default_reasoning_effort: "low",
      reasoning_effort: "high",
    }),
  ).toEqual({ efforts: ["low", "high"], defaultEffort: "low" });
  // Without a usable default, medium, then high, then low, then the first thinking level.
  expect(
    compatibleModelReasoningFromListing({
      supported_reasoning_efforts: ["none", "high", "max"],
      reasoning_effort: "ultra",
    }),
  ).toEqual({ efforts: ["none", "high", "max"], defaultEffort: "high" });
  expect(compatibleModelReasoningFromListing({ supported_reasoning_efforts: ["none"] })).toEqual({
    efforts: ["none"],
    defaultEffort: "none",
  });
  for (const entry of [null, [], "x", { id: "m" }, { supported_reasoning_efforts: ["ultra"] }])
    expect(compatibleModelReasoningFromListing(entry)).toBeNull();
});

test("saved reasoning levels are sorted, deduplicated and must contain their default", () => {
  expect(
    CompatibleModelReasoning.parse({ efforts: ["high", "low", "high"], defaultEffort: "low" }),
  ).toEqual({ efforts: ["low", "high"], defaultEffort: "low" });
  expect(
    CompatibleModelReasoning.safeParse({ efforts: ["low"], defaultEffort: "high" }).success,
  ).toBe(false);
  expect(CompatibleModelReasoning.safeParse({ efforts: [], defaultEffort: "low" }).success).toBe(
    false,
  );
  // Only a compatible endpoint's metadata may carry them.
  const reasoning = { efforts: ["low", "high"], defaultEffort: "high" };
  expect(
    DirectModelProviderMetadata.safeParse({
      provider: "openai_compatible",
      baseUrl: "https://inference.example.com/v1",
      model: "acme/thinker",
      reasoning,
    }).success,
  ).toBe(true);
  expect(
    DirectModelProviderMetadata.safeParse({ provider: "openai", model: "gpt-5", reasoning })
      .success,
  ).toBe(false);
});
