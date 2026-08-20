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
    const mutationStart = source.indexOf(
      "const review = await appendKnowledgeClaimReview",
      actorStart,
    );
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

  test("acquires rooted Task-note authority before generic current-session locks", async () => {
    const source = await readFile(sourcePath, "utf8");
    const prelockStart = source.indexOf("const prelocked = await prelock(scopedDb)");
    const currentSessionLockStart = source.indexOf("WITH locked_workspace AS MATERIALIZED");
    const resolverCall = source.lastIndexOf("return await resolveTaskNotePromotionSource(");
    expect(prelockStart).toBeGreaterThanOrEqual(0);
    expect(currentSessionLockStart).toBeGreaterThan(prelockStart);
    expect(resolverCall).toBeGreaterThan(currentSessionLockStart);
    expect(
      source.slice(resolverCall, source.indexOf("async (scopedDb, authority", resolverCall)),
    ).toContain("resolveTaskNotePromotionSource");
  });

  test("takes the instruction destination workspace lock before rooted Task-note locks", async () => {
    const source = await readFile(sourcePath, "utf8");
    const destinationLock = source.indexOf('if (destinationWorkspaceLock === "update")');
    const workspaceUpdate = source.indexOf("FOR UPDATE OF workspace", destinationLock);
    const rootedPrelock = source.indexOf("const prelocked = await prelock(scopedDb)");
    const modeSelection = source.lastIndexOf(
      'isInstructionPolicyProposal(request) ? "update" : "key_share"',
    );
    expect(destinationLock).toBeGreaterThanOrEqual(0);
    expect(workspaceUpdate).toBeGreaterThan(destinationLock);
    expect(rootedPrelock).toBeGreaterThan(workspaceUpdate);
    expect(modeSelection).toBeGreaterThan(rootedPrelock);
  });

  test("reconstructs archived Task-note replay from bounded immutable Knowledge evidence", async () => {
    const source = await readFile(sourcePath, "utf8");
    const replayStart = source.indexOf("async function replayTaskNoteKnowledgeMaterialization");
    const materializeStart = source.indexOf("async function materializeTaskNoteKnowledge");
    const waysStart = source.indexOf("async function materializeWaysOfWorkingProposal");
    expect(replayStart).toBeGreaterThanOrEqual(0);
    expect(materializeStart).toBeGreaterThan(replayStart);
    expect(waysStart).toBeGreaterThan(materializeStart);
    const replay = source.slice(replayStart, materializeStart);
    expect(replay).toContain("schema.knowledgeClaimEvidence");
    expect(replay).toContain("schema.knowledgeClaims");
    expect(replay).toContain("schema.knowledgeFacts");
    expect(replay).toContain('createHash("sha256")');
    expect(replay).not.toContain("schema.taskNotes");
  });
});
