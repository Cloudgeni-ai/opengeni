import { expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ChannelASession } from "../src/sandbox/channel-a";
import {
  executeSynchronousCommand,
  observeSynchronousCommand,
  synchronousCommandPage,
  SynchronousCommandOutcomeUnknownError,
} from "../src/sandbox/synchronous-command";
import {
  cancellableSynchronousShellCommand,
  createTurnToolCancellationController,
} from "../src/sandbox/turn-tool-cancellation";
import { mcpToolErrorOutput } from "../src/index";
import {
  synchronousNativeOutputFixture,
  synchronousOutputFixture,
} from "./synchronous-output-fixture";

function running(handle: number, output = ""): string {
  return `Process running with session ID ${handle}\n\nOutput:\n${output}`;
}
function exited(code: number, output = ""): string {
  return `Process exited with code ${code}\n\nOutput:\n${output}`;
}

test("native terminal execution keeps the original arguments and separate streams", async () => {
  const args = { cmd: "native read", maxOutputTokens: 10 };
  let calls = 0;
  const result = await executeSynchronousCommand(
    {
      exec: async (received) => {
        expect(received).toBe(args);
        expect(received.tty).toBeUndefined();
        calls++;
        return { stdout: "data", stderr: "diagnostic", exitCode: 0 };
      },
      writeStdin: async () => {
        throw new Error("terminal commands do not need polling");
      },
    },
    args,
  );
  expect(result).toMatchObject({ stdout: "data", stderr: "diagnostic", exitCode: 0 });
  expect(calls).toBe(1);
});

test("collects all pages of the same command, including split markers and eventual nonzero", async () => {
  let starts = 0;
  let reads = 0;
  const pages = ["_BATCH_OK__", " €", " tail"];
  const output = synchronousOutputFixture();
  const result = await executeSynchronousCommand(
    {
      getProviderCommandOutput: output.getProviderCommandOutput,
      execCommand: async () => {
        starts++;
        return output.record(running(42, "__OPENGENI_FS"), "__OPENGENI_FS");
      },
      writeStdin: async (args) => {
        expect(args.sessionId).toBe(42);
        expect(args.chars).toBe("");
        const text = pages[reads++]!;
        return output.record(
          reads === 3 ? exited(7, text) : running(42, text),
          text,
          "",
          reads === 3 ? 7 : null,
        );
      },
    },
    { cmd: "write once" },
  );
  expect(result.stdout).toBe("__OPENGENI_FS_BATCH_OK__ € tail");
  expect(result.exitCode).toBe(7);
  expect(starts).toBe(1);
  expect(reads).toBe(3);
});

test("exit before EOF is not terminal and stream pages are not a banner's truncated tail", async () => {
  const command: ModalRouterProviderCommand = {
    kind: "modal-router-v1",
    sandboxId: "sb-test",
    taskId: "task-test",
    execId: crypto.randomUUID(),
    streams: {
      stdout: { byteOffset: 20, utf8Remainder: "", eof: false, exitCode: 0 },
      stderr: { byteOffset: 10, utf8Remainder: "", eof: true, exitCode: 0 },
    },
  };
  const session: ChannelASession = {
    getProviderCommandOutput: () => ({
      command,
      exitCode: 0,
      chunks: [
        { stream: "stdout", chunkId: "stdout", text: "complete prefix" },
        { stream: "stderr", chunkId: "stderr", text: "warning" },
      ],
    }),
  };
  const initial = synchronousCommandPage(session, running(43, "truncated tail"));
  expect(initial.exitCode).toBeNull();
  let reads = 0;
  const result = await observeSynchronousCommand(initial, async (handle) => {
    expect(handle).toBe(43);
    reads++;
    command.streams.stdout.eof = true;
    return { ...synchronousCommandPage(session, exited(0)), stdout: " suffix", stderr: "" };
  });
  expect(result).toMatchObject({
    stdout: "complete prefix suffix",
    stderr: "warning",
    exitCode: 0,
  });
  expect(reads).toBe(1);
});

test("unknown observation preserves locator/output and never starts again or advises a retry", async () => {
  let starts = 0;
  const output = synchronousOutputFixture();
  const error = await executeSynchronousCommand(
    {
      getProviderCommandOutput: output.getProviderCommandOutput,
      execCommand: async () => {
        starts++;
        return output.record(running(44, "already written"), "already written");
      },
      writeStdin: async () => {
        throw new Error("read transport unavailable");
      },
    },
    { cmd: "mutation" },
  ).catch((caught) => caught);
  expect(error).toBeInstanceOf(SynchronousCommandOutcomeUnknownError);
  expect(error).toMatchObject({ sessionId: 44, output: { stdout: "already written", stderr: "" } });
  expect(starts).toBe(1);
  const rendered = mcpToolErrorOutput(error).content[0].text;
  expect(rendered).toContain("pending or unknown");
  expect(rendered).not.toMatch(/try again|retry|already written/i);
});

test("missing or changed observation handles never license fallback execution", async () => {
  const output = synchronousOutputFixture();
  await expect(
    executeSynchronousCommand({ exec: async () => ({ exitCode: null }) }, { cmd: "work" }),
  ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown", sessionId: null });
  await expect(
    executeSynchronousCommand(
      {
        getProviderCommandOutput: output.getProviderCommandOutput,
        execCommand: async () => output.record(running(45), ""),
        writeStdin: async () =>
          output.record(running(46, "different process"), "different process"),
      },
      { cmd: "work" },
    ),
  ).rejects.toMatchObject({ sessionId: 45, output: { stdout: "", stderr: "" } });
});

test("trusted pages preserve exact CRLF bytes and legacy handle loss is not successful exit zero", async () => {
  const output = synchronousOutputFixture();
  const result = await executeSynchronousCommand(
    {
      getProviderCommandOutput: output.getProviderCommandOutput,
      execCommand: async () =>
        output.record("Process exited with code 0\r\n\r\nOutput:\r\nbody\r\n", "body\r\n", "", 0),
    },
    { cmd: "read" },
  );
  expect(result.stdout).toBe("body\r\n");
  output.reset();
  await expect(
    executeSynchronousCommand(
      {
        getProviderCommandOutput: output.getProviderCommandOutput,
        execCommand: async () =>
          output.record(running(49, "__OPENGENI_FS_BATCH_OK__"), "__OPENGENI_FS_BATCH_OK__"),
        writeStdin: async () => exited(0, "write_stdin failed: session not found: 49"),
      },
      { cmd: "write" },
    ),
  ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown", sessionId: 49 });
});

test("a competing collector's cursor advance cannot authorize a result with missing bytes", async () => {
  await expect(
    observeSynchronousCommand(
      {
        stdout: "prefix",
        stderr: "",
        sessionId: 51,
        exitCode: null,
        wallTimeSeconds: 0,
        outputCursor: {
          identity: "exact command",
          expected: { stdout: 0, stderr: 0 },
          next: { stdout: 6, stderr: 0 },
        },
      },
      async () => ({
        stdout: "tail",
        stderr: "",
        exitCode: 0,
        wallTimeSeconds: 0,
        outputCursor: {
          identity: "exact command",
          expected: { stdout: 20, stderr: 0 },
          next: { stdout: 24, stderr: 0 },
        },
      }),
    ),
  ).rejects.toMatchObject({
    sessionId: 51,
    output: { stdout: "prefix", stderr: "" },
    code: "synchronous_command_outcome_unknown",
  });
});

test("worker synchronous runner is non-PTY and collects protocol output without tail truncation", async () => {
  const controller = createTurnToolCancellationController();
  const output = synchronousNativeOutputFixture();
  const prefix = "p".repeat(20_000);
  const userCommand = "filesystem protocol";
  let starts = 0;
  let reads = 0;
  const result = await controller.runSandboxCommandSynchronous(
    {
      getSynchronousCommandOutput: output.getSynchronousCommandOutput,
      execCommand: async (args) => {
        expect(args.tty).toBe(false);
        expect(args.cmd.indexOf(userCommand)).toBe(args.cmd.lastIndexOf(userCommand));
        // The cancellable group leader propagates the original shell's status.
        expect(args.cmd).toContain("__opengeni_status=$?");
        starts++;
        return output.record(
          running(47, "truncated presentation"),
          prefix,
          "warning prefix",
          null,
          47,
        );
      },
      writeStdin: async ({ sessionId, chars }) => {
        expect(sessionId).toBe(47);
        expect(chars).toBe("");
        reads++;
        return output.record(
          exited(9, "combined presentation tail"),
          "__OPENGENI_FS_BATCH_OK__",
          " warning tail",
          9,
        );
      },
    },
    { cmd: userCommand, maxOutputTokens: 1 },
  );
  expect(result.stdout).toBe(`${prefix}__OPENGENI_FS_BATCH_OK__`);
  expect(result.stderr).toBe("warning prefix warning tail");
  expect(result.exitCode).toBe(9);
  expect(starts).toBe(1);
  expect(reads).toBe(1);
  controller.cancel();
  await controller.waitForQuiescence();
});

test("synchronous cancellation wrapper keeps a large command under the single-argument limit", () => {
  const command = "':'\n".repeat(24_000);
  const wrapped = cancellableSynchronousShellCommand(
    command,
    `/tmp/opengeni-turn-shell/test-${crypto.randomUUID()}`,
  );

  expect(Buffer.byteLength(command, "utf8")).toBeLessThan(128 * 1024);
  expect(wrapped.indexOf(command)).toBe(wrapped.lastIndexOf(command));
  expect(Buffer.byteLength(wrapped, "utf8")).toBeLessThan(128 * 1024);
});

test("failed worker observation keeps the physical fence until exact retained settlement", async () => {
  const controller = createTurnToolCancellationController();
  let reaped = false;
  let controls = 0;
  const session: ChannelASession = {
    execCommand: async () => running(48, "batch marker"),
    writeStdin: async () => {
      throw new Error("observation interrupted");
    },
    hasRetainedProcess: () => !reaped,
    reconcileRetainedProcess: async () => reaped,
    cancelSupervisedCommand: async () => {
      controls++;
      return true;
    },
    writeStdinForProcessControl: async () => {
      throw new Error("observation interrupted");
    },
  };
  await expect(
    controller.runSandboxCommandSynchronous(session, { cmd: "write once" }),
  ).rejects.toMatchObject({ sessionId: 48, code: "synchronous_command_outcome_unknown" });
  controller.cancel();
  const drain = controller.waitForQuiescence();
  expect(
    await Promise.race([drain.then(() => "settled"), Bun.sleep(50).then(() => "pending")]),
  ).toBe("pending");
  expect(controls).toBeGreaterThan(0);
  reaped = true;
  expect(
    await Promise.race([drain.then(() => "settled"), Bun.sleep(1_000).then(() => "pending")]),
  ).toBe("settled");
});

test("cancellation interrupts observation but drain still awaits original terminal proof", async () => {
  const controller = createTurnToolCancellationController();
  const output = synchronousNativeOutputFixture();
  let entered!: () => void;
  const observing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const terminalAvailable = new Promise<void>((resolve) => {
    release = resolve;
  });
  let originalSettled = false;
  let cancellationRequested = false;
  const userCommand = "write once";
  const session: ChannelASession = {
    getSynchronousCommandOutput: output.getSynchronousCommandOutput,
    execCommand: async ({ cmd }) => {
      expect(cmd.indexOf(userCommand)).toBe(cmd.lastIndexOf(userCommand));
      return output.record(
        running(50, "truncated presentation"),
        "write markers",
        "warning",
        null,
        50,
      );
    },
    hasRetainedProcess: () => !originalSettled,
    reconcileRetainedProcess: async () => originalSettled,
    cancelSupervisedCommand: async () => {
      cancellationRequested = true;
      return true;
    },
    writeStdinForProcessControl: async ({ signal }) => {
      if (signal) {
        entered();
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
        throw new Error("unreachable");
      }
      await terminalAvailable;
      originalSettled = true;
      return output.record(exited(130), "", "cancelled", 130);
    },
  };
  const run = controller.runSandboxCommandSynchronous(session, { cmd: userCommand });
  const rejection = run.catch((error) => error);
  await observing;
  controller.cancel();
  expect(await rejection).toMatchObject({ name: "TurnSandboxCommandCancelledError" });
  const drain = controller.waitForQuiescence();
  expect(
    await Promise.race([drain.then(() => "settled"), Bun.sleep(50).then(() => "pending")]),
  ).toBe("pending");
  expect(cancellationRequested).toBe(true);
  expect(originalSettled).toBe(false);
  release();
  await drain;
  expect(originalSettled).toBe(true);
});
