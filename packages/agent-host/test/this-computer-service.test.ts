import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThisComputer, type ThisComputerDeps } from "../src/this-computer";
import { parseAgentServiceStatus } from "../src/agent-service";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(
  options: {
    legacy?: boolean;
    signedOut?: boolean;
    inspectionFailure?: boolean;
    /** How the agent behaves when the app runs it as its helper. */
    hosted?: "runs" | "exits";
    /** The app's own screen grants (what a check run by the app reports). */
    appGrants?: "all" | "some";
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "og-service-host-"));
  const bundle = join(home, "Applications", "OpenGeni Agent.app", "Contents", "MacOS");
  mkdirSync(bundle, { recursive: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const binary = join(bundle, "opengeni-agent");
  const link = join(home, ".local", "bin", "opengeni-agent");
  const calls = join(home, "calls");
  const paused = join(home, "paused");
  writeFileSync(
    binary,
    [
      "#!/bin/sh",
      `echo "$*" >> "${calls}"`,
      'case "$*" in',
      `  connections) echo '  c1  https://server.example  workspace=w1  agent=a1' ;;`,
      `  'service status --json') ${options.legacy ? `echo "error: unexpected argument '--json' found" >&2; exit 2` : options.inspectionFailure ? `echo 'service manager unavailable' >&2; exit 1` : `if [ -f "${paused}" ]; then echo '{"schemaVersion":1,"installed":true,"enabled":false,"running":false,"binaryPath":null}'; else echo '{"schemaVersion":1,"installed":true,"enabled":true,"running":true,"binaryPath":null}'; fi`} ;;`,
      `  'service stop') touch "${paused}" ;;`,
      `  'service start') rm -f "${paused}" ;;`,
      `  --version) echo 'opengeni-agent 0.1.109' ;;`,
      `  permissions) echo '{"required":true,"screenRecording":true,"accessibility":${options.appGrants === "all"},"inputMonitoring":${options.appGrants === "all"}}' ;;`,
      `  *' run') ${options.hosted === "exits" ? "exit 1" : `if [ -f "${home}/crash" ]; then exit 1; fi; echo "$$" > "${home}/hosted.pid"; exec sleep 30`} ;;`,
      "  *) exit 99 ;;",
      "esac",
    ].join("\n"),
  );
  chmodSync(binary, 0o755);
  symlinkSync(binary, link);
  const original = readFileSync(binary);
  const serverCalls: string[] = [];
  const settings: string[] = [];
  const deps: ThisComputerDeps = {
    platform: "darwin",
    arch: "arm64",
    home,
    env: {},
    dataDir: home,
    logDir: home,
    agentSigningKey: "",
    fetch: async () => {
      throw new Error("must not download");
    },
    mintEnrollToken: async () => {
      throw new Error(options.signedOut ? "signed out" : "must reuse enrollment");
    },
    allowAgents: async (account, workspace, agent) => {
      serverCalls.push(`${account}:${workspace}:${agent}`);
      if (options.signedOut) throw new Error("signed out");
    },
    readMachine: async (account) => {
      expect(account).toBe("signed-in-account");
      return {
        online: true,
        screenControl: true,
        permissions: {
          screenRecording: true,
          accessibility: true,
          inputMonitoring: true,
        },
      };
    },
    openSystemSettings: (url) => settings.push(url),
    trash: async () => {
      throw new Error("must not trash");
    },
    onScreenControlHandedOver: () => {
      throw new Error("must not reset permissions");
    },
    onChange: () => undefined,
    ...(options.hosted ? { hostServiceAgent: true, hostedSettleMs: 400 } : {}),
  };
  const instances: ThisComputer[] = [];
  const create = () => {
    const instance = new ThisComputer(deps);
    instances.push(instance);
    return instance;
  };
  cleanups.push(async () => {
    for (const instance of instances) await instance.shutdown();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    create,
    home,
    deps,
    paused,
    settings,
    serverCalls,
    commands: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
    preserved: () => {
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(binary)).toEqual(original);
    },
  };
}

describe.skipIf(process.platform === "win32")("service-backed desktop setup", () => {
  test("explicit authenticated setup reuses grants; quit and relaunch leave the service alone", async () => {
    const f = fixture();
    const app = f.create();
    await app.boot();
    expect(f.commands()).toEqual([]);
    const status = await app.connect("signed-in-account", "https://server.example", "w1", {
      screenControl: true,
    });
    expect(f.serverCalls).toEqual(["signed-in-account:w1:a1"]);
    expect(status.management).toBe("service");
    expect(status.permissionAppName).toBe("Opengeni Agent");
    expect(status.permissions).toEqual([
      { id: "screenRecording", granted: true },
      { id: "accessibility", granted: true },
      { id: "inputMonitoring", granted: true },
    ]);
    expect(status.reconnecting).toBe(false);
    expect(app.openAtLoginChange(true)).toBeNull();
    await app.requestPermission("accessibility");
    expect(f.settings).toHaveLength(1);
    await app.shutdown();
    app.shutdownNow();
    const before = f.commands();
    await f.create().boot();
    expect(f.commands()).toEqual(before);
    expect(f.commands().some((command) => /permissions|uninstall|run|stop/.test(command))).toBe(
      false,
    );
    f.preserved();
  });

  test("pause is service state, survives relaunch, and only explicit resume clears it", async () => {
    const f = fixture();
    const app = f.create();
    await app.connect("signed-in-account", "https://server.example", "w1", { screenControl: true });
    await app.pause();
    expect(existsSync(f.paused)).toBe(true);
    const reopened = f.create();
    await reopened.boot();
    expect((await reopened.status("https://server.example", "w1", "signed-in-account")).state).toBe(
      "paused",
    );
    await reopened.resume();
    expect(existsSync(f.paused)).toBe(false);
    expect((await reopened.status("https://server.example", "w1", "signed-in-account")).state).toBe(
      "connected",
    );
    f.preserved();
  });

  test("an unauthenticated connect never changes the service", async () => {
    const f = fixture({ signedOut: true });
    await expect(
      f
        .create()
        .connect("signed-in-account", "https://server.example", "w1", { screenControl: true }),
    ).rejects.toThrow("signed out");
    expect(f.commands()).toEqual(["service status --json", "connections"]);
    f.preserved();
  });

  test("legacy agents are left intact and require an agent update before management", async () => {
    const f = fixture({ legacy: true });
    await expect(
      f
        .create()
        .connect("signed-in-account", "https://server.example", "w1", { screenControl: true }),
    ).rejects.toThrow("Update the existing Opengeni agent");
    expect(f.commands()).toEqual(["service status --json"]);
    expect(f.serverCalls).toEqual([]);
    f.preserved();
  });

  test("service inspection failures are not misreported as an old agent", async () => {
    const f = fixture({ inspectionFailure: true });
    await expect(
      f
        .create()
        .connect("signed-in-account", "https://server.example", "w1", { screenControl: true }),
    ).rejects.toThrow("service manager unavailable");
    expect(f.serverCalls).toEqual([]);
    f.preserved();
  });

  test("an existing enrollment's authorization error never creates another enrollment", async () => {
    const f = fixture();
    let minted = false;
    f.deps.allowAgents = async () => {
      throw new Error("access denied");
    };
    f.deps.mintEnrollToken = async () => {
      minted = true;
      throw new Error("unexpected enrollment");
    };
    await expect(
      f
        .create()
        .connect("signed-in-account", "https://server.example", "w1", { screenControl: true }),
    ).rejects.toThrow("access denied");
    expect(minted).toBe(false);
    expect(f.commands()).toEqual(["service status --json", "connections"]);
    f.preserved();
  });

  test("failed app setup keeps its install ownership across relaunch", async () => {
    const f = fixture();
    // A new app-owned installation has no standalone bundle or binary yet.
    rmSync(join(f.home, "Applications"), { recursive: true });
    rmSync(join(f.home, ".local", "bin", "opengeni-agent"));
    f.deps.mintEnrollToken = async () => "test-enrollment-token";
    await expect(
      f
        .create()
        .connect("signed-in-account", "https://server.example", "w1", { screenControl: false }),
    ).rejects.toThrow("Couldn't reach");
    expect(JSON.parse(readFileSync(join(f.home, "this-computer.json"), "utf8")).appInstalled).toBe(
      true,
    );
    // Simulate a binary installed before enrollment failed. It remains app-owned.
    const binary = join(f.home, ".local", "bin", "opengeni-agent");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const reopened = f.create();
    expect(
      (await reopened.status("https://server.example", "w1", "signed-in-account")).management,
    ).toBe("app");
    await reopened.boot();
    expect(f.commands()).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("a service agent moved into the app", () => {
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  const state = (home: string) =>
    JSON.parse(readFileSync(join(home, "this-computer.json"), "utf8")) as {
      management: string;
      hostedService: string | null;
    };

  test("asking for a permission moves it into the app first, with the same registration", async () => {
    const f = fixture({ hosted: "runs" });
    const app = f.create();
    await app.connect("signed-in-account", "https://server.example", "w1", { screenControl: true });
    // The service has grants the app lacks: a reading alone never moves it, so
    // a setup that works keeps working.
    await app.status("https://server.example", "w1", "signed-in-account");
    await new Promise((r) => setTimeout(r, 300));
    expect(f.commands()).not.toContain("service stop");
    expect(state(f.home).hostedService).toBeNull();
    // Asking for one moves it first, so macOS gives the grant to the app.
    await app.requestPermission("screenRecording");
    expect(f.settings).toEqual([]);
    expect(state(f.home)).toMatchObject({ management: "app", hostedService: expect.any(String) });
    // The service was turned off (kept installed) before the helper started: one agent.
    expect(existsSync(f.paused)).toBe(true);
    expect(f.commands()).toContain("service stop");
    expect(f.commands().some((command) => command.endsWith(" run"))).toBe(true);
    // No new enrollment: minting would have thrown.
    const status = await app.status("https://server.example", "w1", "signed-in-account");
    expect(status.management).toBe("app");
    expect(status.permissionAppName).toBeUndefined();
    expect(status.state).toBe("connected");
    // Its permissions now are the app's own, and opening at login keeps it available.
    expect(status.permissions?.find((p) => p.id === "accessibility")?.granted).toBe(false);
    expect(status.requestedPermissions).toEqual(["screenRecording"]);
    // Asking began just now: after a macOS relaunch it goes on.
    expect(status.setupPending).toBe(true);
    // Asked once: screens then know not to ask again unprompted.
    await app.requestPermission("accessibility");
    expect(
      (await app.status("https://server.example", "w1", "signed-in-account")).requestedPermissions,
    ).toEqual(["screenRecording", "accessibility"]);
    expect(app.openAtLoginChange(true)).toBe("open");
    // Turning computer use off and on is the app's pause, not the service.
    const serviceCommands = f.commands().filter((command) => command.startsWith("service "));
    await app.pause();
    expect((await app.status("https://server.example", "w1", "signed-in-account")).state).toBe(
      "paused",
    );
    expect(existsSync(f.paused)).toBe(true);
    expect(f.commands().filter((command) => /^service (start|stop)/.test(command))).toEqual(
      serviceCommands.filter((command) => /^service (start|stop)/.test(command)),
    );
    f.preserved();
  });

  test("moves on its own when the app already holds the service's grants", async () => {
    const f = fixture({ hosted: "runs", appGrants: "all" });
    const app = f.create();
    await app.connect("signed-in-account", "https://server.example", "w1", { screenControl: true });
    await app.status("https://server.example", "w1", "signed-in-account");
    await until(() => existsSync(join(f.home, "hosted.pid")));
    await new Promise((r) => setTimeout(r, 600));
    expect(state(f.home)).toMatchObject({ management: "app", hostedService: expect.any(String) });
    expect(existsSync(f.paused)).toBe(true);
    // Quitting doesn't take this computer away: it goes back to the service.
    expect((await app.summary()).handsBackOnQuit).toBe(true);
  });

  test("turning off during a move applies after it and stays off", async () => {
    const f = fixture({ hosted: "runs", appGrants: "all" });
    const app = f.create();
    await app.connect("signed-in-account", "https://server.example", "w1", { screenControl: true });
    void app.status("https://server.example", "w1", "signed-in-account");
    await until(() => f.commands().includes("service stop"));
    await app.pause();
    // Long past the settle time: nothing rolled back or turned it on again.
    await new Promise((r) => setTimeout(r, 700));
    expect(state(f.home)).toMatchObject({ management: "app", paused: true });
    expect(existsSync(f.paused)).toBe(true);
    expect(f.commands().filter((command) => command === "service start")).toHaveLength(1);
    expect((await app.status("https://server.example", "w1", "signed-in-account")).state).toBe(
      "paused",
    );
  });

  test("quitting hands it back to the service, and Off stays off", async () => {
    for (const off of [false, true]) {
      const f = fixture({ hosted: "runs", appGrants: "all" });
      const app = f.create();
      await app.connect("signed-in-account", "https://server.example", "w1", {
        screenControl: true,
      });
      await app.status("https://server.example", "w1", "signed-in-account");
      await until(() => existsSync(join(f.home, "hosted.pid")));
      await new Promise((r) => setTimeout(r, 600));
      if (off) await app.pause();
      await app.shutdown();
      expect(state(f.home)).toMatchObject({ management: "service", hostedService: null });
      expect(existsSync(f.paused)).toBe(off);
      // Next launch: the service's agent, as before (on or off).
      const next = f.create();
      expect((await next.status("https://server.example", "w1", "signed-in-account")).state).toBe(
        off ? "paused" : "connected",
      );
    }
  }, 15_000);

  test("a relaunch starts the helper again, or hands back when it can't stay up", async () => {
    const moved = async () => {
      const f = fixture({ hosted: "runs", appGrants: "all" });
      const app = f.create();
      await app.connect("signed-in-account", "https://server.example", "w1", {
        screenControl: true,
      });
      await app.status("https://server.example", "w1", "signed-in-account");
      await until(() => existsSync(join(f.home, "hosted.pid")));
      await new Promise((r) => setTimeout(r, 600));
      const saved = readFileSync(join(f.home, "this-computer.json"), "utf8");
      // The app ended unasked; the next launch finds what was saved then.
      await app.shutdown();
      writeFileSync(f.paused, "");
      writeFileSync(join(f.home, "this-computer.json"), saved);
      rmSync(join(f.home, "hosted.pid"), { force: true });
      return f;
    };

    // Healthy: the app runs it again, and the service stays off.
    const healthy = await moved();
    await healthy.create().boot();
    await until(() => existsSync(join(healthy.home, "hosted.pid")));
    await new Promise((r) => setTimeout(r, 600));
    expect(state(healthy.home)).toMatchObject({ management: "app" });
    expect(existsSync(healthy.paused)).toBe(true);

    // The helper keeps exiting: the service runs it again.
    const crashing = await moved();
    writeFileSync(join(crashing.home, "crash"), "");
    await crashing.create().boot();
    await until(() => !existsSync(crashing.paused));
    expect(existsSync(crashing.paused)).toBe(false);
    expect(state(crashing.home)).toMatchObject({ management: "service", hostedService: null });

    // Its program is gone (reinstalled elsewhere): back to the service.
    const missing = await moved();
    const saved = JSON.parse(readFileSync(join(missing.home, "this-computer.json"), "utf8"));
    writeFileSync(
      join(missing.home, "this-computer.json"),
      JSON.stringify({ ...saved, hostedService: join(missing.home, "gone") }),
    );
    await missing.create().boot();
    expect(existsSync(missing.paused)).toBe(false);
    expect(state(missing.home)).toMatchObject({ management: "service", hostedService: null });

    // The service already took it back: it keeps it, with no second agent.
    const taken = await moved();
    rmSync(taken.paused);
    await taken.create().boot();
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(taken.home, "hosted.pid"))).toBe(false);
    expect(state(taken.home)).toMatchObject({ management: "service", hostedService: null });
  }, 30_000);

  test("goes back to the service when the helper doesn't start", async () => {
    const f = fixture({ hosted: "exits", appGrants: "all" });
    const app = f.create();
    await app.connect("signed-in-account", "https://server.example", "w1", { screenControl: true });
    await app.status("https://server.example", "w1", "signed-in-account");
    // Connecting started the service once; going back starts it again.
    await until(() => f.commands().filter((command) => command === "service start").length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(state(f.home)).toMatchObject({ management: "service", hostedService: null });
    // Back to exactly one agent: the service runs again.
    expect(existsSync(f.paused)).toBe(false);
    const status = await app.status("https://server.example", "w1", "signed-in-account");
    expect(status.management).toBe("service");
    expect(status.state).toBe("connected");
    expect(status.error).toBeNull();
    f.preserved();
  });

  test("an app that doesn't host service agents leaves the service alone", async () => {
    const f = fixture();
    const app = f.create();
    await app.connect("signed-in-account", "https://server.example", "w1", { screenControl: true });
    await app.status("https://server.example", "w1", "signed-in-account");
    await new Promise((r) => setTimeout(r, 300));
    expect(f.commands()).not.toContain("service stop");
    expect(state(f.home).hostedService).toBeNull();
  });
});

test("service inspection requires versioned structured evidence", () => {
  expect(parseAgentServiceStatus("opengeni-agent LaunchAgent: loaded")).toBeNull();
  expect(parseAgentServiceStatus('{"schemaVersion":1,"installed":true}')).toBeNull();
  expect(
    parseAgentServiceStatus(
      '{"schemaVersion":1,"installed":true,"enabled":false,"running":false,"binaryPath":null}',
    )?.enabled,
  ).toBe(false);
});
