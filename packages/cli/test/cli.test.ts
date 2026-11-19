import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_EXIT, OPENGENI_CLI_VERSION, runCli } from "../src/index";

const packageRoot = join(import.meta.dir, "..");
const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
};

async function capture(
  argv: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env,
    fetch: () => {
      throw new Error("no request expected");
    },
  });
  return { exitCode, stdout, stderr };
}

describe("runCli", () => {
  test("prints the package version", async () => {
    expect(OPENGENI_CLI_VERSION).toBe(manifest.version);
    for (const flag of ["--version", "-v", "version"]) {
      expect(await capture([flag])).toEqual({
        exitCode: CLI_EXIT.ok,
        stdout: `${manifest.version}\n`,
        stderr: "",
      });
    }
  });

  test("prints usage for help and for no arguments", async () => {
    for (const argv of [
      [],
      ["--help"],
      ["-h"],
      ["help"],
      ["agents", "--help"],
      ["agents", "deploy", "--help"],
    ]) {
      const result = await capture(argv);
      expect(result.exitCode).toBe(CLI_EXIT.ok);
      expect(result.stdout).toContain("Usage: opengeni <command>");
      expect(result.stdout).toContain("agents deploy [dir]");
      expect(result.stdout).toContain("agents export <key>");
      expect(result.stderr).toBe("");
    }
  });

  test("agents deploy without an API key or organization explains what to set", async () => {
    const result = await capture(["agents", "deploy", "./agents", "--dry-run"]);
    expect(result.exitCode).toBe(CLI_EXIT.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPENGENI_API_KEY");
    expect(result.stderr).toContain("OPENGENI_ORGANIZATION_ID");
  });

  test("unknown options and extra arguments are usage errors", async () => {
    const env = { OPENGENI_API_KEY: "key", OPENGENI_ORGANIZATION_ID: "org" };
    expect((await capture(["agents", "deploy", "--nope"], env)).stderr).toContain(
      "unknown option --nope",
    );
    expect((await capture(["agents", "deploy", "a", "b"], env)).stderr).toContain(
      "expected one directory",
    );
    expect((await capture(["agents", "deploy", "--organization"], env)).stderr).toContain(
      "--organization needs a value",
    );
    expect((await capture(["agents", "export"], env)).stderr).toContain("expected the agent key");
    expect((await capture(["agents", "deploy", "--out", "x"], env)).exitCode).toBe(CLI_EXIT.usage);
  });

  test("unknown commands print usage and exit 1", async () => {
    for (const argv of [["deploy"], ["agents"], ["agents", "list"], ["--nope"]]) {
      const result = await capture(argv);
      expect(result.exitCode).toBe(CLI_EXIT.usage);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage: opengeni <command>");
    }
    expect((await capture(["deploy"])).stderr).toStartWith("Unknown command: opengeni deploy");
  });
});

describe("opengeni executable", () => {
  let bundleDirectory: string | undefined;
  afterAll(() => {
    if (bundleDirectory) rmSync(bundleDirectory, { recursive: true, force: true });
  });

  async function run(command: string[], env: Record<string, string> = {}) {
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  test("declares the opengeni bin and ships the agent schema", () => {
    expect(manifest.name).toBe("opengeni");
    expect(manifest.bin).toEqual({ opengeni: "./dist/bin/opengeni.cjs" });
    expect(manifest.files).toContain("schemas");
  });

  test("the source entry runs under Bun", async () => {
    const entry = join(packageRoot, "src", "bin.ts");
    expect(await run([process.execPath, entry, "--version"])).toEqual({
      exitCode: 0,
      stdout: `${manifest.version}\n`,
      stderr: "",
    });
    expect((await run([process.execPath, entry, "agents", "deploy"])).exitCode).toBe(1);
    expect((await run([process.execPath, entry, "unknown"])).exitCode).toBe(1);
  });

  test("the Node CommonJS bundle runs under Node", async () => {
    const node = Bun.which("node");
    if (!node && process.env.CI) throw new Error("node is required for the opengeni Node check");
    if (!node) return;
    bundleDirectory = mkdtempSync(join(tmpdir(), "opengeni-cli-bundle-"));
    const bundle = await Bun.build({
      entrypoints: [join(packageRoot, "src", "bin.ts")],
      outdir: bundleDirectory,
      naming: "opengeni.cjs",
      format: "cjs",
      target: "node",
      banner: "#!/usr/bin/env node",
    });
    expect(bundle.success).toBe(true);
    const executable = join(bundleDirectory, "opengeni.cjs");
    expect(await run([node, executable, "--version"])).toEqual({
      exitCode: 0,
      stdout: `${manifest.version}\n`,
      stderr: "",
    });
    expect((await run([node, executable, "--help"])).stdout).toContain("Usage: opengeni");
    const deploy = await run([node, executable, "agents", "deploy", ".", "--dry-run"]);
    expect(deploy.exitCode).toBe(1);
    expect(deploy.stderr).toContain("OPENGENI_API_KEY");
    expect((await run([node, executable, "unknown"])).exitCode).toBe(1);
    // Validation runs in the bundle too (zod and yaml are bundled).
    const fixtures = join(import.meta.dir, "fixtures", "invalid-agents");
    const invalid = await run([node, executable, "agents", "deploy", fixtures], {
      OPENGENI_API_KEY: "key",
      OPENGENI_ORGANIZATION_ID: "org",
      OPENGENI_BASE_URL: "http://127.0.0.1:9",
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("nothing was deployed");
  });
});
