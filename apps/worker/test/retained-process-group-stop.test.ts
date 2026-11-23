import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cancellableShellCommand } from "../../../packages/runtime/src/sandbox/turn-tool-cancellation";
import {
  parseRetainedProcessGroupControl,
  retainedProcessGroupStopOutcome,
} from "@opengeni/runtime/sandbox";
import { stopRetainedProcessGroup } from "../src/activities/sandbox-lease";

// The reaper runs the stop helper as one ordinary provider exec on the box.
// Locally that exec is `bash -c`, reported with the same exit banner.
function localBoxSession() {
  return {
    execCommand: async (args: { cmd: string }) =>
      await new Promise<string>((resolve, reject) => {
        const child = spawn("bash", ["-c", args.cmd], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", reject);
        child.on("close", (code) =>
          resolve(`Process exited with code ${code ?? -1}\nOutput:\n${output}`),
        );
      }),
  };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

async function startWrappedCommand(command: string) {
  const dir = mkdtempSync(join(tmpdir(), "opengeni-group-stop-"));
  const token = crypto.randomUUID();
  const markerPath = join(dir, "markers", token);
  const child: ChildProcess = spawn("bash", ["-c", cancellableShellCommand(command, markerPath)], {
    env: { ...process.env, OUT_DIR: dir },
    stdio: "ignore",
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  cleanup.push(() => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !existsSync(markerPath); i++) await delay(20);
  expect(existsSync(markerPath)).toBe(true);
  return { dir, control: { markerPath, token }, exited };
}

describe("Pause/Stop of an adopted unsupervised command", () => {
  test("ends the whole process group, including a child that ignores TERM, with no delayed write", async () => {
    // Mirrors the Workbench acceptance Pause fixture: every process ignores
    // INT/TERM and writes a file after a delay unless it is killed first.
    const { dir, control, exited } = await startWrappedCommand(
      [
        "trap '' TERM INT",
        '( trap "" TERM INT; sleep 2; echo child > "$OUT_DIR/child-wrote" ) &',
        'sleep 2; echo leader > "$OUT_DIR/leader-wrote"',
      ].join("\n"),
    );
    const parsed = parseRetainedProcessGroupControl(control);
    expect(parsed).toEqual(control);

    expect(await stopRetainedProcessGroup(localBoxSession() as never, parsed!)).toBe(true);
    const ended = await exited;
    expect(ended.signal ?? ended.code).not.toBeNull();

    await delay(3_000);
    expect(existsSync(join(dir, "child-wrote"))).toBe(false);
    expect(existsSync(join(dir, "leader-wrote"))).toBe(false);
  }, 20_000);

  test("never signals a process whose arguments do not carry the token", async () => {
    const { dir, control, exited } = await startWrappedCommand(
      'sleep 1; echo done > "$OUT_DIR/finished"',
    );
    // The real marker with a foreign token: the live group's leader does not
    // carry that token, so the helper signals nothing and proves nothing.
    const foreign = { markerPath: control.markerPath, token: crypto.randomUUID() };
    expect(await stopRetainedProcessGroup(localBoxSession() as never, foreign)).toBe(false);
    const ended = await exited;
    expect(ended).toEqual({ code: 0, signal: null });
    expect(existsSync(join(dir, "finished"))).toBe(true);
  }, 20_000);

  test("a transport failure is not a stop", async () => {
    const control = {
      markerPath: `/tmp/opengeni-turn-shell/${crypto.randomUUID()}`,
      token: "",
    };
    control.token = control.markerPath.slice(control.markerPath.lastIndexOf("/") + 1);
    const failing = {
      execCommand: async () => {
        throw new Error("provider unavailable");
      },
    };
    expect(await stopRetainedProcessGroup(failing as never, control)).toBe(false);
    expect(await stopRetainedProcessGroup({} as never, control)).toBe(false);
  });

  test("only well-formed stored identities are used", () => {
    const token = crypto.randomUUID();
    expect(parseRetainedProcessGroupControl({ markerPath: `/tmp/m/${token}`, token })).toEqual({
      markerPath: `/tmp/m/${token}`,
      token,
    });
    for (const bad of [
      null,
      "x",
      { markerPath: `/tmp/m/${token}` },
      { markerPath: `tmp/m/${token}`, token },
      { markerPath: `/tmp/m/other`, token },
      { markerPath: `/tmp/../m/${token}`, token },
      { markerPath: `/tmp/m\n/${token}`, token },
      { markerPath: "/tmp/m/a'b", token: "a'b" },
      { markerPath: "/tmp/m/short", token: "short" },
    ])
      expect(parseRetainedProcessGroupControl(bad)).toBeNull();
    expect(retainedProcessGroupStopOutcome(0)).toBe("stopped");
    expect(retainedProcessGroupStopOutcome(74)).toBe("stopped");
    expect(retainedProcessGroupStopOutcome(75)).toBe("live");
    expect(retainedProcessGroupStopOutcome(76)).toBe("inconclusive");
    expect(retainedProcessGroupStopOutcome(null)).toBe("inconclusive");
  });
});
