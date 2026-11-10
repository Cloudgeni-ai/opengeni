import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCompressedJsonLines, writeCompressedJsonLines } from "../src/compressed-json-lines";

describe("compressed JSON lines", () => {
  test("a file that fails while the producer is busy fails the write, removes both files and leaves nothing unhandled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compressed-json-lines-"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // The outer file cannot be created, and it fails while the inner writer
      // is still working, as when the transcript fails during the bundle read.
      const outer = writeCompressedJsonLines(
        join(directory, "missing", "outer.zst"),
        (writeOuter) =>
          writeCompressedJsonLines(join(directory, "inner.zst"), async (writeInner) => {
            for (let i = 0; i < 20; i++) {
              await writeInner(`row ${i}`);
              await new Promise((resolve) => setTimeout(resolve, 10));
              await writeOuter(`line ${i}`);
            }
          }).then(() => undefined),
      );
      await expect(outer).rejects.toMatchObject({ code: "ENOENT" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("lines written while another file is open come back as written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "compressed-json-lines-"));
    try {
      const lines = Array.from({ length: 3000 }, (_, i) =>
        JSON.stringify({ i, text: "x".repeat(i % 97) }),
      );
      const outer = await writeCompressedJsonLines(
        join(directory, "outer.zst"),
        async (writeOuter) => {
          await writeCompressedJsonLines(join(directory, "inner.zst"), async (writeInner) => {
            for (const line of lines) {
              await writeInner(line);
              await writeOuter(line);
            }
          });
        },
      );
      const read: string[] = [];
      for await (const line of readCompressedJsonLines(outer.path)) read.push(line);
      expect(read).toEqual(lines);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
