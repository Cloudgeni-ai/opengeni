import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxVirtualComputerEnvironmentAllocator, nativeComputerEnvironment } from "../src";

test.skipIf(process.platform !== "linux")(
  "cleans started display processes when the window manager fails to start",
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
      // Installed, but never reached: the window manager exits first.
      for (const name of ["failing-window-manager", "xterm", "x11vnc"]) {
        await writeFile(join(root, name), "#!/bin/sh\nexit 1\n");
        await chmod(join(root, name), 0o700);
      }
      const allocator = new LinuxVirtualComputerEnvironmentAllocator({
        windowManagerBinary: join(root, "failing-window-manager"),
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

test.skipIf(process.platform !== "linux")(
  "names the missing desktop programs and how to install them before starting anything",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "og-missing-desktop-programs-"));
    try {
      const xvfb = join(root, "Xvfb");
      await writeFile(xvfb, `#!/bin/sh\ntouch '${root}/started'\nexec sleep 60\n`);
      await chmod(xvfb, 0o700);
      for (const name of ["dbus-daemon", "xterm"]) {
        await writeFile(join(root, name), "#!/bin/sh\nexit 1\n");
        await chmod(join(root, name), 0o700);
      }
      const allocation = new LinuxVirtualComputerEnvironmentAllocator().allocate({
        computerSessionId: crypto.randomUUID(),
        controllerGeneration: crypto.randomUUID(),
        sessionDirectory: root,
        baseEnvironment: { ...process.env, PATH: root },
      });
      await expect(allocation).rejects.toMatchObject({
        code: "resource_unavailable",
        retryable: false,
        message:
          "this machine can't start a virtual desktop because xfwm4 and x11vnc aren't installed. On Debian or Ubuntu, install with: sudo apt install xfwm4 x11vnc",
      });
      expect(await readFile(join(root, "started"), "utf8").catch(() => null)).toBeNull();
    } finally {
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
