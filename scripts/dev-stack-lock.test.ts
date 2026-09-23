import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDevelopmentStackLock } from "./dev-stack-lock";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-launch-lock-test-"));
  directories.push(directory);
  return directory;
}
const owner = { token: "test-owner", repositoryRoot: "/test/checkout" };

describe("local stack ownership", () => {
  test("rejects a second owner while allowing a different project", async () => {
    const directory = await fixture();
    const release = acquireDevelopmentStackLock("one", owner, { directory });
    try {
      expect(() => acquireDevelopmentStackLock("one", owner, { directory })).toThrow(
        "already has a launcher",
      );
      const releaseOther = acquireDevelopmentStackLock("two", owner, { directory });
      releaseOther();
    } finally {
      release();
    }
    const releaseNext = acquireDevelopmentStackLock("one", owner, { directory });
    releaseNext();
  });

  test("refuses a surviving shell after supervisor death and recovers after it exits", async () => {
    const directory = await fixture();
    const release = acquireDevelopmentStackLock("one", owner, { directory });
    const shell = Bun.spawn(
      [
        "bash",
        "-c",
        "trap 'exit 0' TERM; while :; do sleep 0.1; done",
        `--opengeni-dev-stack-token=${owner.token}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      await Bun.sleep(30);
      release();
      expect(() => acquireDevelopmentStackLock("one", owner, { directory })).toThrow(
        "still running from /test/checkout",
      );
    } finally {
      shell.kill("SIGTERM");
      await shell.exited;
    }
    const recovered = acquireDevelopmentStackLock("one", owner, { directory });
    recovered();
  });

  test("OS releases a killed process's lock without deleting the lock file", async () => {
    const directory = await fixture();
    const script = join(directory, "holder.ts");
    const marker = join(directory, "ready");
    await writeFile(
      script,
      `
      import { acquireDevelopmentStackLock } from ${JSON.stringify(new URL("./dev-stack-lock.ts", import.meta.url).href)};
      acquireDevelopmentStackLock("one", ${JSON.stringify(owner)}, { directory: ${JSON.stringify(directory)} });
      await Bun.write(${JSON.stringify(marker)}, "ready");
      setInterval(() => {}, 1000);
    `,
    );
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    try {
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(20);
      expect(await Bun.file(marker).exists()).toBe(true);
      expect(() => acquireDevelopmentStackLock("one", owner, { directory })).toThrow(
        "already has a launcher",
      );
      child.kill("SIGKILL");
      await child.exited;
      const recovered = acquireDevelopmentStackLock("one", owner, { directory });
      recovered();
    } finally {
      child.kill();
      await child.exited;
    }
  }, 10_000);
});
