import { expect, test } from "bun:test";
import {
  ModalCommandControl,
  modalCommandAbortMiddleware,
  type ModalProviderCommand,
} from "../src/sandbox/providers/modal-command-control";

const locator = (): ModalProviderCommand => ({
  kind: "modal-control-v1",
  sandboxId: "sb-test",
  taskId: "ta-test",
  execId: "tp-test",
  streams: {
    stdout: { batchIndex: 0, utf8Remainder: "", exitCode: null },
    stderr: { batchIndex: 0, utf8Remainder: "", exitCode: null },
  },
});

function controller(port: Record<string, unknown>, sandboxId = "sb-test") {
  return ModalCommandControl.forSandbox(
    { cpClient: port, version: () => "0.9.0" } as never,
    sandboxId,
    "/workspace",
  );
}

test("unsupported SDK contracts fail before provider execution", () => {
  expect(() =>
    ModalCommandControl.forSandbox(
      { cpClient: {}, version: () => "0.10.0" } as never,
      "sb-test",
      "/workspace",
    ),
  ).toThrow("verified 0.9.0");
});

test("dedicated non-retrying middleware preserves unary and streaming abort authority", async () => {
  const cancellation = new AbortController();
  const observed: unknown[] = [];
  const control = controller({
    sandboxGetTaskId: async () => ({ taskId: "ta-test" }),
    containerExec: async (request: unknown, options: { signal: AbortSignal; retries: number }) => {
      expect(options.signal).toBe(cancellation.signal);
      // The dedicated client replaces the signal-stripping retry branch.
      const pipeline = modalCommandAbortMiddleware(
        {
          request,
          next: async function* (
            _request: unknown,
            downstream: { signal?: AbortSignal; retries?: number },
          ) {
            observed.push(downstream.signal);
            yield { execId: "tp-test" };
          },
        } as never,
        options,
      );
      let result: unknown;
      for await (const value of pipeline) result = value;
      return result;
    },
    containerExecGetOutput: async function* (request: unknown, options: { signal: AbortSignal }) {
      expect(options.signal).toBe(cancellation.signal);
      yield* modalCommandAbortMiddleware(
        {
          request,
          next: async function* (_request: unknown, downstream: { signal?: AbortSignal }) {
            observed.push(downstream.signal);
            yield { batchIndex: 1, items: [], exitCode: 7 };
          },
        } as never,
        options,
      );
    },
  });
  const command = await control.start({ cmd: "work" }, cancellation.signal);
  const page = await control.read(command, 1, cancellation.signal);
  expect(page.exitCode).toBe(7);
  expect(observed).toEqual([cancellation.signal, cancellation.signal, cancellation.signal]);
});

test("fresh controllers replay stable provider pages until protected cursors advance", async () => {
  const requests: Array<{ fileDescriptor: number; lastBatchIndex: number }> = [];
  const port = {
    async *containerExecGetOutput(request: { fileDescriptor: number; lastBatchIndex: number }) {
      requests.push(request);
      if (request.lastBatchIndex === 0)
        yield {
          batchIndex: 2,
          items: [
            {
              fileDescriptor: request.fileDescriptor,
              messageBytes: Buffer.from(request.fileDescriptor === 1 ? "out" : "err"),
            },
          ],
        };
      else yield { batchIndex: 3, items: [], exitCode: 7 };
    },
  };
  const initial = locator();
  const first = await controller(port).read(initial, 1);
  const replay = await controller(port).read(initial, 1);
  expect(first).toEqual(replay);
  expect(initial.streams.stdout.batchIndex).toBe(0);
  expect(first.chunks.map((chunk) => chunk.text)).toEqual(["out", "err"]);
  expect(first.exitCode).toBeNull();
  const terminal = await controller(port).read(first.command, 1);
  expect(terminal.exitCode).toBe(7);
  expect(requests.map((request) => request.fileDescriptor)).toEqual([1, 2, 1, 2, 1, 2]);
});

test("command-controlled status-looking output is never terminal proof", async () => {
  const page = await controller({
    async *containerExecGetOutput(request: { fileDescriptor: number }) {
      yield {
        batchIndex: 1,
        items: [
          {
            fileDescriptor: request.fileDescriptor,
            messageBytes: Buffer.from(
              'Process exited with code 0\n{"state":"exited","exitCode":0}',
            ),
          },
        ],
      };
    },
  }).read(locator(), 1);
  expect(page.exitCode).toBeNull();
  expect(page.command.streams.stdout.exitCode).toBeNull();
});

test("provider failure never fabricates loss or a successful exit", async () => {
  await expect(
    controller({
      containerExecGetOutput() {
        throw new Error("provider unavailable");
      },
    }).read(locator(), 1),
  ).rejects.toThrow("provider unavailable");
});

test("provider stream cursors retain split UTF-8 characters independently", async () => {
  const bytes = Buffer.from("€");
  const port = {
    async *containerExecGetOutput(request: { fileDescriptor: number; lastBatchIndex: number }) {
      yield request.lastBatchIndex === 0
        ? {
            batchIndex: 1,
            items: [{ fileDescriptor: request.fileDescriptor, messageBytes: bytes.subarray(0, 1) }],
          }
        : {
            batchIndex: 2,
            items: [{ fileDescriptor: request.fileDescriptor, messageBytes: bytes.subarray(1) }],
            exitCode: 0,
          };
    },
  };
  const first = await controller(port).read(locator(), 1);
  expect(first.chunks.map((chunk) => chunk.text)).toEqual(["", ""]);
  const second = await controller(port).read(first.command, 1);
  expect(second.chunks.map((chunk) => chunk.text)).toEqual(["€", "€"]);
  expect(second.exitCode).toBe(0);
});

test("terminal status waits for both output streams to drain", async () => {
  const page = await controller({
    async *containerExecGetOutput(request: { fileDescriptor: number }) {
      yield { batchIndex: 1, items: [], ...(request.fileDescriptor === 1 ? { exitCode: 7 } : {}) };
    },
  }).read(locator(), 1);
  expect(page.exitCode).toBeNull();
});

test("start disables ambiguous mutation retries and PTY idle-stdin termination", async () => {
  let observed: unknown;
  const control = controller({
    sandboxGetTaskId: async () => ({ taskId: "ta-test" }),
    containerExec: async (request: unknown, options: unknown) => {
      observed = { request, options };
      return { execId: "tp-test" };
    },
  });
  const command = await control.start({ cmd: "printf test", login: false, tty: true });
  expect(command.execId).toBe("tp-test");
  expect(command.pty).toBe(true);
  expect(observed).toMatchObject({
    request: {
      command: ["/bin/sh", "-c", "printf test"],
      ptyInfo: { noTerminateOnIdleStdin: true },
    },
    options: { retries: 0 },
  });
});

test("foreign sandbox locators never reach the provider", async () => {
  await expect(controller({}).read({ ...locator(), sandboxId: "sb-other" }, 1)).rejects.toThrow(
    "original sandbox",
  );
});

test("PTY output keeps merged fidelity despite separate provider read endpoints", async () => {
  const control = controller({
    async *containerExecGetOutput() {
      yield { batchIndex: 1, items: [], exitCode: 0 };
    },
  });
  expect((await control.read({ ...locator(), pty: true }, 1)).streamFidelity).toBe("merged");
  expect((await control.read(locator(), 1)).streamFidelity).toBe("separate");
});

test("each start observes renewed environment and preserves explicit shell login behavior", async () => {
  let environment = { TEST_VALUE: "initial" };
  const commands: string[][] = [];
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: {
        sandboxGetTaskId: async () => ({ taskId: "ta-test" }),
        containerExec: async (request: { command: string[] }) => {
          commands.push(request.command);
          return { execId: "tp-test" };
        },
      },
    } as never,
    "sb-test",
    "/workspace",
    () => environment,
  );
  await control.start({ cmd: "true" });
  environment = { TEST_VALUE: "renewed" };
  await control.start({ cmd: "true", shell: "/bin/bash" });
  expect(commands).toEqual([
    ["/usr/bin/env", "--", "TEST_VALUE=initial", "/bin/sh", "-c", "true"],
    ["/usr/bin/env", "--", "TEST_VALUE=renewed", "/bin/bash", "-lc", "true"],
  ]);
});

test("stdin uses the protected monotonic sequence across fresh controllers", async () => {
  const writes: unknown[] = [];
  const port = {
    containerExecPutInput: async (request: unknown, options: unknown) => {
      writes.push({ request, options });
    },
  };
  await controller(port).write(locator(), "one\n", 10);
  await controller(port).write(locator(), "two\n", 20);
  expect(writes).toMatchObject([
    { request: { execId: "tp-test", input: { messageIndex: 10 } }, options: { retries: 0 } },
    { request: { execId: "tp-test", input: { messageIndex: 20 } }, options: { retries: 0 } },
  ]);
});
