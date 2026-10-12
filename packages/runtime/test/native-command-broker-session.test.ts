import { expect, test } from "bun:test";
import { ModalBrokerProviderCommand } from "@opengeni/contracts";
import { NativeBrokerCommandSession } from "../src/sandbox/providers/native-command-broker-session";
import type { NativeBrokerCoordinator } from "../src/sandbox/providers/native-command-broker-coordinator";
import {
  initialNativeBrokerTransportState,
  type DurableNativeBrokerTransport,
} from "../src/sandbox/providers/native-command-broker-transport";
import {
  withCommandSupervisionReady,
  withProviderCommandHandle,
  withProviderCommandInputAdmission,
  ProviderCommandStartRejectedError,
  type ProviderCommandPersistence,
} from "../src/sandbox/provider-command-session";
import { hasTypedExecHandleLoss } from "../src/sandbox/exec-banner";
import type { NativeBrokerFrame } from "../src/sandbox/providers/native-command-broker-wire";

function fixture() {
  const identity = { brokerId: crypto.randomUUID(), sandboxId: "sb-exact", taskId: "ta-exact" };
  const state = initialNativeBrokerTransportState(identity);
  const commandId = crypto.randomUUID();
  const command = ModalBrokerProviderCommand.parse({
    kind: "modal-broker-v1",
    sandboxId: identity.sandboxId,
    taskId: identity.taskId,
    execId: commandId,
    pty: false,
    supervision: {
      protocol: "native-subreaper-broker-channel-v1",
      invocationId: commandId,
      brokerId: identity.brokerId,
      launchRequestId: crypto.randomUUID(),
      launchEpoch: 1,
    },
    capture: { sequence: 0, receiptAckObserved: false },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  });
  let persisted = structuredClone(command);
  let qualifications = 0,
    writes = 0,
    captures = 0,
    cancelled = false;
  const stdin: Array<{ input: unknown; bytes: Uint8Array }> = [];
  const journal = {
    read: async () => state,
    controlReply: async () => null,
    framesAfter: async () => ({ frames: [], lastSequence: 0, hasMore: false, providerEof: false }),
  } as unknown as DurableNativeBrokerTransport;
  const coordinator = {
    send: async () => {
      writes++;
      return { state: "accepted", index: writes };
    },
    sendRetainedStdin: async (input: unknown, bytes: Uint8Array) => {
      stdin.push({ input, bytes: Uint8Array.from(bytes) });
      return { state: "accepted", index: 1, offset: 0 };
    },
    observeAfter: async () => {
      throw new Error("zero-budget read must not wait");
    },
    acknowledgeOutput: async () => {
      throw new Error("empty fixture has no output to ACK");
    },
  } as unknown as NativeBrokerCoordinator;
  const options = {
    journal,
    coordinator,
    identity,
    root: "/workspace",
    environment: () => ({ PATH: "/usr/bin:/bin" }),
    verify: async () => {
      qualifications++;
      return { sandboxId: "sb-exact", taskId: "ta-exact" };
    },
  };
  const session = new NativeBrokerCommandSession(options);
  const persistence: ProviderCommandPersistence = {
    load: async () => structuredClone(persisted),
    acknowledge: async () => {
      throw new Error("No legacy output ACK");
    },
    reserveInput: async () => {
      throw new Error("No standalone input allocator");
    },
    recordSupervisionReceipt: async () => {
      throw new Error("No fixture native receipt");
    },
    loadSupervisionReceipt: async () => null,
    requestCancellation: async () => {
      cancelled = true;
    },
    cancellationRequested: async () => cancelled,
    captureBrokerPage: async (page) => {
      expect(page.expected).toEqual(persisted);
      captures++;
      persisted = structuredClone(page.command);
      return { command: structuredClone(persisted), captured: true };
    },
  };
  return {
    session,
    command,
    identity,
    state,
    options,
    persistence,
    stdin,
    counts: () => ({ qualifications, writes, captures }),
    replace: (next: ModalBrokerProviderCommand) => {
      persisted = next;
    },
  };
}

test("broker surface has no unretained setup or router protocol fallback", async () => {
  const f = fixture();
  await expect(f.session.execCommand({ cmd: "work" })).rejects.toThrow();
  await expect(
    withCommandSupervisionReady(
      true,
      () => f.session.execCommand({ cmd: "work" }),
      "native-subreaper-broker-channel-v1",
    ),
  ).rejects.toThrow("admission");
  await expect(
    withProviderCommandHandle(37, () =>
      withCommandSupervisionReady(true, () => f.session.execCommand({ cmd: "work" })),
    ),
  ).rejects.toThrow();
  await expect(
    f.session.verifyCommandSupervisionCapability("native-subreaper-v1"),
  ).rejects.toThrow();
  expect(f.counts()).toEqual({ qualifications: 0, writes: 0, captures: 0 });
  expect(hasTypedExecHandleLoss(f.session)).toBe(true);
});

test("session verification uses exact physical binding and cannot be retargeted by mutating options", async () => {
  const f = fixture();
  f.identity.taskId = "changed caller object";
  f.options.verify = async () => ({ sandboxId: "foreign", taskId: "foreign" });
  expect(
    await f.session.verifyCommandSupervisionCapability("native-subreaper-broker-channel-v1"),
  ).toEqual({ sandboxId: "sb-exact", taskId: "ta-exact" });
  f.state.output.taskId = "changed physical state";
  await expect(
    f.session.verifyCommandSupervisionCapability("native-subreaper-broker-channel-v1"),
  ).rejects.toThrow("physical identity");
  expect(f.counts().writes).toBe(0);
});

test("retained handle binding rejects foreign instances, malformed aliases and execution rebinding", async () => {
  const f = fixture();
  for (const handle of [0, -1, 1.5, Number.MAX_SAFE_INTEGER])
    expect(() => f.session.bindProviderCommand(handle, f.command, f.persistence)).toThrow("handle");
  expect(() =>
    f.session.bindProviderCommand(37, { ...f.command, taskId: "foreign" }, f.persistence),
  ).toThrow("physical session");
  expect(() =>
    f.session.bindProviderCommand(
      37,
      { ...f.command, supervision: { ...f.command.supervision, brokerId: crypto.randomUUID() } },
      f.persistence,
    ),
  ).toThrow("physical session");
  f.session.bindProviderCommand(37, f.command, f.persistence);
  const returned = f.session.getProviderCommand(37)!;
  returned.taskId = "caller mutation";
  expect(f.session.getProviderCommand(37)).toEqual(f.command);
  expect(() =>
    f.session.bindProviderCommand(
      37,
      {
        ...f.command,
        supervision: { ...f.command.supervision, launchRequestId: crypto.randomUUID() },
      },
      f.persistence,
    ),
  ).toThrow("rebound");
  await expect(f.session.writeStdin({ sessionId: 999, chars: "unsafe" })).rejects.toThrow();
  f.replace({ ...f.command, taskId: "foreign" });
  await expect(f.session.releaseSupervisedCommand(37)).rejects.toThrow("identity changed");
  expect(f.counts().writes).toBe(0);
});

test("stdin needs the exact canonical child admission and refuses oversized or lossy text before any provider write", async () => {
  const f = fixture();
  f.session.bindProviderCommand(37, f.command, f.persistence);
  const input = {
    sessionId: crypto.randomUUID(),
    processId: crypto.randomUUID(),
    admissionId: crypto.randomUUID(),
    commandId: f.command.execId,
  };
  await expect(f.session.writeStdin({ sessionId: 37, chars: "hello" })).rejects.toThrow(
    "child admission",
  );
  await expect(
    withProviderCommandInputAdmission({ ...input, commandId: crypto.randomUUID() }, () =>
      f.session.writeStdin({ sessionId: 37, chars: "hello" }),
    ),
  ).rejects.toThrow("child admission");
  for (const chars of ["x".repeat(8193), "\ud800"])
    await expect(
      withProviderCommandInputAdmission(input, () =>
        f.session.writeStdin({ sessionId: 37, chars }),
      ),
    ).rejects.toThrow("payload bound");
  for (const yieldTimeMs of [-1, 1.5, Number.NaN])
    await expect(
      withProviderCommandInputAdmission(input, () =>
        f.session.writeStdin({ sessionId: 37, chars: "not sent", yieldTimeMs }),
      ),
    ).rejects.toThrow("observation budget");
  expect(f.stdin).toHaveLength(0);
  const result = await withProviderCommandInputAdmission(input, () =>
    f.session.writeStdin({ sessionId: 37, chars: "literal €\n", yieldTimeMs: 0 }),
  );
  expect(f.stdin).toHaveLength(1);
  expect(f.stdin[0]!.input).toEqual(input);
  expect(Buffer.from(f.stdin[0]!.bytes).toString()).toBe("literal €\n");
  expect(f.session.getProviderCommandOutput(result)).toMatchObject({
    command: f.command,
    exitCode: null,
    chunks: [],
  });
  expect(f.counts().captures).toBe(2);
  expect(await f.session.captureCommandOutput(result)).toBe(true);
  expect(await f.session.captureCommandOutput(result)).toBe(false);
  expect(f.session.getProviderCommandOutput(result)).toBeNull();
});

test("closing one session surface neither closes the shared broker nor grants later command access", async () => {
  const f = fixture();
  f.session.bindProviderCommand(37, f.command, f.persistence);
  await f.session.close();
  await expect(f.session.writeStdin({ sessionId: 37 })).rejects.toThrow("closed");
  await expect(
    f.session.verifyCommandSupervisionCapability("native-subreaper-broker-channel-v1"),
  ).rejects.toThrow("closed");
  expect(f.counts()).toEqual({ qualifications: 0, writes: 0, captures: 0 });
  expect(f.session.getProviderCommand(37)).toBeNull();
});

test("a committed never-started reply reports rejection rather than a fabricated exit or observation uncertainty", async () => {
  const f = fixture();
  let request: NativeBrokerFrame | undefined;
  let settled = false;
  f.options.coordinator.send = async (input) => {
    request = {
      ...input,
      direction: "request",
      brokerId: f.command.supervision.brokerId,
      ownerEpoch: 1,
      sequence: 1,
    };
    return { state: "accepted", index: 1 };
  };
  f.options.journal.request = async (id) =>
    request?.requestId === id
      ? {
          frame: request as NativeBrokerFrame & { direction: "request" },
          accepted: true,
          phase: "accepted",
        }
      : null;
  f.options.journal.controlReply = async (id) =>
    request?.requestId === id
      ? {
          ...request,
          direction: "response",
          kind: "status",
          sequence: 2,
          payload: Buffer.from('{"state":"not_started","launchClosed":true}'),
        }
      : null;
  f.persistence.rejectBrokerLaunch = async (_command, proof) => {
    expect(proof.requestId).toBe(request!.requestId);
    settled = true;
  };
  f.session.bindProviderCommand(37, f.command, f.persistence);
  await f.session.cancelSupervisedCommand(37, "explicit_stop");
  await expect(f.session.writeStdin({ sessionId: 37, yieldTimeMs: 0 })).rejects.toBeInstanceOf(
    ProviderCommandStartRejectedError,
  );
  expect(settled).toBe(true);
  expect(f.session.getProviderCommand(37)!.streams.stdout.exitCode).toBeNull();
});
