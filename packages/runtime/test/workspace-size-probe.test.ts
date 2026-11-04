import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRemoteWorkspaceSize } from "../src/sandbox/workspace-archive";

const linuxTest = test.skipIf(process.platform !== "linux");

async function probeScript(ephemeral: string[] = []): Promise<string> {
  let script = "";
  await probeRemoteWorkspaceSize({
    state: { manifest: { ephemeralPersistencePaths: () => new Set(ephemeral) } },
    async exec(input: { cmd: string }) {
      script = input.cmd;
      return { stdout: "", exitCode: 0 };
    },
  });
  return script;
}

function runIn(root: string, script: string): string {
  const result = Bun.spawnSync(["/bin/bash", "-c", script.replace("cd /workspace", `cd ${root}`)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return Buffer.from(result.stdout).toString("utf8").trim();
}

describe("workspace size probe", () => {
  test("parses the walk's summary line", async () => {
    expect(
      await probeRemoteWorkspaceSize({
        async exec() {
          return { stdout: "OPENGENI_WORKSPACE_SIZE_V1 12 3456\n", exitCode: 0 };
        },
      }),
    ).toEqual({ fileCount: 12, totalFileBytes: 3456 });
    expect(
      await probeRemoteWorkspaceSize({
        async exec() {
          return { stdout: "", exitCode: 0 };
        },
      }),
    ).toBeNull();
  });

  linuxTest("leaves out the session's ephemeral paths, like the archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-size-probe-"));
    try {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "mnt/data"), { recursive: true });
      writeFileSync(join(root, "src/a.ts"), "1234");
      writeFileSync(join(root, "b.txt"), "56");
      writeFileSync(join(root, "mnt/data/big.bin"), "x".repeat(100));
      expect(runIn(root, await probeScript())).toBe("OPENGENI_WORKSPACE_SIZE_V1 3 106");
      expect(runIn(root, await probeScript(["mnt"]))).toBe("OPENGENI_WORKSPACE_SIZE_V1 2 6");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
    "an unreadable folder still measures the rest",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-size-probe-"));
      try {
        writeFileSync(join(root, "kept.txt"), "abc");
        mkdirSync(join(root, "locked"));
        writeFileSync(join(root, "locked/hidden.txt"), "zz");
        chmodSync(join(root, "locked"), 0o000);
        expect(runIn(root, await probeScript())).toBe("OPENGENI_WORKSPACE_SIZE_V1 1 3");
      } finally {
        chmodSync(join(root, "locked"), 0o700);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
