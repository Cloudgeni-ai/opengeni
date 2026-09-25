import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** A session double that runs the exact generated command in a host shell. */
function hostShellSession(root: string, calls: string[] = []): ChannelASession {
  return {
    exec: async (args) => {
      calls.push(args.cmd);
      const proc = Bun.spawn(["/bin/sh", "-c", args.cmd], {
        cwd: resolve(root, args.workdir ?? "."),
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
