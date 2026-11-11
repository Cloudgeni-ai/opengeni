import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { computerNativeMacWindows } from "../src/cua/macos-windows";

test("a screen check whose helper hangs gives up instead of stalling the computer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "macos-windows-"));
  try {
    const helper = join(directory, "computer-native");
    await writeFile(helper, "#!/bin/sh\nexec sleep 30\n");
    await chmod(helper, 0o755);
    const started = Date.now();
    await expect(computerNativeMacWindows(helper, 200).console()).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(5_000);

    // A helper whose output stays open after the kill (here a child it left
    // behind; on macOS also one stuck in an uninterruptible call) never
    // closes: the check gives up when its timer fires all the same.
    await writeFile(helper, "#!/bin/sh\nsleep 4 &\nexec sleep 30\n");
    const stuck = Date.now();
    await expect(computerNativeMacWindows(helper, 200).console()).rejects.toThrow("timed out");
    expect(Date.now() - stuck).toBeLessThan(2_000);

    await writeFile(helper, '#!/bin/sh\ncat >/dev/null\necho \'{"console":"locked"}\'\n');
    expect(await computerNativeMacWindows(helper, 2_000).console()).toBe("locked");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
