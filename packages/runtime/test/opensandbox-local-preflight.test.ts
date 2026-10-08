import { describe, expect, test } from "bun:test";
import {
  DefaultAdapterFactory,
  type AdapterFactory,
  type Sandboxes,
} from "@alibaba-group/opensandbox";
import { shell, SandboxUnsupportedFeatureError } from "@openai/agents/sandbox";
import { OpenSandboxClient } from "../src/sandbox/providers/opensandbox-adapter";
import {
  nextDurableOpId,
  runWithToolCallCorrelation,
  sanitizeOpIdToken,
} from "../src/sandbox/op-correlation";
import {
  createTurnToolCancellationController,
  TurnSandboxCommandCancelledError,
} from "../src/sandbox/turn-tool-cancellation";

const IMAGE = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
const PTY_ERROR =
  "OpenSandbox v1 does not expose a bidirectional PTY; run the command with tty=false.";

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

async function settles(promise: Promise<void>): Promise<void> {
  expect(await Promise.race([promise.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(
    true,
  );
}

/** Actual default SDK command/health/files/status/interrupt adapters use the
 * public connection transport. Only unrelated lifecycle responses are stubbed.
 * A cold custom factory additionally proves PTY validation precedes factory use. */
async function fixture(input: { held?: boolean; coldCustomFactory?: boolean } = {}) {
  const accepted = deferred();
  const release = deferred();
  const interrupted = deferred();
  const calls: string[] = [];
  const starts: string[] = [];
  const statuses: string[] = [];
  const interrupts: string[] = [];
  const acknowledgements: string[] = [];
  let running = false;
  let commandConstructors = 0;
  const event = (value: Record<string, unknown>) =>
    new TextEncoder().encode(`data: ${JSON.stringify({ timestamp: 1, ...value })}\n\n`);
  const transport = (async (url, init) => {
    const request = url instanceof Request ? url : new Request(url, init);
    const path = new URL(request.url);
    calls.push(`${request.method} ${path.pathname}`);
    if (path.pathname === "/ping") return new Response("ok");
    if (path.pathname === "/directories" && request.method === "POST")
      return new Response(null, { status: 204 });
    if (path.pathname === "/command" && request.method === "POST") {
      starts.push(((await request.json()) as { command: string }).command);
      running = true;
      accepted.resolve();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(event({ type: "init", text: "exec-original" }));
            controller.enqueue(event({ type: "stdout", text: "original output\n" }));
            const finish = () => {
              running = false;
              controller.enqueue(event({ type: "execution_complete" }));
              controller.close();
            };
            if (input.held) void release.promise.then(finish);
            else finish();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (path.pathname === "/command" && request.method === "DELETE") {
      interrupts.push(path.searchParams.get("id")!);
      interrupted.resolve();
      // Request delivery is advisory; the held command has not exited yet.
      return new Response(null, { status: 204 });
    }
    if (path.pathname.startsWith("/command/status/")) {
      statuses.push(decodeURIComponent(path.pathname.slice("/command/status/".length)));
      return Response.json({ id: "exec-original", running, exit_code: running ? null : 0 });
    }
    throw new Error(`unexpected fixture RPC: ${request.method} ${path.pathname}`);
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
  factory.createLifecycleStack = (options) => {
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
  if (input.coldCustomFactory) {
    factory.createExecdStack = () => {
      commandConstructors += 1;
      throw new Error("custom command factory must not be consulted for local PTY validation");
    };
  }
  const session = await new OpenSandboxClient({
    baseUrl: "https://lifecycle.fixture.test",
    apiKey: "fixture-key",
    image: IMAGE,
    ttlSeconds: 60,
    useServerProxy: true,
    readyTimeoutSeconds: 2,
    resourceLimits: { cpu: "1" },
    resourceRequests: { cpu: "1" },
    adapterFactory: factory as AdapterFactory,
  }).create();
  const acknowledge = session.acknowledgeCommandOutput.bind(session);
  session.acknowledgeCommandOutput = async (receipt) => {
    acknowledgements.push(receipt);
    await acknowledge(receipt);
  };
  if (!input.coldCustomFactory) await session.start();
  calls.length = 0;
  const controller = createTurnToolCancellationController();
  const exec = shell({ configureTools: (tools) => controller.wrapTools(tools, session) })
    .clone()
    .bind(session)
    .tools()
    .find((tool) => tool.type === "function" && tool.name === "exec_command");
  if (!exec || exec.type !== "function") throw new Error("missing actual SDK exec tool");
  return {
    session,
    controller,
    exec,
    calls,
    starts,
    statuses,
    interrupts,
    acknowledgements,
    accepted: accepted.promise,
    interrupted: interrupted.promise,
    finish: release.resolve,
    commandConstructors: () => commandConstructors,
    running: () => running,
    async close() {
      release.resolve();
      await session.close();
    },
  };
}

function expectNoDispatch(f: Awaited<ReturnType<typeof fixture>>): void {
  expect(f.calls).toEqual([]);
  expect(f.starts).toEqual([]);
  expect(f.statuses).toEqual([]);
  expect(f.interrupts).toEqual([]);
  expect(f.acknowledgements).toEqual([]);
  expect(f.running()).toBe(false);
  expect(f.session.hasRetainedProcess(1)).toBe(false);
}

describe("OpenSandbox provider-local preflight custody", () => {
  test.each(["exec", "execCommand"] as const)(
    "%s PTY refusal preserves the error and reports only its exact unstarted correlation",
    async (method) => {
      const f = await fixture();
      try {
        const unstarted: string[] = [];
        const selected: unknown[] = [];
        const callId = "call.pty/refusal";
        await runWithToolCallCorrelation(
          callId,
          async () => {
            const error = await f.session[method]({ cmd: "never dispatch", tty: true }).catch(
              (cause: unknown) => cause,
            );
            expect(error).toBeInstanceOf(SandboxUnsupportedFeatureError);
            expect(error).toMatchObject({ message: PTY_ERROR });
            expectNoDispatch(f);
            expect(unstarted).toEqual([`${sanitizeOpIdToken(callId)}:0`]);
            expect(nextDurableOpId()).toBe(`${sanitizeOpIdToken(callId)}:1`);
          },
          {
            onRemoteOperationNotDispatched: (opId) => unstarted.push(opId),
            onRemoteOperationTransportSelected: (control) => selected.push(control),
          },
        );
        expect(selected).toEqual([]);
        expectNoDispatch(f);
      } finally {
        await f.close();
      }
    },
  );

  test("the actual wrapped SDK model tool retires only its local PTY refusal", async () => {
    const f = await fixture();
    try {
      const output = await f.exec.invoke(
        {} as never,
        JSON.stringify({ cmd: "never dispatch", tty: true }),
        {
          toolCall: {
            type: "function_call",
            callId: "model.pty/refusal",
            name: "exec_command",
            arguments: "{}",
          },
        },
      );
      expect(output).toContain(PTY_ERROR);
      expect(output).not.toContain("Process exited with code");
      expectNoDispatch(f);
      await settles(f.controller.waitForQuiescence());
      expectNoDispatch(f);
    } finally {
      await f.close();
    }
  });

  test("structured internal PTY refusal rejects without a phantom joined operation", async () => {
    const f = await fixture();
    try {
      await expect(
        f.controller.runSandboxCommandStructured(f.session, { cmd: "never dispatch", tty: true }),
      ).rejects.toThrow(PTY_ERROR);
      expectNoDispatch(f);
      await settles(f.controller.waitForQuiescence());
      expectNoDispatch(f);
    } finally {
      await f.close();
    }
  });

  test("local PTY proof is owned before an unverified custom command factory is consulted", async () => {
    const f = await fixture({ coldCustomFactory: true });
    try {
      expect(
        await f.exec.invoke({} as never, JSON.stringify({ cmd: "never dispatch", tty: true })),
      ).toContain(PTY_ERROR);
      expect(f.commandConstructors()).toBe(0);
      expectNoDispatch(f);
      await settles(f.controller.waitForQuiescence());
      expect(f.commandConstructors()).toBe(0);
      expectNoDispatch(f);
    } finally {
      await f.close();
    }
  });

  test("simultaneous local PTY refusal cannot settle or retarget the accepted original command", async () => {
    const f = await fixture({ held: true });
    try {
      const original = f.controller
        .runSandboxCommandSynchronous(f.session, {
          cmd: "original accepted command",
          yieldTimeMs: 1,
        })
        .catch((error: unknown) => error);
      await f.accepted;
      const output = await f.exec.invoke(
        {} as never,
        JSON.stringify({ cmd: "never dispatch", tty: true }),
        {
          toolCall: {
            type: "function_call",
            callId: "different.pty/refusal",
            name: "exec_command",
            arguments: "{}",
          },
        },
      );
      expect(output).toContain(PTY_ERROR);
      expect(f.starts).toEqual(["original accepted command"]);
      expect(f.running()).toBe(true);
      expect(f.acknowledgements).toEqual([]);
      const drain = f.controller.waitForQuiescence();
      await settles(f.interrupted);
      expect(await pending(drain)).toBe(true);
      expect(f.running()).toBe(true);
      expect(f.interrupts.length).toBeGreaterThan(0);
      expect(f.interrupts.every((id) => id === "exec-original")).toBe(true);
      expect(f.statuses.every((id) => id === "exec-original")).toBe(true);
      f.finish();
      expect(await original).toBeInstanceOf(TurnSandboxCommandCancelledError);
      await settles(drain);
      expect(f.running()).toBe(false);
      expect(f.starts).toEqual(["original accepted command"]);
      expect(f.interrupts.every((id) => id === "exec-original")).toBe(true);
    } finally {
      await f.close();
    }
  });

  test("the synchronous filesystem entry remains non-PTY and uses the actual original command", async () => {
    const f = await fixture();
    try {
      expect(
        await f.controller.runSandboxCommandSynchronous(f.session, {
          cmd: "ordinary pipe command",
        }),
      ).toMatchObject({ exitCode: 0, stdout: "original output\n", stderr: "" });
      await settles(f.controller.waitForQuiescence());
      expect(f.starts).toEqual(["ordinary pipe command"]);
      expect(f.calls).toEqual(["POST /command"]);
      expect(f.interrupts).toEqual([]);
      expect(f.statuses).toEqual([]);
      expect(f.running()).toBe(false);
    } finally {
      await f.close();
    }
  });
});
