import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  Client,
  Server,
  ServerCredentials,
  credentials,
  status,
  type ServiceDefinition,
} from "@grpc/grpc-js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Sandbox } from "modal";
import { ModalCommandStartOutcomeUnknownError } from "../src/sandbox/providers/modal-command-start-errors";
import {
  isModalCommandStartOutcomeUnknownError,
  isModalTaskExecStartPreDispatchUnavailableError,
} from "../src/sandbox/providers/modal";
import {
  MODAL_ROUTER_READ_PAGE_BYTES,
  ModalCommandRouterWire,
  ModalCommandStartNotDispatchedError,
  ModalCommandStartPreDispatchUnavailableError,
  ModalCommandStartRejectedError,
  modalRouterWire,
  type ModalRouterPreparedStart,
  type ModalRouterStart,
} from "../src/sandbox/providers/modal-command-router-wire";

const service = "modal.task_command_router.TaskCommandRouter";
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
const payload = Buffer.from(Array.from({ length: 8 }, (_, i) => `line:${i}\n`).join(""));
const large = Buffer.alloc(MODAL_ROUTER_READ_PAGE_BYTES + 16 * 1024, 97);
// A finished command's multi-megabyte backlog, delivered in small provider
// messages as the router does.
const backlog = Buffer.alloc(8 * 1024 * 1024, 98);
const server = new Server();
let directory: string;
let endpoint: string;
let certificate: Buffer;
let startCalls = 0;
let writeCalls = 0;
let pollCalls = 0;
const starts: object[] = [];
let cancelledStartReceived: (() => void) | undefined;
let cancelledReads = 0;
const requests: Array<{ execId: string; offset: number; fileDescriptor: number }> = [];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "opengeni-modal-router-"));
  const keyPath = join(directory, "server.key"),
    certPath = join(directory, "server.pem");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  if (result.status !== 0) throw new Error("Test TLS certificate generation failed");
  certificate = readFileSync(certPath);
  server.addService(
    {
      start: definition("TaskExecStart", "Start", "Empty"),
      read: definition("TaskExecStdioRead", "Read", "Data", true),
      poll: definition("TaskExecPoll", "Identity", "Poll"),
      write: definition("TaskExecStdinWrite", "Write", "Empty"),
    } as ServiceDefinition,
    {
      start(call: any, callback: any) {
        startCalls++;
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        starts.push(modalRouterWire.lookupType("Start").toObject(call.request));
        if (call.request.execId === "prepared-cancel") {
          cancelledStartReceived?.();
          return;
        }
        if (call.request.execId === "prepared") {
          callback(null, {});
          return;
        }
        if (call.request.execId === "server-spoof") {
          callback({
            code: status.UNAVAILABLE,
            details: "Name resolution failed for target dns:task-spoof.w.modal.host:443",
          });
          return;
        }
        callback({
          code: call.request.execId === "rejected" ? status.NOT_FOUND : status.UNAVAILABLE,
          details:
            call.request.execId === "rejected" ? "executable unavailable" : "ambiguous start",
        });
      },
      read(call: any) {
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        const { execId, offset, fileDescriptor } = call.request;
        requests.push({ execId, offset: Number(offset), fileDescriptor });
        call.on("cancelled", () => cancelledReads++);
        if (execId === "silent") return;
        if (execId === "failed") {
          call.destroy({ code: status.UNAVAILABLE, details: "read unavailable" });
          return;
        }
        if (execId === "backlog") {
          for (let start = Number(offset); start < backlog.length; start += 64 * 1024)
            call.write({ data: backlog.subarray(start, start + 64 * 1024) });
          call.end();
          return;
        }
        const source = execId === "large" ? large : payload;
        call.write({ data: source.subarray(Number(offset)) });
        call.end();
      },
      poll(call: any, callback: any) {
        pollCalls++;
        callback(
          null,
          call.request.execId === "running"
            ? {}
            : call.request.execId === "signal"
              ? { signal: 9 }
              : { code: 0 },
        );
      },
      write(call: any, callback: any) {
        writeCalls++;
        expect(Number(call.request.offset)).toBe(17);
        expect(Buffer.from(call.request.data).toString()).toBe("input");
        callback(null, {});
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createSsl(null, [
        { private_key: readFileSync(keyPath), cert_chain: certificate },
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

function wire() {
  return new ModalCommandRouterWire({ url: endpoint, jwt: "test-token" }, certificate);
}
const identity = (execId = "normal") => ({ taskId: "task-test", execId });

const readinessRequest = (): ModalRouterStart => ({
  ...identity("prepared"),
  commandArgs: ["/bin/true"],
  workdir: "/tmp",
  env: {},
});

function expectDescriptionRefusal(client: ModalCommandRouterWire, candidate: unknown): void {
  let error: unknown;
  try {
    client.describePreparedStart(candidate as ModalRouterPreparedStart);
  } catch (failure) {
    error = failure;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty("name", "Error");
  expect(error).toHaveProperty(
    "message",
    "Invalid, unsupported or unavailable Modal prepared Start descriptor",
  );
  expect(error).not.toBeInstanceOf(ModalCommandStartNotDispatchedError);
  expect(error).not.toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
  expect(error).not.toBeInstanceOf(ModalCommandStartRejectedError);
  expect(isModalTaskExecStartPreDispatchUnavailableError(error)).toBe(false);
  expect(isModalCommandStartOutcomeUnknownError(error)).toBe(false);
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("taskId");
  expect(error).not.toHaveProperty("execId");
  expect(Object.getOwnPropertySymbols(error)).toEqual([]);
}

test("fixed readiness description retains the actual preflight fixture without getter work or consumption", async () => {
  const client = wire();
  const request = readinessRequest();
  const codec = modalRouterWire.lookupType("Start").setup();
  const encodeStart = codec.encode;
  const fixture = Buffer.from(
    "0a097461736b2d74657374120870726570617265641a092f62696e2f74727565200128013a042f746d70",
    "hex",
  );
  let encoded: Buffer | undefined;
  let encodes = 0;
  const before = {
    starts: startCalls,
    writes: writeCalls,
    polls: pollCalls,
    reads: requests.length,
  };
  let callbacks = 0;
  codec.encode = function (value, writer) {
    encodes++;
    const result = encodeStart.call(this, value, writer);
    encoded = Buffer.from(result.finish());
    return result;
  };
  try {
    const pending = client.prepareStart(request);
    expect(encodes).toBe(1);
    expect(encoded).toEqual(fixture);
    // Caller changes before readiness completes cannot change the descriptor.
    request.taskId = "other-task";
    request.execId = "other-exec";
    request.commandArgs.push("not-readiness");
    request.env.SECRET = "not-retained";
    request.workdir = "/workspace";
    const prepared = await pending;
    const descriptor = client.describePreparedStart(prepared);
    expect(descriptor).not.toBeInstanceOf(Promise);
    expect(descriptor).toEqual({
      ...identity("prepared"),
      descriptorProtocol: "modal-prepared-start-descriptor",
      descriptorVersion: 1,
      readinessRecipe: "modal-exec-readiness-bin-true-v1",
      readinessRecipeVersion: 1,
      startMessage: "Start",
      rpcMethod: `/${service}/TaskExecStart`,
      encoderVersion: "protobufjs@7.6.5",
      preflight: {
        encoding: "modal-start-protobuf-preflight-v1",
        sha256: "db127d48dc760c65e2e27acffc9c699e4a945ac894a997d52b31b1ace2d28519",
        byteLength: 42,
        encoderFingerprint:
          "sha256:0af6a034d3159fd68e4ec650ef56db06babf81f08d8beb17c3b8c1861767f50e",
      },
    });
    expect(descriptor.preflight.sha256).toBe(createHash("sha256").update(fixture).digest("hex"));
    expect(descriptor.preflight.byteLength).toBe(encoded!.length);
    expect(descriptor.encoderVersion).toBe(
      `protobufjs@${createRequire(import.meta.url)("protobufjs/package.json").version}`,
    );
    expect(descriptor.preflight.encoderFingerprint).toBe(
      `sha256:${createHash("sha256")
        .update(
          JSON.stringify({
            encoderVersion: "protobufjs@7.6.5",
            schema: modalRouterWire.toJSON(),
            encoding: "Start.encode(Start.fromObject(value)).finish()",
          }),
        )
        .digest("hex")}`,
    );
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.preflight)).toBe(true);
    expect(Reflect.set(descriptor, "execId", "substituted")).toBe(false);
    expect(Reflect.set(descriptor.preflight, "sha256", "substituted")).toBe(false);
    // Description must not perform another encode or any transport operation.
    codec.encode = () => {
      throw new Error("No encoding during description");
    };
    Object.defineProperty((client as any).client, "waitForReady", {
      value: () => {
        throw new Error("No readiness during description/dispatch");
      },
    });
    for (let index = 0; index < 3; index++)
      expect(client.describePreparedStart(prepared)).toBe(descriptor);
    expect(encodes).toBe(1);
    expect({
      starts: startCalls,
      writes: writeCalls,
      polls: pollCalls,
      reads: requests.length,
    }).toEqual(before);
    expect(callbacks).toBe(0);
    codec.encode = encodeStart;
    // The real TLS Start still dispatches once, consuming synchronously.
    callbacks++;
    const dispatched = client.dispatchPreparedStart(prepared);
    expectDescriptionRefusal(client, prepared);
    await dispatched;
    expectDescriptionRefusal(client, prepared);
    expect(callbacks).toBe(1);
    expect(startCalls - before.starts).toBe(1);
    expect(starts.at(-1)).toEqual({
      ...identity("prepared"),
      commandArgs: ["/bin/true"],
      workdir: "/tmp",
      stdoutConfig: 1,
      stderrConfig: 1,
    });
    expect(writeCalls).toBe(before.writes);
    expect(pollCalls).toBe(before.polls);
    expect(requests.length).toBe(before.reads);
  } finally {
    codec.encode = encodeStart;
    client.close();
  }
});

test("description rejects forged/copied/foreign/closed handles without proof or consumption", async () => {
  const issuer = wire(),
    foreign = wire();
  const before = startCalls;
  try {
    const prepared = await issuer.prepareStart(readinessRequest());
    const descriptor = issuer.describePreparedStart(prepared);
    for (const candidate of [
      {},
      undefined,
      null,
      "prepared",
      { ...prepared },
      Object.create(prepared),
      JSON.parse(JSON.stringify(prepared)),
      structuredClone(prepared),
      descriptor,
      { ...descriptor },
      new Proxy(prepared, {}),
      { command: prepared, admission: "not-authority" },
    ])
      expectDescriptionRefusal(issuer, candidate);
    expectDescriptionRefusal(foreign, prepared);
    foreign.close();
    expectDescriptionRefusal(foreign, prepared);
    expect(issuer.describePreparedStart(prepared)).toBe(descriptor);
    expect(startCalls).toBe(before);
    issuer.close();
    expectDescriptionRefusal(issuer, prepared);
    // Getter refusal does not pre-spend the closed handle: dispatch alone
    // retains its genuine local closure proof, then seals the handle.
    await expect(issuer.dispatchPreparedStart(prepared)).rejects.toBeInstanceOf(
      ModalCommandStartNotDispatchedError,
    );
    expectDescriptionRefusal(issuer, prepared);
    expect(startCalls).toBe(before);
  } finally {
    issuer.close();
    foreign.close();
  }
});

test("only the exact readiness input is describable; unsupported generic Starts still dispatch", async () => {
  const client = wire();
  const before = startCalls;
  const ptyInfo = {
    enabled: false,
    winszRows: 0,
    winszCols: 0,
    envTerm: "",
    ptyType: 0,
    noTerminateOnIdleStdin: false,
  };
  const variants = [
    { ...readinessRequest(), commandArgs: ["true"] },
    { ...readinessRequest(), commandArgs: ["/bin/true", "extra"] },
    { ...readinessRequest(), workdir: "/workspace" },
    { ...readinessRequest(), env: { EXTRA: "value" } },
    { ...readinessRequest(), env: { [Symbol("extra")]: "value" } },
    { ...readinessRequest(), ptyInfo },
    { ...readinessRequest(), ptyInfo: undefined },
    { ...readinessRequest(), timeoutSecs: 1 },
    { ...readinessRequest(), stdoutConfig: 2 },
    { ...readinessRequest(), stderrConfig: 2 },
    { ...readinessRequest(), runtimeDebug: true },
    { ...readinessRequest(), secretIds: ["not-used"] },
    { ...readinessRequest(), containerId: "not-used" },
    { ...readinessRequest(), extra: undefined },
    { ...readinessRequest(), [Symbol("extra")]: true },
    new Proxy(readinessRequest(), {
      ownKeys() {
        throw new Error("Unreadable shape");
      },
    }),
  ];
  try {
    for (const request of variants) {
      const prepared = await client.prepareStart(request);
      expectDescriptionRefusal(client, prepared);
      await client.dispatchPreparedStart(prepared);
      await expect(client.dispatchPreparedStart(prepared)).rejects.toThrow("Invalid or consumed");
    }
    expect(startCalls - before).toBe(variants.length);
    // The generic convenience Start is still available for these profiles.
    await client.start(variants[0]!);
    expect(startCalls - before).toBe(variants.length + 1);
  } finally {
    client.close();
  }
});

test("TLS preparation sends no mutation and freezes exact parameters before single-use dispatch", async () => {
  const client = wire();
  const request: ModalRouterStart = {
    ...identity("prepared"),
    commandArgs: ["/bin/true", "é雪", "literal $value"],
    workdir: "/workspace/original",
    env: { ORIGINAL: "exact-value" },
    ptyInfo: {
      enabled: true,
      winszRows: 24,
      winszCols: 80,
      envTerm: "xterm",
      ptyType: 1,
      noTerminateOnIdleStdin: true,
    },
  };
  const beforeStart = startCalls,
    beforeWrite = writeCalls;
  try {
    const pending = client.prepareStart(request);
    request.commandArgs[0] = "substituted";
    request.env.ORIGINAL = "substituted";
    request.ptyInfo!.winszRows = 99;
    const prepared = await pending;
    expect(prepared).toEqual(identity("prepared"));
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(startCalls).toBe(beforeStart);
    expect(writeCalls).toBe(beforeWrite);
    request.taskId = "other-task";
    request.execId = "other-exec";
    request.workdir = "/workspace/other";
    // If dispatch secretly rejoins readiness, this actual TLS RPC cannot pass.
    Object.defineProperty((client as any).client, "waitForReady", {
      value: () => {
        throw new Error("Readiness after the preparation boundary");
      },
    });
    const dispatched = client.dispatchPreparedStart(prepared);
    const duplicate = client.dispatchPreparedStart(prepared).catch((error) => error);
    await dispatched;
    expect(await duplicate).toHaveProperty(
      "message",
      "Invalid or consumed Modal prepared Start handle",
    );
    expect(startCalls - beforeStart).toBe(1);
    expect(writeCalls).toBe(beforeWrite);
    expect(starts.at(-1)).toEqual({
      ...identity("prepared"),
      commandArgs: ["/bin/true", "é雪", "literal $value"],
      workdir: "/workspace/original",
      env: { ORIGINAL: "exact-value" },
      ptyInfo: {
        enabled: true,
        winszRows: 24,
        winszCols: 80,
        envTerm: "xterm",
        ptyType: 1,
        noTerminateOnIdleStdin: true,
      },
      stdoutConfig: 1,
      stderrConfig: 1,
    });
  } finally {
    client.close();
  }
});

test("only the issuing factory's original handle can dispatch on its transport", async () => {
  const issuer = wire(),
    foreign = wire();
  const before = startCalls;
  try {
    const prepared = await issuer.prepareStart({
      ...identity("prepared"),
      commandArgs: ["/bin/true"],
      workdir: "/tmp",
      env: {},
    });
    for (const candidate of [
      { ...prepared },
      JSON.parse(JSON.stringify(prepared)),
      { command: prepared, admission: "not-authority" },
    ]) {
      const error = await issuer
        .dispatchPreparedStart(candidate as ModalRouterPreparedStart)
        .catch((failure) => failure);
      expect(error).not.toBeInstanceOf(ModalCommandStartNotDispatchedError);
      expect(error).not.toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
      expect(error).toHaveProperty("message", "Invalid or consumed Modal prepared Start handle");
    }
    await expect(foreign.dispatchPreparedStart(prepared)).rejects.toThrow("Invalid or consumed");
    expect(startCalls).toBe(before);
    await issuer.dispatchPreparedStart(prepared);
    expect(startCalls - before).toBe(1);
  } finally {
    issuer.close();
    foreign.close();
  }
});

test("lost Start acknowledgement spends the original prepared handle permanently", async () => {
  const client = wire();
  const before = startCalls;
  try {
    const prepared = await client.prepareStart({
      ...identity("prepared-unknown"),
      commandArgs: ["/bin/true"],
      workdir: "/tmp",
      env: {},
    });
    const descriptor = client.describePreparedStart(prepared);
    const outcome = await client.dispatchPreparedStart(prepared).catch((error) => error);
    expect(outcome).toMatchObject({
      name: "CommandStartOutcomeUnknownError",
      ...identity("prepared-unknown"),
      cause: { code: status.UNAVAILABLE },
    });
    expect(descriptor).toMatchObject(identity("prepared-unknown"));
    expectDescriptionRefusal(client, prepared);
    expectDescriptionRefusal(client, descriptor);
    const duplicate = await client.dispatchPreparedStart(prepared).catch((error) => error);
    expect(duplicate).not.toBeInstanceOf(ModalCommandStartNotDispatchedError);
    expect(duplicate).not.toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
    expect(duplicate).toHaveProperty("message", "Invalid or consumed Modal prepared Start handle");
    expect(startCalls - before).toBe(1);
  } finally {
    client.close();
  }
});

test("post-dispatch cancellation is ambiguous and never permits a second Start", async () => {
  const client = wire(),
    cancellation = new AbortController();
  const reason = new Error("caller cancelled after Start");
  const received = new Promise<void>((resolve) => {
    cancelledStartReceived = resolve;
  });
  const before = startCalls;
  try {
    const prepared = await client.prepareStart({
      ...identity("prepared-cancel"),
      commandArgs: ["/bin/true"],
      workdir: "/tmp",
      env: {},
    });
    const pending = client
      .dispatchPreparedStart(prepared, cancellation.signal)
      .catch((error) => error);
    await received;
    expectDescriptionRefusal(client, prepared);
    cancellation.abort(reason);
    expect(await pending).toMatchObject({
      name: "CommandStartOutcomeUnknownError",
      ...identity("prepared-cancel"),
      cause: reason,
    });
    await expect(client.dispatchPreparedStart(prepared)).rejects.toThrow("Invalid or consumed");
    expect(startCalls - before).toBe(1);
  } finally {
    cancelledStartReceived = undefined;
    client.close();
  }
});

test("RPC-time serialization remains ambiguous and leaves the prepared handle spent", async () => {
  const client = wire();
  const codec = modalRouterWire.lookupType("Start");
  const encodeStart = codec.encode;
  const before = startCalls;
  try {
    const prepared = await client.prepareStart({
      ...identity("serialization-failure"),
      commandArgs: ["/bin/true"],
      workdir: "/tmp",
      env: {},
    });
    codec.encode = () => {
      throw new Error("RPC serializer failed after preparation");
    };
    expect(client.describePreparedStart(prepared)).toMatchObject(identity("serialization-failure"));
    const error = await client.dispatchPreparedStart(prepared).catch((failure) => failure);
    expect(error).toBeInstanceOf(ModalCommandStartOutcomeUnknownError);
    expect(error).not.toBeInstanceOf(ModalCommandStartNotDispatchedError);
    expect(error).not.toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
    expect(error).toMatchObject(identity("serialization-failure"));
    expect(startCalls).toBe(before);
    expectDescriptionRefusal(client, prepared);
    codec.encode = encodeStart;
    await expect(client.dispatchPreparedStart(prepared)).rejects.toThrow("Invalid or consumed");
    expect(startCalls).toBe(before);
  } finally {
    codec.encode = encodeStart;
    client.close();
  }
});

test("abort or close after preparation sends zero Start but still spends the handle", async () => {
  const before = startCalls;
  for (const close of [false, true]) {
    const client = wire(),
      cancellation = new AbortController();
    try {
      const prepared = await client.prepareStart({
        ...identity("prepared"),
        commandArgs: ["/bin/true"],
        workdir: "/tmp",
        env: {},
      });
      if (close) client.close();
      else cancellation.abort(new Error("caller stopped before dispatch"));
      if (close) expectDescriptionRefusal(client, prepared);
      else expect(client.describePreparedStart(prepared)).toMatchObject(identity("prepared"));
      await expect(
        client.dispatchPreparedStart(prepared, cancellation.signal),
      ).rejects.toBeInstanceOf(ModalCommandStartNotDispatchedError);
      expectDescriptionRefusal(client, prepared);
      await expect(client.dispatchPreparedStart(prepared)).rejects.toThrow("Invalid or consumed");
      expect(startCalls).toBe(before);
    } finally {
      client.close();
    }
  }
});

test("preparation validation fails before readiness or any mutation", async () => {
  const client = wire(),
    before = startCalls,
    beforeWrite = writeCalls;
  let readinessCalls = 0;
  Object.defineProperty((client as any).client, "waitForReady", {
    value: () => {
      readinessCalls++;
      throw new Error("Must validate before readiness");
    },
  });
  try {
    for (const invalid of [
      { ...identity(), commandArgs: [14], workdir: "/tmp", env: {} },
      { ...identity(), commandArgs: [], workdir: "/tmp", env: {} },
      { ...identity(), commandArgs: ["/bin/true"], workdir: "/tmp", env: { BAD: 14 } },
      { ...identity(), commandArgs: ["x".repeat(4 * 1024 * 1024)], workdir: "/tmp", env: {} },
    ]) {
      await expect(client.prepareStart(invalid as ModalRouterStart)).rejects.toBeInstanceOf(
        ModalCommandStartNotDispatchedError,
      );
    }
    expect(readinessCalls).toBe(0);
    expect(startCalls).toBe(before);
    expect(writeCalls).toBe(beforeWrite);
  } finally {
    client.close();
  }
});

test("preparation outage or in-flight cancellation never enters the dispatch callback", async () => {
  const client = new ModalCommandRouterWire({
    url: "https://task-notarealtask2707.w.modal.host",
    jwt: "test-token",
  });
  const request = { ...identity(), commandArgs: ["/bin/true"], workdir: "/tmp", env: {} };
  const before = startCalls,
    beforeWrite = writeCalls;
  let dispatchCallbacks = 0;
  const prepareThenDispatch = async (signal?: AbortSignal) => {
    const prepared = await client.prepareStart(request, signal);
    dispatchCallbacks++;
    await client.dispatchPreparedStart(prepared, signal);
  };
  try {
    const cancellation = new AbortController();
    const pending = prepareThenDispatch(cancellation.signal).catch((error) => error);
    cancellation.abort(new Error("cancel during channel readiness"));
    expect(await pending).toBeInstanceOf(ModalCommandStartNotDispatchedError);
    await expect(prepareThenDispatch()).rejects.toBeInstanceOf(
      ModalCommandStartPreDispatchUnavailableError,
    );
    expect(dispatchCallbacks).toBe(0);
    expect(startCalls).toBe(before);
    expect(writeCalls).toBe(beforeWrite);
    expect(request).toEqual({
      ...identity(),
      commandArgs: ["/bin/true"],
      workdir: "/tmp",
      env: {},
    });
  } finally {
    client.close();
  }
}, 15_000);

test("both pinned SDK distributions dispatch ambiguous Start once without transient replay", async () => {
  const sdkServer = new Server();
  let calls = 0;
  sdkServer.addService(
    { start: definition("TaskExecStart", "Start", "Empty") } as ServiceDefinition,
    {
      start(_call: unknown, callback: (error: unknown) => void) {
        calls++;
        callback({
          code: status.UNAVAILABLE,
          details:
            "Name resolution failed for target dns:task-72zioucmtnmt4av4osz7bk19t.w.modal.host:443",
        });
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    sdkServer.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, boundPort) =>
      error ? reject(error) : resolve(boundPort),
    ),
  );
  const cjs = createRequire(import.meta.url)("modal") as { Sandbox: typeof Sandbox };
  try {
    for (const SandboxClass of [Sandbox, cjs.Sandbox]) {
      const sdk = new SandboxClass(
        {
          profile: { serverUrl: "http://localhost" },
          logger: { debug: () => {}, warn: () => {} },
          cpClient: {
            taskGetCommandRouterAccess: async () => ({
              url: `https://127.0.0.1:${port}`,
              jwt: "test-token",
            }),
          },
        } as never,
        "sb-sdk-test",
        { taskId: "task-test" },
      );
      const before = calls;
      try {
        const error = await sdk.exec(["true"]).catch((failure) => failure);
        expect(error).toMatchObject({
          name: "CommandStartOutcomeUnknownError",
          taskId: "task-test",
          cause: {
            name: "ClientError",
            path: `/${service}/TaskExecStart`,
            code: status.UNAVAILABLE,
          },
        });
        expect(calls - before).toBe(1);
        expect(isModalCommandStartOutcomeUnknownError(error)).toBe(true);
      } finally {
        sdk.detach();
      }
    }
  } finally {
    sdkServer.forceShutdown();
  }
});

test("real no-port DNS target never dispatches Start; the client readiness gate proves it", async () => {
  const host = "task-notarealtask2707.w.modal.host";
  // grpc-js accepts a no-port authority and reports a resolver error without
  // :443; server-shaped error fields are therefore not useful dispatch proof.
  const raw = new Client(host, credentials.createInsecure());
  try {
    const native = await new Promise<unknown>((resolve) =>
      raw.makeUnaryRequest(
        `/${service}/TaskExecStart`,
        () => Buffer.alloc(0),
        (bytes) => bytes,
        {},
        { deadline: Date.now() + 1_000 },
        (error) => resolve(error),
      ),
    );
    expect((native as { details: string }).details).toContain(`dns:${host}`);
    expect((native as { details: string }).details).not.toContain(`${host}:443`);
  } finally {
    raw.close();
  }

  const client = new ModalCommandRouterWire({ url: `https://${host}`, jwt: "test-token" });
  try {
    expect((client as any).client.getChannel().getTarget()).toBe(`dns:${host}:443`);
    let dispatched = 0;
    Object.defineProperty(client, "unary", {
      value: async () => {
        dispatched++;
      },
    });
    await expect(
      client.start({ ...identity(), commandArgs: ["true"], workdir: "/tmp", env: {} }),
    ).rejects.toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
    expect(dispatched).toBe(0);
  } finally {
    client.close();
  }
}, 15_000);

test("an accepting TLS server cannot authorize replay by returning DNS-shaped text", async () => {
  const client = wire();
  const before = startCalls;
  try {
    const failure = await client
      .start({ ...identity("server-spoof"), commandArgs: ["true"], workdir: "/tmp", env: {} })
      .catch((error) => error);
    expect(startCalls - before).toBe(1);
    expect(failure).toMatchObject({
      name: "CommandStartOutcomeUnknownError",
      cause: {
        code: status.UNAVAILABLE,
        details: "Name resolution failed for target dns:task-spoof.w.modal.host:443",
      },
    });
    expect(failure).not.toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
  } finally {
    client.close();
  }
});

test("closing during pre-dispatch readiness never becomes a retryable transport failure", async () => {
  const client = wire();
  let ready: ((error?: Error) => void) | undefined;
  Object.defineProperty(client, "client", {
    value: {
      waitForReady: (_deadline: number, callback: (error?: Error) => void) => {
        ready = callback;
      },
      close: () => {},
    },
  });
  const result = client
    .start({ ...identity(), commandArgs: ["true"], workdir: "/tmp", env: {} })
    .catch((error) => error);
  client.close();
  ready!(new Error("channel closed"));
  const error = await result;
  expect(error).toHaveProperty("message", "Modal command router is closed");
  expect(error).not.toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
});

test("authenticated Start rejection is typed separately from transport uncertainty", async () => {
  const client = wire();
  try {
    await expect(
      client.start({ ...identity("rejected"), commandArgs: ["missing"], workdir: "/tmp", env: {} }),
    ).rejects.toBeInstanceOf(ModalCommandStartRejectedError);
    try {
      await client.start({ ...identity(), commandArgs: ["true"], workdir: "/tmp", env: {} });
      throw new Error("Expected ambiguous failure");
    } catch (error) {
      expect(error).not.toBeInstanceOf(ModalCommandStartRejectedError);
      expect(error).toBeInstanceOf(ModalCommandStartOutcomeUnknownError);
      expect((error as Error).cause).toMatchObject({ code: status.UNAVAILABLE });
    }
  } finally {
    client.close();
  }
});

test("TLS byte-offset reads replay exactly, including a new transport", async () => {
  const first = wire(),
    second = wire();
  try {
    expect(await first.read(identity(), "stdout", 0, 2000)).toEqual({ bytes: payload, eof: true });
    expect(await second.read(identity(), "stdout", 0, 2000)).toEqual({ bytes: payload, eof: true });
    expect(await second.read(identity(), "stderr", 14, 2000)).toEqual({
      bytes: payload.subarray(14),
      eof: true,
    });
    expect(requests.at(-1)?.fileDescriptor).toBe(1);
  } finally {
    first.close();
    second.close();
  }
});

test("bounded reads resume inside a provider chunk without loss or false EOF", async () => {
  const client = wire();
  try {
    const first = await client.read(identity("large"), "stdout", 0, 2000);
    expect(first.bytes.length).toBe(MODAL_ROUTER_READ_PAGE_BYTES);
    expect(first.eof).toBe(false);
    const second = await client.read(identity("large"), "stdout", first.bytes.length, 2000);
    expect(second.eof).toBe(true);
    expect(Buffer.concat([first.bytes, second.bytes])).toEqual(large);
  } finally {
    client.close();
  }
});

test("a finished command's multi-megabyte backlog drains in a few page-sized reads", async () => {
  const client = wire();
  try {
    const pages: Buffer[] = [];
    let offset = 0,
      eof = false,
      reads = 0;
    while (!eof) {
      const page = await client.read(identity("backlog"), "stdout", offset, 2000);
      expect(page.bytes.length).toBeLessThanOrEqual(MODAL_ROUTER_READ_PAGE_BYTES);
      pages.push(page.bytes);
      offset += page.bytes.length;
      eof = page.eof;
      reads++;
      expect(reads).toBeLessThanOrEqual(backlog.length / MODAL_ROUTER_READ_PAGE_BYTES + 1);
    }
    expect(Buffer.concat(pages)).toEqual(backlog);
  } finally {
    client.close();
  }
});

test("an empty deadline is not command completion", async () => {
  const client = wire();
  try {
    expect(await client.read(identity("silent"), "stdout", 0, 100)).toEqual({
      bytes: Buffer.alloc(0),
      eof: false,
    });
  } finally {
    client.close();
  }
});

test("external cancellation is propagated, never returned as a successful empty read", async () => {
  const client = wire(),
    cancellation = new AbortController();
  const error = new Error("caller stopped");
  const timer = setTimeout(() => cancellation.abort(error), 50);
  try {
    await expect(
      client.read(identity("silent"), "stdout", 0, 2000, cancellation.signal),
    ).rejects.toBe(error);
  } finally {
    clearTimeout(timer);
    client.close();
  }
  expect(cancelledReads).toBeGreaterThan(0);
});

test("poll distinguishes running, exit zero, and signal termination", async () => {
  const client = wire();
  try {
    expect(await client.poll(identity("running"))).toBeNull();
    expect(await client.poll(identity())).toBe(0);
    expect(await client.poll(identity("signal"))).toBe(137);
  } finally {
    client.close();
  }
});

test("an ambiguous start is sent exactly once", async () => {
  const client = wire(),
    before = startCalls;
  try {
    await expect(
      client.start({ ...identity(), commandArgs: ["true"], workdir: "/workspace", env: {} }),
    ).rejects.toMatchObject({
      name: "CommandStartOutcomeUnknownError",
      cause: { code: status.UNAVAILABLE },
    });
    expect(startCalls - before).toBe(1);
  } finally {
    client.close();
  }
});

test("stdin uses a byte offset and closed transports fail locally", async () => {
  const client = wire();
  await client.write(identity(), 17, Buffer.from("input"));
  client.close();
  await expect(client.poll(identity())).rejects.toThrow("closed");
});

test("plaintext endpoints and invalid read bounds are rejected", async () => {
  expect(
    () => new ModalCommandRouterWire({ url: "http://localhost:1", jwt: "test-token" }),
  ).toThrow("TLS");
  const client = wire();
  try {
    await expect(client.read(identity(), "stdout", -1, 100)).rejects.toThrow("bounds");
  } finally {
    client.close();
  }
});
