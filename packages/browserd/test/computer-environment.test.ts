import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExistingComputerEnvironmentAllocator,
  LinuxVirtualComputerEnvironmentAllocator,
  nativeComputerEnvironment,
} from "../src";
import { nativeLinuxDesktopSession } from "../src/linux-desktop-session";

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

const sessionContext = (baseEnvironment: NodeJS.ProcessEnv) => ({
  computerSessionId: "00000000-0000-4000-8000-000000000001",
  controllerGeneration: "g1",
  sessionDirectory: "/tmp/unused",
  baseEnvironment,
});

test.skipIf(process.platform !== "linux")(
  "a controller started before anyone signed in joins the desktop found when a session opens",
  async () => {
    let lookups = 0;
    const allocator = new ExistingComputerEnvironmentAllocator({
      findLinuxDesktop: async () => {
        lookups += 1;
        return { display: ":0", xauthority: "/home/user/.Xauthority" };
      },
    });
    const lease = await allocator.allocate(
      sessionContext({ PATH: "/usr/bin", HOME: "/home/user" }),
    );
    expect(lease.seatId).toBe("host-seat::0");
    expect(lease.displayId).toBe(":0");
    expect(lease.environment.DISPLAY).toBe(":0");
    expect(lease.environment.XAUTHORITY).toBe("/home/user/.Xauthority");
    expect(lookups).toBe(1);

    // An inherited DISPLAY may be one an earlier login left behind: the
    // helper checks it (it tries it first) and its answer is used.
    const inherited = await allocator.allocate(
      sessionContext({ PATH: "/usr/bin", DISPLAY: ":1", XAUTHORITY: "/tmp/stale-auth" }),
    );
    expect(inherited.displayId).toBe(":0");
    expect(inherited.environment.XAUTHORITY).toBe("/home/user/.Xauthority");
    expect(lookups).toBe(2);

    // A Wayland session without Xwayland keeps its own path.
    const wayland = await allocator.allocate(
      sessionContext({ PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0" }),
    );
    expect(wayland.displayId).toBe("wayland-0");
    expect(lookups).toBe(2);
  },
);

test.skipIf(process.platform !== "linux")(
  "no desktop to join says why, and a failed lookup keeps the plain refusal",
  async () => {
    const reason =
      "No one is signed in to a desktop on this machine as the user the agent runs as. " +
      "It works once that user signs in to an X11 desktop session on the machine's screen.";
    const refused = new ExistingComputerEnvironmentAllocator({
      findLinuxDesktop: async () => ({ unavailable: reason }),
    });
    await expect(refused.allocate(sessionContext({ PATH: "/usr/bin" }))).rejects.toMatchObject({
      code: "resource_unavailable",
      message: reason,
    });
    const broken = new ExistingComputerEnvironmentAllocator({
      findLinuxDesktop: async () => {
        throw new Error("helper missing");
      },
    });
    await expect(broken.allocate(sessionContext({ PATH: "/usr/bin" }))).rejects.toMatchObject({
      code: "resource_unavailable",
      message: "connected Linux ComputerSession has no active graphical display",
    });
  },
);

test.skipIf(process.platform === "win32")(
  "the native helper's desktop-session answer is read and checked",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "og-desktop-session-"));
    try {
      const helper = async (name: string, body: string) => {
        const path = join(root, name);
        await writeFile(path, `#!/bin/sh\n${body}\n`);
        await chmod(path, 0o700);
        return path;
      };
      const found = await helper(
        "found",
        `[ "$1" = desktop-session ] && printf '%s\\n' '{"display":":0","xauthority":null}'`,
      );
      expect(await nativeLinuxDesktopSession(found)()).toEqual({ display: ":0", xauthority: null });
      const none = await helper("none", `printf '%s\\n' '{"unavailable":"Nobody is signed in."}'`);
      expect(await nativeLinuxDesktopSession(none)()).toEqual({
        unavailable: "Nobody is signed in.",
      });
      const garbage = await helper("garbage", `printf '%s\\n' '{"display":""}'`);
      await expect(nativeLinuxDesktopSession(garbage)()).rejects.toThrow();
      const hung = await helper("hung", "exec sleep 30");
      await expect(nativeLinuxDesktopSession(hung, 200)()).rejects.toThrow("timed out");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
