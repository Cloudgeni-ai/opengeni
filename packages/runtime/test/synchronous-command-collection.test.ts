import { expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import {
  executeSynchronousCommand,
  observeSynchronousCommand,
  SynchronousCommandOutcomeUnknownError,
} from "../src/sandbox/synchronous-command";

test("an established output cursor cannot disappear on a terminal page", async () => {
  await expect(
    observeSynchronousCommand(
      {
        stdout: "prefix",
        stderr: "",
        sessionId: 1,
        exitCode: null,
        wallTimeSeconds: 0,
        outputCursor: {
          identity: "original command",
          expected: { stdout: 0, stderr: 0 },
          next: { stdout: 6, stderr: 0 },
        },
      },
      async () => ({ stdout: "tail", stderr: "", exitCode: 0, wallTimeSeconds: 0 }),
    ),
  ).rejects.toMatchObject({
    code: "synchronous_command_outcome_unknown",
    sessionId: 1,
    output: { stdout: "prefix", stderr: "" },
  });
});

test("a real local SDK terminal structured result preserves separate streams despite presentation truncation", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const stdout = `prefix${"x".repeat(2_000)}`;
  const stderr = "y".repeat(2_000);
  try {
    const result = await executeSynchronousCommand(session, {
      cmd: `printf %s '${stdout}'; printf %s '${stderr}' >&2; exit 7`,
      yieldTimeMs: 1_000,
      maxOutputTokens: 1,
    });
    expect(result).toMatchObject({ stdout, stderr, exitCode: 7 });
  } finally {
    await session.close();
  }
});

test("a routed local SDK yielded command keeps exact custody without consuming its banner reader", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const backend = { session, sandboxId: null, kind: "local", activeEpoch: 0 };
  let promotions = 0;
  let reads = 0;
  let settlements = 0;
  const write = session.writeStdin.bind(session);
  session.writeStdin = async (args) => {
    reads++;
    return await write(args);
  };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    beforeMutation: async () => "admitted",
    afterMutation: async ({ retainedProcess, retainedProcessPurpose }) => {
      expect(retainedProcess?.providerSessionId).toBe(1);
      expect(retainedProcessPurpose).toBe("synchronous_filesystem");
      promotions++;
    },
    captureProcessOutput: async () => {},
    settleProcess: async () => {
      settlements++;
    },
  });
  try {
    await expect(
      route.execSynchronous({
        cmd: "sleep 0.15; printf late; printf diagnostic >&2",
        yieldTimeMs: 1,
        maxOutputTokens: 1,
      }),
    ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown", sessionId: 1 });
    expect(promotions).toBe(1);
    expect(reads).toBe(0);
    expect(settlements).toBe(0);
    expect(route.hasRetainedProcess(1)).toBe(true);
    const retained = await session.writeStdin({
      sessionId: 1,
      chars: "",
      yieldTimeMs: 1_000,
      maxOutputTokens: 1_000,
    });
    expect(retained).toContain("late");
    expect(retained).toContain("diagnostic");
  } finally {
    await session.close();
  }
});

test("banner-only terminal output cannot masquerade as separated streams through routing", async () => {
  const backend = {
    session: { execCommand: async () => "Process exited with code 0\n\nOutput:\nmerged" },
    sandboxId: null,
    kind: "local",
  };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
  });
  await expect(route.execSynchronous({ cmd: "read" })).rejects.toMatchObject({
    code: "synchronous_command_outcome_unknown",
    output: { stdout: "", stderr: "" },
  });
});

test.each([1, 20_000])(
  "the local SDK yielded reader cannot prove separated complete output at token limit %s",
  async (maxOutputTokens) => {
    const session = await new UnixLocalSandboxClient().create(new Manifest());
    const stdout = `prefix${"x".repeat(2_000)}`;
    const stderr = "y".repeat(2_000);
    const command = `printf prefix; sleep 0.15; printf %s '${"x".repeat(2_000)}'; printf %s '${stderr}' >&2`;
    let starts = 0;
    let reads = 0;
    let originalHandle: number | undefined;
    try {
      const result = await executeSynchronousCommand(
        {
          exec: async (args) => {
            expect(args.cmd).toBe(command);
            expect(args.tty).toBeUndefined();
            starts++;
            const page = await session.exec(args);
            expect(page.stdout).toBe("prefix");
            originalHandle = page.sessionId;
            return page;
          },
          writeStdin: async (args) => {
            reads++;
            expect(args.sessionId).toBe(originalHandle);
            return await session.writeStdin(args);
          },
        },
        { cmd: command, yieldTimeMs: 50, maxOutputTokens },
      ).catch((error: unknown) => error);
      expect(originalHandle).toBeNumber();
      expect(result).toBeInstanceOf(SynchronousCommandOutcomeUnknownError);
      expect(result).toMatchObject({
        sessionId: originalHandle,
        output: { stdout: "prefix", stderr: "" },
      });
      expect(starts).toBe(1);
      // The unsupported collector must not consume or delete this SDK handle.
      expect(reads).toBe(0);
      const retained = await session.writeStdin({
        sessionId: originalHandle!,
        chars: "",
        yieldTimeMs: 1_000,
        maxOutputTokens: 20_000,
      });
      expect(retained).toContain("Process exited with code 0");
      expect(retained).toContain(stdout.slice(6));
      expect(retained).toContain(stderr);
    } finally {
      await session.close();
    }
  },
);

test("the worker fails closed on a real local SDK yielded banner before consuming its reader", async () => {
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const controller = createTurnToolCancellationController();
  const command = `sleep 0.15; printf %s '${"x".repeat(2_000)}'; printf %s '${"y".repeat(2_000)}' >&2`;
  const exec = session.execCommand.bind(session);
  const write = session.writeStdin.bind(session);
  let starts = 0;
  let reads = 0;
  session.execCommand = async (args) => {
    if (args.cmd.includes(command)) {
      expect(args.tty).toBe(false);
      starts++;
    }
    return await exec(args);
  };
  session.writeStdin = async (args) => {
    reads++;
    return await write(args);
  };
  try {
    await expect(
      controller.runSandboxCommandSynchronous(session, {
        cmd: command,
        yieldTimeMs: 1,
        maxOutputTokens: 1,
      }),
    ).rejects.toMatchObject({
      code: "synchronous_command_outcome_unknown",
      sessionId: 1,
      output: { stdout: "", stderr: "" },
    });
    expect(starts).toBe(1);
    expect(reads).toBe(0);
  } finally {
    controller.cancel();
    await controller.waitForQuiescence();
    await session.close();
  }
}, 30_000);
