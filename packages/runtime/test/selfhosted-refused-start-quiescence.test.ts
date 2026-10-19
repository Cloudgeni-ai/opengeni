import { expect, test } from "bun:test";
import { shell } from "@openai/agents/sandbox";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ErrorCode,
  OpExit,
  OpState,
  OpLostReason,
  OpStatus,
  type ControlRequest,
} from "@opengeni/agent-proto";
import { runWithToolCallCorrelation } from "../src/sandbox/op-correlation";
import { SelfhostedControlError } from "../src/sandbox/selfhosted/control-rpc";
import { FakeOpRunner, InMemoryOpStreamTransport } from "../src/sandbox/selfhosted/op-testing";
import { OpTombstonedError } from "../src/sandbox/selfhosted/op-stream";
import { SelfhostedSession } from "../src/sandbox/selfhosted/session";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";

test.each(["sdk", "lifecycle"] as const)(
  "a refused spawn releases the %s turn fence without waiting for nonexistent output frames",
  async (surface) => {
    const transport = new InMemoryOpStreamTransport();
    const runner = new FakeOpRunner({
      transport,
      workspaceId: "workspace",
      agentId: "agent",
      connectionInstanceId: "connection",
    });
    let opId = "";
    let recovery = false;
    const requests: ControlRequest[] = [];
    const session = new SelfhostedSession({
      workspaceId: "workspace",
      workspaceRoot: "/project",
      agentId: "agent",
      connectionInstanceId: "connection",
      relay: { host: "relay.test" },
      timeoutMs: 500,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      opStream: { transport, ackIntervalMs: 20, silenceTimeoutMs: 120, reconnectHoldMs: 600 },
      controlRpc: {
        request: async (subject, request, options) => {
          requests.push(request);
          if (request.op?.$case === "opStart") {
            opId = request.requestId;
            return {
              requestId: request.requestId,
              result: undefined,
              error: {
                code: ErrorCode.ERROR_CODE_NOT_FOUND,
                message: "exec working directory /missing: not found",
                retryable: false,
                detail: {},
              },
            };
          }
          // Match the real runner's SpawnFailed record: COMPLETE, watermark zero,
          // an empty typed exit, and no pump that could ever publish a frame.
          if (!recovery)
            return {
              requestId: request.requestId,
              error: undefined,
              result: {
                $case: "opStatus" as const,
                opStatus: {
                  opId,
                  state: OpState.OP_STATE_COMPLETE,
                  nextSeq: "1",
                  writeOffset: "0",
                  lostReason: 0,
                  exit: OpExit.fromPartial({
                    exitCode: -1,
                    failureCode: "OP_PIPE_IO",
                    failureDetail: { io_error: "spawn failed: missing directory" },
                    totals: { stdout: "0", stderr: "0" },
                    digests: {
                      stdout: bytesToHex(blake3(new Uint8Array())),
                      stderr: bytesToHex(blake3(new Uint8Array())),
                    },
                  }),
                },
              },
            };
          // Test cleanup only: give an unfixed client a terminal frame so a red
          // assertion cannot leave its cancellation polling alive in the suite.
          if (!runner.runs.has(opId)) {
            runner.script(opId, { frames: [], exit: { exitCode: -1 } });
            await runner.request(
              subject,
              {
                ...request,
                requestId: opId,
                op: {
                  $case: "opStart",
                  opStart: {
                    op: {
                      $case: "exec",
                      exec: {
                        command: ["fixture-only"],
                        shell: true,
                        cwd: "/project",
                        env: {},
                        stdin: new Uint8Array(),
                        timeoutMs: 0,
                      },
                    },
                    windowBytes: "1048576",
                    deadlineMs: "0",
                    originId: "test",
                  },
                },
              },
              options,
            );
          }
          return runner.request(subject, request, options);
        },
      },
    });
    const controller = createTurnToolCancellationController();
    try {
      if (surface === "lifecycle") {
        await expect(
          controller.runSandboxCommand(session, { cmd: "never starts", workdir: "/missing" }),
        ).rejects.toThrow("exec working directory /missing: not found");
      } else {
        const exec = shell({ configureTools: (tools) => controller.wrapTools(tools, session) })
          .clone()
          .bind(session)
          .tools()
          .find((t) => t.type === "function" && t.name === "exec_command");
        if (!exec || exec.type !== "function") throw Error("Missing exec tool");
        const result = await exec.invoke(
          {} as never,
          JSON.stringify({ cmd: "never starts", workdir: "/missing" }),
          {
            toolCall: {
              type: "function_call",
              callId: "call_refused",
              name: "exec_command",
              arguments: "{}",
            },
          },
        );
        expect(String(result)).toBe(
          "An error occurred while running the tool. Please try again. Error: SelfhostedControlError: exec working directory /missing: not found",
        );
      }
      const drained = await Promise.race([
        controller.waitForQuiescence().then(() => true),
        Bun.sleep(300).then(() => false),
      ]);
      expect(drained).toBe(true);
      expect(requests.filter((r) => r.op?.$case === "opStart")).toHaveLength(1);
      expect(requests.filter((r) => r.op?.$case === "opQuery")).toHaveLength(1);
      expect(requests.filter((r) => r.op?.$case === "opAttach")).toHaveLength(0);
      expect(custodySizes(session)).toEqual([0, 0]);
    } finally {
      recovery = true;
      await controller.waitForQuiescence();
    }
  },
  5_000,
);

function custodySizes(session: SelfhostedSession) {
  const custody = session as unknown as {
    inFlightOpStreamClients: Map<string, unknown>;
    inFlightOpStreamOutput: Map<string, unknown>;
  };
  return [custody.inFlightOpStreamClients.size, custody.inFlightOpStreamOutput.size];
}

function failedSpawnStatus(): OpStatus {
  return OpStatus.fromPartial({
    opId: "proof:0",
    state: OpState.OP_STATE_COMPLETE,
    nextSeq: "1",
    exit: { exitCode: -1, failureCode: "OP_PIPE_IO", totals: { stdout: "0", stderr: "0" } },
  });
}

test.each([
  ["failed spawn", {}, true],
  [
    "cancel tombstone",
    { nextSeq: "0", exit: OpExit.fromPartial({ cancelled: true, exitCode: -1 }) },
    true,
  ],
  ["running", { state: OpState.OP_STATE_RUNNING }, false],
  [
    "restarted",
    { state: OpState.OP_STATE_LOST, lostReason: OpLostReason.OP_LOST_REASON_AGENT_RESTARTED },
    false,
  ],
  [
    "evicted",
    { state: OpState.OP_STATE_LOST, lostReason: OpLostReason.OP_LOST_REASON_EVICTED },
    false,
  ],
  ["stored frames", { nextSeq: "2" }, false],
  [
    "nonzero output",
    {
      exit: OpExit.fromPartial({ failureCode: "OP_PIPE_IO", totals: { stdout: "1", stderr: "0" } }),
    },
    false,
  ],
  ["missing exit", { exit: undefined }, false],
  ["wrong identity", { opId: "another:0" }, false],
  ["query fails", null, false],
] as const)(
  "only exact zero-frame terminal proof releases custody: %s",
  async (_name, override, proven) => {
    const original = new SelfhostedControlError({
      code: ErrorCode.ERROR_CODE_NOT_FOUND,
      message: "original spawn refusal",
      reason: null,
      retryable: false,
    });
    const requests: ControlRequest[] = [];
    const subjects: string[] = [];
    const released: string[] = [];
    const session = new SelfhostedSession({
      workspaceId: "workspace",
      workspaceRoot: "/project",
      agentId: "agent",
      connectionInstanceId: "connection",
      relay: { host: "relay.test" },
      timeoutMs: 100,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      opStream: { transport: new InMemoryOpStreamTransport() },
      controlRpc: {
        request: async (subject, request) => {
          requests.push(request);
          subjects.push(subject);
          if (request.op?.$case === "opStart") throw original;
          if (override === null) throw new Error("query unavailable");
          return {
            requestId: request.requestId,
            error: undefined,
            result: {
              $case: "opStatus",
              opStatus: { ...failedSpawnStatus(), ...override },
            },
          };
        },
      },
    });
    let caught: unknown;
    await runWithToolCallCorrelation(
      "proof",
      async () => {
        try {
          await session.execCommand({ cmd: "refused", workdir: "/missing" });
        } catch (error) {
          caught = error;
        }
      },
      { onRemoteOperationNotDispatched: (opId) => released.push(opId) },
    );
    expect(caught).toBe(original);
    expect(released).toEqual(proven ? ["proof:0"] : []);
    expect(custodySizes(session)).toEqual(proven ? [0, 0] : [1, 1]);
    expect(requests.map((r) => r.op?.$case)).toEqual(["opStart", "opQuery"]);
    expect(requests[1]?.epoch).toBe(0);
    expect(subjects[1]).toBe(subjects[0]);
  },
);

test.each([
  ["a tombstone", { nextSeq: "0" }, true],
  // Negative control: a cancelled record that has stored a frame is not a
  // tombstone, so the start refusal alone proves nothing.
  ["a cancelled record with frames", { nextSeq: "1" }, false],
] as const)(
  "a start refused with %s releases custody only on the tombstone's own proof",
  async (_name, override, tombstone) => {
    const requests: ControlRequest[] = [];
    const released: string[] = [];
    const session = new SelfhostedSession({
      workspaceId: "workspace",
      workspaceRoot: "/project",
      agentId: "agent",
      connectionInstanceId: "connection",
      relay: { host: "relay.test" },
      timeoutMs: 100,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      opStream: { transport: new InMemoryOpStreamTransport() },
      controlRpc: {
        request: async (_subject, request) => {
          requests.push(request);
          const cancelled = OpStatus.fromPartial({
            opId: "proof:0",
            state: OpState.OP_STATE_COMPLETE,
            exit: { cancelled: true, exitCode: -1 },
            ...override,
          });
          if (request.op?.$case === "opStart") {
            return {
              requestId: request.requestId,
              error: undefined,
              result: { $case: "opStart", opStart: { accepted: false, status: cancelled } },
            };
          }
          return {
            requestId: request.requestId,
            error: undefined,
            result: {
              $case: "opStatus",
              opStatus: OpStatus.fromPartial({ opId: "proof:0", state: OpState.OP_STATE_RUNNING }),
            },
          };
        },
      },
    });
    let caught: unknown;
    await runWithToolCallCorrelation(
      "proof",
      async () => {
        try {
          await session.execCommand({ cmd: "cancelled" });
        } catch (error) {
          caught = error;
        }
      },
      { onRemoteOperationNotDispatched: (opId) => released.push(opId) },
    );
    expect((caught as Error).message).toBe(
      "The command was cancelled before the machine admitted it.",
    );
    expect(caught instanceof OpTombstonedError).toBe(tombstone);
    expect(requests.map((r) => r.op?.$case)).toEqual(
      tombstone ? ["opStart"] : ["opStart", "opQuery"],
    );
    expect(released).toEqual(tombstone ? ["proof:0"] : []);
    expect(custodySizes(session)).toEqual(tombstone ? [0, 0] : [1, 1]);
  },
);

test.each(["unsupported", "offline", "never sent", "reconnecting"] as const)(
  "failed-start proof preserves %s handling",
  async (kind) => {
    const original = new SelfhostedControlError({
      code:
        kind === "unsupported" ? ErrorCode.ERROR_CODE_UNSUPPORTED : ErrorCode.ERROR_CODE_TIMEOUT,
      message: "original refusal",
      reason: kind === "reconnecting" ? "agent_reconnecting" : null,
      retryable: false,
      agentOffline: kind === "offline",
      neverSent: kind === "never sent",
    });
    const requests: ControlRequest[] = [];
    const released: string[] = [];
    const session = new SelfhostedSession({
      workspaceId: "workspace",
      workspaceRoot: "/project",
      agentId: "agent",
      connectionInstanceId: "connection",
      relay: { host: "relay.test" },
      timeoutMs: 100,
      retryClock: { sleep: async () => {}, jitter: () => 0.5 },
      opStream: { transport: new InMemoryOpStreamTransport() },
      controlRpc: {
        request: async (_subject, request) => {
          requests.push(request);
          if (request.op?.$case === "opStart") throw original;
          return {
            requestId: request.requestId,
            error: undefined,
            result: { $case: "opStatus", opStatus: failedSpawnStatus() },
          };
        },
      },
    });
    let caught: unknown;
    await runWithToolCallCorrelation(
      "proof",
      async () => {
        try {
          await session.execCommand({ cmd: "refused" });
        } catch (error) {
          caught = error;
        }
      },
      { onRemoteOperationNotDispatched: (opId) => released.push(opId) },
    );
    if (kind === "never sent") {
      // No OpStart reached any agent: nothing ran, so custody is released
      // without asking a runner that never saw the op.
      expect(caught).toBe(original);
      expect(requests.every((r) => r.op?.$case === "opStart")).toBe(true);
      expect(custodySizes(session)).toEqual([0, 0]);
    } else if (kind === "unsupported") {
      expect(caught).toBeInstanceOf(SelfhostedControlError);
      expect((caught as Error).message).toBe(
        "This Connected Machine does not advertise the streaming command protocol required for exec. Update and reconnect the Opengeni agent. The command was not started.",
      );
      expect(requests.map((r) => r.op?.$case)).toEqual(["opStart", "opQuery"]);
      expect(released).toEqual(["proof:0"]);
      expect(custodySizes(session)).toEqual([0, 0]);
    } else {
      expect(caught).toBe(original);
      expect(requests.every((r) => r.op?.$case === "opStart")).toBe(true);
      expect(released).toEqual([]);
      expect(custodySizes(session)).toEqual([1, 1]);
    }
  },
);
