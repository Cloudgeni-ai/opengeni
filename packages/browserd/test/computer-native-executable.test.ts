import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareComputerNativeExecutable } from "../src/computer-native-executable";

test("isolates concurrent macOS executable identities and cleans only owned copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-executable-test-"));
  const source = join(directory, "helper");
  await writeFile(source, "signed helper bytes");
  try {
    const a = await prepareComputerNativeExecutable(source, "darwin");
    const b = await prepareComputerNativeExecutable(source, "darwin");
    try {
      expect(a.path).not.toBe(b.path);
      expect(await readFile(a.path, "utf8")).toBe("signed helper bytes");
      expect((await stat(a.path)).mode & 0o777).toBe(0o700);
      await a.cleanup();
      expect(await readFile(b.path, "utf8")).toBe("signed helper bytes");
      expect(await readFile(source, "utf8")).toBe("signed helper bytes");
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
    const linux = await prepareComputerNativeExecutable(source, "linux");
    expect(linux.path).toBe(source);
    await linux.cleanup();
    expect(await readFile(source, "utf8")).toBe("signed helper bytes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
