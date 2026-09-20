import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CommandSupervisionReceipt, ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import {
  type ProviderCommandPersistence,
  type ProviderCommandSession,
  withProviderCommandHandle,
} from "../src/sandbox/provider-command-session";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";

function fixture() {
  const invocationId = randomUUID();
  const command: ModalRouterProviderCommand = {
    kind: "modal-router-v1",
    sandboxId: "sb-original",
    taskId: "ta-original",
    execId: randomUUID(),
    supervision: {
      protocol: "native-subreaper-v1",
      invocationId,
      nonce: "a".repeat(64),
      controlPath: `/tmp/opengeni-supervision/${invocationId}.sock`,
    },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
  const receipt: CommandSupervisionReceipt = {
    protocol: "native-subreaper-v1",
    invocationId,
    receiptId: randomUUID(),
    leaderExitCode: 7,
  };
  let retained: ModalRouterProviderCommand | null = null;
  let proof: CommandSupervisionReceipt | null = null;
  let intent = false;
  let quiescent = false;
  let terminal = false;
  let providerExitCode = 0;
  let failProof = false;
  let failAck = false;
  let failCapture = false;
  let controlUnavailable = false;
  const actions: string[] = [];
  const persistence: ProviderCommandPersistence = {
    load: async () => structuredClone(retained),
    acknowledge: async () => {
      throw new Error("not legacy");
    },
    reserveInput: async () => {
      if (intent) throw new Error("cancelled");
      actions.push("stdin-admitted");
      return 0;
    },
    loadSupervisionReceipt: async () => proof,
    recordSupervisionReceipt: async (value) => {
      actions.push("persist-proof");
      if (failProof) throw new Error("database unavailable");
      proof = value;
    },
    requestCancellation: async () => {
      intent = true;
      actions.push("persist-intent");
    },
    cancellationRequested: async () => intent,
    captureRouterPage: async (page) => {
      if (failCapture) throw new Error("capture unavailable");
      retained = page.command;
      actions.push("capture-output");
      return { command: page.command, captured: true };
    },
  };
  const control = {
    start: async () => {
      actions.push("launch-idle");
      return structuredClone(command);
    },
    read: async (current: ModalRouterProviderCommand) => {
      const next = structuredClone(current);
      if (terminal)
        for (const stream of ["stdout", "stderr"] as const)
          next.streams[stream] = { ...next.streams[stream], eof: true, exitCode: providerExitCode };
      return {
        command: next,
        expected: current,
        chunks: [],
        exitCode: terminal ? providerExitCode : null,
      };
    },
    readProbe: async () => {
      throw new Error("unused");
    },
    write: async () => {
      actions.push("stdin-sent");
    },
    supervisionControl: async (_command: unknown, action: string, ackId?: string) => {
      actions.push(action);
      if (controlUnavailable) throw new Error("control unavailable");
      if (action === "cancel") quiescent = true;
      if (action === "ack") {
        expect(proof).toEqual(receipt);
        expect(ackId).toBe(receipt.receiptId);
        if (failAck) throw new Error("ack response lost");
        terminal = true;
      }
      return quiescent ? { state: "quiescent" as const, receipt } : { state: "running" as const };
    },
  };
  function adapter() {
    const session = {} as ChannelASession & ProviderCommandSession;
    installModalCommandSession(session, control as never);
    return session;
  }
  const session = adapter();
  const start = () =>
    withProviderCommandHandle(41, () => session.execCommand!({ cmd: "user code" }));
  const retain = () => {
    retained = structuredClone(command);
    session.bindProviderCommand!(41, command, persistence);
  };
  const read = (target = session) =>
    target.writeStdin!({ sessionId: 41, chars: "", yieldTimeMs: 0 });
  return {
    session,
    start,
    retain,
    read,
    actions,
    command,
    receipt,
    persistence,
    recreate: () => {
      const next = adapter();
      next.bindProviderCommand!(41, retained!, persistence);
      return next;
    },
    quiesce: () => {
      quiescent = true;
    },
    crash: () => {
      terminal = true;
      controlUnavailable = true;
    },
    failSupervisor: () => {
      providerExitCode = 125;
      terminal = true;
      controlUnavailable = true;
    },
    failProof: (value: boolean) => {
      failProof = value;
    },
    failAck: (value: boolean) => {
      failAck = value;
    },
    failCapture: (value: boolean) => {
      failCapture = value;
    },
  };
}

test("idle launch never releases user code before initial retention commits", async () => {
  const f = fixture();
  expect(parseExecBannerSessionId(await f.start())).toBe(41);
  expect(f.actions).toEqual(["launch-idle"]);
  await expect(f.session.releaseSupervisedCommand!(41)).rejects.toThrow(
    "committed initial retention",
  );
  expect(f.actions).toEqual(["launch-idle"]);
  f.retain();
  await f.session.releaseSupervisedCommand!(41);
  expect(f.actions).toEqual(["launch-idle", "release"]);
});

test("natural quiescence persists receipt before ACK and terminal output", async () => {
  const f = fixture();
  await f.start();
  f.retain();
  f.quiesce();
  expect(parseExecBannerExitCode(await f.read())).toBe(7);
  expect(f.actions).toEqual(["launch-idle", "release", "persist-proof", "ack", "capture-output"]);
});

test("lost proof persistence never ACKs and replay recovers on another adapter", async () => {
  const f = fixture();
  await f.start();
  f.retain();
  f.quiesce();
  f.failProof(true);
  expect(parseExecBannerExitCode(await f.read())).toBeNull();
  expect(f.actions).not.toContain("ack");
  f.failProof(false);
  expect(parseExecBannerExitCode(await f.read(f.recreate()))).toBe(7);
  expect(f.actions.filter((action) => action === "persist-proof")).toHaveLength(2);
});

test("proof survives lost ACK and terminal capture failure across adapters", async () => {
  const f = fixture();
  await f.start();
  f.retain();
  f.quiesce();
  f.failAck(true);
  expect(parseExecBannerExitCode(await f.read())).toBeNull();
  f.failAck(false);
  f.failCapture(true);
  await expect(f.read(f.recreate())).rejects.toThrow("capture unavailable");
  f.failCapture(false);
  expect(parseExecBannerExitCode(await f.read(f.recreate()))).toBe(7);
  expect(f.actions.filter((action) => action === "persist-proof")).toHaveLength(1);
});

test("provider terminal without quiescence never exposes completion", async () => {
  const f = fixture();
  await f.start();
  f.retain();
  f.crash();
  expect(parseExecBannerExitCode(await f.read())).toBeNull();
  expect(f.actions).toContain("capture-output");
  expect(f.actions).not.toContain("persist-proof");
});

test("supervisor failure after durable proof is not a successful ACK exit", async () => {
  const f = fixture();
  await f.start();
  f.retain();
  f.quiesce();
  f.failAck(true);
  expect(parseExecBannerExitCode(await f.read())).toBeNull();
  f.failSupervisor();
  expect(parseExecBannerExitCode(await f.read(f.recreate()))).toBeNull();
  expect(f.actions.filter((action) => action === "persist-proof")).toHaveLength(1);
});

test("cancellation commits monotonic intent before signaling and fences subsequent stdin", async () => {
  const f = fixture();
  await f.start();
  f.retain();
  expect(await f.session.cancelSupervisedCommand!(41, "provider_deadline")).toBe(true);
  expect(f.actions.indexOf("persist-intent")).toBeLessThan(f.actions.indexOf("cancel"));
  await expect(
    f.recreate().writeStdin!({ sessionId: 41, chars: "input", yieldTimeMs: 0 }),
  ).rejects.toThrow("cancelled");
  expect(f.actions).not.toContain("stdin-sent");
  expect(parseExecBannerExitCode(await f.read(f.recreate()))).toBe(7);
});

test("a reconstructed handle cannot substitute the immutable supervision identity", async () => {
  const f = fixture();
  await f.start();
  f.retain();
  const forged = structuredClone(f.command);
  forged.supervision!.nonce = "b".repeat(64);
  expect(() => f.session.bindProviderCommand!(41, forged, f.persistence)).toThrow(
    "another execution",
  );
});

test("routing never releases on failed retention and recovers the same invocation", async () => {
  const f = fixture();
  let failRetention = true;
  const backend = { session: f.session, sandboxId: null, kind: "modal", activeEpoch: 0 } as const;
  const routed = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    providerSupervisionReady: async () => true,
    providerCommandHandle: () => 41,
    providerCommandPersistence: () => f.persistence,
    beforeMutation: async () => "admitted",
    afterMutation: async () => {
      if (failRetention) throw new Error("DB unavailable");
      f.retain();
    },
    captureProcessOutput: async () => {},
  });
  await expect(routed.execCommand({ cmd: "once" })).rejects.toThrow(
    "lost durable process promotion",
  );
  expect(f.actions).toEqual(["launch-idle"]);
  expect(routed.hasRetainedProcess(41)).toBe(true);
  failRetention = false;
  await routed.writeStdinForProcessRead({ sessionId: 41, chars: "", yieldTimeMs: 0 });
  expect(f.actions.filter((action) => action === "launch-idle")).toHaveLength(1);
  expect(f.actions).toContain("release");
});

test("routing retains the locator when release response is ambiguous", async () => {
  const f = fixture();
  f.session.releaseSupervisedCommand = async () => {
    throw new Error("release response lost");
  };
  const backend = { session: f.session, sandboxId: null, kind: "modal", activeEpoch: 0 } as const;
  const routed = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    providerCommandHandle: () => 41,
    providerCommandPersistence: () => f.persistence,
    beforeMutation: async () => "admitted",
    afterMutation: async () => {
      f.retain();
    },
    captureProcessOutput: async () => {},
  });
  await expect(routed.execCommand({ cmd: "once" })).rejects.toThrow("release is unresolved");
  expect(routed.hasRetainedProcess(41)).toBe(true);
  expect(f.actions.filter((action) => action === "launch-idle")).toHaveLength(1);
});
