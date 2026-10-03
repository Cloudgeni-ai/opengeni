import { afterEach, expect, test } from "bun:test";
import { Server, ServerCredentials, status, type ServiceDefinition } from "@grpc/grpc-js";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import {
  MODAL_ROUTER_READ_PAGE_BYTES,
  ModalCommandRouterWire,
  modalRouterWire,
} from "../src/sandbox/providers/modal-command-router-wire";
import { reduceModalRawOutputPage } from "../src/sandbox/providers/modal-command-raw-page";

const definition = (method: string, input: string, output: string, streaming = false) => ({
  path: `/modal.task_command_router.TaskCommandRouter/${method}`,
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

function cursor(): ModalRouterProviderCommand {
  return {
    kind: "modal-router-v1",
    sandboxId: "sb-original",
    taskId: "task-original",
    execId: "11111111-1111-4111-8111-111111111111",
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
}

async function until(predicate: () => boolean, description: string) {
  const deadline = performance.now() + 2_000;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(5);
  if (!predicate()) throw new Error(`TLS fixture did not observe ${description}`);
}

async function fixture(mode: "normal" | "split" | "bounded" | "cancel" | "failure" = "normal") {
  const directory = mkdtempSync(join(tmpdir(), "modal-raw-page-tls-"));
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
  const server = new Server();
  const requests: Array<{
    method: string;
    taskId: string;
    execId: string;
    offset?: number;
    stream?: number;
  }> = [];
  let active = 0,
    peak = 0,
    cancellations = 0,
    starts = 0,
    writes = 0;
  let terminal = mode !== "split";
  const entered = (call: any, method: string) => {
    expect(call.metadata.get("authorization")).toEqual(["Bearer raw-page-test-token"]);
    expect(call.request.taskId).toBe("task-original");
    expect(call.request.execId).toBe(cursor().execId);
    requests.push({
      method,
      taskId: call.request.taskId,
      execId: call.request.execId,
      ...(method === "read"
        ? { offset: Number(call.request.offset), stream: call.request.fileDescriptor }
        : {}),
    });
    active++;
    peak = Math.max(peak, active);
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        active--;
      }
    };
    call.once("cancelled", () => {
      cancellations++;
      finish();
    });
    return finish;
  };
  const stdout = Buffer.from([0x41, 0xe2, 0x82, 0xac, 0xff]);
  const stderr = Buffer.from("diagnostic\n");
  server.addService(
    {
      read: definition("TaskExecStdioRead", "Read", "Data", true),
      poll: definition("TaskExecPoll", "Identity", "Poll"),
      start: definition("TaskExecStart", "Start", "Empty"),
      write: definition("TaskExecStdinWrite", "Write", "Empty"),
    } as ServiceDefinition,
    {
      read(call: any) {
        const finish = entered(call, "read");
        const offset = Number(call.request.offset),
          stream = call.request.fileDescriptor;
        if (mode === "cancel") return;
        if (mode === "failure") {
          if (stream === 0) {
            call.write({ data: Buffer.from([0xe2, 0x82]) });
            return;
          }
          void until(() => requests.length === 3, "all three native calls").then(() => {
            finish();
            call.emit("error", {
              code: status.PERMISSION_DENIED,
              details: "authenticated read rejected",
            });
          });
          return;
        }
        if (mode === "split" && stream === 0) {
          if (offset === 0) {
            call.write({ data: Buffer.from([0xe2, 0x82]) });
            return;
          }
          call.write({ data: Buffer.from([0xac]) });
        } else {
          const bytes =
            mode === "bounded" && stream === 0
              ? Buffer.alloc(MODAL_ROUTER_READ_PAGE_BYTES + 32_768, 0x41)
              : stream === 0
                ? stdout
                : stderr;
          call.write({ data: bytes.subarray(offset) });
        }
        finish();
        call.end();
      },
      poll(call: any, callback: any) {
        const finish = entered(call, "poll");
        if (mode === "cancel" || mode === "failure") return;
        finish();
        callback(null, terminal ? { code: 0 } : {});
      },
      start(_call: any, callback: any) {
        starts++;
        callback(null, {});
      },
      write(_call: any, callback: any) {
        writes++;
        callback(null, {});
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
    { url: `https://localhost:${port}`, jwt: "raw-page-test-token" },
    readFileSync(cert),
  );
  const control = ModalCommandControl.forSandbox(
    { version: () => "0.9.0", cpClient: {} } as never,
    "sb-original",
    "/workspace",
  );
  // Replace only access acquisition. Native read/poll encoding, TLS, deadlines,
  // cancellation and Promise.allSettled collection are the production path.
  Object.defineProperty(control, "withRouter", {
    value: async (
      taskId: string,
      signal: AbortSignal | undefined,
      run: (router: ModalCommandRouterWire) => Promise<unknown>,
    ) => {
      expect(taskId).toBe("task-original");
      signal?.throwIfAborted();
      return await run(wire);
    },
  });
  cleanups.push(async () => {
    await control.close();
    wire.close();
    server.forceShutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    control,
    requests,
    stdout,
    stderr,
    setTerminal: () => {
      terminal = true;
    },
    stats: () => ({ active, peak, cancellations, starts, writes }),
    drained: () => until(() => active === 0, "server-side RPC completion/cancellation"),
  };
}

test("real authenticated native read exposes bytes and exactly preserves decoded read projection", async () => {
  const f = await fixture();
  const expected = cursor();
  const raw = await f.control.readRaw(expected, 1_000);
  expect(raw.exit).toEqual({ source: "router_poll", code: 0 });
  expect(Buffer.from(raw.streams.stdout.bytes)).toEqual(f.stdout);
  expect(Buffer.from(raw.streams.stderr.bytes)).toEqual(f.stderr);
  const reduced = reduceModalRawOutputPage(raw, expected);
  expect(reduced.chunks.map((chunk) => chunk.text)).toEqual(["A€�", "diagnostic\n"]);
  expect(await f.control.read(expected, 1_000)).toEqual(reduced);
  const calls = f.requests.length;
  const retained = await f.control.readRaw(raw.command, 1_000);
  expect(retained.exit).toEqual({ source: "retained_terminal", code: 0 });
  expect(reduceModalRawOutputPage(retained, raw.command).chunks).toEqual([]);
  expect(f.requests.length).toBe(calls);
  expect(expected).toEqual(cursor());
  await f.drained();
  expect(f.stats().starts).toBe(0);
  expect(f.stats().writes).toBe(0);
});

test("native quiet partial page retains split UTF-8 and the same independent read offsets", async () => {
  const f = await fixture("split");
  const expected = cursor();
  const first = await f.control.readRaw(expected, 75);
  expect(first.streams.stdout.eof).toBe(false);
  expect(first.command.streams.stdout.byteOffset).toBe(2);
  expect(first.command.streams.stdout.utf8Remainder).toBe("4oI=");
  expect(first.command.streams.stderr.eof).toBe(true);
  expect(reduceModalRawOutputPage(first, expected).exitCode).toBeNull();
  f.setTerminal();
  const second = await f.control.readRaw(first.command, 1_000);
  expect(reduceModalRawOutputPage(second, first.command).chunks.map((chunk) => chunk.text)).toEqual(
    ["€"],
  );
  expect(second.command.streams.stdout.byteOffset).toBe(3);
  expect(
    f.requests
      .filter((request) => request.method === "read")
      .map(({ stream, offset }) => [stream, offset]),
  ).toEqual([
    [0, 0],
    [1, 0],
    [0, 2],
  ]);
  await f.drained();
  expect(f.stats().starts).toBe(0);
  expect(f.stats().writes).toBe(0);
});

test("native wire page bound is not EOF or consumed backlog", async () => {
  const f = await fixture("bounded");
  const expected = cursor();
  const raw = await f.control.readRaw(expected, 1_000);
  expect(raw.streams.stdout.bytes.byteLength).toBe(MODAL_ROUTER_READ_PAGE_BYTES);
  expect(raw.streams.stdout.eof).toBe(false);
  const reduced = reduceModalRawOutputPage(raw, expected);
  expect(reduced.command.streams.stdout.byteOffset).toBe(MODAL_ROUTER_READ_PAGE_BYTES);
  expect(reduced.exitCode).toBeNull();
  expect(reduced.providerExited).toBe(true);
  await f.drained();
  expect(f.stats().starts).toBe(0);
});

test("owner cancellation joins both native stream calls and poll without another attempt", async () => {
  const f = await fixture("cancel");
  const expected = cursor();
  const cancellation = new AbortController();
  const reason = new Error("exact raw-page owner cancelled");
  const pending = f.control.readRaw(expected, 1_000, cancellation.signal).catch((error) => error);
  await until(() => f.requests.length === 3, "three outstanding authenticated calls");
  expect(f.stats().active).toBe(3);
  cancellation.abort(reason);
  expect(await pending).toBe(reason);
  await f.drained();
  expect(f.stats().cancellations).toBe(3);
  expect(f.stats().peak).toBe(3);
  expect(f.requests.length).toBe(3);
  expect(f.stats().starts).toBe(0);
  expect(f.stats().writes).toBe(0);
  expect(expected).toEqual(cursor());
});

test("a failed sibling joins partial-byte read and poll without returning a fabricated page", async () => {
  const f = await fixture("failure");
  const expected = cursor();
  const failure = await f.control.readRaw(expected, 1_000).catch((error) => error);
  expect(failure.code).toBe(status.PERMISSION_DENIED);
  await f.drained();
  expect(f.stats().active).toBe(0);
  expect(f.stats().peak).toBe(3);
  expect(f.requests.length).toBe(3);
  expect(f.stats().starts).toBe(0);
  expect(f.stats().writes).toBe(0);
  expect(expected).toEqual(cursor());
});

test("native raw reads reject legacy locators and pre-cancellation before any RPC", async () => {
  const f = await fixture();
  await expect(
    f.control.readRaw({ ...cursor(), kind: "modal-control-v1" } as never, 1),
  ).rejects.toThrow();
  const cancellation = new AbortController();
  const reason = new Error("cancelled before raw read");
  cancellation.abort(reason);
  expect(await f.control.readRaw(cursor(), 1, cancellation.signal).catch((error) => error)).toBe(
    reason,
  );
  expect(f.requests).toEqual([]);
  expect(f.stats().starts).toBe(0);
  expect(f.stats().writes).toBe(0);
});
