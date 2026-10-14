import { describe, expect, test } from "bun:test";
import {
  ConnectionConfig,
  DefaultAdapterFactory,
  type Sandboxes,
} from "@alibaba-group/opensandbox";
import { shell } from "@openai/agents/sandbox";
import { OpenSandboxClient } from "../src/sandbox/providers/opensandbox-adapter";
import { SandboxChannelAService } from "../src/sandbox/channel-a";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import {
  runWithToolCallCorrelation,
  type RemoteOperationControl,
} from "../src/sandbox/op-correlation";
import {
  observeSynchronousCommand,
  synchronousCommandPage,
} from "../src/sandbox/synchronous-command";
import {
  withOpenSandboxCommandDispatchProof,
  withOpenSandboxCommandStreamProof,
} from "../src/sandbox/providers/opensandbox-command-stream";
import {
  createTurnToolCancellationController,
  TurnSandboxCommandCancelledError,
} from "../src/sandbox/turn-tool-cancellation";

const IMAGE = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function pending(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    Bun.sleep(30).then(() => true),
  ]);
}

/** Genuine default command, health, file and control adapters. The public
 * connection fetch/SSE hooks model an accepted mutation with no response ID;
 * only the unrelated lifecycle is stubbed. No SDK private state is accessed. */
async function fixture(
  mode: "headers" | "http500",
  held = false,
  delegatedFactory = false,
  malformedResult = false,
) {
  const release = deferred();
  const accepted = deferred();
  const readEntered = deferred();
  const calls: string[] = [];
  const starts: string[] = [];
  const interrupts: string[] = [];
  const statuses: string[] = [];
  const headerLoss = new Error("original response headers unavailable after acceptance");
  let running = false;
  const transport = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/command" && request.method === "POST") {
      starts.push(((await request.json()) as { command: string }).command);
      running = true;
      accepted.resolve();
      if (held) await release.promise;
      if (mode === "headers") throw headerLoss;
      return Response.json(
        { code: "EXECUTION_REPLY_UNAVAILABLE", message: "accepted command response failed" },
        { status: 500 },
      );
    }
    if (url.pathname === "/ping") return new Response("ok");
    if (url.pathname === "/directories" && request.method === "POST")
      return new Response(null, { status: 204 });
    if (url.pathname === "/command" && request.method === "DELETE") {
      interrupts.push(url.searchParams.get("id")!);
      return new Response("receipt unavailable", { status: 503 });
    }
    if (url.pathname.startsWith("/command/status/")) {
      statuses.push(url.pathname);
      return new Response("status unavailable", { status: 503 });
    }
    throw new Error(`unexpected fixture RPC: ${request.method} ${url.pathname}`);
  }) as typeof fetch;
  const info = {
    id: "sandbox-original",
    image: { uri: IMAGE },
    entrypoint: ["tail", "-f", "/dev/null"],
    metadata: {},
    extensions: {},
    status: { state: "Running" },
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
  const factory = new DefaultAdapterFactory();
  if (delegatedFactory || malformedResult) {
    const createDefault = factory.createExecdStack.bind(factory);
    factory.createExecdStack = (options) => {
      // A custom constructor changing its later method must not retroactively
      // authenticate the constructor that actually selected this transport.
      factory.createExecdStack = DefaultAdapterFactory.prototype.createExecdStack;
      const stack = createDefault(options);
      if (malformedResult) {
        const run = stack.commands.run.bind(stack.commands);
        stack.commands.run = async (...args) => {
          await run(...args).catch(() => undefined);
          return undefined as never;
        };
      }
      return stack;
    };
  }
  factory.createLifecycleStack = (options) => {
    // Override public connection hooks, not the default command constructor or
    // its run/runStream methods. Both still execute the pinned SDK wire path.
    Object.defineProperties(options.connectionConfig, {
      fetch: { configurable: true, value: transport },
      sseFetch: { configurable: true, value: transport },
    });
    return {
      sandboxes: {
        createSandbox: async () => info,
        getSandbox: async () => info,
        getSandboxEndpoint: async () => ({ endpoint: "exec.fixture.test" }),
      } as unknown as Sandboxes,
    };
  };
  const session = await new OpenSandboxClient({
    baseUrl: "https://lifecycle.fixture.test",
    apiKey: "fixture-key",
    image: IMAGE,
    ttlSeconds: 60,
    useServerProxy: true,
    readyTimeoutSeconds: 2,
    resourceLimits: { cpu: "1" },
    resourceRequests: { cpu: "1" },
    adapterFactory: factory,
  }).create();
  const write = session.writeStdin.bind(session);
  session.writeStdin = (args) => {
    readEntered.resolve();
    return write(args);
  };
  const abort = new AbortController();
  const controller = createTurnToolCancellationController(abort.signal);
  const events: unknown[] = [];
  const backend = { session, sandboxId: "sandbox-original", kind: "opensandbox", activeEpoch: 0 };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: "sandbox-original", activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    beforeMutation: async () => "admission",
    afterMutation: async () => {},
    adoptProcessAsBackgroundCommand: async () => {
      throw new Error("no internal background adoption");
    },
  });
  const service = new SandboxChannelAService({
    session: route,
    workspaceRoot: "/workspace",
    commandRunner: (adapter, args) =>
      controller.runSandboxCommandSynchronous(adapter, { ...args, yieldTimeMs: held ? 1 : 1_000 }),
    emit: async (batch) => {
      events.push(...batch);
    },
  });
  return {
    session,
    controller,
    abort,
    route,
    service,
    calls,
    starts,
    interrupts,
    statuses,
    events,
    headerLoss,
    transport,
    accepted: accepted.promise,
    readEntered: readEntered.promise,
    release: release.resolve,
    running: () => running,
    async close() {
      release.resolve();
      await session.close();
    },
  };
}

describe("OpenSandbox command dispatch uncertainty", () => {
  test("an unverified malformed result after accepted dispatch cannot manufacture terminal exit", async () => {
    const f = await fixture("headers", false, false, true);
    try {
      const result = await runWithToolCallCorrelation("malformed_result", () =>
        f.session.exec({ cmd: "mutation once", yieldTimeMs: 1_000 }),
      );
      expect(synchronousCommandPage(f.session, result)).toMatchObject({
        sessionId: 1,
        exitCode: null,
        collectionUnavailable: true,
      });
      expect(f.session.hasRetainedProcess(1)).toBe(true);
      expect(await f.session.observeExecCommand("malformed_result:0")).toEqual({
        status: "running",
      });
      expect(f.starts).toEqual(["mutation once"]);
      expect(f.running()).toBe(true);
      expect(f.statuses).toEqual([]);
      expect(f.interrupts).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test.each(["headers", "http500"] as const)(
    "native reads preserve their original %s error without terminal/no-dispatch proof",
    async (mode) => {
      const f = await fixture(mode);
      try {
        const error = await runWithToolCallCorrelation("native_read", () =>
          f.session.readFile({ path: "fixture/run.py" }),
        ).catch((cause: unknown) => cause);
        if (mode === "headers") expect(error).toBe(f.headerLoss);
        else
          expect(error).toMatchObject({
            statusCode: 500,
            error: { code: "EXECUTION_REPLY_UNAVAILABLE" },
          });
        expect(f.session.hasRetainedProcess(1)).toBe(true);
        expect(await f.session.observeExecCommand("native_read:0")).toEqual({ status: "running" });
        expect(await f.session.cancelExecCommand("native_read:0")).toBe(false);
        expect(f.starts).toHaveLength(1);
        expect(f.interrupts).toEqual([]);
        expect(f.statuses).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  test.each(["headers", "http500"] as const)(
    "dispatch evidence retains the actual default SDK %s cause",
    async (mode) => {
      const f = await fixture(mode);
      try {
        const config = new ConnectionConfig({ domain: "https://exec.fixture.test" });
        Object.defineProperty(config, "sseFetch", { configurable: true, value: f.transport });
        const commands = withOpenSandboxCommandStreamProof(
          new DefaultAdapterFactory(),
        ).createExecdStack({
          connectionConfig: config,
          execdBaseUrl: "https://exec.fixture.test",
        }).commands;
        const error = await withOpenSandboxCommandDispatchProof(commands, () =>
          commands.run("mutation once"),
        ).catch((cause: unknown) => cause);
        expect(error).toMatchObject({ notDispatched: false });
        const original = (error as Error).cause;
        if (mode === "headers") expect(original).toBe(f.headerLoss);
        else
          expect(original).toMatchObject({
            statusCode: 500,
            error: { code: "EXECUTION_REPLY_UNAVAILABLE" },
          });
        expect(f.starts).toEqual(["mutation once"]);
        expect(f.running()).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  test.each(["headers", "http500"] as const)(
    "accepted %s loss before initial yield returns unknown, never a synthetic exit",
    async (mode) => {
      const f = await fixture(mode);
      try {
        let control: RemoteOperationControl | undefined;
        const result = await runWithToolCallCorrelation(
          "original",
          () => f.session.exec({ cmd: "mutation once", yieldTimeMs: 1_000 }),
          {
            onRemoteOperationTransportSelected: (selected) => {
              control = selected;
            },
          },
        );
        const page = synchronousCommandPage(f.session, result);
        expect(page).toMatchObject({ sessionId: 1, exitCode: null, collectionUnavailable: true });
        expect(f.session.hasRetainedProcess(1)).toBe(true);
        expect(await f.session.cancelExecCommand("original:0")).toBe(false);
        expect(await control!.observeExecCommand!("original:0")).toEqual({ status: "running" });
        await expect(
          f.session.writeStdinForProcessControl({ sessionId: 1, chars: "" }),
        ).rejects.toThrow("identity");
        await expect(
          observeSynchronousCommand(page, async () => {
            throw new Error("must not read incomplete output");
          }),
        ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
        expect(f.starts).toEqual(["mutation once"]);
        expect(f.running()).toBe(true);
        expect(f.interrupts).toEqual([]);
        expect(f.statuses).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  test.each(["headers", "http500"] as const)(
    "accepted %s loss after numeric yield keeps the same unknown operation",
    async (mode) => {
      const f = await fixture(mode, true);
      try {
        const initial = await runWithToolCallCorrelation("original", () =>
          f.session.exec({ cmd: "mutation once", yieldTimeMs: 1 }),
        );
        expect(initial.sessionId).toBe(1);
        await f.accepted;
        f.release();
        const receipt = await f.session.writeStdinForProcessControl({
          sessionId: 1,
          chars: "",
          yieldTimeMs: 1_000,
        });
        const page = synchronousCommandPage(f.session, receipt, 1);
        expect(page).toMatchObject({ sessionId: 1, exitCode: null, collectionUnavailable: true });
        expect(f.session.hasRetainedProcess(1)).toBe(true);
        expect(await f.session.cancelExecCommand("original:0")).toBe(false);
        expect(await f.session.observeExecCommand("original:0")).toEqual({ status: "running" });
        await expect(
          observeSynchronousCommand(synchronousCommandPage(f.session, initial), async () => page),
        ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
        expect(f.starts).toEqual(["mutation once"]);
        expect(f.running()).toBe(true);
        expect(f.interrupts).toEqual([]);
        expect(f.statuses).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  test.each(["synchronous", "model"] as const)(
    "actual default SDK blank-command preflight settles unstarted %s custody",
    async (kind) => {
      const f = await fixture("headers");
      try {
        await f.session.start();
        f.calls.length = 0;
        if (kind === "synchronous") {
          await expect(
            f.controller.runSandboxCommandSynchronous(f.session, { cmd: "   " }),
          ).rejects.toThrow("command cannot be empty");
        } else {
          const exec = shell({
            configureTools: (tools) => f.controller.wrapTools(tools, f.session),
          })
            .clone()
            .bind(f.session)
            .tools()
            .find((tool) => tool.type === "function" && tool.name === "exec_command");
          if (!exec || exec.type !== "function") throw new Error("missing SDK exec tool");
          const output = await exec.invoke(
            {} as never,
            JSON.stringify({ cmd: "   ", tty: false }),
            {
              toolCall: {
                type: "function_call",
                callId: "local_refusal",
                name: "exec_command",
                arguments: "{}",
              },
            },
          );
          expect(output).toContain("command cannot be empty");
        }
        const drain = f.controller.waitForQuiescence();
        expect(await pending(drain)).toBe(false);
        await drain;
        expect(f.starts).toEqual([]);
        expect(f.calls).toEqual([]);
        expect(f.interrupts).toEqual([]);
        expect(f.statuses).toEqual([]);
        expect(f.running()).toBe(false);
      } finally {
        await f.close();
      }
    },
  );

  for (const [mode, held] of [
    ["headers", false],
    ["http500", false],
    ["headers", true],
    ["http500", true],
  ] as const) {
    test(`accepted no-ID ${mode} loss ${held ? "after" : "before"} yield has held cleanup and no filesystem success`, async () => {
      const f = await fixture(mode, held);
      try {
        const operation = f.service.fsWriteFiles({
          directory: "fixture",
          files: [{ path: "run.py", content: "print(42)\n" }],
        });
        if (held) {
          await f.readEntered;
          f.release();
        }
        await expect(operation).rejects.toMatchObject({
          code: "synchronous_command_outcome_unknown",
        });
        const drain = f.controller.waitForQuiescence();
        expect(await pending(drain)).toBe(true);
        expect(f.session.hasRetainedProcess(1)).toBe(true);
        expect(f.route.hasRetainedProcess(1)).toBe(true);
        expect(f.starts).toHaveLength(1);
        expect(f.running()).toBe(true);
        expect(f.interrupts).toEqual([]);
        expect(f.statuses).toEqual([]);
        expect(f.events).toEqual([]);
        expect(f.service.currentRevision()).toBe(0);
      } finally {
        await f.close();
      }
    });
  }

  test.each(["headers", "http500"] as const)(
    "won cancellation after accepted no-ID %s failure retains an unresolved physical join",
    async (mode) => {
      const f = await fixture(mode, true);
      try {
        const operation = f.service
          .fsWriteFiles({
            directory: "fixture",
            files: [{ path: "run.py", content: "print(42)\n" }],
          })
          .catch((error: unknown) => error);
        await f.readEntered;
        f.abort.abort(new Error("cancelled accepted filesystem command"));
        f.release();
        expect(await operation).toBeInstanceOf(TurnSandboxCommandCancelledError);
        expect(await pending(f.controller.waitForQuiescence())).toBe(true);
        expect(f.session.hasRetainedProcess(1)).toBe(true);
        expect(f.route.hasRetainedProcess(1)).toBe(true);
        expect(f.starts).toHaveLength(1);
        expect(f.running()).toBe(true);
        expect(f.interrupts).toEqual([]);
        expect(f.statuses).toEqual([]);
        expect(f.events).toEqual([]);
        expect(f.service.currentRevision()).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

  test("local no-dispatch proof cannot settle a different accepted operation in the same controller", async () => {
    const f = await fixture("headers", true);
    try {
      const first = f.controller
        .runSandboxCommandSynchronous(f.session, { cmd: "first mutation", yieldTimeMs: 1 })
        .catch((error: unknown) => error);
      await f.accepted;
      await expect(
        f.controller.runSandboxCommandSynchronous(f.session, { cmd: "   " }),
      ).rejects.toThrow("command cannot be empty");
      f.release();
      expect(await first).toMatchObject({
        code: "synchronous_command_outcome_unknown",
        sessionId: 1,
      });
      expect(await pending(f.controller.waitForQuiescence())).toBe(true);
      expect(f.session.hasRetainedProcess(1)).toBe(true);
      expect(f.starts).toEqual(["first mutation"]);
      expect(f.running()).toBe(true);
      expect(f.interrupts).toEqual([]);
      expect(f.statuses).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test("unverified custom factory absence of fetch cannot prove an unstarted command", async () => {
    const f = await fixture("headers", false, true);
    try {
      const result = await runWithToolCallCorrelation("unverified", () =>
        f.session.exec({ cmd: "   ", yieldTimeMs: 1_000 }),
      );
      expect(synchronousCommandPage(f.session, result)).toMatchObject({
        sessionId: 1,
        exitCode: null,
        collectionUnavailable: true,
      });
      expect(f.starts).toEqual([]);
      expect(await f.session.observeExecCommand("unverified:0")).toEqual({ status: "running" });
      expect(f.session.hasRetainedProcess(1)).toBe(true);
      expect(f.statuses).toEqual([]);
      expect(f.interrupts).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
