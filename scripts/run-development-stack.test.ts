import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a second launcher cannot mutate runtime state; termination permits restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengeni-launcher-test-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const project = `launch-test-${randomUUID()}`;
  try {
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, ".env"), `OPENGENI_COMPOSE_PROJECT=${project}\n`);
    await writeFile(
      join(root, "scripts/dev-stack-project.sh"),
      await readFile(new URL("./dev-stack-project.sh", import.meta.url)),
    );
    await writeFile(
      join(root, "scripts/dev-stack-backend.sh"),
      await readFile(new URL("./dev-stack-backend.sh", import.meta.url)),
    );
    await writeFile(
      join(root, "scripts/dev-stack.sh"),
      `#!/usr/bin/env bash
      set -eu
      trap 'exit 0' TERM INT
      [ "$OPENGENI_DEV_BACKEND" = native ]
      [ "$OPENGENI_COMPOSE_PROJECT" = "${project}" ]
      echo started >> .env.runtime
      while :; do sleep 0.1; done
    `,
    );
    const runner = join(root, "runner.ts");
    await writeFile(
      runner,
      `
      import { runDevelopmentStack } from ${JSON.stringify(new URL("./run-development-stack.ts", import.meta.url).href)};
      try { process.exitCode = await runDevelopmentStack(${JSON.stringify(root)}, { checkPrerequisites: async () => {} }); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `,
    );
    const launch = () => {
      // This fixture tests launcher ownership, not host Docker readiness. The
      // real resolver still runs, using native without probing a host daemon.
      const child = Bun.spawn([process.execPath, "--no-env-file", runner], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          TMPDIR: root,
          OPENGENI_DEV_BACKEND: "native",
          OPENGENI_COMPOSE_PROJECT: project,
          OPENGENI_OBJECT_STORAGE_FIXTURE: "garage",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      children.push(child);
      // Only the generated fixture's isolated environment reaches this child;
      // retain its bounded diagnostic instead of hiding premature failures.
      const stderr = new Response(child.stderr).text().then((text) => text.slice(-2_048));
      return { child, stderr };
    };
    const waitForStarts = async (count: number, launched: ReturnType<typeof launch>) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const text = await Bun.file(join(root, ".env.runtime"))
          .text()
          .catch(() => "");
        if (text === "started\n".repeat(count)) return;
        if (launched.child.exitCode !== null) break;
        await Bun.sleep(20);
      }
      launched.child.kill("SIGTERM");
      await launched.child.exited;
      throw new Error(
        `launcher did not start ${count} times (exit ${launched.child.exitCode}): ${(await launched.stderr) || "no child stderr"}`,
      );
    };
    const first = launch();
    await waitForStarts(1, first);
    const second = launch();
    expect(await second.child.exited).toBe(1);
    expect(await second.stderr).toContain("already has a launcher");
    expect(await Bun.file(join(root, ".env.runtime")).text()).toBe("started\n");
    first.child.kill("SIGTERM");
    await first.child.exited;
    const third = launch();
    await waitForStarts(2, third);
    third.child.kill("SIGTERM");
    await third.child.exited;
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
