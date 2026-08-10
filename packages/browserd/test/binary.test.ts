import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePinnedAgentBrowserBinary } from "../src";

describe("pinned agent-browser binary resolution", () => {
  test("accepts the exact packaged binary through the explicit image path", async () => {
    const packaged = await resolvePinnedAgentBrowserBinary();
    const explicit = await resolvePinnedAgentBrowserBinary({ binaryPath: packaged.path });
    expect(explicit).toEqual(packaged);
  });

  test("rejects ambiguous sources and a modified explicit binary", async () => {
    await expect(
      resolvePinnedAgentBrowserBinary({ binaryPath: "/tmp/native", packageRoot: "/tmp/package" }),
    ).rejects.toThrow("mutually exclusive");

    const directory = await mkdtemp("/tmp/ogb-binary-");
    const path = join(directory, "agent-browser");
    try {
      await writeFile(path, "not the pinned native binary", { mode: 0o755 });
      await chmod(path, 0o755);
      await expect(resolvePinnedAgentBrowserBinary({ binaryPath: path })).rejects.toThrow(
        "digest mismatch",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
