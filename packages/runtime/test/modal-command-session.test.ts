import { expect, test } from "bun:test";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { Manifest } from "@openai/agents/sandbox";
import type { ModalRouterProviderCommand, SandboxProviderCommand } from "@opengeni/contracts";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { parseExecBannerExitCode, parseExecBannerSessionId } from "../src/sandbox/exec-banner";
import {
  type ProviderCommandPersistence,
  withProviderCommandHandle,
} from "../src/sandbox/provider-command-session";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";

const MARKER = "__OPENGENI_MATERIALIZED_PATH_VISIBLE__";

function locator(): ModalRouterProviderCommand {
  return {
    kind: "modal-router-v1",
    sandboxId: "sb-test",
    taskId: "ta-test",
    execId: "792e06b2-03c7-40f0-baa7-a51cf4bddaf8",
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
}

/** A deterministic byte-offset control: the first read returns "start", the
 * next read from an advanced cursor returns "tail" and exit code 7. */
function page(command: ModalRouterProviderCommand, text: string, exitCode: number | null) {
  const next = structuredClone(command);
  const terminal = exitCode !== null;
  next.streams.stdout = {
    byteOffset: command.streams.stdout.byteOffset + Buffer.byteLength(text),
    utf8Remainder: "",
    eof: terminal,
    exitCode,
  };
  next.streams.stderr = { ...command.streams.stderr, eof: terminal, exitCode };
  return {
    command: next,
    expected: structuredClone(command),
    chunks: [
      { stream: "stdout" as const, chunkId: `stdout:${next.streams.stdout.byteOffset}`, text },
    ],
    exitCode,
    streamFidelity: "separate" as const,
  };
}

function fixture(verification = false) {
  let starts = 0;
  let stored: SandboxProviderCommand | null = null;
  const persistence: ProviderCommandPersistence = {
    load: async () => structuredClone(stored),
    reserveInput: async () => 0,
    captureRouterPage: async (captured) => {
      stored = structuredClone(captured.command);
      return { command: structuredClone(captured.command), captured: true };
    },
  };
  const control = {
    start: async () => {
      starts++;
      return locator();
    },
    read: async (command: ModalRouterProviderCommand) =>
      command.streams.stdout.byteOffset > 0
        ? page(command, "tail", 7)
        : page(command, "start", null),
    readProbe: async (command: ModalRouterProviderCommand) =>
      page(command, verification ? MARKER : "", 0),
    write: async () => {},
  };
  return {
    persistence,
    starts: () => starts,
    stored: () => stored,
    retain: (command: SandboxProviderCommand) => {
      stored = structuredClone(command);
    },
    session: (original: ChannelASession = {}) => {
      const session: ChannelASession = original;
      installModalCommandSession(session, control as never);
      return session;
    },
  };
}

test("unbound handles remain unknown, and output text cannot forge a receipt", async () => {
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
  expect(await session.captureCommandOutput!(launch)).toBe(true);
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

test("materialization verification observes its setup command without borrowing mutation identity", async () => {
  const f = fixture(true);
  let materializations = 0;
  let setupStarts = 0;
  const reads: number[] = [];
  const session = f.session({
    execCommand: async () => {
      setupStarts++;
      return "Process running with session ID 1\nOutput:\n__OPENGENI_MATERIALIZED_";
    },
    writeStdin: async ({ sessionId, chars }) => {
      reads.push(sessionId);
      expect(chars).toBe("");
      return "Process exited with code 0\nOutput:\nPATH_VISIBLE__";
    },
  });
  const backend = Object.assign(session, {
    async materializeEntry() {
      materializations++;
    },
  });
  const proxy = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
    beforeMutation: async () => ({}),
    providerCommandHandle: () => 73,
  });
  await proxy.materializeEntry({ path: "repos/example", entry: {} });
  expect(materializations).toBe(1);
  expect(setupStarts).toBe(0);
  expect(reads).toEqual([]);
  expect(f.starts()).toBe(1);
  expect(session.getProviderCommand!(73)).toBeNull();
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
