import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LIGHTPANDA_BINARY_SHA256,
  LIGHTPANDA_VERSION,
  LightpandaRunner,
  resolvePinnedLightpandaBinary,
  type ResolvedLightpandaBinary,
} from "../src";

describe("Lightpanda native lifecycle", () => {
  test("rejects unpinned and indirect native executables", async () => {
    const directory = await mkdtemp("/tmp/ogb-lightpanda-binary-");
    const binary = join(directory, "lightpanda");
    const link = join(directory, "lightpanda-link");
    try {
      await writeFile(binary, "not the pinned executable", { mode: 0o755 });
      await symlink(binary, link);
      await expect(resolvePinnedLightpandaBinary({ binaryPath: binary })).rejects.toThrow(
        "digest mismatch",
      );
      await expect(resolvePinnedLightpandaBinary({ binaryPath: link })).rejects.toThrow(
        "exact regular file",
      );
      await expect(
        resolvePinnedLightpandaBinary({
          binaryPath: binary,
          platform: "win32",
          architecture: "arm64",
        }),
      ).rejects.toThrow("does not publish a binary");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("starts once, reuses its private endpoint, and terminates the exact child", async () => {
    const directory = await mkdtemp("/tmp/ogb-lightpanda-runner-");
    const binaryPath = join(directory, "fixture-lightpanda");
    const startsPath = join(directory, "starts");
    const script = `#!${process.execPath}\nimport { appendFile } from 'node:fs/promises';\nawait appendFile(${JSON.stringify(startsPath)}, 'start\\n');\nawait Bun.sleep(80);\nprocess.stderr.write('$msg="server running" address=127.0.0.1:43210\\n');\nawait new Promise((resolve) => process.once('SIGTERM', resolve));\n`;
    await writeFile(binaryPath, script, { mode: 0o700 });
    await chmod(binaryPath, 0o700);
    const binary: ResolvedLightpandaBinary = {
      path: binaryPath,
      name:
        process.platform === "darwin"
          ? process.arch === "arm64"
            ? "lightpanda-aarch64-macos"
            : "lightpanda-x86_64-macos"
          : process.arch === "arm64"
            ? "lightpanda-aarch64-linux"
            : "lightpanda-x86_64-linux",
      version: LIGHTPANDA_VERSION,
      sha256:
        LIGHTPANDA_BINARY_SHA256[
          process.platform === "darwin"
            ? process.arch === "arm64"
              ? "lightpanda-aarch64-macos"
              : "lightpanda-x86_64-macos"
            : process.arch === "arm64"
              ? "lightpanda-aarch64-linux"
              : "lightpanda-x86_64-linux"
        ],
    };
    const runner = await LightpandaRunner.create({
      binary,
      sessionDirectory: join(directory, "session"),
    });
    try {
      const abort = new AbortController();
      const abandoned = runner.run<{ cdpUrl: string }>(["get", "cdp-url"], {
        signal: abort.signal,
      });
      abort.abort();
      await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
      expect(await runner.run<{ cdpUrl: string }>(["get", "cdp-url"])).toEqual({
        cdpUrl: "ws://127.0.0.1:43210/",
      });
      expect(await runner.run<{ cdpUrl: string }>(["get", "cdp-url"])).toEqual({
        cdpUrl: "ws://127.0.0.1:43210/",
      });
      expect(await readFile(startsPath, "utf8")).toBe("start\n");
    } finally {
      await runner.terminate();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
