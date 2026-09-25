import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  ChannelAUnavailableError,
  ChannelAValidationError,
  SandboxChannelAService,
  validateCodeSearchRipgrepArgs,
  type ChannelASession,
} from "../src/sandbox";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A session double that runs the exact generated command in a host shell.
 * `binDir` goes first on PATH, so a fake `rg` there replaces the real one.
 */
function hostShellSession(
  root: string,
  calls: string[] = [],
  binDir?: string,
  env: Record<string, string> = {},
): ChannelASession {
  return {
    exec: async (args) => {
      calls.push(args.cmd);
      const proc = Bun.spawn(["/bin/sh", "-c", args.cmd], {
        cwd: resolve(root, args.workdir ?? "."),
        env: {
          ...process.env,
          ...(binDir ? { PATH: `${binDir}${delimiter}${process.env.PATH}` } : {}),
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
  };
}

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "code-search-"));
  roots.push(root);
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "src", "approval.ts"), "export const approvalPolicy = 'ask';\n");
  writeFileSync(join(root, "src", "nested", "other.ts"), "// approvalPolicy is read here\n");
  writeFileSync(join(root, "README.md"), "no match in this file\n");
  return root;
}

/** A directory holding an executable `rg` that runs `body` and ignores its arguments. */
function fakeRipgrep(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "code-search-bin-"));
  roots.push(dir);
  writeFileSync(join(dir, "rg"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "rg"), 0o755);
  return dir;
}

/** Peak RSS in bytes. Bun reports `maxRSS` in bytes on macOS and kilobytes on Linux. */
function peakRssBytes(): number {
  const peak = process.resourceUsage().maxRSS;
  return peak < process.memoryUsage().rss / 2 ? peak * 1024 : peak;
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** Mirrors the per-frame chunk size in channel-a.ts. */
const CHUNK_BYTES = 512 * 1024;

const hasRipgrep = Bun.which("rg") !== null;
const SEARCH = ["--null", "--line-number", "--with-filename", "--no-heading", "--color", "never"];

describe("code search ripgrep arguments", () => {
  test("accepts the scout argument set and prepends --no-config", () => {
    expect(
      validateCodeSearchRipgrepArgs([
        ...SEARCH,
        "-i",
        "-m",
        "25",
        "--max-columns",
        "8000",
        "--max-filesize",
        "4000000",
        "-g",
        "!node_modules",
        "-e",
        "(?-u:\\b)(approval|policy)",
        "--",
        "./src/",
        ".",
      ]),
    ).toEqual([
      "--no-config",
      ...SEARCH,
      "-i",
      "-m",
      "25",
      "--max-columns",
      "8000",
      "--max-filesize",
      "4000000",
      "-g",
      "!node_modules",
      "-e",
      "(?-u:\\b)(approval|policy)",
      "--",
      "./src",
      ".",
    ]);
  });

  test("rejects flags that run programs or read other files", () => {
    for (const args of [
      ["--pre", "cat", "-e", "x", "--", "."],
      ["-z", "-e", "x", "--", "."],
      ["--pre-glob", "*", "-e", "x", "--", "."],
      ["-f", "patterns.txt", "--", "."],
      ["--color", "always", "-e", "x", "--", "."],
      ["-m", "0", "-e", "x", "--", "."],
    ]) {
      expect(() => validateCodeSearchRipgrepArgs(args)).toThrow(ChannelAValidationError);
    }
  });

  test("rejects paths outside the workspace and a missing path list", () => {
    for (const args of [
      ["-e", "x", "--", "../etc"],
      ["-e", "x", "--", "/etc"],
      ["-e", "x", "--", "-rf"],
      ["-e", "x"],
      ["-e", "x", "--"],
    ]) {
      expect(() => validateCodeSearchRipgrepArgs(args)).toThrow(ChannelAValidationError);
    }
  });
});

describe("SandboxChannelAService.codeSearchRipgrep", () => {
  test.skipIf(!hasRipgrep)("returns exact ripgrep output for matches", async () => {
    const root = fixtureRepo();
    const svc = new SandboxChannelAService({ session: hostShellSession(root) });
    const result = await svc.codeSearchRipgrep([...SEARCH, "-e", "approvalPolicy", "--", "."], {
      timeoutMs: 20_000,
      maxBytes: 1024 * 1024,
    });
    expect(result.available).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    const rows = result.stdout.trim().split("\n").sort();
    expect(rows).toEqual([
      `./src/approval.ts${"\u0000"}1:export const approvalPolicy = 'ask';`,
      `./src/nested/other.ts${"\u0000"}1:// approvalPolicy is read here`,
    ]);
  });

  test.skipIf(!hasRipgrep)("reports no matches and pattern errors by exit status", async () => {
    const root = fixtureRepo();
    const svc = new SandboxChannelAService({ session: hostShellSession(root) });
    const none = await svc.codeSearchRipgrep(["-e", "zzqqnothing", "--", "."], {
      timeoutMs: 20_000,
      maxBytes: 1024,
    });
    expect(none).toMatchObject({ available: true, stdout: "", exitCode: 1, truncated: false });
    const invalid = await svc.codeSearchRipgrep(["-e", "(unclosed", "--", "."], {
      timeoutMs: 20_000,
      maxBytes: 1024,
    });
    expect(invalid.exitCode).toBe(2);
  });

  test.skipIf(!hasRipgrep)("cuts oversized output at a whole line", async () => {
    const root = fixtureRepo();
    writeFileSync(
      join(root, "big.txt"),
      Array.from({ length: 2_000 }, (_, i) => `match line ${i}`).join("\n"),
    );
    const svc = new SandboxChannelAService({ session: hostShellSession(root) });
    const result = await svc.codeSearchRipgrep(["--no-heading", "-e", "match", "--", "big.txt"], {
      timeoutMs: 20_000,
      maxBytes: 1_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stdout.endsWith("\n")).toBe(true);
    for (const line of result.stdout.trim().split("\n")) {
      expect(line).toMatch(/^match line \d+$/);
    }
  });

  test("stops a slow search at the budget and returns whole lines", async () => {
    const root = fixtureRepo();
    const pidFile = join(root, "rg.pid");
    const bin = fakeRipgrep(
      [
        `echo $$ > '${pidFile}'`,
        `awk 'BEGIN { for (i = 0; i < 100000; i++) printf "line %05d\\n", i }'`,
        "printf 'partial'",
        "exec sleep 60",
      ].join("\n"),
    );
    const svc = new SandboxChannelAService({ session: hostShellSession(root, [], bin) });
    const started = Date.now();
    const result = await svc.codeSearchRipgrep(["-e", "x", "--", "."], {
      timeoutMs: 1_000,
      maxBytes: 4 * 1024 * 1024,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result).toMatchObject({ available: true, exitCode: null, timedOut: true });
    // Some lines reach the results file before the kill; the partial record is dropped.
    expect(result.stdout).toMatch(/^(line \d{5}\n)+$/);
    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    const deadline = Date.now() + 3_000;
    while (!processIsGone(pid) && Date.now() < deadline) await Bun.sleep(50);
    expect(processIsGone(pid)).toBe(true);
  }, 20_000);

  /** Random base64 lines barely compress, so their gzip spans several frames. */
  function incompressibleOutput(lines: number): string {
    return `${Array.from({ length: lines }, () => randomBytes(60).toString("base64")).join("\n")}\n`;
  }

  test("fetches output larger than one frame in chunks and removes it from the box", async () => {
    const root = fixtureRepo();
    const tmp = mkdtempSync(join(tmpdir(), "code-search-tmp-"));
    roots.push(tmp);
    const output = incompressibleOutput(20_000);
    const outputFile = join(root, "rg-output.txt");
    writeFileSync(outputFile, output);
    const bin = fakeRipgrep(`exec cat '${outputFile}'`);
    const calls: string[] = [];
    const svc = new SandboxChannelAService({
      session: hostShellSession(root, calls, bin, { TMPDIR: tmp }),
    });
    const result = await svc.codeSearchRipgrep(["-e", "x", "--", "."], {
      timeoutMs: 20_000,
      maxBytes: 4 * 1024 * 1024,
    });
    expect(gzipSync(output).length).toBeGreaterThan(2 * CHUNK_BYTES);
    expect(result).toEqual({
      available: true,
      stdout: output,
      exitCode: 0,
      truncated: false,
      timedOut: false,
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  test("stops at the transfer cap, cuts at a whole line, and removes the output", async () => {
    const root = fixtureRepo();
    const tmp = mkdtempSync(join(tmpdir(), "code-search-tmp-"));
    roots.push(tmp);
    const output = incompressibleOutput(20_000);
    const outputFile = join(root, "rg-output.txt");
    writeFileSync(outputFile, output);
    const bin = fakeRipgrep(`exec cat '${outputFile}'`);
    const svc = new SandboxChannelAService({
      session: hostShellSession(root, [], bin, { TMPDIR: tmp }),
    });
    const result = await svc.codeSearchRipgrep(["-e", "x", "--", "."], {
      timeoutMs: 20_000,
      maxBytes: 4 * 1024 * 1024,
      maxTransferBytes: CHUNK_BYTES + 100 * 1024,
    });
    expect(result).toMatchObject({ available: true, exitCode: 0, truncated: true });
    expect(result.stdout.length).toBeGreaterThan(CHUNK_BYTES / 2);
    expect(result.stdout.length).toBeLessThan(output.length);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(output.startsWith(result.stdout)).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  }, 30_000);

  test("rejects a frame longer than one chunk", async () => {
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({
          stdout: `__OPENGENI_CODE_SEARCH_RG_BEGIN__${"A".repeat(CHUNK_BYTES * 2)}__OPENGENI_CODE_SEARCH_RG_END__0:0__`,
          stderr: "",
          exitCode: 0,
        }),
      },
    });
    await expect(
      svc.codeSearchRipgrep(["-e", "x", "--", "."], { timeoutMs: 5_000, maxBytes: 10 }),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
  });

  test("never passes a malformed output token back to the box", async () => {
    const calls: string[] = [];
    const frame = gzipSync("match\n").toString("base64");
    const svc = new SandboxChannelAService({
      session: {
        exec: async (args) => {
          calls.push(args.cmd);
          return {
            stdout: `__OPENGENI_CODE_SEARCH_RG_BEGIN__${frame}__OPENGENI_CODE_SEARCH_RG_END__0:0:9999999:..__`,
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });
    await expect(
      svc.codeSearchRipgrep(["-e", "x", "--", "."], { timeoutMs: 5_000, maxBytes: 1_000 }),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
    expect(calls).toHaveLength(1);
  });

  test("bounds inflation of a hostile compressed frame", async () => {
    // Concatenated gzip members inflate about 500x; one chunk of them expands
    // to over 200 MB if decoding is unbounded.
    const member = gzipSync(Buffer.alloc(1024 * 1024, "match line\n"), { level: 9 });
    const copies = Math.floor(CHUNK_BYTES / member.length);
    const frame = Buffer.concat(Array.from({ length: copies }, () => member)).toString("base64");
    expect(copies).toBeGreaterThan(200);
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({
          stdout: `__OPENGENI_CODE_SEARCH_RG_BEGIN__${frame}__OPENGENI_CODE_SEARCH_RG_END__0:0__`,
          stderr: "",
          exitCode: 0,
        }),
      },
    });
    const peakBefore = peakRssBytes();
    const result = await svc.codeSearchRipgrep(["-e", "x", "--", "."], {
      timeoutMs: 5_000,
      maxBytes: 1_000,
    });
    expect(peakRssBytes() - peakBefore).toBeLessThan(128 * 1024 * 1024);
    expect(result).toMatchObject({ available: true, exitCode: 0, truncated: true });
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stdout).toMatch(/^(match line\n)+$/);
  });

  test("fails closed on a frame that is not gzip", async () => {
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({
          stdout: `__OPENGENI_CODE_SEARCH_RG_BEGIN__${Buffer.from("not gzip").toString("base64")}__OPENGENI_CODE_SEARCH_RG_END__0:0__`,
          stderr: "",
          exitCode: 0,
        }),
      },
    });
    await expect(
      svc.codeSearchRipgrep(["-e", "x", "--", "."], { timeoutMs: 5_000, maxBytes: 10 }),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
  });

  test("reports a box without ripgrep as unavailable", async () => {
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({
          stdout: "__OPENGENI_CODE_SEARCH_RG_END__127:0__",
          stderr: "",
          exitCode: 0,
        }),
      },
    });
    expect(
      await svc.codeSearchRipgrep(["-e", "x", "--", "."], { timeoutMs: 5_000, maxBytes: 10 }),
    ).toEqual({
      available: false,
      stdout: "",
      exitCode: null,
      truncated: false,
      timedOut: false,
    });
  });

  test("fails closed when the provider drops the trailer", async () => {
    const svc = new SandboxChannelAService({
      session: {
        exec: async () => ({
          stdout: "__OPENGENI_CODE_SEARCH_RG_BEGIN__H4sI",
          stderr: "",
          exitCode: 0,
        }),
      },
    });
    await expect(
      svc.codeSearchRipgrep(["-e", "x", "--", "."], { timeoutMs: 5_000, maxBytes: 10 }),
    ).rejects.toBeInstanceOf(ChannelAUnavailableError);
  });

  test("does not use GNU timeout", async () => {
    const calls: string[] = [];
    const svc = new SandboxChannelAService({
      session: {
        exec: async (args) => {
          calls.push(args.cmd);
          return { stdout: "__OPENGENI_CODE_SEARCH_RG_END__127:0__", stderr: "", exitCode: 0 };
        },
      },
    });
    await svc.codeSearchRipgrep(["-e", "x", "--", "."], { timeoutMs: 5_000, maxBytes: 10 });
    expect(calls[0]).not.toMatch(/(^|[;&|()\s])timeout([;&|()\s]|$)/);
  });
});

describe("SandboxChannelAService.codeSearchPathKinds", () => {
  test("classifies files, directories and missing paths", async () => {
    const root = fixtureRepo();
    const svc = new SandboxChannelAService({ session: hostShellSession(root) });
    expect(await svc.codeSearchPathKinds(["src", "src/approval.ts", "missing/dir", "."])).toEqual({
      src: "directory",
      "src/approval.ts": "file",
      "missing/dir": "missing",
      ".": "directory",
    });
  });

  test("rejects traversal", async () => {
    const svc = new SandboxChannelAService({ session: hostShellSession(fixtureRepo()) });
    await expect(svc.codeSearchPathKinds(["../outside"])).rejects.toBeInstanceOf(
      ChannelAValidationError,
    );
  });
});
