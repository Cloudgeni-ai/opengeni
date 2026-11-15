// A command whose machine's agent stops answering: production execs have no
// deadline, and a start was retried for up to its 15-minute resend horizon,
// each attempt waiting out its reply recovery, so the tool call hung with no
// event (staging, 2026-11-04: 11 minutes, until the chat was paused). The op
// stream now stops waiting once the agent has answered nothing for its bound
// and fails the command as offline, in words that say what to do.

import { describe, expect, test } from "bun:test";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  AGENT_UNRESPONSIVE_DETAIL_KEY,
  AGENT_UNRESPONSIVE_MACHINE_DETAIL_KEY,
  AGENT_UNRESPONSIVE_RECOVERY_DETAIL_KEY,
  NatsControlRpc,
  SelfhostedControlError,
} from "../src/sandbox/selfhosted/control-rpc";
import { renderSelfhostedFault } from "../src/sandbox/selfhosted/fault-rendering";
import { FakeOpRunner, InMemoryOpStreamTransport } from "../src/sandbox/selfhosted/op-testing";
import { SelfhostedSession } from "../src/sandbox/selfhosted/session";
import { runWithToolCallCorrelation } from "../src/sandbox/op-correlation";

const WORKSPACE = "ws-offline";
const AGENT = "agent-offline";
const INSTANCE = "connection-1";
const ROOT = "/home/user/project";

function rig(options: {
  /** How the gone agent's requests end: held until they time out (its link is
   *  up, nobody answers) or no responders (its link is gone). */
  gone: "held" | "no responders";
  drainingStarts?: number;
  retrySleepMs?: number;
}) {
  const state = { gone: false };
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    transport,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    connectionInstanceId: INSTANCE,
    defaultScript: () => ({
      frames: [],
      exit: { exitCode: 0 },
      ...(options.drainingStarts ? { drainingStarts: options.drainingStarts } : {}),
    }),
  });
  // As a current agent does: the link carries headers, and the agent issues
  // control replay tokens, so every request gets its reply recovery.
  const controlRpc = new NatsControlRpc(async () => ({
    supportsHeaders: true,
    request: async (subject: string, payload: Uint8Array, opts: { timeout: number }) => {
      const request = ControlRequest.decode(payload);
      if (state.gone) {
        if (options.gone === "held") {
          await Bun.sleep(opts.timeout);
          throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
        }
        throw Object.assign(new Error("503 no responders"), { code: "503" });
      }
      const base = subject.split(".replay.")[0]!;
      const response: ControlResponse =
        request.op?.$case === "ping"
          ? {
              requestId: request.requestId,
              error: undefined,
              result: {
                $case: "ping",
                ping: {
                  nonce: request.op.ping.nonce,
                  agentMonotonicMs: "0",
                  controlReplayTokens:
                    request.op.ping.controlReplayWindowMs !== "0"
                      ? Array.from({ length: 64 }, () => crypto.randomUUID())
                      : [],
                },
              },
            }
          : await runner.request(base, request, { timeoutMs: opts.timeout });
      return {
        data: ControlResponse.encode(response).finish(),
        headers: { get: (name: string) => (name === "Opengeni-Control-Replay" ? "2" : "") },
      };
    },
  }));
  const abandoned: string[] = [];
  const session = new SelfhostedSession({
    workspaceId: WORKSPACE,
    workspaceRoot: ROOT,
    agentId: AGENT,
    connectionInstanceId: INSTANCE,
    controlRpc,
    relay: { host: "relay.test" },
    timeoutMs: 300,
    // Production: no exec deadline.
    execTimeoutMs: 0,
    retryClock: {
      sleep: async () => {
        if (options.retrySleepMs) await Bun.sleep(options.retrySleepMs);
      },
      jitter: () => 0.5,
    },
    resolveOperationAdmission: async () => ({
      connectionInstanceId: INSTANCE,
      workspaceRoot: ROOT,
      operationResourcePolicy: {
        memoryMaxBytes: null,
        memoryHighBytes: null,
        cpuMaxMillicores: null,
        revision: 1,
      },
      operationResourcePolicySupported: true,
      operationCpuQuotaSupported: true,
      opStream: {
        transport,
        ackIntervalMs: 20,
        silenceTimeoutMs: 120,
        reconnectHoldMs: 600,
        startUnansweredMs: 1_000,
      },
    }),
    abandonCommand: async (input) => {
      abandoned.push(input.opId);
      return { commandId: `command-${abandoned.length}` };
    },
    opStream: { transport, ackIntervalMs: 20, silenceTimeoutMs: 120, reconnectHoldMs: 600 },
  });
  return { session, state, runner, abandoned };
}

async function execWithin(session: SelfhostedSession, cmd: string, ms: number) {
  const startedAt = Date.now();
  const outcome = await Promise.race([
    runWithToolCallCorrelation(`call_${crypto.randomUUID()}`, () => session.exec({ cmd })).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    ),
    Bun.sleep(ms).then(() => ({ stillWaiting: true as const })),
  ]);
  return { outcome, elapsedMs: Date.now() - startedAt };
}

describe("a command whose Connected Machine stops answering", () => {
  test("fails as offline after the unanswered bound when its link holds every request", async () => {
    const { session, state } = rig({ gone: "held" });
    const first = await execWithin(session, "echo hi", 10_000);
    expect(first.outcome).toMatchObject({ result: { exitCode: 0 } });
    // The machine goes to sleep, or its agent is killed and never restarts,
    // while its link stays up: nothing answers and nothing says no.
    state.gone = true;
    const { outcome, elapsedMs } = await execWithin(session, "echo alive-4", 12_000);
    expect(outcome).not.toHaveProperty("stillWaiting");
    expect(outcome).toHaveProperty("error");
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(SelfhostedControlError);
    const control = error as SelfhostedControlError;
    expect(control.agentOffline).toBe(true);
    expect(Number(control.detail[AGENT_UNRESPONSIVE_DETAIL_KEY])).toBeGreaterThanOrEqual(1_000);
    expect(control.detail[AGENT_UNRESPONSIVE_MACHINE_DETAIL_KEY]).toBe("connected_machine");
    // A Connected Machine is the person's own: never restarted.
    expect(control.detail[AGENT_UNRESPONSIVE_RECOVERY_DETAIL_KEY]).toBe("none");
    expect(elapsedMs).toBeLessThan(6_000);
    const text = renderSelfhostedFault(control);
    expect(text).toContain("the person's machine stopped responding");
    expect(text).toContain("check that their machine is on, awake and connected");
  }, 30_000);

  test("a machine nobody listens for ends at the bound too, with the offline words", async () => {
    const { session, state } = rig({ gone: "no responders" });
    expect((await execWithin(session, "echo hi", 10_000)).outcome).toHaveProperty("result");
    state.gone = true;
    const { outcome, elapsedMs } = await execWithin(session, "echo alive-4", 12_000);
    const error = (outcome as { error: SelfhostedControlError }).error;
    expect(error).toBeInstanceOf(SelfhostedControlError);
    expect(error.agentOffline).toBe(true);
    expect(error.detail[AGENT_UNRESPONSIVE_DETAIL_KEY]).toBeDefined();
    // The control link keeps the start in flight, retrying it, until the
    // bound: whether it reached the agent is not known, so it is never
    // reported as not run.
    expect(error.neverSent).toBe(false);
    expect(elapsedMs).toBeGreaterThanOrEqual(1_000);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(renderSelfhostedFault(error)).toContain("the person's machine stopped responding");
  }, 30_000);

  test("a start held in flight is handed to the ledger with a stop request", async () => {
    const { session, state, abandoned } = rig({ gone: "held" });
    expect((await execWithin(session, "echo hi", 10_000)).outcome).toHaveProperty("result");
    state.gone = true;
    const { outcome } = await execWithin(session, "touch once", 12_000);
    const error = (outcome as { error: SelfhostedControlError }).error;
    expect(error).toBeInstanceOf(SelfhostedControlError);
    // The start may have reached the agent: its outcome is unknown, never
    // "did not run", and its stop is recorded for when the agent answers.
    expect(error.neverSent).toBe(false);
    expect(abandoned).toHaveLength(1);
    const text = renderSelfhostedFault(error, { connectedMachine: true });
    expect(text).toContain(
      "unknown — the command may have started before the machine stopped answering.",
    );
    // The command may itself have stopped the agent, so the words say so,
    // as the offline-during-command words do.
    expect(text).toContain("or this or an earlier command may have stopped the Opengeni agent");
    expect(text).toContain("don't re-run a command that stops or deletes the Opengeni agent");
  }, 30_000);

  test("a busy agent that keeps answering is waited for past the bound", async () => {
    // Six DRAINING answers 400 ms apart: 2.4 s, well past the 1 s bound.
    const { session } = rig({ gone: "held", drainingStarts: 6, retrySleepMs: 400 });
    const { outcome, elapsedMs } = await execWithin(session, "echo busy", 12_000);
    expect(outcome).toMatchObject({ result: { exitCode: 0 } });
    expect(elapsedMs).toBeGreaterThan(2_000);
  }, 30_000);
});

describe("the words a command whose workspace machine stopped answering gets", () => {
  function unresponsive(recovery: string, neverSent: boolean): SelfhostedControlError {
    return new SelfhostedControlError({
      message: "the agent did not answer for 180s",
      code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
      reason: "agent_offline",
      retryable: false,
      agentOffline: true,
      neverSent,
      detail: {
        [AGENT_UNRESPONSIVE_DETAIL_KEY]: "180000",
        [AGENT_UNRESPONSIVE_MACHINE_DETAIL_KEY]: "compute",
        [AGENT_UNRESPONSIVE_RECOVERY_DETAIL_KEY]: recovery,
      },
    });
  }

  test("restarted", () => {
    const text = renderSelfhostedFault(unresponsive("restarted", false));
    expect(text).toContain(
      "this chat's workspace machine stopped responding and didn't come back. It was restarted; re-run the command.",
    );
    expect(text).toContain("did not answer for 3 minutes");
    expect(text).toContain("If it had started, the restart stopped it.");
    // Not named for a Connected Machine, and the same when routed as an
    // Opengeni-owned box.
    expect(text).not.toStartWith("[connected machine]");
    expect(
      renderSelfhostedFault(unresponsive("restarted", false), { workspaceMachine: true }),
    ).toBe(text);
  });

  test("already restarted this turn", () => {
    const text = renderSelfhostedFault(unresponsive("already_restarted", true));
    expect(text).toContain("already restarted once this turn");
    expect(text).toContain("a new chat gets a fresh workspace machine");
    // A box restarted moments ago may still be booting: one re-run first.
    expect(text).toContain(
      "if the restart was only just made, wait a moment and re-run the command once",
    );
    expect(text).toContain("This command never reached it.");
  });

  test("host busy moving or saving it", () => {
    const text = renderSelfhostedFault(unresponsive("host_busy", true));
    expect(text).toContain("is being moved or saved by its host");
    expect(text).toContain("so it was not restarted");
    expect(text).toContain("wait a couple of minutes, then re-run the command");
  });

  test("restart failed", () => {
    expect(renderSelfhostedFault(unresponsive("restart_failed", true))).toContain(
      "restarting it failed",
    );
  });

  test("the compute service could not carry out or confirm the restart", () => {
    const text = renderSelfhostedFault(unresponsive("host_unavailable", false));
    expect(text).toContain("a restart could not be carried out or confirmed");
    // A 503 does not prove the restart did not happen, nor that the box runs
    // on (its host may be lost): the words hedge both.
    expect(text).toContain("probably not restarted");
    expect(text).toContain("If its host is only restarting its own agent, the machine runs on");
    expect(text).not.toContain("the machine keeps running");
    expect(text).toContain("check running commands with command_read");
    expect(text).not.toContain("restarting it failed");
  });

  test("answering again", () => {
    expect(renderSelfhostedFault(unresponsive("answering", true))).toContain("is answering again");
    // A start that may have reached it may still be running, or be stopping:
    // the words never promise either.
    expect(renderSelfhostedFault(unresponsive("answering", false))).toContain(
      "If it started, it may still be running, or it may be being stopped.",
    );
  });

  test("restarting", () => {
    const text = renderSelfhostedFault(unresponsive("restarting", false));
    expect(text).toContain("A restart was requested; re-run the command in a moment.");
    expect(text).toContain("If it had started, the restart stops it.");
  });

  test("no restart could be arranged", () => {
    const text = renderSelfhostedFault(unresponsive("restart_unavailable", true));
    expect(text).toContain("it could not be restarted");
    expect(text).toContain("so none was made");
  });

  test("a Connected Machine the command never reached is only offline", () => {
    const error = new SelfhostedControlError({
      message: "the agent did not answer for 180s",
      code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
      reason: "agent_offline",
      retryable: false,
      agentOffline: true,
      neverSent: true,
      detail: {
        [AGENT_UNRESPONSIVE_DETAIL_KEY]: "180000",
        [AGENT_UNRESPONSIVE_MACHINE_DETAIL_KEY]: "connected_machine",
        [AGENT_UNRESPONSIVE_RECOVERY_DETAIL_KEY]: "none",
      },
    });
    const text = renderSelfhostedFault(error, { connectedMachine: true });
    expect(text).toContain("the person's machine stopped responding");
    expect(text).toContain("nothing ran; the command never reached the machine.");
    expect(text).toContain("check that it is on, awake and connected, then re-run the command");
    expect(text).not.toContain("may have stopped the Opengeni agent");
  });

  test("without the machine kind, the routed context names the box", () => {
    const error = new SelfhostedControlError({
      message: "the agent did not answer for 180s",
      code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
      reason: "agent_offline",
      retryable: false,
      agentOffline: true,
      neverSent: true,
      detail: { [AGENT_UNRESPONSIVE_DETAIL_KEY]: "180000" },
    });
    expect(renderSelfhostedFault(error, { workspaceMachine: true })).toContain(
      "this chat's workspace machine stopped responding",
    );
    expect(renderSelfhostedFault(error, { connectedMachine: true })).toContain(
      "the person's machine stopped responding",
    );
  });
});
