import { describe, expect, test } from "bun:test";
import { sampleSegmentDatabaseSpans } from "../src/activities/agent-turn/run";

describe("segment database span sampling", () => {
  test("is deterministic per attempt and samples a small share of attempts", () => {
    const ids = Array.from({ length: 4_000 }, (_, index) => `attempt-${index}`);
    for (const id of ids.slice(0, 50)) {
      expect(sampleSegmentDatabaseSpans(id)).toBe(sampleSegmentDatabaseSpans(id));
    }
    const sampled = ids.filter(sampleSegmentDatabaseSpans).length / ids.length;
    expect(sampled).toBeGreaterThan(0.03);
    expect(sampled).toBeLessThan(0.07);
  });
});
