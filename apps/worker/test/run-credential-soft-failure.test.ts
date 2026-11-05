import { describe, expect, test } from "bun:test";
import {
  clearRunCredentials,
  materializeRunCredentials,
  normalizeRunCredentialsResolution,
} from "@opengeni/runtime";
import * as runCredentials from "../src/activities/agent-turn/run-credentials";

const scope = { accountId: "account-a", workspaceId: "workspace-a", sessionId: "session-a" };

const material = normalizeRunCredentialsResolution(
  {
    status: "ok",
    ...scope,
    environment: { FIXTURE_TOKEN: "fixture-credential-value" },
    files: [],
    fileEnvironment: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as never,
  scope,
)!;

/** A box whose disk is full: writes fail, deletes still work. */
function fullDiskBox(options: { clearFails?: boolean } = {}) {
  const commands: string[] = [];
  return {
    commands,
    exec: async ({ cmd }: { cmd: string }) => {
      commands.push(cmd);
      const clearing = commands.length > 1;
      if (clearing && !options.clearFails) {
        return { exitCode: 0, output: "\n__OPENGENI_RUN_CREDENTIAL_COMMAND_OK__\n" };
      }
      return {
        exitCode: 1,
        output: "bash: line 4: /tmp/opengeni-run-credentials/x/env: No space left on device",
      };
    },
  };
}

function writer(box: ReturnType<typeof fullDiskBox>, initial: boolean) {
  return {
    initial,
    write: async () =>
      await materializeRunCredentials(box as never, material, {
        sessionId: "session-a",
        attemptId: "attempt-a",
        executionGeneration: 1,
        ...(initial ? { pruneOtherAttempts: true } : {}),
      }),
    clear: async () => await clearRunCredentials(box as never, "session-a"),
  };
}

describe("run credential files on a full disk", () => {
  const writeSoftly = (runCredentials as Partial<typeof runCredentials>)
    .writeRunCredentialFilesSoftly;

  test("the first write fails softly and clears every earlier generation", async () => {
    expect(typeof writeSoftly).toBe("function");
    if (!writeSoftly) return;
    const box = fullDiskBox();
    expect(await writeSoftly(writer(box, true))).toEqual({
      hookId: "run-credentials",
      cause: { kind: "no_space" },
    });
    // The write, then the clear of the whole session root (older generations
    // and the half-written staging folder), so no older credentials stay active.
    expect(box.commands).toHaveLength(2);
    expect(box.commands[1]).toContain("/tmp/opengeni-run-credentials/");
    expect(box.commands[1]).toContain("rm -rf");
  });

  test("a renewal write, a failed clear and any other failure still throw", async () => {
    expect(typeof writeSoftly).toBe("function");
    if (!writeSoftly) return;
    await expect(writeSoftly(writer(fullDiskBox(), false))).rejects.toThrow(
      "run credential materialization command failed",
    );
    await expect(writeSoftly(writer(fullDiskBox({ clearFails: true }), true))).rejects.toThrow(
      "run credential materialization command failed",
    );
    const unrelated = new Error("decoder failed");
    await expect(
      writeSoftly({
        initial: true,
        write: async () => {
          throw unrelated;
        },
        clear: async () => undefined,
      }),
    ).rejects.toBe(unrelated);
  });
});
