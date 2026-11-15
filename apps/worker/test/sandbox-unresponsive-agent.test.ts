import { describe, expect, test } from "bun:test";
import { ComputeControlError } from "@opengeni/runtime/sandbox";
import {
  recoverUnresponsiveComputeAgent,
  type SandboxProcessStartRecovery,
} from "../src/activities/agent-turn/sandbox-setup-agent-failure";

type Published = Parameters<SandboxProcessStartRecovery["publish"]>[0][number];

/** A compute box whose agent stopped answering, and a turn's event log. */
function turn(
  options: {
    answers?: boolean;
    restartFails?: boolean | Error;
    publishFails?: boolean;
  } = {},
) {
  const events: Published[] = [];
  let restarts = 0;
  const machine = {
    agentAnswers: async () => options.answers ?? false,
    restartMachine: async () => {
      restarts += 1;
      if (options.restartFails instanceof Error) throw options.restartFails;
      if (options.restartFails) throw new Error("control service unavailable");
    },
  };
  const recovery = {
    restartsThisTurn: async () => ({
      started: events.filter((event) => event.type === "sandbox.operation.started").length,
      completed: events.filter((event) => event.type === "sandbox.operation.completed").length,
    }),
    publish: async (published: Published[]) => {
      if (options.publishFails) throw new Error("event log unavailable");
      events.push(...published);
    },
    operationName: "sandbox.process_start_restart",
  };
  return { machine, recovery, events, restarts: () => restarts };
}

describe("a compute box whose agent stopped answering a command", () => {
  test("is restarted once per turn, recorded before and after", async () => {
    const { machine, recovery, events, restarts } = turn();
    expect(await recoverUnresponsiveComputeAgent(machine, recovery)).toBe("restarted");
    expect(restarts()).toBe(1);
    expect(events).toEqual([
      {
        type: "sandbox.operation.started",
        payload: { name: "sandbox.process_start_restart", reason: "agent_unresponsive" },
      },
      {
        type: "sandbox.operation.completed",
        payload: { name: "sandbox.process_start_restart" },
      },
    ]);
    // The next command of the same turn finds it silent again: no loop.
    expect(await recoverUnresponsiveComputeAgent(machine, recovery)).toBe("already_restarted");
    expect(restarts()).toBe(1);
  });

  test("is left alone when its agent answers again", async () => {
    const { machine, recovery, events, restarts } = turn({ answers: true });
    expect(await recoverUnresponsiveComputeAgent(machine, recovery)).toBe("answering");
    expect(restarts()).toBe(0);
    expect(events).toEqual([]);
  });

  test("is not restarted while its host is busy handing it off, and nothing is recorded", async () => {
    const { machine, recovery, events, restarts } = turn();
    const busy = { ...recovery, hostBusy: async () => true };
    expect(await recoverUnresponsiveComputeAgent(machine, busy)).toBe("host_busy");
    expect(restarts()).toBe(0);
    expect(events).toEqual([]);
    // Once the host is done, a box still silent is restarted as before.
    const done = { ...recovery, hostBusy: async () => false };
    expect(await recoverUnresponsiveComputeAgent(machine, done)).toBe("restarted");
    expect(restarts()).toBe(1);
  });

  test("a host whose business cannot be read is taken as not busy", async () => {
    const { machine, recovery, restarts } = turn();
    const unreadable = {
      ...recovery,
      hostBusy: async (): Promise<boolean> => {
        throw new Error("database unavailable");
      },
    };
    expect(await recoverUnresponsiveComputeAgent(machine, unreadable)).toBe("restarted");
    expect(restarts()).toBe(1);
  });

  test("a failed restart is recorded and reported", async () => {
    const { machine, recovery, events } = turn({ restartFails: true });
    expect(await recoverUnresponsiveComputeAgent(machine, recovery)).toBe("restart_failed");
    expect(events.map((event) => event.type)).toEqual([
      "sandbox.operation.started",
      "sandbox.operation.failed",
    ]);
  });

  test("a restart its host cannot serve now is reported as the host's, not the box's", async () => {
    // As on 10 Nov 2026: the host's agent was restarting, and compute control
    // answered the restart with 503 unavailable.
    const refused = new ComputeControlError({
      kind: "unavailable",
      status: 503,
      message:
        "compute control service POST /v1/sandboxes/x/restart: unavailable for now: this host's agent is starting: it is taking back the sandboxes an earlier run left",
    });
    const { machine, recovery, events } = turn({ restartFails: refused });
    expect(await recoverUnresponsiveComputeAgent(machine, recovery)).toBe("host_unavailable");
    expect(events.map((event) => event.type)).toEqual([
      "sandbox.operation.started",
      "sandbox.operation.failed",
    ]);
    // Any other refusal is still a failed restart.
    const other = turn({
      restartFails: new ComputeControlError({ kind: "host", status: 502, message: "refused" }),
    });
    expect(await recoverUnresponsiveComputeAgent(other.machine, other.recovery)).toBe(
      "restart_failed",
    );
  });

  test("a restart that cannot be recorded is not made, and says so", async () => {
    const { machine, recovery, restarts } = turn({ publishFails: true });
    expect(await recoverUnresponsiveComputeAgent(machine, recovery)).toBe("restart_unavailable");
    expect(restarts()).toBe(0);
  });

  test("without the turn's restart count, no restart is made", async () => {
    const { machine, recovery, restarts } = turn();
    recovery.restartsThisTurn = async () => {
      throw new Error("database unavailable");
    };
    expect(await recoverUnresponsiveComputeAgent(machine, recovery)).toBe("restart_unavailable");
    expect(restarts()).toBe(0);
  });

  test("a restart begun this turn that did not finish is not made again", async () => {
    const { machine, recovery, events, restarts } = turn();
    events.push({
      type: "sandbox.operation.started",
      payload: { name: "sandbox.process_start_restart", reason: "process_start_failed" },
    });
    expect(await recoverUnresponsiveComputeAgent(machine, recovery)).toBe("already_restarted");
    expect(restarts()).toBe(0);
  });
});
