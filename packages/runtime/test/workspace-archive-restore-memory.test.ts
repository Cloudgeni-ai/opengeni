import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Restoring a workspace archive must cost memory proportional to the archive,
// with a small constant: the restore holds the fetched bytes, one base64 copy
// and one decoded copy. Copying a decoded Node Buffer with `Uint8Array.from`
// walks it through Bun's generic iterator path, which used about 16x the
// archive in transient memory per copy, so a few-hundred-MB workspace could
// take a worker past 15 GB during a cold restore.
const ARCHIVE_BYTES = 48 * 1024 * 1024;
const MAX_PEAK_GROWTH_ARCHIVE_MULTIPLE = 6;

const fixture = fileURLToPath(
  new URL("./fixtures/workspace-archive-restore-memory.ts", import.meta.url),
);

describe("workspace archive restore memory", () => {
  test.skipIf(process.platform !== "linux")(
    "restoring an object-storage archive peaks at a small multiple of its size",
    async () => {
      const child = Bun.spawn([process.execPath, fixture, String(ARCHIVE_BYTES)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const { peakGrowthBytes } = JSON.parse(stdout) as { peakGrowthBytes: number };
      expect(peakGrowthBytes / ARCHIVE_BYTES).toBeLessThan(MAX_PEAK_GROWTH_ARCHIVE_MULTIPLE);
    },
    60_000,
  );
});
