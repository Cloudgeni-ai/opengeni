import { expect, test } from "bun:test";
import { Server, ServerCredentials, status, type ServiceDefinition } from "@grpc/grpc-js";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { createRequire } from "node:module";
import * as modalSdk from "modal";
import {
  getModalCommandStartInvocation,
  installModalCommandStartContext,
  installModalCommandStartRetention,
  withModalCommandStartSignal,
} from "../src/sandbox/providers/modal-command-start-errors";
import { ProviderCommandStartOutcomeUnknownError } from "../src/sandbox/provider-command-session";
import { modalRouterWire } from "../src/sandbox/providers/modal-command-router-wire";

const require = createRequire(import.meta.url);
const distributions = [
  { name: "ESM", sdk: modalSdk, Session: ModalSandboxSession },
  {
    name: "CJS",
    sdk: require("modal") as typeof modalSdk,
    Session: require("@openai/agents-extensions/sandbox/modal")
      .ModalSandboxSession as typeof ModalSandboxSession,
  },
];
const dns = "Name resolution failed for target dns:task-spoof.w.modal.host:443";
type Failure =
  | "wait"
  | "stdout"
  | "stderr"
  | "both"
  | "cancel-wait"
  | "cancel-stdout"
  | "cancel-stderr"
  | "none";
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

async function fixture(
  failure: Failure,
  distribution: (typeof distributions)[number],
  timeoutMs?: number,
) {
  const server = new Server();
  const starts: Array<{ taskId: string; execId: string; pty: boolean }> = [];
  const waits: Array<{ taskId: string; execId: string }> = [];
  const reads: Array<{
    taskId: string;
    execId: string;
    fileDescriptor: number;
    offset: number;
  }> = [];
  const writes: object[] = [];
  let entered: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server.addService(
    {
      start: definition("TaskExecStart", "Start", "Empty"),
      wait: definition("TaskExecWait", "Identity", "Poll"),
      read: definition("TaskExecStdioRead", "Read", "Data", true),
      poll: definition("TaskExecPoll", "Identity", "Poll"),
      write: definition("TaskExecStdinWrite", "Write", "Empty"),
    } as ServiceDefinition,
    {
      start(call: any, callback: any) {
        starts.push(call.request);
        expect(call.metadata.get("authorization")).toEqual(["Bearer test-token"]);
        callback(null, {});
      },
      wait(call: any, callback: any) {
        waits.push(call.request);
        if (failure === "cancel-wait") {
          entered();
          return;
        }
        if (failure === "wait") callback({ code: status.UNAVAILABLE, details: dns });
        else callback(null, { code: 0 });
      },
      read(call: any) {
        reads.push(call.request);
        const stream = call.request.fileDescriptor === 0 ? "stdout" : "stderr";
        if (failure === `cancel-${stream}`) {
          entered();
          return;
        }
        if (failure === stream || failure === "both") {
          // Bytes already read must never become a consumed cursor or fake EOF
          // when the adapter cannot deliver a truthful completed response.
          if (Number(call.request.offset) === 0) {
            call.write({ data: Buffer.from(`${stream} partial\n`) }, () =>
              call.emit("error", { code: status.UNAVAILABLE, details: dns }),
            );
          } else call.emit("error", { code: status.UNAVAILABLE, details: dns });
          return;
        }
        call.write({ data: Buffer.from(`${stream} before uncertainty\n`) });
        call.end();
      },
      poll(_call: any, callback: any) {
        callback(null, { code: 0 });
      },
      write(call: any, callback: any) {
        writes.push(call.request);
        callback(null, {});
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, boundPort) =>
      error ? reject(error) : resolve(boundPort),
    ),
  );
  const modal = {
    profile: { serverUrl: "http://localhost" },
    logger: { debug: () => {}, warn: () => {} },
    cpClient: {
      taskGetCommandRouterAccess: async () => ({
        url: `https://127.0.0.1:${port}`,
        jwt: "test-token",
      }),
      sandboxGetTaskId: async () => ({ taskId: "task-adapter" }),
    },
  };
  installModalCommandStartContext(modal);
  const sandbox = new distribution.sdk.Sandbox(modal as never, "sb-adapter", {
    taskId: "task-adapter",
  });
  if (timeoutMs !== undefined) {
    const exec = sandbox.exec.bind(sandbox);
    Object.assign(sandbox, {
      exec: (command: string[], options: object) => exec(command, { ...options, timeoutMs }),
    });
  }
  const session = new distribution.Session({
    modal,
    app: {},
    sandbox,
    ownsSandbox: false,
    state: {
      sandboxId: "sb-adapter",
      appName: "test",
      manifest: new Manifest({ root: "/workspace" }),
      environment: {},
      workspacePersistence: "tar",
      ownsSandbox: false,
      imageTag: "test",
    },
  } as never);
  installModalCommandStartRetention(session);
  return {
    starts,
    waits,
    reads,
    writes,
    blocked,
    sandbox,
    session,
    close() {
      sandbox.detach();
      server.forceShutdown();
    },
  };
}

for (const distribution of distributions) {
  for (const failure of ["wait", "stdout", "stderr", "both"] as const) {
    test(`${distribution.name} actual adapter preserves post-ACK ${failure} uncertainty`, async () => {
      const f = await fixture(failure, distribution);
      const controller = new AbortController();
      try {
        const result = await withModalCommandStartSignal(controller.signal, () =>
          f.session.execCommand({ cmd: "original command", tty: true, yieldTimeMs: 5_000 }),
        ).catch((error) => error);
        expect(result).toBeInstanceOf(ProviderCommandStartOutcomeUnknownError);
        const invocation = getModalCommandStartInvocation(result);
        expect(invocation).not.toBeNull();
        expect(invocation).toMatchObject({
          sandboxId: "sb-adapter",
          taskId: "task-adapter",
          execId: f.starts[0]!.execId,
          pty: true,
        });
        expect(Object.isFrozen(invocation)).toBe(true);
        const wrappedCause = Object.getOwnPropertyDescriptor(result, "cause")!.value;
        const actualCause = Object.getOwnPropertyDescriptor(wrappedCause, "cause")!.value;
        expect(typeof actualCause).toBe("object");
        expect(getModalCommandStartInvocation(actualCause)).toBe(invocation);
        expect(result.command).toMatchObject({
          taskId: "task-adapter",
          execId: f.starts[0]!.execId,
          pty: true,
          streams: {
            stdout: { byteOffset: 0, eof: false, exitCode: null },
            stderr: { byteOffset: 0, eof: false, exitCode: null },
          },
        });
        expect(f.starts).toHaveLength(1);
        expect(f.writes).toHaveLength(0);
        for (const call of [...f.waits, ...f.reads])
          expect(call).toMatchObject({ taskId: "task-adapter", execId: f.starts[0]!.execId });
        expect(
          failure === "wait"
            ? f.waits.length
            : f.reads.filter((call) => call.fileDescriptor === (failure === "stdout" ? 0 : 1))
                .length,
        ).toBeLessThanOrEqual(3);
      } finally {
        controller.abort();
        f.close();
      }
    }, 10_000);
  }

  for (const failure of ["cancel-wait", "cancel-stdout", "cancel-stderr"] as const) {
    test(`${distribution.name} actual adapter retains exact invocation on ${failure}`, async () => {
      const f = await fixture(failure, distribution);
      const controller = new AbortController();
      try {
        const result = withModalCommandStartSignal(controller.signal, () =>
          f.session.execCommand({ cmd: "original command", tty: true, yieldTimeMs: 5_000 }),
        ).catch((error) => error);
        await f.blocked;
        const began = Date.now();
        controller.abort(new Error("owning attempt cancelled"));
        const error = await result;
        expect(Date.now() - began).toBeLessThan(1_000);
        expect(error).toBeInstanceOf(ProviderCommandStartOutcomeUnknownError);
        expect(getModalCommandStartInvocation(error)).toMatchObject({
          taskId: "task-adapter",
          execId: f.starts[0]!.execId,
          pty: true,
        });
        expect(error.command.streams.stdout.eof).toBe(false);
        expect(error.command.streams.stderr.eof).toBe(false);
        expect(f.starts).toHaveLength(1);
        expect(f.writes).toHaveLength(0);
      } finally {
        controller.abort();
        f.close();
      }
    }, 10_000);
  }

  for (const failure of ["cancel-wait", "cancel-stdout", "cancel-stderr"] as const) {
    test(`${distribution.name} actual adapter bounds ${failure} without an external abort`, async () => {
      const f = await fixture(failure, distribution, 1_000);
      const controller = new AbortController();
      try {
        const began = Date.now();
        const error = await withModalCommandStartSignal(controller.signal, () =>
          f.session.execCommand({ cmd: "bounded original command", tty: true, yieldTimeMs: 5_000 }),
        ).catch((failureValue) => failureValue);
        expect(Date.now() - began).toBeLessThan(1_500);
        expect(error).toBeInstanceOf(ProviderCommandStartOutcomeUnknownError);
        expect(getModalCommandStartInvocation(error)).toMatchObject({
          taskId: "task-adapter",
          execId: f.starts[0]!.execId,
          pty: true,
        });
        expect(error.command.streams.stdout.eof).toBe(false);
        expect(error.command.streams.stderr.eof).toBe(false);
        expect(f.starts).toHaveLength(1);
        expect(f.writes).toHaveLength(0);
      } finally {
        controller.abort();
        f.close();
      }
    }, 10_000);
  }

  test(`${distribution.name} actual adapter still returns proven exit and both drained streams`, async () => {
    const f = await fixture("none", distribution);
    try {
      const result = await f.session.execCommand({ cmd: "normal command", yieldTimeMs: 5_000 });
      expect(result).toContain("Process exited with code 0");
      expect(result).toContain("stdout before uncertainty");
      expect(result).toContain("stderr before uncertainty");
      expect(f.starts).toHaveLength(1);
      expect(f.writes).toHaveLength(0);
    } finally {
      f.close();
    }
  });
}
