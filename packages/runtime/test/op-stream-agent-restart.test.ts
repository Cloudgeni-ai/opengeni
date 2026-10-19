// An exec whose agent restarts: the connection it was admitted to is replaced
// by a new one (a Connected Machine's agent restarted, or a compute sandbox's
// VM booted fresh). Real SelfhostedSession, op stream and NatsControlRpc over a
// fake NATS connection that routes each exact subject to its own fake runner.

import { describe, expect, test } from "bun:test";
import { ControlRequest, ControlResponse, ExecRequest } from "@opengeni/agent-proto";
import {
  NatsControlRpc,
  SelfhostedControlError,
  timeoutAgentError,
} from "../src/sandbox/selfhosted/control-rpc";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
  type FakeOpScript,
} from "../src/sandbox/selfhosted/op-testing";
import { OpStreamExecClient } from "../src/sandbox/selfhosted/op-stream";
import type { OpStreamTransport } from "../src/sandbox/selfhosted/op-transport";
import { SelfhostedSession } from "../src/sandbox/selfhosted/session";
import { runWithToolCallCorrelation } from "../src/sandbox/op-correlation";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";
import { SandboxChannelAService } from "../src/sandbox/channel-a";

const WORKSPACE = "ws-restart";
const AGENT = "agent-restart";
const OLD = "connection-old";
const NEW = "connection-new";
const ROOT = "/home/user/project";

function rig(
  options: {
    execTimeoutMs?: number;
    controlTimeoutMs?: number;
    /** A gone agent's requests are held unanswered, as a host holds a request
     * while it wakes a sandbox, instead of finding no responders. */
    goneHolds?: boolean;
    onRequest?: (request: ControlRequest, instance: string) => void | Promise<void>;
    defaultScript?: (exec: ExecRequest) => FakeOpScript;
    /** "turn": a turn's ledger adoption; "direct": a caller without a turn
     * records only abandoned commands; "failing": recording fails. */
    ledger?: "turn" | "direct" | "failing";
    /** Delay of the nth admission (0-based). */
    admissionDelayMs?: (call: number) => number;
  } = {},
) {
  const state = { live: OLD, gone: new Set<string>() };
  // Each agent has its own frame stream; a gone agent's frames stop.
  const streams = new Map(
    [OLD, NEW].map((instance) => [instance, new InMemoryOpStreamTransport()]),
  );
  const transport: OpStreamTransport = {
    subscribe: async (subject, onMessage) => {
      const subscriptions = await Promise.all(
        [...streams].map(([instance, stream]) =>
          stream.subscribe(subject, (payload) => {
            if (!state.gone.has(instance)) onMessage(payload);
          }),
        ),
      );
      return {
        unsubscribe: () => {
          for (const subscription of subscriptions) subscription.unsubscribe();
        },
      };
    },
    publish: async (subject, payload) => {
      for (const [instance, stream] of streams) {
        if (!state.gone.has(instance)) await stream.publish(subject, payload);
      }
    },
  };
  const runners = new Map(
    [OLD, NEW].map((instance) => [
      instance,
      new FakeOpRunner({
        transport: streams.get(instance)!,
        workspaceId: WORKSPACE,
        agentId: AGENT,
        connectionInstanceId: instance,
        ...(options.defaultScript ? { defaultScript: options.defaultScript } : {}),
      }),
    ]),
  );
  /** The old agent is gone and a new one is live on a new connection. */
  const restart = () => {
    state.gone.add(OLD);
    state.live = NEW;
  };
  /** The old agent answers again and holds the connection once more. */
  const returnOld = () => {
    state.gone.delete(OLD);
    state.live = OLD;
  };
  /** The agent's host is lost: the agent stops answering on its connection,
   * which stays its live one. */
  const loseHost = () => {
    state.gone.add(OLD);
  };
  /** The agent's link comes back, at this replica or another: the same agent
   * process answers again on its connection. It never saw the requests its
   * lost link held. */
  const relink = () => {
    state.gone.delete(OLD);
  };
  const requests: { request: ControlRequest; instance: string }[] = [];
  const controlRpc = new NatsControlRpc(async () => ({
    request: async (subject: string, payload: Uint8Array, opts: { timeout: number }) => {
      const instance = subject.split(".")[4] ?? "";
      const request = ControlRequest.decode(payload);
      requests.push({ request, instance });
      await options.onRequest?.(request, instance);
      const runner = runners.get(instance);
      if (runner && state.gone.has(instance) && options.goneHolds) {
        await Bun.sleep(opts.timeout);
        throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
      }
      if (!runner || state.gone.has(instance)) {
        throw Object.assign(new Error("503 no responders"), { code: "503" });
      }
      // A request the agent holds is answered or times out, as over NATS.
      const response = await Promise.race([
        runner.request(subject, request, { timeoutMs: opts.timeout }),
        Bun.sleep(opts.timeout).then(() => {
          throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
        }),
      ]);
      return { data: ControlResponse.encode(response).finish() };
    },
  }));
  const adoptions: { connectionInstanceId: string; opId: string; abandoned?: boolean }[] = [];
  const record = async (input: (typeof adoptions)[number]) => {
    if (options.ledger === "failing") throw new Error("ledger unavailable");
    adoptions.push(input);
    return { commandId: `command-${adoptions.length}` };
  };
  let admissions = 0;
  const session = new SelfhostedSession({
    workspaceId: WORKSPACE,
    workspaceRoot: ROOT,
    agentId: AGENT,
    connectionInstanceId: OLD,
    controlRpc,
    relay: { host: "relay.test" },
    timeoutMs: options.controlTimeoutMs ?? 2_000,
    execTimeoutMs: options.execTimeoutMs ?? 5_000,
    retryClock: { sleep: async () => {}, jitter: () => 0.5 },
    resolveOperationAdmission: async () => {
      const delay = options.admissionDelayMs?.(admissions++) ?? 0;
      if (delay > 0) await Bun.sleep(delay);
      return {
        connectionInstanceId: state.live,
        workspaceRoot: ROOT,
        operationResourcePolicy: {
          memoryMaxBytes: null,
          memoryHighBytes: null,
          cpuMaxMillicores: null,
          revision: 1,
        },
        operationResourcePolicySupported: true,
        operationCpuQuotaSupported: true,
        opStream: { transport, ackIntervalMs: 20, silenceTimeoutMs: 120, reconnectHoldMs: 600 },
      };
    },
    ...(options.ledger === "direct"
      ? { abandonCommand: async (input) => await record({ ...input }) }
      : { adoptBackgroundCommand: record }),
    opStream: { transport, ackIntervalMs: 20, silenceTimeoutMs: 120, reconnectHoldMs: 600 },
  });
  /** A client on the old connection, as the session's recovery reads use. */
  const oldClient = () =>
    new OpStreamExecClient({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: OLD,
      epoch: 0,
      rpcSubject: `agent.${WORKSPACE}.${AGENT}.connection.${OLD}.rpc`,
      controlRpc,
      transport,
      controlTimeoutMs: options.controlTimeoutMs ?? 2_000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      ackIntervalMs: 20,
      silenceTimeoutMs: 120,
      reconnectHoldMs: 600,
      connectionCurrent: async () => state.live === OLD,
    });
  return {
    session,
    runners,
    restart,
    returnOld,
    loseHost,
    relink,
    requests,
    adoptions,
    transport,
    oldClient,
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(1);
  }
}

describe("an exec whose agent restarts", () => {
  test("a running command is handed to the ledger with a stop request and the turn is released", async () => {
    const { session, runners, restart, adoptions } = rig({
      // The turn's own setup commands finish; the user's command keeps running.
      defaultScript: (exec) =>
        exec.command.join(" ").includes("sleep 600")
          ? { frames: [], live: true, holdUntilCancel: true }
          : { frames: [], exit: { exitCode: 0 } },
    });
    const controller = createTurnToolCancellationController(new AbortController().signal);
    // As a terminal command runs: through the turn fence, outside any tool call.
    const run = controller.runSandboxCommandStructured(session, { cmd: "sleep 600" });
    const started = () =>
      runners.get(OLD)!.starts.find((start) => start.exec.command.join(" ").includes("sleep 600"));
    await until(() => started() !== undefined);
    const opId = started()!.opId;
    restart();

    const startedAt = Date.now();
    const error = await run.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expectOutcomeUnknown(error, { startConfirmed: true, stopRequested: true });
    // A new connection does not prove the old process is gone: the command is
    // handed over once, with a stop request bound to the connection it ran on.
    expect(adoptions).toEqual([
      expect.objectContaining({ connectionInstanceId: OLD, opId, abandoned: true }),
    ]);
    // The turn's fence drains without the old agent ever coming back.
    controller.cancel(error);
    await controller.waitForQuiescence();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(runners.get(NEW)!.runs.has(opId)).toBe(false);
  });

  test("a replacement after the start was accepted never says the command did not run", async () => {
    let restarted = false;
    const context = rig({
      onRequest: (request) => {
        // The agent restarts after accepting the start, before the first attach.
        if (request.op?.$case === "opAttach" && !restarted) {
          restarted = true;
          context.restart();
        }
      },
    });
    const { session, runners, adoptions } = context;
    const opId = "call_restart_attach:0";
    runners.get(OLD)!.script(opId, { frames: [], live: true, holdUntilCancel: true });

    const error = await runWithToolCallCorrelation("call_restart_attach", () =>
      session.exec({ cmd: "touch once" }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(runners.get(OLD)!.runs.get(opId)?.startCount).toBe(1);
    expectOutcomeUnknown(error, { startConfirmed: true, stopRequested: true });
    expect(adoptions).toEqual([
      expect.objectContaining({ connectionInstanceId: OLD, opId, abandoned: true }),
    ]);
    // Never repeated on the new agent.
    expect(runners.get(NEW)!.runs.has(opId)).toBe(false);
  });

  test("a request the old agent's host holds ends once the agent is replaced", async () => {
    let restarted = false;
    const context = rig({
      // Far longer than the test: only the replacement can end the wait.
      controlTimeoutMs: 30_000,
      execTimeoutMs: 60_000,
      goneHolds: true,
      onRequest: (request) => {
        // The sandbox's VM dies as the start is sent; its host holds the start
        // while it brings the sandbox back with a fresh agent.
        if (request.op?.$case === "opStart" && !restarted) {
          restarted = true;
          context.restart();
        }
      },
    });
    const { session, runners, adoptions } = context;
    const controller = createTurnToolCancellationController(new AbortController().signal);
    const startedAt = Date.now();
    const error = await controller.runSandboxCommandStructured(session, { cmd: "touch once" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // The start may have reached the old agent, but no agent confirmed it:
    // unknown, never "did not run" and never "while this command was running".
    expectOutcomeUnknown(error, { startConfirmed: false, stopRequested: true });
    expect(adoptions).toEqual([expect.objectContaining({ connectionInstanceId: OLD })]);
    controller.cancel(error);
    await controller.waitForQuiescence();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect([...runners.get(NEW)!.runs.keys()]).toEqual([]);
  });

  test("a held start whose stop cannot be recorded claims neither a run nor a stop", async () => {
    let restarted = false;
    const context = rig({
      controlTimeoutMs: 30_000,
      execTimeoutMs: 60_000,
      goneHolds: true,
      ledger: "failing",
      onRequest: (request) => {
        if (request.op?.$case === "opStart" && !restarted) {
          restarted = true;
          context.restart();
        }
      },
    });
    const { session, runners, requests, adoptions } = context;
    const error = await runWithToolCallCorrelation("call_held_unrecorded", () =>
      session.exec({ cmd: "touch once" }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expectOutcomeUnknown(error, { startConfirmed: false, stopRequested: false });
    expect(adoptions).toEqual([]);
    expect(requests.filter((r) => r.request.op?.$case === "opCancel")).toEqual([]);
    expect(runners.get(OLD)!.starts).toEqual([]);
    expect([...runners.get(NEW)!.runs.keys()]).toEqual([]);
  });

  test("a caller without a turn records the command as abandoned and is released", async () => {
    const { session, runners, restart, adoptions } = rig({
      ledger: "direct",
      defaultScript: () => ({ frames: [], live: true, holdUntilCancel: true }),
    });
    const controller = createTurnToolCancellationController(new AbortController().signal);
    // As a direct terminal request runs, with a long bounded wait.
    const run = controller.runSandboxCommandStructured(session, {
      cmd: "sleep 600",
      yieldTimeMs: 30_000,
    });
    await until(() => runners.get(OLD)!.starts.length === 1);
    const opId = runners.get(OLD)!.starts[0]!.opId;
    restart();
    const error = await run.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expectOutcomeUnknown(error, { startConfirmed: true, stopRequested: true });
    // Only the abandonment is recorded: a direct request never backgrounds.
    expect(adoptions).toEqual([{ ...adoptions[0], connectionInstanceId: OLD, opId }]);
    expect(adoptions[0]).not.toHaveProperty("abandoned");
    controller.cancel(error);
    await controller.waitForQuiescence();
  });

  test("when the ledger cannot record it, cleanup keeps it and stops it once the old agent returns", async () => {
    const { session, runners, restart, returnOld, adoptions } = rig({
      ledger: "failing",
      defaultScript: () => ({ frames: [], live: true, holdUntilCancel: true }),
    });
    const controller = createTurnToolCancellationController(new AbortController().signal);
    const run = controller.runSandboxCommandStructured(session, { cmd: "sleep 600" });
    await until(() => runners.get(OLD)!.starts.length === 1);
    const opId = runners.get(OLD)!.starts[0]!.opId;
    restart();
    const error = await run.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // Nothing recorded a stop, so the text does not claim one.
    expectOutcomeUnknown(error, { startConfirmed: true, stopRequested: false });
    expect(adoptions).toEqual([]);
    controller.cancel(error);
    let quiescent = false;
    const quiescence = controller.waitForQuiescence().then(() => {
      quiescent = true;
    });
    // Nothing proves the command ended, so cleanup keeps waiting for it.
    await Bun.sleep(300);
    expect(quiescent).toBe(false);
    expect(runners.get(OLD)!.runs.get(opId)?.exit.cancelled).not.toBe(true);
    // The old agent was still alive and answers again: the stop reaches it.
    returnOld();
    await quiescence;
    expect(runners.get(OLD)!.runs.get(opId)?.exit.cancelled).toBe(true);
  });

  test("a re-admission that outlasts the exec's deadline is never sent", async () => {
    let restarted = false;
    const context = rig({
      execTimeoutMs: 150,
      // The re-admission (admission 2, after the first admission and the
      // revalidation before the first start) takes longer than the time the
      // exec has left.
      admissionDelayMs: (call) => (call === 2 ? 200 : 0),
      onRequest: (request) => {
        if (request.op?.$case === "opStart" && !restarted) {
          restarted = true;
          context.restart();
        }
      },
    });
    const { session, runners, requests } = context;
    const startedAt = Date.now();
    const error = await runWithToolCallCorrelation("call_readmit_late", () =>
      session.exec({ cmd: "touch once" }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // It never ran anywhere, and says so.
    expect(String(error)).toMatch(/so it did not run/);
    expect(Date.now() - startedAt).toBeLessThan(400);
    await Bun.sleep(100);
    expect(
      requests.filter((r) => r.request.op?.$case === "opStart").map((r) => r.instance),
    ).toEqual([OLD]);
    expect([...runners.get(NEW)!.runs.keys()]).toEqual([]);
  });

  test("a re-admitted start gets only the time its exec has left", async () => {
    let restarted = false;
    const context = rig({
      execTimeoutMs: 1_000,
      // The re-admission takes 300 ms of the exec's time.
      admissionDelayMs: (call) => (call === 2 ? 300 : 0),
      onRequest: (request) => {
        if (request.op?.$case === "opStart" && !restarted) {
          restarted = true;
          context.restart();
        }
      },
    });
    const { session, runners, requests } = context;
    runners.get(NEW)!.script("call_readmit_left:0", { frames: [], exit: { exitCode: 0 } });
    await runWithToolCallCorrelation("call_readmit_left", () => session.exec({ cmd: "true" }));
    const starts = requests.filter((r) => r.request.op?.$case === "opStart");
    expect(starts.map((r) => r.instance)).toEqual([OLD, NEW]);
    const [first, second] = starts.map((r) =>
      r.request.op?.$case === "opStart" && r.request.op.opStart.op?.$case === "exec"
        ? r.request.op.opStart.op.exec.timeoutMs
        : -1,
    );
    expect(first).toBeGreaterThan(900);
    expect(second).toBeLessThanOrEqual(700);
    expect(second).toBeGreaterThan(0);
  });

  test("a start whose admission check outlasts the deadline is never sent", async () => {
    const { session, requests } = rig({
      execTimeoutMs: 150,
      // The revalidation just before the first start outlasts the exec.
      admissionDelayMs: (call) => (call === 1 ? 200 : 0),
    });
    const error = await runWithToolCallCorrelation("call_late_check", () =>
      session.exec({ cmd: "touch once" }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(String(error)).toMatch(/did not respond in time/);
    await Bun.sleep(100);
    expect(requests.filter((r) => r.request.op?.$case === "opStart")).toEqual([]);
  });

  test("a deadline spent before any start leaves nothing to stop or wait for", async () => {
    const context = rig({
      execTimeoutMs: 150,
      ledger: "failing",
      // The revalidation just before the first start outlasts the exec.
      admissionDelayMs: (call) => (call === 1 ? 200 : 0),
    });
    const { session, requests, restart } = context;
    const controller = createTurnToolCancellationController(new AbortController().signal);
    const error = await controller.runSandboxCommandStructured(session, { cmd: "touch once" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error instanceof SelfhostedControlError && error.neverSent).toBe(true);
    // Its agent is gone: nothing may wait on it for an op that never existed.
    restart();
    controller.cancel(error);
    const quiescent = await Promise.race([
      controller.waitForQuiescence().then(() => true),
      Bun.sleep(1_500).then(() => false),
    ]);
    expect(quiescent).toBe(true);
    expect(
      requests.filter((r) =>
        ["opStart", "opAttach", "opCancel", "opQuery"].includes(r.request.op?.$case ?? ""),
      ),
    ).toEqual([]);
  });

  test("a recovery read replaced before any agent acknowledged the op does not say it ran", async () => {
    const { restart, oldClient } = rig();
    const client = oldClient();
    restart();
    const error = await client
      .readExisting("unacknowledged:0", 50, async () => {})
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectOutcomeUnknown(error, { startConfirmed: false, stopRequested: false });
  });

  test("a recovery read keeps the start acknowledgement its client saw", async () => {
    const { runners, restart, oldClient } = rig();
    const client = oldClient();
    const opId = "acknowledged:0";
    runners.get(OLD)!.script(opId, { frames: [], live: true, holdUntilCancel: true });
    const exec = ExecRequest.fromPartial({ command: ["sleep 600"], shell: true });
    const running = await client.execWithYield(opId, exec, 60_000, 0, {
      yieldMs: 50,
      onYield: () => {},
    });
    expect(running.status).toBe("running");
    restart();
    const error = await client
      .readExisting(opId, 50, async () => {})
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectOutcomeUnknown(error, { startConfirmed: true, stopRequested: false });
  });

  test("a start that never reached the old agent runs once on the new one", async () => {
    let restarted = false;
    const context = rig({
      onRequest: (request) => {
        // The agent restarts before its start arrives.
        if (request.op?.$case === "opStart" && !restarted) {
          restarted = true;
          context.restart();
        }
      },
    });
    const { session, runners, requests, adoptions } = context;
    const opId = "call_restart_start:0";
    runners.get(NEW)!.script(opId, {
      frames: [{ channel: "stdout", bytes: "ran on the new agent" }],
      exit: { exitCode: 0 },
    });

    const result = await runWithToolCallCorrelation("call_restart_start", () =>
      session.exec({ cmd: "echo hi" }),
    );
    expect(result.stdout).toBe("ran on the new agent");
    expect(runners.get(OLD)!.runs.has(opId)).toBe(false);
    expect(runners.get(NEW)!.runs.get(opId)?.startCount).toBe(1);
    // The first start kept its own destination; the second went to the new one.
    expect(
      requests.filter((r) => r.request.op?.$case === "opStart").map((r) => r.instance),
    ).toEqual([OLD, NEW]);
    expect(adoptions).toEqual([]);
  });
});

describe("an exec whose start outlives its wall", () => {
  function directClient(
    revalidate: () => Promise<void>,
    subscribeDelayMs = 0,
    /** Answers an OpStart attempt (0-based) instead of the runner. */
    answerStart?: (attempt: number) => Promise<ControlResponse | undefined>,
  ) {
    const frames = new InMemoryOpStreamTransport();
    // Subscription setup that takes `subscribeDelayMs`, as a slow bus does.
    const transport: OpStreamTransport = {
      subscribe: async (subject, onMessage) => {
        if (subscribeDelayMs > 0) await Bun.sleep(subscribeDelayMs);
        return await frames.subscribe(subject, onMessage);
      },
      publish: async (subject, payload) => await frames.publish(subject, payload),
    };
    const runner = new FakeOpRunner({
      transport: frames,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: OLD,
    });
    const starts: ControlRequest[] = [];
    const client = new OpStreamExecClient({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      connectionInstanceId: OLD,
      epoch: 0,
      rpcSubject: `agent.${WORKSPACE}.${AGENT}.connection.${OLD}.rpc`,
      controlRpc: {
        request: async (subject, request, opts) => {
          if (request.op?.$case === "opStart") {
            starts.push(request);
            const answer = await answerStart?.(starts.length - 1);
            if (answer) return answer;
          }
          return await runner.request(subject, request, opts);
        },
      },
      transport,
      controlTimeoutMs: 1_000,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      revalidateBeforeStartRetry: revalidate,
    });
    return { client, runner, starts };
  }

  test("a start whose revalidation outlasts the wall never runs", async () => {
    const { client, runner, starts } = directClient(() => Bun.sleep(150));
    const exec = ExecRequest.fromPartial({ command: ["touch once"], shell: true });
    const error = await client.exec("wall_start:0", exec, 50, 80).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(String(error)).toMatch(/did not respond in time/);
    // No OpStart was ever sent: provably not run, so nothing keeps custody.
    expect(error instanceof SelfhostedControlError && error.neverSent).toBe(true);
    await Bun.sleep(200);
    expect(starts).toEqual([]);
    expect(runner.runs.has("wall_start:0")).toBe(false);
  });

  test("a start whose subscription setup outlasts the deadline is never sent", async () => {
    const { client, runner, starts } = directClient(async () => {}, 120);
    const exec = ExecRequest.fromPartial({ command: ["touch once"], shell: true });
    // The wall is far later: only the deadline itself refuses the start.
    const error = await client.exec("slow_subscribe:0", exec, 50, 5_000).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(String(error)).toMatch(/did not respond in time/);
    expect(error instanceof SelfhostedControlError && error.neverSent).toBe(true);
    await Bun.sleep(100);
    expect(starts).toEqual([]);
    expect(runner.runs.has("slow_subscribe:0")).toBe(false);
  });

  test("a deadline after a start that may have arrived keeps the outcome uncertain", async () => {
    // The first start times out unanswered (it may have reached the agent);
    // the deadline passes before the retry.
    const { client, starts } = directClient(
      async () => {},
      0,
      async (attempt) => {
        if (attempt > 0) return undefined;
        await Bun.sleep(100);
        return ControlResponse.fromPartial({ error: timeoutAgentError() });
      },
    );
    const exec = ExecRequest.fromPartial({ command: ["touch once"], shell: true });
    const error = await client.exec("maybe_sent:0", exec, 50, 5_000).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(String(error)).toMatch(/did not respond in time/);
    expect(error instanceof SelfhostedControlError && error.neverSent).toBe(false);
    expect(starts).toHaveLength(1);
  });

  test("subscription setup does not extend the start's absolute deadline", async () => {
    const { client, runner, starts } = directClient(async () => {}, 80);
    runner.script("slow_subscribe_ok:0", { frames: [], exit: { exitCode: 0 } });
    const exec = ExecRequest.fromPartial({ command: ["true"], shell: true });
    const before = Date.now();
    await client.exec("slow_subscribe_ok:0", exec, 1_000, 5_000);
    const [start] = starts;
    const deadline = start?.op?.$case === "opStart" ? Number(start.op.opStart.deadlineMs) : NaN;
    expect(deadline).toBeGreaterThanOrEqual(before + 1_000);
    // Fixed when the exec began, not after its 80 ms subscription setup.
    expect(deadline).toBeLessThan(before + 1_000 + 40);
  });

  test("a retried start keeps its first absolute deadline", async () => {
    const { client, runner, starts } = directClient(() => Bun.sleep(20));
    runner.script("retried_start:0", { frames: [], exit: { exitCode: 0 }, drainingStarts: 2 });
    const exec = ExecRequest.fromPartial({ command: ["true"], shell: true });
    await client.exec("retried_start:0", exec, 5_000, 10_000);
    const deadlines = starts.map((start) =>
      start.op?.$case === "opStart" ? start.op.opStart.deadlineMs : "",
    );
    expect(deadlines).toHaveLength(3);
    expect(new Set(deadlines).size).toBe(1);
  });
});

function expectOutcomeUnknown(
  error: unknown,
  expected: { startConfirmed: boolean; stopRequested: boolean },
): void {
  const text = String(error);
  const outcome = expected.startConfirmed
    ? "The machine's agent was replaced while this command was running, so its outcome is " +
      "unknown: it may still be running, or it may have finished."
    : "The machine's agent was replaced before this command's outcome was known: it may " +
      "not have started, may still be running, or may have finished.";
  expect(text).toContain(outcome);
  if (expected.stopRequested) {
    expect(text).toContain(`${outcome} A stop has been requested for it.`);
  } else {
    expect(text).not.toMatch(/stop has been requested/);
  }
  if (!expected.startConfirmed) expect(text).not.toMatch(/while this command was running/);
  expect(text).not.toMatch(/did not survive|did not run/);
}

describe("an exec whose start is held by a link that ends", () => {
  // As a direct terminal exec runs on a compute sandbox whose host link drops:
  // its start sits on the link that ended, the caller gives up, and the same
  // agent comes back on a new link without ever having seen the start.
  function linkLoss(order: "stop first" | "start first") {
    let lost = false;
    let restored = false;
    const stopSeen = Promise.withResolvers<void>();
    const context = rig({
      controlTimeoutMs: 400,
      execTimeoutMs: 0,
      goneHolds: true,
      ledger: "direct",
      defaultScript: () => ({ frames: [], exit: { exitCode: 0 } }),
      onRequest: async (request) => {
        if (request.op?.$case === "opCancel") stopSeen.resolve();
        if (request.op?.$case === "opStart" && !lost) {
          lost = true;
          context.loseHost();
          setTimeout(() => {
            restored = true;
            context.relink();
          }, 1_000);
        }
        // The agent gets the stop before the retried start.
        if (order === "stop first" && request.op?.$case === "opStart" && restored) {
          await stopSeen.promise;
          await Bun.sleep(20);
        }
      },
    });
    return context;
  }

  test("a stop that reaches the agent before its start settles the command: it never ran", async () => {
    const { session, runners, requests } = linkLoss("stop first");
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    // The caller gives up while the start is still unanswered.
    const timer = setTimeout(() => abort.abort(new Error("timed out")), 1_200);
    try {
      const error = await controller
        .runSandboxCommandStructured(session, { cmd: "touch once", yieldTimeMs: 1_200 })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeDefined();
      const settledAt = Date.now();
      controller.cancel(error);
      // The agent's tombstone proves the op never began and never can: the
      // drain ends instead of waiting for frames that will never come.
      await controller.waitForQuiescence();
      expect(Date.now() - settledAt).toBeLessThan(1_000);
    } finally {
      clearTimeout(timer);
    }
    const runner = runners.get(OLD)!;
    expect(runner.starts).toEqual([]);
    expect(runner.runs.size).toBe(0);
    // No probing storm after the proof.
    expect(requests.filter((r) => r.request.op?.$case === "opAttach").length).toBeLessThan(10);
  });

  test("a start that reaches the agent first runs once", async () => {
    const { session, runners } = linkLoss("start first");
    const controller = createTurnToolCancellationController(new AbortController().signal);
    const result = await controller.runSandboxCommandStructured(session, {
      cmd: "touch once",
      yieldTimeMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    await controller.waitForQuiescence();
    expect(runners.get(OLD)!.starts).toHaveLength(1);
  });

  test("a read of an op the agent tombstoned completes as cancelled, with no output", async () => {
    const { oldClient, runners } = rig();
    const opId = "call_tombstoned:0";
    // Cancelled before it ever began on this connection.
    await runners.get(OLD)!.request(
      `agent.${WORKSPACE}.${AGENT}.connection.${OLD}.rpc`,
      ControlRequest.fromPartial({
        requestId: "cancel",
        op: { $case: "opCancel", opCancel: { opId } },
      }),
      { timeoutMs: 1_000 },
    );
    const read = await oldClient().readExisting(opId, 250, async () => {});
    expect(read.status).toBe("completed");
    if (read.status !== "completed") throw new Error("not completed");
    expect(read.outcome.terminalExit?.cancelled).toBe(true);
    expect(read.outcome.response.stdout.byteLength).toBe(0);
    expect(read).not.toHaveProperty("outputReceipt");
  });

  test("a tombstone is no evidence the command began: a later replaced read keeps it unconfirmed", async () => {
    const { oldClient, runners, restart } = rig();
    const client = oldClient();
    const opId = "call_tombstoned_then_replaced:0";
    await runners.get(OLD)!.request(
      `agent.${WORKSPACE}.${AGENT}.connection.${OLD}.rpc`,
      ControlRequest.fromPartial({
        requestId: "cancel",
        op: { $case: "opCancel", opCancel: { opId } },
      }),
      { timeoutMs: 1_000 },
    );
    // An attach-only read meets the tombstone.
    expect((await client.readExisting(opId, 250, async () => {})).status).toBe("completed");
    restart();
    const error = await client
      .readExisting(opId, 50, async () => {})
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectOutcomeUnknown(error, { startConfirmed: false, stopRequested: false });
  });
});

describe("a terminal exec whose deadline passes while its agent is unreachable", () => {
  // A terminal exec's deadline cancels its command. Exit 124 says the deadline
  // ended it, so it needs proof that it did; past the deadline, a command whose
  // agent was replaced before that proof came gets the same unknown outcome as
  // any request on a replaced connection.
  const holding = (exec: ExecRequest): FakeOpScript =>
    exec.command.join(" ").includes("sleep 600")
      ? { frames: [], live: true, holdUntilCancel: true }
      : { frames: [], exit: { exitCode: 0 } };

  for (const unreachable of ["host lost", "agent offline"] as const) {
    test(`${unreachable}, then replaced: the outcome is unknown, not exit 124`, async () => {
      const context = rig({
        // A lost host holds requests; an offline agent has no responders.
        goneHolds: unreachable === "host lost",
        controlTimeoutMs: 30_000,
        execTimeoutMs: 60_000,
        defaultScript: holding,
      });
      const { session, runners, adoptions } = context;
      const response = new SandboxChannelAService({ session }).terminalExec({
        command: "sleep 600",
        cwd: "",
        timeoutMs: 300,
        emitStream: false,
      });
      const started = () =>
        runners
          .get(OLD)!
          .starts.find((start) => start.exec.command.join(" ").includes("sleep 600"));
      await until(() => started() !== undefined);
      const opId = started()!.opId;
      context.loseHost();
      // The deadline passes; its cancellation cannot reach the agent.
      await Bun.sleep(600);
      context.restart();
      const startedAt = Date.now();
      const error = await response.then(
        (made) => made,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SelfhostedControlError);
      expect(String(error)).not.toMatch(/exceeded/);
      expectOutcomeUnknown(error, { startConfirmed: true, stopRequested: true });
      expect(adoptions).toEqual([
        expect.objectContaining({ connectionInstanceId: OLD, opId, abandoned: true }),
      ]);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(runners.get(NEW)!.runs.has(opId)).toBe(false);
    });
  }

  test("a deadline that provably ended the command is exit 124", async () => {
    const { session, runners, adoptions } = rig({ defaultScript: holding });
    const made = await new SandboxChannelAService({ session }).terminalExec({
      command: "sleep 600",
      cwd: "",
      timeoutMs: 300,
      emitStream: false,
    });
    expect(made).toMatchObject({ exitCode: 124, running: false });
    expect(made.stderr).toBe("Terminal command exceeded 300ms");
    const run = [...runners.get(OLD)!.runs.values()].find((entry) => entry.exit.cancelled);
    expect(run).toBeDefined();
    expect(adoptions).toEqual([]);
  });
});
