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
import {
  ModalCommandRouterWire,
  ModalCommandStartPreDispatchUnavailableError,
  ModalCommandStartRejectedError,
  modalRouterWire,
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
const large = Buffer.alloc(80 * 1024, 97);
const server = new Server();
let directory: string;
let endpoint: string;
let certificate: Buffer;
let startCalls = 0;
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
        const source = execId === "large" ? large : payload;
        call.write({ data: source.subarray(Number(offset)) });
        call.end();
      },
      poll(call: any, callback: any) {
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
});

test("an accepting TLS server cannot authorize replay by returning DNS-shaped text", async () => {
  const client = wire();
  const before = startCalls;
  try {
    const failure = await client
      .start({ ...identity("server-spoof"), commandArgs: ["true"], workdir: "/tmp", env: {} })
      .catch((error) => error);
    expect(startCalls - before).toBe(1);
    expect(failure).toMatchObject({
      code: status.UNAVAILABLE,
      details: "Name resolution failed for target dns:task-spoof.w.modal.host:443",
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
      expect((error as { code: number }).code).toBe(status.UNAVAILABLE);
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
    expect(first.bytes.length).toBe(64 * 1024);
    expect(first.eof).toBe(false);
    const second = await client.read(identity("large"), "stdout", first.bytes.length, 2000);
    expect(second.eof).toBe(true);
    expect(Buffer.concat([first.bytes, second.bytes])).toEqual(large);
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
    ).rejects.toMatchObject({ code: status.UNAVAILABLE });
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
