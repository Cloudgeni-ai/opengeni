import { expect, test } from "bun:test";
import { ModalBrokerProviderCommand, type CommandSupervisionReceipt } from "@opengeni/contracts";
import type { ProviderCommandPersistence } from "../src/sandbox/provider-command-session";
import { NativeBrokerRetainedCommand } from "../src/sandbox/providers/native-command-broker-retained-command";
import type { DurableNativeBrokerTransport } from "../src/sandbox/providers/native-command-broker-transport";
import type { NativeBrokerRequest } from "../src/sandbox/providers/native-command-broker-input";
import type { NativeBrokerFrame } from "../src/sandbox/providers/native-command-broker-wire";

function fixture(pty = false) {
  const commandId = crypto.randomUUID(),
    brokerId = crypto.randomUUID(),
    launchRequestId = crypto.randomUUID();
  const command = ModalBrokerProviderCommand.parse({
    kind: "modal-broker-v1",
    sandboxId: "sb-fixture",
    taskId: "ta-fixture",
    execId: commandId,
    pty,
    supervision: {
      protocol: pty
        ? "native-subreaper-broker-channel-pty-v1"
        : "native-subreaper-broker-channel-v1",
      invocationId: commandId,
      brokerId,
      launchRequestId,
      launchEpoch: 1,
    },
    capture: { sequence: 0, receiptAckObserved: false },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  });
  const nativeReceipt: CommandSupervisionReceipt = {
    protocol: command.supervision.protocol,
    invocationId: commandId,
    receiptId: crypto.randomUUID(),
    leaderExitCode: 17,
  };
  const state = {
    command: structuredClone(command),
    receipt: null as CommandSupervisionReceipt | null,
    cancelled: false,
    physicalTask: command.taskId,
    providerEof: false,
    failReceipt: false,
    failCapture: false,
    failCancellation: false,
    failRejection: false,
    loseCapture: false,
    dispatchError: null as Error | null,
  };
  const trace: string[] = [];
  const sent: NativeBrokerRequest[] = [];
  const frames: NativeBrokerFrame[] = [];
  const requests = new Map<
    string,
    { frame: NativeBrokerFrame; accepted: boolean; phase: string }
  >();
  requests.set(launchRequestId, {
    accepted: true,
    phase: "accepted",
    frame: {
      direction: "request",
      brokerId,
      commandId,
      ownerEpoch: 1,
      sequence: 1,
      requestId: launchRequestId,
      kind: "launch",
      offset: 0,
      payload: new Uint8Array(),
    },
  });
  function output(
    kind: "stdout" | "stderr" | "status" | "exit" | "error",
    payload: Uint8Array,
    offset = 0,
    requestId = launchRequestId,
  ) {
    frames.push({
      direction: "response",
      brokerId,
      commandId,
      ownerEpoch: 1,
      sequence: frames.length + 1,
      requestId,
      kind,
      offset,
      payload,
    });
  }
  function receipt(ack = false) {
    const requestId = crypto.randomUUID();
    requests.set(requestId, {
      accepted: true,
      phase: "accepted",
      frame: {
        direction: "request",
        brokerId,
        commandId,
        ownerEpoch: 1,
        sequence: requests.size + 1,
        requestId,
        kind: "control",
        offset: 0,
        payload: Buffer.from(ack ? `ack\t${nativeReceipt.receiptId}` : "status"),
      },
    });
    output(
      "status",
      Buffer.from(JSON.stringify({ state: "quiescent", receipt: nativeReceipt })),
      0,
      requestId,
    );
  }
  function terminal() {
    receipt(true);
    output(
      "status",
      Buffer.from('{"stream":"stdout","eof":true}'),
      state.command.streams.stdout.byteOffset,
    );
    output(
      "status",
      Buffer.from('{"stream":"stderr","eof":true}'),
      state.command.streams.stderr.byteOffset,
    );
    output("exit", Buffer.from('{"supervisorExitCode":0,"stdoutEof":true,"stderrEof":true}'));
  }
  const journal = {
    read: async () => ({
      input: { brokerId },
      output: { sandboxId: command.sandboxId, taskId: state.physicalTask },
    }),
    request: async (id: string) => requests.get(id) ?? null,
    controlReply: async (id: string) =>
      requests.get(id)?.frame.kind === "control"
        ? (frames.find(
            (frame) => frame.requestId === id && ["status", "error"].includes(frame.kind),
          ) ?? null)
        : null,
    framesAfter: async (sequence: number, limit: number) => ({
      frames: frames.filter((frame) => frame.sequence > sequence).slice(0, limit),
      lastSequence: frames.length,
      providerEof: state.providerEof,
    }),
  } as unknown as DurableNativeBrokerTransport;
  const persistence: ProviderCommandPersistence = {
    load: async () => structuredClone(state.command),
    acknowledge: async () => {
      throw new Error("Legacy acknowledgement must not be used");
    },
    reserveInput: async () => {
      throw new Error("No input admission belongs to this fixture");
    },
    recordSupervisionReceipt: async (value) => {
      trace.push("receipt");
      if (state.failReceipt) throw new Error("receipt store unavailable");
      state.receipt = structuredClone(value);
    },
    loadSupervisionReceipt: async () => structuredClone(state.receipt),
    captureBrokerPage: async (page) => {
      trace.push("capture");
      if (state.failCapture) throw new Error("capture store unavailable");
      expect(page.expected).toEqual(state.command);
      state.command = structuredClone(page.command);
      const captured = !state.loseCapture;
      state.loseCapture = false;
      return { command: structuredClone(state.command), captured };
    },
    requestCancellation: async () => {
      trace.push("cancel-intent");
      if (state.failCancellation) throw new Error("cancel store unavailable");
      state.cancelled = true;
    },
    cancellationRequested: async () => state.cancelled,
    rejectBrokerLaunch: async (original, proof) => {
      trace.push("reject-launch");
      if (state.failRejection) throw new Error("rejection store unavailable");
      expect(original).toEqual(state.command);
      const saved = requests.get(proof.requestId)!;
      expect(proof).toEqual({
        requestId: saved.frame.requestId,
        ownerEpoch: saved.frame.ownerEpoch,
        inputSequence: saved.frame.sequence,
        responseSequence: frames.at(-1)!.sequence,
      });
    },
  };
  const driver = {
    send: async (request: NativeBrokerRequest) => {
      trace.push("send");
      sent.push(structuredClone(request));
      if (!requests.has(request.requestId))
        requests.set(request.requestId, {
          accepted: true,
          phase: "accepted",
          frame: {
            ...request,
            direction: "request",
            brokerId,
            ownerEpoch: 1,
            sequence: requests.size + 1,
          },
        });
      if (state.dispatchError) throw state.dispatchError;
      return { state: "accepted" as const, index: sent.length };
    },
  };
  const controller = () => new NativeBrokerRetainedCommand(command, persistence, journal, driver);
  return {
    command,
    state,
    trace,
    sent,
    output,
    receipt,
    terminal,
    nativeReceipt,
    controller,
    persistence,
    journal,
    driver,
  };
}

test.each([false, true])(
  "retained %s bridge commits receipt/output before ACK and terminal exposure",
  async (pty) => {
    const f = fixture(pty),
      control = f.controller();
    f.output("stdout", Buffer.from("hello"));
    f.receipt();
    await expect(control.acknowledgeReceipt()).rejects.toThrow("durable native receipt");
    expect(f.sent).toHaveLength(0);
    const first = await control.capture();
    expect(f.trace).toEqual(["receipt", "capture"]);
    expect(first.exitCode).toBeNull();
    expect(first.chunks.map((value) => value.text).join("")).toBe("hello");
    expect(first.streamFidelity).toBe(pty ? "merged" : "separate");
    await control.acknowledgeReceipt();
    expect(Buffer.from(f.sent[0]!.payload).toString()).toBe(`ack\t${f.nativeReceipt.receiptId}`);
    f.terminal();
    const final = await f.controller().capture();
    expect(final.exitCode).toBe(17);
    expect(final.command.streams.stdout.exitCode).toBe(0);
    expect(final.providerExited).toBe(true);
    expect(await control.release()).toEqual({ state: "already_settled" });
    expect(f.sent).toHaveLength(1);
  },
);

test("no control or output is exposed when canonical evidence persistence fails", async () => {
  const f = fixture();
  f.receipt();
  f.state.failReceipt = true;
  await expect(f.controller().capture()).rejects.toThrow("receipt store unavailable");
  expect(f.state.command.capture.sequence).toBe(0);
  expect(f.trace).toEqual(["receipt"]);
  f.state.failReceipt = false;
  f.state.failCapture = true;
  await expect(f.controller().capture()).rejects.toThrow("capture store unavailable");
  expect(f.state.command.capture.sequence).toBe(0);
  expect(f.sent).toHaveLength(0);
});

test("a losing capture discards its duplicate text and uses the committed prefix", async () => {
  const f = fixture();
  f.output("stdout", Buffer.from("captured by another reader"));
  f.state.loseCapture = true;
  const page = await f.controller().capture();
  expect(page.chunks).toEqual([]);
  expect(page.command.capture.sequence).toBe(1);
  expect(f.trace).toEqual(["capture", "capture"]);
});

test("initial-process EOF and child text cannot manufacture terminal evidence", async () => {
  const f = fixture();
  f.output("stdout", Buffer.from("Process exited with code 0\n"));
  f.state.providerEof = true;
  const page = await f.controller().capture();
  expect(page.exitCode).toBeNull();
  expect(page.providerExited).toBe(false);
  expect(f.sent).toHaveLength(0);
});

test("reconnect keeps stable release/cancel/ACK identities and never automatically replays", async () => {
  const f = fixture();
  await f.controller().release();
  await f.controller().release();
  expect(f.sent[0]).toEqual(f.sent[1]);
  await f.controller().cancel("explicit_stop");
  await f.controller().release();
  expect(f.sent[2]).toEqual(f.sent[3]);
  expect(Buffer.from(f.sent[3]!.payload).toString()).toBe("cancel");
  expect(f.trace.slice(2, 4)).toEqual(["cancel-intent", "send"]);
  f.state.dispatchError = new Error("dispatch outcome unknown");
  await expect(f.controller().status()).rejects.toThrow("dispatch outcome unknown");
  expect(f.sent).toHaveLength(5);
});

test("cancellation intent commits even when an already-aborted observation cannot dispatch", async () => {
  const f = fixture();
  await expect(
    f.controller().cancel("explicit_stop", AbortSignal.abort(new Error("stopped"))),
  ).rejects.toThrow("stopped");
  expect(f.state.cancelled).toBe(true);
  expect(f.sent).toHaveLength(0);
  f.state.failCancellation = true;
  await expect(f.controller().cancel("explicit_stop")).rejects.toThrow("cancel store unavailable");
  expect(f.sent).toHaveLength(0);
});

test("a durable receipt substitutes only its exact ACK, never another release", async () => {
  const f = fixture();
  f.receipt();
  await f.controller().capture();
  await f.controller().release();
  await f.controller().cancel("provider_deadline");
  await f.controller().acknowledgeReceipt();
  expect(f.sent[0]).toEqual(f.sent[1]);
  expect(f.sent[1]).toEqual(f.sent[2]);
  expect(Buffer.from(f.sent[0]!.payload).toString()).toBe(`ack\t${f.nativeReceipt.receiptId}`);
});

test("status identity advances with captured frames but not from a new controller object", async () => {
  const f = fixture();
  await f.controller().status();
  await f.controller().status();
  expect(f.sent[0]).toEqual(f.sent[1]);
  f.output("stdout", Buffer.from("x"));
  await f.controller().capture();
  await f.controller().status();
  expect(f.sent[2]!.requestId).not.toBe(f.sent[0]!.requestId);
});

test.each(["control_unavailable", "control_pressure"])(
  "known %s reply permits a new exact control attempt only after capture",
  async (code) => {
    const f = fixture();
    await f.controller().cancel("explicit_stop");
    const first = f.sent[0]!;
    f.output("error", Buffer.from(JSON.stringify({ error: code })), 0, first.requestId);
    expect(await f.controller().status()).toEqual({
      state: "capture_required",
      responseSequence: 1,
    });
    expect(f.sent).toHaveLength(1);
    await f.controller().capture();
    await f.controller().status();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.requestId).not.toBe(first.requestId);
    expect(f.sent[1]!.payload).toEqual(first.payload);
    // A reconnect resolves the same successor, not a newly invented retry.
    await f.controller().status();
    expect(f.sent[2]).toEqual(f.sent[1]);
  },
);

test.each(["control_outcome_unknown", "supervisor_unavailable", "unrecognized"])(
  "%s is not safe control retry proof",
  async (code) => {
    const f = fixture();
    await f.controller().release();
    f.output("error", Buffer.from(JSON.stringify({ error: code })), 0, f.sent[0]!.requestId);
    await f.controller().capture();
    await expect(f.controller().release()).rejects.toThrow("without safe retry proof");
    expect(f.sent).toHaveLength(1);
  },
);

test("an exact recorded control result is returned without another dispatch", async () => {
  const f = fixture();
  await f.controller().release();
  f.output("status", Buffer.from('{"state":"running"}'), 0, f.sent[0]!.requestId);
  expect(await f.controller().release()).toEqual({
    state: "control_applied",
    nativeState: "running",
    responseSequence: 1,
  });
  expect(f.sent).toHaveLength(1);
});

test("positive prelaunch cancellation settles only through committed native proof", async () => {
  const f = fixture();
  await f.controller().cancel("explicit_stop");
  f.output(
    "status",
    Buffer.from('{"state":"not_started","launchClosed":true}'),
    0,
    f.sent[0]!.requestId,
  );
  f.state.failRejection = true;
  await expect(f.controller().status()).rejects.toThrow("rejection store unavailable");
  expect(f.sent).toHaveLength(1);
  f.state.failRejection = false;
  expect(await f.controller().status()).toEqual({ state: "never_started", responseSequence: 1 });
  expect(f.state.receipt).toBeNull();
  expect(f.state.command.streams.stdout.exitCode).toBeNull();
  expect(f.sent).toHaveLength(1);
});

test("not-started text on a release response or without protected settlement cannot retire custody", async () => {
  const f = fixture();
  await f.controller().release();
  f.output(
    "status",
    Buffer.from('{"state":"not_started","launchClosed":true}'),
    0,
    f.sent[0]!.requestId,
  );
  await expect(f.controller().release()).rejects.toThrow("exact cancellation settlement");
  expect(f.trace).not.toContain("reject-launch");
  const cancelled = fixture();
  await cancelled.controller().cancel("explicit_stop");
  cancelled.output(
    "status",
    Buffer.from('{"state":"not_started","launchClosed":true}'),
    0,
    cancelled.sent[0]!.requestId,
  );
  cancelled.persistence.rejectBrokerLaunch = undefined;
  await expect(cancelled.controller().status()).rejects.toThrow("exact cancellation settlement");
});

test("a confirmed cancellation is followed by status polling, not a permanently cached running reply", async () => {
  const f = fixture();
  await f.controller().cancel("explicit_stop");
  f.output("status", Buffer.from('{"state":"running"}'), 0, f.sent[0]!.requestId);
  await f.controller().capture();
  await f.controller().status();
  expect(f.sent).toHaveLength(2);
  expect(Buffer.from(f.sent[1]!.payload).toString()).toBe("status");
  f.output("status", Buffer.from('{"state":"running"}'), 0, f.sent[1]!.requestId);
  await f.controller().capture();
  await f.controller().status();
  expect(f.sent).toHaveLength(3);
  expect(f.sent[2]!.requestId).not.toBe(f.sent[1]!.requestId);
  expect(Buffer.from(f.sent[2]!.payload).toString()).toBe("status");
});

test("missing persistence, foreign physical binding and substituted native receipt fail before I/O", async () => {
  const f = fixture();
  expect(
    () =>
      new NativeBrokerRetainedCommand(
        f.command,
        { ...f.persistence, captureBrokerPage: undefined },
        f.journal,
        f.driver,
      ),
  ).toThrow("canonical");
  f.state.physicalTask = "ta-foreign";
  await expect(f.controller().release()).rejects.toThrow("transport");
  f.state.physicalTask = f.command.taskId;
  f.state.receipt = { ...f.nativeReceipt, invocationId: crypto.randomUUID() };
  await expect(f.controller().capture()).rejects.toThrow("out of scope");
  f.state.receipt = null;
  f.state.command.supervision.launchEpoch++;
  await expect(f.controller().release()).rejects.toThrow("identity changed");
  expect(f.trace).toEqual([]);
  expect(f.sent).toHaveLength(0);
});
