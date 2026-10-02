import { afterEach, expect, test } from "bun:test";
import { Server, ServerCredentials, status, type ServiceDefinition } from "@grpc/grpc-js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ModalCommandRouterWire,
  modalRouterWire,
} from "../src/sandbox/providers/modal-command-router-wire";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import { verifyModalMaterializedPath } from "../src/sandbox/providers/modal-materialization-verification";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";
import {
  ProviderCommandObservationUnavailableError,
  isProviderCommandObservationUnavailableError,
} from "../src/sandbox/provider-command-session";
import { ModalCommandStartOutcomeUnknownError } from "../src/sandbox/providers/modal-command-start-errors";
import { agentRunFailurePayload } from "../../../apps/worker/src/activities/agent-turn/errors";
import { ModalCommandStartRejectedError } from "../src/sandbox/providers/modal-command-router-wire";

const prefix = "/modal.task_command_router.TaskCommandRouter/";
const definition = (method: string, input: string, output: string, streaming = false) => ({
  path: prefix + method,
  requestStream: false,
  responseStream: streaming,
  requestSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType(input).encode(value).finish()),
  requestDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(input).decode(bytes),
  responseSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType(output).encode(value).finish()),
  responseDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(output).decode(bytes),
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  options: {
    lostStartAck?: boolean;
    slowReadOutage?: boolean;
    lostInputAck?: boolean;
    capability?: boolean;
    rejectedStartCode?: number;
    readFailureCode?: number;
    stallRead?: boolean;
    partialOutput?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "modal-assurance-counterexample-"));
  const key = join(directory, "server.key");
  const cert = join(directory, "server.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  if (generated.status !== 0) throw new Error("TLS certificate generation failed");
  const server = new Server();
  const starts: Array<{ execId: string; commandArgs: string[] }> = [];
  const reads: Array<{ execId: string; offset: number; stream: number }> = [];
  const writes: Array<{ execId: string; offset: number; data: string }> = [];
  const invocations = new Set<string>();
  let readEntered!: () => void;
  const enteredRead = new Promise<void>((resolve) => {
    readEntered = resolve;
  });
  let readCancellations = 0;
  let unavailableUntil = 0;
  const marker = "__OPENGENI_MATERIALIZED_PATH_VISIBLE__";
  server.addService(
    {
      start: definition("TaskExecStart", "Start", "Empty"),
      read: definition("TaskExecStdioRead", "Read", "Data", true),
      poll: definition("TaskExecPoll", "Identity", "Poll"),
      write: definition("TaskExecStdinWrite", "Write", "Empty"),
    } as ServiceDefinition,
    {
      start(call: any, callback: any) {
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        starts.push(call.request);
        invocations.add(call.request.execId);
        if (options.slowReadOutage || options.partialOutput)
          unavailableUntil = performance.now() + 2_500;
        callback(
          options.rejectedStartCode
            ? {
                code: options.rejectedStartCode,
                details: "definitive helper rejection",
              }
            : options.lostStartAck
              ? {
                  code: status.UNAVAILABLE,
                  details: "Name resolution failed for target dns:task-accepted.w.modal.host:443",
                }
              : null,
          {},
        );
      },
      read(call: any) {
        const { execId, fileDescriptor } = call.request;
        const offset = Number(call.request.offset);
        reads.push({ execId, offset, stream: fileDescriptor });
        readEntered();
        call.once("cancelled", () => {
          readCancellations++;
        });
        if (!invocations.has(execId)) {
          call.emit("error", { code: status.NOT_FOUND, details: "wrong invocation" });
          return;
        }
        if (options.stallRead && fileDescriptor === 0) return;
        if (options.readFailureCode) {
          call.emit("error", {
            code: options.readFailureCode,
            details: "nontransport read rejection",
          });
          return;
        }
        if (options.partialOutput && fileDescriptor === 0 && offset === 0) {
          call.write({ data: Buffer.from(marker).subarray(0, 7) });
          return;
        }
        if (fileDescriptor === 0 && performance.now() < unavailableUntil) {
          call.emit("error", {
            code: status.UNAVAILABLE,
            details: "temporary read outage before recovery",
          });
          return;
        }
        const output = options.capability ? "native-subreaper-v1" : marker;
        if (fileDescriptor === 0) call.write({ data: Buffer.from(output).subarray(offset) });
        call.end();
      },
      poll(call: any, callback: any) {
        callback(null, invocations.has(call.request.execId) ? { code: 0 } : {});
      },
      write(call: any, callback: any) {
        writes.push({
          execId: call.request.execId,
          offset: Number(call.request.offset),
          data: Buffer.from(call.request.data).toString(),
        });
        callback(
          options.lostInputAck
            ? {
                code: status.UNAVAILABLE,
                details: "input accepted but acknowledgement lost",
              }
            : null,
          {},
        );
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createSsl(null, [
        { private_key: readFileSync(key), cert_chain: readFileSync(cert) },
      ]),
      (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
    ),
  );
  const wire = new ModalCommandRouterWire(
    {
      url: "https://localhost:" + port,
      jwt: "test-token",
    },
    readFileSync(cert),
  );
  if (options.partialOutput) {
    const read = wire.read.bind(wire);
    wire.read = (identity, stream, offset, waitMs, signal) =>
      read(
        identity,
        stream,
        offset,
        stream === "stdout" && offset === 0 ? Math.min(200, waitMs) : waitMs,
        signal,
      );
  }
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: { sandboxGetTaskId: async () => ({ taskId: "task-original" }) },
    } as never,
    "sandbox-original",
    "/workspace",
  );
  // Replace authenticated-access acquisition only. Production request encoding,
  // Start dispatch provenance and read/unknown handling use real TLS/gRPC.
  Object.defineProperty(control, "withRouter", {
    value: async (
      task: string,
      signal: AbortSignal | undefined,
      run: (router: ModalCommandRouterWire) => Promise<unknown>,
    ) => {
      expect(task).toBe("task-original");
      signal?.throwIfAborted();
      return await run(wire);
    },
  });
  cleanups.push(async () => {
    wire.close();
    await control.close();
    server.forceShutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    control,
    wire,
    starts,
    reads,
    writes,
    invocations,
    enteredRead,
    readCancellations: () => readCancellations,
  };
}

function originalLocator(execId: string) {
  return {
    kind: "modal-router-v1" as const,
    sandboxId: "sandbox-original",
    taskId: "task-original",
    execId,
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
}

test("capability lost Start ACK recovers by observing original successful helper once", async () => {
  const f = await fixture({ lostStartAck: true, capability: true });
  const result = await f.control.verifySupervisionCapability().catch((error) => error);
  expect(f.starts).toHaveLength(1);
  expect(f.invocations.has(f.starts[0]!.execId)).toBe(true);
  const observed = await f.control.read(originalLocator(f.starts[0]!.execId), 1_000);
  expect(observed.exitCode).toBe(0);
  expect(observed.chunks.map((chunk) => chunk.text).join("")).toBe("native-subreaper-v1");
  expect(f.starts).toHaveLength(1);
  expect(result).toEqual({ sandboxId: "sandbox-original", taskId: "task-original" });
  expect(new Set(f.reads.map((read) => read.execId))).toEqual(new Set([f.starts[0]!.execId]));
});

test("materialization lost Start ACK observes original successful probe without replay", async () => {
  const f = await fixture({ lostStartAck: true });
  const pending = new Set<AbortController>();
  const result = await verifyModalMaterializedPath(f.control, "ready", "/workspace", pending).then(
    () => "verified",
    (error) => error,
  );
  expect(f.starts).toHaveLength(1);
  expect(f.invocations.has(f.starts[0]!.execId)).toBe(true);
  expect(pending.size).toBe(0);
  const observed = await f.control.read(originalLocator(f.starts[0]!.execId), 1_000);
  expect(observed.exitCode).toBe(0);
  expect(observed.chunks.map((chunk) => chunk.text).join("")).toBe(
    "__OPENGENI_MATERIALIZED_PATH_VISIBLE__",
  );
  expect(f.starts).toHaveLength(1);
  expect(result).toBe("verified");
  expect(new Set(f.reads.map((read) => read.execId))).toEqual(new Set([f.starts[0]!.execId]));
});

test("materialization retries same locator beyond one read window while original 30 s deadline remains", async () => {
  const f = await fixture({ slowReadOutage: true });
  const pending = new Set<AbortController>();
  const began = performance.now();
  const result = await verifyModalMaterializedPath(f.control, "ready", "/workspace", pending).then(
    () => "verified",
    (error) => error,
  );
  expect(f.starts).toHaveLength(1);
  expect(pending.size).toBe(0);
  expect(new Set(f.reads.map((read) => read.execId))).toEqual(new Set([f.starts[0]!.execId]));
  expect(f.reads.every((read) => read.offset === 0)).toBe(true);
  if (result !== "verified") await new Promise<void>((resolve) => setTimeout(resolve, 2_600));
  const observed = await f.control.read(originalLocator(f.starts[0]!.execId), 1_000);
  expect(observed.exitCode).toBe(0);
  expect(observed.chunks.map((chunk) => chunk.text).join("")).toBe(
    "__OPENGENI_MATERIALIZED_PATH_VISIBLE__",
  );
  expect(f.starts).toHaveLength(1);
  expect(performance.now() - began).toBeLessThan(5_000);
  expect(result).toBe("verified");
}, 35_000);

test.each(["write_stdin", "command_input"] as const)(
  "%s accepted UTF-8 stdin with lost ACK retains its writer and renders no-resend uncertainty",
  async (alias) => {
    const f = await fixture({ lostInputAck: true });
    const original = await f.control.start({ cmd: "cat", tty: true });
    let command = original;
    let inputOffset = 0;
    let reservations = 0;
    const chars = "å✓\n";
    const session: Record<string, any> = {};
    installModalCommandSession(session as never, f.control);
    session.bindProviderCommand(77, command, {
      load: async () => structuredClone(command),
      acknowledge: async (next: typeof command) => {
        command = next;
        return next;
      },
      reserveInput: async (length: number) => {
        reservations++;
        const old = inputOffset;
        inputOffset += length;
        return old;
      },
      captureRouterPage: async (page: { command: typeof command }) => {
        command = page.command;
        return { command, captured: true };
      },
    });
    const controller = createTurnToolCancellationController();
    const cancellationSession = {
      hasRetainedProcess: (handle: number) => handle === 77,
      retainedProcessHasTypedHandleLoss: () => true,
      supportsCommandInput: () => true,
      writeStdinForProcessMutation: (args: unknown) => session.writeStdin(args),
      writeStdinForProcessRead: (args: unknown) => session.writeStdin(args),
    };
    const tools = controller.wrapTools(
      [
        {
          type: "function",
          name: "write_stdin",
          invoke: async () => {
            throw new Error("retained direct path must be used");
          },
        },
      ],
      cancellationSession as never,
    );
    const input = tools.find((tool) => tool.name === alias)!;
    const result = await input.invoke(
      {},
      JSON.stringify({
        session_id: 77,
        chars,
        yield_time_ms: 1_000,
      }),
    );
    expect(f.starts).toHaveLength(1);
    expect(f.writes).toEqual([{ execId: original.execId, offset: 0, data: chars }]);
    expect(reservations).toBe(1);
    expect(inputOffset).toBe(Buffer.byteLength(chars));
    expect(inputOffset).toBe(6);
    expect(cancellationSession.hasRetainedProcess(77)).toBe(true);
    expect(session.getProviderCommand(77).execId).toBe(original.execId);
    expect(result).toContain("outcome is unknown");
    expect(result).toContain("Do not resend stdin");
    expect(result).not.toContain("Please try again");
    expect(result).not.toContain("Process exited");
    // A later empty-input read uses the same retained provider identity.
    const observed = await session.writeStdin({
      sessionId: 77,
      chars: "",
      yieldTimeMs: 1_000,
    });
    expect(observed).toContain("Process exited with code 0");
    expect(new Set(f.reads.map((read) => read.execId))).toEqual(new Set([original.execId]));
    expect(f.writes).toHaveLength(1);
    expect(reservations).toBe(1);
    expect(f.starts).toHaveLength(1);
  },
);

test.each(["capability", "materialization"] as const)(
  "%s definitive Start rejection stays authoritative without observation or replay",
  async (probe) => {
    const f = await fixture({ rejectedStartCode: status.PERMISSION_DENIED });
    const pending = new Set<AbortController>();
    const result = await (
      probe === "capability"
        ? f.control.verifySupervisionCapability()
        : verifyModalMaterializedPath(f.control, "ready", "/workspace", pending)
    ).catch((error) => error);
    expect(result).toBeInstanceOf(ModalCommandStartRejectedError);
    expect(result.code).toBe(status.PERMISSION_DENIED);
    expect(f.starts).toHaveLength(1);
    expect(f.reads).toHaveLength(0);
    expect(pending.size).toBe(0);
  },
);

test.each(["capability", "materialization"] as const)(
  "%s nontransport observation rejection stays authoritative without retry",
  async (probe) => {
    const f = await fixture({
      capability: probe === "capability",
      readFailureCode: status.PERMISSION_DENIED,
    });
    const pending = new Set<AbortController>();
    const result = await (
      probe === "capability"
        ? f.control.verifySupervisionCapability()
        : verifyModalMaterializedPath(f.control, "ready", "/workspace", pending)
    ).catch((error) => error);
    expect(result.code).toBe(status.PERMISSION_DENIED);
    expect(f.starts).toHaveLength(1);
    expect(f.reads.length).toBeGreaterThan(0);
    expect(f.reads.length).toBeLessThanOrEqual(2);
    expect(pending.size).toBe(0);
  },
);

test("materialization cancellation aborts its current observation and preserves owning reason", async () => {
  const f = await fixture({ stallRead: true });
  const pending = new Set<AbortController>();
  const reason = new Error("owning attempt cancelled fixed probe");
  const result = verifyModalMaterializedPath(f.control, "ready", "/workspace", pending).catch(
    (error) => error,
  );
  await f.enteredRead;
  expect(pending.size).toBe(1);
  for (const controller of pending) controller.abort(reason);
  expect(await result).toBe(reason);
  expect(f.starts).toHaveLength(1);
  expect(pending.size).toBe(0);
  // Client cancellation reaches the real server asynchronously.
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(f.readCancellations()).toBeGreaterThan(0);
});

test("materialization transient recovery preserves partial output and exact stream cursor", async () => {
  const f = await fixture({ partialOutput: true });
  const pending = new Set<AbortController>();
  await verifyModalMaterializedPath(f.control, "ready", "/workspace", pending);
  expect(f.starts).toHaveLength(1);
  expect(new Set(f.reads.map((read) => read.execId))).toEqual(new Set([f.starts[0]!.execId]));
  const stdout = f.reads.filter((read) => read.stream === 0);
  expect(stdout[0]!.offset).toBe(0);
  expect(stdout.length).toBeGreaterThan(5);
  expect(stdout.slice(1).every((read) => read.offset === 7)).toBe(true);
  expect(pending.size).toBe(0);
});

test.each(["mixed transport", "changed locator"] as const)(
  "materialization %s does not acquire fixed-probe continuation authority",
  async (shape) => {
    const f = await fixture({ slowReadOutage: true });
    const read = f.control.readProbe.bind(f.control);
    let windows = 0;
    let rejected: ProviderCommandObservationUnavailableError | undefined;
    f.control.readProbe = async (...args) => {
      windows++;
      try {
        return await read(...args);
      } catch (error) {
        if (!(error instanceof ProviderCommandObservationUnavailableError)) throw error;
        const command = structuredClone(error.command);
        if (shape === "changed locator") command.execId = crypto.randomUUID();
        rejected = new ProviderCommandObservationUnavailableError(
          command,
          error,
          shape !== "mixed transport",
        );
        throw rejected;
      }
    };
    const pending = new Set<AbortController>();
    const result = await verifyModalMaterializedPath(
      f.control,
      "ready",
      "/workspace",
      pending,
    ).catch((error) => error);
    expect(windows).toBe(1);
    expect(f.starts).toHaveLength(1);
    expect(pending.size).toBe(0);
    if (shape === "mixed transport") expect(result).toBe(rejected);
    else {
      expect(result.diagnostic.reason).toBe("invalid_response");
      expect(result.cause).toBe(rejected);
    }
  },
);

test("materialization lost ACK remains uncertain when its original deadline expires", async () => {
  const f = await fixture({ lostStartAck: true, stallRead: true });
  const pending = new Set<AbortController>();
  const began = performance.now();
  const result = await verifyModalMaterializedPath(
    f.control,
    "ready",
    "/workspace",
    pending,
    150,
  ).catch((error) => error);
  expect(result.diagnostic.reason).toBe("command_pending");
  expect(result.cause).toBeInstanceOf(ProviderCommandObservationUnavailableError);
  expect(result.cause.command).toEqual(originalLocator(f.starts[0]!.execId));
  expect(result.diagnostic.providerExecution.execId).toBe(f.starts[0]!.execId);
  expect(isProviderCommandObservationUnavailableError(result)).toBe(true);
  expect(agentRunFailurePayload(result)).toMatchObject({
    code: "sandbox_materialization_verification_failed",
    retryable: false,
    materializationDiagnostic: { reason: "command_pending" },
  });
  expect(f.starts).toHaveLength(1);
  expect(pending.size).toBe(0);
  expect(performance.now() - began).toBeLessThan(1_000);
});

test("capability conflicting lost-ACK locator stays unknown without observing or replaying it", async () => {
  const f = await fixture({ lostStartAck: true, capability: true });
  const start = f.wire.start.bind(f.wire);
  let conflicting: ModalCommandStartOutcomeUnknownError | undefined;
  f.wire.start = async (...args) => {
    try {
      await start(...args);
    } catch (error) {
      if (!(error instanceof ModalCommandStartOutcomeUnknownError)) throw error;
      conflicting = new ModalCommandStartOutcomeUnknownError(
        error.taskId,
        crypto.randomUUID(),
        error,
      );
      throw conflicting;
    }
  };
  const result = await f.control.verifySupervisionCapability().catch((error) => error);
  expect(result).toBe(conflicting);
  expect(agentRunFailurePayload(result)).toMatchObject({
    code: "sandbox_command_start_outcome_unknown",
    retryable: false,
  });
  expect(f.starts).toHaveLength(1);
  expect(f.reads).toHaveLength(0);
});

test.each(["capability", "materialization"] as const)(
  "%s lost ACK followed by NOT_FOUND preserves original uncertainty without read retry or replay",
  async (probe) => {
    const f = await fixture({
      lostStartAck: true,
      capability: probe === "capability",
      readFailureCode: status.NOT_FOUND,
    });
    const pending = new Set<AbortController>();
    const result = await (
      probe === "capability"
        ? f.control.verifySupervisionCapability()
        : verifyModalMaterializedPath(f.control, "ready", "/workspace", pending)
    ).catch((error) => error);
    expect(result).toBeInstanceOf(ProviderCommandObservationUnavailableError);
    expect(result.command).toEqual(originalLocator(f.starts[0]!.execId));
    expect(result.readRetryAllowed).toBe(false);
    expect(result.cause).toBeInstanceOf(AggregateError);
    expect(result.cause.errors[1].code).toBe(status.NOT_FOUND);
    expect(result.cause.errors[0].execId ?? result.cause.errors[0].command.execId).toBe(
      f.starts[0]!.execId,
    );
    expect(agentRunFailurePayload(result)).toMatchObject({
      code: "sandbox_command_observation_unavailable",
      retryable: false,
    });
    expect(f.starts).toHaveLength(1);
    expect(f.reads.length).toBeGreaterThan(0);
    expect(f.reads.length).toBeLessThanOrEqual(2);
    expect(pending.size).toBe(0);
  },
);
