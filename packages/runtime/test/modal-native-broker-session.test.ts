import { expect, test } from "bun:test";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { Manifest } from "@openai/agents/sandbox";
import { shellQuote } from "@openai/agents-core/sandbox/internal";
import type { ChannelAExecArgs } from "../src/sandbox/channel-a";
import type { SynchronousCommandResult } from "../src/sandbox/synchronous-command";
import {
  withProviderCommandHandle,
  withRequiredCommandSupervision,
  withTurnCommandSupervision,
  turnCommandSupervisionProtocol,
  requiredCommandSupervisionProtocol,
} from "../src/sandbox/provider-command-session";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";
import { NativeBrokerCommandSession } from "../src/sandbox/providers/native-command-broker-session";
import {
  installModalNativeBrokerSession,
  withModalNativeBrokerSetupCommands,
} from "../src/sandbox/providers/modal-native-broker-session";

type SdkInternals = {
  sandbox: {
    exec(
      argv: unknown,
      options?: unknown,
    ): Promise<{
      stdout: ReadableStream<string>;
      stderr: ReadableStream<string>;
      wait(): Promise<number>;
    }>;
    filesystem: {
      readBytes(path: string): Promise<Uint8Array>;
      writeBytes(bytes: Uint8Array, path: string): Promise<void>;
    };
  };
  runDirectCommand(argv: string[]): Promise<void>;
  runAsCommandRunner(command: string): Promise<{ status: number; stdout: string; stderr: string }>;
  archiveIo(): {
    runCommand(command: string): Promise<{ status: number; stdout: string; stderr: string }>;
  };
  activeProcesses: Map<unknown, unknown>;
};

function fixture() {
  const events: string[] = [];
  const calls: ChannelAExecArgs[] = [];
  const state = { fail: false, output: "/workspace/file\n", status: 0 };
  const snapshots: unknown[] = [];
  const commands = new NativeBrokerCommandSession({
    journal: {} as ConstructorParameters<typeof NativeBrokerCommandSession>[0]["journal"],
    coordinator: {} as ConstructorParameters<typeof NativeBrokerCommandSession>[0]["coordinator"],
    identity: { sandboxId: "sb-exact", taskId: "ta-exact", brokerId: crypto.randomUUID() },
    root: "/workspace",
    environment: () => ({ FIXTURE: "value" }),
    verify: async () => ({ sandboxId: "sb-exact", taskId: "ta-exact" }),
  });
  commands.execCommand = async () => {
    events.push("broker-command");
    return "broker fixture";
  };
  const originalClose = commands.close.bind(commands);
  commands.close = async () => {
    events.push("broker-close");
    await originalClose();
  };
  const session = new ModalSandboxSession({
    modal: { version: () => "0.9.0" },
    app: {},
    ownsSandbox: true,
    sandbox: {
      exec: async () => {
        throw new Error("TaskExec must never run");
      },
      terminate: async () => {
        events.push("terminate");
      },
      snapshotFilesystem: async (options: unknown) => {
        snapshots.push(options);
        return { imageId: "im-retained-snapshot" };
      },
      filesystem: {
        readBytes: async () => {
          events.push("file-read");
          return new TextEncoder().encode("retained file");
        },
        writeBytes: async () => {
          events.push("file-write");
        },
      },
    },
    state: {
      sandboxId: "sb-exact",
      manifest: new Manifest({ root: "/workspace" }),
      environment: { FIXTURE: "value" },
      workspacePersistence: "snapshot_filesystem",
    },
  } as unknown as ConstructorParameters<typeof ModalSandboxSession>[0]);
  const sdk = session as unknown as SdkInternals;
  const execute = async (args: ChannelAExecArgs): Promise<SynchronousCommandResult> => {
    calls.push(args);
    if (state.fail) throw new Error("canonical admission refused");
    return {
      stdout: state.output,
      stderr: "diagnostic",
      exitCode: state.status,
      wallTimeSeconds: 0,
    };
  };
  const install = () =>
    installModalNativeBrokerSession(session, commands, async () => {
      events.push("transport-close");
    });
  return { session, sdk, events, calls, state, commands, execute, install, snapshots };
}

test("real SDK helper exec sites use one scoped canonical executor, never TaskExec", async () => {
  const f = fixture();
  f.install();
  await withModalNativeBrokerSetupCommands(f.session, f.execute, async () => {
    await f.sdk.runDirectCommand(["mkdir", "-p", "--", "/workspace/a ' $(touch bad)\n"]);
    const runner = await f.sdk.runAsCommandRunner("printf fixture");
    const archive = await f.sdk.archiveIo().runCommand("printf archive");
    expect(runner).toEqual({ status: 0, stdout: "/workspace/file\n", stderr: "diagnostic" });
    expect(archive).toEqual(runner);
    expect(await f.session.pathExists("file")).toBe(true);
  });
  expect(f.calls).toHaveLength(5);
  expect(f.calls[0]!.cmd).toBe(
    `exec ${["mkdir", "-p", "--", "/workspace/a ' $(touch bad)\n"].map(shellQuote).join(" ")}`,
  );
  expect(
    f.calls.every((call) => call.tty === false && call.login === false && call.shell === "/bin/sh"),
  ).toBe(true);
  expect(await f.session.execCommand({ cmd: "fixture" })).toBe("broker fixture");
  expect(f.events).toEqual(["broker-command"]);
});

test("unscoped, foreign and expired helper calls fail before execution", async () => {
  const f = fixture(),
    other = fixture();
  f.install();
  other.install();
  await expect(f.sdk.runDirectCommand(["true"])).rejects.toThrow("exact live routing scope");
  await withModalNativeBrokerSetupCommands(other.session, other.execute, async () => {
    await expect(f.sdk.runDirectCommand(["true"])).rejects.toThrow("exact live routing scope");
  });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let detached!: Promise<unknown>;
  await withModalNativeBrokerSetupCommands(f.session, f.execute, async () => {
    detached = wait.then(() => f.sdk.runDirectCommand(["true"]));
  });
  release();
  await expect(detached).rejects.toThrow("exact live routing scope");
  expect(f.calls).toHaveLength(0);
});

test("unsupported options and canonical refusal do not fall back or replay", async () => {
  const f = fixture();
  f.install();
  await withModalNativeBrokerSetupCommands(f.session, f.execute, async () => {
    for (const options of [
      { mode: "binary" },
      { pty: true },
      { env: { FOREIGN: "value" } },
      { timeout: 1000 },
      { stdout: "inherit" },
    ])
      await expect(f.sdk.sandbox.exec(["true"], options)).rejects.toThrow("foreground options");
    expect(f.calls).toHaveLength(0);
    f.state.fail = true;
    await expect(f.sdk.runDirectCommand(["true"])).rejects.toThrow("canonical admission refused");
    expect(f.calls).toHaveLength(1);
  });
});

test("real SDK file methods preserve routing and mutation admission", async () => {
  const f = fixture();
  f.install();
  await expect(f.sdk.sandbox.filesystem.readBytes("/workspace/file")).rejects.toThrow(
    "routing scope",
  );
  await withModalNativeBrokerSetupCommands(f.session, f.execute, async () => {
    expect(
      new TextDecoder().decode(await f.sdk.sandbox.filesystem.readBytes("/workspace/file")),
    ).toBe("retained file");
    await expect(
      f.sdk.sandbox.filesystem.writeBytes(new Uint8Array(), "/workspace/file"),
    ).rejects.toThrow("mutation admission");
    await withProviderCommandHandle(37, () =>
      f.sdk.sandbox.filesystem.writeBytes(new Uint8Array(), "/workspace/file"),
    );
  });
  expect(f.events).toEqual(["file-read", "file-write"]);
});

test("close is host-only, idempotent, and prevents later helper execution", async () => {
  const f = fixture();
  f.install();
  await Promise.all([f.session.close(), f.session.close()]);
  expect(f.events).toEqual(["broker-close", "transport-close"]);
  await withModalNativeBrokerSetupCommands(f.session, f.execute, async () => {
    await expect(f.sdk.runDirectCommand(["true"])).rejects.toThrow("session is closed");
  });
  await expect(f.session.hydrateWorkspace("unsupported")).rejects.toThrow("preservation admission");
  expect(f.events).not.toContain("terminate");
});

test("qualified bootstrap readiness is host-only and preserves rejection and cancellation", async () => {
  const f = fixture();
  let reads = 0;
  installModalNativeBrokerSession(
    f.session,
    f.commands,
    async () => {},
    async (signal) => {
      signal?.throwIfAborted();
      reads++;
      if (reads > 1) throw new Error("qualified bootstrap is no longer current");
    },
  );
  const check = Reflect.get(f.session, "verifyExecReadiness").bind(f.session);
  expect(await check()).toBe(0);
  await expect(check()).rejects.toThrow("no longer current");
  const aborted = AbortSignal.abort(new Error("cancelled readiness"));
  await expect(check(aborted)).rejects.toThrow("cancelled readiness");
  expect(reads).toBe(2);
  expect(f.calls).toHaveLength(0);
  await f.session.close();
  await expect(check()).rejects.toThrow("session is closed");
});

test("installation refuses active SDK commands and duplicate wrappers", () => {
  const f = fixture();
  f.sdk.activeProcesses.set(12, {});
  expect(f.install).toThrow("existing SDK commands");
  f.sdk.activeProcesses.clear();
  f.install();
  expect(f.install).toThrow("one fresh SDK session");
});

test("existing list compatibility uses the scoped runner and snapshot wrappers keep identity", async () => {
  const f = fixture();
  installOpenGeniModalSnapshotPolicy(f.session);
  const original = f.sdk.sandbox;
  f.install();
  expect(f.sdk.sandbox).toBe(original);
  const session = f.session as unknown as {
    listDir(args: { path: string }): Promise<unknown>;
    persistWorkspace(options: { requestId: string }): Promise<Uint8Array>;
  };
  f.state.output = "f\t1\t0\t644\t./file\0";
  await withModalNativeBrokerSetupCommands(
    f.session,
    async (args) => {
      const result = await f.execute(args);
      const frame = /__OPENGENI_FS_CONFINED_([a-f0-9]{32})_OK__/.exec(args.cmd)?.[1];
      if (!frame) throw new Error("confined command did not contain a frame nonce");
      return {
        ...result,
        stdout: `__OPENGENI_FS_CONFINED_${frame}_OK__\n${result.stdout}__OPENGENI_FS_CONFINED_${frame}_END__:${result.exitCode}__`,
      };
    },
    async () => {
      expect(await session.listDir({ path: "/workspace" })).toEqual([
        { name: "file", path: "/workspace/file", type: "file" },
      ]);
    },
  );
  expect(f.calls).toHaveLength(1);
  const requestId = crypto.randomUUID();
  expect((await session.persistWorkspace({ requestId })).byteLength).toBeGreaterThan(0);
  expect(f.snapshots).toEqual([{ ttlMs: null, snapshotId: requestId }]);
});

test("routing supplies exact-backend helper scope without inheriting an outer PTY shape", async () => {
  const f = fixture();
  f.install();
  const backend = {
    session: f.session,
    kind: "modal",
    sandboxId: null,
    activeEpoch: 0,
    leaseEpoch: 7,
    providerInstanceId: "sb-exact",
  };
  const proxy = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    qualifiedProviderSupervision: async () => {
      throw new Error("Only nested commands select a protocol");
    },
  });
  // The canonical nested command path is independently covered by routing
  // admission tests; this checks the actual SDK helper's private callback.
  Reflect.set(
    proxy,
    "execSynchronousOnBackend",
    async (args: ChannelAExecArgs, _runner: unknown, selected: unknown) => {
      expect(selected).toEqual(backend);
      expect(turnCommandSupervisionProtocol()).toBe("native-subreaper-v1");
      expect(requiredCommandSupervisionProtocol()).toBeUndefined();
      return await f.execute(args);
    },
  );
  await withTurnCommandSupervision("native-subreaper-pty-v1", () =>
    withRequiredCommandSupervision("native-subreaper-pty-v1", async () => {
      expect(await proxy.pathExists("file")).toBe(true);
      expect(requiredCommandSupervisionProtocol()).toBe("native-subreaper-pty-v1");
    }),
  );
  expect(f.calls).toHaveLength(2);
  await expect(f.session.pathExists("file")).rejects.toThrow("exact live routing scope");
});
