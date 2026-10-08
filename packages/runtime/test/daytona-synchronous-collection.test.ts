import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Manifest } from "@openai/agents/sandbox";
import { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { executeSynchronousCommand } from "../src/sandbox/synchronous-command";

function fixture(root: string, environment: Record<string, string>) {
  const calls: { command: string; cwd?: string; env?: Record<string, string>; timeout?: number }[] =
    [];
  const session = new DaytonaSandboxSession({
    state: {
      sandboxId: "sb-stream",
      manifest: new Manifest({ root }),
      pauseOnExit: false,
      environment,
    },
    sandbox: {
      id: "sb-stream",
      start: async () => {},
      stop: async () => {},
      delete: async () => {},
      fs: {
        createFolder: async () => {},
        uploadFile: async () => {},
        downloadFile: async () => Buffer.alloc(0),
        deleteFile: async () => {},
      },
      process: {
        executeCommand: async (command, cwd, env, timeout) => {
          calls.push({ command, cwd, env, timeout });
          const child = Bun.spawn(["/bin/sh", "-c", command], {
            cwd,
            env: { ...process.env, ...env },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return { result: stdout + stderr, artifacts: { stdout }, exitCode };
        },
      },
    },
  });
  return { session, calls };
}

test.each([
  [undefined, false],
  [undefined, true],
  [String(process.getuid!()), false],
  [String(process.getuid!()), true],
] as const)(
  "the original Daytona native command retains cwd, environment, runAs %s and login %s through collection",
  async (runAs, login) => {
    const root = await mkdtemp(join(tmpdir(), "daytona-command-"));
    await mkdir(join(root, "child"));
    const environment = { ORIGINAL_ENV: "same" };
    const source = fixture(root, environment);
    const args = {
      cmd: "printf '%s\n%s\n' \"$PWD\" \"$ORIGINAL_ENV\"; printf '  diagnostic\n' >&2",
      workdir: "child",
      runAs,
      login,
      maxOutputTokens: 1,
    };
    try {
      await source.session.execCommand(args);
      const original = source.calls[0]!;
      const result = await executeSynchronousCommand(source.session, args);
      const collected = source.calls[1]!;
      expect(result).toMatchObject({
        stdout: `${join(root, "child")}\nsame\n`,
        stderr: "  diagnostic\n",
        exitCode: 0,
      });
      expect(source.calls).toHaveLength(2);
      expect(collected.command.split(original.command)).toHaveLength(2);
      expect(collected).toMatchObject({
        cwd: original.cwd,
        env: original.env,
        timeout: original.timeout,
      });
      expect(collected.env).toBe(environment);
      expect(collected.cwd).toBe(join(root, "child"));
      // The envelope transports the SDK's exact shell/runAs compilation, not
      // a replacement user command or guessed shell arguments.
      if (runAs) expect(original.command).toContain(`target_user='${runAs}'`);
    } finally {
      await source.session.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a Daytona command on a Python-free environment is unknown rather than falsely complete or replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-no-python-"));
  const source = fixture(root, { PATH: root });
  try {
    // This ordinary shell command is supported without Python. The same
    // environment cannot satisfy the envelope prerequisite; do not fabricate
    // a successful separate page from the native formatter's exit 127.
    expect(await source.session.execCommand({ cmd: "printf original" })).toContain(
      "Process exited with code 0",
    );
    await expect(
      executeSynchronousCommand(source.session, { cmd: "printf original" }),
    ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
    expect(source.calls).toHaveLength(2);
  } finally {
    await source.session.close();
    await rm(root, { recursive: true, force: true });
  }
});
