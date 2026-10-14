import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { shell } from "@openai/agents/sandbox";
import { testSettings } from "@opengeni/testing";

import { createSandboxClientForBackend } from "../src/index";
import { parseExecResponseBanner } from "../src/sandbox/exec-banner";
import {
  createTurnToolCancellationController,
  foregroundWait,
  modelWaitMs,
} from "../src/sandbox/turn-tool-cancellation";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;

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

function functionTool(name: string, invoke: FunctionTool["invoke"]): FunctionTool {
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

/**
 * A retained command scripted against virtual time: every provider read
 * advances the clock by `stepMs` and `script(now)` returns the output produced
 * during that slice and whether the command has exited.
 */
function scriptedCommand(
  script: (now: number) => { output?: string; exitCode?: number },
  stepMs: number,
) {
  let now = 0;
  const base = 1_000_000;
  const clock = spyOn(performance, "now").mockImplementation(() => base + now);
  const state = { reads: 0, adoptions: 0 };
  const session = {
    hasRetainedProcess: () => true,
    canAdoptRetainedProcessAsBackgroundCommand: () => true,
    writeStdinForProcessRead: async () => {
      state.reads += 1;
      now += stepMs;
      const slice = script(now);
      return slice.exitCode !== undefined
        ? exited(slice.exitCode, slice.output ?? "")
        : running(7, slice.output ?? "");
    },
    adoptRetainedProcessAsBackgroundCommand: async () => {
      state.adoptions += 1;
    },
  };
  return { session, state, now: () => now, restore: () => clock.mockRestore() };
}

type Options = { cutPolling?: boolean; pollFloor?: boolean };

function tools(session: object, options: Options, inputs: string[] = []) {
  const controller = createTurnToolCancellationController(undefined, {
    cutPolling: options.cutPolling ?? true,
    pollFloor: options.pollFloor ?? true,
  });
  const [exec, write] = controller.wrapTools(
    [
      functionTool("exec_command", async () => running(7)),
      functionTool("write_stdin", async (_context, input) => {
        inputs.push(String(input));
        return running(7);
      }),
    ],
    session,
  ) as FunctionTool[];
  return { controller, exec: exec!, write: write! };
}

async function runExec(
  session: object,
  args: Record<string, unknown>,
  options: Options = {},
): Promise<string> {
  const { exec } = tools(session, options);
  return String(await exec.invoke(runContext, JSON.stringify(args)));
}

describe("poll floor wait arithmetic", () => {
  test("off: identical to the existing wait for every request", () => {
    for (const cutPolling of [false, true]) {
      for (const value of [undefined, null, -1, 0, 250, 1_000, 10_000, 30_000, 120_000, 900_000]) {
        const expected = cutPolling
          ? { waitMs: modelWaitMs(value, true), quietReturnAfterMs: modelWaitMs(value, false) }
          : { waitMs: modelWaitMs(value, false) };
        expect(foregroundWait(value, cutPolling)).toEqual(expected);
        expect(foregroundWait(value, cutPolling, false)).toEqual(expected);
      }
    }
  });

  test("on: raises short waits to 30 s, keeps long ones, quiet return from the requested window", () => {
    expect(foregroundWait(1_000, true, true)).toEqual({
      waitMs: 30_000,
      quietReturnAfterMs: 1_000,
    });
    expect(foregroundWait(0, true, true)).toEqual({ waitMs: 30_000, quietReturnAfterMs: 0 });
    expect(foregroundWait(undefined, true, true)).toEqual({
      waitMs: 30_000,
      quietReturnAfterMs: 10_000,
    });
    expect(foregroundWait(120_000, true, true)).toEqual({
      waitMs: 120_000,
      quietReturnAfterMs: 30_000,
    });
    // Without cut polling the floor still applies, under the ordinary cap.
    expect(foregroundWait(1_000, false, true)).toEqual({
      waitMs: 30_000,
      quietReturnAfterMs: 1_000,
    });
    expect(foregroundWait(120_000, false, true)).toEqual({
      waitMs: 30_000,
      quietReturnAfterMs: 30_000,
    });
  });
});

describe("poll floor on exec_command and write_stdin", () => {
  test("a non-TTY test run requested with a 1 s yield returns its exit from the same call", async () => {
    const fake = scriptedCommand(
      (now) =>
        now >= 24_000
          ? { output: "40 passed\n", exitCode: 0 }
          : now % 2_000 === 0
            ? { output: `test ${now}\n` }
            : {},
      1_000,
    );
    try {
      const result = await runExec(fake.session, {
        cmd: "pytest -q",
        tty: false,
        yield_time_ms: 1_000,
      });
      expect(result).toContain("Process exited with code 0");
      expect(result).toContain("40 passed");
      expect(fake.now()).toBe(24_000);
      expect(fake.state.adoptions).toBe(0);
    } finally {
      fake.restore();
    }
  });

  test("a silent non-TTY build holds until the 30 s floor", async () => {
    const fake = scriptedCommand(() => ({}), 1_000);
    try {
      const result = await runExec(fake.session, {
        cmd: "cargo build -q",
        tty: false,
        yield_time_ms: 1_000,
      });
      expect(result).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(30_000);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });

  test("returns as soon as the command exits", async () => {
    const fake = scriptedCommand((now) => (now >= 2_000 ? { exitCode: 3 } : {}), 1_000);
    try {
      const result = await runExec(fake.session, {
        cmd: "false",
        tty: false,
        yield_time_ms: 1_000,
      });
      expect(result).toContain("Process exited with code 3");
      expect(fake.now()).toBe(2_000);
    } finally {
      fake.restore();
    }
  });

  test("a dev server that printed its URL returns once output goes quiet", async () => {
    const fake = scriptedCommand(
      (now) => (now === 1_000 ? { output: "  Local: http://0.0.0.0:5173/\n" } : {}),
      1_000,
    );
    try {
      const result = await runExec(fake.session, {
        cmd: "npm run dev",
        tty: false,
        yield_time_ms: 1_000,
      });
      expect(result).toContain("Process running with session ID 7");
      expect(result).toContain("http://0.0.0.0:5173/");
      // Output at 1 s, then CUT_POLLING_OUTPUT_QUIET_MS of silence.
      expect(fake.now()).toBe(6_000);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });

  test("an input prompt returns after a short silence", async () => {
    const fake = scriptedCommand(
      (now) => (now === 1_000 ? { output: "Overwrite file? [y/N] " } : {}),
      1_000,
    );
    try {
      const result = await runExec(fake.session, {
        cmd: "./install.sh",
        tty: false,
        yield_time_ms: 1_000,
      });
      expect(result).toContain("Overwrite file? [y/N] ");
      expect(fake.now()).toBe(3_000);
    } finally {
      fake.restore();
    }
  });

  test("TTY commands keep the requested wait", async () => {
    const fake = scriptedCommand(() => ({}), 1_000);
    try {
      const result = await runExec(fake.session, {
        cmd: "python3",
        tty: true,
        yield_time_ms: 1_000,
      });
      expect(result).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(1_000);
    } finally {
      fake.restore();
    }
  });

  test("an omitted tty (interactive by default below the lean schema) keeps the requested wait", async () => {
    const fake = scriptedCommand(() => ({}), 1_000);
    try {
      await runExec(fake.session, { cmd: "top", yield_time_ms: 1_000 });
      expect(fake.now()).toBe(1_000);
    } finally {
      fake.restore();
    }
  });

  test("flag off: a non-TTY 1 s yield returns at 1 s, with or without cut polling", async () => {
    for (const cutPolling of [true, false]) {
      const fake = scriptedCommand(() => ({}), 1_000);
      try {
        const result = await runExec(
          fake.session,
          { cmd: "pytest -q", tty: false, yield_time_ms: 1_000 },
          { cutPolling, pollFloor: false },
        );
        expect(result).toContain("Process running with session ID 7");
        expect(fake.now()).toBe(1_000);
      } finally {
        fake.restore();
      }
    }
  });

  test("empty polls of a non-TTY command get the floor; input and TTY sessions do not", async () => {
    // Coarse virtual slices keep this multi-call test fast: each read is 5 s.
    const fake = scriptedCommand(() => ({}), 5_000);
    try {
      const inputs: string[] = [];
      const { exec, write } = tools(fake.session, {}, inputs);
      // Launch without a TTY; the dev-server-like silence holds to the floor.
      await exec.invoke(
        runContext,
        JSON.stringify({ cmd: "make test", tty: false, yield_time_ms: 1_000 }),
      );
      expect(fake.now()).toBe(30_000);

      const poll = async (args: Record<string, unknown>): Promise<number> => {
        const before = fake.now();
        await write.invoke(runContext, JSON.stringify({ session_id: 7, ...args }));
        return fake.now() - before;
      };
      expect(await poll({ chars: "", yield_time_ms: 1_000 })).toBe(30_000);
      expect(await poll({ yield_time_ms: 1_000 })).toBe(30_000);
      expect(await poll({ chars: null, yield_time_ms: 1_000 })).toBe(30_000);
      // Sending input keeps the requested wait (one slice).
      expect(await poll({ chars: "y\n", yield_time_ms: 1_000 })).toBe(5_000);
      expect(inputs.some((input) => input.includes('"chars":"y\\n"'))).toBe(true);
      // A long requested wait is unchanged by the floor.
      expect(await poll({ chars: "", yield_time_ms: 60_000 })).toBe(60_000);
    } finally {
      fake.restore();
    }
  }, 20_000);

  test("empty polls of a TTY command or a command this turn did not launch keep the requested wait", async () => {
    const fake = scriptedCommand(() => ({}), 1_000);
    try {
      const unknown = tools(fake.session, {});
      const before = fake.now();
      await unknown.write.invoke(
        runContext,
        JSON.stringify({ session_id: 7, chars: "", yield_time_ms: 1_000 }),
      );
      expect(fake.now() - before).toBe(1_000);

      const { exec, write } = tools(fake.session, {});
      await exec.invoke(
        runContext,
        JSON.stringify({ cmd: "python3", tty: true, yield_time_ms: 1_000 }),
      );
      const start = fake.now();
      await write.invoke(
        runContext,
        JSON.stringify({ session_id: 7, chars: "", yield_time_ms: 1_000 }),
      );
      expect(fake.now() - start).toBe(1_000);
    } finally {
      fake.restore();
    }
  });

  test("an interrupt during the floor cancels at the next provider slice, without adoption", async () => {
    let cancelAt: (() => void) | null = null;
    const fake = scriptedCommand((now) => {
      if (now === 5_000) cancelAt?.();
      return {};
    }, 250);
    try {
      const { controller, exec } = tools(fake.session, {});
      cancelAt = () => controller.cancel(new Error("user interrupt"));
      await expect(
        exec.invoke(
          runContext,
          JSON.stringify({ cmd: "sleep 600", tty: false, yield_time_ms: 1_000 }),
        ),
      ).rejects.toThrow("user interrupt");
      expect(fake.now()).toBe(5_000);
      expect(fake.state.adoptions).toBe(0);
    } finally {
      fake.restore();
    }
  });
});

describe("poll floor against a real local process", () => {
  const sessions: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  });

  async function localTools(signal?: AbortSignal) {
    const python = Bun.which("python3");
    expect(python).not.toBeNull();
    process.env.OPENAI_AGENTS_PYTHON = python!;
    const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
    const client = createSandboxClientForBackend("local", settings) as {
      create(manifest?: unknown): Promise<{ close(): Promise<void> }>;
    };
    const session = await client.create({});
    sessions.push(session);
    const controller = createTurnToolCancellationController(signal, {
      cutPolling: true,
      pollFloor: true,
    });
    const capability = shell({ configureTools: (list) => controller.wrapTools(list) });
    const list = capability
      .clone()
      .bind(session as never)
      .tools();
    const find = (name: string) =>
      list.find((tool): tool is FunctionTool => tool.type === "function" && tool.name === name)!;
    return { controller, exec: find("exec_command"), write: find("write_stdin") };
  }

  async function timed(run: () => Promise<unknown>): Promise<{ output: string; ms: number }> {
    const started = performance.now();
    const output = String(await run());
    return { output, ms: performance.now() - started };
  }

  const notLinux = process.platform !== "linux";

  test.skipIf(notLinux)(
    "a 4 s non-TTY command requested with a 1 s yield returns its exit in one call",
    async () => {
      const { exec } = await localTools();
      const { output, ms } = await timed(() =>
        exec.invoke(
          runContext,
          JSON.stringify({
            cmd: "for i in 1 2 3 4; do echo step $i; sleep 1; done; echo built",
            tty: false,
            yield_time_ms: 1_000,
            max_output_tokens: 1_000,
          }),
        ),
      );
      expect(parseExecResponseBanner(output)).toEqual({ kind: "exited", exitCode: 0 });
      expect(output).toContain("built");
      expect(ms).toBeLessThan(8_000);
    },
    20_000,
  );

  test.skipIf(notLinux)(
    "a server that prints and then idles hands back control after the quiet window",
    async () => {
      const { exec, controller } = await localTools();
      const { output, ms } = await timed(() =>
        exec.invoke(
          runContext,
          JSON.stringify({
            cmd: "echo 'listening on http://0.0.0.0:8080'; sleep 120",
            tty: false,
            yield_time_ms: 1_000,
            max_output_tokens: 1_000,
          }),
        ),
      );
      expect(parseExecResponseBanner(output).kind).toBe("running");
      expect(output).toContain("listening on");
      expect(ms).toBeGreaterThan(4_500);
      expect(ms).toBeLessThan(10_000);
      controller.cancel();
      await controller.waitForQuiescence();
    },
    30_000,
  );

  test.skipIf(notLinux)(
    "a prompt returns after a short silence and an input write is not floored",
    async () => {
      const { exec, write, controller } = await localTools();
      const first = await timed(() =>
        exec.invoke(
          runContext,
          JSON.stringify({
            cmd: "printf 'Continue? [y/N] '; read answer; echo got=$answer; sleep 120",
            tty: false,
            yield_time_ms: 1_000,
            max_output_tokens: 1_000,
          }),
        ),
      );
      const banner = parseExecResponseBanner(first.output);
      expect(banner.kind).toBe("running");
      expect(first.output).toContain("Continue? [y/N] ");
      // The prompt signal (2 s quiet), not the 5 s output-quiet return.
      expect(first.ms).toBeLessThan(4_000);
      if (banner.kind !== "running") throw new Error("expected a running command");
      // Input is not floored: the echo returns, then the quiet window applies.
      const answered = await timed(() =>
        write.invoke(
          runContext,
          JSON.stringify({ session_id: banner.sessionId, chars: "y\n", yield_time_ms: 1_000 }),
        ),
      );
      expect(answered.ms).toBeLessThan(3_000);
      controller.cancel();
      await controller.waitForQuiescence();
    },
    30_000,
  );

  test.skipIf(notLinux)(
    "a user interrupt during the floor returns promptly",
    async () => {
      const abort = new AbortController();
      const { exec, controller } = await localTools(abort.signal);
      const started = performance.now();
      const pending = exec.invoke(
        runContext,
        JSON.stringify({ cmd: "sleep 120", tty: false, yield_time_ms: 1_000 }),
      );
      setTimeout(() => abort.abort(new Error("user interrupt")), 3_000);
      await expect(pending).rejects.toThrow("user interrupt");
      const ms = performance.now() - started;
      expect(ms).toBeGreaterThan(2_900);
      expect(ms).toBeLessThan(5_000);
      await controller.waitForQuiescence();
    },
    30_000,
  );

  test.skipIf(notLinux)(
    "a TTY command keeps its 1 s yield",
    async () => {
      const { exec, controller } = await localTools();
      const { output, ms } = await timed(() =>
        exec.invoke(
          runContext,
          JSON.stringify({ cmd: "sleep 120", tty: true, yield_time_ms: 1_000 }),
        ),
      );
      expect(parseExecResponseBanner(output).kind).toBe("running");
      expect(ms).toBeLessThan(3_000);
      controller.cancel();
      await controller.waitForQuiescence();
    },
    30_000,
  );
});
