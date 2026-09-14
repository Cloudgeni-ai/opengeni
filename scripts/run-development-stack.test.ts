import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a second launcher cannot mutate runtime state; termination permits restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengeni-launcher-test-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, ".env"), `OPENGENI_COMPOSE_PROJECT=launch-test-${randomUUID()}\n`);
    await writeFile(
      join(root, "scripts/dev-stack-project.sh"),
      await readFile(new URL("./dev-stack-project.sh", import.meta.url)),
    );
    await writeFile(
      join(root, "scripts/dev-stack.sh"),
      `#!/usr/bin/env bash
      set -eu
      trap 'exit 0' TERM INT
      echo started >> .env.runtime
      while :; do sleep 0.1; done
    `,
    );
    const runner = join(root, "runner.ts");
    await writeFile(
      runner,
      `
      import { runDevelopmentStack } from ${JSON.stringify(new URL("./run-development-stack.ts", import.meta.url).href)};
      try { process.exitCode = await runDevelopmentStack(${JSON.stringify(root)}); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `,
    );
    const launch = () => {
      const child = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe" });
      children.push(child);
      return child;
    };
    const waitForStarts = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const text = await Bun.file(join(root, ".env.runtime"))
          .text()
          .catch(() => "");
        if (text === "started\n".repeat(count)) return;
        await Bun.sleep(20);
      }
      throw new Error(`launcher did not start ${count} times`);
    };
    const first = launch();
    await waitForStarts(1);
    const second = launch();
    expect(await second.exited).toBe(1);
    expect(await new Response(second.stderr).text()).toContain("already has a launcher");
    expect(await Bun.file(join(root, ".env.runtime")).text()).toBe("started\n");
    first.kill("SIGTERM");
    await first.exited;
    const third = launch();
    await waitForStarts(2);
    third.kill("SIGTERM");
    await third.exited;
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
