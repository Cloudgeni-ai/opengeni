import { afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { shell } from "@openai/agents/sandbox";
import { existsSync } from "node:fs";

import {
  cancellableShellCommand,
  createTurnToolCancellationController,
} from "../src/sandbox/turn-tool-cancellation";
import { createSandboxClientForBackend } from "../src/index";
import { testSettings } from "@opengeni/testing";

const runContext = {} as never;

function running(sessionId: number, output = ""): string {
  return [
    "Chunk ID: abc123",
    "Wall time: 0.2500 seconds",
    `Process running with session ID ${sessionId}`,
    "Output:",
    output,
  ].join("\n");
}

function exited(exitCode: number, output = ""): string {
  return [
    "Chunk ID: abc123",
    "Wall time: 0.0100 seconds",
    `Process exited with code ${exitCode}`,
    "Output:",
    output,
  ].join("\n");
}

function functionTool(
  name: string,
  invoke: Extract<Tool<unknown>, { type: "function" }>["invoke"],
): Extract<Tool<unknown>, { type: "function" }> {
  return {
    type: "function",
    name,
    description: name,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: true },
    strict: false,
    needsApproval: async () => false,
    invoke,
  };
}

async function pendingAfterMicrotasks(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return !settled;
}

describe("turn sandbox-tool physical cancellation fence", () => {
  test("promotes a provider shell into an isolated process group before user code", async () => {
    const markerPath = `/tmp/opengeni-turn-shell/test-${crypto.randomUUID()}`;
    const command = cancellableShellCommand(
      'test "$$" = "$(ps -o pgid= -p "$$" | tr -d \'[:space:]\')" && printf isolated',
      markerPath,
    );
    const process = Bun.spawn(["/bin/sh", "-c", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toBe("isolated");
    expect(existsSync(markerPath)).toBe(false);
  });

  test("forces a short PTY yield and escalates ignored Ctrl-C/TERM to a confirmed group KILL", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let processAlive = true;
    let execInput: Record<string, unknown> | null = null;
    const signals: string[] = [];
    const writes: string[] = [];

    const exec = functionTool("exec_command", async (_context, rawInput) => {
      const input = JSON.parse(rawInput) as Record<string, unknown>;
      const cmd = String(input.cmd);
      if (cmd.includes("command cat '/tmp/opengeni-turn-shell/")) {
        return exited(0, "4200 4200\n");
      }
      if (cmd.includes("command kill -TERM")) {
        signals.push("TERM");
        return exited(0);
      }
      if (cmd.includes("command kill -KILL")) {
        signals.push("KILL");
        processAlive = false;
        return exited(0);
      }
      if (cmd.includes("command kill -0")) {
        return exited(processAlive ? 75 : 0);
      }
      execInput = input;
      return running(7, "started\n");
    });
    const write = functionTool("write_stdin", async (_context, rawInput) => {
      const input = JSON.parse(rawInput) as { chars?: string };
      writes.push(input.chars ?? "");
      return processAlive ? running(7) : exited(137);
    });
    const wrapped = controller.wrapTools([exec, write]) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    const output = await wrapped[0]!.invoke(
      runContext,
      JSON.stringify({ cmd: "sleep 60", tty: false, yield_time_ms: 30_000 }),
    );
    expect(output).toContain("Process running with session ID 7");
    expect(execInput?.tty).toBe(true);
    expect(execInput?.yield_time_ms).toBe(250);
    expect(String(execInput?.cmd)).toContain("sleep 60");
    expect(String(execInput?.cmd)).toContain("/tmp/opengeni-turn-shell/");

    abort.abort(new Error("steered"));
    await controller.waitForQuiescence();

    expect(writes[0]).toBe("\u0003");
    expect(signals).toEqual(["TERM", "KILL"]);
    expect(processAlive).toBe(false);
  });

  test("abort waits for an exec invocation that has not yielded its provider session yet", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let releaseExec!: (output: string) => void;
    let execStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      execStarted = resolve;
    });
    const delayedOutput = new Promise<string>((resolve) => {
      releaseExec = resolve;
    });
    let firstExec = true;
    const exec = functionTool("exec_command", async (_context, rawInput) => {
      const cmd = String((JSON.parse(rawInput) as { cmd?: unknown }).cmd);
      if (firstExec) {
        firstExec = false;
        execStarted();
        return await delayedOutput;
      }
      if (cmd.includes("command cat '/tmp/opengeni-turn-shell/")) {
        return exited(0, "4300 4300\n");
      }
      if (cmd.includes("command kill -0")) return exited(0);
      return exited(0);
    });
    const write = functionTool("write_stdin", async () => exited(130));
    const wrapped = controller.wrapTools([exec, write]) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    const invocation = wrapped[0]!.invoke(runContext, JSON.stringify({ cmd: "sleep 60" }));
    await started;
    abort.abort(new Error("steered"));
    const quiescence = controller.waitForQuiescence();
    expect(await pendingAfterMicrotasks(quiescence)).toBe(true);

    releaseExec(running(9));
    await invocation;
    await quiescence;
  });

  test("matching lost-session banners unregister ordinary and cancellation-finalizer PTYs", async () => {
    const ordinaryController = createTurnToolCancellationController();
    let ordinaryWrites = 0;
    const ordinaryExec = functionTool("exec_command", async () => running(17));
    const ordinaryWrite = functionTool("write_stdin", async () => {
      ordinaryWrites += 1;
      return "write_stdin failed: session not found: 17";
    });
    const ordinaryTools = ordinaryController.wrapTools([ordinaryExec, ordinaryWrite]) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;
    await ordinaryTools[0]!.invoke(runContext, JSON.stringify({ cmd: "sleep 60" }));
    await ordinaryTools[1]!.invoke(runContext, JSON.stringify({ session_id: 17, chars: "" }));
    ordinaryController.cancel(new Error("steered"));
    await ordinaryController.waitForQuiescence();
    expect(ordinaryWrites).toBe(1);

    const finalizerAbort = new AbortController();
    const finalizerController = createTurnToolCancellationController(finalizerAbort.signal);
    let finalizerWrites = 0;
    const finalizerExec = functionTool("exec_command", async (_context, rawInput) => {
      const cmd = String((JSON.parse(rawInput) as { cmd?: unknown }).cmd);
      if (cmd.includes("command cat '/tmp/opengeni-turn-shell/")) return exited(0);
      return running(18);
    });
    const finalizerWrite = functionTool("write_stdin", async () => {
      finalizerWrites += 1;
      return "write_stdin failed: session not found: 18";
    });
    const [wrappedFinalizerExec] = finalizerController.wrapTools([
      finalizerExec,
      finalizerWrite,
    ]) as Array<Extract<Tool<unknown>, { type: "function" }>>;
    await wrappedFinalizerExec!.invoke(runContext, JSON.stringify({ cmd: "sleep 60" }));
    finalizerAbort.abort(new Error("steered"));
    await finalizerController.waitForQuiescence();
    expect(finalizerWrites).toBe(1);
  });

  test("ID-less, malformed, mismatched, and ambiguous writes cannot open either PTY fence", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let response: "idless" | "malformed" | "mismatched" | "ambiguous" | "matching" = "idless";
    let writes = 0;
    const exec = functionTool("exec_command", async (_context, rawInput) => {
      const cmd = String((JSON.parse(rawInput) as { cmd?: unknown }).cmd);
      if (cmd.includes("command cat '/tmp/opengeni-turn-shell/")) return exited(0);
      return running(19);
    });
    const write = functionTool("write_stdin", async () => {
      writes += 1;
      if (response === "idless") return "write_stdin failed: session not found";
      if (response === "malformed") return "write_stdin failed: session not found: unknown";
      if (response === "mismatched") return "write_stdin failed: session not found: 91";
      if (response === "ambiguous") throw new Error("provider temporarily unavailable");
      return "write_stdin failed: session not found: 19";
    });
    const [wrappedExec, wrappedWrite] = controller.wrapTools([exec, write]) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;
    await wrappedExec!.invoke(runContext, JSON.stringify({ cmd: "sleep 60" }));
    expect(
      await wrappedWrite!.invoke(runContext, JSON.stringify({ session_id: 19, chars: "" })),
    ).toBe("write_stdin failed: session not found");
    // The ordinary model-facing write must retain the tracker on an ID-less
    // response. Cancellation's rawWrite sees the same response and must also
    // keep the physical fence closed.
    abort.abort(new Error("steered"));
    const quiescence = controller.waitForQuiescence();
    await Bun.sleep(125);
    expect(await pendingAfterMicrotasks(quiescence)).toBe(true);
    response = "malformed";
    await Bun.sleep(125);
    expect(await pendingAfterMicrotasks(quiescence)).toBe(true);
    response = "mismatched";
    await Bun.sleep(125);
    expect(await pendingAfterMicrotasks(quiescence)).toBe(true);
    response = "ambiguous";
    await Bun.sleep(125);
    expect(await pendingAfterMicrotasks(quiescence)).toBe(true);
    response = "matching";
    await quiescence;
    expect(writes).toBeGreaterThanOrEqual(5);
  });

  test("cancels a connected-machine op by its durable tool-call id before waiting for output", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let finishExec!: (output: string) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const output = new Promise<string>((resolve) => {
      finishExec = resolve;
    });
    const cancelledOpIds: string[] = [];
    const session = {
      supportsPty: () => false,
      cancelExecCommand: async (opId: string) => {
        cancelledOpIds.push(opId);
        finishExec("cancelled");
        return true;
      },
    };
    const exec = functionTool("exec_command", async () => {
      markStarted();
      return await output;
    });
    const [wrapped] = controller.wrapTools([exec], session) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    const invocation = wrapped!.invoke(runContext, JSON.stringify({ cmd: "sleep 60" }), {
      toolCall: {
        type: "function_call",
        callId: "call.machine/1",
        name: "exec_command",
        arguments: "{}",
      },
    });
    await started;
    abort.abort(new Error("steered"));
    await controller.waitForQuiescence();
    await invocation;

    expect(cancelledOpIds).toEqual(["call_2e_machine_2f_1:0"]);
  });

  test("drains a parallel capability operation and rejects any operation admitted after cancellation", async () => {
    const controller = createTurnToolCancellationController();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mutate = functionTool("mutate_workspace", async () => {
      await held;
      return "done";
    });
    const [wrapped] = controller.wrapTools([mutate]) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    const first = wrapped!.invoke(runContext, "{}");
    await Promise.resolve();
    controller.cancel(new Error("steered"));
    const quiescence = controller.waitForQuiescence();
    expect(await pendingAfterMicrotasks(quiescence)).toBe(true);
    await expect(wrapped!.invoke(runContext, "{}")).rejects.toThrow("steered");

    finish();
    await first;
    await quiescence;
  });

  test("cancels a lifecycle/setup command through the same physical process fence", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let processAlive = true;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const signals: string[] = [];
    const session = {
      supportsPty: () => true,
      exec: async (input: { cmd: string; tty?: boolean; yieldTimeMs?: number }) => {
        if (input.cmd.includes("command cat '/tmp/opengeni-turn-shell/")) {
          return { exitCode: 0, output: "4400 4400\n" };
        }
        if (input.cmd.includes("command kill -TERM")) {
          signals.push("TERM");
          return { exitCode: 0, output: "" };
        }
        if (input.cmd.includes("command kill -KILL")) {
          signals.push("KILL");
          processAlive = false;
          return { exitCode: 0, output: "" };
        }
        if (input.cmd.includes("command kill -0")) {
          return { exitCode: processAlive ? 75 : 0, output: "" };
        }
        expect(input.tty).toBe(true);
        expect(input.yieldTimeMs).toBe(250);
        markStarted();
        return { sessionId: 12, output: "started\n" };
      },
      writeStdin: async ({ chars }: { chars?: string }) => {
        if (chars === "\u0003") return running(12);
        return processAlive ? running(12) : exited(137);
      },
    };

    const command = controller.runSandboxCommand(session, {
      cmd: "trap '' INT TERM; sleep 60",
      yieldTimeMs: 120_000,
    });
    await started;
    abort.abort(new Error("steered during setup"));
    await expect(command).rejects.toThrow("steered during setup");
    await controller.waitForQuiescence();

    expect(signals).toEqual(["TERM", "KILL"]);
    expect(processAlive).toBe(false);
  });

  test("cancels a connected-machine lifecycle command by a durable op id", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let finish!: (result: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const result = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const cancelledOpIds: string[] = [];
    const session = {
      supportsPty: () => false,
      exec: async () => {
        markStarted();
        return await result;
      },
      cancelExecCommand: async (opId: string) => {
        cancelledOpIds.push(opId);
        finish({ exitCode: 130, output: "cancelled" });
        return true;
      },
    };

    const command = controller.runSandboxCommand(session, { cmd: "sleep 60" });
    await started;
    abort.abort(new Error("steered during setup"));
    await controller.waitForQuiescence();
    await command;

    expect(cancelledOpIds).toHaveLength(1);
    expect(cancelledOpIds[0]).toMatch(/^turn_lifecycle_[a-zA-Z0-9_-]+:0$/);
  });

  test("drains the hosted apply_patch editor path before opening the fence", async () => {
    const controller = createTurnToolCancellationController();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const applyPatch = {
      type: "apply_patch" as const,
      name: "apply_patch",
      needsApproval: async () => false,
      editor: {
        createFile: async () => undefined,
        updateFile: async () => {
          await held;
        },
        deleteFile: async () => undefined,
      },
    } as Extract<Tool<unknown>, { type: "apply_patch" }>;
    const [wrapped] = controller.wrapTools([applyPatch]) as Array<
      Extract<Tool<unknown>, { type: "apply_patch" }>
    >;

    const operation = wrapped!.editor.updateFile({
      type: "update_file",
      path: "/workspace/file.txt",
      diff: "@@\n-old\n+new",
    });
    await Promise.resolve();
    controller.cancel(new Error("steered"));
    const quiescence = controller.waitForQuiescence();
    expect(await pendingAfterMicrotasks(quiescence)).toBe(true);

    finish();
    await operation;
    await quiescence;
  });
});

describe("turn sandbox-tool cancellation against a real local process", () => {
  const sessions: Array<{ close(): Promise<void> }> = [];
  const originalPython = process.env.OPENAI_AGENTS_PYTHON;

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map(async (session) => await session.close()));
    if (originalPython === undefined) delete process.env.OPENAI_AGENTS_PYTHON;
    else process.env.OPENAI_AGENTS_PYTHON = originalPython;
  });

  test("a signal-ignoring process cannot write after the fence resolves", async () => {
    const python = Bun.which("python3");
    expect(python).not.toBeNull();
    process.env.OPENAI_AGENTS_PYTHON = python!;
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const client = createSandboxClientForBackend("local", settings) as {
      create(manifest?: unknown): Promise<{
        close(): Promise<void>;
        state: { workspaceRootPath: string };
      }>;
    };
    const session = await client.create({});
    sessions.push(session);
    const zombiePath = `${session.state.workspaceRootPath}/steer-zombie-${crypto.randomUUID()}`;
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    const capability = shell({ configureTools: (tools) => controller.wrapTools(tools) });
    const tools = capability
      .clone()
      .bind(session as never)
      .tools();
    const exec = tools.find(
      (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
        tool.type === "function" && tool.name === "exec_command",
    );
    expect(exec).toBeDefined();

    const started = performance.now();
    const output = await exec!.invoke(
      runContext,
      JSON.stringify({
        cmd: `trap '' INT TERM; sleep 3; printf zombie > '${zombiePath}'`,
        yield_time_ms: 10_000,
      }),
    );
    expect(output).toContain("Process running with session ID");

    abort.abort(new Error("steered"));
    await controller.waitForQuiescence();
    expect(performance.now() - started).toBeLessThan(2_000);
    await Bun.sleep(3_250);
    expect(existsSync(zombiePath)).toBe(false);
  });

  test("a signal-ignoring lifecycle command cannot write after the fence resolves", async () => {
    const python = Bun.which("python3");
    expect(python).not.toBeNull();
    process.env.OPENAI_AGENTS_PYTHON = python!;
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const client = createSandboxClientForBackend("local", settings) as {
      create(manifest?: unknown): Promise<{
        close(): Promise<void>;
        state: { workspaceRootPath: string };
      }>;
    };
    const session = await client.create({});
    sessions.push(session);
    const zombiePath = `${session.state.workspaceRootPath}/setup-zombie-${crypto.randomUUID()}`;
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    const started = performance.now();
    const command = controller.runSandboxCommand(session as never, {
      cmd: `trap '' INT TERM; sleep 3; printf zombie > '${zombiePath}'`,
      yieldTimeMs: 120_000,
    });
    await Bun.sleep(350);

    abort.abort(new Error("steered during setup"));
    await expect(command).rejects.toThrow("steered during setup");
    await controller.waitForQuiescence();
    expect(performance.now() - started).toBeLessThan(2_000);
    await Bun.sleep(3_250);
    expect(existsSync(zombiePath)).toBe(false);
  });
});
