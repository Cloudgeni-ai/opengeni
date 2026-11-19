import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinary } from "../build-binary";
import { CLI_EXIT, OPENGENI_CLI_VERSION, runCli } from "../src/index";

const packageRoot = join(import.meta.dir, "..");
const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as {
  name: string;
  version: string;
  bin: Record<string, string>;
};

function capture(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const exitCode = runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

describe("runCli", () => {
  test("prints the package version", () => {
    expect(OPENGENI_CLI_VERSION).toBe(manifest.version);
    for (const flag of ["--version", "-v", "version"]) {
      expect(capture([flag])).toEqual({
        exitCode: CLI_EXIT.ok,
        stdout: `${manifest.version}\n`,
        stderr: "",
      });
    }
  });

  test("prints usage for help and for no arguments", () => {
    for (const argv of [[], ["--help"], ["-h"], ["help"], ["agents", "--help"]]) {
      const result = capture(argv);
      expect(result.exitCode).toBe(CLI_EXIT.ok);
      expect(result.stdout).toContain("Usage: opengeni <command>");
      expect(result.stdout).toContain("agents deploy [dir] [--dry-run] [--publish]");
      expect(result.stderr).toBe("");
    }
  });

  test("agents deploy explains it is not available yet and exits 2", () => {
    for (const argv of [
      ["agents", "deploy"],
      ["agents", "deploy", "./agents", "--dry-run"],
      ["agents", "deploy", "--publish", "agents"],
    ]) {
      const result = capture(argv);
      expect(result.exitCode).toBe(CLI_EXIT.unavailable);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toContain("not available");
      expect(result.stderr).toContain(manifest.version);
      expect(result.stderr).toContain("Update the opengeni package");
    }
  });

  test("unknown commands print usage and exit 1", () => {
    for (const argv of [["deploy"], ["agents"], ["agents", "list"], ["--nope"]]) {
      const result = capture(argv);
      expect(result.exitCode).toBe(CLI_EXIT.usage);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage: opengeni <command>");
    }
    expect(capture(["deploy"]).stderr).toStartWith("Unknown command: opengeni deploy");
  });
});

describe("opengeni executable", () => {
  let bundleDirectory: string | undefined;
  afterAll(() => {
    if (bundleDirectory) rmSync(bundleDirectory, { recursive: true, force: true });
  });

  async function run(command: string[]) {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  test("declares the opengeni bin", () => {
    expect(manifest.name).toBe("opengeni");
    expect(manifest.bin).toEqual({ opengeni: "./dist/bin/opengeni.cjs" });
  });

  test("the source entry runs under Bun", async () => {
    const entry = join(packageRoot, "src", "bin.ts");
    expect(await run([process.execPath, entry, "--version"])).toEqual({
      exitCode: 0,
      stdout: `${manifest.version}\n`,
      stderr: "",
    });
    expect((await run([process.execPath, entry, "agents", "deploy"])).exitCode).toBe(2);
    expect((await run([process.execPath, entry, "unknown"])).exitCode).toBe(1);
  });

  test("the shipped Node CommonJS executable runs under Node", async () => {
    const node = Bun.which("node");
    if (!node && process.env.CI) throw new Error("node is required for the opengeni Node check");
    bundleDirectory = mkdtempSync(join(tmpdir(), "opengeni-cli-bundle-"));
    // The same build step package build.ts runs for dist/bin/opengeni.cjs.
    const executable = await buildBinary(join(bundleDirectory, "bin"));
    expect((await Bun.file(executable).text()).startsWith("#!/usr/bin/env node\n")).toBe(true);
    if (!node) return;
    // The shebang makes it directly executable, as npm's bin link runs it.
    expect((await run([executable, "--version"])).stdout).toBe(`${manifest.version}\n`);
    expect(await run([node, executable, "--version"])).toEqual({
      exitCode: 0,
      stdout: `${manifest.version}\n`,
      stderr: "",
    });
    expect((await run([node, executable, "--help"])).stdout).toContain("Usage: opengeni");
    const deploy = await run([node, executable, "agents", "deploy", ".", "--dry-run"]);
    expect(deploy.exitCode).toBe(2);
    expect(deploy.stderr).toContain("not available");
    expect((await run([node, executable, "unknown"])).exitCode).toBe(1);
  });
});
