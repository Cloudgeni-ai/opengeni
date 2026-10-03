import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CommandSupervisionReceipt, ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import {
  type ProviderCommandPersistence,
  type ProviderCommandSession,
  withProviderCommandHandle,
  admittedCommandSupervisionReady,
  reserveSupervisedLaunch,
  ProviderCommandStartRejectedError,
} from "../src/sandbox/provider-command-session";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import { ModalCommandStartPreDispatchUnavailableError } from "../src/sandbox/providers/modal-command-router-wire";
import { isModalTaskExecStartPreDispatchUnavailableError } from "../src/sandbox/providers/modal";
import {
  RoutingSandboxSession,
  RoutingBackendRecoveryRequiredError,
} from "../src/sandbox/routing/routing-session";
import { isProviderSandboxGoneDuringRoutedOperation } from "../src/sandbox/provider-errors";

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
  let startRejection = false;
  let startReadinessFailure = false;
  let providerHandle = 41;
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
    verifySupervisionCapability: async () => ({
      sandboxId: command.sandboxId,
      taskId: command.taskId,
    }),
    start: async () => {
      if (admittedCommandSupervisionReady()) await reserveSupervisedLaunch(command);
      if (startRejection)
        throw new ProviderCommandStartRejectedError(new Error("provider rejected start"));
      if (startReadinessFailure)
        await ModalCommandStartPreDispatchUnavailableError.ensureReady({
          waitForReady: (_deadline: number, callback: (error: Error) => void) =>
            callback(new Error("resolver not ready")),
        } as never);
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
    session.bindProviderCommand!(providerHandle, command, persistence);
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
    setProviderHandle: (value: number) => {
      providerHandle = value;
    },
    clearRetention: () => {
      retained = null;
    },
    rejectStart: () => {
      startRejection = true;
    },
    failReadiness: (value = true) => {
      startReadinessFailure = value;
    },
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
  expect(f.actions).toEqual(["launch-idle", "status", "persist-proof", "ack", "capture-output"]);
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

test("routing never dispatches before durable reservation and can retry a never-dispatched call", async () => {
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
    "Reserved supervised launch did not return",
  );
  expect(f.actions).toEqual([]);
  expect(routed.hasRetainedProcess(41)).toBe(false);
  failRetention = false;
  await routed.execCommand({ cmd: "once" });
  expect(f.actions.filter((action) => action === "launch-idle")).toHaveLength(1);
  expect(f.actions).toContain("release");
});

test("an incompatible warm instance fails before admission without legacy fallback", async () => {
  const f = fixture();
  f.session.verifyCommandSupervisionCapability = async () => {
    throw new Error("native helper missing");
  };
  let admitted = false;
  let classified = 0;
  const backend = { session: f.session, sandboxId: null, kind: "modal", activeEpoch: 0 } as const;
  const routed = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    providerSupervisionReady: async () => true,
    providerCommandHandle: () => 41,
    providerCommandPersistence: () => f.persistence,
    beforeMutation: async () => {
      admitted = true;
    },
    afterMutation: async () => {},
    onDefaultBackendError: async ({ error, kind }) => {
      classified++;
      expect(isProviderSandboxGoneDuringRoutedOperation(kind, error)).toBe(false);
      return null;
    },
  });
  await expect(routed.execCommand({ cmd: "never" })).rejects.toThrow("helper missing");
  expect(admitted).toBe(false);
  expect(f.actions).toEqual([]);
  expect(classified).toBe(1);
});

for (const op of ["exec", "execCommand"] as const) {
  test(`${op} preflight provider loss uses exact recovery authority before admission and invalidates the stale route`, async () => {
    const f = fixture();
    const missing = Object.assign(new Error("exact sandbox disappeared"), {
      code: "SANDBOX_NOT_FOUND",
    });
    f.session.verifyCommandSupervisionCapability = async () => {
      throw missing;
    };
    let admissions = 0;
    let losses = 0;
    let resolutions = 0;
    const backend = {
      session: f.session,
      sandboxId: null,
      kind: "modal",
      activeEpoch: 0,
      leaseEpoch: 7,
      providerInstanceId: f.command.sandboxId,
    } as const;
    const routed = new RoutingSandboxSession({
      defaultResolved: backend,
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => {
        resolutions++;
        if (resolutions === 1) return backend;
        throw new Error("fresh route resolution");
      },
      providerSupervisionReady: async () => true,
      providerCommandHandle: () => 41,
      providerCommandPersistence: () => f.persistence,
      beforeMutation: async () => {
        admissions++;
      },
      afterMutation: async () => {
        throw new Error("No admission may be settled");
      },
      onDefaultBackendError: async (input) => {
        expect(input.error).toBe(missing);
        expect(input.op).toBe(op);
        expect(input.backend).toMatchObject({
          leaseEpoch: 7,
          providerInstanceId: f.command.sandboxId,
        });
        expect(isProviderSandboxGoneDuringRoutedOperation(input.kind, input.error)).toBe(true);
        losses++;
        return { leaseEpoch: 8, recovery: "degraded" };
      },
    });
    await expect(routed[op]({ cmd: "never" })).rejects.toBeInstanceOf(
      RoutingBackendRecoveryRequiredError,
    );
    expect({ admissions, losses, resolutions }).toEqual({
      admissions: 0,
      losses: 1,
      resolutions: 1,
    });
    expect(f.actions).toEqual([]);
    // The failed call was not replayed. Only the next separate call resolves
    // again, rather than reusing the cached missing instance's preflight.
    await expect(routed[op]({ cmd: "later" })).rejects.toThrow("fresh route resolution");
    expect({ admissions, losses, resolutions }).toEqual({
      admissions: 0,
      losses: 1,
      resolutions: 2,
    });
    expect(f.actions).toEqual([]);
  });
}

test("authenticated never-started rejection settles its reservation without quiescence or running receipt", async () => {
  const f = fixture();
  f.rejectStart();
  let rejected = false;
  f.persistence.rejectSupervisedLaunch = async (command) => {
    expect(command).toEqual(f.command);
    rejected = true;
  };
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
      f.retain();
    },
  });
  await expect(routed.execCommand({ cmd: "never" })).rejects.toBeInstanceOf(
    ProviderCommandStartRejectedError,
  );
  expect(rejected).toBe(true);
  expect(routed.hasRetainedProcess(41)).toBe(false);
  expect(f.actions).toEqual([]);
});

test("a pre-dispatch failure permits bounded new launch only after exact never-started settlement", async () => {
  const f = fixture();
  f.failReadiness();
  let settlementFails = true;
  let settled = 0;
  f.persistence.rejectSupervisedLaunch = async (command) => {
    expect(command).toEqual(f.command);
    if (settlementFails) throw new Error("reservation settlement unavailable");
    f.clearRetention();
    settled++;
  };
  const backend = { session: f.session, sandboxId: null, kind: "modal", activeEpoch: 0 } as const;
  let nextHandle = 40;
  const routed = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    providerSupervisionReady: async () => true,
    providerCommandHandle: (admission) => admission as number,
    providerCommandPersistence: () => f.persistence,
    beforeMutation: async () => {
      f.setProviderHandle(++nextHandle);
      return nextHandle;
    },
    afterMutation: async () => f.retain(),
  });
  const uncertain = await routed.execCommand({ cmd: "once" }).catch((error) => error);
  expect(uncertain).toMatchObject({ name: "RoutingMutationOutcomeUnknownError", retryable: false });
  expect(isModalTaskExecStartPreDispatchUnavailableError(uncertain)).toBe(false);
  expect(routed.hasRetainedProcess(41)).toBe(true);
  expect(f.actions).not.toContain("launch-idle");

  // An exact durable rejection is the only branch that can clear the
  // reservation and surface proof of never-dispatch to bounded recovery.
  settlementFails = false;
  const safe = await routed.execCommand({ cmd: "once" }).catch((error) => error);
  expect(safe).toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
  expect(settled).toBe(1);
  expect(routed.hasRetainedProcess(42)).toBe(false);
  f.failReadiness(false);
  await routed.execCommand({ cmd: "once" });
  expect(f.actions.filter((action) => action === "launch-idle")).toHaveLength(1);
});

test("a fresh observer never releases an abandoned idle reservation", async () => {
  const f = fixture();
  await f.start();
  f.retain();
  await f.read(f.recreate());
  expect(f.actions).toContain("status");
  expect(f.actions).not.toContain("release");
  await f.recreate().cancelSupervisedCommand!(41, "provider_deadline");
  expect(f.actions).toContain("cancel");
});

test("routing retains the locator when release response is ambiguous", async () => {
  const f = fixture();
  f.session.releaseSupervisedCommand = async () => {
    await ModalCommandStartPreDispatchUnavailableError.ensureReady({
      waitForReady: (_deadline: number, callback: (error: Error) => void) =>
        callback(new Error("resolver not ready")),
    } as never);
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
  const uncertain = await routed.execCommand({ cmd: "once" }).catch((error) => error);
  expect(uncertain).toMatchObject({ name: "RoutingMutationOutcomeUnknownError", retryable: false });
  expect(isModalTaskExecStartPreDispatchUnavailableError(uncertain)).toBe(false);
  expect(routed.hasRetainedProcess(41)).toBe(true);
  expect(f.actions.filter((action) => action === "launch-idle")).toHaveLength(1);
});
