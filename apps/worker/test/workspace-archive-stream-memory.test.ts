import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Saving and restoring a remote sandbox's workspace archive must not hold the
// archive in the worker's memory: a 578 MB workspace once grew a worker to
// 16 GB. The archive streams between the box and a private disk spool in
// small chunks, so the worker's peak memory must not grow with its size.
//
// The workspace is mostly one sparse file: cheap on disk, but its zeros are
// real bytes in the tar, so the archive is the full size.
const SPARSE_FILE_BYTES = 384 * 1024 * 1024;
const RANDOM_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PEAK_GROWTH_BYTES = 96 * 1024 * 1024;

const fixture = join(import.meta.dir, "fixtures/workspace-archive-stream-memory.ts");

async function phase(name: "save" | "restore", scratch: string) {
  const child = Bun.spawn([process.execPath, fixture, name, scratch], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${name} phase failed (${exitCode}): ${stderr}`);
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as {
    peakGrowthBytes: number;
    archiveBytes?: number;
    streamed?: boolean;
  };
}

test.skipIf(process.platform !== "linux")(
  "a remote workspace archive saves and restores without growing worker memory with its size",
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opengeni-archive-memory-"));
    try {
      const source = join(scratch, "source");
      await mkdir(join(source, "src"), { recursive: true });
      await writeFile(join(source, "large.bin"), "");
      await truncate(join(source, "large.bin"), SPARSE_FILE_BYTES);
      await writeFile(join(source, "random.bin"), randomBytes(RANDOM_FILE_BYTES));
      await writeFile(join(source, "src/index.ts"), "export const answer = 42;\n");

      const saved = await phase("save", scratch);
      console.info(`archive ${saved.archiveBytes} bytes: save peak +${saved.peakGrowthBytes}`);
      expect(saved.archiveBytes).toBeGreaterThan(SPARSE_FILE_BYTES + RANDOM_FILE_BYTES);
      expect(saved.peakGrowthBytes).toBeLessThan(MAX_PEAK_GROWTH_BYTES);
      expect(saved.streamed).toBe(true);

      const restored = await phase("restore", scratch);
      console.info(`restore peak +${restored.peakGrowthBytes}`);
      expect(restored.peakGrowthBytes).toBeLessThan(MAX_PEAK_GROWTH_BYTES);
      // Cold restore verified the restored tree's fingerprint against the
      // descriptor; the files are there at their full size.
      const restoredRoot = join(scratch, "restored");
      expect((await readdir(restoredRoot)).sort()).toEqual(["large.bin", "random.bin", "src"]);
      expect((await stat(join(restoredRoot, "large.bin"))).size).toBe(SPARSE_FILE_BYTES);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  240_000,
);
