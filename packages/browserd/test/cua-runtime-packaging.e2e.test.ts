import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageCuaRuntime } from "../scripts/stage-cua-runtime";

// This can run on a locked or headless Mac. It does not grant permissions,
// capture the desktop, discover apps or deliver input.
test.skipIf(process.platform !== "darwin" || process.env.OPENGENI_CUA_PACKAGING_E2E !== "1")(
  "compiled CUA loads only its adjacent release-contained assets",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-cua-package-"));
    try {
      const staged = dirname(await stageCuaRuntime(process.arch));
      for (const directory of ["cua-sdk", "node_modules"])
        await cp(join(staged, directory), join(root, directory), { recursive: true });
      const binary = join(root, "probe");
      const run = async (args: string[]) => {
        const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, exitCode };
      };
      const build = await run([
        process.execPath,
        "build",
        "--compile",
        join(import.meta.dir, "fixtures/cua/PackagedProbe.ts"),
        "--outfile",
        binary,
      ]);
      if (build.exitCode !== 0) throw new Error(build.stderr);
      const signed = await run(["codesign", "--force", "--sign", "-", "--timestamp=none", binary]);
      if (signed.exitCode !== 0) throw new Error(signed.stderr);
      const loaded = await run([binary]);
      if (loaded.exitCode !== 0) throw new Error(loaded.stderr);
      expect(JSON.parse(loaded.stdout)).toEqual({ permissionsRead: true });
      await rm(join(root, "cua-sdk"), { recursive: true });
      const absent = await run([binary]);
      expect(absent.exitCode).not.toBe(0);
      expect(absent.stderr).toContain("does not contain the experimental CUA SDK");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
