import { describe, expect, test } from "bun:test";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { compactionLimitError, parseTokenLimit } from "./model-compaction-page";
import { compactionSummary } from "./workspace-models-page";

const policy = {
  defaultTokens: 300_000,
  overrideTokens: null,
  effectiveTokens: 300_000,
  minimumTokens: 8_000,
  maximumTokens: 872_000,
};

describe("compaction limits", () => {
  test("read plain, grouped and k-suffixed numbers", () => {
    for (const text of ["250000", "250,000", " 250 000 ", "250k", "250K", "250_000"])
      expect(parseTokenLimit(text)).toBe(250_000);
    expect(parseTokenLimit("1.5k")).toBe(1_500);
    for (const text of ["", "abc", "25e4", "-5", "250.5"]) expect(parseTokenLimit(text)).toBeNull();
  });

  test("explain the range, with a 16,000 floor", () => {
    expect(compactionLimitError("16000", policy)).toBeNull();
    expect(compactionLimitError("872k", policy)).toBeNull();
    for (const text of ["15999", "872001", "lots"])
      expect(compactionLimitError(text, policy)).toBe("Use a number from 16,000 to 872,000.");
  });

  test("the Models row counts custom limits on the models the page lists", () => {
    const model = (overrideTokens: number | null, status = "ready") =>
      ({
        compactionPolicy: { ...policy, overrideTokens },
        credentialReadiness: { status },
      }) as unknown as WorkspaceModelCatalogModel;
    expect(compactionSummary([])).toBeUndefined();
    expect(compactionSummary([model(null), model(null)])).toBe("Model defaults");
    expect(compactionSummary([model(90_000), model(null)])).toBe("1 custom limit");
    expect(compactionSummary([model(90_000), model(200_000), model(5, "missing")])).toBe(
      "2 custom limits",
    );
  });
});
