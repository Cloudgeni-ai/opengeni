import { expect, test } from "bun:test";
import { Daytona as NativeDaytona, Process as NativeProcess } from "@daytonaio/sdk";
import { Manifest } from "@openai/agents/sandbox";
import { DaytonaSandboxClient } from "@openai/agents-extensions/sandbox/daytona";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  boundDaytonaCommandProcess,
  withDaytonaCommandBinding,
} from "../src/sandbox/providers/daytona-command-binding";
import { DaytonaFramedCommand } from "../src/sandbox/providers/daytona-framed-command";

// The pinned native service labels each line, appends a newline to a final
// unterminated line and publishes exit before both labelers join. These native
// Process regressions exercise that raw transport limitation, not a fabricated
// trusted filesystem receipt. See upstream v0.162.0 pkg/session/execute.go.
function fixture(
  waitForEof = true,
  purgeOnDelete = false,
  loseStartReply = false,
  onDelete?: () => Promise<void>,
) {
  const sessionId = crypto.randomUUID();
  let selectedSessionId = sessionId;
  const commandId = crypto.randomUUID();
  const logs: Buffer[] = [];
  const originals = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  let source = "";
  let exitCode: number | undefined;
  let starts = 0;
  let deleted = 0;
  let readers: Promise<void> = Promise.resolve();
  let present = true;
  const labelled = async (stream: "stdout" | "stderr", input: ReadableStream<Uint8Array>) => {
    const prefix = Buffer.alloc(3, stream === "stdout" ? 1 : 2);
    let pending = Buffer.alloc(0);
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      originals[stream] = Buffer.concat([originals[stream], bytes]);
      pending = Buffer.concat([pending, bytes]);
      let newline = pending.indexOf(10);
      while (newline !== -1) {
        logs.push(Buffer.concat([prefix, pending.subarray(0, newline + 1)]));
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
    }
    if (pending.length) logs.push(Buffer.concat([prefix, pending, Buffer.from("\n")]));
  };
  const exists = () => {
    if (!present) throw Object.assign(new Error("Native session missing"), { statusCode: 404 });
  };
  const process = new NativeProcess(
    { basePath: "https://native.invalid" } as ConstructorParameters<typeof NativeProcess>[0],
    {} as ConstructorParameters<typeof NativeProcess>[1],
    {
      executeCommand: async () => ({ data: { exitCode: 0, result: "" } }),
      createSession: async ({ sessionId: session }: { sessionId: string }) => {
        if (starts) expect(session).toBe(selectedSessionId);
        else selectedSessionId = session;
        present = true;
        return { data: {} };
      },
      sessionExecuteCommand: async (
        session: string,
        request: { command: string; runAsync?: boolean },
      ) => {
        expect(session).toBe(selectedSessionId);
        exists();
        source = request.command;
        starts++;
        const child = Bun.spawn(["/bin/sh", "-c", source], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const exited = child.exited.then((code) => {
          exitCode = code;
        });
        readers = Promise.all([
          labelled("stdout", child.stdout),
          labelled("stderr", child.stderr),
          exited,
        ]).then(() => {});
        if (request.runAsync) {
          if (loseStartReply) throw new Error("Original command Start reply lost");
          return { data: { cmdId: commandId } };
        }
        await exited;
        if (waitForEof) await readers;
        return {
          data: { cmdId: commandId, exitCode, output: Buffer.concat(logs).toString("utf8") },
        };
      },
      getSessionCommand: async (session: string, command: string) => {
        expect(session).toBe(selectedSessionId);
        expect(command).toBe(commandId);
        exists();
        return { data: { id: commandId, command: source, exitCode } };
      },
      getSession: async (session: string) => {
        expect(session).toBe(selectedSessionId);
        exists();
        return {
          data: { sessionId: session, commands: [{ id: commandId, command: source, exitCode }] },
        };
      },
      getSessionCommandLogs: async (session: string, command: string) => {
        expect(session).toBe(selectedSessionId);
        expect(command).toBe(commandId);
        exists();
        return { data: Buffer.concat(logs).toString("utf8") };
      },
      deleteSession: async (session: string) => {
        expect(session).toBe(selectedSessionId);
        deleted++;
        await onDelete?.();
        if (purgeOnDelete) present = false;
        return { data: {} };
      },
    } as unknown as ConstructorParameters<typeof NativeProcess>[2],
    async () => {
      throw new Error("no new authentication or connection");
    },
  );
  return {
    process,
    sessionId,
    commandId,
    originals,
    starts: () => starts,
    deleted: () => deleted,
    eof: () => readers,
  };
}

test("the pinned Agents Daytona create and exact resume discard native session API bindings", async () => {
  const native = fixture();
  const sandbox = {
    id: "sb-native-binding",
    process: native.process,
    start: async () => {},
    stop: async () => {},
    delete: async () => {},
    fs: {
      createFolder: async () => {},
      uploadFile: async () => {},
      downloadFile: async () => Buffer.alloc(0),
      deleteFile: async () => {},
    },
  };
  const create = Object.getOwnPropertyDescriptor(NativeDaytona.prototype, "create")!;
  const get = Object.getOwnPropertyDescriptor(NativeDaytona.prototype, "get")!;
  let creates = 0;
  let gets = 0;
  Object.defineProperty(NativeDaytona.prototype, "create", {
    ...create,
    value: async (args: { image: string }) => {
      expect(args.image).toBe("debian:12.9");
      creates++;
      return sandbox;
    },
  });
  Object.defineProperty(NativeDaytona.prototype, "get", {
    ...get,
    value: async (id: string) => {
      expect(id).toBe(sandbox.id);
      gets++;
      return sandbox;
    },
  });
  try {
    const client = new DaytonaSandboxClient({
      apiKey: "native-fixture",
      apiUrl: "https://native.invalid",
      target: "fixture",
      pauseOnExit: true,
    });
    const created = await client.create(new Manifest());
    const resumed = await client.resumeExact(created.state);
    for (const session of [created, resumed]) {
      const retained = Object.getOwnPropertyDescriptor(session, "sandbox")?.value as {
        process: Record<string, unknown>;
      };
      for (const method of [
        "createSession",
        "executeSessionCommand",
        "getSessionCommand",
        "getSessionCommandLogs",
        "sendSessionCommandInput",
        "deleteSession",
      ] as const) {
        expect(typeof native.process[method]).toBe("function");
        expect(retained.process[method]).toBeUndefined();
      }
      expect(Object.keys(retained.process).sort()).toEqual([
        "createPty",
        "executeCommand",
        "killPtySession",
      ]);
      await session.close();
    }
    expect(creates).toBe(1);
    expect(gets).toBe(1);
    expect(native.starts()).toBe(0);
  } finally {
    Object.defineProperty(NativeDaytona.prototype, "create", create);
    Object.defineProperty(NativeDaytona.prototype, "get", get);
  }
});

test("native framed cleanup shares a failed attempt and retries only after terminal output custody", async () => {
  let reject!: (error: Error) => void;
  let failed = false;
  const gate = new Promise<void>((_resolve, rejectGate) => {
    reject = rejectGate;
  });
  const native = fixture(true, false, false, async () => {
    if (!failed) await gate;
  });
  const command = new DaytonaFramedCommand(
    native.process,
    "printf original; printf diagnostic >&2",
    crypto.randomUUID(),
  );
  await command.start();
  await native.eof();
  expect(await command.read()).toEqual({ stdout: "original", stderr: "diagnostic", exitCode: 0 });
  const first = command.cleanup();
  const second = command.cleanup();
  expect(native.deleted()).toBe(1);
  const outcomes = Promise.allSettled([first, second]);
  reject(new Error("cleanup response unavailable"));
  expect((await outcomes).map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  expect(native.deleted()).toBe(1);
  failed = true;
  await command.cleanup();
  await command.cleanup();
  expect(native.deleted()).toBe(2);
  expect(native.starts()).toBe(1);
});

test("runtime Daytona binding keeps the same native principal and exact sandbox through SDK create and patch-free exact resume", async () => {
  const native = fixture();
  const sandbox = {
    id: "sb-bound-native",
    target: "original-target",
    process: native.process,
    start: async () => {},
    stop: async () => {},
    delete: async () => {},
    fs: {
      createFolder: async () => {},
      uploadFile: async () => {},
      downloadFile: async () => Buffer.alloc(0),
      deleteFile: async () => {},
    },
  };
  const create = Object.getOwnPropertyDescriptor(NativeDaytona.prototype, "create")!;
  const get = Object.getOwnPropertyDescriptor(NativeDaytona.prototype, "get")!;
  const options = {
    apiKey: "frozen-native-fixture",
    apiUrl: "https://original-native.invalid",
    target: "original-target",
    pauseOnExit: true,
  };
  let creates = 0;
  let gets = 0;
  let ordinaryResumes = 0;
  function principal(client: object) {
    for (const field of ["apiKey", "apiUrl", "target"] as const)
      expect(Object.getOwnPropertyDescriptor(client, field)?.value).toBe(options[field]);
  }
  Object.defineProperty(NativeDaytona.prototype, "create", {
    ...create,
    value: async function (this: object, args: { image: string }) {
      principal(this);
      expect(args.image).toBe("debian:12.9");
      creates++;
      return sandbox;
    },
  });
  Object.defineProperty(NativeDaytona.prototype, "get", {
    ...get,
    value: async function (this: object, id: string) {
      principal(this);
      expect(id).toBe("sb-bound-native");
      gets++;
      return sandbox;
    },
  });
  try {
    const sdk = new DaytonaSandboxClient(options);
    sdk.resume = async () => {
      ordinaryResumes++;
      throw new Error("no replacing resume");
    };
    Object.defineProperty(sdk, "resumeExact", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const client = withDaytonaCommandBinding(sdk, options);
    const created = await client.create(new Manifest());
    expect(gets).toBe(0);
    const selected = await boundDaytonaCommandProcess(created);
    expect(await boundDaytonaCommandProcess(created)).toBe(selected);
    expect(gets).toBe(1);
    await selected.createSession(native.sessionId);
    const receipt = await selected.executeSessionCommand(native.sessionId, {
      command: "printf original",
    });
    expect(receipt.cmdId).toBe(native.commandId);
    expect(native.originals.stdout.toString()).toBe("original");
    const resumed = await client.resumeExact(created.state);
    expect(resumed.state.sandboxId).toBe(created.state.sandboxId);
    expect(await boundDaytonaCommandProcess(resumed)).toBe(
      await boundDaytonaCommandProcess(resumed),
    );
    expect(creates).toBe(1);
    expect(gets).toBe(2);
    expect(ordinaryResumes).toBe(0);
    expect(native.starts()).toBe(1);
    await created.close();
    await resumed.close();
    const selectedAgain = await client.create(new Manifest());
    selectedAgain.state.apiUrl = "https://changed-native.invalid";
    await expect(boundDaytonaCommandProcess(selectedAgain)).rejects.toThrow(
      "changed exact Daytona",
    );
    expect(gets).toBe(2);
    expect(native.starts()).toBe(1);
    await selectedAgain.close();
    const wrongTarget = await client.create(new Manifest());
    sandbox.target = "different-target";
    await expect(boundDaytonaCommandProcess(wrongTarget)).rejects.toThrow("different target");
    expect(native.starts()).toBe(1);
    sandbox.target = options.target;
    const originalId = sandbox.id;
    const wrongId = await client.create(new Manifest());
    sandbox.id = "not-original";
    await expect(boundDaytonaCommandProcess(wrongId)).rejects.toThrow("different sandbox");
    sandbox.id = originalId;
    await wrongTarget.close();
    await wrongId.close();
  } finally {
    Object.defineProperty(NativeDaytona.prototype, "create", create);
    Object.defineProperty(NativeDaytona.prototype, "get", get);
  }
});

test("the pinned native Daytona session adds newline bytes absent from the original streams", async () => {
  const native = fixture();
  await native.process.createSession(native.sessionId);
  const result = await native.process.executeSessionCommand(native.sessionId, {
    command: "printf prefix; printf diagnostic >&2",
  });
  expect(result).toMatchObject({
    cmdId: native.commandId,
    stdout: "prefix\n",
    stderr: "diagnostic\n",
    exitCode: 0,
  });
  expect(native.originals.stdout.toString()).toBe("prefix");
  expect(native.originals.stderr.toString()).toBe("diagnostic");
  expect(native.starts()).toBe(1);
  await native.process.deleteSession(native.sessionId);
});

test("the pinned native Daytona marker projection cannot authenticate original stream membership", async () => {
  const native = fixture();
  await native.process.createSession(native.sessionId);
  const result = await native.process.executeSessionCommand(native.sessionId, {
    command: "printf 'prefix\\002\\002\\002tail'; printf diagnostic >&2",
  });
  expect(native.originals.stdout.toString()).toBe("prefix\u0002\u0002\u0002tail");
  expect(native.originals.stderr.toString()).toBe("diagnostic");
  expect(result.stdout).toBe("prefix");
  expect(result.stderr).toContain("tail");
  expect(result.stderr).toContain("diagnostic");
  expect(native.starts()).toBe(1);
  await native.process.deleteSession(native.sessionId);
});

test("the pinned native Daytona text projection replaces malformed original UTF8", async () => {
  const native = fixture();
  await native.process.createSession(native.sessionId);
  const result = await native.process.executeSessionCommand(native.sessionId, {
    command: "printf '\\377'",
  });
  expect([...native.originals.stdout]).toEqual([255]);
  expect(result.stdout).toBe("�\n");
  expect(result.exitCode).toBe(0);
  expect(native.starts()).toBe(1);
  await native.process.deleteSession(native.sessionId);
});

test.each([false, true])(
  "native framed collection recovers the one original command across lost Start reply %s",
  async (lostReply) => {
    const native = fixture(true, false, lostReply);
    const command = new DaytonaFramedCommand(
      native.process,
      "printf prefix; printf diagnostic >&2; exit 7",
      crypto.randomUUID(),
    );
    await command.start();
    await native.eof();
    expect(await command.read()).toEqual({ stdout: "prefix", stderr: "diagnostic", exitCode: 7 });
    expect(await command.read()).toEqual({ stdout: "prefix", stderr: "diagnostic", exitCode: 7 });
    await expect(command.start()).rejects.toThrow("cannot be started again");
    expect(native.starts()).toBe(1);
    expect(native.deleted()).toBe(0);
    await command.cleanup();
    expect(native.deleted()).toBe(1);
  },
);

test("native deletion success and a purged session cannot release framed output or original physical custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-purged-command-"));
  const release = join(root, "release");
  const native = fixture(false, true);
  const command = new DaytonaFramedCommand(
    native.process,
    `printf prefix; (while [ ! -e '${release}' ]; do sleep 0.01; done; printf diagnostic >&2) & exit 7`,
    crypto.randomUUID(),
  );
  let physicalComplete = false;
  try {
    await command.start();
    const physical = native.eof().then(() => {
      physicalComplete = true;
    });
    expect(await command.read()).toBeNull();
    await expect(command.cleanup()).rejects.toThrow("remain unknown");
    // Model the pinned daemon's suppressed termination error: deletion purges
    // the namespace/log access but deliberately does NOT stop this real child.
    await native.process.deleteSession(command.sessionId);
    expect(native.deleted()).toBe(1);
    expect(physicalComplete).toBe(false);
    await expect(command.read()).rejects.toMatchObject({ statusCode: 404 });
    await expect(command.cleanup()).rejects.toThrow("remain unknown");
    expect(native.starts()).toBe(1);
    await writeFile(release, "release");
    await physical;
    // Later actual exit still cannot recreate the purged original output.
    await expect(command.read()).rejects.toMatchObject({ statusCode: 404 });
    await expect(command.cleanup()).rejects.toThrow("remain unknown");
    expect(native.deleted()).toBe(1);
    expect(native.starts()).toBe(1);
  } finally {
    await writeFile(release, "release");
    await native.eof();
    await rm(root, { recursive: true, force: true });
  }
});

test("native Daytona exit and snapshot logs do not prove descendant stream EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-native-eof-"));
  const release = join(root, "release");
  const native = fixture(false);
  let drained = false;
  try {
    await native.process.createSession(native.sessionId);
    const result = await native.process.executeSessionCommand(native.sessionId, {
      command: `printf prefix; (while [ ! -e '${release}' ]; do sleep 0.01; done; printf tail; printf diagnostic >&2) & exit 7`,
    });
    const pendingEof = native.eof().finally(() => {
      drained = true;
    });
    expect(result).toMatchObject({ cmdId: native.commandId, exitCode: 7 });
    expect(
      await native.process.getSessionCommand(native.sessionId, native.commandId),
    ).toMatchObject({ id: native.commandId, exitCode: 7 });
    expect(
      (await native.process.getSessionCommandLogs(native.sessionId, native.commandId)).output ?? "",
    ).toBe("");
    expect(drained).toBe(false);
    expect(native.deleted()).toBe(0);
    await writeFile(release, "release");
    await pendingEof;
    expect(
      await native.process.getSessionCommandLogs(native.sessionId, native.commandId),
    ).toMatchObject({ stdout: "prefixtail\n", stderr: "diagnostic\n" });
    expect(native.originals.stdout.toString()).toBe("prefixtail");
    expect(native.originals.stderr.toString()).toBe("diagnostic");
    expect(native.starts()).toBe(1);
    await native.process.deleteSession(native.sessionId);
  } finally {
    await writeFile(release, "release");
    await native.eof();
    await rm(root, { recursive: true, force: true });
  }
});
