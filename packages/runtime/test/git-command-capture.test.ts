import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCommandCapture } from "../src/sandbox/git-command-capture";

describe("Git capture descriptor ownership", () => {
  for (const replacement of [
    "directory symlink",
    "different directory",
    "output symlink",
  ] as const) {
    test(`rejects ${replacement} without removing outside content`, async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-capture-ownership-"));
      const outside = mkdtempSync(join(tmpdir(), "opengeni-capture-outside-"));
      const name = "opengeni-git-capture-test";
      const path = join(root, name);
      const run = async (input: Parameters<typeof gitCommandCapture>[0]) => {
        const process = Bun.spawn(
          ["/bin/bash", "--noprofile", "--norc", "-c", gitCommandCapture(input)],
          {
            env: { ...globalThis.process.env, TMPDIR: root },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        return { stdout, stderr, exitCode };
      };
      try {
        writeFileSync(join(outside, "output"), "outside sentinel");
        const captured = await run({
          name,
          action: "capture",
          command: "head -c 600000 /dev/zero",
          maxBytes: 1_000_000,
          chunkBytes: 512 * 1024,
        });
        expect(captured.exitCode).toBe(0);
        const identity = /__OPENGENI_GIT_SPOOL__(\d+:\d+)/.exec(captured.stdout)?.[1];
        expect(identity).toBeDefined();
        if (replacement === "output symlink") {
          rmSync(join(path, "output"));
          symlinkSync(join(outside, "output"), join(path, "output"));
        } else {
          renameSync(path, join(root, "original"));
          if (replacement === "directory symlink") symlinkSync(outside, path);
          else renameSync(outside, path);
        }
        const read = await run({
          name,
          identity,
          action: "read",
          chunkBytes: 512 * 1024,
          offset: 512 * 1024,
          expected: 75_712,
          sizeBytes: 600_000,
          sha256: "0".repeat(64),
        });
        expect(read.exitCode).not.toBe(0);
        expect(read.stdout).not.toContain("outside sentinel");
        await run({ name, identity, action: "cleanup", chunkBytes: 512 * 1024 });
        const sentinel =
          replacement === "different directory" ? join(path, "output") : join(outside, "output");
        expect(readFileSync(sentinel, "utf8")).toBe("outside sentinel");
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }
});
