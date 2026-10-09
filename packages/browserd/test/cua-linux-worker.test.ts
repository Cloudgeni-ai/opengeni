import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxWorkerLauncher } from "../src/cua/linux-worker";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test.skipIf(process.platform === "win32")(
  "worker launcher resolves the session PATH and preserves arguments through quoted paths",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cua-launcher-"));
    directories.push(directory);
    const bin = join(directory, "nonstandard 'bin");
    await mkdir(bin);
    // A synthetic setsid verifies dispatch without creating a desktop or process group.
    await writeFile(
      join(bin, "setsid"),
      '#!/bin/sh\n[ "$1" = "--" ] || exit 9\nshift\nexec "$@"\n',
      {
        mode: 0o700,
      },
    );
    const worker = join(bin, "worker 'fixture");
    await writeFile(
      worker,
      '#!/bin/sh\nprintf "%s\\n" "$1" "$DISPLAY" "${WAYLAND_DISPLAY-unset}" "${XAUTHORITY-unset}" "${AT_SPI_BUS_ADDRESS-unset}"\n',
      { mode: 0o700 },
    );
    const environment = {
      PATH: bin,
      XDG_RUNTIME_DIR: directory,
      DISPLAY: ":123",
      WAYLAND_DISPLAY: "other",
      XAUTHORITY: "other",
      AT_SPI_BUS_ADDRESS: "other",
    };
    const launcher = await linuxWorkerLauncher(worker, environment);
    const child = Bun.spawn([launcher, "literal ' $() argument"], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.split("\n")).toEqual([
      "literal ' $() argument",
      ":123",
      "unset",
      "unset",
      "unset",
      "",
    ]);
  },
);

test("worker launch fails before writing a launcher when setsid is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cua-launcher-"));
  directories.push(directory);
  await expect(
    linuxWorkerLauncher("/example/worker", { PATH: directory, XDG_RUNTIME_DIR: directory }),
  ).rejects.toThrow("requires setsid");
  expect(await Bun.file(join(directory, "cua-worker-launcher")).exists()).toBe(false);
});
