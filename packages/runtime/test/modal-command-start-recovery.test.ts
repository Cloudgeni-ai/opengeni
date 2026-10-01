import { expect, test } from "bun:test";
import {
  Agent,
  Runner,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { createRequire } from "node:module";
import { status as Status } from "@grpc/grpc-js";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { buildAgentCapabilities, type TurnToolCancellationFence } from "../src/index";
import {
  ProviderCommandStartOutcomeUnknownError,
  type ProviderCommandPersistence,
  type ProviderCommandSession,
} from "../src/sandbox/provider-command-session";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import {
  ModalCommandRouterWire,
  ModalCommandStartNotDispatchedError,
} from "../src/sandbox/providers/modal-command-router-wire";
import { isModalTaskExecStartPreDispatchUnavailableError } from "../src/sandbox/providers/modal";
import {
  RoutingMutationOutcomeUnknownError,
  RoutingSandboxSession,
  type RoutingSandboxSessionDeps,
} from "../src/sandbox/routing/routing-session";
import type { ChannelASession } from "../src/sandbox/channel-a";

const path = "/modal.task_command_router.TaskCommandRouter/TaskExecStart";
const dns = "Name resolution failed for target dns:task-72zioucmtnmt4av4osz7bk19t.w.modal.host";
// Resolve Modal's actual dependency without introducing a second nice-grpc pin.
const { ClientError } = createRequire(import.meta.resolve("modal"))("nice-grpc") as {
  ClientError: new (path: string, code: number, details: string) => Error;
};

function fixture(cause: unknown) {
  const command: ModalRouterProviderCommand = {
    kind: "modal-router-v1",
    sandboxId: "sb-original",
    taskId: "task-original",
    execId: crypto.randomUUID(),
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
  let starts = 0;
  let promotions = 0;
  let promotionUnavailable = false;
  let stored = command;
  const settlements: Array<Parameters<NonNullable<RoutingSandboxSessionDeps["afterMutation"]>>[0]> =
    [];
  const terminalProofs: unknown[] = [];
  const backend: ChannelASession & ProviderCommandSession = { supportsPty: () => true };
  installModalCommandSession(backend, {
    start: async () => {
      starts++;
      throw new ProviderCommandStartOutcomeUnknownError(command, cause);
    },
    read: async (value) => {
      expect(value.execId).toBe(command.execId);
      const next = structuredClone(command);
      for (const stream of ["stdout", "stderr"] as const)
        next.streams[stream] = { ...next.streams[stream], eof: true, exitCode: 0 };
      return {
        command: next,
        expected: value as ModalRouterProviderCommand,
        exitCode: 0,
        chunks: [],
      };
    },
    readProbe: async () => {
      throw new Error("not a materialization operation");
    },
    write: async () => {
      throw new Error("inspection must not mutate stdin");
    },
  });
  const persistence: ProviderCommandPersistence = {
    load: async () => stored,
    acknowledge: async (value) => value,
    reserveInput: async () => {
      throw new Error("inspection must not reserve stdin");
    },
    captureRouterPage: async (page) => {
      stored = page.command;
      return { command: stored, captured: true };
    },
  };
  const routed = new RoutingSandboxSession({
    defaultResolved: {
      session: backend,
      sandboxId: null,
      kind: "modal",
      leaseEpoch: 3,
      providerInstanceId: command.sandboxId,
      activeEpoch: 0,
    },
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async (pointer) => {
      expect(pointer).toEqual({ activeSandboxId: null, activeEpoch: 0 });
      return {
        session: backend,
        sandboxId: null,
        kind: "modal",
        leaseEpoch: 3,
        providerInstanceId: command.sandboxId,
      };
    },
    beforeMutation: async () => "admission",
    providerCommandHandle: () => 41,
    providerCommandPersistence: () => persistence,
    afterMutation: async (input) => {
      settlements.push(input);
      promotions++;
      if (promotionUnavailable) throw new Error("settlement unavailable");
      expect(input.outcome).toBe("outcome_unknown");
      expect(input.retainedProcess?.providerCommand).toEqual(command);
    },
    settleProcess: async (input) => {
      terminalProofs.push(input.proof);
    },
  });
  return {
    routed,
    command,
    settlements,
    terminalProofs,
    starts: () => starts,
    promotions: () => promotions,
    failPromotion: (value: boolean) => {
      promotionUnavailable = value;
    },
  };
}

test("real nice-grpc Start error shapes retain exact invocation instead of rejected settlement", async () => {
  for (const details of [dns, `${dns}:443`, "Connection dropped", "Deadline exceeded"]) {
    const cause = new ClientError(
      path,
      details === "Deadline exceeded" ? Status.DEADLINE_EXCEEDED : Status.UNAVAILABLE,
      details,
    );
    const f = fixture(cause);
    const failure = await f.routed.execCommand({ cmd: "once", tty: true }).catch((error) => error);
    expect(failure).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    expect(failure.cause.cause).toBe(cause);
    expect(isModalTaskExecStartPreDispatchUnavailableError(failure)).toBe(false);
    expect(f.starts()).toBe(1);
    expect(f.settlements).toHaveLength(1);
    expect(f.routed.hasRetainedProcess(41)).toBe(true);
    expect(f.terminalProofs).toHaveLength(0);
    expect(
      await f.routed.writeStdinForProcessRead({ sessionId: 41, chars: "", yieldTimeMs: 0 }),
    ).toContain("Process exited with code 0");
    expect(f.starts()).toBe(1);
    expect(f.terminalProofs).toEqual([
      { outcome: "exited", exitCode: 0, reason: "provider_exit_banner" },
    ]);
    expect(f.routed.hasRetainedProcess(41)).toBe(false);
  }
});

test("failed outcome-unknown promotion retries only settlement, preserving locator and never Start", async () => {
  const f = fixture(new ClientError(path, Status.UNAVAILABLE, dns));
  f.failPromotion(true);
  const failure = await f.routed.execCommand({ cmd: "once" }).catch((error) => error);
  expect(failure).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
  expect(f.routed.hasRetainedProcess(41)).toBe(true);
  expect(f.terminalProofs).toHaveLength(0);
  f.failPromotion(false);
  expect(
    await f.routed.writeStdinForProcessRead({ sessionId: 41, chars: "", yieldTimeMs: 0 }),
  ).toContain("Process exited with code 0");
  expect(f.starts()).toBe(1);
  expect(f.promotions()).toBe(2);
  expect(f.settlements[0]!.retainedProcess).toEqual(f.settlements[1]!.retainedProcess);
});

test("production shell delivers unknown Start to model and continues the same agent run", async () => {
  const f = fixture(new ClientError(path, Status.UNAVAILABLE, dns));
  let fence: TurnToolCancellationFence | undefined;
  const caps = buildAgentCapabilities(testSettings({ sandboxBackend: "modal" }), [], {
    onToolCancellationFence: (value) => {
      fence = value;
    },
  });
  const shell = caps.find((capability) => capability.type === "shell")!;
  const tools = shell
    .clone()
    .bind(f.routed as never)
    .tools();
  const requests: ModelRequest[] = [];
  const outputs: ModelResponse["output"][] = [
    [
      {
        type: "function_call",
        callId: "start-once",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "once", tty: false, yield_time_ms: 0 }),
      },
    ],
    [
      {
        type: "function_call",
        callId: "inspect-only",
        name: "write_stdin",
        arguments: JSON.stringify({ session_id: 41, chars: "", yield_time_ms: 0 }),
      },
    ],
    [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Inspection completed without replay." }],
      },
    ],
  ];
  const model: Model = {
    getResponse: async (request) => {
      requests.push(request);
      return { usage: new Usage(), output: outputs[requests.length - 1]! };
    },
    getStreamedResponse: () => {
      throw new Error("not a streaming test");
    },
  };
  const result = await new Runner({ tracingDisabled: true }).run(
    new Agent({ name: "test", model, tools }),
    "Run once and inspect uncertainty.",
  );
  expect(result.finalOutput).toBe("Inspection completed without replay.");
  expect(requests).toHaveLength(3);
  const modelInput = JSON.stringify(requests[1]!.input);
  expect(modelInput).toContain("outcome unknown");
  expect(modelInput).toContain("session_id 41");
  expect(modelInput).toContain("Do not blindly retry");
  expect(modelInput).not.toContain("Please try again");
  expect(f.starts()).toBe(1);
  expect(f.routed.hasRetainedProcess(41)).toBe(false);
  await fence!.waitForQuiescence();
});

test("readiness cancellation and closure settle only the exact never-started supervised reservation", async () => {
  for (const action of ["cancel", "close"] as const) {
    const wire = new ModalCommandRouterWire({
      url: "https://task-test.w.modal.host",
      jwt: "test-token",
    });
    let readyCallback: ((error?: Error) => void) | undefined;
    let enterReady: () => void = () => {};
    const readyEntered = new Promise<void>((resolve) => {
      enterReady = resolve;
    });
    let unaryCalls = 0;
    Object.defineProperty(wire, "client", {
      value: {
        waitForReady: (_deadline: number, callback: (error?: Error) => void) => {
          readyCallback = callback;
          enterReady();
        },
        close: () => {},
      },
    });
    Object.defineProperty(wire, "unary", {
      value: async () => {
        unaryCalls++;
      },
    });
    const control = ModalCommandControl.forSandbox(
      {
        version: () => "0.9.0",
        cpClient: { sandboxGetTaskId: async () => ({ taskId: "task-original" }) },
      } as never,
      "sb-original",
      "/workspace",
    );
    Object.defineProperty(control, "withRouter", {
      value: async (
        _taskId: string,
        _signal: AbortSignal,
        run: (router: ModalCommandRouterWire) => Promise<void>,
      ) => run(wire),
    });
    const backend: ChannelASession & ProviderCommandSession = {};
    installModalCommandSession(backend, {
      start: control.start.bind(control),
      verifySupervisionCapability: async () => ({
        sandboxId: "sb-original",
        taskId: "task-original",
      }),
      read: async () => {
        throw new Error("must not inspect nonexistent invocation");
      },
      readProbe: async () => {
        throw new Error("not a materialization operation");
      },
      write: async () => {
        throw new Error("must not mutate nonexistent invocation");
      },
    });
    let reserved: ModalRouterProviderCommand | null = null;
    let reservations = 0;
    let rejections = 0;
    const persistence: ProviderCommandPersistence = {
      load: async () => reserved,
      acknowledge: async (command) => command,
      reserveInput: async () => 0,
      rejectSupervisedLaunch: async (command) => {
        expect(command).toEqual(reserved!);
        rejections++;
        reserved = null;
      },
    };
    const route = {
      session: backend,
      sandboxId: null,
      kind: "modal",
      providerInstanceId: "sb-original",
      activeEpoch: 0,
    };
    const routed = new RoutingSandboxSession({
      defaultResolved: route,
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => route,
      beforeMutation: async () => "exact-admission",
      providerCommandHandle: () => 41,
      providerSupervisionReady: async () => true,
      providerCommandPersistence: () => persistence,
      afterMutation: async ({ outcome, retainedProcess }) => {
        expect(outcome).toBe("resolved");
        expect(retainedProcess?.providerCommand?.kind).toBe("modal-router-v1");
        reserved = retainedProcess!.providerCommand as ModalRouterProviderCommand;
        reservations++;
      },
    });
    try {
      const result = routed
        .execCommand({ cmd: "must-not-run", tty: false })
        .catch((error) => error);
      await readyEntered;
      if (action === "cancel") await backend.cancelPendingExecCommand!();
      else {
        wire.close();
        readyCallback!(new Error("channel closed during readiness"));
      }
      const error = await result;
      expect(error).toBeInstanceOf(ModalCommandStartNotDispatchedError);
      expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
      expect(unaryCalls).toBe(0);
      expect(reservations).toBe(1);
      expect(rejections).toBe(1);
      expect(reserved).toBeNull();
      expect(routed.hasRetainedProcess(41)).toBe(false);
    } finally {
      wire.close();
      await control.close();
    }
  }
});
