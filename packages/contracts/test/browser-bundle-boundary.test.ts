import { describe, expect, test } from "bun:test";
import path from "node:path";

const fixtureRoot = path.resolve(import.meta.dir, "fixtures");

async function bundle(entrypoint: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(fixtureRoot, entrypoint)],
    format: "esm",
    target: "browser",
    minify: true,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Could not bundle ${entrypoint}`);
  }
  return await result.outputs[0]!.text();
}

describe("contracts browser bundle boundary", () => {
  test("keeps agent-topology and work-claim validators out of unrelated browser imports", async () => {
    const [browserCore, agentTopology] = await Promise.all([
      bundle("browser-core-bundle-entry.ts"),
      bundle("agent-topology-bundle-entry.ts"),
    ]);

    expect(browserCore).toContain("work_claim_upsert");
    expect(browserCore).not.toContain("possibleOverlap");
    expect(browserCore).not.toContain("work claim canonical key");

    expect(agentTopology).toContain("possibleOverlap");
    expect(agentTopology).toContain("noAdditionalAccess");
  });
});
