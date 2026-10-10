import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Tool } from "@openai/agents";

import {
  createTurnToolCancellationController,
  cutPollingExperimentEnabled,
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
  const realNow = performance.now.bind(performance);
  const base = realNow();
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

  test("default keeps the 30-second cap; the experiment honors requests up to 10 minutes", () => {
    expect(modelWaitMs(undefined, false)).toBe(10_000);
    expect(modelWaitMs(undefined, true)).toBe(10_000);
    expect(modelWaitMs(5_000, true)).toBe(5_000);
    expect(modelWaitMs(290_000, false)).toBe(30_000);
    expect(modelWaitMs(290_000, true)).toBe(290_000);
    expect(modelWaitMs(1_200_000, true)).toBe(600_000);
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

  test("flag on: a command that never exits returns control at the 10-minute ceiling", async () => {
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
      expect(fake.state.reads).toBe(10);
      expect(fake.state.adoptions).toBe(1);
    } finally {
      fake.restore();
    }
  });
});
