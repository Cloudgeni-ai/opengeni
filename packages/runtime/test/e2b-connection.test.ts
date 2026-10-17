import { describe, expect, mock, test } from "bun:test";
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
    answer = (call) =>
      call.command.includes("[ -w") ? { ...ok, stdout: "owner 1000:1000\n" } : ok;
    await new E2BSandboxClient({ connection }).create(new Manifest({ root: "/workspace" }));
    const [probe, handover] = takeCommands();
    expect(probe?.options.user).toBeUndefined();
    expect(handover?.options.user).toBe("root");
    expect(handover?.command).toBe("mkdir -p -- '/workspace' && chown -- 1000:1000 '/workspace'");
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
  test("a command runs from a staged file, and the shell exits with it", async () => {
    RecordingSandbox.written.clear();
    RecordingSandbox.typed.length = 0;
    const session = await new E2BSandboxClient({ connection }).create(
      new Manifest({ root: "/workspace" }),
    );
    const output = await session.execCommand({
      cmd: "echo 'hi there'",
      tty: true,
      yieldTimeMs: 1000,
    });

    // E2B's PTY is an interactive bash: the command goes to a file, and the
    // one line typed runs it and leaves the shell with its status.
    const staged = [...RecordingSandbox.written].filter(([path]) =>
      /^\/tmp\/agents-pty-[0-9a-f-]{36}\.sh$/.test(path),
    );
    expect(staged).toHaveLength(1);
    const [path, content] = staged[0]!;
    expect(content).toBe(`rm -f -- '${path}'\nexec /bin/sh -c 'echo '\\''hi there'\\'''\n`);
    expect(RecordingSandbox.typed).toEqual([`/bin/sh '${path}'; exit\n`]);
    // The PTY ended with the command, so its exit status is reported.
    expect(output).toContain("exited with code 0");
    expect(output).toContain("done");
  });
});
