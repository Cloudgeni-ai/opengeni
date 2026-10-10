import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Tool } from "@openai/agents";

import {
  createTurnToolCancellationController,
  cutPollingExperimentEnabled,
  looksLikeInputPrompt,
  modelWaitMs,
} from "../src/sandbox/turn-tool-cancellation";

const runContext = {} as never;
const FLAG = "OPENGENI_EXPERIMENT_CUT_POLLING";
const originalFlag = process.env[FLAG];

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
): Promise<string> {
  const controller = createTurnToolCancellationController();
  const [exec] = controller.wrapTools(
    [functionTool("exec_command", async () => running(7, initialOutput))],
    session,
  ) as Array<Extract<Tool<unknown>, { type: "function" }>>;
  return String(
    await exec!.invoke(runContext, JSON.stringify({ cmd, yield_time_ms: yieldTimeMs })),
  );
}

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
});

describe("cut-polling experiment flag", () => {
  test("is off unless exactly 1", () => {
    expect(cutPollingExperimentEnabled({})).toBe(false);
    expect(cutPollingExperimentEnabled({ [FLAG]: "0" })).toBe(false);
    expect(cutPollingExperimentEnabled({ [FLAG]: "true" })).toBe(false);
    expect(cutPollingExperimentEnabled({ [FLAG]: "1" })).toBe(true);
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

  test("flag off: a 90 s command requested with a 290 s wait returns a running handle at 30 s", async () => {
    delete process.env[FLAG];
    const fake = virtualCommand(90_000);
    try {
      const controller = createTurnToolCancellationController();
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

  test("flag on: the same command returns its terminal result from the original call", async () => {
    process.env[FLAG] = "1";
    const fake = virtualCommand(90_000);
    try {
      const controller = createTurnToolCancellationController();
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

  test("flag on: an explicit short yield still returns early", async () => {
    process.env[FLAG] = "1";
    const fake = virtualCommand(90_000, 5_000);
    try {
      const controller = createTurnToolCancellationController();
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

  test("flag on: a write_stdin poll honors its long requested wait", async () => {
    process.env[FLAG] = "1";
    const fake = virtualCommand(120_000);
    try {
      const controller = createTurnToolCancellationController();
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

  test("flag on: a command that never exits returns control at the 4-minute ceiling", async () => {
    process.env[FLAG] = "1";
    const fake = virtualCommand(null, 60_000);
    try {
      const controller = createTurnToolCancellationController();
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
    process.env[FLAG] = "1";
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
    process.env[FLAG] = "1";
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
    process.env[FLAG] = "1";
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
      const controller = createTurnToolCancellationController();
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
    process.env[FLAG] = "1";
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
    process.env[FLAG] = "1";
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
    process.env[FLAG] = "1";
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

  test("flag off: a prompt still holds the ordinary window", async () => {
    delete process.env[FLAG];
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
