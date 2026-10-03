import { describe, expect, test } from "bun:test";

import { insightsFilters, nextInsightsSearch, parseInsightsSearch } from "./search";

const ROOT = "0b7c1f7e-2f4a-4c1e-9a9e-3f0d2c1b5a60";

describe("parseInsightsSearch", () => {
  test("keeps valid selections and drops defaults and malformed values", () => {
    expect(
      parseInsightsSearch({
        range: "month",
        chart: "spend",
        provider: "openai",
        model: "gpt-5.4",
        root: ROOT.toUpperCase(),
        session: "not-a-uuid",
      }),
    ).toEqual({ range: "month", chart: "spend", provider: "openai", model: "gpt-5.4", root: ROOT });
    expect(parseInsightsSearch({ range: "week", provider: "all", model: "" })).toEqual({});
    expect(parseInsightsSearch({ range: "decade", provider: "x".repeat(201) })).toEqual({});
  });

  test("maps URL keys onto API filters", () => {
    expect(insightsFilters({ provider: "anthropic", session: ROOT })).toEqual({
      provider: "anthropic",
      model: "all",
      rootSessionId: null,
      sessionId: ROOT,
    });
  });

  test("clears keys that return to their defaults", () => {
    const current = parseInsightsSearch({ range: "ytd", provider: "openai", root: ROOT });
    expect(nextInsightsSearch(current, { provider: "all", rootSessionId: null })).toEqual({
      range: "ytd",
    });
    expect(nextInsightsSearch(current, { range: "week", measure: "money" })).toEqual({
      chart: "spend",
      provider: "openai",
      root: ROOT,
    });
  });
});
