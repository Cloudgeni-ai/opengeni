import { expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSettings } from "@opengeni/testing/settings";
import { buildAgentCapabilities } from "../src/index";
import { sandboxCommandOutput } from "../src/sandbox/command-result";
import {
  createTurnToolCancellationController,
  type TurnToolCancellationFence,
} from "../src/sandbox/turn-tool-cancellation";

test("production capabilities use the manifest temporary directory for setup and tool markers", async () => {
  // Spaces and shell metacharacters must stay literal through every wrapper.
  const directory = await mkdtemp(join(tmpdir(), "marker space ' $literal-"));
  const environment = { TMPDIR: directory };
  const session = await new UnixLocalSandboxClient().create(new Manifest({ environment }));
  let fence!: TurnToolCancellationFence;
  const caps = buildAgentCapabilities(testSettings({ sandboxBackend: "local" }), [], {
    sandboxEnvironment: environment,
    onToolCancellationFence: (value) => {
      fence = value;
    },
  });
  const command = 'test -f "$__opengeni_marker" && printf "%s" "$__opengeni_marker"';
  try {
    const setup = await fence.runSandboxCommand(session, { cmd: command, tty: false });
    expect(sandboxCommandOutput(setup)).toStartWith(`${directory}/opengeni-turn-shell/`);
    const sync = await fence.runSandboxCommandSynchronous(session, { cmd: command });
    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toStartWith(`${directory}/opengeni-turn-shell/`);
    const tool = caps
      .find((cap) => cap.type === "shell")!
      .clone()
      .bind(session)
      .tools()
      .find((candidate) => candidate.name === "exec_command");
    if (!tool || tool.type !== "function") throw new Error("No exec_command");
    const result = await tool.invoke({} as never, JSON.stringify({ cmd: command, tty: false }));
    expect(sandboxCommandOutput(result)).toStartWith(`${directory}/opengeni-turn-shell/`);
  } finally {
    fence.cancel();
    await fence.waitForQuiescence();
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom marker identity remains fixed when the caller changes its environment map", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marker-cancel-"));
  const environment = { TMPDIR: directory };
  const session = await new UnixLocalSandboxClient().create(new Manifest({ environment }));
  const abort = new AbortController();
  let fence!: TurnToolCancellationFence;
  buildAgentCapabilities(testSettings({ sandboxBackend: "local" }), [], {
    sandboxEnvironment: environment,
    turnCancellationSignal: abort.signal,
    onToolCancellationFence: (value) => {
      fence = value;
    },
  });
  environment.TMPDIR = "/unrelated-directory";
  try {
    const command = fence.runSandboxCommand(session, {
      cmd: "trap '' INT TERM; sleep 30",
      tty: false,
      yieldTimeMs: 120_000,
    });
    await Bun.sleep(250);
    abort.abort(new Error("cancel custom marker"));
    await expect(command).rejects.toThrow("cancel custom marker");
    await fence.waitForQuiescence();
  } finally {
    fence.cancel();
    await fence.waitForQuiescence();
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test("invalid temporary paths are rejected before POSIX shell execution", async () => {
  for (const sandboxTemporaryDirectory of ["relative", "/tmp/\0bad"]) {
    const controller = createTurnToolCancellationController(undefined, {
      sandboxTemporaryDirectory,
    });
    await expect(
      controller.runSandboxCommand(
        {
          execCommand: async () => {
            throw new Error("must not dispatch");
          },
        },
        { cmd: "true" },
      ),
    ).rejects.toThrow("Sandbox temporary directory must be absolute");
  }
});

test("connected-machine commands do not interpret Windows TMPDIR as a POSIX marker path", async () => {
  const controller = createTurnToolCancellationController(undefined, {
    sandboxTemporaryDirectory: "C:\\Users\\runner\\Temp",
  });
  const commands: string[] = [];
  const session = {
    commandCancellationTransport: async () => "remote_operation" as const,
    cancelExecCommand: async () => true,
    exec: async ({ cmd }: { cmd: string }) => {
      commands.push(cmd);
      return { exitCode: 0, output: "done" };
    },
  };
  const result = await controller.runSandboxCommand(session, { cmd: "Write-Output done" });
  expect(sandboxCommandOutput(result)).toBe("done");
  expect(commands).toEqual(["Write-Output done"]);
  controller.cancel();
  await controller.waitForQuiescence();
});
