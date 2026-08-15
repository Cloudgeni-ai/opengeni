import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/company-brain-governed-writes.ts",
);

describe("Company Brain governed write admission", () => {
  test("locks canonical attempt rows before a fresh interruption recheck and every mutation", async () => {
    const source = await readFile(sourcePath, "utf8");
    const lockStart = source.indexOf("WITH locked_workspace AS MATERIALIZED");
    const recheckStart = source.indexOf("const revalidated =");
    const actorStart = source.indexOf("const actor: ScopedKnowledgeActor");
    const mutationStart = source.indexOf("const review = await appendKnowledgeClaimReview");
    expect(lockStart).toBeGreaterThanOrEqual(0);
    expect(recheckStart).toBeGreaterThan(lockStart);
    expect(actorStart).toBeGreaterThan(recheckStart);
    expect(mutationStart).toBeGreaterThan(actorStart);
    expect(source.slice(lockStart, recheckStart)).not.toContain("session_attempt_interruptions");
    expect(source.slice(recheckStart, actorStart)).toContain("session_attempt_interruptions");
    expect(source.slice(recheckStart, actorStart)).toContain(
      "interruption.state IN ('pending', 'delivered', 'acknowledged')",
    );
  });
});
