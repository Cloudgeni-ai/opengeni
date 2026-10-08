import { expect, test } from "bun:test";
import { Daytona as NativeDaytona, Process as NativeProcess } from "@daytonaio/sdk";
import { Manifest } from "@openai/agents/sandbox";
import { DaytonaSandboxClient } from "@openai/agents-extensions/sandbox/daytona";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The pinned native service labels each line, appends a newline to a final
// unterminated line and publishes exit before both labelers join. These native
// Process regressions exercise that raw transport limitation, not a fabricated
// trusted filesystem receipt. See upstream v0.162.0 pkg/session/execute.go.
function fixture(waitForEof = true) {
  const sessionId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const logs: Buffer[] = [];
  const originals = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  let source = "";
  let exitCode: number | undefined;
  let starts = 0;
  let deleted = 0;
  let readers: Promise<void> = Promise.resolve();
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
  const original = (session: string, command?: string) => {
    expect(session).toBe(sessionId);
    if (command !== undefined) expect(command).toBe(commandId);
  };
  const process = new NativeProcess(
    { basePath: "https://native.invalid" } as ConstructorParameters<typeof NativeProcess>[0],
    {} as ConstructorParameters<typeof NativeProcess>[1],
    {
      executeCommand: async () => ({ data: { exitCode: 0, result: "" } }),
      createSession: async ({ sessionId: session }: { sessionId: string }) => {
        original(session);
        return { data: {} };
      },
      sessionExecuteCommand: async (session: string, request: { command: string }) => {
        original(session);
        source = request.command;
        starts++;
        const child = Bun.spawn(["/bin/sh", "-c", source], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        readers = Promise.all([
          labelled("stdout", child.stdout),
          labelled("stderr", child.stderr),
        ]).then(() => {});
        exitCode = await child.exited;
        if (waitForEof) await readers;
        return {
          data: { cmdId: commandId, exitCode, output: Buffer.concat(logs).toString("utf8") },
        };
      },
      getSessionCommand: async (session: string, command: string) => {
        original(session, command);
        return { data: { id: commandId, command: source, exitCode } };
      },
      getSessionCommandLogs: async (session: string, command: string) => {
        original(session, command);
        return { data: Buffer.concat(logs).toString("utf8") };
      },
      deleteSession: async (session: string) => {
        original(session);
        deleted++;
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
