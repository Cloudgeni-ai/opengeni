import { describe, expect, test } from "bun:test";
import {
  DefaultAdapterFactory,
  type AdapterFactory,
  type Sandboxes,
} from "@alibaba-group/opensandbox";
import { OpenSandboxClient } from "../src/sandbox/providers/opensandbox-adapter";
import { SandboxChannelAService } from "../src/sandbox/channel-a";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import {
  runWithToolCallCorrelation,
  type RemoteOperationControl,
} from "../src/sandbox/op-correlation";
import {
  createTurnToolCancellationController,
  TurnSandboxCommandCancelledError,
} from "../src/sandbox/turn-tool-cancellation";

const IMAGE = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
const PREFIX = "__OGF_D__0____OGF_W__0____OPENGENI_FS_BATCH_OK__";
const STDERR = "before stream loss\n";

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

async function settles(promise: Promise<unknown>): Promise<void> {
  expect(await Promise.race([promise.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(
    true,
  );
}

async function waitForQuery(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("original operation observation did not reach the fixture");
}

/** The command, status and interrupt services are real default SDK HTTP
 * adapters. Only unrelated lifecycle, health and directory setup are stubbed. */
async function fixture(
  input: { held?: boolean; failCapture?: boolean; executionIds?: string[] } = {},
) {
  const release = deferred();
  const readEntered = deferred();
  const interrupted = deferred();
  const commands: string[] = [];
  const interrupts: string[] = [];
  const queries: string[] = [];
  const observations: Array<{ requestedId: string; returnedId: string | null }> = [];
  let status = { id: "exec-original", running: true, exit_code: null as number | null };
  const statuses = new Map<string, typeof status>();
  let offline = false;
  const event = (value: Record<string, unknown>) =>
    new TextEncoder().encode(`data: ${JSON.stringify({ timestamp: 1, ...value })}\n\n`);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/command" && request.method === "POST") {
        commands.push(((await request.json()) as { command: string }).command);
        const executionId = input.executionIds?.[commands.length - 1] ?? "exec-original";
        if (input.executionIds)
          statuses.set(executionId, { id: executionId, running: true, exit_code: null });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(event({ type: "init", text: executionId }));
              controller.enqueue(event({ type: "stdout", text: PREFIX }));
              controller.enqueue(event({ type: "stderr", text: STDERR }));
              const finish = () => {
                controller.enqueue(new TextEncoder().encode("data: {not json}\n\n"));
                controller.close();
              };
              if (input.held) void release.promise.then(finish);
              else finish();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.pathname === "/command" && request.method === "DELETE") {
        interrupts.push(url.searchParams.get("id")!);
        interrupted.resolve();
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith("/command/status/")) {
        const executionId = decodeURIComponent(url.pathname.slice("/command/status/".length));
        queries.push(executionId);
        const response = statuses.get(executionId) ?? status;
        observations.push({ requestedId: executionId, returnedId: offline ? null : response.id });
        return offline
          ? new Response("observer offline", { status: 503 })
          : Response.json(response);
      }
      return new Response("unexpected fixture request", { status: 404 });
    },
  });
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
  const native = new DefaultAdapterFactory();
  const factory: AdapterFactory = {
    createLifecycleStack: () => ({
      sandboxes: {
        createSandbox: async () => info,
        getSandbox: async () => info,
        getSandboxEndpoint: async () => ({ endpoint: server.url.host }),
      } as unknown as Sandboxes,
    }),
    createExecdStack: (options) => {
      const stack = native.createExecdStack(options);
      return {
        ...stack,
        health: { ping: async () => true },
        files: { ...stack.files, createDirectories: async () => {} },
      } as ReturnType<AdapterFactory["createExecdStack"]>;
    },
    createEgressStack: (options) => native.createEgressStack(options),
  };
  const session = await new OpenSandboxClient({
    baseUrl: server.url.origin,
    apiKey: "fixture-key",
    image: IMAGE,
    ttlSeconds: 60,
    useServerProxy: true,
    readyTimeoutSeconds: 2,
    resourceLimits: { cpu: "1" },
    resourceRequests: { cpu: "1" },
    adapterFactory: factory,
  }).create();
  const reads: number[] = [];
  const acknowledgements: string[] = [];
  const write = session.writeStdin.bind(session);
  session.writeStdin = (args) => {
    reads.push(args.sessionId);
    const result = write(args);
    readEntered.resolve();
    return result;
  };
  const acknowledge = session.acknowledgeCommandOutput.bind(session);
  session.acknowledgeCommandOutput = async (receipt) => {
    acknowledgements.push(receipt);
    await acknowledge(receipt);
  };
  const abort = new AbortController();
  const controller = createTurnToolCancellationController(abort.signal);
  const captured = new Map<string, { stream: string; chunk: string }>();
  const settled: number[] = [];
  const events: unknown[] = [];
  let failCapture = input.failCapture ?? false;
  let failSettlement = false;
  let successorCalls = 0;
  let pointer = { activeSandboxId: "sandbox-original", activeEpoch: 0 };
  const backend = { session, sandboxId: "sandbox-original", kind: "opensandbox", activeEpoch: 0 };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => pointer,
    resolveActiveBackend: async (resolvedPointer) => {
      if (resolvedPointer.activeSandboxId === "sandbox-original") return backend;
      successorCalls++;
      throw new Error("cleanup must not resolve the successor backend");
    },
    beforeMutation: async () => "owned admission",
    afterMutation: async () => {},
    captureProcessOutput: async (page) => {
      if (failCapture) {
        failCapture = false;
        throw new Error("capture unavailable");
      }
      expect(page.streamFidelity).toBe("separate");
      captured.set(page.chunkId, { stream: page.stream, chunk: page.chunk });
    },
    settleProcess: async ({ backend: retainedBackend, process, proof }) => {
      expect(retainedBackend.sandboxId).toBe("sandbox-original");
      expect(proof.exitCode).toBe(0);
      if (failSettlement) {
        failSettlement = false;
        throw new Error("settlement unavailable");
      }
      settled.push(process.providerSessionId);
    },
    adoptProcessAsBackgroundCommand: async () => {
      throw new Error("no background adoption");
    },
  });
  const service = new SandboxChannelAService({
    session: route,
    workspaceRoot: "/workspace",
    commandRunner: (adapter, args) =>
      controller.runSandboxCommandSynchronous(adapter, {
        ...args,
        yieldTimeMs: input.held ? 1 : 1_000,
      }),
    emit: async (batch) => {
      events.push(...batch);
    },
  });
  return {
    session,
    route,
    controller,
    abort,
    service,
    commands,
    interrupts,
    queries,
    observations,
    captured,
    settled,
    events,
    reads,
    acknowledgements,
    readEntered: readEntered.promise,
    interrupted: interrupted.promise,
    release: release.resolve,
    status(value: typeof status) {
      status = value;
    },
    statusFor(executionId: string, value: typeof status) {
      statuses.set(executionId, value);
    },
    offline(value: boolean) {
      offline = value;
    },
    failCapture() {
      failCapture = true;
    },
    failSettlement() {
      failSettlement = true;
    },
    swap() {
      pointer = { activeSandboxId: "sandbox-successor", activeEpoch: 1 };
    },
    successorCalls: () => successorCalls,
    write: () =>
      service.fsWriteFiles({
        directory: "fixture",
        files: [{ path: "run.py", content: "print(42)\n" }],
      }),
    async close() {
      release.resolve();
      await session.close();
      await server.stop(true);
    },
  };
}

describe("OpenSandbox joined physical reconciliation", () => {
  test("exact proof-only observer never consumes or acknowledges retained output", async () => {
    const f = await fixture();
    try {
      let control: RemoteOperationControl | undefined;
      const receipt = await runWithToolCallCorrelation(
        "proof_only",
        () => f.session.execCommand({ cmd: "fixture mutation", yieldTimeMs: 1_000 }),
        {
          onRemoteOperationTransportSelected: (selected) => {
            control = selected;
          },
        },
      );
      const original = structuredClone(f.session.getSynchronousCommandOutput(receipt));
      expect(original).toMatchObject({
        sessionId: 1,
        stdout: PREFIX,
        stderr: STDERR,
        exitCode: null,
        collectionUnavailable: true,
        outputCursor: {
          next: { stdout: Buffer.byteLength(PREFIX), stderr: Buffer.byteLength(STDERR) },
        },
      });
      expect(control?.observeExecCommand).toBeFunction();
      await expect(control!.observeExecCommand!("foreign:0")).rejects.toThrow("identity");
      await expect(control!.cancelExecCommand!("foreign:0")).rejects.toThrow("identity");
      expect(await f.session.observeExecCommand("proof_only:0")).toEqual({ status: "running" });
      f.status({ id: "exec-other", running: false, exit_code: 0 });
      await expect(control!.observeExecCommand!("proof_only:0")).rejects.toThrow("identity");
      f.status({ id: "exec-original", running: false, exit_code: null });
      expect(await control!.observeExecCommand!("proof_only:0")).toEqual({ status: "running" });
      f.offline(true);
      await expect(control!.observeExecCommand!("proof_only:0")).rejects.toThrow();
      f.offline(false);
      f.status({ id: "exec-original", running: false, exit_code: 7 });
      const proof = await control!.observeExecCommand!("proof_only:0");
      expect(proof).toMatchObject({ status: "completed", result: { exitCode: 7 } });
      if (proof.status !== "completed") throw new Error("expected exact physical proof");
      expect(proof.failure).toMatchObject({
        code: "synchronous_command_outcome_unknown",
        sessionId: 1,
      });
      expect(f.session.getSynchronousCommandOutput(receipt)).toEqual(original);
      expect(f.session.hasRetainedProcess(1)).toBe(true);
      expect(f.reads).toEqual([]);
      expect(f.acknowledgements).toEqual([]);
      const terminal = await f.session.writeStdin({ sessionId: 1, chars: "" });
      expect(f.session.getSynchronousCommandOutput(terminal)).toMatchObject({
        stdout: "",
        stderr: "",
        exitCode: 7,
        collectionUnavailable: true,
        outputCursor: {
          expected: original!.outputCursor!.next,
          next: original!.outputCursor!.next,
        },
      });
      expect(f.session.hasRetainedProcess(1)).toBe(false);
      f.offline(true);
      const queryCount = f.queries.length;
      expect(await control!.observeExecCommand!("proof_only:0")).toMatchObject({
        status: "completed",
        result: { exitCode: 7 },
      });
      expect(await control!.cancelExecCommand!("proof_only:0")).toBe(true);
      expect(f.queries).toHaveLength(queryCount);
      expect(f.interrupts).toEqual([]);
      expect(f.commands).toHaveLength(1);
      expect(new Set(f.queries)).toEqual(new Set(["exec-original"]));
    } finally {
      await f.close();
    }
  });

  test("externally retired exact command still settles controller drain without FS success", async () => {
    const f = await fixture();
    try {
      await expect(f.write()).rejects.toMatchObject({
        code: "synchronous_command_outcome_unknown",
      });
      const drain = f.controller.waitForQuiescence();
      await f.interrupted;
      expect(await pending(drain)).toBe(true);
      f.status({ id: "exec-other", running: false, exit_code: 0 });
      await expect(
        f.route.writeStdinForProcessControl({ sessionId: 1, chars: "" }),
      ).rejects.toThrow("identity");
      expect(await pending(drain)).toBe(true);
      expect(f.route.hasRetainedProcess(1)).toBe(true);
      f.status({ id: "exec-original", running: false, exit_code: 0 });
      const terminal = await f.route.writeStdinForProcessControl({ sessionId: 1, chars: "" });
      expect(f.session.getSynchronousCommandOutput(terminal)).toMatchObject({
        exitCode: 0,
        collectionUnavailable: true,
      });
      expect(f.route.hasRetainedProcess(1)).toBe(false);
      expect(f.session.hasRetainedProcess(1)).toBe(false);
      await settles(drain);
      expect(f.commands).toHaveLength(1);
      expect(f.interrupts).toEqual(["exec-original"]);
      expect(new Set(f.queries)).toEqual(new Set(["exec-original"]));
      expect(f.settled).toEqual([1]);
      expect(f.events).toEqual([]);
      expect(f.service.currentRevision()).toBe(0);
    } finally {
      await f.close();
    }
  });

  test("won cancellation replaces unknown output error while physical drain stays held", async () => {
    const f = await fixture({ held: true });
    try {
      const operation = f.write().catch((error: unknown) => error);
      await f.readEntered;
      f.abort.abort(new Error("cancelled filesystem command"));
      await f.interrupted;
      f.release();
      expect(await operation).toBeInstanceOf(TurnSandboxCommandCancelledError);
      const drain = f.controller.waitForQuiescence();
      expect(await pending(drain)).toBe(true);
      f.offline(true);
      await waitForQuery(() => f.observations.some((page) => page.returnedId === null));
      expect(await pending(drain)).toBe(true);
      f.offline(false);
      f.status({ id: "exec-other", running: false, exit_code: 0 });
      await waitForQuery(() => f.observations.some((page) => page.returnedId === "exec-other"));
      expect(await pending(drain)).toBe(true);
      f.swap();
      f.status({ id: "exec-original", running: false, exit_code: 0 });
      await f.route.writeStdinForProcessControl({ sessionId: 1, chars: "" });
      await settles(drain);
      expect(f.commands).toHaveLength(1);
      expect(f.interrupts).toEqual(["exec-original"]);
      expect(f.successorCalls()).toBe(0);
      expect(f.events).toEqual([]);
      expect(f.service.currentRevision()).toBe(0);
    } finally {
      await f.close();
    }
  });

  test("physical drain never discards failed capture or failed routed settlement custody", async () => {
    const f = await fixture({ failCapture: true });
    try {
      await expect(f.write()).rejects.toThrow("output could not be retained");
      expect(f.captured.size).toBe(0);
      expect(f.acknowledgements).toEqual([]);
      expect(f.route.hasRetainedProcess(1)).toBe(true);
      const drain = f.controller.waitForQuiescence();
      await f.interrupted;
      expect(await pending(drain)).toBe(true);
      f.swap();
      f.status({ id: "exec-original", running: false, exit_code: 0 });
      // Pure physical proof may close the controller fence, not the routed
      // writer/output holder. No raw stream reader or final output ACK ran.
      await settles(drain);
      expect(f.reads).toEqual([]);
      expect(f.acknowledgements).toEqual([]);
      expect(f.captured.size).toBe(0);
      expect(f.settled).toEqual([]);
      expect(f.session.hasRetainedProcess(1)).toBe(true);
      expect(f.route.hasRetainedProcess(1)).toBe(true);
      f.failCapture();
      await expect(
        f.route.writeStdinForProcessControl({ sessionId: 1, chars: "" }),
      ).rejects.toThrow("output could not be retained");
      expect(f.reads).toEqual([]);
      expect(f.route.hasRetainedProcess(1)).toBe(true);
      expect(f.session.hasRetainedProcess(1)).toBe(true);
      f.failSettlement();
      await expect(
        f.route.writeStdinForProcessControl({ sessionId: 1, chars: "" }),
      ).rejects.toThrow("durable settlement failed");
      expect(f.reads).toEqual([1]);
      expect(f.session.hasRetainedProcess(1)).toBe(false);
      expect(f.route.hasRetainedProcess(1)).toBe(true);
      expect(f.captured.size).toBe(2);
      expect([...f.captured.values()]).toEqual([
        { stream: "stdout", chunk: PREFIX },
        { stream: "stderr", chunk: STDERR },
      ]);
      for (const receipt of f.acknowledgements)
        expect(f.session.getSynchronousCommandOutput(receipt)?.collectionUnavailable).toBe(true);
      const queryCount = f.queries.length;
      f.offline(true);
      const terminal = await f.route.writeStdinForProcessControl({ sessionId: 1, chars: "" });
      expect(f.session.getSynchronousCommandOutput(terminal)).toMatchObject({
        exitCode: 0,
        collectionUnavailable: true,
      });
      expect(f.queries).toHaveLength(queryCount);
      expect(f.reads).toEqual([1]);
      expect(f.route.hasRetainedProcess(1)).toBe(false);
      expect(f.settled).toEqual([1]);
      expect(f.commands).toHaveLength(1);
      expect(f.interrupts).toEqual(["exec-original"]);
      expect(f.successorCalls()).toBe(0);
      expect(f.events).toEqual([]);
      expect(f.service.currentRevision()).toBe(0);
    } finally {
      await f.close();
    }
  });

  test("parallel unknown commands reconcile only their original operation and execution", async () => {
    const f = await fixture({ executionIds: ["exec-first", "exec-second"] });
    const second = createTurnToolCancellationController();
    try {
      await expect(
        f.controller.runSandboxCommandSynchronous(f.session, {
          cmd: "first mutation",
          yieldTimeMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown", sessionId: 1 });
      await expect(
        second.runSandboxCommandSynchronous(f.session, {
          cmd: "second mutation",
          yieldTimeMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown", sessionId: 2 });
      const firstDrain = f.controller.waitForQuiescence();
      const secondDrain = second.waitForQuiescence();
      expect(await pending(firstDrain)).toBe(true);
      expect(await pending(secondDrain)).toBe(true);
      f.statusFor("exec-first", { id: "exec-first", running: false, exit_code: 7 });
      f.statusFor("exec-second", { id: "exec-first", running: false, exit_code: 7 });
      await settles(firstDrain);
      await waitForQuery(() =>
        f.observations.some(
          (page) => page.requestedId === "exec-second" && page.returnedId === "exec-first",
        ),
      );
      expect(await pending(secondDrain)).toBe(true);
      expect(f.session.hasRetainedProcess(1)).toBe(true);
      expect(f.session.hasRetainedProcess(2)).toBe(true);
      expect(f.reads).toEqual([]);
      expect(f.acknowledgements).toEqual([]);
      f.statusFor("exec-second", { id: "exec-second", running: false, exit_code: 0 });
      await settles(secondDrain);
      for (const [sessionId, exitCode] of [
        [1, 7],
        [2, 0],
      ]) {
        const terminal = await f.session.writeStdin({ sessionId: sessionId!, chars: "" });
        expect(f.session.getSynchronousCommandOutput(terminal)).toMatchObject({
          exitCode,
          collectionUnavailable: true,
        });
      }
      expect(f.commands).toHaveLength(2);
      expect(f.interrupts).toEqual(["exec-first", "exec-second"]);
      expect(new Set(f.queries)).toEqual(new Set(["exec-first", "exec-second"]));
      expect(f.events).toEqual([]);
      expect(f.service.currentRevision()).toBe(0);
    } finally {
      await f.close();
    }
  });
});
