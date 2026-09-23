import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxVirtualComputerEnvironmentAllocator, nativeComputerEnvironment } from "../src";

test.skipIf(process.platform !== "linux")(
  "cleans started display processes when the window manager executable is missing",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "og-missing-desktop-tool-"));
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    try {
      for (const [name, ready] of [
        ["Xvfb", "printf '123\\n' >&3"],
        ["dbus-daemon", "printf 'unix:path=/tmp/fixture-bus\\n'"],
      ]) {
        const path = join(root, name!);
        await writeFile(
          path,
          `#!/bin/sh\nprintf '%s' "$$" > ${quote(path + ".pid")}\n${ready}\nexec sleep 60\n`,
        );
        await chmod(path, 0o700);
      }
      const allocator = new LinuxVirtualComputerEnvironmentAllocator({
        windowManagerBinary: join(root, "missing-window-manager"),
      });
      await expect(
        allocator.allocate({
          computerSessionId: crypto.randomUUID(),
          controllerGeneration: crypto.randomUUID(),
          sessionDirectory: root,
          baseEnvironment: { ...process.env, PATH: `${root}:${process.env.PATH}` },
        }),
      ).rejects.toThrow();
      for (const name of ["Xvfb", "dbus-daemon"]) {
        const pid = Number(await readFile(join(root, name + ".pid"), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      for (const name of ["Xvfb", "dbus-daemon"]) {
        const pid = Number(await readFile(join(root, name + ".pid"), "utf8").catch(() => "0"));
        if (pid > 1) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("native Computer helpers receive GUI state without cloud credentials", () => {
  expect(
    nativeComputerEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/workspace",
      DISPLAY: ":42",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus",
      LC_MESSAGES: "en_US.UTF-8",
      OPENGENI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      AZURE_CLIENT_SECRET: "secret",
      MALFORMED: "nul\0value",
    }),
  ).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/workspace",
    DISPLAY: ":42",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus",
    LC_MESSAGES: "en_US.UTF-8",
  });
});
