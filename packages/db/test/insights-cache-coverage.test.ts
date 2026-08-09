import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const sourcePath = new URL("../src/insights.ts", import.meta.url);

describe("Insights cache coverage SQL", () => {
  test("counts only calls with both cache-read and input telemetry", async () => {
    const source = await readFile(sourcePath, "utf8");
    const completeTelemetryPredicate =
      "cachedTokens} is not null and ${schema.modelCallFacts.inputTokens} is not null";

    expect(source.split(completeTelemetryPredicate)).toHaveLength(7);
    expect(source).not.toContain(
      "cacheKnownCalls: sql<number>`count(${schema.modelCallFacts.cachedTokens})::int`",
    );
  });
});
