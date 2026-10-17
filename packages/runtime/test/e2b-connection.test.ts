import { afterEach, describe, expect, mock, test } from "bun:test";
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

// E2B's images run dash as /bin/sh, and so do the real PTYs below where
// dash is installed: how a shell ends after Ctrl-C differs between shells.
const e2bShell = Bun.which("dash") ?? "/bin/sh";

// A PTY as E2B's envd runs one: an interactive bash in a real PTY. Like
// envd, it reports a shell a signal killed as exit code -1, and it ends only
// once nothing holds the PTY any more. On Linux a process the command left
// in the background holds it after the shell exits, while macOS revokes the
// PTY then, so with `held` the end waits for `release` on every platform.
class RealPty {
  static readonly all: RealPty[] = [];
  readonly shell: Bun.Subprocess;
  readonly ended: Promise<void>;
  disconnected = false;
  release: () => void = () => {};
  private closed: () => void = () => {};

  constructor(onData: (data: Uint8Array) => void, held: boolean) {
    const eof = new Promise<void>((resolve) => (this.closed = resolve));
    const released = held ? new Promise<void>((resolve) => (this.release = resolve)) : undefined;
    this.ended = Promise.all([eof, released]).then(() => {});
    this.shell = Bun.spawn(["bash", "--noprofile", "--norc", "-i"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "dumb", PS1: "$ " },
      terminal: {
        cols: 200,
        rows: 24,
        data: (_terminal, data) => {
          if (!this.disconnected) {
            onData(data);
          }
        },
        exit: () => this.closed(),
      },
    });
    RealPty.all.push(this);
  }

  // The SDK's handle: `wait` throws for a status other than 0, as E2B's does.
  handle() {
    return {
      pid: this.shell.pid,
      wait: async () => {
        await this.ended;
        await this.shell.exited;
        const exitCode = this.shell.signalCode ? -1 : (this.shell.exitCode ?? -1);
        if (exitCode !== 0) {
          throw new CommandExitError({ exitCode, stdout: "", stderr: "" });
        }
        return { exitCode, stdout: "", stderr: "" };
      },
      disconnect: async () => {
        this.disconnected = true;
      },
      kill: async () => {
        this.shell.kill(9);
        return true;
      },
    };
  }

  write(data: Uint8Array) {
    this.shell.terminal!.write(data);
  }
}

class RecordingSandbox {
  // Files written, and what a PTY was typed, in order.
  static readonly written = new Map<string, string>();
  static readonly typed: string[] = [];
  // With a real PTY, staged files are written to disk too and PTYs are
  // RealPtys; otherwise typing a line ends the PTY with exit status 0.
  static realPty: { held: boolean } | undefined;
  readonly files = {
    makeDir: async () => true,
    write: async (path: string, content: string) => {
      RecordingSandbox.written.set(path, content);
      if (RecordingSandbox.realPty && path.startsWith("/tmp/agents-pty-")) {
        writeFileSync(path, content.replaceAll("/bin/sh -c ", `${e2bShell} -c `));
      }
    },
  };
  readonly pty = {
    create: async (options: { onData: (data: Uint8Array) => void }) => {
      if (RecordingSandbox.realPty) {
        const pty = new RealPty(options.onData, RecordingSandbox.realPty.held);
        this.typing = (data) => {
          const typed = new TextDecoder().decode(data);
          RecordingSandbox.typed.push(typed);
          pty.write(
            new TextEncoder().encode(typed.replace(/^exec \/bin\/sh /, `exec ${e2bShell} `)),
          );
        };
        return pty.handle();
      }
      let ended = (_: { exitCode: number }) => {};
      const exit = new Promise<{ exitCode: number }>((resolve) => (ended = resolve));
      this.typing = (data) => {
        RecordingSandbox.typed.push(new TextDecoder().decode(data));
        options.onData(new TextEncoder().encode("done\r\n"));
        ended({ exitCode: 0 });
      };
      return { pid: 7, wait: () => exit, kill: async () => true };
    },
    sendInput: async (_pid: number, data: Uint8Array) => {
      this.typing(data);
    },
  };
  private typing: (data: Uint8Array) => void = () => {};
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

describe("E2B adapter tty commands", () => {
  afterEach(() => {
    RecordingSandbox.realPty = undefined;
    for (const pty of RealPty.all.splice(0)) {
      pty.release();
      pty.shell.kill(9);
    }
  });

  async function session() {
    RecordingSandbox.written.clear();
    RecordingSandbox.typed.length = 0;
    return await new E2BSandboxClient({ connection }).create(new Manifest({ root: "/workspace" }));
  }

  // The one file a command was staged in, and the nonce in its marks.
  function staged(): { path: string; content: string; nonce: string } {
    const files = [...RecordingSandbox.written].filter(([path]) =>
      /^\/tmp\/agents-pty-[0-9a-f]{32}\.sh$/.test(path),
    );
    expect(files).toHaveLength(1);
    const [path, content] = files[0]!;
    return { path, content, nonce: path.slice("/tmp/agents-pty-".length, -".sh".length) };
  }

  const exitCode = (response: string) => {
    const match = /Process exited with code (-?\d+)/.exec(response);
    return match ? Number(match[1]) : undefined;
  };
  const sessionId = (response: string) => {
    const match = /Process running with session ID (\d+)/.exec(response);
    return match ? Number(match[1]) : undefined;
  };
  // What a response shows of the command's output.
  const printed = (response: string) => response.slice(response.indexOf("\nOutput:\n") + 9);

  test("a command runs from a staged file that replaces the shell", async () => {
    const sandbox = await session();
    const response = await sandbox.execCommand({
      cmd: "echo 'hi there'",
      tty: true,
      yieldTimeMs: 1000,
    });
    const { path, content, nonce } = staged();
    // E2B's PTY is an interactive bash: the command goes to a file, and the
    // one line typed replaces that bash with a shell running the file, which
    // marks the command's start and reports its status.
    const mark = (what: string) => `printf '\\033]agents-pty;${nonce};${what}\\007'`;
    expect(content).toBe(
      [
        `rm -f -- '${path}'`,
        mark("start"),
        "set -m",
        `trap "${mark("exit;130")}; exit 130" INT`,
        `/bin/sh -c 'echo '\\''hi there'\\'''`,
        "status=$?",
        `${mark("exit;%d")} "$status"`,
        'exit "$status"',
        "",
      ].join("\n"),
    );
    expect(RecordingSandbox.typed).toEqual([`exec /bin/sh '${path}'\n`]);
    // This fake PTY ends with "done" before any mark: what a PTY showed
    // when it ended before the command started is passed on, with E2B's
    // status.
    expect(exitCode(response)).toBe(0);
    expect(printed(response)).toBe("done\r\n");
  });

  const posix = test.skipIf(process.platform === "win32");

  // Runs `cmd` through the adapter in a real PTY. With `interrupt`, presses
  // Ctrl-C once the command printed `started`, and again every 250 ms until
  // it ends, as a person would: dash holds a Ctrl-C that lands between two
  // of its commands until the next one ends. Returns the status reported,
  // or undefined while it still runs, and all the output shown.
  async function run(
    cmd: string,
    options: { held?: boolean; interrupt?: boolean } = {},
  ): Promise<{ exitCode: number | undefined; output: string }> {
    RecordingSandbox.realPty = { held: options.held ?? false };
    const sandbox = await session();
    let response = await sandbox.execCommand({
      cmd,
      tty: true,
      yieldTimeMs: options.interrupt ? 1000 : 5000,
    });
    let output = printed(response);
    if (options.interrupt) {
      expect(output).toContain("started\r\n");
      for (let presses = 0; exitCode(response) === undefined && presses < 20; presses += 1) {
        const id = sessionId(response);
        expect(id).toBeDefined();
        response = await sandbox.writeStdin({ sessionId: id!, chars: "\x03", yieldTimeMs: 250 });
        output += printed(response);
      }
    }
    return { exitCode: exitCode(response), output };
  }

  posix(
    "in a real PTY a command reports its status and shows only its own output",
    async () => {
      expect(await run("exit 3")).toEqual({ exitCode: 3, output: "" });
      // Not bash's prompt, the typed line or the marks.
      expect(await run("echo hi there")).toEqual({ exitCode: 0, output: "hi there\r\n" });
    },
    15_000,
  );

  posix(
    "in a real PTY Ctrl-C ends the command with status 130",
    async () => {
      // The shell dies of the Ctrl-C after its command does, which E2B
      // reports as -1; the shell reports 130 itself instead.
      const interrupted = await run("echo started; sleep 30", { interrupt: true });
      expect(interrupted.exitCode).toBe(130);
      // A command that handles Ctrl-C itself keeps control, and its own
      // status is the one reported.
      const handled = await run(
        `sleep 30 & trap 'kill $!; echo caught; exit 4' INT; echo started; wait`,
        { interrupt: true },
      );
      expect(handled.exitCode).toBe(4);
      expect(handled.output).toContain("caught");
    },
    20_000,
  );

  posix(
    "in a real PTY a process left in the background outlives a command that still ends",
    async () => {
      const pidFile = `/tmp/agents-pty-test-${globalThis.crypto.randomUUID()}`;
      try {
        // The background process holds the PTY, so E2B's process goes on
        // running; the command ends at the status its shell reported.
        expect(await run(`sleep 60 & echo $! > ${pidFile}`, { held: true })).toEqual({
          exitCode: 0,
          output: "",
        });
        const [pty] = RealPty.all;
        const ended = await Promise.race([
          pty!.ended.then(() => true),
          Bun.sleep(100).then(() => false),
        ]);
        expect(ended).toBe(false);
        // The adapter stopped following the PTY, and killed nothing.
        expect(pty!.disconnected).toBe(true);
        const pid = Number(readFileSync(pidFile, "utf8"));
        expect(() => process.kill(pid, 0)).not.toThrow();
        process.kill(pid, "SIGKILL");
      } finally {
        rmSync(pidFile, { force: true });
      }
    },
    15_000,
  );
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
