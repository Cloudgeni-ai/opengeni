import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { confinedFileReadScript, parseConfinedFileRead } from "../src/sandbox/confined-file-read";
import { SandboxChannelAService } from "../src/sandbox/channel-a";
import { OpenSandboxSession } from "../src/sandbox/providers/opensandbox-adapter";

const root = mkdtempSync(join(tmpdir(), "opengeni-confined-read-"));
const outside = mkdtempSync(join(tmpdir(), "opengeni-outside-read-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function run(script: string) {
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

describe("race-safe confined file reads", () => {
  test("caps a giant single line in bytes and preserves arbitrary binary bytes", () => {
    const bytes = Buffer.from([0, 1, 255, 254, ...Array(1024).fill(65)]);
    writeFileSync(join(root, "large.bin"), bytes);
    const result = run(confinedFileReadScript(root, "large.bin", 4));
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(parseConfinedFileRead(result.stdout, 4)!)).toEqual(bytes.subarray(0, 4));
    expect(parseConfinedFileRead(result.stdout, 3)).toBeNull();
    expect(parseConfinedFileRead(result.stdout.replace(/END__/u, "END_"), 4)).toBeNull();
  });

  test("rejects escaping and internal symlinks, traversal and non-regular files", () => {
    writeFileSync(join(outside, "secret"), "dummy private bytes");
    symlinkSync(join(outside, "secret"), join(root, "escape"));
    symlinkSync(join(root, "large.bin"), join(root, "internal"));
    symlinkSync(outside, join(root, "escape-dir"));
    for (const path of ["escape", "internal", "escape-dir/secret", "../secret", "."]) {
      const result = run(confinedFileReadScript(root, path, 64));
      expect(result.exitCode, `${path}: ${result.stdout} ${result.stderr}`).toBe(67);
      expect(result.stdout).not.toContain("dummy private");
    }
  });

  test("a directory swap after opening retains its original descriptor", () => {
    mkdirSync(join(root, "swap"));
    writeFileSync(join(root, "swap", "value"), "inside");
    writeFileSync(join(outside, "value"), "outside");
    const script = confinedFileReadScript(root, "swap/value", 64).replace(
      "    fd = os.open(parts[-1]",
      `    os.rename(${JSON.stringify(join(root, "swap"))}, ${JSON.stringify(join(root, "original"))})\n` +
        `    os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(join(root, "swap"))})\n` +
        "    fd = os.open(parts[-1]",
    );
    const result = run(script);
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(parseConfinedFileRead(result.stdout, 64)!).toString()).toBe("inside");
  });

  test("a final-file swap between lstat and open is rejected by inode identity", () => {
    writeFileSync(join(root, "race"), "inside");
    writeFileSync(join(outside, "race"), "outside");
    const script = confinedFileReadScript(root, "race", 64).replace(
      "    fd = os.open(parts[-1]",
      `    os.rename(${JSON.stringify(join(root, "race"))}, ${JSON.stringify(join(root, "race-original"))})\n` +
        `    os.symlink(${JSON.stringify(join(outside, "race"))}, ${JSON.stringify(join(root, "race"))})\n` +
        "    fd = os.open(parts[-1]",
    );
    const result = run(script);
    expect(result.exitCode).toBe(67);
    expect(result.stdout).toBe("");
  });

  test("workspaceOnly rejects Windows outside roots before dispatch and unsupported roots fail closed", async () => {
    let commands = 0;
    const service = new SandboxChannelAService({
      workspaceRoot: "C:/repo",
      fileReadScope: "machine",
      session: {
        exec: async () => {
          commands++;
          return { stdout: "", exitCode: 67 };
        },
      },
    });
    await expect(
      service.fsRead({
        path: "D:/private/data",
        maxBytes: 4,
        encoding: "base64",
        workspaceOnly: true,
      }),
    ).rejects.toThrow(/outside/);
    expect(commands).toBe(0);
    const result = run(confinedFileReadScript("C:/repo", "inside.txt", 4));
    expect(result.exitCode).toBe(67);
    expect(result.stdout).toBe("");
  });

  test("native providers cannot return more bytes than requested", async () => {
    const service = new SandboxChannelAService({
      workspaceRoot: "/workspace",
      session: { readFile: async () => "oversized result" },
    });
    const read = await service.fsRead({ path: "a", maxBytes: 4, encoding: "utf8" });
    expect(read.content).toBe("over");
    expect(read.sizeBytes).toBe(4);
    expect(read.truncated).toBe(true);
  });

  test("Connected Machine workspaceOnly reads cannot escape via absolute paths or symlinks", async () => {
    let nativeReads = 0;
    const service = new SandboxChannelAService({
      workspaceRoot: root,
      fileReadScope: "machine",
      session: {
        readFile: async () => {
          nativeReads++;
          return "must not call";
        },
        exec: async ({ cmd }) => {
          const result = spawnSync("bash", ["--noprofile", "--norc", "-c", cmd], {
            encoding: "utf8",
          });
          return { stdout: result.stdout, exitCode: result.status };
        },
      },
    });
    const request = { encoding: "base64" as const, maxBytes: 4, workspaceOnly: true };
    expect((await service.fsRead({ ...request, path: "./large.bin" })).sizeBytes).toBe(4);
    expect((await service.fsRead({ ...request, path: join(root, "large.bin") })).sizeBytes).toBe(4);
    for (const path of [join(outside, "secret"), "../secret", "escape", "escape-dir/secret"]) {
      await expect(service.fsRead({ ...request, path })).rejects.toThrow();
    }
    expect(nativeReads).toBe(0);
  });

  test("OpenSandbox adapter uses confined descriptors, never line-limit file downloads", async () => {
    const session = new OpenSandboxSession({
      state: { sandboxId: "test" } as never,
      options: {} as never,
    });
    const commands: string[] = [];
    session.exec = async ({ cmd }) => {
      commands.push(cmd);
      // Simulate the provider's /workspace mount with an actual local filesystem.
      const mapped = cmd.replace('root = "/workspace"', `root = ${JSON.stringify(root)}`);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", mapped], {
        encoding: "utf8",
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.status,
        wallTimeSeconds: 0,
      };
    };
    expect(await session.readFile({ path: "large.bin", maxBytes: 4 })).toEqual(
      new Uint8Array([0, 1, 255, 254]),
    );
    for (const path of ["escape", "escape-dir/secret", "internal"]) {
      await expect(session.readFile({ path, maxBytes: 64 })).rejects.toThrow(/symlink/);
    }
    await expect(session.readFile({ path: "missing", maxBytes: 64 })).rejects.toMatchObject({
      name: "SandboxWorkspaceReadNotFoundError",
    });
    expect(commands.every((cmd) => cmd.includes("python3 -I -S -c"))).toBe(true);
  });
});
