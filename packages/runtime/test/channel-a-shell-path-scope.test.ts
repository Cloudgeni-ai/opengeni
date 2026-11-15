import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxChannelAService } from "../src/sandbox/channel-a";

const root = mkdtempSync(join(tmpdir(), "opengeni-shell-scope-root-"));
const scratch = mkdtempSync(join(tmpdir(), "opengeni-shell-scope-tmp-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});
writeFileSync(join(scratch, "report.pdf"), "scratch output");
writeFileSync(join(root, "inside.txt"), "inside");
symlinkSync(join(scratch, "report.pdf"), join(root, "linked.pdf"));

const bash = async ({ cmd }: { cmd: string }) => {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", cmd], { encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
};

/** A managed box: native reads are confined to the workspace, the shell is not. */
function managed() {
  return new SandboxChannelAService({
    workspaceRoot: root,
    session: {
      async readFile() {
        throw new Error("path resolves outside workspace");
      },
      exec: bash,
    },
  });
}

const read = { encoding: "utf8" as const, maxBytes: 1024 };

describe("shell-scoped file reads", () => {
  test("a managed box reads a file outside the workspace that its shell can read", async () => {
    const service = managed();
    const outside = join(scratch, "report.pdf");
    expect((await service.fsRead({ ...read, path: outside }, { pathScope: "shell" })).content).toBe(
      "scratch output",
    );
    // Relative paths resolve from the workspace root, as in the shell.
    const relative = `../${scratch.split("/").at(-1)}/report.pdf`;
    expect(
      (await service.fsRead({ ...read, path: relative }, { pathScope: "shell" })).content,
    ).toBe("scratch output");
    expect(
      (await service.fsRead({ ...read, path: "linked.pdf" }, { pathScope: "shell" })).content,
    ).toBe("scratch output");
    expect(
      (await service.fsRead({ ...read, path: "inside.txt" }, { pathScope: "shell" })).content,
    ).toBe("inside");
  });

  test("the default workspace scope stays confined", async () => {
    const service = managed();
    await expect(service.fsRead({ ...read, path: join(scratch, "report.pdf") })).rejects.toThrow(
      /outside/,
    );
    await expect(service.digestWorkspaceFile(join(scratch, "report.pdf"))).rejects.toThrow(
      /outside/,
    );
  });

  test("a missing file is still not found", async () => {
    await expect(
      managed().fsRead({ ...read, path: join(scratch, "missing.pdf") }, { pathScope: "shell" }),
    ).rejects.toThrow(/not found/);
  });

  test("a large file outside the workspace is digested where it lives", async () => {
    const digest = await managed().digestWorkspaceFile(join(scratch, "report.pdf"), {
      pathScope: "shell",
    });
    expect(digest.sizeBytes).toBe("scratch output".length);
    expect(digest.sha256).toBe(createHash("sha256").update("scratch output").digest("hex"));
  });

  test("a Connected Machine reads the absolute host path natively", async () => {
    const reads: string[] = [];
    const service = new SandboxChannelAService({
      workspaceRoot: root,
      providerPathMode: "workspace-relative",
      fileReadScope: "machine",
      session: {
        async readFile({ path }) {
          reads.push(path);
          return Buffer.from("machine bytes");
        },
      },
    });
    const result = await service.fsRead(
      { ...read, path: "../elsewhere/out.csv" },
      { pathScope: "shell" },
    );
    expect(result.content).toBe("machine bytes");
    expect(reads).toEqual([join(root, "..", "elsewhere", "out.csv")]);
  });
});
