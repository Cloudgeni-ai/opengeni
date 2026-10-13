import { expect, test } from "bun:test";
import { ModalBrokerProviderCommand } from "@opengeni/contracts";
import {
  RoutingSandboxSession,
  type RoutableBackendSession,
} from "../src/sandbox/routing/routing-session";
import {
  admittedProviderCommandInput,
  withProviderCommandInputAdmission,
  withoutProviderCommandHandle,
  type ProviderCommandInputAdmission,
  type ProviderCommandOutput,
} from "../src/sandbox/provider-command-session";

function fixture() {
  const commandId = crypto.randomUUID(),
    processId = crypto.randomUUID(),
    sessionId = crypto.randomUUID();
  const admission = {
    id: crypto.randomUUID(),
    sessionId,
    actorKind: "process",
    actorId: processId,
    providerBackend: "modal",
    providerInstanceId: "sb-exact",
    leaseEpoch: 7,
  };
  const command = ModalBrokerProviderCommand.parse({
    kind: "modal-broker-v1",
    sandboxId: "sb-exact",
    taskId: "ta-exact",
    execId: commandId,
    pty: false,
    supervision: {
      protocol: "native-subreaper-broker-channel-v1",
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
  const state = {
    admission: admission as unknown,
    writes: 0,
    captures: 0,
    nativeControls: [] as string[],
    inputs: [] as Array<ProviderCommandInputAdmission | undefined>,
    chars: [] as unknown[],
    settlements: [] as string[],
    appended: [] as string[],
    atomic: true,
    page: null as ProviderCommandOutput | null,
    beforeWrite: async () => {},
    failWrite: false,
    durablySettled: false,
  };
  const backend: RoutableBackendSession = {
    bindProviderCommand: (_handle, bound) => {
      expect(bound).toEqual(command);
    },
    getProviderCommand: () => command,
    getProviderCommandOutput: (result) => (typeof result === "string" ? state.page : null),
    captureCommandOutput: async () => {
      state.captures++;
      return state.atomic;
    },
    cancelSupervisedCommand: async (_handle, reason) => {
      expect(admittedProviderCommandInput()).toBeUndefined();
      state.nativeControls.push(reason);
      return true;
    },
    execCommand: async () => {
      throw new Error("Legacy helper must not run");
    },
    writeStdin: async (args: unknown) => {
      state.writes++;
      state.inputs.push(admittedProviderCommandInput());
      state.chars.push((args as { chars?: unknown }).chars);
      await state.beforeWrite();
      if (state.failWrite) throw new Error("Fixture provider rejection");
      expect(admittedProviderCommandInput()).toEqual(state.inputs.at(-1));
      return "Process running with session ID 37\n\nOutput:\n";
    },
  };
  const resolved = {
    session: backend,
    kind: "modal",
    sandboxId: null,
    leaseEpoch: 7,
    providerInstanceId: "sb-exact",
  };
  const proxy = new RoutingSandboxSession({
    defaultResolved: resolved,
    readPointer: async () => {
      throw new Error("Never resolve a new pointer for retained input");
    },
    resolveActiveBackend: async () => {
      throw new Error("Never resolve a new backend");
    },
    providerCommandPersistence: () => ({
      load: async () => command,
      acknowledge: async () => {
        throw new Error("No legacy ACK");
      },
      reserveInput: async () => {
        throw new Error("No standalone offset allocation");
      },
    }),
    beforeProcessMutation: async () => state.admission,
    afterProcessMutation: async ({ outcome }) => {
      state.settlements.push(outcome);
    },
    captureProcessOutput: async ({ chunk }) => {
      state.appended.push(chunk);
    },
    isProcessSettled: async () => state.durablySettled,
  });
  proxy.adoptRetainedProcess({
    process: { id: processId, providerSessionId: 37, providerCommand: command },
    backend: { sandboxId: null, leaseEpoch: 7, providerInstanceId: "sb-exact", activeEpoch: 0 },
  });
  return {
    proxy,
    backend,
    state,
    admission,
    command,
    input: { admissionId: admission.id, sessionId, processId, commandId },
  };
}

test("retained broker stdin receives only the server-created exact admission, never command arguments", async () => {
  const f = fixture();
  await f.proxy.writeStdinForProcessMutation({
    sessionId: 37,
    chars: "hello",
    admissionId: crypto.randomUUID(),
    processId: crypto.randomUUID(),
  });
  expect(f.state.inputs).toEqual([f.input]);
  expect(Object.isFrozen(f.state.inputs[0])).toBe(true);
  expect(f.state.settlements).toEqual(["resolved"]);
  expect(admittedProviderCommandInput()).toBeUndefined();
});

test("missing or mismatched broker admissions settle rejected without provider input", async () => {
  for (const change of [
    null,
    "not an admission",
    { id: "invalid" },
    { sessionId: "invalid" },
    { actorKind: "direct" },
    { actorId: crypto.randomUUID() },
    { providerBackend: "selfhosted" },
    { providerInstanceId: "sb-other" },
    { leaseEpoch: 8 },
  ]) {
    const f = fixture();
    f.state.admission =
      change && typeof change === "object" ? { ...f.admission, ...change } : change;
    await expect(
      f.proxy.writeStdinForProcessMutation({ sessionId: 37, chars: "no" }),
    ).rejects.toThrow();
    expect(f.state.writes).toBe(0);
    expect(f.state.settlements).toEqual(["rejected"]);
    expect(admittedProviderCommandInput()).toBeUndefined();
  }
});

test("concurrent routes retain distinct stdin contexts across awaited provider calls", async () => {
  const first = fixture(),
    second = fixture();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.state.beforeWrite = async () => {
    await ready;
  };
  second.state.beforeWrite = async () => {
    release();
  };
  await Promise.all(
    [first, second].map((f) => f.proxy.writeStdinForProcessMutation({ sessionId: 37, chars: "x" })),
  );
  expect(first.state.inputs).toEqual([first.input]);
  expect(second.state.inputs).toEqual([second.input]);
  expect(admittedProviderCommandInput()).toBeUndefined();
});

test("private helpers clear input context, and provider rejection does not leak it", async () => {
  const f = fixture();
  await withProviderCommandInputAdmission(f.input, async () => {
    await withoutProviderCommandHandle(async () => {
      expect(admittedProviderCommandInput()).toBeUndefined();
    });
    expect(admittedProviderCommandInput()).toEqual(f.input);
  });
  f.state.failWrite = true;
  await expect(f.proxy.writeStdinForProcessMutation({ sessionId: 37, chars: "x" })).rejects.toThrow(
    "Fixture provider rejection",
  );
  expect(f.state.settlements).toEqual(["rejected"]);
  expect(admittedProviderCommandInput()).toBeUndefined();
});

test("broker controls use native cancellation and refuse legacy process helpers", async () => {
  const f = fixture();
  expect(
    await withProviderCommandInputAdmission(f.input, () =>
      f.proxy.cancelSupervisedCommand(37, "provider_deadline"),
    ),
  ).toBe(true);
  await withProviderCommandInputAdmission(f.input, () =>
    f.proxy.writeStdinForProcessControl({ sessionId: 37, chars: "\u0003" }),
  );
  expect(f.state.nativeControls).toEqual(["provider_deadline", "explicit_stop"]);
  expect(f.state.chars).toEqual([""]);
  expect(f.state.inputs).toEqual([undefined]);
  expect(f.state.settlements).toEqual([]);
  await expect(f.proxy.execCommandForProcessControl(37, { cmd: "kill -9 123" })).rejects.toThrow(
    "Legacy process helpers are unavailable",
  );
});

test("native cancellation acknowledgement alone keeps custody; only canonical never-started settlement releases the route", async () => {
  const f = fixture();
  expect(await f.proxy.cancelSupervisedCommand(37, "explicit_stop")).toBe(true);
  expect(f.proxy.hasRetainedProcess(37)).toBe(true);
  f.state.durablySettled = true;
  expect(await f.proxy.cancelSupervisedCommand(37, "explicit_stop")).toBe(true);
  expect(f.proxy.hasRetainedProcess(37)).toBe(false);
  expect(f.state.writes).toBe(0);
  expect(f.state.settlements).toEqual([]);
});

test("broker pages require atomic capture and never enter legacy append-then-ack", async () => {
  for (const atomic of [true, false]) {
    const f = fixture();
    f.state.page = {
      command: f.command,
      expected: f.command,
      chunks: [{ stream: "stdout", chunkId: "retained", text: "once" }],
      exitCode: null,
    };
    f.state.atomic = atomic;
    const result = f.proxy.writeStdinForProcessRead({ sessionId: 37, chars: "" });
    if (atomic) await result;
    else await expect(result).rejects.toThrow("atomic capture remains pending");
    expect(f.state.captures).toBe(1);
    expect(f.state.appended).toEqual([]);
  }
});

test("missing broker capture adapter rejects output without a legacy append", async () => {
  const f = fixture();
  f.state.page = {
    command: f.command,
    chunks: [{ stream: "stdout", chunkId: "held", text: "held" }],
    exitCode: null,
  };
  delete f.backend.captureCommandOutput;
  await expect(f.proxy.writeStdinForProcessRead({ sessionId: 37, chars: "" })).rejects.toThrow(
    "atomic retention adapter",
  );
  expect(f.state.appended).toEqual([]);
});
