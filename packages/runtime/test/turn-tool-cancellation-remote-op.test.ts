import { describe, expect, test } from "bun:test";
import type { Tool } from "@openai/agents";
import { shell } from "@openai/agents/sandbox";
import { ErrorCode, OpFrame, type ControlRequest, type ExecRequest } from "@opengeni/agent-proto";
import { SelfhostedControlError, type ControlRpc } from "../src/sandbox/selfhosted/control-rpc";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
  type FakeOpScript,
} from "../src/sandbox/selfhosted/op-testing";
import { SelfhostedSession, type SelfhostedSessionDeps } from "../src/sandbox/selfhosted/session";
import { SandboxChannelAService } from "../src/sandbox/channel-a";
import {
  createTurnToolCancellationController,
  TurnSandboxCommandCancelledError,
} from "../src/sandbox/turn-tool-cancellation";

const WORKSPACE = "remote-custody-workspace";
const AGENT = "remote-custody-agent";
const CONNECTION = "remote-custody-connection";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    Bun.sleep(25).then(() => true),
  ]);
}

function makeRig(input: {
  beforeRequest?: (request: ControlRequest) => void | Promise<void>;
  defaultScript?: (exec: ExecRequest, opId: string) => FakeOpScript | Promise<FakeOpScript>;
  sessionDeps?: Pick<
    SelfhostedSessionDeps,
    "adoptBackgroundCommand" | "resolveOperationAdmission" | "execTimeoutMs"
  >;
}) {
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    transport,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    connectionInstanceId: CONNECTION,
    ...(input.defaultScript ? { defaultScript: input.defaultScript } : {}),
  });
  const requests: ControlRequest[] = [];
  const controlRpc: ControlRpc = {
    request: async (subject, request, options) => {
      requests.push(request);
      await input.beforeRequest?.(request);
      return await runner.request(subject, request, options);
    },
  };
  const session = new SelfhostedSession({
    workspaceId: WORKSPACE,
    workspaceRoot: "/workspace",
    agentId: AGENT,
    connectionInstanceId: CONNECTION,
    relay: { host: "relay.test", tls: true },
    controlRpc,
    timeoutMs: 100,
    execTimeoutMs: 5_000,
    retryClock: { sleep: async () => {}, jitter: () => 0.5 },
    opStream: {
      transport,
      ackIntervalMs: 10,
      silenceTimeoutMs: 100,
      reconnectHoldMs: 600,
    },
    ...input.sessionDeps,
  });
  return { transport, runner, requests, session };
}

function sdkExec(
  controller: ReturnType<typeof createTurnToolCancellationController>,
  session: SelfhostedSession,
): Extract<Tool<unknown>, { type: "function" }> {
  const exec = shell({ configureTools: (tools) => controller.wrapTools(tools, session) })
    .clone()
    .bind(session)
    .tools()
    .find(
      (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
        tool.type === "function" && tool.name === "exec_command",
    );
  if (!exec) throw new Error("SDK shell did not expose exec_command");
  return exec;
}

function opIdFromStart(request: ControlRequest): string | null {
  return request.op?.$case === "opStart" ? request.requestId : null;
}

describe("remote synchronous command custody", () => {
  test.each(["synchronous", "model"] as const)(
    "trusted local admission refusal settles an unstarted %s command with no RPC",
    async (mode) => {
      let admissionCalls = 0;
      const rig = makeRig({
        sessionDeps: {
          resolveOperationAdmission: async () => {
            admissionCalls++;
            return null;
          },
        },
      });
      const controller = createTurnToolCancellationController();

      if (mode === "synchronous") {
        await expect(
          controller.runSandboxCommandSynchronous(rig.session, { cmd: "must not start" }),
        ).rejects.toThrow("no authoritative live runner connection");
      } else {
        const result = await sdkExec(controller, rig.session).invoke(
          {} as never,
          JSON.stringify({ cmd: "must not start" }),
          {
            toolCall: {
              type: "function_call",
              callId: "unstarted_model",
              name: "exec_command",
              arguments: "{}",
            },
          },
        );
        expect(result).toContain("no authoritative live runner connection");
      }

      const drain = controller.waitForQuiescence();
      expect(await remainsPending(drain)).toBe(false);
      await drain;
      expect(admissionCalls).toBe(1);
      expect(rig.requests).toEqual([]);
      expect(rig.runner.starts).toEqual([]);
      expect(rig.runner.runs.size).toBe(0);
      expect(rig.transport.decodedAcks()).toEqual([]);
    },
  );

  test("failed durable transfer keeps exact cleanup joined until cancellation recovers", async () => {
    let cancellationAvailable = false;
    let adoptionAttempts = 0;
    const rig = makeRig({
      beforeRequest: (request) => {
        if (request.op?.$case === "opCancel" && !cancellationAvailable) {
          throw new Error("cancellation receipt unavailable");
        }
      },
      defaultScript: () => ({
        frames: [{ channel: "stdout", bytes: "retained during failed transfer" }],
        live: true,
        holdUntilCancel: true,
      }),
      sessionDeps: {
        execTimeoutMs: 0,
        adoptBackgroundCommand: async () => {
          adoptionAttempts++;
          throw new Error("adoption did not commit");
        },
      },
    });
    const controller = createTurnToolCancellationController();
    const opId = "failed_transfer:0";
    try {
      const result = await sdkExec(controller, rig.session).invoke(
        {} as never,
        JSON.stringify({ cmd: "long running command", yield_time_ms: 1 }),
        {
          toolCall: {
            type: "function_call",
            callId: "failed_transfer",
            name: "exec_command",
            arguments: "{}",
          },
        },
      );
      expect(result).toContain("cancellation receipt unavailable");
      expect(adoptionAttempts).toBe(1);
      expect(rig.runner.starts.map((start) => start.opId)).toEqual([opId]);
      expect(rig.runner.runs.get(opId)?.exit.cancelled).toBe(false);

      const drain = controller.waitForQuiescence();
      expect(await remainsPending(drain)).toBe(true);
      expect(rig.runner.runs.get(opId)?.exit.cancelled).toBe(false);
      cancellationAvailable = true;
      await drain;

      const run = rig.runner.runs.get(opId)!;
      expect(run.exit.cancelled).toBe(true);
      expect(run.startCount).toBe(1);
      expect(run.finalAcked).toBe(false);
      expect(run.acks.some((ack) => ack.final)).toBe(false);
      expect(run.frames.some((frame) => frame.body?.$case === "data")).toBe(true);
      expect(
        rig.requests
          .filter((request) => request.op?.$case === "opCancel")
          .every(
            (request) => request.op?.$case === "opCancel" && request.op.opCancel.opId === opId,
          ),
      ).toBe(true);
      expect(rig.runner.starts).toHaveLength(1);
    } finally {
      cancellationAvailable = true;
      await rig.session.cancelExecCommand(opId);
    }
  });

  test("pending durable transfer stays joined without cancelling a committed background command", async () => {
    const adoptionStarted = deferred();
    const releaseAdoption = deferred();
    let adoptionCommits = 0;
    const commandId = "11111111-1111-4111-8111-111111111111";
    const opId = "committed_transfer:0";
    const rig = makeRig({
      defaultScript: () => ({ frames: [], live: true, holdUntilCancel: true }),
      sessionDeps: {
        execTimeoutMs: 0,
        adoptBackgroundCommand: async () => {
          adoptionStarted.resolve();
          await releaseAdoption.promise;
          adoptionCommits++;
          return { commandId };
        },
      },
    });
    const controller = createTurnToolCancellationController();
    const invocation = sdkExec(controller, rig.session).invoke(
      {} as never,
      JSON.stringify({ cmd: "long running command", yield_time_ms: 1 }),
      {
        toolCall: {
          type: "function_call",
          callId: "committed_transfer",
          name: "exec_command",
          arguments: "{}",
        },
      },
    );
    await adoptionStarted.promise;
    const drain = controller.waitForQuiescence();
    expect(await remainsPending(drain)).toBe(true);
    expect(rig.requests.some((request) => request.op?.$case === "opCancel")).toBe(false);
    releaseAdoption.resolve();
    const result = await invocation;
    await drain;

    expect(result).toContain(`command ID ${commandId}`);
    expect(adoptionCommits).toBe(1);
    expect(rig.runner.starts.map((start) => start.opId)).toEqual([opId]);
    expect(rig.runner.runs.get(opId)?.exit.cancelled).toBe(false);
    expect(rig.requests.some((request) => request.op?.$case === "opCancel")).toBe(false);
    expect(rig.runner.runs.get(opId)?.finalAcked).toBe(false);
    await rig.session.cancelExecCommand(opId);
  });

  test("recovers exact terminal output after an observation transport loss without restarting", async () => {
    let failFirstAttach = true;
    const rig = makeRig({
      beforeRequest: (request) => {
        if (request.op?.$case === "opAttach" && failFirstAttach) {
          failFirstAttach = false;
          throw new Error("temporary attach loss");
        }
      },
      defaultScript: () => ({
        frames: [
          { channel: "stdout", bytes: "recovered stdout\n" },
          { channel: "stderr", bytes: "recovered stderr\n" },
        ],
        exit: { exitCode: 0 },
      }),
    });
    const controller = createTurnToolCancellationController();

    const result = await controller.runSandboxCommandSynchronous(rig.session, {
      cmd: "print captured output",
    });
    await controller.waitForQuiescence();

    expect(result).toMatchObject({
      stdout: "recovered stdout\n",
      stderr: "recovered stderr\n",
      exitCode: 0,
    });
    expect(rig.runner.starts).toHaveLength(1);
    const opId = rig.runner.starts[0]!.opId;
    expect(rig.requests.filter((request) => request.op?.$case === "opAttach")).not.toHaveLength(0);
    expect(rig.requests.map(opIdFromStart).filter((id): id is string => id !== null)).toEqual([
      opId,
    ]);
    expect(rig.runner.runs.get(opId)?.finalAcked).toBe(false);
    expect(rig.runner.runs.get(opId)?.acks.some((ack) => ack.final)).toBe(false);
  });

  test.each([false, true])(
    "keeps quiescence closed after lost observation until the same op is terminal (cancelled first: %s)",
    async (cancelBeforeFirstAttachReturns) => {
      const firstAttachEntered = deferred();
      const firstAttachRelease = deferred();
      let failAttachments = true;
      let attachCount = 0;
      const rig = makeRig({
        beforeRequest: async (request) => {
          if (request.op?.$case !== "opAttach") return;
          attachCount += 1;
          if (cancelBeforeFirstAttachReturns && attachCount === 1) {
            firstAttachEntered.resolve();
            await firstAttachRelease.promise;
          }
          if (failAttachments)
            throw new SelfhostedControlError({
              message: "observer temporarily unavailable",
              code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
              reason: "agent_offline",
              retryable: false,
              agentOffline: true,
            });
        },
        defaultScript: () => ({
          frames: [{ channel: "stdout", bytes: "retained-before-terminal" }],
          live: true,
          holdUntilCancel: true,
        }),
      });
      const abort = new AbortController();
      const controller = createTurnToolCancellationController(abort.signal);
      const operation = controller.runSandboxCommandSynchronous(rig.session, {
        cmd: "long running command",
      });
      void operation.catch(() => undefined);

      await waitFor(() => rig.runner.starts.length === 1, "the original OpStart");
      const opId = rig.runner.starts[0]!.opId;
      if (cancelBeforeFirstAttachReturns) {
        await firstAttachEntered.promise;
        abort.abort(new Error("cancelled while attach was pending"));
        const drain = controller.waitForQuiescence();
        firstAttachRelease.resolve();
        await expect(operation).rejects.toBeInstanceOf(TurnSandboxCommandCancelledError);
        await waitFor(
          () => rig.runner.runs.get(opId)?.exit.cancelled === true,
          "runner cancellation of the accepted op",
        );
        expect(await remainsPending(drain)).toBe(true);
        failAttachments = false;
        await drain;
      } else {
        await expect(operation).rejects.toThrow("observer temporarily unavailable");
        abort.abort(new Error("cancelled after observation loss"));
        const drain = controller.waitForQuiescence();
        await waitFor(
          () => rig.runner.runs.get(opId)?.exit.cancelled === true,
          "runner cancellation of the accepted op",
        );
        expect(await remainsPending(drain)).toBe(true);
        failAttachments = false;
        await drain;
      }

      const run = rig.runner.runs.get(opId)!;
      expect(rig.runner.starts.map((start) => start.opId)).toEqual([opId]);
      expect(rig.requests.filter((request) => request.op?.$case === "opStart")).toHaveLength(1);
      expect(
        rig.requests
          .filter((request) => request.op?.$case === "opAttach")
          .every(
            (request) => request.op?.$case === "opAttach" && request.op.opAttach.opId === opId,
          ),
      ).toBe(true);
      expect(run.exit.cancelled).toBe(true);
      expect(run.finalAcked).toBe(false);
      expect(run.acks.some((ack) => ack.final)).toBe(false);
      expect(run.frames.some((frame) => frame.body?.$case === "data")).toBe(true);
    },
  );

  test("model exec keeps the same remote custody after its initial observer fails", async () => {
    let failAttachments = true;
    const rig = makeRig({
      beforeRequest: (request) => {
        if (request.op?.$case === "opAttach" && failAttachments) {
          throw new Error("model command observer unavailable");
        }
      },
      defaultScript: () => ({
        frames: [{ channel: "stdout", bytes: "model command retained" }],
        live: true,
        holdUntilCancel: true,
      }),
    });
    const abort = new AbortController();
    const controller = createTurnToolCancellationController(abort.signal);
    const execTool = {
      type: "function" as const,
      name: "exec_command",
      description: "test exec command",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      strict: false,
      needsApproval: async () => false,
      invoke: async (_context: unknown, input: string) =>
        await rig.session.exec(JSON.parse(input) as { cmd: string }),
    };
    const [wrapped] = controller.wrapTools([execTool], rig.session);
    const invocation = wrapped!.invoke({} as never, JSON.stringify({ cmd: "long command" }));
    await expect(invocation).rejects.toThrow("model command observer unavailable");

    const opId = rig.runner.starts[0]!.opId;
    abort.abort(new Error("turn ended after observer loss"));
    const drain = controller.waitForQuiescence();
    await waitFor(
      () => rig.runner.runs.get(opId)?.exit.cancelled === true,
      "runner cancellation of the model command",
    );
    expect(await remainsPending(drain)).toBe(true);
    failAttachments = false;
    await drain;

    expect(rig.runner.starts.map((start) => start.opId)).toEqual([opId]);
    expect(rig.runner.runs.get(opId)?.finalAcked).toBe(false);
    expect(rig.runner.runs.get(opId)?.acks.some((ack) => ack.final)).toBe(false);
  });

  test.each([
    { exitCode: 0, stdout: "complete output", stderr: "" },
    { exitCode: 7, stdout: "partial output", stderr: "command failed" },
  ])("preserves uncancelled terminal result $exitCode", async ({ exitCode, stdout, stderr }) => {
    const rig = makeRig({
      defaultScript: () => ({
        frames: [
          ...(stdout ? [{ channel: "stdout" as const, bytes: stdout }] : []),
          ...(stderr ? [{ channel: "stderr" as const, bytes: stderr }] : []),
        ],
        exit: { exitCode },
      }),
    });
    const controller = createTurnToolCancellationController();

    const result = await controller.runSandboxCommandSynchronous(rig.session, {
      cmd: "finish normally",
    });
    await controller.waitForQuiescence();

    expect(result).toMatchObject({ stdout, stderr, exitCode });
    expect(rig.runner.starts).toHaveLength(1);
    expect(rig.runner.runs.get(rig.runner.starts[0]!.opId)?.finalAcked).toBe(false);
  });

  test.each([0, 7])(
    "cancellation wins over remote terminal exit %s before Channel-A emits an fs revision",
    async (exitCode) => {
      let finalOpId: string | null = null;
      const heldFrames: Array<{ subject: string; payload: Uint8Array }> = [];
      let releaseFinalFrames = false;
      const rig = makeRig({
        defaultScript: (exec, opId) => {
          const command = exec.command.join(" ");
          if (command.includes("base64 -d >")) {
            finalOpId = opId;
            return { frames: [], exit: { exitCode } };
          }
          return command.includes("__OPENGENI_FS_CONFINED_OK__")
            ? {
                frames: [{ channel: "stdout", bytes: "__OPENGENI_FS_CONFINED_OK__" }],
                exit: { exitCode: 0 },
              }
            : { frames: [], exit: { exitCode: 0 } };
        },
      });
      const deliver = rig.transport.deliver.bind(rig.transport);
      rig.transport.deliver = (subject, payload) => {
        const frame = OpFrame.decode(payload);
        if (frame.opId === finalOpId && !releaseFinalFrames) {
          heldFrames.push({ subject, payload });
          return;
        }
        deliver(subject, payload);
      };
      const abort = new AbortController();
      const controller = createTurnToolCancellationController(abort.signal);
      const events: unknown[] = [];
      const service = new SandboxChannelAService({
        session: rig.session,
        workspaceRoot: "/workspace",
        commandRunner: (session, args) => controller.runSandboxCommandSynchronous(session, args),
        emit: async (batch) => {
          events.push(...batch);
        },
      });
      const settled = service
        .fsWrite({
          path: "target.txt",
          content: "do not report success after cancellation",
          encoding: "utf8",
          overwrite: true,
          createParents: false,
        })
        .then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );

      await waitFor(() => finalOpId !== null && heldFrames.length > 0, "held terminal frames");
      const originalOpId = finalOpId!;
      abort.abort(new Error("filesystem operation cancelled"));
      await waitFor(
        () =>
          rig.requests.some(
            (request) =>
              request.op?.$case === "opCancel" && request.op.opCancel.opId === originalOpId,
          ),
        "OpCancel for the original filesystem command",
      );
      await waitFor(
        () => (rig.runner.runs.get(originalOpId)?.attachCount ?? 0) >= 2,
        "same-op terminal observer",
      );
      releaseFinalFrames = true;
      for (const frame of heldFrames.splice(0)) deliver(frame.subject, frame.payload);

      const outcome = await settled;
      await controller.waitForQuiescence();
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(TurnSandboxCommandCancelledError);
      }
      expect(events).toEqual([]);
      expect((service as unknown as { revision: number }).revision).toBe(0);
      expect(rig.runner.starts.filter((start) => start.opId === originalOpId)).toHaveLength(1);
      expect(rig.runner.runs.get(originalOpId)?.finalAcked).toBe(false);
    },
  );
});
