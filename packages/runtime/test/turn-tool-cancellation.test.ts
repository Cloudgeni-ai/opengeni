import { afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { shell } from "@openai/agents/sandbox";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cancellableShellCommand,
  createTurnToolCancellationController,
} from "../src/sandbox/turn-tool-cancellation";
import { parseExecResponseBanner } from "../src/sandbox/exec-banner";
import {
  RoutingMutationOutcomeUnknownError,
  RoutingSandboxSession,
} from "../src/sandbox/routing/routing-session";
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
  test.skipIf(Bun.which("setsid") === null)(
    "promotes a provider shell into an isolated process group before user code",
    async () => {
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
    },
  );

  test.skipIf(!existsSync("/proc/self/stat") || Bun.which("setsid") === null)(
    "uses Linux procfs when a minimal sandbox image omits ps",
    async () => {
      const markerPath = `/tmp/opengeni-turn-shell/test-${crypto.randomUUID()}`;
      const command = cancellableShellCommand("printf isolated", markerPath);
      const binDir = mkdtempSync(join(tmpdir(), "opengeni-procless-"));
      try {
        for (const executable of ["mkdir", "rm", "setsid"]) {
          const resolved = Bun.which(executable);
          expect(resolved).not.toBeNull();
          symlinkSync(resolved!, join(binDir, executable));
        }
        const child = Bun.spawn(["/bin/sh", "-c", command], {
          env: { ...process.env, PATH: binDir },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        expect(stdout).toBe("isolated");
        expect(command).toContain("/proc/$__opengeni_lookup_pid/stat");
        expect(existsSync(markerPath)).toBe(false);
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );

  test("preserves explicit non-TTY execution and escalates without injecting Ctrl-C", async () => {
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
    expect(execInput?.tty).toBe(false);
    expect(execInput?.yield_time_ms).toBe(250);
    expect(String(execInput?.cmd)).toContain("sleep 60");
    expect(String(execInput?.cmd)).toContain("/tmp/opengeni-turn-shell/");

    abort.abort(new Error("steered"));
    await controller.waitForQuiescence();

    expect(writes).not.toContain("\u0003");
    expect(signals).toEqual(["TERM", "KILL"]);
    expect(processAlive).toBe(false);
  });

  test("preserves explicit PTY execution and uses Ctrl-C before process-group escalation", async () => {
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
        return exited(0, "4300 4300\n");
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
      return running(8, "started\n");
    });
    const write = functionTool("write_stdin", async (_context, rawInput) => {
      const input = JSON.parse(rawInput) as { chars?: string };
      const chars = input.chars ?? "";
      writes.push(chars);
      if (chars === "\u0003") processAlive = false;
      return processAlive ? running(8) : exited(130);
    });
    const wrapped = controller.wrapTools([exec, write]) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    const output = await wrapped[0]!.invoke(
      runContext,
      JSON.stringify({ cmd: "sleep 60", tty: true, yield_time_ms: 30_000 }),
    );
    expect(output).toContain("Process running with session ID 8");
    expect(execInput?.tty).toBe(true);
    expect(execInput?.yield_time_ms).toBe(250);

    abort.abort(new Error("steered"));
    await controller.waitForQuiescence();

    expect(writes[0]).toBe("\u0003");
    expect(signals).toEqual([]);
    expect(processAlive).toBe(false);
  });

  test("model-facing stdin uses retained-process mutation routing, never control or generic write", async () => {
    const controller = createTurnToolCancellationController();
    let rawWrites = 0;
    const mutations: Array<Record<string, unknown>> = [];
    let controls = 0;
    const exec = functionTool("exec_command", async () => running(31));
    const write = functionTool("write_stdin", async () => {
      rawWrites += 1;
      return exited(0);
    });
    const session = {
      hasRetainedProcess: (sessionId: number) => sessionId === 31,
      writeStdinForProcessMutation: async (args: Record<string, unknown>) => {
        mutations.push(args);
        return exited(0, "done");
      },
      writeStdinForProcessControl: async () => {
        controls += 1;
        return exited(0);
      },
    };
    const [wrappedExec, wrappedWrite] = controller.wrapTools([exec, write], session) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    await wrappedExec!.invoke(runContext, JSON.stringify({ cmd: "sleep 60" }));
    expect(
      await wrappedWrite!.invoke(
        runContext,
        JSON.stringify({
          session_id: 31,
          chars: "hello",
          yield_time_ms: 30_000,
          max_output_tokens: 256,
        }),
      ),
    ).toContain("done");

    expect(mutations).toEqual([
      { sessionId: 31, chars: "hello", yieldTimeMs: 250, maxOutputTokens: 256 },
    ]);
    expect(controls).toBe(0);
    expect(rawWrites).toBe(0);
  });

  test("cancellation uses retained-process control routing without a generic write tool", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let processAlive = true;
    let rawExecs = 0;
    let mutations = 0;
    const controlWrites: Array<Record<string, unknown>> = [];
    const helperCommands: string[] = [];
    const settlementOrder: string[] = [];
    const exec = functionTool("exec_command", async () => {
      rawExecs += 1;
      return running(32);
    });
    const session = {
      hasRetainedProcess: (sessionId: number) => sessionId === 32,
      writeStdinForProcessMutation: async () => {
        mutations += 1;
        return running(32);
      },
      writeStdinForProcessControl: async (args: Record<string, unknown>) => {
        controlWrites.push(args);
        settlementOrder.push("provider-control");
        return processAlive ? running(32) : exited(137);
      },
      execCommandForProcessControl: async (
        sessionId: number,
        args: { cmd: string; yieldTimeMs?: number; maxOutputTokens?: number },
      ) => {
        expect(sessionId).toBe(32);
        expect(args.yieldTimeMs).toBe(1_000);
        expect(args.maxOutputTokens).toBe(128);
        expect("yield_time_ms" in args).toBe(false);
        helperCommands.push(args.cmd);
        if (args.cmd.includes("command cat '/tmp/opengeni-turn-shell/")) {
          return exited(0, "5200 5200\n");
        }
        if (args.cmd.includes("command kill -KILL")) {
          settlementOrder.push("group-kill");
          processAlive = false;
          return exited(0);
        }
        if (args.cmd.includes("command kill -0")) {
          settlementOrder.push(processAlive ? "group-live" : "group-absent");
          return exited(processAlive ? 75 : 0);
        }
        return exited(0);
      },
    };
    const [wrappedExec] = controller.wrapTools([exec], session) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    await wrappedExec!.invoke(runContext, JSON.stringify({ cmd: "sleep 60" }));
    abort.abort(new Error("steered"));
    await controller.waitForQuiescence();

    expect(rawExecs).toBe(1);
    expect(mutations).toBe(0);
    expect(controlWrites.at(-1)).toMatchObject({ sessionId: 32, chars: "" });
    expect(helperCommands.some((command) => command.includes("command cat"))).toBe(true);
    expect(helperCommands.some((command) => command.includes("command kill -TERM"))).toBe(true);
    expect(helperCommands.some((command) => command.includes("command kill -KILL"))).toBe(true);
    expect(
      helperCommands.some((command) => command.includes("/proc/$__opengeni_lookup_pid/cmdline")),
    ).toBe(true);
    expect(
      helperCommands.some((command) => command.includes("/proc/$__opengeni_lookup_pid/stat")),
    ).toBe(true);
    const guardedIdentityProbe = helperCommands.find(
      (command) =>
        command.includes("__opengeni_process_args") && command.includes("command kill -0"),
    );
    expect(guardedIdentityProbe).toContain(
      '__opengeni_args="$(__opengeni_process_args "$__opengeni_pid")" || exit 76',
    );
    expect(guardedIdentityProbe).toContain(
      '__opengeni_live_pgid="$(__opengeni_process_group_id "$__opengeni_pid")" || exit 76',
    );
    const emptyBin = mkdtempSync(join(tmpdir(), "opengeni-inspection-unavailable-"));
    try {
      const inspectionFailure = Bun.spawn(["/bin/sh", "-c", guardedIdentityProbe!], {
        env: { ...process.env, PATH: emptyBin },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [inspectionStderr, inspectionExitCode] = await Promise.all([
        new Response(inspectionFailure.stderr).text(),
        inspectionFailure.exited,
      ]);
      expect(inspectionExitCode, inspectionStderr).toBe(76);
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
    expect(processAlive).toBe(false);
    expect(settlementOrder.lastIndexOf("provider-control")).toBeGreaterThan(
      settlementOrder.indexOf("group-absent"),
    );
  });

  test("registers a durably promoted process even when stale authority rejects the exec output", async () => {
    const controller = createTurnToolCancellationController();
    let processAlive = true;
    let retained = true;
    let providerCalls = 0;
    let controlPolls = 0;
    const exec = functionTool("exec_command", async () => {
      providerCalls += 1;
      throw new RoutingMutationOutcomeUnknownError(
        "execCommand",
        "durable promotion succeeded but output was rejected",
        {
          retainedProcess: {
            id: "77777777-7777-4777-8777-777777777777",
            providerSessionId: 34,
          },
        },
      );
    });
    const session = {
      hasRetainedProcess: (sessionId: number) => sessionId === 34 && retained,
      writeStdinForProcessControl: async () => {
        controlPolls += 1;
        retained = false;
        return exited(143);
      },
      execCommandForProcessControl: async (sessionId: number, args: { cmd: string }) => {
        expect(sessionId).toBe(34);
        if (args.cmd.includes("command cat '/tmp/opengeni-turn-shell/")) {
          return exited(0, "6200 6200\n");
        }
        if (args.cmd.includes("command kill -TERM")) {
          processAlive = false;
          return exited(0);
        }
        if (args.cmd.includes("command kill -0")) return exited(processAlive ? 75 : 0);
        return exited(0);
      },
    };
    const [wrappedExec] = controller.wrapTools([exec], session) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    await expect(
      wrappedExec!.invoke(runContext, JSON.stringify({ cmd: "sleep 60" })),
    ).rejects.toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    controller.cancel(new Error("turn finalized"));
    await controller.waitForQuiescence();

    expect(providerCalls).toBe(1);
    expect(controlPolls).toBe(1);
    expect(retained).toBe(false);
  });

  test("retries ambiguous process promotion on the exact route before finalization drains it", async () => {
    const controller = createTurnToolCancellationController();
    let providerCalls = 0;
    let promotions = 0;
    let controlPolls = 0;
    let processAlive = true;
    const retainedIds: string[] = [];
    const backend = {
      supportsPty: () => true,
      execCommand: async (args: unknown) => {
        const cmd =
          args && typeof args === "object" && typeof (args as { cmd?: unknown }).cmd === "string"
            ? ((args as { cmd: string }).cmd ?? "")
            : "";
        if (cmd.includes("command cat '/tmp/opengeni-turn-shell/")) {
          return exited(0, "6200 6200\n");
        }
        if (cmd.includes("command kill -TERM")) {
          processAlive = false;
          return exited(0);
        }
        if (cmd.includes("command kill -0")) {
          return exited(processAlive ? 75 : 0);
        }
        providerCalls += 1;
        return running(34, "started");
      },
      writeStdin: async () => {
        controlPolls += 1;
        processAlive = false;
        return exited(143);
      },
    };
    const session = new RoutingSandboxSession({
      defaultResolved: {
        session: backend,
        sandboxId: null,
        kind: "modal",
        activeEpoch: 0,
      },
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({
        session: backend,
        sandboxId: null,
        kind: "modal",
      }),
      beforeMutation: async () => "parent",
      afterMutation: async ({ retainedProcess }) => {
        promotions += 1;
        retainedIds.push(retainedProcess!.id);
        if (promotions === 1) throw new Error("promotion transaction lost");
      },
    });
    const exec = functionTool("exec_command", async (_runContext, input) => {
      return await session.execCommand(JSON.parse(input) as Record<string, unknown>);
    });
    const [wrappedExec] = controller.wrapTools([exec], session) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    const error = await wrappedExec!
      .invoke(runContext, JSON.stringify({ cmd: "sleep 60" }))
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    expect((error as RoutingMutationOutcomeUnknownError).retainedProcess).toEqual({
      id: expect.any(String),
      providerSessionId: 34,
    });

    controller.cancel(new Error("turn finalized"));
    await controller.waitForQuiescence();

    expect(providerCalls).toBe(1);
    expect(promotions).toBe(2);
    expect(new Set(retainedIds).size).toBe(1);
    expect(controlPolls).toBe(1);
    expect(session.hasRetainedProcess(34)).toBe(false);
  });

  test("lifecycle command finalization drains an exact process whose promotion was ambiguous", async () => {
    const controller = createTurnToolCancellationController();
    let providerMutationCalls = 0;
    let promotions = 0;
    let controlPolls = 0;
    const retainedIds: string[] = [];
    const backend = {
      supportsPty: () => true,
      execCommand: async (args: unknown) => {
        const cmd =
          args && typeof args === "object" && typeof (args as { cmd?: unknown }).cmd === "string"
            ? ((args as { cmd: string }).cmd ?? "")
            : "";
        if (!cmd.includes("sleep 60")) return exited(0, "6200 6200\n");
        providerMutationCalls += 1;
        return running(35, "started");
      },
      writeStdin: async () => {
        controlPolls += 1;
        return exited(143);
      },
    };
    const session = new RoutingSandboxSession({
      defaultResolved: {
        session: backend,
        sandboxId: null,
        kind: "modal",
        activeEpoch: 0,
      },
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({
        session: backend,
        sandboxId: null,
        kind: "modal",
      }),
      beforeMutation: async () => "parent",
      afterMutation: async ({ retainedProcess }) => {
        promotions += 1;
        retainedIds.push(retainedProcess!.id);
        if (promotions === 1) throw new Error("promotion transaction lost");
      },
    });

    const error = await controller
      .runSandboxCommandStructured(session, { cmd: "sleep 60", yieldTimeMs: 100 })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    expect((error as RoutingMutationOutcomeUnknownError).retainedProcess).toEqual({
      id: expect.any(String),
      providerSessionId: 35,
    });

    controller.cancel(new Error("lifecycle request finalized"));
    await controller.waitForQuiescence();

    expect(providerMutationCalls).toBe(1);
    expect(promotions).toBe(2);
    expect(new Set(retainedIds).size).toBe(1);
    expect(controlPolls).toBe(1);
    expect(session.hasRetainedProcess(35)).toBe(false);
  });

  test("retained-process terminal settlement failure keeps the cancellation fence closed", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let rawWrites = 0;
    let allowSettlement = false;
    let controlAttempts = 0;
    const write = functionTool("write_stdin", async () => {
      rawWrites += 1;
      return running(33);
    });
    const session = {
      hasRetainedProcess: (sessionId: number) => sessionId === 33,
      writeStdinForProcessMutation: async () => running(33),
      writeStdinForProcessControl: async () => {
        controlAttempts += 1;
        if (!allowSettlement) throw new Error("durable settlement unavailable");
        return "write_stdin failed: session not found: 33";
      },
    };
    const [wrappedWrite] = controller.wrapTools([write], session) as Array<
      Extract<Tool<unknown>, { type: "function" }>
    >;

    await wrappedWrite!.invoke(runContext, JSON.stringify({ session_id: 33, chars: "input" }));
    abort.abort(new Error("steered"));
    const quiescence = controller.waitForQuiescence();
    await Bun.sleep(125);
    expect(await pendingAfterMicrotasks(quiescence)).toBe(true);

    allowSettlement = true;
    await quiescence;
    expect(controlAttempts).toBeGreaterThanOrEqual(2);
    expect(rawWrites).toBe(0);
  });

  test("abort cancels an exec invocation that has not yielded its provider session yet", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let rejectExec!: (error: Error) => void;
    let execStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      execStarted = resolve;
    });
    const delayedOutput = new Promise<string>((_resolve, reject) => {
      rejectExec = reject;
    });
    let firstExec = true;
    const cancellationCommands: string[] = [];
    const exec = functionTool("exec_command", async (_context, rawInput) => {
      const cmd = String((JSON.parse(rawInput) as { cmd?: unknown }).cmd);
      if (firstExec) {
        firstExec = false;
        execStarted();
        return await delayedOutput;
      }
      cancellationCommands.push(cmd);
      return exited(0);
    });
    const write = functionTool("write_stdin", async () => exited(130));
    let providerCancellations = 0;
    const wrapped = controller.wrapTools([exec, write], {
      supportsPty: () => true,
      cancelPendingExecCommand: async () => {
        providerCancellations += 1;
        rejectExec(new Error("Modal command-router transport closed"));
      },
    }) as Array<Extract<Tool<unknown>, { type: "function" }>>;

    const invocation = wrapped[0]!
      .invoke(runContext, JSON.stringify({ cmd: "sleep 60" }))
      .catch((error) => error);
    await started;
    abort.abort(new Error("steered"));
    await controller.waitForQuiescence();

    expect(await invocation).toBeInstanceOf(Error);
    expect(providerCancellations).toBe(1);
    expect(cancellationCommands).toHaveLength(1);
    expect(cancellationCommands[0]).toContain(".cancelled");
    expect(cancellationCommands[0]).toContain("command kill -TERM");
    expect(cancellationCommands[0]).toContain("command kill -KILL");
  });

  test("abort also cancels a cleanup exec that stalls before provider yield", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let rejectOriginal!: (error: Error) => void;
    let rejectCleanup!: (error: Error) => void;
    let execStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      execStarted = resolve;
    });
    const original = new Promise<string>((_resolve, reject) => {
      rejectOriginal = reject;
    });
    const cleanup = new Promise<string>((_resolve, reject) => {
      rejectCleanup = reject;
    });
    let releaseCleanupCancellation!: () => void;
    const cleanupCancellation = new Promise<void>((resolve) => {
      releaseCleanupCancellation = resolve;
    });
    let markCleanupCancellationStarted!: () => void;
    const cleanupCancellationStarted = new Promise<void>((resolve) => {
      markCleanupCancellationStarted = resolve;
    });
    const cancellationCommands: string[] = [];
    let execCalls = 0;
    const exec = functionTool("exec_command", async (_context, rawInput) => {
      execCalls += 1;
      const cmd = String((JSON.parse(rawInput) as { cmd?: unknown }).cmd);
      if (execCalls === 1) {
        execStarted();
        return await original;
      }
      cancellationCommands.push(cmd);
      if (execCalls === 2) return await cleanup;
      return exited(0);
    });
    const write = functionTool("write_stdin", async () => exited(130));
    let providerCancellations = 0;
    const wrapped = controller.wrapTools([exec, write], {
      supportsPty: () => true,
      cancelPendingExecCommand: async () => {
        providerCancellations += 1;
        if (providerCancellations === 1) {
          rejectOriginal(new Error("original Modal command-router transport closed"));
        } else if (providerCancellations === 2) {
          rejectCleanup(new Error("cleanup Modal command-router transport closed"));
          markCleanupCancellationStarted();
          await cleanupCancellation;
        }
      },
    }) as Array<Extract<Tool<unknown>, { type: "function" }>>;

    const invocation = wrapped[0]!
      .invoke(runContext, JSON.stringify({ cmd: "sleep 60" }))
      .catch((error) => error);
    await started;
    abort.abort(new Error("steered"));
    const quiescence = controller.waitForQuiescence();
    await cleanupCancellationStarted;
    expect(await pendingAfterMicrotasks(quiescence)).toBe(true);
    releaseCleanupCancellation();
    await quiescence;

    expect(await invocation).toBeInstanceOf(Error);
    expect(providerCancellations).toBe(2);
    expect(cancellationCommands).toHaveLength(2);
    expect(cancellationCommands[0]).toContain(".cancelled");
    expect(cancellationCommands[1]).toContain(".cancelled");
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
        if (input.cmd.includes("command : >")) {
          signals.push("TERM", "KILL");
          processAlive = false;
          return { exitCode: 0, output: "" };
        }
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

  test("preserves explicit non-TTY lifecycle commands and cancels them without Ctrl-C", async () => {
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    let processAlive = true;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const signals: string[] = [];
    const writes: string[] = [];
    const session = {
      supportsPty: () => true,
      exec: async (input: { cmd: string; tty?: boolean; yieldTimeMs?: number }) => {
        if (input.cmd.includes("command : >")) {
          signals.push("TERM", "KILL");
          processAlive = false;
          return { exitCode: 0, output: "" };
        }
        if (input.cmd.includes("command cat '/tmp/opengeni-turn-shell/")) {
          return { exitCode: 0, output: "4500 4500\n" };
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
        expect(input.tty).toBe(false);
        expect(input.yieldTimeMs).toBe(250);
        markStarted();
        return { sessionId: 13, output: "started\n" };
      },
      writeStdin: async ({ chars }: { chars?: string }) => {
        writes.push(chars ?? "");
        return processAlive ? running(13) : exited(137);
      },
    };

    const command = controller.runSandboxCommand(session, {
      cmd: "trap '' INT TERM; sleep 60",
      tty: false,
      yieldTimeMs: 120_000,
    });
    await started;
    abort.abort(new Error("steered during non-TTY setup"));
    await expect(command).rejects.toThrow("steered during non-TTY setup");
    await controller.waitForQuiescence();

    expect(writes).not.toContain("\u0003");
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

  test.skipIf(process.platform !== "linux" || Bun.which("git") === null)(
    "explicit non-TTY execution exposes pipe descriptors and bypasses the Git pager",
    async () => {
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
      const repoPath = `${session.state.workspaceRootPath}/non-tty-repo-${crypto.randomUUID()}`;
      const pagerMarker = `${session.state.workspaceRootPath}/pager-${crypto.randomUUID()}`;
      const controller = createTurnToolCancellationController();
      const capability = shell({ configureTools: (tools) => controller.wrapTools(tools) });
      const tools = capability
        .clone()
        .bind(session as never)
        .tools();
      const exec = tools.find(
        (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
          tool.type === "function" && tool.name === "exec_command",
      );
      const write = tools.find(
        (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
          tool.type === "function" && tool.name === "write_stdin",
      );
      expect(exec).toBeDefined();
      expect(write).toBeDefined();

      let current = await exec!.invoke(
        runContext,
        JSON.stringify({
          tty: false,
          cmd: [
            "set -eu",
            `rm -rf '${repoPath}' '${pagerMarker}'`,
            `mkdir -p '${repoPath}'`,
            `git -C '${repoPath}' init -q`,
            `git -C '${repoPath}' config user.name OpenGeni`,
            `git -C '${repoPath}' config user.email opengeni@example.invalid`,
            `printf first > '${repoPath}/file.txt'`,
            `git -C '${repoPath}' add file.txt`,
            `git -C '${repoPath}' commit -qm first`,
            'printf "stdin=%s stdout=%s stderr=%s\\n" "$([ -t 0 ] && echo tty || echo pipe)" "$([ -t 1 ] && echo tty || echo pipe)" "$([ -t 2 ] && echo tty || echo pipe)"',
            `GIT_PAGER="tee '${pagerMarker}'" git -C '${repoPath}' log --oneline`,
            `test ! -e '${pagerMarker}'`,
            "printf 'pager=not-invoked\\n'",
          ].join("\n"),
        }),
      );
      let output = current;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const banner = parseExecResponseBanner(current);
        if (banner.kind !== "running") break;
        current = await write!.invoke(
          runContext,
          JSON.stringify({
            session_id: banner.sessionId,
            chars: "",
            yield_time_ms: 250,
            max_output_tokens: 4_096,
          }),
        );
        output += `\n${current}`;
      }

      expect(parseExecResponseBanner(current)).toEqual({ kind: "exited", exitCode: 0 });
      expect(output).toContain("stdin=pipe stdout=pipe stderr=pipe");
      expect(output).toContain("pager=not-invoked");
      expect(existsSync(pagerMarker)).toBe(false);
    },
  );

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
