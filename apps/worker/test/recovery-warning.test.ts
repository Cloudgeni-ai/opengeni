import { expect, mock, test } from "bun:test";

let warning: string | null = "Filesystem discontinuity: exact accepted checkpoint";
let failure: Error | null = null;
mock.module("@opengeni/db", () => ({
  getSandboxRecoveryDiscontinuity: async () => {
    if (failure) throw failure;
    return warning;
  },
}));
const { recoveryAwareSessionInstructions, FILESYSTEM_DISCONTINUITY_PROTOCOL } =
  await import("../src/activities/agent-turn/recovery-warning");

test("the compatible worker module reconstructs the warning independently of transcript context", async () => {
  expect(FILESYSTEM_DISCONTINUITY_PROTOCOL).toBe(2);
  for (const instructions of [
    null,
    "After compaction",
    "After recovery",
    "Continuation",
    "Retry",
  ]) {
    expect(
      await recoveryAwareSessionInstructions({} as never, "workspace", {
        id: "session",
        instructions,
      }),
    ).toContain(warning!);
  }
  warning = null;
  expect(
    await recoveryAwareSessionInstructions({} as never, "workspace", {
      id: "session",
      instructions: "ordinary",
    }),
  ).toBe("ordinary");
});

test("warning fetch or parse failure prevents reaching inference", async () => {
  for (const message of ["Database unavailable", "Invalid durable consent receipt"]) {
    failure = new Error(message);
    let reachedInference = false;
    await expect(
      (async () => {
        await recoveryAwareSessionInstructions({} as never, "workspace", { id: "session" });
        reachedInference = true;
      })(),
    ).rejects.toThrow(message);
    expect(reachedInference).toBe(false);
  }
  failure = null;
});
