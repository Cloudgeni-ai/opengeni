import { afterAll, beforeAll, expect, test } from "bun:test";
import { Metadata, Server, ServerCredentials, status, type ServiceDefinition } from "@grpc/grpc-js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Sandbox } from "modal";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import {
  verifySandboxExecReadiness,
  SandboxExecReadinessError,
  isModalTaskExecStartPreDispatchUnavailableError,
} from "../src/sandbox";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import {
  ModalCommandRouterWire,
  ModalCommandStartPreDispatchUnavailableError,
  ModalCommandStartRejectedError,
  modalRouterWire,
} from "../src/sandbox/providers/modal-command-router-wire";
import {
  waitForSandboxExecReadiness,
  SandboxExecReadinessTimeoutError,
} from "../../../apps/worker/src/sandbox-resume";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { isProviderCommandObservationUnavailableError } from "../src/sandbox/provider-command-session";

const service = "/modal.task_command_router.TaskCommandRouter/";
const definition = (method: string, input: string, output: string, streaming = false) => ({
  path: service + method,
  requestStream: false,
  responseStream: streaming,
  requestSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType(input).encode(value).finish()),
  requestDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(input).decode(bytes),
  responseSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType(output).encode(value).finish()),
  responseDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(output).decode(bytes),
});
const server = new Server();
let directory: string, endpoint: string, certificate: Buffer;
type Mode =
  | "success"
  | "lost-start"
  | "unknown-start"
  | "internal-start"
  | "lost-read"
  | "unobservable"
  | "rejected"
  | "nonzero";
let mode: Mode = "success";
let starts: Array<{ execId: string; commandArgs: string[]; workdir: string; env: object }> = [];
let observations: string[] = [];
let failedRead = false;
let preparations: string[] = [];
let preparationPending = false;
let preparationEntered: () => void;
let completePreparation: () => void;
let foregroundReadFailures = 0;
let foregroundPollFailure = false;
let foregroundPollPending = false;
let foregroundPollCancelled = 0;
let foregroundWrites = 0;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "opengeni-readiness-"));
  const key = join(directory, "server.key"),
    cert = join(directory, "server.pem");
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
  if (generated.status !== 0) throw new Error("Test TLS certificate generation failed");
  certificate = readFileSync(cert);
  server.addService(
    {
      start: definition("TaskExecStart", "Start", "Empty"),
      read: definition("TaskExecStdioRead", "Read", "Data", true),
      poll: definition("TaskExecPoll", "Identity", "Poll"),
      preparation: definition("ReadinessPreparation", "Identity", "Empty"),
      write: definition("TaskExecStdinWrite", "Write", "Empty"),
    } as ServiceDefinition,
    {
      start(call: any, callback: any) {
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        starts.push(call.request);
        callback(
          mode === "rejected"
            ? { code: status.NOT_FOUND, details: "executable unavailable" }
            : mode === "unknown-start" || mode === "internal-start"
              ? {
                  code: mode === "unknown-start" ? status.UNKNOWN : status.INTERNAL,
                  details: "accepted probe, lost response",
                }
              : mode === "lost-start" || mode === "unobservable"
                ? {
                    code: status.UNAVAILABLE,
                    details: "Name resolution failed for target dns:task-spoof.w.modal.host:443",
                  }
                : null,
          {},
        );
      },
      read(call: any) {
        observations.push(call.request.execId);
        if (foregroundReadFailures > 0) {
          foregroundReadFailures--;
          call.emit("error", { code: status.UNAVAILABLE, details: "read DNS unavailable" });
          return;
        }
        if (mode === "unobservable" || (mode === "lost-read" && !failedRead)) {
          failedRead = true;
          call.emit("error", { code: status.UNAVAILABLE, details: "read connection dropped" });
        } else call.end();
      },
      poll(call: any, callback: any) {
        observations.push(call.request.execId);
        if (foregroundPollPending) {
          call.on("cancelled", () => foregroundPollCancelled++);
          return;
        }
        if (foregroundPollFailure) {
          callback({ code: status.UNAVAILABLE, details: "poll DNS unavailable" });
          return;
        }
        callback(null, { code: mode === "nonzero" ? 127 : 0 });
      },
      write(_call: any, callback: any) {
        foregroundWrites++;
        callback(null, {});
      },
      preparation(call: any, callback: any) {
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        preparations.push(call.request.taskId);
        completePreparation = () => callback(null, {});
        preparationEntered();
        if (!preparationPending)
          callback({ code: status.UNAVAILABLE, details: "read-only preparation unavailable" });
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createSsl(null, [
        { private_key: readFileSync(key), cert_chain: certificate },
      ]),
      (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
    ),
  );
  endpoint = `https://localhost:${port}`;
});
afterAll(() => {
  server.forceShutdown();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function fixture(
  selected: Mode = "success",
  url = endpoint,
  preparation?: { stage: "task" | "access"; pending?: boolean },
) {
  mode = selected;
  starts = [];
  observations = [];
  failedRead = false;
  preparations = [];
  foregroundReadFailures = 0;
  foregroundPollFailure = false;
  foregroundPollPending = false;
  foregroundPollCancelled = 0;
  foregroundWrites = 0;
  preparationPending = preparation?.pending ?? false;
  const enteredPreparation = new Promise<void>((resolve) => {
    preparationEntered = resolve;
  });
  completePreparation = () => undefined;
  let sdkStarts = 0;
  const sandbox = new Sandbox(
    {
      profile: { serverUrl: "http://localhost" },
      logger: { debug() {}, warn() {} },
      cpClient: {
        taskGetCommandRouterAccess: async () => ({
          url: "https://task-readiness.invalid",
          jwt: "test-token",
        }),
      },
    } as never,
    "sb-readiness",
    { taskId: "task-readiness" },
  );
  const original = sandbox.exec.bind(sandbox);
  sandbox.exec = async (...args) => {
    sdkStarts++;
    return await original(...args);
  };
  const session = new ModalSandboxSession({
    state: {
      sandboxId: "sb-readiness",
      manifest: new Manifest({ root: "/workspace" }),
      environment: { BASH_ENV: "/workspace/user-startup" },
      workspacePersistence: "tar",
    },
    sandbox,
    modal: { version: () => "0.9.0" },
    app: {},
  } as never);
  const wire = new ModalCommandRouterWire({ url, jwt: "test-token" }, certificate);
  const prepare = async (stage: "task" | "access", signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const metadata = new Metadata();
    metadata.set("authorization", "Bearer test-token");
    await new Promise<void>((resolve, reject) => {
      const client = (wire as any).client;
      const call = client.makeUnaryRequest(
        service + "ReadinessPreparation",
        (value: object) =>
          Buffer.from(modalRouterWire.lookupType("Identity").encode(value).finish()),
        (bytes: Buffer) => modalRouterWire.lookupType("Empty").decode(bytes),
        { taskId: stage },
        metadata,
        { deadline: Date.now() + 5_000 },
        (error: Error | null) => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) reject(signal.reason);
          else if (error) reject(error);
          else resolve();
        },
      );
      const abort = () => call.cancel();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: {
        sandboxGetTaskId: async (_request: unknown, options: { signal?: AbortSignal }) => {
          if (preparation?.stage === "task") await prepare("task", options?.signal);
          return { taskId: "task-readiness" };
        },
        taskGetCommandRouterAccess: async (
          _request: unknown,
          options: { signal?: AbortSignal },
        ) => {
          await prepare("access", options?.signal);
          return { url, jwt: "test-token" };
        },
      },
    } as never,
    "sb-readiness",
    "/workspace",
  );
  if (!preparation)
    Object.defineProperty(control, "withRouter", {
      value: async (
        _task: string,
        signal: AbortSignal | undefined,
        run: (router: ModalCommandRouterWire) => Promise<unknown>,
      ) => {
        signal?.throwIfAborted();
        return await run(wire);
      },
    });
  installModalCommandSession(session, control);
  const established = {
    backendId: "modal",
    instanceId: "sb-readiness",
    session,
    client: {},
    sessionState: {},
  };
  return {
    established,
    session,
    wire,
    control,
    enteredPreparation,
    completePreparation: () => completePreparation(),
    sdkStarts: () => sdkStarts,
    close: async () => {
      wire.close();
      sandbox.detach();
      await control.close();
    },
  };
}

function foregroundTools(f: ReturnType<typeof fixture>) {
  let stored: ModalRouterProviderCommand;
  let adoptions = 0;
  let retained = true;
  const fence = createTurnToolCancellationController();
  const invoke = async (_context: unknown, input: string) => {
    const args = JSON.parse(input);
    stored = await f.control.start({ cmd: args.cmd }, AbortSignal.timeout(2_000));
    f.session.bindProviderCommand!(73, stored, {
      load: async () => stored,
      acknowledge: async (command) => command,
      reserveInput: async () => 0,
      captureRouterPage: async (page) => {
        stored = page.command;
        return { command: stored, captured: true };
      },
    });
    return "Chunk ID: started\nWall time: 0 seconds\nProcess running with session ID 73\nOutput:\ninitial";
  };
  const tools = fence.wrapTools(
    [
      { type: "function", name: "exec_command", invoke },
      {
        type: "function",
        name: "write_stdin",
        invoke: async (_context: unknown, input: string) => {
          const args = JSON.parse(input);
          return f.session.writeStdin!({
            sessionId: args.session_id,
            chars: args.chars,
            yieldTimeMs: args.yield_time_ms,
          });
        },
      },
    ],
    {
      hasRetainedProcess: () => retained,
      retainedProcessIdentity: () => ({ id: "6b7df4e1-2f69-4bbd-95ea-0427ad72cd09" }),
      adoptRetainedProcessAsBackgroundCommand: async () => {
        adoptions++;
      },
      writeStdinForProcessRead: (args) => f.session.writeStdin!(args),
      writeStdinForProcessMutation: (args) => f.session.writeStdin!(args),
      cancelSupervisedCommand: async () => {
        foregroundPollPending = false;
        foregroundPollFailure = false;
        return true;
      },
      writeStdinForProcessControl: async (args) => {
        const result = await f.session.writeStdin!(args);
        if (result.includes("Process exited")) retained = false;
        return result;
      },
    },
  );
  return {
    exec: tools[0]!,
    write: tools[1]!,
    input: tools[2]!,
    invoke,
    fence,
    adoptions: () => adoptions,
    stored: () => stored,
  };
}

test("post-start real gRPC UNAVAILABLE retries only the exact foreground read", async () => {
  const f = fixture();
  const tools = foregroundTools(f);
  foregroundReadFailures = 1;
  try {
    const result = await tools.exec.invoke(
      {},
      JSON.stringify({ cmd: "work", yield_time_ms: 1_000 }),
    );
    expect(result).toContain("Process exited with code 0");
    expect(result).toContain("initial");
    expect(starts).toHaveLength(1);
    expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
    expect(tools.stored().streams.stdout.eof).toBe(true);
    expect(tools.adoptions()).toBe(0);
  } finally {
    await f.close();
  }
});

test("foreground stdin read failure does not resend nonempty input", async () => {
  const f = fixture();
  const tools = foregroundTools(f);
  try {
    await tools.exec.invoke({}, JSON.stringify({ cmd: "work", yield_time_ms: 0 }));
    foregroundReadFailures = 100;
    const recovery = setTimeout(() => {
      foregroundReadFailures = 0;
    }, 350);
    const result = await tools.write.invoke(
      {},
      JSON.stringify({ session_id: 73, chars: "input", yield_time_ms: 1_000 }),
    );
    clearTimeout(recovery);
    expect(result).toContain("Process exited with code 0");
    expect(foregroundWrites).toBe(1);
    expect(starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("command_input observation exhaustion contains uncertainty without resending input", async () => {
  const f = fixture();
  const tools = foregroundTools(f);
  try {
    await tools.exec.invoke({}, JSON.stringify({ cmd: "work", yield_time_ms: 0 }));
    foregroundPollFailure = true;
    const result = await tools.input.invoke({}, JSON.stringify({ session_id: 73, chars: "input" }));
    expect(result).toContain("observation unavailable");
    expect(result).toContain("Do not replay");
    expect(result).not.toContain("Process exited");
    expect(foregroundWrites).toBe(1);
    expect(starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  "lifecycle exact-read uncertainty is typed rather than a fake successful exit (exhausted=%s)",
  async (exhausted) => {
    const f = fixture();
    const tools = foregroundTools(f);
    const controller = createTurnToolCancellationController();
    foregroundReadFailures = exhausted ? 100 : 1;
    try {
      const session = {
        execCommand: async (args: { cmd: string }) => tools.invoke({}, JSON.stringify(args)),
        writeStdin: (args: Parameters<NonNullable<typeof f.session.writeStdin>>[0]) =>
          f.session.writeStdin!(args),
      };
      const result = await controller
        .runSandboxCommandStructured(session, { cmd: "work", yieldTimeMs: 1_000 })
        .catch((error) => error);
      if (exhausted) expect(isProviderCommandObservationUnavailableError(result)).toBe(true);
      else expect(result).toMatchObject({ exitCode: 0, stdout: "initial" });
      expect(starts).toHaveLength(1);
      expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
    } finally {
      await f.close();
    }
  },
);

test("foreground cancellation aborts an already-in-flight exact poll", async () => {
  const f = fixture();
  const tools = foregroundTools(f);
  foregroundPollPending = true;
  try {
    const pending = tools.exec.invoke({}, JSON.stringify({ cmd: "work", yield_time_ms: 5_000 }));
    for (let attempt = 0; !observations.length && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(observations.length).toBeGreaterThan(0);
    const began = performance.now();
    tools.fence.cancel("pause");
    await expect(pending).rejects.toMatchObject({ name: "TurnSandboxCommandCancelledError" });
    await tools.fence.waitForQuiescence();
    expect(performance.now() - began).toBeLessThan(500);
    expect(foregroundPollCancelled).toBeGreaterThan(0);
    expect(starts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("post-start real gRPC poll exhaustion is an unknown tool result after the requested wait", async () => {
  const f = fixture();
  const tools = foregroundTools(f);
  foregroundPollFailure = true;
  const began = performance.now();
  try {
    const result = await tools.exec.invoke({}, JSON.stringify({ cmd: "work", yield_time_ms: 500 }));
    expect(performance.now() - began).toBeGreaterThanOrEqual(450);
    expect(result).toContain("observation unavailable");
    expect(result).toContain("Do not replay");
    expect(result).not.toContain("Process exited");
    expect(result).not.toContain("Please try again");
    expect(starts).toHaveLength(1);
    expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
    expect(tools.stored().streams.stdout.byteOffset).toBe(0);
    expect(tools.stored().streams.stdout.eof).toBe(false);
    expect(tools.adoptions()).toBe(0);
  } finally {
    await f.close();
  }
});

test.each(["task", "access"] as const)(
  "genuine %s preparation transport failure proves zero-Start non-dispatch",
  async (stage) => {
    const f = fixture("success", endpoint, { stage });
    try {
      const error = await f.control
        .verifyExecReadiness(AbortSignal.timeout(2_000))
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.cause.code).toBe(status.UNAVAILABLE);
      expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(true);
      expect(preparations).toEqual([stage]);
      expect(starts).toHaveLength(0);
      expect(f.sdkStarts()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

test.each(["task", "access"] as const)(
  "owning cancellation fences a late %s preparation reply without retry authority",
  async (stage) => {
    const f = fixture("success", endpoint, { stage, pending: true });
    const owner = new AbortController();
    const reason = new Error("owning attempt cancelled during preparation");
    try {
      const result = f.control.verifyExecReadiness(owner.signal).catch((caught) => caught);
      await f.enteredPreparation;
      owner.abort(reason);
      const error = await result;
      expect(error).toBe(reason);
      expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
      f.completePreparation();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(preparations).toEqual([stage]);
      expect(starts).toHaveLength(0);
      expect(f.sdkStarts()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

test("worker readiness uses native pre-dispatch proof instead of the pinned SDK DNS failure", async () => {
  const f = fixture();
  const client = (f.wire as any).client;
  const ready = client.waitForReady.bind(client);
  let gates = 0;
  client.waitForReady = (deadline: number, callback: (error?: Error) => void) => {
    if (++gates === 1) callback(new Error("local DNS resolver unavailable before dispatch"));
    else ready(deadline, callback);
  };
  try {
    await waitForSandboxExecReadiness(f.established, 2_000);
    expect(gates).toBe(2);
    expect(f.sdkStarts()).toBe(0);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ commandArgs: ["/bin/true"], workdir: "/tmp", env: {} });
    expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
  } finally {
    await f.close();
  }
});

test("real unresolved DNS remains within the worker readiness budget and sends no Start", async () => {
  const f = fixture("success", "https://task-readiness.invalid");
  const begun = performance.now();
  try {
    await expect(waitForSandboxExecReadiness(f.established, 200)).rejects.toBeInstanceOf(
      SandboxExecReadinessTimeoutError,
    );
    expect(performance.now() - begun).toBeLessThan(2_000);
    expect(starts).toHaveLength(0);
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("an accepted Start with DNS-shaped lost reply is observed once without replay", async () => {
  const f = fixture("lost-start");
  try {
    await waitForSandboxExecReadiness(f.established, 2_000);
    expect(starts).toHaveLength(1);
    expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("UNKNOWN and INTERNAL Start replies observe the accepted invocation without replay", async () => {
  for (const selected of ["unknown-start", "internal-start"] as const) {
    const f = fixture(selected);
    try {
      await waitForSandboxExecReadiness(f.established, 2_000);
      expect(starts).toHaveLength(1);
      expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
    } finally {
      await f.close();
    }
  }
});

test("transient output observation retries only the exact probe", async () => {
  const f = fixture("lost-read");
  try {
    await waitForSandboxExecReadiness(f.established, 2_000);
    expect(failedRead).toBe(true);
    expect(starts).toHaveLength(1);
    expect(new Set(observations)).toEqual(new Set([starts[0]!.execId]));
  } finally {
    await f.close();
  }
});

test("persistent uncertainty times out without another Start or fallback to SDK", async () => {
  const f = fixture("unobservable");
  try {
    await expect(waitForSandboxExecReadiness(f.established, 300)).rejects.toBeInstanceOf(
      SandboxExecReadinessTimeoutError,
    );
    expect(starts).toHaveLength(1);
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("definitive rejection and failed exit remain failures", async () => {
  for (const selected of ["rejected", "nonzero"] as const) {
    const f = fixture(selected);
    try {
      const error = await waitForSandboxExecReadiness(f.established, 2_000).catch(
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(
        selected === "rejected" ? ModalCommandStartRejectedError : SandboxExecReadinessError,
      );
      if (selected === "nonzero") expect(error.exitCode).toBe(127);
      expect(starts).toHaveLength(1);
    } finally {
      await f.close();
    }
  }
});

test("attempt cancellation stops readiness before dispatch and does not become retry authority", async () => {
  const f = fixture();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  (f.wire as any).client.waitForReady = () => {
    enter();
  };
  try {
    const result = verifySandboxExecReadiness(f.established, 2_000).catch((error) => error);
    await entered;
    await (f.session as any).cancelPendingExecCommand();
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SandboxExecReadinessError);
    expect(starts).toHaveLength(0);
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("the worker owning signal cancels readiness and fences a late channel-ready callback", async () => {
  const f = fixture();
  const owner = new AbortController();
  const reason = new Error("owning attempt cancelled");
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let ready!: (error?: Error) => void;
  (f.wire as any).client.waitForReady = (_deadline: number, callback: typeof ready) => {
    ready = callback;
    enter();
  };
  try {
    const result = waitForSandboxExecReadiness(f.established, 60_000, {}, owner.signal).catch(
      (caught) => caught,
    );
    await entered;
    owner.abort(reason);
    expect(await result).toBe(reason);
    ready();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(starts).toHaveLength(0);
    expect(f.sdkStarts()).toBe(0);
  } finally {
    await f.close();
  }
});
