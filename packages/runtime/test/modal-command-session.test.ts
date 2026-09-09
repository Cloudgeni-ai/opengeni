import { expect, test } from "bun:test";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import {
  withProviderCommandHandle,
  type ProviderCommandPersistence,
} from "../src/sandbox/provider-command-session";
import {
  RoutingSandboxSession,
  type RoutingRetainedProcess,
} from "../src/sandbox/routing/routing-session";
import type { SandboxProviderCommand } from "@opengeni/contracts";

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
    session: () => {
      const session: ChannelASession = {};
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
    backend: { sandboxId: null, leaseEpoch: 2, providerInstanceId: "sb-test", activeEpoch: 3 },
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
