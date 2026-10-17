import { describe, expect, mock, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Manifest } from "@openai/agents/sandbox";

// The E2B SDK is replaced by a recorder: these tests check what the adapter
// hands the SDK when Opengeni points it at an E2B-compatible API.
type Call = { kind: "create" | "connect"; args: unknown[] };
const calls: Call[] = [];

// Every command a sandbox is asked to run, and how the fake sandbox answers.
type Command = { command: string; options: { user?: string; cwd?: string } };
type Answer = { exitCode: number; stdout: string; stderr: string };
const commands: Command[] = [];
const ok: Answer = { exitCode: 0, stdout: "", stderr: "" };
// By default the workspace root is writable by the default user.
const writable = (call: Command): Answer =>
  call.command.includes("[ -w") ? { ...ok, stdout: "writable\n" } : ok;
let answer: (command: Command) => Answer = writable;

// The E2B SDK throws on a non-zero exit, carrying the command's result.
class CommandExitError extends Error {
  constructor(readonly result: Answer) {
    super(`exit status ${result.exitCode}`);
  }
  get exitCode() {
    return this.result.exitCode;
  }
  get stdout() {
    return this.result.stdout;
  }
  get stderr() {
    return this.result.stderr;
  }
}

class RecordingSandbox {
  // Files written, and what a PTY was typed, in order.
  static readonly written = new Map<string, string>();
  static readonly typed: string[] = [];
  readonly files = {
    makeDir: async () => true,
    write: async (path: string, content: string) => {
      RecordingSandbox.written.set(path, content);
    },
  };
  // One PTY at a time: typing a line into it ends it with exit status 0.
  readonly pty = {
    create: async (options: { onData: (data: Uint8Array) => void }) => {
      let ended = (_: { exitCode: number }) => {};
      const exit = new Promise<{ exitCode: number }>((resolve) => (ended = resolve));
      this.typing = (line) => {
        RecordingSandbox.typed.push(line);
        options.onData(new TextEncoder().encode("done\r\n"));
        ended({ exitCode: 0 });
      };
      return { pid: 7, wait: () => exit, kill: async () => true };
    },
    sendInput: async (_pid: number, data: Uint8Array) => {
      this.typing(new TextDecoder().decode(data));
    },
  };
  private typing: (line: string) => void = () => {};
  readonly commands = {
    run: async (command: string, options: Command["options"] = {}) => {
      const call = { command, options };
      commands.push(call);
      const result = answer(call);
      if (result.exitCode !== 0) {
        throw new CommandExitError(result);
      }
      return result;
    },
  };
  constructor(readonly sandboxId: string) {}
  async kill() {
    return true;
  }
  async pause() {
    return true;
  }
  static async create(...args: unknown[]) {
    calls.push({ kind: "create", args });
    return new RecordingSandbox("sbx-created");
  }
  static async connect(...args: unknown[]) {
    calls.push({ kind: "connect", args });
    return new RecordingSandbox(String(args[0]));
  }
}

mock.module("e2b", () => ({ Sandbox: RecordingSandbox, CommandExitError }));

const { E2BSandboxClient } = await import("@openai/agents-extensions/sandbox/e2b");

const connection = {
  apiKey: "key-1",
  domain: "sandboxes.example.com",
  apiUrl: "https://api.sandboxes.example.com",
};

function takeCalls(): Call[] {
  return calls.splice(0, calls.length);
}

describe("E2B adapter connection options", () => {
  test("create hands the key, domain and API address to the SDK", async () => {
    takeCalls();
    const client = new E2BSandboxClient({ template: "base", timeout: 60, connection });
    const session = await client.create(new Manifest({ root: "/workspace" }));
    const [create] = takeCalls();
    expect(create?.kind).toBe("create");
    expect(create?.args[0]).toBe("base");
    expect(create?.args[1]).toMatchObject({
      apiKey: "key-1",
      domain: "sandboxes.example.com",
      apiUrl: "https://api.sandboxes.example.com",
      timeoutMs: 60_000,
    });
    // An unset field is left to the SDK's own default.
    expect(Object.keys(create?.args[1] as object)).not.toContain("sandboxUrl");

    // The connection, the key above all, never reaches saved session state.
    const saved = JSON.stringify(await client.serializeSessionState(session.state));
    expect(saved).not.toContain("key-1");
    expect(saved).not.toContain("sandboxes.example.com");
  });

  test("exact resume connects with the same connection", async () => {
    takeCalls();
    const client = new E2BSandboxClient({ timeout: 30, connection });
    const created = await client.create(new Manifest({ root: "/workspace" }));
    takeCalls();
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(created.state),
    );
    const resumed = await client.resumeExact(state);
    const [connect] = takeCalls();
    expect(connect?.kind).toBe("connect");
    expect(connect?.args[0]).toBe("sbx-created");
    expect(connect?.args[1]).toMatchObject({
      apiKey: "key-1",
      domain: "sandboxes.example.com",
      apiUrl: "https://api.sandboxes.example.com",
      timeoutMs: 30_000,
    });
    expect(resumed.state.sandboxId).toBe("sbx-created");
  });

  test("without a connection the SDK gets exactly what it got before", async () => {
    takeCalls();
    const client = new E2BSandboxClient({});
    await client.create(new Manifest({ root: "/workspace" }));
    const [create] = takeCalls();
    expect(create?.kind).toBe("create");
    expect(create?.args).toEqual([undefined]);
  });
});

describe("E2B adapter workspace root", () => {
  function takeCommands(): Command[] {
    return commands.splice(0, commands.length);
  }

  test("a root the default user can write needs nothing more", async () => {
    takeCommands();
    answer = writable;
    await new E2BSandboxClient({ connection }).create(new Manifest({ root: "/workspace" }));
    const run = takeCommands();
    expect(run[0]?.options.user).toBeUndefined();
    expect(run.some((call) => call.options.user === "root")).toBe(false);
  });

  test("a root owned by someone else is handed to the default user as root", async () => {
    takeCommands();
    // Unusable until the handover, usable after it.
    let handedOver = false;
    answer = (call) => {
      if (call.options.user === "root") {
        handedOver = true;
        return ok;
      }
      if (call.command.includes("[ -w")) {
        return { ...ok, stdout: handedOver ? "writable\n" : "owner 1000:1000\n" };
      }
      return ok;
    };
    await new E2BSandboxClient({ connection }).create(new Manifest({ root: "/workspace" }));
    const [probe, handover, recheck] = takeCommands();
    expect(probe?.options.user).toBeUndefined();
    expect(handover?.options.user).toBe("root");
    expect(handover?.command).toBe(
      "mkdir -p -- '/workspace' && chown -- 1000:1000 '/workspace' && chmod u+rwx -- '/workspace'",
    );
    // The default user checks again that it can now write and enter it.
    expect(recheck?.options.user).toBeUndefined();
    expect(recheck?.command).toContain("[ -w '/workspace' ] && [ -x '/workspace' ]");
    answer = writable;
  });

  test("a root still unusable after the handover fails the create", async () => {
    takeCommands();
    answer = (call) => {
      if (call.command.includes("[ -w")) {
        return { ...ok, stdout: "owner 1000:1000\n" };
      }
      return ok;
    };
    const client = new E2BSandboxClient({ connection });
    await expect(client.create(new Manifest({ root: "/workspace" }))).rejects.toThrow(
      "the default user still cannot write it after it was handed over",
    );
    answer = writable;
  });

  test("a root that cannot be handed over fails the create with the reason", async () => {
    takeCommands();
    answer = (call) => {
      if (call.command.includes("[ -w")) {
        return { ...ok, stdout: "owner 1000:1000\n" };
      }
      if (call.options.user === "root") {
        return { exitCode: 1, stdout: "", stderr: "chown: Read-only file system" };
      }
      return ok;
    };
    const client = new E2BSandboxClient({ connection });
    await expect(client.create(new Manifest({ root: "/workspace" }))).rejects.toThrow(
      "failed to prepare the workspace root",
    );
    answer = writable;
  });
});

describe("E2B adapter tty commands", () => {
  // Runs a tty command through the adapter, and returns the file it staged
  // and the line it typed into the PTY.
  async function stage(cmd: string): Promise<{ path: string; content: string; typed: string }> {
    RecordingSandbox.written.clear();
    RecordingSandbox.typed.length = 0;
    const session = await new E2BSandboxClient({ connection }).create(
      new Manifest({ root: "/workspace" }),
    );
    const output = await session.execCommand({ cmd, tty: true, yieldTimeMs: 1000 });
    // The fake PTY ended with the command, so its exit status is reported.
    expect(output).toContain("exited with code 0");
    expect(output).toContain("done");
    const staged = [...RecordingSandbox.written].filter(([path]) =>
      /^\/tmp\/agents-pty-[0-9a-f-]{36}\.sh$/.test(path),
    );
    expect(staged).toHaveLength(1);
    expect(RecordingSandbox.typed).toHaveLength(1);
    const [path, content] = staged[0]!;
    return { path, content, typed: RecordingSandbox.typed[0]! };
  }

  test("a command runs from a staged file that replaces the shell", async () => {
    const { path, content, typed } = await stage("echo 'hi there'");
    // E2B's PTY is an interactive bash: the command goes to a file, and the
    // one line typed replaces that bash with a shell running the file.
    expect(content).toBe(`rm -f -- '${path}'\nset -m\n/bin/sh -c 'echo '\\''hi there'\\'''\n`);
    expect(typed).toBe(`exec /bin/sh '${path}'\n`);
  });

  // Types the adapter's line into a real interactive bash in a real PTY, as
  // E2B's PTY does, after waiting for `ready` in its output when given, and
  // optionally pressing Ctrl-C once it appears, and again every 100 ms, as
  // a person would: dash holds a Ctrl-C that lands between two of its
  // commands until the next one ends. Returns how the PTY's process ended,
  // or "still running" after five seconds.
  async function runInPty(
    cmd: string,
    options: { ready?: string; interrupt?: boolean } = {},
  ): Promise<number | "still running"> {
    const { path, content, typed } = await stage(cmd);
    writeFileSync(path, content);
    let output = "";
    let sawReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => (sawReady = resolve));
    const shell = Bun.spawn(["bash", "--noprofile", "--norc", "-i"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "dumb", PS1: "$ " },
      terminal: {
        cols: 200,
        rows: 24,
        data: (_terminal, data) => {
          output += new TextDecoder().decode(data);
          if (options.ready && output.includes(`${options.ready}\r\n`)) {
            sawReady();
          }
        },
      },
    });
    let interrupting: ReturnType<typeof setInterval> | undefined;
    try {
      shell.terminal!.write(typed);
      if (options.ready) {
        await ready;
      }
      if (options.interrupt) {
        const press = () => {
          try {
            shell.terminal!.write("\x03");
          } catch {
            // The PTY has just ended.
          }
        };
        press();
        interrupting = setInterval(press, 100);
      }
      return await Promise.race([
        shell.exited,
        Bun.sleep(5_000).then(() => "still running" as const),
      ]);
    } finally {
      clearInterval(interrupting);
      shell.kill(9);
    }
  }

  const posix = test.skipIf(process.platform === "win32");

  posix(
    "in a real PTY the shell ends with the command's status",
    async () => {
      expect(await runInPty("exit 3")).toBe(3);
      expect(await runInPty("echo hi there")).toBe(0);
    },
    15_000,
  );

  posix(
    "in a real PTY Ctrl-C ends the command and the PTY with it",
    async () => {
      // An interrupted command used to leave bash at its prompt: the PTY
      // never ended, and the command never reported an exit status.
      expect(await runInPty("echo started; sleep 30", { ready: "started", interrupt: true })).toBe(
        130,
      );
      // A command that handles Ctrl-C itself keeps control, and its own
      // status is the one reported.
      expect(
        await runInPty(`sleep 30 & trap 'kill $!; echo caught; exit 4' INT; echo started; wait`, {
          ready: "started",
          interrupt: true,
        }),
      ).toBe(4);
    },
    15_000,
  );

  posix(
    "in a real PTY a process left in the background outlives the PTY",
    async () => {
      const pidFile = `/tmp/agents-pty-test-${globalThis.crypto.randomUUID()}`;
      try {
        expect(await runInPty(`sleep 60 & echo $! > ${pidFile}`)).toBe(0);
        const pid = Number(readFileSync(pidFile, "utf8"));
        // A moment for a hangup sent as the PTY ended to take effect.
        await Bun.sleep(200);
        expect(() => process.kill(pid, 0)).not.toThrow();
        process.kill(pid, "SIGKILL");
      } finally {
        rmSync(pidFile, { force: true });
      }
    },
    15_000,
  );
});
