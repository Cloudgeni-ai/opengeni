import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const adapterUrl = new URL(
  "../src/domain/preference-registry-durable-learning-adapter.ts",
  import.meta.url,
);

describe("Preference Registry durable-learning principal", () => {
  test("emits agent_attempt authority and never spoofs a direct human session", async () => {
    const source = await readFile(adapterUrl, "utf8");
    expect(source).not.toContain('principalKind: "human_session"');
    expect(source.match(/principalKind: "agent_attempt"/gu)).toHaveLength(3);
    expect(source.match(/durableLearningAttemptId: attempt\.id/gu)).toHaveLength(3);
    expect(source.match(/durableLearningInputHash: attempt\.inputHash/gu)).toHaveLength(3);
  });
});
