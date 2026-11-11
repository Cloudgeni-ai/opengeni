import { expect, test } from "bun:test";
import { freshWorkspaceSandboxRecoveryDiscontinuity } from "@opengeni/contracts";
import {
  recoveryAwareSessionInstructions,
  FILESYSTEM_DISCONTINUITY_PROTOCOL,
} from "../src/activities/agent-turn/recovery-warning";

let warning: string | null = "Filesystem discontinuity: exact accepted checkpoint";
let failure: Error | null = null;
const readDiscontinuity = async () => {
  if (failure) throw failure;
  return warning;
};

test("the compatible worker module reconstructs the warning independently of transcript context", async () => {
  expect(FILESYSTEM_DISCONTINUITY_PROTOCOL).toBe(4);
  for (const instructions of [
    null,
    "After compaction",
    "After recovery",
    "Continuation",
    "Retry",
  ]) {
    expect(
      await recoveryAwareSessionInstructions(
        {} as never,
        "workspace",
        {
          id: "session",
          instructions,
        },
        readDiscontinuity,
      ),
    ).toContain(warning!);
  }
  warning = null;
  expect(
    await recoveryAwareSessionInstructions(
      {} as never,
      "workspace",
      {
        id: "session",
        instructions: "ordinary",
      },
      readDiscontinuity,
    ),
  ).toBe("ordinary");
});

test("warning fetch or parse failure prevents reaching inference", async () => {
  for (const message of ["Database unavailable", "Invalid durable consent receipt"]) {
    failure = new Error(message);
    let reachedInference = false;
    await expect(
      (async () => {
        await recoveryAwareSessionInstructions(
          {} as never,
          "workspace",
          { id: "session" },
          readDiscontinuity,
        );
        reachedInference = true;
      })(),
    ).rejects.toThrow(message);
    expect(reachedInference).toBe(false);
  }
  failure = null;
});

test("explicit recovery never rewrites the previously sent session instruction prefix", async () => {
  const instructions = "stable session instructions";
  let explicitDecision = false;
  const reader: typeof readDiscontinuity = async () => null;
  const read = async (_db: unknown, _workspace: string, _session: string, projection?: string) => {
    expect(projection).toBe("legacy_instructions");
    return projection === "explicit_notice" && explicitDecision
      ? "new filesystem warning"
      : reader();
  };
  const before = await recoveryAwareSessionInstructions(
    {} as never,
    "workspace",
    { id: "session", instructions },
    read,
  );
  explicitDecision = true;
  const after = await recoveryAwareSessionInstructions(
    {} as never,
    "workspace",
    { id: "session", instructions },
    read,
  );
  expect(after).toBe(before);
  expect(after).toBe(instructions);
});

test("the empty-workspace variant survives every reconstruction and names the loss, not the tree", async () => {
  const fresh = freshWorkspaceSandboxRecoveryDiscontinuity({
    version: 1,
    sessionId: crypto.randomUUID(),
    sandboxGroupId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    leaseEpoch: 5,
    workspaceGeneration: 81,
    archiveGeneration: null,
    lostAt: "2026-09-24T07:50:31.000Z",
    reason: "archive_unavailable",
  });
  for (const instructions of [null, "After compaction", "After recovery", "Retry"]) {
    const composed = await recoveryAwareSessionInstructions(
      {} as never,
      "workspace",
      { id: "session", instructions },
      async () => fresh,
    );
    expect(composed).toContain("lost at 2026-09-24T07:50:31.000Z");
    expect(composed).toContain("new empty workspace");
    expect(composed).toContain("do not assume they exist");
    expect(composed).toContain("Never automatically replay prior commands");
    if (instructions) expect(composed.startsWith(instructions)).toBe(true);
  }
});
