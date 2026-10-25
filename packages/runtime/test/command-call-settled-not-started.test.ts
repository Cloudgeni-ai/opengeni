// An attempt that ends while a command call is still waiting for its sandbox
// (being created, or failed to come up) settles that call as not started, so
// Retry stays available, and the call never reaches a sandbox that comes up
// later. A call that reached its sandbox, or never asked for it, is left to
// the ordinary outcome-unknown settlement.

import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { buildAgentCapabilities } from "../src/index";
import {
  RoutingSandboxSession,
  createTurnToolCancellationController,
  type TurnToolCancellationFence,
  type RoutableBackendSession,
} from "../src/sandbox";
import { RoutedCallSettledNotStartedError } from "../src/sandbox/routing/routed-call-scope";

function lazySandbox() {
  const sent: string[] = [];
  const home: RoutableBackendSession = {
    state: { manifest: { root: "/workspace" } },
    exec: async (args: unknown) => {
      sent.push((args as { cmd: string }).cmd);
      return { stdout: "ran", exitCode: 0 };
    },
    execCommand: async (args: unknown) => {
      sent.push((args as { cmd: string }).cmd);
      return "Process exited with code 0\n\nOutput:\nran";
    },
  };
  let comeUp!: () => void;
  let fail!: (error: Error) => void;
  let provisioning: Promise<void> = new Promise<void>((resolve, reject) => {
    comeUp = resolve;
    fail = reject;
  });
  const proxy = new RoutingSandboxSession({
    defaultResolved: {
      session: { state: { manifest: { root: "/workspace" } } } as RoutableBackendSession,
      sandboxId: null,
      kind: "unprovisioned",
    },
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => {
      await provisioning;
      return { session: home, sandboxId: null, kind: "modal" };
    },
  });
  return {
    proxy,
    sent,
    comeUp: () => comeUp(),
    fail: (error: Error) => fail(error),
    ready: () => {
      provisioning = Promise.resolve();
    },
  };
}

function functionTool(name: string, invoke: () => Promise<unknown>) {
  return {
    type: "function" as const,
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    strict: false,
    invoke: async () => await invoke(),
  };
}

const call = (callId: string) => ({ toolCall: { callId } });

describe("a command call that ends waiting for its sandbox", () => {
  test("the production exec_command is settled while its sandbox is created", async () => {
    const sandbox = lazySandbox();
    let fence: TurnToolCancellationFence | null = null;
    const caps = buildAgentCapabilities(testSettings({ sandboxBackend: "modal" }), [], {
      turnCancellationSignal: new AbortController().signal,
      onToolCancellationFence: (created) => {
        fence = created;
      },
    });
    const exec = caps
      .find((cap) => cap.type === "shell")!
      .clone()
      .bind(sandbox.proxy as never)
      .tools()
      .find((candidate) => candidate.name === "exec_command");
    if (!exec || exec.type !== "function") throw new Error("No shell tool");
    const toolCall = {
      type: "function_call" as const,
      callId: "call-exec",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "make" }),
    };
    const running = exec
      .invoke({} as never, toolCall.arguments, { toolCall } as never)
      .catch((error: unknown) => error);
    await Bun.sleep(5);
    expect(fence!.settleCommandCallsNotStarted!()).toEqual(["call-exec"]);
    sandbox.comeUp();
    await running;
    expect(sandbox.sent).toEqual([]);
  });

  test("is settled as not started and never reaches the sandbox that comes up", async () => {
    const sandbox = lazySandbox();
    const controller = createTurnToolCancellationController();
    const [exec] = controller.wrapTools([
      functionTool("exec_command", () => sandbox.proxy.exec({ cmd: "make" })),
    ]);
    const running = exec!.invoke({}, "{}", call("call-waiting") as never);
    await Bun.sleep(0);
    expect(controller.settleCommandCallsNotStarted()).toEqual(["call-waiting"]);
    sandbox.comeUp();
    await expect(running).rejects.toBeInstanceOf(RoutedCallSettledNotStartedError);
    expect(sandbox.sent).toEqual([]);
    // Settling again names it again; nothing else changes.
    expect(controller.settleCommandCallsNotStarted()).toEqual(["call-waiting"]);
  });

  test("is settled as not started when its sandbox failed to come up", async () => {
    const sandbox = lazySandbox();
    const controller = createTurnToolCancellationController();
    const [exec] = controller.wrapTools([
      functionTool("exec_command", () => sandbox.proxy.exec({ cmd: "make" })),
    ]);
    const running = exec!.invoke({}, "{}", call("call-failed") as never);
    sandbox.fail(new Error("the sandbox did not start"));
    await expect(running).rejects.toThrow("the sandbox did not start");
    expect(controller.settleCommandCallsNotStarted()).toEqual(["call-failed"]);
    expect(sandbox.sent).toEqual([]);
  });

  test("a call that reached its sandbox is not settled", async () => {
    const sandbox = lazySandbox();
    sandbox.ready();
    const controller = createTurnToolCancellationController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const [exec] = controller.wrapTools([
      functionTool("exec_command", async () => {
        await sandbox.proxy.exec({ cmd: "first" });
        await held;
        return await sandbox.proxy.exec({ cmd: "second" });
      }),
    ]);
    const running = exec!.invoke({}, "{}", call("call-ran") as never);
    await Bun.sleep(0);
    expect(sandbox.sent).toEqual(["first"]);
    expect(controller.settleCommandCallsNotStarted()).toEqual([]);
    release();
    await running;
    expect(sandbox.sent).toEqual(["first", "second"]);
  });

  test("calls that never asked for the sandbox, and other tools, are not settled", async () => {
    const sandbox = lazySandbox();
    const controller = createTurnToolCancellationController();
    const never = new Promise<never>(() => undefined);
    const [notYet, other] = controller.wrapTools([
      functionTool("exec_command", () => never),
      functionTool("write_stdin", () => sandbox.proxy.exec({ cmd: "stdin" })),
    ]);
    void notYet!.invoke({}, "{}", call("call-not-yet") as never);
    void other!.invoke({}, "{}", call("call-stdin") as never);
    await Bun.sleep(0);
    expect(controller.settleCommandCallsNotStarted()).toEqual([]);
    sandbox.comeUp();
  });
});
