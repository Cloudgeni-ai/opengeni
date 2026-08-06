import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseGnuTime } from "./profile-command";

describe("secret-safe command profile parsing", () => {
  test("parses GNU time CPU, RSS, and filesystem counters", () => {
    expect(
      parseGnuTime(`
        User time (seconds): 1.25
        System time (seconds): 0.50
        Maximum resident set size (kbytes): 2048
        File system inputs: 3
        File system outputs: 4
      `),
    ).toEqual({
      userSeconds: 1.25,
      systemSeconds: 0.5,
      maxRssBytes: 2 * 1024 * 1024,
      fileSystemInputs: 3,
      fileSystemOutputs: 4,
    });
  });

  test("missing or malformed fields remain explicit nulls", () => {
    expect(parseGnuTime("Maximum resident set size (kbytes): nope\n")).toEqual({
      userSeconds: null,
      systemSeconds: null,
      maxRssBytes: null,
      fileSystemInputs: null,
      fileSystemOutputs: null,
    });
  });

  test("failure still writes terminal evidence", async () => {
    const output = join(mkdtempSync(join(tmpdir(), "opengeni-profile-failure-")), "result.json");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--name",
        "failure",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        "exit 7",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await child.exited).toBe(7);
    const profile = JSON.parse(readFileSync(output, "utf8")) as { exitCode: number };
    expect(profile.exitCode).toBe(7);
  });

  test("deadline terminates the command group and records a timeout", async () => {
    const output = join(mkdtempSync(join(tmpdir(), "opengeni-profile-timeout-")), "result.json");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--name",
        "timeout",
        "--output",
        output,
        "--timeout-seconds",
        "1",
        "--",
        "sleep",
        "30",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await child.exited).not.toBe(0);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      timedOut: boolean;
      timeoutSeconds: number;
      forwardedSignal: string | null;
    };
    expect(profile.timedOut).toBe(true);
    expect(profile.timeoutSeconds).toBe(1);
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });

  test("a TERM-trapping command cannot turn a timeout into success", async () => {
    if (process.platform === "win32") return;
    const output = join(
      mkdtempSync(join(tmpdir(), "opengeni-profile-trapped-timeout-")),
      "result.json",
    );
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--name",
        "trapped-timeout",
        "--output",
        output,
        "--timeout-seconds",
        "1",
        "--",
        "sh",
        "-c",
        "trap 'exit 0' TERM; while :; do sleep 1; done",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await child.exited).toBe(124);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      timedOut: boolean;
    };
    expect(profile.exitCode).toBe(124);
    expect(profile.timedOut).toBe(true);
  });

  test("cancellation is forwarded and recorded", async () => {
    const output = join(mkdtempSync(join(tmpdir(), "opengeni-profile-cancel-")), "result.json");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--name",
        "cancel",
        "--output",
        output,
        "--",
        "sleep",
        "30",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await Bun.sleep(150);
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      forwardedSignal: string | null;
    };
    expect(profile.exitCode).not.toBe(0);
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });

  test("cancellation terminates the complete descendant process group", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-tree-cancel-"));
    const output = join(root, "result.json");
    const pidFile = join(root, "descendant.pid");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--name",
        "tree-cancel",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        `sleep 30 & echo $! > ${pidFile}; wait`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    for (let attempt = 0; attempt < 40 && !existsSync(pidFile); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(existsSync(pidFile)).toBe(true);
    const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
      } catch {
        break;
      }
      await Bun.sleep(25);
    }
    expect(() => process.kill(descendantPid, 0)).toThrow();
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      forwardedSignal: string | null;
    };
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });

  test("cancellation escalates after the leader exits while a descendant survives TERM", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-leader-exit-"));
    const output = join(root, "result.json");
    const pidFile = join(root, "descendant.pid");
    const script = join(root, "leader-exits.sh");
    writeFileSync(
      script,
      `#!/usr/bin/env bash
set -eu
trap 'exit 0' TERM
(
  trap '' TERM
  echo "$BASHPID" > "$1"
  while :; do sleep 1; done
) &
wait
`,
    );
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--name",
        "leader-exits",
        "--output",
        output,
        "--",
        "bash",
        script,
        pidFile,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, OPENGENI_PROFILE_KILL_GRACE_MS: "100" },
      },
    );
    for (let attempt = 0; attempt < 80 && !existsSync(pidFile); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(existsSync(pidFile)).toBe(true);
    const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    expect(() => process.kill(descendantPid, 0)).toThrow();
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      forwardedSignal: string | null;
    };
    expect(profile.exitCode).not.toBe(0);
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });

  test("a successful leader cannot leave an unprofiled descendant behind", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-orphan-"));
    const output = join(root, "result.json");
    const pidFile = join(root, "descendant.pid");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--name",
        "orphan",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        'sleep 300 >/dev/null 2>&1 & echo "$!" > "$1"',
        "sh",
        pidFile,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: {
          ...process.env,
          OPENGENI_PROFILE_KILL_GRACE_MS: "100",
          OPENGENI_PROFILE_NATURAL_SETTLE_MS: "100",
        },
      },
    );
    expect(await child.exited).toBe(70);
    const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(() => process.kill(descendantPid, 0)).toThrow();
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      observedExitCode: number;
      processGroupObservedAfterLeaderExit: boolean;
      processGroupSettledNaturally: boolean | null;
      processGroupLeakDetected: boolean;
      processGroupSettled: boolean;
    };
    expect(profile.exitCode).toBe(70);
    expect(profile.observedExitCode).toBe(0);
    expect(profile.processGroupObservedAfterLeaderExit).toBe(true);
    expect(profile.processGroupSettledNaturally).toBe(false);
    expect(profile.processGroupLeakDetected).toBe(true);
    expect(profile.processGroupSettled).toBe(true);
  });

  test("a successful leader permits bounded natural descendant teardown", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-natural-settle-"));
    const output = join(root, "result.json");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--name",
        "natural-settle",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        "sleep 0.5 >/dev/null 2>&1 &",
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, OPENGENI_PROFILE_NATURAL_SETTLE_MS: "1000" },
      },
    );
    expect(await child.exited).toBe(0);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      observedExitCode: number;
      processGroupObservedAfterLeaderExit: boolean;
      processGroupSettledNaturally: boolean | null;
      processGroupLeakDetected: boolean;
      processGroupSettled: boolean;
    };
    expect(profile.exitCode).toBe(0);
    expect(profile.observedExitCode).toBe(0);
    expect(profile.processGroupObservedAfterLeaderExit).toBe(true);
    expect(profile.processGroupSettledNaturally).toBe(true);
    expect(profile.processGroupLeakDetected).toBe(false);
    expect(profile.processGroupSettled).toBe(true);
  });

  test("cancellation escalates against a TERM-ignoring descendant group", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-stubborn-cancel-"));
    const output = join(root, "result.json");
    const ready = join(root, "ready");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--name",
        "stubborn-cancel",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        `trap '' TERM; touch ${ready}; while :; do sleep 1; done`,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, OPENGENI_PROFILE_KILL_GRACE_MS: "100" },
      },
    );
    for (let attempt = 0; attempt < 80 && !existsSync(ready); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(existsSync(ready)).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      forwardedSignal: string | null;
    };
    expect(profile.exitCode).not.toBe(0);
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });
});
