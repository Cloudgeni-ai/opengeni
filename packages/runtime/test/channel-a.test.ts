// P4.4 — Channel-A structured services against a REAL creds-free local box.
//
// The unix_local backend runs in-process (no provider creds, no OpenAI key), so
// these tests exercise the FULL SandboxChannelAService over a real session:
// fsWrite/fsRead round-trip text + binary, fsList returns a coherent tree,
// git status/diff parse into structured hunks, terminal exec streams output. The
// parsers are also unit-tested in isolation (no box) for the porcelain/numstat/
// unified-diff shapes the Pierre diff consumes.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { testSettings } from "@opengeni/testing";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SandboxChannelAService,
  ChannelANotFoundError,
  ChannelAUnavailableError,
  MockAgentResponder,
  SelfhostedSession,
  parsePorcelainV2,
  parseNumstatZ,
  parseUnifiedPatch,
  stripExecBanner,
  parseExecBannerSessionId,
  parseExecBannerExitCode,
  isExecSessionLostBanner,
  type ChannelASession,
} from "../src/sandbox";
import { createSandboxClientForBackend } from "../src/index";

const NUL = String.fromCharCode(0);

async function pendingAfterMicrotasks(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return !settled;
}

// These cases execute real filesystem, Git, and shell processes against a local
// sandbox. Their product-level commands retain tighter operation deadlines, while
// the file-scoped test ceiling leaves enough room for cleanup under a loaded CI
// host instead of canceling a live process at Bun's five-second unit default.
setDefaultTimeout(30_000);

type LiveLocalSession = ChannelASession & {
  closed: boolean;
  state: { workspaceRootPath: string };
  close: () => Promise<void>;
};

const liveSessions: LiveLocalSession[] = [];
const temporaryRoots: string[] = [];
const originalAgentsPython = process.env.OPENAI_AGENTS_PYTHON;

beforeAll(() => {
  if (originalAgentsPython !== undefined) return;
  const python = Bun.which("python3");
  if (python === null) {
    throw new Error("real local sandbox tests require a Python 3 executable");
  }
  // The local sandbox intentionally supplies a minimal child PATH. Give the
  // Agents SDK's host-side PTY bridge the absolute interpreter selected from
  // the test runner's PATH so these tests are portable to Nix hosts as well.
  process.env.OPENAI_AGENTS_PYTHON = python;
});

afterAll(() => {
  if (originalAgentsPython === undefined) delete process.env.OPENAI_AGENTS_PYTHON;
  else process.env.OPENAI_AGENTS_PYTHON = originalAgentsPython;
});

async function makeBox(): Promise<{ session: LiveLocalSession; root: string }> {
  const settings = testSettings({ sandboxBackend: "local", webSearchEnabled: false });
  const client = createSandboxClientForBackend("local", settings) as unknown as {
    backendId: string;
    create: (m?: unknown) => Promise<LiveLocalSession>;
  };
  expect(client.backendId).toBe("unix_local");
  const session = await client.create({});
  liveSessions.push(session);
  return { session, root: session.state.workspaceRootPath };
}

afterEach(async () => {
  for (const s of liveSessions.splice(0)) {
    if (!s.closed) await s.close().catch(() => undefined);
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runFixtureCommand(root: string, command: string): void {
  const result = Bun.spawnSync(["/bin/bash", "-c", command], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `fixture command failed (${result.exitCode}): ${Buffer.from(result.stderr).toString("utf8")}`,
    );
  }
}

function requireHostExecutable(name: string): string {
  const executable = Bun.which(name);
  if (executable === null) {
    throw new Error(`Channel-A test requires ${name} on PATH`);
  }
  return executable;
}

function writeInvalidBytePath(path: Buffer, content: string): void {
  const python = requireHostExecutable("python3");
  const result = Bun.spawnSync(
    [
      python,
      "-c",
      "import base64, os, sys; p=base64.b64decode(sys.argv[1]); data=base64.b64decode(sys.argv[2]); fd=os.open(p, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o644); os.write(fd, data); os.close(fd)",
      path.toString("base64"),
      Buffer.from(content).toString("base64"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`invalid-byte fixture write failed: ${Buffer.from(result.stderr).toString()}`);
  }
}

function makeModalLikeExecOnlySession(
  root: string,
  options: {
    pathPrefix?: string;
    beforeExec?: (
      args: Parameters<NonNullable<ChannelASession["execCommand"]>>[0],
    ) => void | Promise<void>;
    env?: Record<string, string>;
  } = {},
): {
  session: ChannelASession;
  truncatedResponses: () => number;
} {
  const retainedOutputChars = 1024 * 1024;
  let truncated = 0;
  return {
    session: {
      execCommand: async (args) => {
        await options.beforeExec?.(args);
        const child = Bun.spawn(["/bin/bash", "-c", args.cmd], {
          cwd: args.workdir ?? root,
          env: {
            ...process.env,
            ...options.env,
            // The production Modal image is Ubuntu/GNU. Keep this host-side
            // adapter faithful when the test runs on macOS/BSD.
            PATH: [
              options.pathPrefix,
              "/opt/homebrew/opt/coreutils/libexec/gnubin",
              process.env.PATH ?? "",
            ]
              .filter(Boolean)
              .join(":"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        let output = [stdout, stderr]
          .filter((value) => value.length > 0)
          .map((value) => value.trimEnd())
          .join("\n");
        output += "\nmodal-like provider trailer";
        if (output.length > retainedOutputChars) {
          truncated += 1;
          const dropped = output.length - retainedOutputChars;
          output = `[...${dropped} characters truncated from process output...]\n${output.slice(
            -retainedOutputChars,
          )}`;
        }
        return [
          "Chunk ID: modal-like",
          "Wall time: 0.0000 seconds",
          `Process exited with code ${exitCode}`,
          "Output:",
          output,
        ].join("\n");
      },
    },
    truncatedResponses: () => truncated,
  };
}

function makeStockMacCommandSurface(root: string): { bin: string; log: string } {
  const bin = join(root, "stock-macos-bin");
  const log = join(root, "stock-macos-commands.log");
  mkdirSync(bin);
  const realStat = Bun.which("stat");
  const realReadlink = Bun.which("readlink");
  const realShasum = Bun.which("shasum");
  const realLsof = Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : null);
  if (!realStat || !realReadlink || !realShasum || !realLsof) {
    throw new Error("stock-macOS simulation requires host stat, readlink, shasum, and lsof");
  }
  const writeCommand = (name: string, body: string): void => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };
  writeCommand(
    "sha256sum",
    ["printf 'sha256sum\\n' >> \"$OPENGENI_STOCK_MAC_LOG\"", "exit 127"].join("\n"),
  );
  writeCommand(
    "shasum",
    [
      "printf 'shasum\\n' >> \"$OPENGENI_STOCK_MAC_LOG\"",
      `exec ${JSON.stringify(realShasum)} "$@"`,
    ].join("\n"),
  );
  writeCommand(
    "readlink",
    [
      'printf \'readlink %s\\n\' "$*" >> "$OPENGENI_STOCK_MAC_LOG"',
      'if [ "${1:-}" = "-f" ]; then exit 1; fi',
      `exec ${JSON.stringify(realReadlink)} "$@"`,
    ].join("\n"),
  );
  writeCommand(
    "stat",
    [
      'printf \'stat %s\\n\' "$*" >> "$OPENGENI_STOCK_MAC_LOG"',
      'if [ "${1:-}" = "-Lc" ] || [ "${1:-}" = "-c" ]; then exit 1; fi',
      'if [ "${1:-}" != "-f" ] || [ "$#" -ne 3 ]; then exit 64; fi',
      'case "$2" in',
      `  %i) exec ${JSON.stringify(realStat)} -L -c '%i' "$3" ;;`,
      `  %z) exec ${JSON.stringify(realStat)} -L -c '%s' "$3" ;;`,
      `  %Lp) exec ${JSON.stringify(realStat)} -L -c '%a' "$3" ;;`,
      "  *) exit 64 ;;",
      "esac",
    ].join("\n"),
  );
  writeCommand(
    "lsof",
    [
      'printf \'lsof %s\\n\' "$*" >> "$OPENGENI_STOCK_MAC_LOG"',
      "pid= fd=",
      'while [ "$#" -gt 0 ]; do case "$1" in -p) pid="$2"; shift 2 ;; -d) fd="$2"; shift 2 ;; *) shift ;; esac; done',
      '[ -n "$pid" ] && [ -n "$fd" ] || exit 64',
      // Linux lsof inserts an extra newline before its n<path> field; stock
      // macOS does not. Normalize the host output so this fixture genuinely
      // exercises the macOS parser on every CI host.
      "set -o pipefail",
      `${JSON.stringify(realLsof)} -a -p "$pid" -d "$fd" -Fn0 | tr -d '\\n'`,
    ].join("\n"),
  );
  return { bin, log };
}

function framedConfinedOutput(command: string, payload = "", status = 0, prelude = ""): string {
  const frame = /__OPENGENI_FS_CONFINED_([a-f0-9]{32})_OK__/.exec(command)?.[1];
  if (!frame) throw new Error("confined command did not contain a frame nonce");
  return `${prelude}__OPENGENI_FS_CONFINED_${frame}_OK__\n${payload}__OPENGENI_FS_CONFINED_${frame}_END__:${status}__`;
}

describe("P4.4 SandboxChannelAService — FileSystem (real local box)", () => {
  test("write then read-back round-trips text", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });

    const write = await svc.fsWrite({
      path: "hello.txt",
      encoding: "utf8",
      content: "hello channel-a\n",
      overwrite: true,
      createParents: true,
    });
    expect(write.path).toBe("hello.txt");
    expect(write.sizeBytes).toBe("hello channel-a\n".length);
    expect(write.revision).toBe(1);

    const read = await svc.fsRead({ path: "hello.txt", encoding: "utf8", maxBytes: 1024 });
    expect(read.encoding).toBe("utf8");
    expect(read.content).toBe("hello channel-a\n");
    expect(read.isBinary).toBe(false);
    expect(read.truncated).toBe(false);
  });

  test("write then read-back round-trips a BINARY file (base64)", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    // A few bytes including a NUL — the binary sniff must catch it.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
    const b64 = bytes.toString("base64");

    await svc.fsWrite({
      path: "blob.bin",
      encoding: "base64",
      content: b64,
      overwrite: true,
      createParents: true,
    });

    const read = await svc.fsRead({ path: "blob.bin", encoding: "base64", maxBytes: 1024 });
    expect(read.encoding).toBe("base64");
    expect(read.isBinary).toBe(true);
    expect(Buffer.from(read.content, "base64").equals(bytes)).toBe(true);
  });

  test("a utf8 read of a binary file auto-detects + returns base64", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    await svc.fsWrite({
      path: "raw.dat",
      encoding: "base64",
      content: bytes.toString("base64"),
      overwrite: true,
      createParents: true,
    });
    const read = await svc.fsRead({ path: "raw.dat", encoding: "utf8", maxBytes: 1024 });
    expect(read.isBinary).toBe(true);
    expect(read.encoding).toBe("base64"); // forced to base64 despite the utf8 request
  });

  test("a transient native read failure recovers through the confined descriptor path", async () => {
    const commands: string[] = [];
    const svc = new SandboxChannelAService({
      session: {
        readFile: async () => {
          throw new Error("provider read endpoint temporarily unavailable");
        },
        exec: async (args) => {
          commands.push(args.cmd);
          return {
            stdout: `__OPENGENI_FS_READ_OK__\n${Buffer.from("recovered\n").toString("base64")}`,
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    const read = await svc.fsRead({ path: "file.txt", encoding: "utf8", maxBytes: 1_024 });
    expect(read.content).toBe("recovered\n");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.startsWith("env -u BASH_ENV bash --noprofile --norc -c ")).toBe(true);
  });

  test("a repeated native and confined read failure is unavailable, never a false 404", async () => {
    const svc = new SandboxChannelAService({
      session: {
        readFile: async () => {
          throw new Error("provider read endpoint temporarily unavailable");
        },
        exec: async () => {
          throw new Error("provider exec endpoint temporarily unavailable");
        },
      },
    });

    await expect(
      svc.fsRead({ path: "file.txt", encoding: "utf8", maxBytes: 1_024 }),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
  });

  test("a structured native ENOENT remains a definite file miss", async () => {
    const svc = new SandboxChannelAService({
      session: {
        readFile: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      },
    });

    await expect(
      svc.fsRead({ path: "missing.txt", encoding: "utf8", maxBytes: 1_024 }),
    ).rejects.toBeInstanceOf(ChannelANotFoundError);
  });

  test("fsList returns a coherent tree of a known directory", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    await svc.fsWrite({
      path: "src/a.ts",
      encoding: "utf8",
      content: "export const a = 1;\n",
      overwrite: true,
      createParents: true,
    });
    await svc.fsWrite({
      path: "src/b.ts",
      encoding: "utf8",
      content: "export const b = 2;\n",
      overwrite: true,
      createParents: true,
    });
    await svc.fsWrite({
      path: "README.md",
      encoding: "utf8",
      content: "# hi\n",
      overwrite: true,
      createParents: true,
    });

    const list = await svc.fsList({ path: "", depth: 3, maxEntries: 1000, includeHidden: true });
    expect(list.root.type).toBe("dir");
    // collect all node paths
    const paths: string[] = [];
    const walk = (n: typeof list.root): void => {
      paths.push(n.path);
      n.children?.forEach(walk);
    };
    walk(list.root);
    expect(paths).toContain("src");
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
    expect(paths).toContain("README.md");
    // a.ts is a file with a non-null size; src is a dir with null size + children
    const findNode = (path: string): typeof list.root | undefined => {
      let found: typeof list.root | undefined;
      const rec = (n: typeof list.root): void => {
        if (n.path === path) found = n;
        n.children?.forEach(rec);
      };
      rec(list.root);
      return found;
    };
    const aNode = findNode("src/a.ts");
    expect(aNode?.type).toBe("file");
    expect(typeof aNode?.sizeBytes).toBe("number");
    const srcNode = findNode("src");
    expect(srcNode?.type).toBe("dir");
    expect(Array.isArray(srcNode?.children)).toBe(true);
  });

  test("fsListPruned emits residue directories but skips their descendants in one tree query", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    const made = await svc.terminalExec({
      command: [
        "mkdir -p node_modules/pkg src/node_modules/nested src/deep",
        "printf residue > node_modules/pkg/index.js",
        "printf nested > src/node_modules/nested/index.js",
        "printf authored > src/deep/keep.ts",
      ].join(" && "),
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    expect(made.exitCode).toBe(0);

    const list = await svc.fsListPruned(
      { path: "", depth: 20, maxEntries: 1_000, includeHidden: true },
      ["node_modules"],
    );
    const paths: string[] = [];
    const walk = (node: typeof list.root): void => {
      paths.push(node.path);
      node.children?.forEach(walk);
    };
    walk(list.root);

    expect(paths).toContain("node_modules");
    expect(paths).toContain("src/node_modules");
    expect(paths).toContain("src/deep/keep.ts");
    expect(paths).not.toContain("node_modules/pkg");
    expect(paths).not.toContain("src/node_modules/nested");
  });

  test("fsListPruned portable macOS/BSD branch preserves depth, hidden, and prune semantics", async () => {
    const { session } = await makeBox();
    const made = await new SandboxChannelAService({ session }).terminalExec({
      command: [
        "mkdir -p src/deep node_modules/pkg .hidden",
        "printf visible > src/keep.ts",
        "printf deep > src/deep/too-deep.ts",
        "printf residue > node_modules/pkg/index.js",
        "printf secret > .hidden/secret.txt",
      ].join(" && "),
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    expect(made.exitCode).toBe(0);

    const originalExec = session.exec?.bind(session);
    if (!originalExec) throw new Error("local test session has no exec surface");
    let portableBranchObserved = false;
    session.exec = async (args) => {
      const capabilityProbe =
        "if find --version >/dev/null 2>&1 && head -z -n 0 </dev/null >/dev/null 2>&1; then";
      if (args.cmd.includes(capabilityProbe)) {
        portableBranchObserved = true;
        args = { ...args, cmd: args.cmd.replace(capabilityProbe, "if false; then") };
      }
      return await originalExec(args);
    };

    const list = await new SandboxChannelAService({ session }).fsListPruned(
      { path: "", depth: 2, maxEntries: 1_000, includeHidden: false },
      ["node_modules"],
    );
    const paths: string[] = [];
    const walk = (node: typeof list.root): void => {
      paths.push(node.path);
      node.children?.forEach(walk);
    };
    walk(list.root);

    expect(portableBranchObserved).toBe(true);
    expect(paths).toContain("src/keep.ts");
    expect(paths).toContain("src/deep");
    expect(paths).toContain("node_modules");
    expect(paths).not.toContain("src/deep/too-deep.ts");
    expect(paths).not.toContain("node_modules/pkg");
    expect(paths).not.toContain(".hidden");
  });

  test("fsListPruned indexes a production-sized tree in one provider exec", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    const made = await svc.terminalExec({
      command:
        'mkdir -p src; for d in $(seq 1 150); do mkdir -p "src/d$d"; for f in $(seq 1 29); do : > "src/d$d/f$f.ts"; done; done',
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    expect(made.exitCode).toBe(0);

    const originalExec = session.exec?.bind(session);
    if (!originalExec) throw new Error("local test session has no exec surface");
    let providerExecs = 0;
    session.exec = async (args) => {
      providerExecs += 1;
      return await originalExec(args);
    };

    const startedAt = performance.now();
    const list = await svc.fsListPruned(
      { path: "", depth: 20, maxEntries: 10_000, includeHidden: true },
      ["node_modules"],
    );
    const durationMs = performance.now() - startedAt;
    let entryCount = 0;
    const walk = (node: typeof list.root): void => {
      for (const child of node.children ?? []) {
        entryCount += 1;
        walk(child);
      }
    };
    walk(list.root);

    expect(providerExecs).toBe(1);
    expect(entryCount).toBe(4_501);
    expect(list.truncated).toBe(false);
    // A generous local-host guard catches accidental per-directory traversal
    // without coupling CI to Modal network latency (the deployed gate owns that).
    expect(durationMs).toBeLessThan(5_000);
  });

  test("fsListPruned rejects non-literal prune patterns before executing the box", async () => {
    let executed = false;
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => {
          executed = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    });

    await expect(
      svc.fsListPruned({ path: "", depth: 1, maxEntries: 10, includeHidden: true }, [
        "../node_modules",
        "*",
      ]),
    ).rejects.toThrow(/invalid directory prune name/);
    expect(executed).toBe(false);
  });

  test("fsListPruned reports transport byte truncation without orphaning child nodes", async () => {
    const recordDelimiter = String.fromCharCode(0);
    let command = "";
    const svc = new SandboxChannelAService({
      session: {
        exec: async (args) => {
          command = args.cmd;
          return {
            stdout: framedConfinedOutput(
              args.cmd,
              [
                `d\t0\t1.0\t755\t./src${recordDelimiter}`,
                `f\t1\t1.0\t644\t./src/a.ts${recordDelimiter}`,
                `__OPENGENI_FS_LIST_TRUNCATED__${recordDelimiter}`,
              ].join(""),
            ),
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    const list = await svc.fsListPruned(
      { path: "", depth: 8, maxEntries: 10, includeHidden: true },
      ["node_modules"],
    );

    expect(list.truncated).toBe(true);
    expect(list.root.children?.[0]?.path).toBe("src");
    expect(list.root.children?.[0]?.children?.[0]?.path).toBe("src/a.ts");
    expect(command).toContain("__OPENGENI_FS_LIST_TRUNCATED__");
  });

  test("fsListPruned fails closed when the provider command is still running", async () => {
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({
          stdout: "__OPENGENI_FS_CONFINED_OK__\n",
          stderr: "",
          exitCode: null,
          sessionId: 17,
        }),
      },
    });

    await expect(
      svc.fsListPruned({ path: "", depth: 8, maxEntries: 10, includeHidden: true }, [
        "node_modules",
      ]),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
  });

  test("fsList retries one completed transient probe and uses a profile-free control shell", async () => {
    const commands: string[] = [];
    const svc = new SandboxChannelAService({
      session: {
        exec: async (args) => {
          commands.push(args.cmd);
          if (commands.length === 1) {
            return { stdout: "provider temporarily unavailable", stderr: "", exitCode: 1 };
          }
          return { stdout: framedConfinedOutput(args.cmd), stderr: "", exitCode: 0 };
        },
      },
    });

    const list = await svc.fsList({ path: "", depth: 1, maxEntries: 10, includeHidden: true });
    expect(list.root.children).toEqual([]);
    expect(commands).toHaveLength(2);
    expect(
      new Set(
        commands.map((command) => /__OPENGENI_FS_CONFINED_([a-f0-9]{32})_OK__/.exec(command)?.[1]),
      ).size,
    ).toBe(2);
    for (const command of commands) {
      expect(command.startsWith("env -u BASH_ENV bash --noprofile --norc -c ")).toBe(true);
      expect(command).not.toContain("bash -lc");
    }
  });

  test("fsList accepts a trusted success record after provider prelude output", async () => {
    let calls = 0;
    const svc = new SandboxChannelAService({
      session: {
        exec: async (args) => {
          calls += 1;
          return {
            stdout: framedConfinedOutput(args.cmd, "", 0, "provider prelude\n"),
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    const list = await svc.fsList({ path: ".", depth: 1, maxEntries: 10, includeHidden: true });
    expect(list.root.children).toEqual([]);
    expect(calls).toBe(1);
  });

  test("fsList rejects truncated or malformed confined end frames", async () => {
    for (const corrupt of [
      (frame: string) => frame.slice(0, -2),
      (frame: string) => frame.replace(/:0__$/, ":256__"),
    ]) {
      const svc = new SandboxChannelAService({
        session: {
          exec: async (args) => ({
            stdout: corrupt(framedConfinedOutput(args.cmd)),
            stderr: "",
            exitCode: 0,
          }),
        },
      });
      await expect(
        svc.fsList({ path: ".", depth: 1, maxEntries: 10, includeHidden: true }),
      ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    }
  });

  test("fsList classifies repeated unmarked provider results as unavailable, never bad input", async () => {
    let calls = 0;
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => {
          calls += 1;
          return { stdout: "", stderr: "provider unavailable", exitCode: 1 };
        },
      },
    });

    await expect(
      svc.fsList({ path: ".", depth: 1, maxEntries: 10, includeHidden: true }),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    expect(calls).toBe(2);
  });

  test("deterministic confinement sentinels remain typed through surrounding provider output", async () => {
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({
          stdout: "provider prelude\n__OPENGENI_FS_NOT_FOUND__\n",
          stderr: "",
          exitCode: 66,
        }),
      },
    });

    await expect(
      svc.fsList({ path: "missing", depth: 1, maxEntries: 10, includeHidden: true }),
    ).rejects.toBeInstanceOf(ChannelANotFoundError);
  });

  test("write with overwrite:false on an existing path throws conflict", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    await svc.fsWrite({
      path: "x.txt",
      encoding: "utf8",
      content: "first",
      overwrite: true,
      createParents: true,
    });
    await expect(
      svc.fsWrite({
        path: "x.txt",
        encoding: "utf8",
        content: "second",
        overwrite: false,
        createParents: true,
      }),
    ).rejects.toThrow(/exists/);
  });

  test("path traversal is rejected with a validation error", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    await expect(svc.fsRead({ path: "../escape", encoding: "utf8", maxBytes: 16 })).rejects.toThrow(
      /traversal/,
    );
    await expect(
      svc.fsRead({ path: "/etc/passwd", encoding: "utf8", maxBytes: 16 }),
    ).rejects.toThrow(/absolute/);
    await expect(
      svc.fsList({ path: "../escape", depth: 1, maxEntries: 10, includeHidden: true }),
    ).rejects.toThrow(/traversal/);
    await expect(svc.gitStatus({ path: "../escape" })).rejects.toThrow(/traversal/);
  });

  test("reads an internal symlink but rejects an escaping symlink", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    const outside = `/tmp/opengeni-channel-a-${crypto.randomUUID()}.txt`;
    const outsideDir = `/tmp/opengeni-channel-a-${crypto.randomUUID()}`;
    const created = await svc.terminalExec({
      command: [
        "printf 'inside content' > internal.txt",
        "ln -s internal.txt internal-link.txt",
        `printf 'outside secret' > '${outside}'`,
        `ln -s '${outside}' external-link.txt`,
        `mkdir -p '${outsideDir}'`,
        `ln -s '${outsideDir}' external-dir`,
      ].join(" && "),
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    expect(created.exitCode).toBe(0);

    const internal = await svc.fsRead({
      path: "internal-link.txt",
      encoding: "utf8",
      maxBytes: 1_024,
    });
    expect(internal.content).toBe("inside content");
    await expect(
      svc.fsRead({ path: "external-link.txt", encoding: "utf8", maxBytes: 1_024 }),
    ).rejects.toThrow(/outside workspace/);

    const execOnly = new SandboxChannelAService({
      session: { exec: session.exec!.bind(session) },
    });
    expect(
      (
        await execOnly.fsRead({
          path: "internal-link.txt",
          encoding: "utf8",
          maxBytes: 1_024,
        })
      ).content,
    ).toBe("inside content");
    await expect(
      execOnly.fsRead({ path: "external-link.txt", encoding: "utf8", maxBytes: 1_024 }),
    ).rejects.toThrow(/outside workspace/);
    await expect(
      svc.fsWrite({
        path: "external-link.txt",
        encoding: "utf8",
        content: "overwrite attempt",
        overwrite: true,
        createParents: false,
      }),
    ).rejects.toThrow(/symbolic link/);
    await expect(
      svc.fsWrite({
        path: "external-dir/new.txt",
        encoding: "utf8",
        content: "escape attempt",
        overwrite: true,
        createParents: true,
      }),
    ).rejects.toThrow(/outside workspace/);
    await expect(svc.fsMkdir({ path: "external-dir/nested", recursive: true })).rejects.toThrow(
      /outside workspace/,
    );
    await expect(
      svc.fsMove({
        path: "internal.txt",
        newPath: "external-dir/moved.txt",
        overwrite: true,
        createParents: true,
      }),
    ).rejects.toThrow(/outside workspace/);
    await expect(
      svc.fsList({ path: "external-dir", depth: 1, maxEntries: 10, includeHidden: true }),
    ).rejects.toThrow(/symbolic link/);
    await expect(svc.gitStatus({ path: "external-dir" })).rejects.toThrow(/symbolic link/);

    const outsideAfter = await svc.terminalExec({
      command: `printf '%s|' "$(cat '${outside}')"; test ! -e '${outsideDir}/new.txt'; test ! -e '${outsideDir}/moved.txt'`,
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    expect(outsideAfter.exitCode).toBe(0);
    expect(outsideAfter.stdout).toBe("outside secret|");

    const tree = await svc.fsList({ path: "", depth: 1, maxEntries: 100, includeHidden: true });
    expect(tree.root.children?.find((node) => node.path === "internal-link.txt")?.type).toBe(
      "symlink",
    );
    expect(tree.root.children?.find((node) => node.path === "external-link.txt")?.type).toBe(
      "symlink",
    );
    await svc.terminalExec({
      command: `rm -f '${outside}'; rmdir '${outsideDir}'`,
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
  });

  test("fsWrite emits an fs.changed notification through the emitter", async () => {
    const { session } = await makeBox();
    const emitted: { type: string; payload: unknown }[] = [];
    const svc = new SandboxChannelAService({
      session,
      leaseEpoch: 7,
      emit: async (events) => {
        emitted.push(...events);
      },
    });
    await svc.fsWrite({
      path: "noted.txt",
      encoding: "utf8",
      content: "hi",
      overwrite: true,
      createParents: true,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe("fs.changed");
    const payload = emitted[0]!.payload as {
      changes: { path: string; kind: string }[];
      revision: number;
      leaseEpoch: number;
    };
    expect(payload.changes[0]!.path).toBe("noted.txt");
    expect(payload.changes[0]!.kind).toBe("modified");
    expect(payload.revision).toBe(1);
    expect(payload.leaseEpoch).toBe(7);
  });

  test("fsMove renames a file and read-back follows the new path", async () => {
    const { session } = await makeBox();
    const emitted: { type: string; payload: unknown }[] = [];
    const svc = new SandboxChannelAService({
      session,
      emit: async (e) => {
        emitted.push(...e);
      },
    });
    await svc.fsWrite({
      path: "old.txt",
      encoding: "utf8",
      content: "move me\n",
      overwrite: true,
      createParents: true,
    });

    const moved = await svc.fsMove({
      path: "old.txt",
      newPath: "new.txt",
      overwrite: false,
      createParents: true,
    });
    expect(moved.path).toBe("old.txt");
    expect(moved.newPath).toBe("new.txt");
    expect(moved.revision).toBe(2);

    const read = await svc.fsRead({ path: "new.txt", encoding: "utf8", maxBytes: 64 });
    expect(read.content).toBe("move me\n");
    await expect(svc.fsRead({ path: "old.txt", encoding: "utf8", maxBytes: 64 })).rejects.toThrow();

    // emits a deleted(old) + created(new) pair on the move.
    const moveEvent = emitted.find((e) =>
      (e.payload as { changes: { path: string }[] }).changes.some((c) => c.path === "new.txt"),
    );
    const changes = (moveEvent!.payload as { changes: { path: string; kind: string }[] }).changes;
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "old.txt", kind: "deleted" }),
        expect.objectContaining({ path: "new.txt", kind: "created" }),
      ]),
    );
  });

  test("fsMove with overwrite:false onto an existing destination throws conflict", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    await svc.fsWrite({
      path: "a.txt",
      encoding: "utf8",
      content: "a",
      overwrite: true,
      createParents: true,
    });
    await svc.fsWrite({
      path: "b.txt",
      encoding: "utf8",
      content: "b",
      overwrite: true,
      createParents: true,
    });
    await expect(
      svc.fsMove({ path: "a.txt", newPath: "b.txt", overwrite: false, createParents: true }),
    ).rejects.toThrow(/exists/);
  });

  test("fsMove with createParents builds missing destination dirs", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    await svc.fsWrite({
      path: "src.txt",
      encoding: "utf8",
      content: "x",
      overwrite: true,
      createParents: true,
    });
    await svc.fsMove({
      path: "src.txt",
      newPath: "deep/nested/dst.txt",
      overwrite: false,
      createParents: true,
    });
    const read = await svc.fsRead({ path: "deep/nested/dst.txt", encoding: "utf8", maxBytes: 16 });
    expect(read.content).toBe("x");
  });

  test("fsMove rejects path traversal on either side", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    await expect(
      svc.fsMove({ path: "../escape", newPath: "x.txt", overwrite: false, createParents: true }),
    ).rejects.toThrow(/traversal/);
    await expect(
      svc.fsMove({ path: "x.txt", newPath: "/abs", overwrite: false, createParents: true }),
    ).rejects.toThrow(/absolute/);
  });

  test("fsMkdir -p creates a nested directory and emits a created(dir) change", async () => {
    const { session } = await makeBox();
    const emitted: { type: string; payload: unknown }[] = [];
    const svc = new SandboxChannelAService({
      session,
      emit: async (e) => {
        emitted.push(...e);
      },
    });

    const made = await svc.fsMkdir({ path: "fresh/dir", recursive: true });
    expect(made.path).toBe("fresh/dir");
    expect(made.revision).toBe(1);

    const list = await svc.fsList({ path: "", depth: 3, maxEntries: 1000, includeHidden: true });
    const paths: string[] = [];
    const walk = (n: typeof list.root): void => {
      paths.push(n.path);
      n.children?.forEach(walk);
    };
    walk(list.root);
    expect(paths).toContain("fresh/dir");

    const evt = emitted.find((e) => e.type === "fs.changed")!;
    const change = (evt.payload as { changes: { path: string; kind: string; isDir: boolean }[] })
      .changes[0]!;
    expect(change).toMatchObject({ path: "fresh/dir", kind: "created", isDir: true });
  });

  test("fsMkdir recursive:false on an existing path throws validation", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    await svc.fsMkdir({ path: "once", recursive: false });
    await expect(svc.fsMkdir({ path: "once", recursive: false })).rejects.toThrow();
  });
});

describe("P4.4 SandboxChannelAService — Git (real local box)", () => {
  async function makeRepoWithStagedChange(): Promise<{
    svc: SandboxChannelAService;
    session: LiveLocalSession;
  }> {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    // init a repo, commit a baseline, then make a staged change.
    await svc.terminalExec({
      command:
        "git init -q && git config user.email t@t.io && git config user.name t && git config commit.gpgsign false",
      cwd: "",
      timeoutMs: 20000,
      emitStream: false,
    });
    await svc.fsWrite({
      path: "file.txt",
      encoding: "utf8",
      content: "line one\nline two\nline three\n",
      overwrite: true,
      createParents: true,
    });
    await svc.terminalExec({
      command: "git add file.txt && git commit -q -m baseline",
      cwd: "",
      timeoutMs: 20000,
      emitStream: false,
    });
    // modify + stage
    await svc.fsWrite({
      path: "file.txt",
      encoding: "utf8",
      content: "line one\nline two changed\nline three\nline four\n",
      overwrite: true,
      createParents: true,
    });
    await svc.terminalExec({
      command: "git add file.txt",
      cwd: "",
      timeoutMs: 20000,
      emitStream: false,
    });
    return { svc, session };
  }

  test("git status on a repo with a staged change reports the file", async () => {
    const { svc } = await makeRepoWithStagedChange();
    const status = await svc.gitStatus({ path: "" });
    expect(status.isRepo).toBe(true);
    expect(status.files.length).toBeGreaterThanOrEqual(1);
    const file = status.files.find((f) => f.path === "file.txt");
    expect(file).toBeDefined();
    expect(file!.index).toBe("modified"); // staged
  });

  test("confinement control records cannot collide with legitimate payload output", async () => {
    const { svc } = await makeRepoWithStagedChange();
    for (const path of [
      "__OPENGENI_FS_NOT_FOUND__",
      "__OPENGENI_FS_ESCAPE__",
      "__OPENGENI_FS_SYMLINK__",
      "__OPENGENI_FS_CONFINED_OK__",
      "__OPENGENI_FS_CONFINED_END__:0__",
    ]) {
      await svc.fsWrite({
        path,
        encoding: "utf8",
        content: `${path}\n`,
        overwrite: true,
        createParents: true,
      });
    }

    const list = await svc.fsList({
      path: "",
      depth: 1,
      maxEntries: 100,
      includeHidden: true,
    });
    expect(list.root.children?.map((node) => node.path)).toEqual(
      expect.arrayContaining([
        "__OPENGENI_FS_NOT_FOUND__",
        "__OPENGENI_FS_ESCAPE__",
        "__OPENGENI_FS_SYMLINK__",
        "__OPENGENI_FS_CONFINED_OK__",
        "__OPENGENI_FS_CONFINED_END__:0__",
      ]),
    );

    const status = await svc.gitStatus({ path: "" });
    expect(status.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "__OPENGENI_FS_NOT_FOUND__",
        "__OPENGENI_FS_ESCAPE__",
        "__OPENGENI_FS_SYMLINK__",
        "__OPENGENI_FS_CONFINED_OK__",
        "__OPENGENI_FS_CONFINED_END__:0__",
      ]),
    );
  });

  test("git diff --staged parses into structured hunks (the Pierre feed)", async () => {
    const { svc } = await makeRepoWithStagedChange();
    const diff = await svc.gitDiff({
      path: "",
      staged: true,
      includeUntracked: false,
      pathspec: [],
      contextLines: 3,
      maxBytesPerFile: 512 * 1024,
    });
    expect(diff.files.length).toBe(1);
    const f = diff.files[0]!;
    expect(f.path).toBe("file.txt");
    expect(f.isBinary).toBe(false);
    expect(f.additions).toBeGreaterThan(0);
    expect(f.hunks.length).toBeGreaterThanOrEqual(1);
    const hunk = f.hunks[0]!;
    // the hunk carries typed add/del/context lines with gutter line numbers
    expect(hunk.lines.some((l) => l.type === "add" && l.newNo !== null && l.oldNo === null)).toBe(
      true,
    );
    expect(hunk.lines.some((l) => l.type === "del" && l.oldNo !== null && l.newNo === null)).toBe(
      true,
    );
    expect(hunk.lines.some((l) => l.type === "context")).toBe(true);
  });

  test("git diff joins every nested provider read before surfacing a failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-settle-"));
    temporaryRoots.push(root);
    runFixtureCommand(
      root,
      [
        "git init -q",
        "git config user.email t@t.io",
        "git config user.name t",
        "git config commit.gpgsign false",
        "printf 'base\\n' > file.txt",
        "git add file.txt",
        "git commit -q -m base",
        "printf 'changed\\n' > file.txt",
      ].join(" && "),
    );

    const modalLike = makeModalLikeExecOnlySession(root);
    const execCommand = modalLike.session.execCommand!;
    let siblingSettled = false;
    modalLike.session.execCommand = async (args) => {
      const running = execCommand(args);
      if (args.cmd.includes("diff --no-color -U3")) {
        await Bun.sleep(25);
        const output = await running;
        siblingSettled = true;
        return output;
      }
      const output = await running;
      return args.cmd.includes("diff --no-color -z --numstat")
        ? output.replace("__OPENGENI_GIT_CHUNK_V1__", "__OPENGENI_GIT_CHUNK_INVALID__")
        : output;
    };

    const svc = new SandboxChannelAService({ session: modalLike.session, workspaceRoot: root });
    await expect(
      svc.gitDiff({
        path: "",
        staged: false,
        includeUntracked: false,
        pathspec: [],
        contextLines: 3,
        maxBytesPerFile: 512 * 1024,
      }),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    expect(siblingSettled).toBe(true);
  });

  test("workspace-review diff includes bounded text, binary, and oversized untracked files", async () => {
    const { svc } = await makeRepoWithStagedChange();
    await svc.fsWrite({
      path: "-new file.txt",
      encoding: "utf8",
      content: "first\nsecond",
      overwrite: true,
      createParents: true,
    });
    const outside = `/tmp/opengeni-channel-a-diff-${crypto.randomUUID()}.txt`;
    const links = await svc.terminalExec({
      command: [
        `printf 'must not leak' > '${outside}'`,
        `ln -s '${outside}' external-link`,
        "ln -s file.txt internal-link",
      ].join(" && "),
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    expect(links.exitCode).toBe(0);
    await svc.fsWrite({
      path: "empty.txt",
      encoding: "utf8",
      content: "",
      overwrite: true,
      createParents: true,
    });
    await svc.fsWrite({
      path: "asset.bin",
      encoding: "base64",
      content: Buffer.from([0, 1, 2, 3]).toString("base64"),
      overwrite: true,
      createParents: true,
    });
    await svc.fsWrite({
      path: "large.txt",
      encoding: "utf8",
      content: "one\ntwo\nthree\n",
      overwrite: true,
      createParents: true,
    });

    const native = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: false,
      pathspec: [],
      contextLines: 3,
      maxBytesPerFile: 8,
    });
    expect(native.files).toEqual([]);

    const review = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: true,
      pathspec: [],
      contextLines: 3,
      maxBytesPerFile: 8,
    });
    const text = review.files.find((file) => file.path === "-new file.txt");
    expect(text?.status).toBe("untracked");
    expect(text?.additions).toBe(2);
    expect(text?.truncated).toBe(true);
    expect(text?.hunks).toEqual([]);

    const empty = review.files.find((file) => file.path === "empty.txt");
    expect(empty?.status).toBe("untracked");
    expect(empty?.additions).toBe(0);
    expect(empty?.truncated).toBe(false);
    expect(empty?.hunks).toEqual([]);

    const binary = review.files.find((file) => file.path === "asset.bin");
    expect(binary?.isBinary).toBe(true);
    expect(binary?.additions).toBe(0);
    expect(binary?.truncated).toBe(false);

    const large = review.files.find((file) => file.path === "large.txt");
    expect(large?.additions).toBe(3);
    expect(large?.truncated).toBe(true);

    const externalLink = review.files.find((file) => file.path === "external-link");
    expect(externalLink?.truncated).toBe(true);
    expect(externalLink?.hunks).toEqual([]);
    expect(JSON.stringify(externalLink)).not.toContain("must not leak");
    const internalLink = review.files.find((file) => file.path === "internal-link");
    expect(internalLink?.hunks[0]?.lines.map((line) => line.text)).toEqual(["file.txt"]);

    const fullText = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: true,
      pathspec: ["-new file.txt"],
      contextLines: 3,
      maxBytesPerFile: 1024,
    });
    expect(fullText.files).toHaveLength(1);
    expect(fullText.files[0]?.hunks[0]?.lines.map((line) => line.text)).toEqual([
      "first",
      "second",
    ]);
    const fullLink = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: true,
      pathspec: ["external-link"],
      contextLines: 3,
      maxBytesPerFile: 1_024,
    });
    expect(fullLink.files[0]?.hunks[0]?.lines.map((line) => line.text)).toEqual([outside]);
    expect(JSON.stringify(fullLink)).not.toContain("must not leak");
    await svc.terminalExec({
      command: `rm -f '${outside}'`,
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
  });

  test("execCommand-only Git capture stays below Modal's retained-output cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-modal-cap-"));
    temporaryRoots.push(root);
    const marker = "OPENGENI_MODAL_DIFF_TRANSPORT";
    const outside = join(tmpdir(), `opengeni-channel-a-outside-${crypto.randomUUID()}.txt`);
    temporaryRoots.push(outside);
    runFixtureCommand(
      root,
      [
        `printf 'outside secret' > '${outside}'`,
        "git init -q",
        "git config user.email test@opengeni.local",
        "git config user.name OpenGeni",
        "git config commit.gpgsign false",
        `printf 'export const marker = "BASE";\\n' > server.ts`,
        `printf 'base\\n' > staged-and-unstaged.txt`,
        `printf 'delete me\\n' > deleted.txt`,
        `printf 'rename me\\n' > old-name.txt`,
        "git add -A",
        "git commit -q -m baseline",
        `printf 'export const marker = "${marker}";\\n' > server.ts`,
        `printf 'staged ${marker}\\n' > staged-and-unstaged.txt`,
        "git add staged-and-unstaged.txt",
        `printf 'final ${marker}\\n' > staged-and-unstaged.txt`,
        "git rm -q deleted.txt",
        "git mv old-name.txt renamed.txt",
        `printf 'untracked ${marker}\\n' > notes.txt`,
        "head -c 2621440 /dev/zero > too-large.bin",
        `ln -s server.ts internal-link`,
        `ln -s '${outside}' external-link`,
      ].join(" && "),
    );
    const modalLike = makeModalLikeExecOnlySession(root);
    const svc = new SandboxChannelAService({
      session: modalLike.session,
      workspaceRoot: root,
    });

    const diff = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: true,
      fromRef: "HEAD",
      pathspec: [],
      contextLines: 3,
      maxBytesPerFile: 2 * 1024 * 1024,
    });

    expect(modalLike.truncatedResponses()).toBe(0);
    expect(
      diff.files
        .find((file) => file.path === "server.ts")
        ?.hunks.some((hunk) => hunk.lines.some((line) => line.text.includes(marker))),
    ).toBe(true);
    expect(diff.files.find((file) => file.path === "staged-and-unstaged.txt")?.status).toBe(
      "modified",
    );
    expect(diff.files.find((file) => file.path === "deleted.txt")?.status).toBe("deleted");
    expect(diff.files.find((file) => file.path === "renamed.txt")?.oldPath).toBe("old-name.txt");
    expect(
      diff.files
        .find((file) => file.path === "notes.txt")
        ?.hunks[0]?.lines.some((line) => line.text.includes(marker)),
    ).toBe(true);
    expect(diff.files.find((file) => file.path === "too-large.bin")).toMatchObject({
      status: "untracked",
      isBinary: true,
      additions: 0,
      truncated: true,
      hunks: [],
    });
    expect(
      diff.files
        .find((file) => file.path === "internal-link")
        ?.hunks[0]?.lines.map((line) => line.text),
    ).toEqual(["server.ts"]);
    const external = diff.files.find((file) => file.path === "external-link");
    expect(external?.hunks[0]?.lines.map((line) => line.text)).toEqual([outside]);
    expect(JSON.stringify(external)).not.toContain("outside secret");
  });

  test("exec-only untracked reads pin the opened descriptor across a symlink swap", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-symlink-race-"));
    temporaryRoots.push(root);
    const outside = join(tmpdir(), `opengeni-channel-a-secret-${crypto.randomUUID()}.txt`);
    temporaryRoots.push(outside);
    const victim = join(root, "victim.txt");
    const safeContent = "safe payload\n";
    const secretContent = "leak target!\n";
    const realCat = requireHostExecutable("cat");
    expect(Buffer.byteLength(safeContent)).toBe(Buffer.byteLength(secretContent));
    writeFileSync(outside, secretContent);
    runFixtureCommand(root, "git init -q");

    const bin = join(root, "attack-bin");
    const swaps = join(root, "swap-count");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "cat"),
      [
        "#!/bin/bash",
        'rm -f -- "$OPENGENI_SWAP_VICTIM"',
        'ln -s -- "$OPENGENI_SWAP_OUTSIDE" "$OPENGENI_SWAP_VICTIM"',
        'printf x >> "$OPENGENI_SWAP_COUNT"',
        `exec ${JSON.stringify(realCat)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "cat"), 0o755);

    const modalLike = makeModalLikeExecOnlySession(root, {
      pathPrefix: bin,
      env: {
        OPENGENI_SWAP_VICTIM: victim,
        OPENGENI_SWAP_OUTSIDE: outside,
        OPENGENI_SWAP_COUNT: swaps,
      },
      // Restore the regular file before every producer invocation. The fake
      // cat swaps it only after fd 3 has been opened and identity-checked.
      beforeExec: () => {
        rmSync(victim, { force: true });
        writeFileSync(victim, safeContent);
      },
    });
    const outputs: string[] = [];
    const execCommand = modalLike.session.execCommand!;
    modalLike.session.execCommand = async (args) => {
      const output = await execCommand(args);
      outputs.push(output);
      return output;
    };
    const svc = new SandboxChannelAService({
      session: modalLike.session,
      workspaceRoot: root,
    });

    const diff = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: true,
      fromRef: "HEAD",
      pathspec: ["victim.txt"],
      contextLines: 3,
      maxBytesPerFile: 1024,
    });

    expect((await Bun.file(swaps).text()).length).toBeGreaterThan(0);
    expect(diff.files[0]?.hunks[0]?.lines.map((line) => line.text)).toEqual(["safe payload"]);
    expect(JSON.stringify(diff)).not.toContain(secretContent.trim());
    expect(outputs.join("\n")).not.toContain(secretContent.trim());
  });

  test("stock macOS/BSD command surface preserves bounded descriptor confinement", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-stock-macos-"));
    temporaryRoots.push(root);
    const outside = join(tmpdir(), `opengeni-channel-a-stock-secret-${crypto.randomUUID()}.txt`);
    temporaryRoots.push(outside);
    const victim = join(root, "victim.txt");
    const safeContent = "safe payload\n";
    const secretContent = "leak target!\n";
    const realCat = requireHostExecutable("cat");
    expect(Buffer.byteLength(safeContent)).toBe(Buffer.byteLength(secretContent));
    writeFileSync(outside, secretContent);
    runFixtureCommand(root, "git init -q");

    const surface = makeStockMacCommandSurface(root);
    const swaps = join(root, "swap-count");
    type InitialProducer = "numstat" | "patch" | "untracked";
    const enteredProducers = new Set<InitialProducer>();
    let releaseInitialProducers!: () => void;
    const allInitialProducersEntered = new Promise<void>((resolve) => {
      releaseInitialProducers = resolve;
    });
    let victimInitializations = 0;
    writeFileSync(
      join(surface.bin, "cat"),
      [
        "#!/bin/bash",
        'rm -f -- "$OPENGENI_SWAP_VICTIM"',
        'ln -s -- "$OPENGENI_SWAP_OUTSIDE" "$OPENGENI_SWAP_VICTIM"',
        'printf x >> "$OPENGENI_SWAP_COUNT"',
        `exec ${JSON.stringify(realCat)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(surface.bin, "cat"), 0o755);

    const macLike = makeModalLikeExecOnlySession(root, {
      pathPrefix: surface.bin,
      env: {
        OPENGENI_STOCK_MAC_LOG: surface.log,
        OPENGENI_SWAP_VICTIM: victim,
        OPENGENI_SWAP_OUTSIDE: outside,
        OPENGENI_SWAP_COUNT: swaps,
      },
      beforeExec: async ({ cmd }) => {
        const producer: InitialProducer | null = cmd.includes("diff --no-color -z --numstat")
          ? "numstat"
          : cmd.includes("diff --no-color -U")
            ? "patch"
            : cmd.includes("ls-files --others --exclude-standard")
              ? "untracked"
              : null;
        if (!producer) return;

        enteredProducers.add(producer);
        if (enteredProducers.size === 3) releaseInitialProducers();
        await Promise.race([
          allInitialProducersEntered,
          Bun.sleep(2_000).then(() => {
            throw new Error(
              `initial gitDiff producers did not overlap: ${[...enteredProducers].sort().join(",")}`,
            );
          }),
        ]);

        // Initialize the attack fixture exactly once, after all three initial
        // provider operations are concurrently in flight but before the
        // untracked producer opens its confined descriptors.
        if (producer === "untracked" && victimInitializations === 0) {
          victimInitializations += 1;
          rmSync(victim, { force: true });
          writeFileSync(victim, safeContent);
        }
      },
    });
    const svc = new SandboxChannelAService({
      session: macLike.session,
      workspaceRoot: root,
    });

    const diff = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: true,
      fromRef: "HEAD",
      pathspec: ["victim.txt"],
      contextLines: 3,
      maxBytesPerFile: 1024,
    });

    const commands = await Bun.file(surface.log).text();
    expect(commands).toContain("sha256sum");
    expect(commands).toContain("shasum");
    expect(commands).toContain("lsof");
    expect(commands).toContain("stat -f %i");
    expect([...enteredProducers].sort()).toEqual(["numstat", "patch", "untracked"]);
    expect(victimInitializations).toBe(1);
    expect((await Bun.file(swaps).text()).length).toBeGreaterThan(0);
    expect(diff.files[0]?.hunks[0]?.lines.map((line) => line.text)).toEqual(["safe payload"]);
    expect(JSON.stringify(diff)).not.toContain(secretContent.trim());
  });

  test("a partial regular-file frame fails unavailable instead of authorizing an empty diff", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-regular-frame-"));
    temporaryRoots.push(root);
    runFixtureCommand(root, "git init -q && printf 'frame body\\n' > notes.txt");
    const modalLike = makeModalLikeExecOnlySession(root);
    const execCommand = modalLike.session.execCommand!;
    let corrupted = false;
    modalLike.session.execCommand = async (args) => {
      const output = await execCommand(args);
      if (!corrupted && args.cmd.includes("line_count=") && output.includes("GIT_CHUNK_END_V1")) {
        corrupted = true;
        return output.replace("__OPENGENI_GIT_CHUNK_END_V1__", "");
      }
      return output;
    };
    const svc = new SandboxChannelAService({
      session: modalLike.session,
      workspaceRoot: root,
    });

    await expect(
      svc.gitDiff({
        path: "",
        staged: false,
        includeUntracked: true,
        fromRef: "HEAD",
        pathspec: [],
        contextLines: 3,
        maxBytesPerFile: 1024,
      }),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    expect(corrupted).toBe(true);
  });

  test("a malformed symlink frame fails unavailable instead of being skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-symlink-frame-"));
    temporaryRoots.push(root);
    runFixtureCommand(
      root,
      "git init -q && printf target > target.txt && ln -s target.txt link.txt",
    );
    const modalLike = makeModalLikeExecOnlySession(root);
    const execCommand = modalLike.session.execCommand!;
    let corrupted = false;
    modalLike.session.execCommand = async (args) => {
      const output = await execCommand(args);
      if (!corrupted && args.cmd.includes("readlink -n") && output.includes("GIT_CHUNK_V1")) {
        corrupted = true;
        return output.replace("__OPENGENI_GIT_CHUNK_V1__", "__OPENGENI_GIT_CHUNK_V0__");
      }
      return output;
    };
    const svc = new SandboxChannelAService({
      session: modalLike.session,
      workspaceRoot: root,
    });

    await expect(
      svc.gitDiff({
        path: "",
        staged: false,
        includeUntracked: true,
        fromRef: "HEAD",
        pathspec: [],
        contextLines: 3,
        maxBytesPerFile: 1024,
      }),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    expect(corrupted).toBe(true);
  });

  test.skipIf(process.platform === "darwin")(
    "tracked invalid-byte Git paths fail unavailable before pathspec replay",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-invalid-tracked-"));
      temporaryRoots.push(root);
      const invalidPath = Buffer.concat([Buffer.from(`${root}/tracked-`), Buffer.from([0xff])]);
      runFixtureCommand(
        root,
        "git init -q && git config user.email test@opengeni.local && git config user.name OpenGeni && git config commit.gpgsign false",
      );
      writeInvalidBytePath(invalidPath, "base\n");
      runFixtureCommand(root, "git add -A && git commit -q -m baseline");
      writeFileSync(invalidPath, "changed\n");
      const modalLike = makeModalLikeExecOnlySession(root);
      const svc = new SandboxChannelAService({
        session: modalLike.session,
        workspaceRoot: root,
      });

      await expect(
        svc.gitDiff({
          path: "",
          staged: false,
          includeUntracked: false,
          fromRef: "HEAD",
          pathspec: [],
          contextLines: 3,
          maxBytesPerFile: 1024,
        }),
      ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    },
  );

  test.skipIf(process.platform === "darwin")(
    "untracked invalid-byte Git paths fail unavailable before file reads",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-invalid-untracked-"));
      temporaryRoots.push(root);
      const invalidPath = Buffer.concat([Buffer.from(`${root}/untracked-`), Buffer.from([0xfe])]);
      runFixtureCommand(root, "git init -q");
      writeInvalidBytePath(invalidPath, "untracked\n");
      const modalLike = makeModalLikeExecOnlySession(root);
      const svc = new SandboxChannelAService({
        session: modalLike.session,
        workspaceRoot: root,
      });

      await expect(
        svc.gitDiff({
          path: "",
          staged: false,
          includeUntracked: true,
          fromRef: "HEAD",
          pathspec: [],
          contextLines: 3,
          maxBytesPerFile: 1024,
        }),
      ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    },
  );

  test("a complete bounded producer is captured once without a second replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-exit-42-"));
    temporaryRoots.push(root);
    runFixtureCommand(root, "git init -q && printf 'notes\\n' > notes.txt");
    const bin = join(root, "producer-bin");
    const count = join(root, "ls-files-count");
    const realGit = requireHostExecutable("git");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      [
        "#!/bin/bash",
        'if [[ " $* " == *" ls-files "* ]]; then',
        '  n=0; [ ! -f "$OPENGENI_GIT_COUNT" ] || n=$(<"$OPENGENI_GIT_COUNT")',
        '  n=$((n + 1)); printf "%s" "$n" > "$OPENGENI_GIT_COUNT"',
        `  ${JSON.stringify(realGit)} "$@"`,
        "  status=$?",
        '  if [ "$n" -ge 2 ]; then exit 42; fi',
        '  exit "$status"',
        "fi",
        `exec ${JSON.stringify(realGit)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "git"), 0o755);
    const modalLike = makeModalLikeExecOnlySession(root, {
      pathPrefix: bin,
      env: { OPENGENI_GIT_COUNT: count },
    });
    const svc = new SandboxChannelAService({
      session: modalLike.session,
      workspaceRoot: root,
    });

    const diff = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: true,
      fromRef: "HEAD",
      pathspec: [],
      contextLines: 3,
      maxBytesPerFile: 1024,
    });
    expect(diff.files.some((file) => file.path === "notes.txt")).toBe(true);
    expect(Number(await Bun.file(count).text())).toBe(1);
  });

  test("a complete bounded producer has no measure-to-read drift window", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-producer-drift-"));
    temporaryRoots.push(root);
    runFixtureCommand(root, "git init -q && printf 'alpha\\n' > alpha.txt");
    const bin = join(root, "producer-bin");
    const count = join(root, "ls-files-count");
    const realGit = requireHostExecutable("git");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      [
        "#!/bin/bash",
        'if [[ " $* " == *" ls-files "* ]]; then',
        '  n=0; [ ! -f "$OPENGENI_GIT_COUNT" ] || n=$(<"$OPENGENI_GIT_COUNT")',
        '  n=$((n + 1)); printf "%s" "$n" > "$OPENGENI_GIT_COUNT"',
        '  if [ "$n" -eq 1 ]; then printf "alpha.txt\\0"; else printf "bravo.txt\\0"; fi',
        "  exit 0",
        "fi",
        `exec ${JSON.stringify(realGit)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "git"), 0o755);
    const modalLike = makeModalLikeExecOnlySession(root, {
      pathPrefix: bin,
      env: { OPENGENI_GIT_COUNT: count },
    });
    const svc = new SandboxChannelAService({
      session: modalLike.session,
      workspaceRoot: root,
    });

    const diff = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: true,
      fromRef: "HEAD",
      pathspec: [],
      contextLines: 3,
      maxBytesPerFile: 1024,
    });
    expect(diff.files.some((file) => file.path === "alpha.txt")).toBe(true);
    expect(Number(await Bun.file(count).text())).toBe(1);
  });

  test("bounded Git capture preserves staged and untracked files before the first commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-channel-a-unborn-"));
    temporaryRoots.push(root);
    runFixtureCommand(
      root,
      [
        "git init -q",
        `printf 'staged before HEAD\\n' > staged.txt`,
        "git add staged.txt",
        `printf 'untracked before HEAD\\n' > untracked.txt`,
      ].join(" && "),
    );
    const modalLike = makeModalLikeExecOnlySession(root);
    const svc = new SandboxChannelAService({
      session: modalLike.session,
      workspaceRoot: root,
    });

    const diff = await svc.gitDiff({
      path: "",
      staged: false,
      includeUntracked: true,
      fromRef: "HEAD",
      pathspec: [],
      contextLines: 3,
      maxBytesPerFile: 512 * 1024,
    });

    expect(modalLike.truncatedResponses()).toBe(0);
    expect(diff.files.find((file) => file.path === "staged.txt")?.status).toBe("added");
    expect(diff.files.find((file) => file.path === "untracked.txt")?.status).toBe("untracked");
  });

  test("git status outside a repo returns isRepo:false (not an error)", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    const status = await svc.gitStatus({ path: "" });
    expect(status.isRepo).toBe(false);
    expect(status.files).toEqual([]);
  });

  test("repository discovery covers the platform nested seed layout and .git files", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    const seeded = await svc.terminalExec({
      command: [
        "mkdir -p repos/havardthun/Vern",
        "git -C repos/havardthun/Vern init -q",
        "git -C repos/havardthun/Vern config user.email t@t.io",
        "git -C repos/havardthun/Vern config user.name t",
        "git -C repos/havardthun/Vern config commit.gpgsign false",
        "printf baseline > repos/havardthun/Vern/file.txt",
        "git -C repos/havardthun/Vern add file.txt",
        "git -C repos/havardthun/Vern commit -q -m baseline",
        "git -C repos/havardthun/Vern worktree add -q ../Vern-linked -b linked",
        "mkdir -p node_modules/ignored",
        "git -C node_modules/ignored init -q",
      ].join(" && "),
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    expect(seeded.exitCode).toBe(0);

    const discovery = await svc.detectReposDetailed();
    expect(discovery).toEqual({
      repos: ["repos/havardthun/Vern", "repos/havardthun/Vern-linked"],
      complete: true,
      degradedReason: null,
    });
  });

  test("repository discovery preserves the workspace-root repository", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    const seeded = await svc.terminalExec({
      command: "git init -q .",
      cwd: "",
      timeoutMs: 20_000,
      emitStream: false,
    });
    expect(seeded.exitCode).toBe(0);
    expect(await svc.detectReposDetailed()).toEqual({
      repos: [""],
      complete: true,
      degradedReason: null,
    });
  });

  test("repository discovery does not depend on GNU timeout", async () => {
    let command = "";
    const svc = new SandboxChannelAService({
      session: {
        exec: async (args) => {
          command = args.cmd;
          return {
            stdout: "__OPENGENI_REPOSITORY_DISCOVERY_STATUS__:0\n",
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    expect(await svc.detectReposDetailed()).toEqual({
      repos: [],
      complete: true,
      degradedReason: null,
    });
    expect(command).not.toMatch(/(^|[;&|()\s])timeout([;&|()\s]|$)/);
  });

  test("repository discovery fails closed when its command cannot complete", async () => {
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({ stdout: "", stderr: "find failed", exitCode: 9 }),
      },
    });
    expect(await svc.detectReposDetailed()).toEqual({
      repos: [],
      complete: false,
      degradedReason: "command_failed",
    });
    // Capability negotiation keeps its historical best-effort compact shape.
    expect(await svc.detectRepos()).toEqual([]);
  });

  test("repository discovery reports an explicit wall-clock timeout", async () => {
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({
          stdout: "__OPENGENI_REPOSITORY_DISCOVERY_STATUS__:124\n",
          stderr: "",
          exitCode: 124,
        }),
      },
    });
    expect(await svc.detectReposDetailed()).toEqual({
      repos: [],
      complete: false,
      degradedReason: "command_timed_out",
    });
  });

  test("repository discovery reports an explicit result-limit degradation", async () => {
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({
          stdout: [
            "./repos/a/one/.git",
            "__OPENGENI_REPOSITORY_DISCOVERY_TRUNCATED__",
            "__OPENGENI_REPOSITORY_DISCOVERY_STATUS__:0",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        }),
      },
    });
    expect(await svc.detectReposDetailed()).toEqual({
      repos: ["repos/a/one"],
      complete: false,
      degradedReason: "result_limit_exceeded",
    });
  });

  test("git log returns the commit chain", async () => {
    const { svc } = await makeRepoWithStagedChange();
    await svc.terminalExec({
      command: "git commit -q -m second",
      cwd: "",
      timeoutMs: 20000,
      emitStream: false,
    });
    const log = await svc.gitLog({ path: "", ref: "HEAD", maxCount: 10, skip: 0, pathspec: [] });
    expect(log.commits.length).toBeGreaterThanOrEqual(2);
    expect(log.commits[0]!.subject).toBe("second");
    expect(log.commits[1]!.subject).toBe("baseline");
    expect(log.commits[0]!.author.name).toBe("t");
  });
});

describe("P4.4 SandboxChannelAService — Terminal exec (real local box)", () => {
  test("terminal exec 'echo $DISPLAY' streams output", async () => {
    const { session } = await makeBox();
    const emitted: { type: string; payload: unknown }[] = [];
    const svc = new SandboxChannelAService({
      session,
      emit: async (e) => {
        emitted.push(...e);
      },
    });
    const out = await svc.terminalExec({
      command: "echo display=$DISPLAY; echo marker_channel_a",
      cwd: "",
      timeoutMs: 10000,
      emitStream: true,
    });
    expect(out.stdout).toContain("marker_channel_a");
    expect(out.exitCode).toBe(0);
    // the buffered output is also published on A1 as the firehose
    expect(emitted.some((e) => e.type === "sandbox.command.output.delta")).toBe(true);
  });

  test("terminal exec reports a non-zero exit code", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    const out = await svc.terminalExec({
      command: "exit 3",
      cwd: "",
      timeoutMs: 10000,
      emitStream: false,
    });
    expect(out.exitCode).toBe(3);
    expect(out.running).toBe(false);
  });

  test("terminal exec drains a provider yield and never exposes a running response", async () => {
    let writes = 0;
    const session: ChannelASession = {
      supportsPty: () => true,
      exec: async () => ({
        stdout: "initial\n",
        stderr: "warning\n",
        exitCode: null,
        sessionId: 81,
      }),
      writeStdin: async () => {
        writes += 1;
        return writes === 1
          ? "Process running with session ID 81\n\nOutput:\nlater\n"
          : "Process exited with code 7\n\nOutput:\ndone\n";
      },
    };

    const out = await new SandboxChannelAService({ session }).terminalExec({
      command: "eventually exits",
      cwd: "",
      timeoutMs: 10_000,
      emitStream: false,
    });

    expect(out).toMatchObject({
      stdout: "initial\nlater\ndone\n",
      stderr: "warning\n",
      exitCode: 7,
      running: false,
    });
    expect(writes).toBe(2);
  });

  test("terminal timeout waits for retained-process settlement after group absence", async () => {
    let processAlive = true;
    let retained = true;
    let allowSettlement = false;
    let finalControlPolls = 0;
    const session: ChannelASession = {
      supportsPty: () => true,
      hasRetainedProcess: (sessionId) => retained && sessionId === 82,
      exec: async () => ({ stdout: "started\n", stderr: "", exitCode: null, sessionId: 82 }),
      writeStdinForProcessControl: async () => {
        if (processAlive) return "Process running with session ID 82\n\nOutput:\n";
        finalControlPolls += 1;
        if (!allowSettlement) throw new Error("settlement unavailable");
        retained = false;
        return "Process exited with code 137\n\nOutput:\n";
      },
      execCommandForProcessControl: async (_sessionId, args) => {
        if (args.cmd.includes("command cat '/tmp/opengeni-turn-shell/")) {
          return "Process exited with code 0\n\nOutput:\n6200 6200\n";
        }
        if (args.cmd.includes("command kill -KILL")) {
          processAlive = false;
          return "Process exited with code 0\n\nOutput:\n";
        }
        if (args.cmd.includes("command kill -0")) {
          return `Process exited with code ${processAlive ? 75 : 0}\n\nOutput:\n`;
        }
        return "Process exited with code 0\n\nOutput:\n";
      },
    };

    const response = new SandboxChannelAService({ session }).terminalExec({
      command: "trap '' INT TERM; sleep 60",
      cwd: "",
      timeoutMs: 75,
      emitStream: false,
    });
    await Bun.sleep(300);
    expect(await pendingAfterMicrotasks(response)).toBe(true);
    expect(processAlive).toBe(false);
    expect(finalControlPolls).toBeGreaterThan(0);

    allowSettlement = true;
    expect(await response).toMatchObject({ exitCode: 124, running: false });
    expect(retained).toBe(false);
  });

  test("terminal timeout kills a signal-ignoring local process before it can write later", async () => {
    const { session, root } = await makeBox();
    const sentinel = `${root}/terminal-timeout-${crypto.randomUUID()}`;
    const startedAt = performance.now();

    const out = await new SandboxChannelAService({ session }).terminalExec({
      command: `trap '' INT TERM; sleep 1; printf late > '${sentinel}'`,
      cwd: "",
      timeoutMs: 200,
      emitStream: false,
    });

    expect(out).toMatchObject({ exitCode: 124, running: false });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    await Bun.sleep(1_100);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("PTY capability probe reports the local backend supports interactive input", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    // The local backend exposes supportsPty()=true + writeStdin -> the compact
    // capability projection advertises interactive PTY. (Actually OPENING a PTY on
    // the local backend needs a python3 pty-bridge, exercised in the next test
    // when available; the capability gate itself does not.)
    const caps = svc.capabilities();
    expect(caps.Terminal.pty.available).toBe(true);
    expect(caps.Terminal.exec).toBe(true);
    expect(caps.FileSystem.available).toBe(true);
    expect(caps.Git.available).toBe(true);
  });

  test("PTY open yields a ptyId + supportsInput when a pty-bridge is available", async () => {
    const { session } = await makeBox();
    const svc = new SandboxChannelAService({ session });
    const ptyId = crypto.randomUUID();
    let opened: Awaited<ReturnType<typeof svc.ptyOpen>>;
    try {
      opened = await svc.ptyOpen({ cols: 80, rows: 24, cwd: "" }, ptyId);
    } catch (error) {
      // The unix_local backend drives interactive PTYs through a python3 bridge
      // the SDK spawns with a sanitized PATH; when that bridge is unavailable the
      // open throws a configuration_error. Treat that as "no pty-bridge here" and
      // skip the live-open assertion (the capability gate above still proves the
      // shape). On the real docker/Modal images the bridge is present, so the e2e
      // PTY path is exercised there.
      const msg = error instanceof Error ? error.message : String(error);
      expect(msg).toMatch(/PTY|python/i);
      return;
    }
    expect(opened.response.ptyId).toBe(ptyId);
    expect(opened.response.streamVia).toBe("sse-events");
    expect(opened.response.supportsInput).toBe(true);
  });
});

describe("P4.4 SandboxChannelAService — terminal cwd frames", () => {
  const RELAY = { host: "relay.test", port: 443, tls: true } as const;
  const WS = "11111111-1111-1111-1111-111111111111";
  const AGENT = "agent-abc";

  test("selfhosted terminalExec preserves virtual '/workspace' so the machine cwd is workingDir", async () => {
    const seen: Array<{ command: string; cwd: string }> = [];
    const mock = new MockAgentResponder({
      exec: (req) => {
        seen.push({ command: req.command.join(" "), cwd: req.cwd });
        expect(req.cwd).toBe("/home/u/proj");
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode("README.md\n"),
          stderr: new Uint8Array(0),
          timedOut: false,
          durationMs: "1",
        };
      },
    });
    const session = new SelfhostedSession({
      workspaceId: WS,
      agentId: AGENT,
      controlRpc: mock,
      relay: RELAY,
      workingDir: "/home/u/proj",
    });
    const svc = new SandboxChannelAService({ session });

    const out = await svc.terminalExec({
      command: "ls",
      cwd: "/workspace",
      timeoutMs: 10000,
      emitStream: false,
    });

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("README.md");
    expect(seen).toEqual([{ command: "ls", cwd: "/home/u/proj" }]);
  });

  test("selfhosted terminalExec preserves virtual '/workspace/sub' so compound commands run in workingDir/sub", async () => {
    const seen: Array<{ command: string; cwd: string }> = [];
    const mock = new MockAgentResponder({
      exec: (req) => {
        seen.push({ command: req.command.join(" "), cwd: req.cwd });
        expect(req.cwd).toBe("/home/u/proj/sub");
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(`${req.cwd}\ntotal 0\n`),
          stderr: new Uint8Array(0),
          timedOut: false,
          durationMs: "1",
        };
      },
    });
    const session = new SelfhostedSession({
      workspaceId: WS,
      agentId: AGENT,
      controlRpc: mock,
      relay: RELAY,
      workingDir: "/home/u/proj",
    });
    const svc = new SandboxChannelAService({ session });

    const out = await svc.terminalExec({
      command: "pwd && ls -la",
      cwd: "/workspace/sub",
      timeoutMs: 10000,
      emitStream: false,
    });

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("/home/u/proj/sub");
    expect(seen).toEqual([{ command: "pwd && ls -la", cwd: "/home/u/proj/sub" }]);
  });

  test("selfhosted ptyOpen preserves virtual cwd before the session maps it", async () => {
    let seenCwd: string | undefined;
    const mock = new MockAgentResponder({
      exec: (req) => {
        seenCwd = req.cwd;
        expect(req.command).toEqual(["/bin/bash"]);
        return {
          exitCode: null,
          stdout: new TextEncoder().encode("root@machine:/home/u/proj/sub# "),
          stderr: new Uint8Array(0),
          timedOut: false,
          durationMs: "1",
        };
      },
    });
    const session = new SelfhostedSession({
      workspaceId: WS,
      agentId: AGENT,
      controlRpc: mock,
      relay: RELAY,
      workingDir: "/home/u/proj",
    });
    const svc = new SandboxChannelAService({ session });

    const opened = await svc.ptyOpen(
      { cols: 80, rows: 24, cwd: "/workspace/sub" },
      "pty-selfhosted",
    );

    expect(opened.response.ptyId).toBe("pty-selfhosted");
    expect(opened.response.supportsInput).toBe(false);
    expect(seenCwd).toBe("/home/u/proj/sub");
  });

  test("provisioned-box terminal cwd behavior still joins repo-relative paths under workspaceRoot", async () => {
    const seen: Array<{ cmd: string; workdir: string | undefined; tty?: boolean }> = [];
    const session: ChannelASession = {
      supportsPty: () => true,
      exec: async (args) => {
        seen.push({ cmd: args.cmd, workdir: args.workdir, tty: args.tty });
        const openingPty = args.cmd === "/bin/bash";
        return {
          stdout: "",
          stderr: "",
          exitCode: openingPty ? null : 0,
          sessionId: openingPty ? 12 : undefined,
        };
      },
      writeStdin: async () => "",
    };
    const svc = new SandboxChannelAService({ session, workspaceRoot: "/workspace" });

    await svc.terminalExec({ command: "pwd", cwd: "", timeoutMs: 10000, emitStream: false });
    await svc.terminalExec({ command: "pwd", cwd: "sub", timeoutMs: 10000, emitStream: false });
    await svc.ptyOpen({ cols: 80, rows: 24, cwd: "sub" }, "pty-provisioned");
    await svc.terminalExec({
      command: "pwd",
      cwd: "/workspace/sub",
      timeoutMs: 10000,
      emitStream: false,
    });

    expect(seen).toHaveLength(4);
    expect(seen[0]).toMatchObject({ workdir: "/workspace", tty: true });
    expect(seen[0]!.cmd).toContain("pwd");
    expect(seen[0]!.cmd).toContain("/tmp/opengeni-turn-shell/");
    expect(seen[1]).toMatchObject({ workdir: "/workspace/sub", tty: true });
    expect(seen[1]!.cmd).toContain("pwd");
    expect(seen[2]).toEqual({ cmd: "/bin/bash", workdir: "/workspace/sub", tty: true });
    expect(seen[3]).toMatchObject({ workdir: "/workspace/sub", tty: true });
    expect(seen[3]!.cmd).toContain("pwd");
  });

  test("dock fs/git operations still use repo-relative workspaceRoot mapping", async () => {
    const paths: string[] = [];
    const commands: string[] = [];
    const session: ChannelASession = {
      readFile: async ({ path }) => {
        paths.push(path);
        return "file";
      },
      exec: async ({ cmd, workdir }) => {
        commands.push(cmd);
        paths.push(workdir ?? "");
        if (cmd.includes("__OPENGENI_GIT_CHUNK_V1__")) {
          const payload = Buffer.from("__OPENGENI_GIT_STATUS_REPO_V1__\0");
          const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
          const capture = [
            `__OPENGENI_GIT_CHUNK_V1__\t0\t${payload.byteLength}\t${digest}\t0\t${payload.byteLength}`,
            payload.toString("base64"),
            "__OPENGENI_GIT_CHUNK_END_V1__",
          ].join("\n");
          return {
            stdout: framedConfinedOutput(cmd, capture),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd.includes("git rev-parse")) {
          return {
            stdout: framedConfinedOutput(cmd, "true\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: cmd.includes('cd -P -- "$target"') ? framedConfinedOutput(cmd) : "",
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const svc = new SandboxChannelAService({ session, workspaceRoot: "/workspace" });

    await svc.fsRead({ path: "file.txt", encoding: "utf8", maxBytes: 16 });
    await svc.gitStatus({ path: "repo" });

    expect(paths).toContain("/workspace/file.txt");
    expect(commands.some((command) => command.includes("/workspace/repo"))).toBe(true);
    expect(commands.some((command) => command.includes('cd -P -- "$target"'))).toBe(true);
  });
});

// ── pure parser unit tests (no box) ─────────────────────────────────────────
describe("P4.4 parsers — porcelain/numstat/unified-diff", () => {
  test("parsePorcelainV2 reads branch + file XY codes", () => {
    const z =
      [
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
        "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
        "1 .M N... 100644 100644 100644 aaa bbb dirty.txt",
        "? untracked.txt",
      ].join(NUL) + NUL;
    const out = parsePorcelainV2(z);
    expect(out.isRepo).toBe(true);
    expect(out.head).toBe("main");
    expect(out.upstream).toBe("origin/main");
    expect(out.ahead).toBe(2);
    expect(out.behind).toBe(1);
    const staged = out.files.find((f) => f.path === "staged.txt");
    expect(staged?.index).toBe("modified");
    expect(staged?.worktree).toBeNull();
    const dirty = out.files.find((f) => f.path === "dirty.txt");
    expect(dirty?.worktree).toBe("modified");
    const untracked = out.files.find((f) => f.path === "untracked.txt");
    expect(untracked?.worktree).toBe("untracked");
  });

  test("parseNumstatZ reads additions/deletions + binary + rename", () => {
    // normal: "5\t2\tfile.ts", binary: "-\t-\timg.png", rename: "1\t0\t" then old, new
    const z = ["5\t2\tfile.ts", "-\t-\timg.png", "1\t0\t", "old.ts", "new.ts"].join(NUL) + NUL;
    const out = parseNumstatZ(z);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      additions: 5,
      deletions: 2,
      binary: false,
      newPath: "file.ts",
      oldPath: null,
    });
    expect(out[1]).toMatchObject({ binary: true, newPath: "img.png" });
    expect(out[2]).toMatchObject({ oldPath: "old.ts", newPath: "new.ts" });
  });

  test("parseUnifiedPatch builds hunks with typed add/del/context + gutter numbers", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "index 111..222 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,4 @@",
      " line one",
      "-line two",
      "+line two changed",
      " line three",
      "+line four",
    ].join("\n");
    const { hunks, status } = parseUnifiedPatch(patch);
    expect(status).toBe("modified");
    expect(hunks).toHaveLength(1);
    const h = hunks[0]!;
    expect(h.oldStart).toBe(1);
    expect(h.newStart).toBe(1);
    const add = h.lines.find((l) => l.type === "add" && l.text === "line two changed");
    expect(add?.oldNo).toBeNull();
    expect(add?.newNo).toBe(2);
    const del = h.lines.find((l) => l.type === "del" && l.text === "line two");
    expect(del?.newNo).toBeNull();
    expect(del?.oldNo).toBe(2);
  });

  test("parseUnifiedPatch detects added/deleted file status", () => {
    const added = [
      "diff --git a/n b/n",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/n",
      "@@ -0,0 +1,1 @@",
      "+hi",
    ].join("\n");
    expect(parseUnifiedPatch(added).status).toBe("added");
    const deleted = [
      "diff --git a/d b/d",
      "deleted file mode 100644",
      "--- a/d",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect(parseUnifiedPatch(deleted).status).toBe("deleted");
  });

  test("stripExecBanner removes the formatExecResponse banner", () => {
    const banner =
      "Chunk ID: abc\nWall time: 0.05 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\nactual output here";
    expect(stripExecBanner(banner)).toBe("actual output here");
    expect(stripExecBanner("no banner here")).toBe("no banner here");
  });

  test("parseExecBannerSessionId recovers a running PTY's session id from the banner", () => {
    // A STILL-RUNNING process (an interactive shell) carries the session-id line.
    const running =
      "Chunk ID: 6497fe\nWall time: 1.0360 seconds\nProcess running with session ID 7\nOutput:\nroot@modal:~# ";
    expect(parseExecBannerSessionId(running)).toBe(7);
    // A finished command carries `Process exited with code N` — no session id.
    const exited =
      "Chunk ID: abc\nWall time: 0.05 seconds\nProcess exited with code 0\nOutput:\ndone";
    expect(parseExecBannerSessionId(exited)).toBeNull();
    // A session-id-looking line in the command OUTPUT (after the marker) must NOT
    // be mistaken for the banner's id.
    const spoof =
      "Chunk ID: abc\nWall time: 0.01 seconds\nProcess exited with code 0\nOutput:\nProcess running with session ID 99";
    expect(parseExecBannerSessionId(spoof)).toBeNull();
    expect(
      parseExecBannerSessionId(
        "Chunk ID: abc\r\nWall time: 0.01 seconds\r\nProcess running with session ID 8\r\nOutput:\r\nready",
      ),
    ).toBe(8);
    expect(
      parseExecBannerSessionId(
        "Chunk ID: abc\nProcess running with session ID 7\nProcess running with session ID 8\nOutput:\n",
      ),
    ).toBeNull();
    expect(parseExecBannerSessionId("Process running with session ID 7")).toBeNull();
    expect(parseExecBannerSessionId("no banner")).toBeNull();
  });

  test("parseExecBannerExitCode reads only a completed command's banner", () => {
    const exited =
      "Chunk ID: abc\nWall time: 0.05 seconds\nProcess exited with code 67\nOutput:\nignored";
    expect(parseExecBannerExitCode(exited)).toBe(67);
    expect(
      parseExecBannerExitCode(
        "Chunk ID: abc\nProcess running with session ID 7\nOutput:\nProcess exited with code 0",
      ),
    ).toBeNull();
    expect(parseExecBannerExitCode("Output:\nProcess exited with code 0")).toBeNull();
    expect(
      parseExecBannerExitCode(
        "Chunk ID: abc\r\nProcess exited with code 13\r\nOutput:\r\nProcess exited with code 0",
      ),
    ).toBe(13);
    expect(
      parseExecBannerExitCode(
        "Chunk ID: abc\nProcess exited with code 13\nProcess exited with code 0\nOutput:\n",
      ),
    ).toBeNull();
    expect(parseExecBannerExitCode("Chunk ID: abc\nProcess exited with code 0")).toBeNull();
  });

  test("isExecSessionLostBanner classifies the lost-PTY writeStdin banner", () => {
    // The Modal writeStdin non-throwing banner when the exec-session is gone.
    expect(isExecSessionLostBanner("write_stdin failed: session not found: 1", 1)).toBe(true);
    expect(isExecSessionLostBanner("session not found: 1", 1)).toBe(true);
    // The hard fence requires the exact tracked numeric id and known complete
    // banner. Generic, malformed, mismatched, and ambiguous text fails closed.
    expect(isExecSessionLostBanner("session not found", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed: session not found: nope", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed: session not found: 9", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed: session not found: 10", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed: session not found: 1 or 2", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed: session not found: 1x", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed: session not found: 01", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed:  session not found: 1", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed: session not found:\n1", 1)).toBe(false);
    expect(isExecSessionLostBanner(" write_stdin failed: session not found: 1", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed: session not found: 1 ", 1)).toBe(false);
    expect(isExecSessionLostBanner("write_stdin failed: session not found: 1\n", 1)).toBe(false);
    expect(
      isExecSessionLostBanner("write_stdin failed: session not found: 9007199254740993", 1),
    ).toBe(false);
    // Real PTY output is never misclassified.
    expect(isExecSessionLostBanner("root@box:~# echo hi\nhi\n", 1)).toBe(false);
    expect(isExecSessionLostBanner("", 1)).toBe(false);
  });

  test("ptyOpen surfaces an execSessionId on an execCommand-only backend (Modal shape)", async () => {
    // Reproduce the Modal session surface: NO structural `exec()`, only
    // `execCommand()` returning a banner string, plus supportsPty()+writeStdin.
    // The fix: run() must recover the session id from the banner so ptyOpen
    // reports a non-null execSessionId (else pty/write 409s -> read-only).
    let nextId = 1;
    const open = new Map<number, boolean>();
    const session: ChannelASession = {
      supportsPty: () => true,
      execCommand: async (args) => {
        if (args.tty) {
          const id = nextId++;
          open.set(id, true);
          return `Chunk ID: zzz\nWall time: 0.4 seconds\nProcess running with session ID ${id}\nOutput:\nroot@box:~# `;
        }
        return "Chunk ID: zzz\nWall time: 0.01 seconds\nProcess exited with code 0\nOutput:\n";
      },
      writeStdin: async ({ sessionId, chars }) => {
        expect(open.get(sessionId)).toBe(true);
        return `Chunk ID: yyy\nWall time: 0.1 seconds\nProcess running with session ID ${sessionId}\nOutput:\n${(chars ?? "").trim()}\n`;
      },
    };
    const svc = new SandboxChannelAService({ session });
    const opened = await svc.ptyOpen({ cols: 80, rows: 24, cwd: "" }, "pty-1");
    expect(opened.response.supportsInput).toBe(true);
    expect(opened.execSessionId).toBe(1); // recovered from the banner (was null before the fix)
    const out = await svc.ptyWrite(
      { ptyId: "pty-1", data: "echo hi\n" },
      opened.execSessionId!,
      "echo hi\n",
    );
    expect(out).toContain("echo hi");
  });

  test("ptyWrite raises a CONFLICT (not raw output) when the exec-session was lost on the live box", async () => {
    // The Modal writeStdin reports a vanished exec-session as a NON-throwing
    // banner string. Pre-fix that string ("write_stdin failed: session not
    // found: 1") was streamed verbatim into the user's xterm; now ptyWrite
    // classifies it and throws a ChannelAConflictError so the route returns 409
    // and the client cleanly re-opens the PTY against the live box.
    const session: ChannelASession = {
      supportsPty: () => true,
      execCommand: async () =>
        "Chunk ID: zzz\nWall time: 0.4 seconds\nProcess running with session ID 1\nOutput:\nroot@box:~# ",
      writeStdin: async () => "write_stdin failed: session not found: 1",
    };
    const svc = new SandboxChannelAService({ session });
    const opened = await svc.ptyOpen({ cols: 80, rows: 24, cwd: "" }, "pty-x");
    await expect(
      svc.ptyWrite({ ptyId: "pty-x", data: "x\n" }, opened.execSessionId!, "x\n"),
    ).rejects.toThrow(/pty session lost/i);
  });
});
