import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Tool } from "@openai/agents";

import {
  COMMAND_FINISH_FLOOR_MS,
  createTurnToolCancellationController,
  execCommandForegroundWait,
  looksLikeInputPrompt,
  modelWaitMs,
} from "../src/sandbox/turn-tool-cancellation";

const runContext = {} as never;
/** Per-test cut-polling setting passed to each controller. */
let cutPolling = false;
/** The finish floor of runExec's controller (with cut polling). */
let finishFloor = true;

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

/**
 * A retained command that exits after `runtimeMs` of virtual time. Each
 * internal provider read advances a virtual clock by `stepMs`, so a long
 * foreground wait runs in a few real milliseconds per read.
 */
function virtualCommand(runtimeMs: number | null, stepMs = 30_000) {
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
      return runtimeMs !== null && now >= runtimeMs
        ? exited(0, `done after ${now}\n`)
        : running(7, `tick ${now}\n`);
    },
    adoptRetainedProcessAsBackgroundCommand: async () => {
      state.adoptions += 1;
    },
  };
  return { session, state, restore: () => clock.mockRestore() };
}

/**
 * A retained command scripted against virtual time: `script(now)` returns the
 * output produced during the slice ending at `now` and whether it has exited.
 */
function scriptedCommand(
  script: (now: number) => { output?: string; exitCode?: number },
  stepMs: number,
) {
  let now = 0;
  // An integer base keeps virtual-time differences exact.
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
  return {
    session,
    state,
    now: () => now,
    restore: () => clock.mockRestore(),
  };
}

async function runExec(
  session: object,
  cmd: string,
  yieldTimeMs: number,
  initialOutput = "",
  extraArgs: Record<string, unknown> = {},
): Promise<string> {
  const controller = createTurnToolCancellationController(undefined, {
    cutPolling,
    finishFloor: cutPolling && finishFloor,
  });
  const [exec] = controller.wrapTools(
    [functionTool("exec_command", async () => running(7, initialOutput))],
    session,
  ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
  return String(
    await exec!.invoke(
      runContext,
      JSON.stringify({ cmd, yield_time_ms: yieldTimeMs, ...extraArgs }),
    ),
  );
}

afterEach(() => {
  cutPolling = false;
  finishFloor = true;
});

describe("cut-polling setting", () => {
  test("is off unless the controller opts in", async () => {
    const fake = virtualCommand(90_000);
    try {
      const controller = createTurnToolCancellationController();
      const [exec] = controller.wrapTools(
        [functionTool("exec_command", async () => running(7, "start\n"))],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const output = String(
        await exec!.invoke(runContext, JSON.stringify({ cmd: "x", yield_time_ms: 290_000 })),
      );
      expect(output).toContain("Process running with session ID");
    } finally {
      fake.restore();
    }
  });

  test("default keeps the 30-second cap; the experiment honors requests up to 4 minutes", () => {
    expect(modelWaitMs(undefined, false)).toBe(10_000);
    expect(modelWaitMs(undefined, true)).toBe(10_000);
    expect(modelWaitMs(5_000, true)).toBe(5_000);
    expect(modelWaitMs(290_000, false)).toBe(30_000);
    expect(modelWaitMs(200_000, true)).toBe(200_000);
    expect(modelWaitMs(290_000, true)).toBe(240_000);
    expect(modelWaitMs(1_200_000, true)).toBe(240_000);
    expect(modelWaitMs(-1, true)).toBe(10_000);
  });

  test("disabled: a 90 s command requested with a 290 s wait returns a running handle at 30 s", async () => {
    cutPolling = false;
    const fake = virtualCommand(90_000);
    try {
      const controller = createTurnToolCancellationController(undefined, { cutPolling });
      const [exec] = controller.wrapTools(
        [functionTool("exec_command", async () => running(7, "start\n"))],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const result = await exec!.invoke(
        runContext,
        JSON.stringify({ cmd: "go test ./...", yield_time_ms: 290_000 }),
      );
      expect(result).toContain("Process running with session ID 7");
      expect(fake.state.reads).toBe(1);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });

  test("enabled: the same command returns its terminal result from the original call", async () => {
    cutPolling = true;
    const fake = virtualCommand(90_000);
    try {
      const controller = createTurnToolCancellationController(undefined, { cutPolling });
      const [exec] = controller.wrapTools(
        [functionTool("exec_command", async () => running(7, "start\n"))],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const result = await exec!.invoke(
        runContext,
        JSON.stringify({ cmd: "go test ./...", yield_time_ms: 290_000 }),
      );
      expect(result).toContain("Process exited with code 0");
      expect(result).toContain("start\ntick 30000\ntick 60000\ndone after 90000");
      expect(fake.state.reads).toBe(3);
      expect(fake.state.adoptions).toBe(0);
      await controller.waitForQuiescence();
    } finally {
      fake.restore();
    }
  });

  test("enabled: an explicit short yield still returns early", async () => {
    cutPolling = true;
    const fake = virtualCommand(90_000, 5_000);
    try {
      const controller = createTurnToolCancellationController(undefined, { cutPolling });
      const [exec] = controller.wrapTools(
        [functionTool("exec_command", async () => running(7))],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const result = await exec!.invoke(
        runContext,
        JSON.stringify({ cmd: "npm run dev", yield_time_ms: 10_000 }),
      );
      expect(result).toContain("Process running with session ID 7");
      expect(fake.state.reads).toBe(2);
    } finally {
      fake.restore();
    }
  });

  test("enabled: a write_stdin poll honors its long requested wait", async () => {
    cutPolling = true;
    const fake = virtualCommand(120_000);
    try {
      const controller = createTurnToolCancellationController(undefined, { cutPolling });
      const [, write] = controller.wrapTools(
        [
          functionTool("exec_command", async () => running(7)),
          functionTool("write_stdin", async () => running(7)),
        ],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const result = await write!.invoke(
        runContext,
        JSON.stringify({ session_id: 7, chars: "", yield_time_ms: 300_000 }),
      );
      expect(result).toContain("Process exited with code 0");
      expect(fake.state.reads).toBe(4);
    } finally {
      fake.restore();
    }
  });

  test("enabled: a command that never exits returns control at the 4-minute ceiling", async () => {
    cutPolling = true;
    const fake = virtualCommand(null, 60_000);
    try {
      const controller = createTurnToolCancellationController(undefined, { cutPolling });
      const [exec] = controller.wrapTools(
        [functionTool("exec_command", async () => running(7))],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const result = await exec!.invoke(
        runContext,
        JSON.stringify({ cmd: "git clone big", yield_time_ms: 1_200_000 }),
      );
      expect(result).toContain("Process running with session ID 7");
      expect(fake.state.reads).toBe(4);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });
});

describe("cut-polling quiet return for servers, watchers and prompts", () => {
  test("recognizes input prompts but not progress output", () => {
    for (const prompt of [
      ">>> ",
      "> ",
      "bash-5.2$ ",
      "root@box:/# ",
      "Password: ",
      "Proceed? ",
      "Overwrite file? [y/N] ",
      "Continue (yes/no) ",
      "line one\n\u001b[32m?\u001b[0m Pick a template: ",
    ]) {
      expect(looksLikeInputPrompt(prompt)).toBe(true);
    }
    for (const notPrompt of [
      "",
      "ready in 312 ms\n",
      ">>> \n",
      "tests/test_api.py ......",
      "[ 45%] Building CXX object foo.o",
      "Compiling serde v1.0.0\r[=====>     ] 12/80",
      "downloading 45%",
    ]) {
      expect(looksLikeInputPrompt(notPrompt)).toBe(false);
    }
  });

  test("a dev server that printed ready returns at the default window, not the requested 4 minutes", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) =>
        now === 1_000 ? { output: "  VITE ready in 312 ms\n  Local: http://0.0.0.0:5173/\n" } : {},
      1_000,
    );
    try {
      const result = await runExec(fake.session, "npm run dev", 300_000);
      expect(result).toContain("Process running with session ID 7");
      expect(result).toContain("VITE ready");
      expect(fake.now()).toBe(30_000);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });

  test("output that keeps streaming past the default window keeps the wait open until exit", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) =>
        now >= 80_000 ? { output: "PASS all\n", exitCode: 0 } : { output: `test ${now / 4_000}\n` },
      4_000,
    );
    try {
      const result = await runExec(fake.session, "npm test", 300_000);
      expect(result).toContain("Process exited with code 0");
      expect(result).toContain("PASS all");
      expect(fake.state.adoptions).toBe(0);
    } finally {
      fake.restore();
    }
  });

  test("a command that printed early and then runs silently returns at the default window, then a re-check waits for exit", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) =>
        now === 5_000
          ? { output: "# Query 1\n" }
          : now >= 235_000
            ? { output: "done\n", exitCode: 0 }
            : {},
      5_000,
    );
    try {
      const first = await runExec(fake.session, "opa eval --partial ...", 290_000);
      expect(first).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(30_000);
      // The re-check produces no new output until exit, so it waits for it.
      const controller = createTurnToolCancellationController(undefined, { cutPolling });
      const [, write] = controller.wrapTools(
        [
          functionTool("exec_command", async () => running(7)),
          functionTool("write_stdin", async () => running(7)),
        ],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const second = await write!.invoke(
        runContext,
        JSON.stringify({ session_id: 7, chars: "", yield_time_ms: 290_000 }),
      );
      expect(second).toContain("Process exited with code 0");
      expect(fake.now()).toBe(235_000);
    } finally {
      fake.restore();
    }
  });

  test("an output gap inside the default window does not return early", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) =>
        now === 2_000
          ? { output: "collected 40 items\ntests/test_api.py ...." }
          : now >= 24_000
            ? { output: "\n40 passed\n", exitCode: 0 }
            : {},
      2_000,
    );
    try {
      const result = await runExec(fake.session, "pytest -q", 120_000);
      expect(result).toContain("Process exited with code 0");
      expect(result).toContain("40 passed");
    } finally {
      fake.restore();
    }
  });

  test("a command waiting at an input prompt returns after a short silence", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) => (now === 1_000 ? { output: "Python 3.12.3\n>>> " } : {}),
      1_000,
    );
    try {
      const result = await runExec(fake.session, "python3", 300_000);
      expect(result).toContain("Process running with session ID 7");
      expect(result).toContain(">>> ");
      expect(fake.now()).toBe(3_000);
    } finally {
      fake.restore();
    }
  });

  test("a silent long build waits for exit", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) => (now >= 150_000 ? { output: "built\n", exitCode: 0 } : {}),
      10_000,
    );
    try {
      const result = await runExec(fake.session, "go build ./... 2>&1 | tail -3", 290_000);
      expect(result).toContain("Process exited with code 0");
      expect(fake.now()).toBe(150_000);
    } finally {
      fake.restore();
    }
  });

  test("a Pause/Steer that lands while a prompt goes quiet cancels instead of adopting", async () => {
    cutPolling = true;
    const controller = createTurnToolCancellationController(undefined, { cutPolling });
    const fake = scriptedCommand((now) => {
      if (now === 1_000) return { output: "Continue? [y/N] " };
      // Lands during the inter-slice delay, after this read's own cancel check.
      if (now === 3_000) setTimeout(() => controller.cancel(new Error("steer")), 0);
      return {};
    }, 1_000);
    try {
      const [exec] = controller.wrapTools(
        [functionTool("exec_command", async () => running(7))],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      await expect(
        exec!.invoke(runContext, JSON.stringify({ cmd: "./install.sh", yield_time_ms: 200_000 })),
      ).rejects.toThrow("steer");
      expect(fake.state.adoptions).toBe(0);
    } finally {
      fake.restore();
    }
  });

  test("disabled: a prompt still holds the ordinary window", async () => {
    cutPolling = false;
    const fake = scriptedCommand((now) => (now === 1_000 ? { output: ">>> " } : {}), 1_000);
    try {
      const result = await runExec(fake.session, "python3", 300_000);
      expect(result).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(30_000);
    } finally {
      fake.restore();
    }
  });
});

describe("finish floor for commands without a TTY", () => {
  test("the floor applies only with cut polling and the floor on, without a TTY or background", () => {
    expect(COMMAND_FINISH_FLOOR_MS).toBe(60_000);
    expect(execCommandForegroundWait({ yield_time_ms: 1_000, tty: false }, true, true)).toEqual({
      waitMs: 60_000,
      quietReturnAfterMs: 60_000,
    });
    // A longer requested wait is kept, with its ordinary quiet return.
    expect(execCommandForegroundWait({ yield_time_ms: 200_000, tty: false }, true, true)).toEqual({
      waitMs: 200_000,
      quietReturnAfterMs: 30_000,
    });
    // A requested wait past the ordinary window but under the floor is raised
    // to the floor and keeps the ordinary quiet return.
    expect(execCommandForegroundWait({ yield_time_ms: 45_000, tty: false }, true, true)).toEqual({
      waitMs: 60_000,
      quietReturnAfterMs: 30_000,
    });
    expect(execCommandForegroundWait({ yield_time_ms: 30_000, tty: false }, true, true)).toEqual({
      waitMs: 60_000,
      quietReturnAfterMs: 60_000,
    });
    expect(
      execCommandForegroundWait({ yield_time_ms: 900_000, tty: false }, true, true).waitMs,
    ).toBe(240_000);
    expect(execCommandForegroundWait({ tty: false }, true, true).waitMs).toBe(60_000);
    expect(
      execCommandForegroundWait({ yield_time_ms: 1_000, tty: false, background: true }, true, true),
    ).toEqual({ waitMs: 1_000, quietReturnAfterMs: 1_000 });
    expect(execCommandForegroundWait({ yield_time_ms: 1_000, tty: true }, true, true)).toEqual({
      waitMs: 1_000,
      quietReturnAfterMs: 1_000,
    });
    // An omitted tty keeps this layer's historical interactive default.
    expect(execCommandForegroundWait({ yield_time_ms: 1_000 }, true, true).waitMs).toBe(1_000);
    // Floor off (no lean schema to offer `background`) or cut polling off: unchanged.
    expect(execCommandForegroundWait({ yield_time_ms: 1_000, tty: false }, true, false)).toEqual({
      waitMs: 1_000,
      quietReturnAfterMs: 1_000,
    });
    expect(execCommandForegroundWait({ yield_time_ms: 1_000, tty: false }, false, true)).toEqual({
      waitMs: 1_000,
    });
  });

  test("a short command asked to yield after 1 s returns its result in one call", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) =>
        now === 2_000
          ? { output: "RUN   TestParse\n" }
          : now >= 42_000
            ? { output: "ok  \tgithub.com/example/parser\t40.1s\n", exitCode: 0 }
            : {},
      2_000,
    );
    try {
      const result = await runExec(fake.session, "go test ./...", 1_000, "", { tty: false });
      expect(result).toContain("Process exited with code 0");
      expect(result).toContain("RUN   TestParse\nok  \tgithub.com/example/parser");
      expect(fake.now()).toBe(42_000);
      expect(fake.state.adoptions).toBe(0);
    } finally {
      fake.restore();
    }
  });

  test("a long silent command still goes to the background at the floor", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) => (now >= 300_000 ? { output: "done\n", exitCode: 0 } : {}),
      5_000,
    );
    try {
      const result = await runExec(fake.session, "cargo build --release", 1_000, "", {
        tty: false,
      });
      expect(result).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(60_000);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });

  test("background: true keeps the requested short wait and reaches no inner layer", async () => {
    cutPolling = true;
    const fake = scriptedCommand(() => ({ output: "listening on :8080\n" }), 500);
    const forwarded: string[] = [];
    try {
      const controller = createTurnToolCancellationController(undefined, {
        cutPolling,
        finishFloor: true,
      });
      const [exec] = controller.wrapTools(
        [
          functionTool("exec_command", async (_context, input) => {
            forwarded.push(String(input));
            return running(7);
          }),
        ],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const result = String(
        await exec!.invoke(
          runContext,
          JSON.stringify({ cmd: "./server", yield_time_ms: 1_000, tty: false, background: true }),
        ),
      );
      expect(result).toContain("Process running with session ID 7");
      expect(result).toContain("listening on :8080");
      expect(fake.now()).toBe(1_000);
      expect(fake.state.adoptions).toBe(1);
      expect(JSON.parse(forwarded[0]!)).not.toHaveProperty("background");
    } finally {
      fake.restore();
    }
  });

  test("a server started with a short yield and without background returns at the floor", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) => (now === 3_000 ? { output: "ready on http://127.0.0.1:3000\n" } : {}),
      3_000,
    );
    try {
      const result = await runExec(fake.session, "npm run dev", 1_000, "", { tty: false });
      expect(result).toContain("Process running with session ID 7");
      expect(result).toContain("ready on http://127.0.0.1:3000");
      expect(fake.now()).toBe(60_000);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });

  test("a requested wait above the floor keeps its ordinary quiet return", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) => (now === 3_000 ? { output: "ready on http://127.0.0.1:3000\n" } : {}),
      1_000,
    );
    try {
      const result = await runExec(fake.session, "npm run dev", 120_000, "", { tty: false });
      expect(result).toContain("Process running with session ID 7");
      // The ordinary 30 s quiet return, not the 60 s floor or the requested 120 s.
      expect(fake.now()).toBe(30_000);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });

  test("without the floor (no background in the schema) a 1 s yield is kept", async () => {
    cutPolling = true;
    finishFloor = false;
    const fake = scriptedCommand(
      (now) => (now >= 42_000 ? { output: "ok\n", exitCode: 0 } : {}),
      500,
    );
    try {
      const result = await runExec(fake.session, "go test ./...", 1_000, "", { tty: false });
      expect(result).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(1_000);
    } finally {
      fake.restore();
    }
  });

  test("cut polling off strips background and keeps the requested wait", async () => {
    cutPolling = false;
    const fake = scriptedCommand(() => ({}), 500);
    const forwarded: string[] = [];
    try {
      const controller = createTurnToolCancellationController(undefined, {
        cutPolling: false,
        finishFloor: true,
      });
      const [exec] = controller.wrapTools(
        [
          functionTool("exec_command", async (_context, input) => {
            forwarded.push(String(input));
            return running(7);
          }),
        ],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const result = String(
        await exec!.invoke(
          runContext,
          JSON.stringify({ cmd: "make", yield_time_ms: 1_000, tty: false, background: false }),
        ),
      );
      expect(result).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(1_000);
      expect(JSON.parse(forwarded[0]!)).not.toHaveProperty("background");
    } finally {
      fake.restore();
    }
  });

  test("a Pause or cancellation ends a floored wait", async () => {
    cutPolling = true;
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal, {
      cutPolling,
      finishFloor: true,
    });
    const fake = scriptedCommand((now) => {
      if (now === 5_000) abort.abort(new Error("paused"));
      return {};
    }, 1_000);
    try {
      const [exec] = controller.wrapTools(
        [functionTool("exec_command", async () => running(7))],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      await expect(
        exec!.invoke(
          runContext,
          JSON.stringify({ cmd: "pytest", yield_time_ms: 1_000, tty: false }),
        ),
      ).rejects.toThrow();
      expect(fake.now()).toBeLessThan(10_000);
    } finally {
      fake.restore();
    }
  });

  test("a floored command waiting at an input prompt still returns after a short silence", async () => {
    cutPolling = true;
    const fake = scriptedCommand(
      (now) => (now === 1_000 ? { output: "Overwrite existing file? [y/N] " } : {}),
      1_000,
    );
    try {
      const result = await runExec(fake.session, "./setup.sh", 1_000, "", { tty: false });
      expect(result).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(3_000);
    } finally {
      fake.restore();
    }
  });

  test("an interactive (TTY) command keeps its requested short wait", async () => {
    cutPolling = true;
    const fake = scriptedCommand(() => ({}), 500);
    try {
      const result = await runExec(fake.session, "python3", 1_000, "", { tty: true });
      expect(result).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(1_000);
    } finally {
      fake.restore();
    }
  });

  test("a waiting Steer still ends a floored wait at the next slice", async () => {
    cutPolling = true;
    const controller = createTurnToolCancellationController(undefined, {
      cutPolling,
      finishFloor: true,
    });
    const fake = scriptedCommand((now) => {
      if (now === 4_000) controller.setForegroundWaitYield(true);
      return {};
    }, 1_000);
    try {
      const [exec] = controller.wrapTools(
        [functionTool("exec_command", async () => running(7))],
        fake.session,
      ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
      const result = String(
        await exec!.invoke(
          runContext,
          JSON.stringify({ cmd: "pytest", yield_time_ms: 1_000, tty: false }),
        ),
      );
      expect(result).toContain("Process running with session ID 7");
      expect(fake.now()).toBe(4_000);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });

  test("a remote operation receives the floored yield and no background argument", async () => {
    cutPolling = true;
    const forwarded: Record<string, unknown>[] = [];
    const controller = createTurnToolCancellationController(undefined, {
      cutPolling,
      finishFloor: true,
    });
    const session = {
      commandCancellationTransport: async () => "remote_operation" as const,
      cancelExecCommand: async () => true,
      supportsPty: () => false,
    };
    const [exec] = controller.wrapTools(
      [
        functionTool("exec_command", async (_context, input) => {
          forwarded.push(JSON.parse(String(input)) as Record<string, unknown>);
          return exited(0, "ok\n");
        }),
      ],
      session,
    ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
    await exec!.invoke(
      runContext,
      JSON.stringify({ cmd: "make test", yield_time_ms: 500, tty: false }),
    );
    await exec!.invoke(
      runContext,
      JSON.stringify({ cmd: "make serve", yield_time_ms: 500, tty: false, background: true }),
    );
    await exec!.invoke(
      runContext,
      JSON.stringify({ cmd: "make lint", yield_time_ms: 500, tty: false, background: false }),
    );
    await exec!.invoke(
      runContext,
      JSON.stringify({ cmd: "make bench", yield_time_ms: 120_000, tty: false }),
    );
    expect(forwarded[0]).toEqual({ cmd: "make test", yield_time_ms: 60_000, tty: false });
    expect(forwarded[1]).toEqual({ cmd: "make serve", yield_time_ms: 500, tty: false });
    expect(forwarded[2]).toEqual({ cmd: "make lint", yield_time_ms: 60_000, tty: false });
    // A yield already above the floor reaches the provider unchanged.
    expect(forwarded[3]).toEqual({ cmd: "make bench", yield_time_ms: 120_000, tty: false });
    await controller.waitForQuiescence();
  });
});
