import { expect, test } from "bun:test";
import type { ModalBrokerProviderCommand } from "@opengeni/contracts";
import {
  withCommandSupervisionReady,
  withProviderCommandHandle,
  withSupervisedLaunchReservation,
  ProviderCommandStartOutcomeUnknownError,
  type AdmittedCommandSupervisionProtocol,
} from "../src/sandbox/provider-command-session";
import { startNativeBrokerCommand } from "../src/sandbox/providers/native-command-broker-start";
import {
  initialNativeBrokerTransportState,
  type DurableNativeBrokerTransport,
} from "../src/sandbox/providers/native-command-broker-transport";
import type { NativeBrokerCoordinator } from "../src/sandbox/providers/native-command-broker-coordinator";
import { decodeNativeBrokerCommandDefinition } from "../src/sandbox/providers/native-command-broker-definition";
import type { NativeBrokerRequest } from "../src/sandbox/providers/native-command-broker-input";
import type { NativeBrokerFrame } from "../src/sandbox/providers/native-command-broker-wire";
import type { ChannelAExecArgs } from "../src/sandbox/channel-a";
import { NativeBrokerInitialDiagnosticsError } from "../src/sandbox/providers/native-command-broker-diagnostics";

function fixture() {
  const state = initialNativeBrokerTransportState({
    brokerId: crypto.randomUUID(),
    sandboxId: "sb-original",
    taskId: "ta-original",
  });
  state.input.writerEpoch = 1;
  state.input.acceptedWriterEpoch = 1;
  const trace: string[] = [];
  const sent: NativeBrokerRequest[] = [];
  const requests = new Map<
    string,
    { frame: NativeBrokerFrame; accepted: boolean; phase: string }
  >();
  const options = {
    root: "/workspace",
    environment: { PATH: "/usr/bin:/bin", EXACT: "literal $x\nvalue" },
  };
  let reserved: ModalBrokerProviderCommand | undefined;
  let reserve: (() => Promise<void>) | undefined;
  let failKind: NativeBrokerRequest["kind"] | undefined;
  let changeReply: ((frame: NativeBrokerFrame) => NativeBrokerFrame) | undefined;
  const journal = {
    read: async () => state,
    diagnosticFault: async () => null,
    request: async (id: string) => requests.get(id) ?? null,
  } as unknown as DurableNativeBrokerTransport;
  const coordinator: Pick<NativeBrokerCoordinator, "claimWriter" | "send" | "reply"> = {
    claimWriter: async () => {
      trace.push("writer");
      return { epoch: 1 };
    },
    send: async (request, _signal, expectedEpoch) => {
      trace.push(request.kind);
      expect(expectedEpoch).toBe(1);
      expect(reserved).toBeDefined();
      sent.push(structuredClone(request));
      if (request.kind === failKind) throw new Error("unknown physical input");
      const frame = {
        ...request,
        direction: "request" as const,
        brokerId: state.input.brokerId,
        ownerEpoch: 1,
        sequence: requests.size + 1,
      };
      requests.set(request.requestId, { frame, accepted: true, phase: "accepted" });
      return { state: "accepted", index: frame.sequence };
    },
    reply: async (id) => {
      const request = requests.get(id)!.frame;
      const frame: NativeBrokerFrame = {
        ...request,
        direction: "response",
        kind: "status",
        offset: request.kind === "definition" ? request.offset + request.payload.length : 0,
        payload: Buffer.from(
          JSON.stringify(
            request.kind === "launch"
              ? { state: "supervisor_started", released: false }
              : { state: "preparing" },
          ),
        ),
      };
      return changeReply ? changeReply(frame) : frame;
    },
  };
  const transport = { journal, coordinator };
  const run = (
    args: ChannelAExecArgs = { cmd: "printf exact" },
    protocol: AdmittedCommandSupervisionProtocol = "native-subreaper-broker-channel-v1",
    handle: number | undefined = 37,
    signal?: AbortSignal,
  ) =>
    withProviderCommandHandle(handle, () =>
      withCommandSupervisionReady(
        true,
        () =>
          withSupervisedLaunchReservation(
            {
              reserve: async (command) => {
                expect(command.kind).toBe("modal-broker-v1");
                reserved = command as ModalBrokerProviderCommand;
                trace.push("reserve");
                await reserve?.();
              },
            },
            () => startNativeBrokerCommand(transport, args, options, signal),
          ),
        protocol,
      ),
    );
  return {
    state,
    trace,
    sent,
    options,
    transport,
    run,
    reserved: () => reserved,
    reserve: (fn: () => Promise<void>) => {
      reserve = fn;
    },
    fail: (kind: NativeBrokerRequest["kind"]) => {
      failKind = kind;
    },
    changeReply: (fn: (frame: NativeBrokerFrame) => NativeBrokerFrame) => {
      changeReply = fn;
    },
  };
}

test("broker start awaits canonical reservation, chunks exact definitions and leaves the supervisor idle", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.reserve(async () => {
    entered();
    await blocked;
  });
  const args = { cmd: "x".repeat(20_000), workdir: "sub", tty: true };
  const original = args.cmd;
  const pending = f.run(args, "native-subreaper-broker-channel-pty-v1");
  await reached;
  expect(f.trace).toEqual(["writer", "reserve"]);
  expect(f.sent).toHaveLength(0);
  args.cmd = "changed";
  f.options.environment.EXACT = "changed";
  release();
  const result = await pending;
  expect(result).toEqual(f.reserved()!);
  expect(result.supervision).toMatchObject({
    launchEpoch: 1,
    protocol: "native-subreaper-broker-channel-pty-v1",
  });
  expect(f.sent[0]!.kind).toBe("prepare");
  expect(f.sent.at(-1)).toMatchObject({
    kind: "launch",
    requestId: result.supervision.launchRequestId,
    commandId: result.execId,
  });
  const chunks = f.sent.filter((request) => request.kind === "definition");
  expect(chunks).toHaveLength(3);
  expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 8192, 16384]);
  expect(chunks.every((chunk) => chunk.payload.length <= 8192)).toBe(true);
  const body = Buffer.concat(chunks.map((chunk) => chunk.payload));
  expect(Buffer.from(f.sent[0]!.payload).readUInt32BE(0)).toBe(body.length);
  expect(decodeNativeBrokerCommandDefinition(body)).toEqual({
    mode: "pty",
    cwd: "/workspace/sub",
    argv: ["/bin/sh", "-c", original],
    env: [
      ["PATH", "/usr/bin:/bin"],
      ["EXACT", "literal $x\nvalue"],
    ],
    rows: 24,
    columns: 80,
  });
  expect(f.sent.some((request) => request.kind === "control")).toBe(false);
});

test("unadmitted, unsupported and out-of-root broker starts make no provider calls", async () => {
  const f = fixture();
  await expect(startNativeBrokerCommand(f.transport, { cmd: "x" }, f.options)).rejects.toThrow(
    "reservation",
  );
  await expect(f.run({ cmd: "x" }, "native-subreaper-v1")).rejects.toThrow("admitted");
  await expect(f.run({ cmd: "x", tty: true })).rejects.toThrow("admitted");
  await expect(f.run({ cmd: "x", runAs: "nobody" })).rejects.toThrow("admitted");
  await expect(
    withProviderCommandHandle(undefined, () =>
      withCommandSupervisionReady(
        true,
        () =>
          withSupervisedLaunchReservation({ reserve: async () => {} }, () =>
            startNativeBrokerCommand(f.transport, { cmd: "x" }, f.options),
          ),
        "native-subreaper-broker-channel-v1",
      ),
    ),
  ).rejects.toThrow("admitted");
  await expect(f.run({ cmd: "x", workdir: "/outside" })).rejects.toThrow("outside");
  f.options.root = "relative";
  await expect(f.run()).rejects.toThrow("absolute");
  expect(f.trace).toEqual([]);
});

test("uncertain reservation or launch keeps its exact original locator without replay or release", async () => {
  for (const where of ["reservation", "prepare", "definition", "launch"] as const) {
    const f = fixture();
    if (where === "reservation")
      f.reserve(async () => {
        throw new Error("reservation commit response lost");
      });
    else f.fail(where);
    const error = await f.run().then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ProviderCommandStartOutcomeUnknownError);
    expect((error as ProviderCommandStartOutcomeUnknownError).command).toEqual(f.reserved()!);
    expect(f.sent.filter((request) => request.kind === "launch")).toHaveLength(
      where === "launch" ? 1 : 0,
    );
    expect(f.sent.some((request) => request.kind === "control")).toBe(false);
  }
});

test("persisted diagnostic faults and changed writer epochs refuse new command reservation", async () => {
  const f = fixture();
  f.transport.journal.diagnosticFault = async () => ({
    version: 1,
    sandboxId: "sb-original",
    taskId: "ta-original",
    reason: "invalid_page",
    page: null,
  });
  await expect(f.run()).rejects.toBeInstanceOf(NativeBrokerInitialDiagnosticsError);
  expect(f.trace).toEqual([]);
  expect(f.reserved()).toBeUndefined();
  for (const field of ["writerEpoch", "acceptedWriterEpoch"] as const) {
    const changed = fixture();
    changed.state.input[field] = 2;
    await expect(changed.run()).rejects.toThrow("not natively fenced");
    expect(changed.trace).toEqual(["writer"]);
    expect(changed.reserved()).toBeUndefined();
  }
});

test("cancellation after reservation preserves the retained locator and dispatches no preparation", async () => {
  const f = fixture();
  const cancelled = new AbortController();
  f.reserve(async () => {
    cancelled.abort(new Error("reservation owner cancelled"));
  });
  const result = await f
    .run({ cmd: "work" }, "native-subreaper-broker-channel-v1", 37, cancelled.signal)
    .catch((cause: unknown) => cause);
  expect(result).toBeInstanceOf(ProviderCommandStartOutcomeUnknownError);
  expect((result as ProviderCommandStartOutcomeUnknownError).command).toEqual(f.reserved()!);
  expect(f.trace).toEqual(["writer", "reserve"]);
  expect(f.sent).toHaveLength(0);
});

test("foreign, malformed and non-idle native replies never advance to another launch", async () => {
  for (const alter of [
    (frame: NativeBrokerFrame) => ({ ...frame, brokerId: crypto.randomUUID() }),
    (frame: NativeBrokerFrame) => ({ ...frame, commandId: crypto.randomUUID() }),
    (frame: NativeBrokerFrame) => ({ ...frame, ownerEpoch: 2 }),
    (frame: NativeBrokerFrame) => ({ ...frame, offset: 999 }),
    (frame: NativeBrokerFrame) => ({ ...frame, payload: Buffer.from('{"state":"running"}') }),
  ]) {
    const f = fixture();
    f.changeReply(alter);
    await expect(f.run()).rejects.toBeInstanceOf(ProviderCommandStartOutcomeUnknownError);
    expect(f.sent.map((request) => request.kind)).toEqual(["prepare"]);
  }
});
