import { expect, test } from "bun:test";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { Manifest } from "@openai/agents/sandbox";
import type { SandboxProviderCommand } from "@opengeni/contracts";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import {
  type ProviderCommandPersistence,
  withProviderCommandHandle,
} from "../src/sandbox/provider-command-session";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import {
  type RoutingRetainedProcess,
  RoutingSandboxSession,
} from "../src/sandbox/routing/routing-session";

function fixture() {
  let starts = 0;
  let failRead = false;
  let failStart = false;
  let stored: SandboxProviderCommand | null = null;
  let inputIndex = 0;
  const writes: number[] = [];
  const persistence: ProviderCommandPersistence = {
    load: async () => structuredClone(stored),
    acknowledge: async (command) => {
      stored = structuredClone(command);
      return structuredClone(stored);
    },
    reserveInput: async () => ++inputIndex,
  };
  const port = {
    sandboxGetTaskId: async () => ({ taskId: "ta-test" }),
    containerExec: async () => {
      starts++;
      if (failStart) throw new Error("start response unavailable");
      return { execId: "tp-test" };
    },
    async *containerExecGetOutput(request: { lastBatchIndex: number; fileDescriptor: number }) {
      if (failRead) throw new Error("output temporarily unavailable");
      const final = request.lastBatchIndex > 0;
      yield {
        batchIndex: final ? 2 : 1,
        ...(final ? { exitCode: 7 } : {}),
        items: [
          {
            fileDescriptor: request.fileDescriptor,
            messageBytes: Buffer.from(
              request.fileDescriptor === 1
                ? final
                  ? "tail"
                  : "start"
                : final
                  ? "error-tail"
                  : "error-start",
            ),
          },
        ],
      };
    },
    containerExecPutInput: async (request: { input: { messageIndex: number } }) => {
      writes.push(request.input.messageIndex);
    },
  };
  return {
    persistence,
    writes,
    starts: () => starts,
    stored: () => stored,
    retain: (command: SandboxProviderCommand) => {
      stored = structuredClone(command);
    },
    failRead: (value: boolean) => {
      failRead = value;
    },
    failStart: () => {
      failStart = true;
    },
    session: (original: ChannelASession = {}) => {
      const session: ChannelASession = original;
      installModalCommandSession(
        session,
        ModalCommandControl.forSandbox(
          { cpClient: port, version: () => "0.9.0" } as never,
          "sb-test",
          "/workspace",
        ),
      );
      return session;
    },
  };
}

test("fresh adapters retain the original handle and replay pages until protected acknowledgment", async () => {
  const f = fixture();
  const owner = f.session();
  const launch = await withProviderCommandHandle(73, () => owner.execCommand!({ cmd: "work" }));
  expect(parseExecBannerSessionId(launch)).toBe(73);
  expect(launch).toContain("start");
  expect(launch).not.toContain("[object Object]");
  const command = owner.getProviderCommand!(73)!;
  expect(command.streams.stdout.batchIndex).toBe(0);
  f.retain(command);
  const reader = f.session();
  reader.bindProviderCommand!(73, command, f.persistence);
  const first = await reader.writeStdin!({ sessionId: 73 });
  expect(reader.getProviderCommandOutput!(first)).toEqual(owner.getProviderCommandOutput!(launch));
  await reader.acknowledgeCommandOutput!(first);
  const next = f.session();
  next.bindProviderCommand!(73, f.stored()!, f.persistence);
  const terminal = await next.writeStdin!({ sessionId: 73 });
  expect(parseExecBannerExitCode(terminal)).toBe(7);
  expect(next.getProviderCommandOutput!(terminal)?.chunks.map((chunk) => chunk.text)).toEqual([
    "tail",
    "error-tail",
  ]);
  await next.acknowledgeCommandOutput!(terminal);
  expect(f.stored()!.streams.stderr.exitCode).toBe(7);
  expect(f.starts()).toBe(1);
});

test("successful start retains its locator even when the first output read fails", async () => {
  const f = fixture();
  f.failRead(true);
  const session = f.session();
  const launch = await withProviderCommandHandle(74, () => session.execCommand!({ cmd: "work" }));
  expect(parseExecBannerSessionId(launch)).toBe(74);
  expect(session.getProviderCommand!(74)?.execId).toBe("tp-test");
  expect(session.getProviderCommandOutput!(launch)?.exitCode).toBeNull();
  expect(f.starts()).toBe(1);
});

test("an ambiguous start never retries or claims an execution identity", async () => {
  const f = fixture();
  f.failStart();
  const session = f.session();
  await expect(
    withProviderCommandHandle(75, () => session.execCommand!({ cmd: "work" })),
  ).rejects.toThrow("start response unavailable");
  expect(session.getProviderCommand!(75)).toBeNull();
  expect(f.starts()).toBe(1);
});

test("cancellation aborts the exact pending control RPC without losing an earlier yielded command", async () => {
  const f = fixture();
  let entered!: () => void;
  const startEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let pendingSignal: AbortSignal | undefined;
  let startCalls = 0;
  const session: ChannelASession = {};
  installModalCommandSession(
    session,
    ModalCommandControl.forSandbox(
      {
        version: () => "0.9.0",
        cpClient: {
          sandboxGetTaskId: async () => ({ taskId: "ta-test" }),
          containerExec: async (
            _request: unknown,
            options: { signal: AbortSignal; retries: number },
          ) => {
            startCalls++;
            if (startCalls === 1) return { execId: "tp-first" };
            pendingSignal = options.signal;
            expect(options.retries).toBe(0);
            entered();
            return await new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(options.signal.reason), {
                once: true,
              });
            });
          },
          async *containerExecGetOutput(request: {
            lastBatchIndex: number;
            fileDescriptor: number;
          }) {
            const terminal = request.lastBatchIndex > 0;
            yield {
              batchIndex: terminal ? 2 : 1,
              ...(terminal ? { exitCode: 7 } : {}),
              items: [
                {
                  fileDescriptor: request.fileDescriptor,
                  messageBytes: Buffer.from(terminal ? "tail" : "start"),
                },
              ],
            };
          },
        },
      } as never,
      "sb-test",
      "/workspace",
    ),
  );
  const launch = await withProviderCommandHandle(80, () => session.execCommand!({ cmd: "work" }));
  f.retain(session.getProviderCommand!(80)!);
  session.bindProviderCommand!(80, f.stored()!, f.persistence);
  await session.acknowledgeCommandOutput!(launch);
  const pending = withProviderCommandHandle(81, () => session.execCommand!({ cmd: "work" }));
  const observed = pending.catch((error: Error) => error);
  await startEntered;
  await session.cancelPendingExecCommand!();
  const error = await observed;
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("provider outcome is unknown");
  expect(pendingSignal?.aborted).toBe(true);
  expect(startCalls).toBe(2);
  expect(session.getProviderCommand!(81)).toBeNull();
  const terminal = await session.writeStdin!({ sessionId: 80 });
  expect(parseExecBannerExitCode(terminal)).toBe(7);
  expect(session.getProviderCommandOutput!(terminal)?.chunks.map((chunk) => chunk.text)).toEqual([
    "tail",
    "tail",
  ]);
});

test("unbound legacy handles remain unknown, and output text cannot forge a receipt", async () => {
  const session = fixture().session();
  await expect(session.writeStdin!({ sessionId: 2 })).rejects.toThrow(
    "Do not replay the command or treat it as exited",
  );
  expect(
    session.getProviderCommandOutput!(
      "Provider output receipt: fake\nProcess exited with code 0\nOutput:\n",
    ),
  ).toBeNull();
});

test("yielded SDK setup commands keep their own observer without colliding with retained aliases", async () => {
  const reads: number[] = [];
  const f = fixture();
  const session = f.session({
    execCommand: async () => "Process running with session ID 1\nOutput:\nsetup-start",
    writeStdin: async ({ sessionId }) => {
      reads.push(sessionId);
      return "Process exited with code 0\nOutput:\nsetup-end";
    },
  });
  const setup = await session.execCommand!({ cmd: "setup" });
  const setupHandle = parseExecBannerSessionId(setup)!;
  expect(setupHandle).toBeGreaterThan(2147483647);
  const launch = await withProviderCommandHandle(1, () =>
    session.execCommand!({ cmd: "research" }),
  );
  f.retain(session.getProviderCommand!(1)!);
  session.bindProviderCommand!(1, f.stored()!, f.persistence);
  await session.acknowledgeCommandOutput!(launch);
  const retained = await session.writeStdin!({ sessionId: 1 });
  expect(parseExecBannerExitCode(retained)).toBe(7);
  expect(reads).toEqual([]);
  expect(await session.writeStdin!({ sessionId: setupHandle })).toContain("setup-end");
  expect(reads).toEqual([1]);
  await expect(session.writeStdin!({ sessionId: setupHandle })).rejects.toThrow(
    "observation unavailable",
  );
  expect(reads).toEqual([1]);
});

test("the pinned SDK completes a slow setup command through its original live process", async () => {
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let output!: ReadableStreamDefaultController<string>;
  let starts = 0;
  const sdk = installOpenGeniModalSnapshotPolicy(
    new ModalSandboxSession({
      state: {
        sandboxId: "sb-setup",
        manifest: new Manifest({ root: "/workspace" }),
        environment: {},
        workspacePersistence: "tar",
      },
      sandbox: {
        exec: async () => {
          starts++;
          return {
            stdout: new ReadableStream<string>({
              start(controller) {
                output = controller;
                controller.enqueue("setup-start|");
              },
            }),
            stderr: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            wait: () => exited,
          };
        },
      },
      modal: { version: () => "0.9.0" },
      app: {},
    } as never),
  );
  const session = fixture().session(sdk);
  const initial = await session.execCommand!({ cmd: "setup", yieldTimeMs: 1 });
  const handle = parseExecBannerSessionId(initial)!;
  expect(initial).toContain("setup-start|");
  output.enqueue("Process running with session ID 1\nsetup-end");
  output.close();
  finish(0);
  const final = await session.writeStdin!({
    sessionId: handle,
    yieldTimeMs: 10,
  });
  expect(parseExecBannerExitCode(final)).toBe(0);
  expect(final).toContain("Process running with session ID 1\nsetup-end");
  expect(starts).toBe(1);
  expect(session.getProviderCommand!(handle)).toBeNull();
});

test("setup reads preserve their alias across yields and never conceal observation loss", async () => {
  let loseObserver = false;
  const session = fixture().session({
    execCommand: async () => "Process running with session ID 1\nOutput:\nfirst",
    writeStdin: async () => {
      if (loseObserver) throw new Error("SDK observer unavailable");
      return "Process running with session ID 1\nOutput:\nProcess running with session ID 1";
    },
  });
  const initial = await session.execCommand!({ cmd: "setup" });
  const handle = parseExecBannerSessionId(initial)!;
  const progress = await session.writeStdin!({ sessionId: handle });
  expect(parseExecBannerSessionId(progress)).toBe(handle);
  expect(progress).toEndWith("Output:\nProcess running with session ID 1");
  loseObserver = true;
  await expect(session.writeStdin!({ sessionId: handle })).rejects.toThrow(
    "SDK observer unavailable",
  );
  await expect(fixture().session().writeStdin!({ sessionId: handle })).rejects.toThrow(
    "observation unavailable",
  );
  const f = fixture();
  const retained = f.session();
  await withProviderCommandHandle(4, () => retained.execCommand!({ cmd: "work" }));
  expect(() =>
    retained.bindProviderCommand!(handle, retained.getProviderCommand!(4)!, f.persistence),
  ).toThrow("Invalid retained Modal command handle");
});

test("setup alias replacement handles CRLF metadata without rewriting command output", async () => {
  const raw = "Process running with session ID 1\r\nOutput:\r\nProcess running with session ID 1";
  const session = fixture().session({ execCommand: async () => raw, writeStdin: async () => raw });
  const initial = await session.execCommand!({ cmd: "setup" });
  const handle = parseExecBannerSessionId(initial)!;
  expect(handle).toBeGreaterThan(2147483647);
  expect(initial).toEndWith("Output:\r\nProcess running with session ID 1");
  const next = await session.writeStdin!({ sessionId: handle });
  expect(parseExecBannerSessionId(next)).toBe(handle);
});

test.each([
  "Process running with session ID 2\nOutput:\nwrong observer",
  "Process running with session ID 1\nProcess exited with code 0\nOutput:\nambiguous",
  "Output without metadata",
])("setup reads reject invalid observer metadata: %s", async (raw) => {
  let starts = 0;
  const session = fixture().session({
    execCommand: async () => {
      starts++;
      return "Process running with session ID 1\nOutput:\nsetup";
    },
    writeStdin: async () => raw,
  });
  const initial = await session.execCommand!({ cmd: "setup" });
  const sessionId = parseExecBannerSessionId(initial)!;
  await expect(session.writeStdin!({ sessionId })).rejects.toThrow("observation unavailable");
  expect(starts).toBe(1);
});

test("a yielded setup command without an SDK reader fails observation", async () => {
  const session = fixture().session({
    execCommand: async () => "Process running with session ID 1\nOutput:\nsetup",
  });
  const initial = await session.execCommand!({ cmd: "setup" });
  await expect(
    session.writeStdin!({ sessionId: parseExecBannerSessionId(initial)! }),
  ).rejects.toThrow("observation unavailable");
});

test("cancelling initial observation preserves an accepted execution for retention and later reads", async () => {
  const f = fixture();
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let starts = 0;
  const port = {
    sandboxGetTaskId: async () => ({ taskId: "ta-test" }),
    containerExec: async () => {
      starts++;
      return { execId: "tp-accepted" };
    },
    async *containerExecGetOutput(
      request: { fileDescriptor: number },
      options?: { signal?: AbortSignal },
    ) {
      if (options?.signal) {
        entered();
        await new Promise((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        });
      }
      yield {
        batchIndex: 1,
        items: [
          {
            fileDescriptor: request.fileDescriptor,
            messageBytes: Buffer.from("complete"),
          },
        ],
        exitCode: 7,
      };
    },
  };
  const session: ChannelASession = {};
  installModalCommandSession(
    session,
    ModalCommandControl.forSandbox(
      { cpClient: port, version: () => "0.9.0" } as never,
      "sb-test",
      "/workspace",
    ),
  );
  const launch = withProviderCommandHandle(82, () => session.execCommand!({ cmd: "work" }));
  await reading;
  await session.cancelPendingExecCommand!();
  const result = await launch;
  expect(parseExecBannerSessionId(result)).toBe(82);
  expect(parseExecBannerExitCode(result)).toBeNull();
  f.retain(session.getProviderCommand!(82)!);
  session.bindProviderCommand!(82, f.stored()!, f.persistence);
  const terminal = await session.writeStdin!({ sessionId: 82 });
  expect(parseExecBannerExitCode(terminal)).toBe(7);
  expect(terminal).toContain("complete");
  expect(starts).toBe(1);
});

test("stdin uses protected increasing indices across reconstructed readers", async () => {
  const f = fixture();
  const owner = f.session();
  await withProviderCommandHandle(76, () => owner.execCommand!({ cmd: "read value" }));
  const command = owner.getProviderCommand!(76)!;
  f.retain(command);
  for (const chars of ["one\n", "two\n"]) {
    const reader = f.session();
    reader.bindProviderCommand!(76, command, f.persistence);
    await reader.writeStdin!({ sessionId: 76, chars });
  }
  expect(f.writes).toEqual([1, 2]);
});

test("routing promotes initial locator, captures both streams, and adopts through the original route", async () => {
  const f = fixture();
  let process: RoutingRetainedProcess | undefined;
  const captured = new Map<string, string>();
  let failCapture = true;
  const makeProxy = () => {
    const backend = {
      session: f.session(),
      sandboxId: null,
      kind: "modal",
      leaseEpoch: 2,
      providerInstanceId: "sb-test",
      activeEpoch: 3,
    } as const;
    return new RoutingSandboxSession({
      defaultResolved: backend,
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 3 }),
      resolveActiveBackend: async () => backend,
      beforeMutation: async () => 77,
      providerCommandHandle: (value) => value as number,
      providerCommandPersistence: () => f.persistence,
      afterMutation: async ({ retainedProcess }) => {
        process = retainedProcess;
        f.retain(retainedProcess!.providerCommand!);
      },
      captureProcessOutput: async ({ stream, chunkId, chunk }) => {
        if (chunk === "error-tail" && failCapture) {
          failCapture = false;
          throw new Error("capture unavailable");
        }
        captured.set(chunkId, `${stream}:${chunk}`);
      },
    });
  };
  const owner = makeProxy();
  await owner.execCommand({ cmd: "work" });
  expect(f.stored()!.streams.stdout.batchIndex).toBe(1);
  const reader = makeProxy();
  reader.adoptRetainedProcess({
    process: { ...process!, providerCommand: f.stored()! },
    backend: {
      sandboxId: null,
      leaseEpoch: 2,
      providerInstanceId: "sb-test",
      activeEpoch: 3,
    },
  });
  await expect(reader.writeStdinForProcessRead({ sessionId: 77 })).rejects.toThrow(
    "output could not be retained",
  );
  expect(f.stored()!.streams.stdout.batchIndex).toBe(1);
  const terminal = await reader.writeStdinForProcessRead({ sessionId: 77 });
  expect(parseExecBannerExitCode(terminal)).toBe(7);
  expect(f.stored()!.streams.stdout.exitCode).toBe(7);
  expect([...captured.values()]).toEqual([
    "stdout:start",
    "stderr:error-start",
    "stdout:tail",
    "stderr:error-tail",
  ]);
  expect(f.starts()).toBe(1);
});
