import { expect, test } from "bun:test";
import { ModalBrokerProviderCommand, type NativeBrokerCommandProtocol } from "@opengeni/contracts";
import {
  RoutingSandboxSession,
  type RoutableBackendSession,
} from "../src/sandbox/routing/routing-session";
import {
  admittedCommandSupervisionProtocol,
  admittedProviderCommandHandle,
  reserveSupervisedLaunch,
  withTurnCommandSupervision,
} from "../src/sandbox/provider-command-session";

function fixture(pty: boolean) {
  const commandId = crypto.randomUUID();
  const protocol: NativeBrokerCommandProtocol = pty
    ? "native-subreaper-broker-channel-pty-v1"
    : "native-subreaper-broker-channel-v1";
  const command = ModalBrokerProviderCommand.parse({
    kind: "modal-broker-v1",
    sandboxId: "sb-exact",
    taskId: "ta-exact",
    execId: commandId,
    pty,
    supervision: {
      protocol,
      invocationId: commandId,
      brokerId: crypto.randomUUID(),
      launchRequestId: crypto.randomUUID(),
      launchEpoch: 1,
    },
    capture: { sequence: 0, receiptAckObserved: false },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  });
  const order: string[] = [];
  let retained = false;
  const state = {
    selected: protocol as string,
    ready: true,
    physical: "sb-exact",
    rejectCapability: false,
  };
  const backend: RoutableBackendSession = {
    verifyCommandSupervisionCapability: async (selected) => {
      order.push("capability");
      expect(selected).toBe(protocol);
      if (state.rejectCapability) throw new Error("broker capability unavailable");
      return { sandboxId: state.physical, taskId: "ta-exact" };
    },
    execCommand: async () => {
      order.push("start");
      expect(admittedCommandSupervisionProtocol()).toBe(protocol);
      expect(admittedProviderCommandHandle()).toBe(37);
      await reserveSupervisedLaunch(command);
      return "Process running with session ID 37\n\nOutput:\n";
    },
    bindProviderCommand: (_handle, value) => {
      order.push("bind");
      expect(value).toEqual(command);
    },
    getProviderCommand: () => command,
    getProviderCommandOutput: () => ({ command, chunks: [], exitCode: null }),
    captureCommandOutput: async () => {
      order.push("capture");
      return true;
    },
    releaseSupervisedCommand: async () => {
      order.push("release");
    },
  };
  const resolved = {
    session: backend,
    kind: "modal",
    sandboxId: null,
    activeEpoch: 0,
    providerInstanceId: "sb-exact",
    leaseEpoch: 7,
  };
  const proxy = new RoutingSandboxSession({
    defaultResolved: resolved,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => resolved,
    qualifiedProviderSupervision: async (actual, requested) => {
      order.push("qualification");
      expect(actual).toEqual(resolved);
      expect(requested).toBe(pty ? "native-subreaper-pty-v1" : "native-subreaper-v1");
      return { status: "enrolled", protocol: state.selected as NativeBrokerCommandProtocol };
    },
    requiredProviderSupervisionReady: async (selected) => {
      order.push("database-ready");
      expect(selected).toBe(protocol);
      return state.ready;
    },
    providerSupervisionReady: async () => {
      throw new Error("No legacy fallback");
    },
    providerCommandHandle: () => 37,
    beforeMutation: async () => {
      order.push("admission");
      return { id: crypto.randomUUID() };
    },
    afterMutation: async ({ retainedProcess }) => {
      order.push("reservation");
      expect(retainedProcess?.providerCommand).toEqual(command);
      retained = true;
    },
    providerCommandPersistence: () => ({
      load: async () => (retained ? command : null),
      acknowledge: async () => {
        throw new Error("No legacy ACK");
      },
      reserveInput: async () => {
        throw new Error("No legacy offset allocator");
      },
    }),
  });
  return { proxy, order, state, command };
}

test.each([false, true])(
  "broker pipe/PTY selection precedes capability and durable launch admission (PTY: %s)",
  async (pty) => {
    for (const origin of ["turn", "api", "structured-api"] as const) {
      const f = fixture(pty);
      const run = () =>
        origin === "structured-api"
          ? f.proxy.exec({ cmd: "fixture", tty: pty })
          : f.proxy.execCommand({ cmd: "fixture", tty: pty });
      if (origin === "turn")
        await withTurnCommandSupervision(
          pty ? "native-subreaper-pty-v1" : "native-subreaper-v1",
          run,
        );
      else await run();
      expect(f.order.slice(0, 6)).toEqual([
        "qualification",
        "database-ready",
        "capability",
        "admission",
        "start",
        "reservation",
      ]);
      expect(f.order.indexOf("reservation")).toBeLessThan(f.order.indexOf("release"));
      expect(f.order.indexOf("capture")).toBeLessThan(f.order.indexOf("release"));
      expect(f.proxy.hasRetainedProcess(37)).toBe(true);
      expect(admittedCommandSupervisionProtocol()).toBeUndefined();
    }
  },
);

test("wrong protocol shape, missing gates and physical mismatch cannot admit or fall back", async () => {
  for (const defect of ["shape", "missing", "ready", "physical", "capability", "runAs"] as const) {
    const f = fixture(false);
    if (defect === "shape") f.state.selected = "native-subreaper-broker-channel-pty-v1";
    if (defect === "missing") f.state.selected = "";
    if (defect === "ready") f.state.ready = false;
    if (defect === "physical") f.state.physical = "sb-foreign";
    if (defect === "capability") f.state.rejectCapability = true;
    await expect(
      f.proxy.execCommand({ cmd: "fixture", ...(defect === "runAs" ? { runAs: "root" } : {}) }),
    ).rejects.toThrow();
    expect(f.order).not.toContain("admission");
    expect(f.order).not.toContain("start");
  }
});

test("legacy API commands and non-Modal routes are not implicitly broker-enrolled", async () => {
  for (const kind of ["modal", "selfhosted"] as const) {
    for (const pty of [false, true]) {
      let inspected = 0;
      const resolved = {
        kind,
        sandboxId: null,
        activeEpoch: 0,
        session: {
          execCommand: async () => {
            expect(admittedCommandSupervisionProtocol()).toBeUndefined();
            return "Process exited with code 0\n\nOutput:\n";
          },
        },
      };
      const proxy = new RoutingSandboxSession({
        defaultResolved: resolved,
        readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
        resolveActiveBackend: async () => resolved,
        qualifiedProviderSupervision: async (_backend, requested) => {
          inspected++;
          expect(requested).toBe(pty ? "native-subreaper-pty-v1" : "native-subreaper-v1");
          return { status: "legacy" };
        },
        providerSupervisionReady: async () => false,
        requiredProviderSupervisionReady: async () => {
          throw new Error("No inferred enrollment");
        },
      });
      await proxy.execCommand({ cmd: "fixture", tty: pty });
      expect(inspected).toBe(kind === "modal" ? 1 : 0);
    }
  }
});
