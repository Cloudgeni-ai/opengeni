import { expect, test } from "bun:test";
import {
  Client,
  Metadata,
  Server,
  ServerCredentials,
  credentials,
  status,
  type ServiceDefinition,
} from "@grpc/grpc-js";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Sandbox, CommandStartPreDispatchUnavailableError } from "modal";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import {
  ModalCommandStartOutcomeUnknownError,
  getModalCommandStartInvocation,
  installModalCommandStartContext,
  installModalCommandStartRetention,
  withModalCommandStartSignal,
} from "../src/sandbox/providers/modal-command-start-errors";
import { ProviderCommandStartOutcomeUnknownError } from "../src/sandbox/provider-command-session";
import { releaseModalCreateFailure } from "../src/sandbox/providers/modal-create-session";
import {
  ModalCommandRouterWire,
  modalRouterWire,
} from "../src/sandbox/providers/modal-command-router-wire";
import {
  isModalTaskExecStartPreDispatchUnavailableError,
  isModalCommandStartOutcomeUnknownError,
} from "../src/sandbox/providers/modal";
import { verifyModalMaterializedPath } from "../src/sandbox/providers/modal-materialization-verification";
import { materializationVerificationDiagnostic } from "../src/sandbox/materialization-verification-error";
import {
  agentRunFailurePayload,
  providerRecoveryResult,
  MAX_AUTOMATIC_PROVIDER_RECOVERIES,
} from "../../../apps/worker/src/activities/agent-turn/errors";

const service = "modal.task_command_router.TaskCommandRouter";
const dns = "Name resolution failed for target dns:task-spoof.w.modal.host:443";
const { ClientError } = createRequire(import.meta.resolve("modal"))("nice-grpc");
const cjs = createRequire(import.meta.url)("modal") as typeof import("modal");
const definition = (method: string, input: string, output: string, streaming = false) => ({
  path: `/${service}/${method}`,
  requestStream: false,
  responseStream: streaming,
  requestSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType(input).encode(value).finish()),
  requestDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(input).decode(bytes),
  responseSerialize: (value: object) =>
    Buffer.from(modalRouterWire.lookupType(output).encode(value).finish()),
  responseDeserialize: (bytes: Buffer) => modalRouterWire.lookupType(output).decode(bytes),
});

async function routerFixture(
  ambiguous = true,
  allowPathValidation = false,
  observation: "unknown" | "terminal" | "running" | "hanging" | "not-found" = "unknown",
  hangingStart = false,
) {
  const server = new Server();
  const starts: Array<{ taskId: string; execId: string; commandArgs: string[] }> = [];
  const closes: unknown[] = [];
  const polls: Array<{ taskId: string; execId: string }> = [];
  server.addService(
    {
      start: definition("TaskExecStart", "Start", "Empty"),
      read: definition("TaskExecStdioRead", "Read", "Data", true),
      poll: definition("TaskExecPoll", "Identity", "Poll"),
      wait: definition("TaskExecWait", "Identity", "Poll"),
      write: definition("TaskExecStdinWrite", "Write", "Empty"),
      close: definition("TestClose", "Identity", "Empty"),
    } as ServiceDefinition,
    {
      start(call: any, callback: any) {
        starts.push(call.request);
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        if (hangingStart) return;
        const validating =
          allowPathValidation &&
          call.request.commandArgs.some((arg: string) => arg.includes("resolve-workspace-path.sh"));
        if (ambiguous && !validating) callback({ code: status.UNAVAILABLE, details: dns });
        else callback(null, {});
      },
      read(call: any) {
        const start = starts.find((candidate) => candidate.execId === call.request.execId);
        if (
          call.request.fileDescriptor === 0 &&
          start?.commandArgs.includes("accepted-with-output")
        )
          call.write({ data: Buffer.from("original output\n") });
        if (
          allowPathValidation &&
          call.request.fileDescriptor === 0 &&
          start?.commandArgs.some((arg) => arg.includes("resolve-workspace-path.sh"))
        )
          call.write({ data: Buffer.from("/workspace\n") });
        call.end();
      },
      poll(call: any, callback: any) {
        polls.push(call.request);
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        if (ambiguous && observation === "hanging") return;
        if (ambiguous && (observation === "unknown" || observation === "not-found"))
          callback({
            code: observation === "not-found" ? status.NOT_FOUND : status.UNAVAILABLE,
            details: "original invocation not observable",
          });
        else callback(null, observation === "running" ? {} : { code: 0 });
      },
      wait(_call: any, callback: any) {
        callback(null, { code: 0 });
      },
      write(_call: any, callback: any) {
        callback(null, {});
      },
      close(call: any, callback: any) {
        closes.push(call.request);
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        callback({
          code: status.UNAVAILABLE,
          details: "sandbox close acknowledgement unavailable",
        });
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, boundPort) =>
      error ? reject(error) : resolve(boundPort),
    ),
  );
  return { server, starts, closes, polls, url: `https://127.0.0.1:${port}` };
}

function sdkSession(url: string, sdkModule: typeof import("modal") = { Sandbox } as never) {
  const modal = {
    profile: { serverUrl: "http://localhost" },
    logger: { debug: () => {}, warn: () => {} },
    cpClient: {
      taskGetCommandRouterAccess: async () => ({ url, jwt: "test-token" }),
      sandboxGetTaskId: async () => ({ taskId: "task-setup" }),
    },
  };
  const sandbox = new sdkModule.Sandbox(modal as never, "sb-resumed", { taskId: "task-setup" });
  installModalCommandStartContext(modal);
  // Same constructor/state used by SDK resume and the lease-owned creation
  // receipt before its manifest is applied. No OpenGeni wrapper can intercept
  // the SDK's private direct sandbox.exec calls here.
  const session = new ModalSandboxSession({
    modal,
    app: {},
    sandbox,
    ownsSandbox: false,
    state: {
      sandboxId: "sb-resumed",
      appName: "test",
      manifest: new Manifest({ root: "/workspace" }),
      environment: {},
      workspacePersistence: "tar",
      ownsSandbox: false,
      imageTag: "test",
    },
  } as never);
  return { sandbox, session, modal };
}

test("both SDK distributions prove DNS non-dispatch and use finite same-turn recovery", async () => {
  await Promise.all(
    [{ Sandbox, CommandStartPreDispatchUnavailableError } as typeof import("modal"), cjs].map(
      async (sdk) => {
        const f = sdkSession("https://task-command-start-does-not-exist.invalid", sdk);
        try {
          const failure = await f.session
            .execCommand({ cmd: "never-start", yieldTimeMs: 0 })
            .catch((error) => error);
          expect(failure).toBeInstanceOf(sdk.CommandStartPreDispatchUnavailableError);
          expect(failure.name).not.toBe("ClientError");
          expect(isModalTaskExecStartPreDispatchUnavailableError(failure)).toBe(true);
          expect(agentRunFailurePayload(failure)).toMatchObject({
            code: "sandbox_command_start_unavailable",
            retryable: true,
          });
          expect(
            providerRecoveryResult({
              failureCode: "sandbox_command_start_unavailable",
              attemptNumber: MAX_AUTOMATIC_PROVIDER_RECOVERIES + 1,
            }),
          ).toMatchObject({ status: "exhausted" });
        } finally {
          f.sandbox.detach();
        }
      },
    ),
  );
}, 15_000);

test("read-only task/router lookup failure proves non-dispatch, not rejection text", async () => {
  for (const stage of ["task", "router"] as const) {
    const f = sdkSession("https://127.0.0.1:1");
    const cause = new ClientError(
      "/modal.client.ModalClient/lookup",
      status.UNAVAILABLE,
      "lookup unavailable",
    );
    if (stage === "task") {
      f.sandbox.detach();
      f.modal.cpClient.sandboxGetTaskId = async () => {
        throw cause;
      };
      // A fresh handle has no cached task id.
      Object.assign(f, { sandbox: new Sandbox(f.modal as never, "sb-resumed") });
    } else
      f.modal.cpClient.taskGetCommandRouterAccess = async () => {
        throw cause;
      };
    try {
      const failure = await f.sandbox.exec(["never-start"]).catch((error) => error);
      expect(failure).toBeInstanceOf(CommandStartPreDispatchUnavailableError);
      expect(failure.cause).toBe(cause);
      expect(isModalTaskExecStartPreDispatchUnavailableError(failure)).toBe(true);
    } finally {
      f.sandbox.detach();
    }
  }
});

test("SDK-internal reprovision/setup/materialization paths never replay server-originated UNAVAILABLE", async () => {
  const f = await routerFixture();
  const tar = spawnSync("tar", ["-cf", "-", "--files-from", "/dev/null"]);
  expect(tar.status).toBe(0);
  const operations: Array<[string, (session: ModalSandboxSession) => Promise<unknown>]> = [
    ["setup exec", (session) => session.execCommand({ cmd: "setup-once", yieldTimeMs: 0 })],
    [
      "reprovision manifest",
      (session) =>
        session.applyManifest(
          new Manifest({ root: "/workspace", entries: { setup: { type: "dir" } } }),
        ),
    ],
    [
      "materialize entry",
      (session) => session.materializeEntry({ path: "dir", entry: { type: "dir" } }),
    ],
    ["filesystem path/read", (session) => session.readFile({ path: "file" })],
    ["runAs path/read", (session) => session.readFile({ path: "file", runAs: "root" })],
    ["tar capture", (session) => session.persistWorkspace()],
    ["tar hydration", (session) => session.hydrateWorkspace(tar.stdout)],
  ];
  try {
    for (const [label, run] of operations) {
      const { session, sandbox } = sdkSession(f.url);
      const before = f.starts.length;
      try {
        const failure = await run(session).catch((error) => error);
        expect(f.starts.length - before, label).toBe(1);
        expect(isModalCommandStartOutcomeUnknownError(failure), label).toBe(true);
        expect(isModalTaskExecStartPreDispatchUnavailableError(failure), label).toBe(false);
        expect(agentRunFailurePayload(failure), label).toMatchObject({
          code: "sandbox_command_start_outcome_unknown",
          retryable: false,
        });
      } finally {
        sandbox.detach();
      }
    }
  } finally {
    f.server.forceShutdown();
  }
});

test("both SDK distributions adopt the exact accepted Start before setup unwinds", async () => {
  const f = await routerFixture(true, true, "terminal");
  const tar = spawnSync("tar", ["-cf", "-", "--files-from", "/dev/null"]);
  expect(tar.status).toBe(0);
  try {
    for (const sdk of [{ Sandbox } as typeof import("modal"), cjs]) {
      const { session, sandbox } = sdkSession(f.url, sdk);
      try {
        const before = f.starts.length;
        await session.execCommand({ cmd: "setup-accepted-once", yieldTimeMs: 0 });
        await session.applyManifest(
          new Manifest({ root: "/workspace", entries: { setup: { type: "dir" } } }),
        );
        await session.materializeEntry({ path: "materialized", entry: { type: "dir" } });
        await session.hydrateWorkspace(tar.stdout);
        const starts = f.starts.slice(before);
        expect(starts.length).toBeGreaterThanOrEqual(4);
        expect(new Set(starts.map((start) => start.execId)).size).toBe(starts.length);
        for (const start of starts)
          if (!start.commandArgs.some((arg) => arg.includes("resolve-workspace-path.sh")))
            expect(
              f.polls.filter(
                (poll) => poll.taskId === start.taskId && poll.execId === start.execId,
              ),
            ).toHaveLength(1);
      } finally {
        sandbox.detach();
      }
    }
  } finally {
    f.server.forceShutdown();
  }
});

test("still-running exact-ID Poll adopts one original ContainerProcess, never a new Start", async () => {
  const f = await routerFixture(true, false, "running");
  try {
    for (const sdk of [{ Sandbox } as typeof import("modal"), cjs]) {
      const { sandbox } = sdkSession(f.url, sdk);
      try {
        const process = await sandbox.exec(["accepted-and-running"]);
        expect(await process.wait()).toBe(0);
        expect(f.starts).toHaveLength(f.polls.length);
        expect(f.starts.at(-1)!.taskId).toBe(f.polls.at(-1)!.taskId);
        expect(f.starts.at(-1)!.execId).toBe(f.polls.at(-1)!.execId);
      } finally {
        sandbox.detach();
      }
    }
    expect(f.starts).toHaveLength(2);
  } finally {
    f.server.forceShutdown();
  }
});

test("lost acknowledgement retains the original output and exit code", async () => {
  const f = await routerFixture(true, false, "terminal");
  const { sandbox } = sdkSession(f.url);
  try {
    const process = await sandbox.exec(["accepted-with-output"]);
    expect(await process.stdout.readText()).toBe("original output\n");
    expect(await process.wait()).toBe(0);
    expect(f.starts).toHaveLength(1);
    expect(f.polls[0]!.execId).toBe(f.starts[0]!.execId);
  } finally {
    sandbox.detach();
    f.server.forceShutdown();
  }
});

test("SDK adapter exhaustion exposes the complete durable command without fake supervision", async () => {
  const f = await routerFixture();
  const { sandbox, session } = sdkSession(f.url);
  installModalCommandStartRetention(session);
  try {
    const error = await session
      .applyManifest(new Manifest({ root: "/workspace", entries: { once: { type: "dir" } } }))
      .catch((failure) => failure);
    expect(error).toBeInstanceOf(ProviderCommandStartOutcomeUnknownError);
    expect(error.command).toMatchObject({
      kind: "modal-router-v1",
      sandboxId: "sb-resumed",
      taskId: "task-setup",
      execId: f.starts[0]!.execId,
      streams: { stdout: { byteOffset: 0, eof: false }, stderr: { byteOffset: 0, eof: false } },
    });
    expect(error.command.supervision).toBeUndefined();
    expect(getModalCommandStartInvocation(error)).toMatchObject({ execId: f.starts[0]!.execId });
    expect(f.starts).toHaveLength(1);
    let physicalCloses = 0;
    let transportCloses = 0;
    const released = await releaseModalCreateFailure(
      {
        close: async () => {
          physicalCloses++;
        },
      },
      {
        close: () => {
          transportCloses++;
        },
      },
      error,
    ).catch((failure) => failure);
    expect(released).toBe(error);
    expect(physicalCloses).toBe(0);
    expect(transportCloses).toBe(1);
    expect(f.starts).toHaveLength(1);
  } finally {
    sandbox.detach();
    f.server.forceShutdown();
  }
});

test("owning cancellation of a dispatched hanging Start retains IDs and cannot launch late", async () => {
  const f = await routerFixture(true, false, "terminal", true);
  const { sandbox, session } = sdkSession(f.url);
  const controller = new AbortController();
  const started = Date.now();
  const pending = withModalCommandStartSignal(controller.signal, () =>
    session
      .materializeEntry({ path: "cancelled-once", entry: { type: "dir" } })
      .catch((error) => error),
  );
  const timer = setTimeout(() => controller.abort(new Error("owning turn cancelled")), 100);
  try {
    const error = await pending;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(getModalCommandStartInvocation(error)).toMatchObject({ execId: f.starts[0]!.execId });
    expect(f.starts).toHaveLength(1);
    expect(f.polls).toHaveLength(0);
  } finally {
    clearTimeout(timer);
    sandbox.detach();
    f.server.forceShutdown();
  }
});

test("a hanging Start acknowledgement is transport-bounded and adopts the original accepted IDs", async () => {
  const f = await routerFixture(true, false, "terminal", true);
  const { sandbox } = sdkSession(f.url);
  const started = Date.now();
  try {
    const process = await sandbox.exec(["accepted-with-output"]);
    expect(Date.now() - started).toBeLessThan(7500);
    expect(await process.stdout.readText()).toBe("original output\n");
    expect(await process.wait()).toBe(0);
    expect(f.starts).toHaveLength(1);
    expect(f.polls).toHaveLength(1);
    expect(f.polls[0]!.execId).toBe(f.starts[0]!.execId);
  } finally {
    sandbox.detach();
    f.server.forceShutdown();
  }
}, 10_000);

test("owning cancellation during read-only router lookup prevents a late Start", async () => {
  const f = await routerFixture(true, false, "terminal");
  const { sandbox, session, modal } = sdkSession(f.url);
  const controller = new AbortController();
  let release: (access: { url: string; jwt: string }) => void = () => {};
  modal.cpClient.taskGetCommandRouterAccess = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = withModalCommandStartSignal(controller.signal, () =>
    session
      .materializeEntry({ path: "never-start", entry: { type: "dir" } })
      .catch((failure) => failure),
  );
  const timer = setTimeout(() => controller.abort(new Error("lookup cancelled")), 100);
  try {
    const error = await pending;
    expect(error).toBe(controller.signal.reason);
    expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
    release({ url: f.url, jwt: "test-token" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.starts).toHaveLength(0);
    expect(f.polls).toHaveLength(0);
  } finally {
    clearTimeout(timer);
    sandbox.detach();
    f.server.forceShutdown();
  }
});

test("failed and NOT_FOUND original-ID observations retain immutable descriptors without replay", async () => {
  for (const observation of ["unknown", "not-found"] as const) {
    const f = await routerFixture(true, false, observation);
    const { sandbox, session } = sdkSession(f.url);
    try {
      const error = await session
        .materializeEntry({ path: "once", entry: { type: "dir" } })
        .catch((failure) => failure);
      expect(isModalCommandStartOutcomeUnknownError(error)).toBe(true);
      const invocation = getModalCommandStartInvocation(error);
      expect(invocation).not.toBeNull();
      expect(invocation).toMatchObject({
        sandboxId: "sb-resumed",
        taskId: f.starts[0]!.taskId,
        execId: f.starts[0]!.execId,
      });
      expect(Object.isFrozen(invocation)).toBe(true);
      expect(f.polls).toHaveLength(3);
      expect(new Set(f.polls.map((poll) => poll.execId))).toEqual(new Set([f.starts[0]!.execId]));
      await expect(invocation!.observe(undefined, 100)).rejects.toThrow();
      expect(f.starts).toHaveLength(1);
      expect(f.polls.length).toBeGreaterThanOrEqual(4);
      expect(f.polls.length).toBeLessThanOrEqual(6);
    } finally {
      sandbox.detach();
      f.server.forceShutdown();
    }
  }
});

test("hanging observation has transport and attempt bounds; cancellation retains original IDs", async () => {
  for (const cancel of [false, true]) {
    const f = await routerFixture(true, false, "hanging");
    const { sandbox, session } = sdkSession(f.url);
    const controller = new AbortController();
    const started = Date.now();
    const pending = withModalCommandStartSignal(controller.signal, () =>
      session
        .materializeEntry({ path: "bounded-once", entry: { type: "dir" } })
        .catch((error) => error),
    );
    const timer = cancel
      ? setTimeout(() => controller.abort(new Error("owning turn cancelled")), 100)
      : undefined;
    try {
      const error = await pending;
      const duration = Date.now() - started;
      expect(duration).toBeLessThan(cancel ? 1500 : 5000);
      expect(isModalCommandStartOutcomeUnknownError(error)).toBe(true);
      expect(getModalCommandStartInvocation(error)).toMatchObject({ execId: f.starts[0]!.execId });
      expect(f.starts).toHaveLength(1);
      expect(f.polls.length).toBeLessThanOrEqual(cancel ? 1 : 3);
      const retained = getModalCommandStartInvocation(error)!;
      const observationStarted = Date.now();
      await expect(retained.observe(undefined, 50)).rejects.toThrow();
      expect(Date.now() - observationStarted).toBeLessThan(1000);
      expect(f.starts).toHaveLength(1);
    } finally {
      if (timer) clearTimeout(timer);
      sandbox.detach();
      f.server.forceShutdown();
    }
  }
}, 10_000);

test("dual manifest and close failure preserves genuine Start uncertainty in both installed helper distributions", async () => {
  const extensionEntry = import.meta.resolve("@openai/agents-extensions/sandbox/modal");
  const esm = await import(new URL("../shared/session.mjs", extensionEntry).href);
  const common = createRequire(extensionEntry)("../shared/session.js");
  const f = await routerFixture();
  const closeClient = new Client(new URL(f.url).host, credentials.createInsecure(), {
    "grpc.enable_retries": 0,
  });
  const closeWire = definition("TestClose", "Identity", "Empty");
  const metadata = new Metadata();
  metadata.set("authorization", "Bearer test-token");
  try {
    for (const [sdk, close] of [
      [{ Sandbox } as typeof import("modal"), esm.closeRemoteSessionOnManifestError],
      [cjs, common.closeRemoteSessionOnManifestError],
    ] as const) {
      const { sandbox, session } = sdkSession(f.url, sdk);
      const beforeStarts = f.starts.length;
      const beforeCloses = f.closes.length;
      try {
        const manifestError = await session
          .applyManifest(new Manifest({ root: "/workspace", entries: { setup: { type: "dir" } } }))
          .catch((error) => error);
        expect(isModalCommandStartOutcomeUnknownError(manifestError)).toBe(true);
        let closeError: unknown;
        const error = await close(
          "Modal",
          {
            close: async () => {
              try {
                await new Promise<void>((resolve, reject) =>
                  closeClient.makeUnaryRequest(
                    closeWire.path,
                    closeWire.requestSerialize,
                    closeWire.responseDeserialize,
                    { taskId: "task-setup", execId: "" },
                    metadata,
                    (failure) => (failure ? reject(failure) : resolve()),
                  ),
                );
              } catch (failure) {
                closeError = failure;
                throw failure;
              }
            },
          },
          manifestError,
        ).catch((failure: unknown) => failure);
        expect(error.cause).toBeInstanceOf(AggregateError);
        expect(error.cause.errors).toHaveLength(2);
        expect(error.cause.errors[0]).toBe(manifestError);
        expect(error.cause.errors[1]).toBe(closeError);
        expect(closeError).toMatchObject({ code: status.UNAVAILABLE });
        expect(isModalCommandStartOutcomeUnknownError(error)).toBe(true);
        expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
        expect(f.starts.length - beforeStarts).toBe(1);
        expect(f.closes.length - beforeCloses).toBe(1);
      } finally {
        sandbox.detach();
      }
    }
  } finally {
    closeClient.close();
    f.server.forceShutdown();
  }
}, 20_000);

test("native capability/control/materialization Starts also contain ambiguous gRPC outcomes", async () => {
  const f = await routerFixture();
  const wire = new ModalCommandRouterWire({ url: f.url, jwt: "test-token" });
  // Use an actual local gRPC transport without TLS; the production wire's
  // authenticated TLS behavior is covered by modal-command-router-wire.test.
  (wire as any).client.close();
  Object.defineProperty(wire, "client", {
    value: new Client(new URL(f.url).host, credentials.createInsecure()),
  });
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: { sandboxGetTaskId: async () => ({ taskId: "task-setup" }) },
    } as never,
    "sb-resumed",
    "/workspace",
  );
  Object.defineProperty(control, "withRouter", {
    value: async (
      _task: string,
      _signal: AbortSignal,
      run: (wire: ModalCommandRouterWire) => Promise<unknown>,
    ) => run(wire),
  });
  const command = {
    kind: "modal-router-v1",
    sandboxId: "sb-resumed",
    taskId: "task-setup",
    execId: crypto.randomUUID(),
    supervision: {
      invocationId: crypto.randomUUID(),
      nonce: "a".repeat(64),
      controlPath: `/tmp/opengeni-supervision/${crypto.randomUUID()}.sock`,
      protocol: "native-subreaper-v1",
    },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  } as const;
  try {
    const capability = await control.verifySupervisionCapability().catch((error) => error);
    expect(capability).toBeInstanceOf(ModalCommandStartOutcomeUnknownError);
    const controlFailure = await control
      .supervisionControl(command as never, "status")
      .catch((error) => error);
    expect(controlFailure).toBeInstanceOf(ModalCommandStartOutcomeUnknownError);
    const pending = new Set<AbortController>();
    const probe = await verifyModalMaterializedPath(control, "dir", "/workspace", pending).catch(
      (error) => error,
    );
    expect(isModalCommandStartOutcomeUnknownError(probe)).toBe(true);
    expect(materializationVerificationDiagnostic(probe)).toMatchObject({ reason: "command_error" });
    expect(pending.size).toBe(0);
    expect(f.starts).toHaveLength(3);
    for (const failure of [capability, controlFailure, probe])
      expect(agentRunFailurePayload(failure)).toMatchObject({
        code: "sandbox_command_start_outcome_unknown",
        retryable: false,
      });
  } finally {
    wire.close();
    await control.close();
    f.server.forceShutdown();
  }
});

test("reconstructed setup succeeds after a proven non-dispatched lookup failure", async () => {
  const f = await routerFixture(false);
  const first = sdkSession(f.url);
  first.modal.cpClient.taskGetCommandRouterAccess = async () => {
    throw new ClientError("lookup", status.UNAVAILABLE, "router unavailable");
  };
  try {
    const failure = await first.session
      .execCommand({ cmd: "setup-once", yieldTimeMs: 0 })
      .catch((error) => error);
    expect(isModalTaskExecStartPreDispatchUnavailableError(failure)).toBe(true);
    expect(f.starts).toHaveLength(0);
    const resumed = sdkSession(f.url);
    try {
      expect(await resumed.session.execCommand({ cmd: "setup-once", yieldTimeMs: 1000 })).toContain(
        "Process exited with code 0",
      );
      expect(f.starts).toHaveLength(1);
      await resumed.session.close();
    } finally {
      resumed.sandbox.detach();
    }
  } finally {
    first.sandbox.detach();
    f.server.forceShutdown();
  }
});

test("later archive capture/hydration failures preserve the genuine dispatch boundary through SDK catch wrappers", async () => {
  const f = await routerFixture(true, true);
  const tar = spawnSync("tar", ["-cf", "-", "--files-from", "/dev/null"]);
  expect(tar.status).toBe(0);
  try {
    for (const operation of ["capture", "hydrate"] as const) {
      const { session, sandbox } = sdkSession(f.url);
      const before = f.starts.length;
      try {
        const failure = await (
          operation === "capture"
            ? session.persistWorkspace()
            : session.hydrateWorkspace(tar.stdout)
        ).catch((error) => error);
        expect(failure).toMatchObject({
          code: "archive_error",
          cause: { name: "CommandStartOutcomeUnknownError", cause: { code: status.UNAVAILABLE } },
        });
        expect(isModalTaskExecStartPreDispatchUnavailableError(failure)).toBe(false);
        expect(agentRunFailurePayload(failure)).toMatchObject({
          code: "sandbox_command_start_outcome_unknown",
          retryable: false,
        });
        const starts = f.starts.slice(before);
        // Path validation, one uncertain operation, and the SDK's distinct
        // best-effort temporary-archive cleanup. The uncertain Start is not replayed.
        expect(starts).toHaveLength(3);
        expect(new Set(starts.map((start) => start.execId)).size).toBe(3);
        expect(
          starts.filter((start) =>
            start.commandArgs.some((arg) => arg.includes("tar -C") || arg.includes("WriteFile")),
          ),
        ).toHaveLength(1);
      } finally {
        sandbox.detach();
      }
    }
  } finally {
    f.server.forceShutdown();
  }
});
