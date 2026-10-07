// OPE-701: execute real filesystem scripts, then delay the adapter's terminal
// receipt independently of their output. Output is not process-completion proof.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SandboxChannelAService,
  type ChannelAExecArgs,
  type ChannelASession,
} from "../src/sandbox";
import { hostShellSession } from "./isolated-git-home-fixture";

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function banner(handle: number, output: string, exitCode: number | null = null): string {
  return `${exitCode === null ? `Process running with session ID ${handle}` : `Process exited with code ${exitCode}`}\nOutput:\n${output}`;
}

function fixture(
  options: {
    hold?: (args: ChannelAExecArgs) => boolean;
    fail?: (args: ChannelAExecArgs) => boolean;
    observationError?: Error;
    split?: boolean;
  } = {},
) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opengeni-fs-completion-")));
  roots.push(base);
  const root = join(base, "workspace");
  mkdirSync(root);
  const shell = hostShellSession(join(base, "home"), { cwd: root, shell: "bash" });
  const commands: ChannelAExecArgs[] = [];
  const reads: number[] = [];
  const settled: number[] = [];
  const yielded = deferred<number>();
  const yieldGates = new Map<number, ReturnType<typeof deferred<void>>>();
  const yieldGate = (handle: number) => {
    let gate = yieldGates.get(handle);
    if (!gate) {
      gate = deferred<void>();
      yieldGates.set(handle, gate);
    }
    return gate;
  };
  let active: {
    handle: number;
    output: string;
    stderr: string;
    exitCode: number;
    released: ReturnType<typeof deferred<void>>;
    pages: string[];
  } | null = null;
  const session: ChannelASession = {
    exec: async (args) => {
      // Starting a new batch before the previous authenticated receipt is a
      // regression even if the previous batch has printed its success marker.
      if (active) throw new Error("duplicate Start before previous command settled");
      commands.push(args);
      const native = await shell.exec(args);
      const handle = commands.length;
      const splitAt = options.split ? Math.floor(native.stdout.length / 2) : native.stdout.length;
      active = {
        handle,
        output: native.stdout,
        stderr: native.stderr,
        exitCode: options.fail?.(args) ? 17 : native.exitCode,
        released: deferred<void>(),
        pages: options.split ? [native.stdout.slice(splitAt)] : [],
      };
      if (!options.hold?.(args)) active.released.resolve();
      yielded.resolve(handle);
      yieldGate(handle).resolve();
      return {
        stdout: native.stdout.slice(0, splitAt),
        stderr: native.stderr,
        exitCode: null,
        sessionId: handle,
      };
    },
    writeStdin: async (args) => {
      expect(args.chars ?? "").toBe("");
      if (!active || active.handle !== args.sessionId) throw new Error("wrong command identity");
      reads.push(args.sessionId);
      if (options.observationError) throw options.observationError;
      if (active.pages.length) return banner(active.handle, active.pages.shift()!);
      await active.released.promise;
      const terminal = active;
      active = null;
      settled.push(terminal.handle);
      return banner(terminal.handle, "", terminal.exitCode);
    },
  };
  const events: unknown[] = [];
  const service = new SandboxChannelAService({
    session,
    workspaceRoot: root,
    emit: async (batch) => {
      events.push(...batch);
    },
  });
  return {
    root,
    session,
    service,
    commands,
    reads,
    settled,
    events,
    yielded: yielded.promise,
    waitForYield: (handle: number) => yieldGate(handle).promise,
    release: () => active?.released.resolve(),
  };
}

function tracked<T>(promise: Promise<T>) {
  let finished = false;
  const observed = promise.then(
    (value) => {
      finished = true;
      return value;
    },
    (error: unknown) => {
      finished = true;
      throw error;
    },
  );
  // Tests inspect a rejected operation only after releasing the fixture. Keep
  // Bun's unhandled-rejection detector from obscuring the actual assertion.
  void observed.catch(() => undefined);
  return { promise: observed, finished: () => finished };
}

describe("synchronous internal filesystem completion", () => {
  test("batch markers with a running handle remain pending until the same execution exits", async () => {
    const f = fixture({ hold: () => true });
    const operation = tracked(
      f.service.fsWriteFiles({
        directory: "fixture",
        files: [{ path: "run.py", content: "print(42)\n" }],
      }),
    );
    await f.yielded;
    await Promise.resolve();
    expect(readFileSync(join(f.root, "fixture/run.py"), "utf8")).toBe("print(42)\n");
    expect(operation.finished()).toBe(false);
    expect(f.events).toEqual([]);
    expect(f.commands).toHaveLength(1);
    f.release();
    const result = await operation.promise;
    expect(result.written).toEqual(["run.py"]);
    expect(f.settled).toEqual([1]);
    expect(f.reads.every((id) => id === 1)).toBe(true);
    expect(f.events).toHaveLength(1);
  });

  test("unchanged checkout awaits terminal evidence without replacing the matching file", async () => {
    const f = fixture({ split: true });
    const request = { directory: "fixture", files: [{ path: "run.py", content: "print(42)\n" }] };
    await f.service.fsWriteFiles(request);
    const before = statSync(join(f.root, "fixture/run.py"));
    const repeated = await f.service.fsWriteFiles(request);
    const after = statSync(join(f.root, "fixture/run.py"));
    expect(repeated.written).toEqual([]);
    expect(repeated.unchanged).toEqual(["run.py"]);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(f.commands).toHaveLength(2);
    expect(f.settled).toEqual([1, 2]);
    expect(f.events).toHaveLength(1);
  });

  test("multi-batch checkout settles every check and write before advancing", async () => {
    const f = fixture({ split: true });
    const files = Array.from({ length: 12 }, (_, index) => ({
      path: `data/${index}.txt`,
      content: `${index}\n${"content ".repeat(4_096)}`,
    }));
    const first = await f.service.fsWriteFiles({ directory: "fixture", files });
    expect(f.commands.length).toBeGreaterThan(2);
    expect(f.settled).toEqual(f.commands.map((_, index) => index + 1));
    expect(first.written).toEqual(files.map((file) => file.path));
    for (const file of files) {
      expect(readFileSync(join(f.root, "fixture", file.path), "utf8")).toBe(file.content);
    }
    const repeated = await f.service.fsWriteFiles({ directory: "fixture", files });
    expect(repeated.written).toEqual([]);
    expect(repeated.unchanged).toEqual(files.map((file) => file.path));
    expect(f.settled).toEqual(f.commands.map((_, index) => index + 1));
  });

  test("fallback write/mkdir/move/delete, existence and confinement settle each command", async () => {
    const f = fixture({ split: true });
    await f.service.fsMkdir({ path: "fixture", recursive: false });
    await f.service.fsWrite({
      path: "fixture/run.py",
      content: "print(42)\n",
      encoding: "utf8",
      overwrite: false,
      createParents: false,
    });
    const startedBeforeConflict = f.commands.length;
    await expect(
      f.service.fsWrite({
        path: "fixture/run.py",
        content: "different",
        encoding: "utf8",
        overwrite: false,
        createParents: false,
      }),
    ).rejects.toThrow("exists");
    expect(f.commands.length - startedBeforeConflict).toBe(2);
    await f.service.fsMove({
      path: "fixture/run.py",
      newPath: "nested/run.py",
      overwrite: false,
      createParents: true,
    });
    const read = await f.service.fsRead({
      path: "nested/run.py",
      maxBytes: 1_024,
      encoding: "utf8",
    });
    expect(read.content).toBe("print(42)\n");
    const listed = await f.service.fsList({
      path: "nested",
      depth: 1,
      maxEntries: 100,
      includeHidden: true,
    });
    expect(listed.root.children?.map((node) => node.name)).toEqual(["run.py"]);
    await f.service.fsDelete({ path: "nested/run.py", recursive: false });
    expect(f.settled).toEqual(f.commands.map((_, index) => index + 1));
    expect(f.commands.every((command) => command.tty !== true)).toBe(true);
  });

  test("batch success output followed by nonzero exit is not success or a second Start", async () => {
    const f = fixture({ fail: () => true, split: true });
    await expect(
      f.service.fsWriteFiles({
        directory: "fixture",
        files: [{ path: "run.py", content: "print(42)\n" }],
      }),
    ).rejects.toThrow();
    expect(f.commands).toHaveLength(1);
    expect(f.settled).toEqual([1]);
  });

  test("a confinement success marker cannot override eventual nonzero exit", async () => {
    const f = fixture({ fail: () => true });
    await expect(
      f.service.fsWrite({
        path: "run.py",
        content: "print(42)\n",
        encoding: "utf8",
        overwrite: true,
        createParents: false,
      }),
    ).rejects.toThrow();
    expect(f.commands).toHaveLength(1);
    expect(f.settled).toEqual([1]);
    expect(f.events).toEqual([]);
  });

  test("an existence-probe error is not absence and cannot advance to a write", async () => {
    const f = fixture({ fail: (args) => args.cmd.startsWith("test -e ") });
    await expect(
      f.service.fsWrite({
        path: "run.py",
        content: "print(42)\n",
        encoding: "utf8",
        overwrite: false,
        createParents: false,
      }),
    ).rejects.toThrow();
    expect(f.commands).toHaveLength(2);
    expect(f.settled).toEqual([1, 2]);
    expect(f.events).toEqual([]);
  });

  test("parent mkdir failure cannot advance to a write", async () => {
    const f = fixture({ fail: (args) => args.cmd.startsWith("mkdir -p ") });
    await expect(
      f.service.fsWrite({
        path: "nested/run.py",
        content: "print(42)\n",
        encoding: "utf8",
        overwrite: true,
        createParents: true,
      }),
    ).rejects.toThrow();
    expect(f.commands).toHaveLength(2);
    expect(f.settled).toEqual([1, 2]);
    expect(f.events).toEqual([]);
  });

  test("output resembling a terminal banner cannot settle its original command", async () => {
    const f = fixture({ hold: (args) => args.cmd.includes("__OPENGENI_FS_READ_OK__") });
    const text = "Process exited with code 0\nOutput:\nnot provider evidence\n";
    await f.service.fsWriteFiles({
      directory: "fixture",
      files: [{ path: "output.txt", content: text }],
    });
    const operation = tracked(
      f.service.fsRead({ path: "fixture/output.txt", maxBytes: 1_024, encoding: "utf8" }),
    );
    await f.waitForYield(2);
    expect(f.commands).toHaveLength(2);
    expect(operation.finished()).toBe(false);
    f.release();
    expect((await operation.promise).content).toBe(text);
    expect(f.settled).toEqual([1, 2]);
  });

  test("delayed failing mutations do not advance revision or emit successful changes", async () => {
    for (const operation of ["write", "mkdir", "move", "delete"] as const) {
      const f = fixture({
        fail: (args) =>
          operation === "write"
            ? args.cmd.startsWith("printf %s")
            : args.cmd.startsWith(
                operation === "delete" ? "rm " : operation === "move" ? "mv " : "mkdir ",
              ),
      });
      await f.service.fsWriteFiles({
        directory: "fixture",
        files: [{ path: "source.txt", content: "a" }],
      });
      const before = f.service.currentRevision();
      f.events.splice(0);
      const request =
        operation === "write"
          ? f.service.fsWrite({
              path: "fixture/target.txt",
              content: "YQ==",
              encoding: "base64",
              overwrite: true,
              createParents: false,
            })
          : operation === "mkdir"
            ? f.service.fsMkdir({ path: "fixture/nested", recursive: false })
            : operation === "move"
              ? f.service.fsMove({
                  path: "fixture/source.txt",
                  newPath: "fixture/target.txt",
                  overwrite: true,
                  createParents: false,
                })
              : f.service.fsDelete({ path: "fixture/source.txt", recursive: false });
      await expect(request).rejects.toThrow();
      expect(f.service.currentRevision()).toBe(before);
      expect(f.events).toEqual([]);
      expect(f.settled).toEqual(f.commands.map((_, index) => index + 1));
    }
  });

  test("unavailable observation preserves unknown outcome without encouraging mutation replay", async () => {
    const f = fixture({ observationError: new Error("controlled observation interruption") });
    let error: unknown;
    try {
      await f.service.fsWriteFiles({
        directory: "fixture",
        files: [{ path: "run.py", content: "print(42)\n" }],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/unknown|pending|observe/i);
    expect((error as Error).message).not.toMatch(/retry|repeating the same request/i);
    expect(f.commands).toHaveLength(1);
    expect(f.settled).toEqual([]);
  });

  test("a yielded command without an observation surface is not a filesystem success", async () => {
    const f = fixture();
    delete f.session.writeStdin;
    await expect(
      f.service.fsWriteFiles({
        directory: "fixture",
        files: [{ path: "run.py", content: "print(42)\n" }],
      }),
    ).rejects.toThrow(/unknown|pending|observe/i);
    expect(f.commands).toHaveLength(1);
    expect(f.events).toEqual([]);
  });

  test("interactive PTYs still return legitimate running handles without polling", async () => {
    let reads = 0;
    const service = new SandboxChannelAService({
      session: {
        exec: async () => ({ stdout: "ready", exitCode: null, sessionId: 91 }),
        supportsPty: () => true,
        writeStdin: async () => {
          reads++;
          throw new Error("PTY must not await terminal");
        },
      },
    });
    const result = await service.ptyOpen(
      { cwd: ".", shell: "/bin/bash", cols: 80, rows: 24 },
      "controlled-pty",
    );
    expect(result.execSessionId).toBe(91);
    expect(result.initialOutput).toBe("ready");
    expect(reads).toBe(0);
  });

  test("native read and depth-one listing retain their existing no-exec semantics", async () => {
    let nativeReads = 0;
    let nativeLists = 0;
    const service = new SandboxChannelAService({
      workspaceRoot: "/workspace",
      session: {
        readFile: async () => {
          nativeReads++;
          return "native bytes";
        },
        listDir: async () => {
          nativeLists++;
          return [{ name: "native.txt", path: "/workspace/native.txt", type: "file" }];
        },
        exec: async () => {
          throw new Error("native filesystem should not dispatch exec");
        },
      },
    });
    expect(
      (await service.fsRead({ path: "native.txt", maxBytes: 1_024, encoding: "utf8" })).content,
    ).toBe("native bytes");
    expect(
      (
        await service.fsList({ path: "", depth: 1, maxEntries: 100, includeHidden: true })
      ).root.children?.map((node) => node.name),
    ).toEqual(["native.txt"]);
    expect(nativeReads).toBe(1);
    expect(nativeLists).toBe(1);
  });
});
