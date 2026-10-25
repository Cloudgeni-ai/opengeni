import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThisComputer, type ThisComputerDeps } from "../src/this-computer";

type Switches = { screenControl: boolean; browserExtension: boolean };

const SERVER = "https://agents.example.test";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MACHINE = "11111111-1111-4111-8111-111111111111";

/** A stand-in agent that writes the switches it was started with, then exits. */
async function fakeComputer(
  switches: Switches | null,
  state?: object,
  { switchable = true }: { switchable?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "og-this-computer-switches-"));
  if (state) await writeFile(join(dir, "this-computer.json"), JSON.stringify(state));
  const agentPath = join(dir, "agent");
  const seen = join(dir, "env.log");
  const switchField = switchable ? ',"screenControlSwitch":true' : "";
  await writeFile(
    agentPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  permissions) echo '{"required":true,"screenRecording":false,"accessibility":false,"inputMonitoring":false${switchField}}'; exit 0 ;;`,
      `  connections) echo "  c1  ${SERVER}  workspace=${WORKSPACE}  agent=${MACHINE}"; exit 0 ;;`,
      '  --version) echo "opengeni-agent 1.0.0"; exit 0 ;;',
      "esac",
      `echo "screen=\${OPENGENI_AGENT_SCREEN_CONTROL:-} browser=\${OPENGENI_AGENT_BROWSER_EXTENSION:-}" >> "${seen}"`,
      "",
    ].join("\n"),
  );
  await chmod(agentPath, 0o755);
  let changes = 0;
  const current = { value: switches };
  const deps = {
    platform: "darwin",
    arch: "arm64",
    home: dir,
    env: {},
    agentSigningKey: "",
    fetch: () => Promise.reject(new Error("offline")),
    dataDir: dir,
    logDir: dir,
    agentPath,
    mintEnrollToken: () => Promise.reject(new Error("unused")),
    allowAgents: () => Promise.resolve(),
    openSystemSettings: () => undefined,
    onChange: () => {
      changes += 1;
    },
    ...(switches ? { agentSwitches: () => current.value! } : {}),
  } as unknown as ThisComputerDeps;
  const computer = new ThisComputer(deps);
  const internals = computer as unknown as {
    spawnAgent(apiUrl: string): { onExit(listener: (code: number | null) => void): void };
    permissionList(): Promise<{ id: string; granted: boolean }[] | null>;
  };
  return {
    computer,
    internals,
    current,
    changes: () => changes,
    /** Every start the agent saw, oldest first. */
    starts: async () =>
      (await readFile(seen, "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
    /** Starts the agent once and returns what it saw. */
    started: async () => {
      const child = internals.spawnAgent("https://opengeni.example");
      await new Promise<void>((resolve) => child.onExit(() => resolve()));
      return (await readFile(seen, "utf8")).trim().split("\n").at(-1);
    },
    done: async () => {
      await computer.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("the person's switches for the app's agent", () => {
  test("start the agent without the screen or the Chrome bridge only when turned off", async () => {
    const fake = await fakeComputer({ screenControl: true, browserExtension: true });
    try {
      expect(await fake.started()).toBe("screen= browser=");
      fake.current.value = { screenControl: false, browserExtension: true };
      expect(await fake.started()).toBe("screen=off browser=");
      fake.current.value = { screenControl: true, browserExtension: false };
      expect(await fake.started()).toBe("screen= browser=off");
    } finally {
      await fake.done();
    }
  });

  test("an app without switches starts the agent as before", async () => {
    const fake = await fakeComputer(null);
    try {
      expect(await fake.started()).toBe("screen= browser=");
    } finally {
      await fake.done();
    }
  });

  test("screen control turned off asks for none of its permissions", async () => {
    const fake = await fakeComputer(
      { screenControl: true, browserExtension: true },
      { adopted: true, screenControl: true, requested: ["files"] },
    );
    try {
      const on = await fake.internals.permissionList();
      expect(on?.map((permission) => permission.id)).toEqual([
        "screenRecording",
        "accessibility",
        "inputMonitoring",
        "files",
      ]);
      fake.current.value = { screenControl: false, browserExtension: true };
      expect(await fake.internals.permissionList()).toBeNull();
    } finally {
      await fake.done();
    }
  });

  test("the guarded folders keep their answer while screen control is off", async () => {
    const fake = await fakeComputer(
      { screenControl: true, browserExtension: true },
      { adopted: true, screenControl: true, requested: ["files"] },
    );
    try {
      const on = await fake.computer.status(SERVER, WORKSPACE);
      expect(on.state).toBe("connected");
      expect(on.permissions?.some((permission) => permission.id === "files")).toBe(true);
      expect(on.folders).toBeUndefined();

      fake.current.value = { screenControl: false, browserExtension: true };
      fake.computer.invalidate();
      const off = await fake.computer.status(SERVER, WORKSPACE);
      expect(off.permissions).toBeUndefined();
      // No screen permission is missing, so nothing reads as needing one.
      expect(off.folders).toBe(true);
    } finally {
      await fake.done();
    }
  });

  test("a change is reported, and a stopped agent stays stopped", async () => {
    const fake = await fakeComputer({ screenControl: false, browserExtension: true });
    try {
      expect(fake.computer.runsOwnAgent).toBe(true);
      await fake.computer.agentSwitchesChanged();
      await fake.computer.agentSwitchesChanged();
      expect(fake.changes()).toBe(2);
      // Nothing was started by the change.
      expect(await fake.starts()).toEqual([]);
    } finally {
      await fake.done();
    }
  });

  test("tells an agent that honours the screen switch from an older one", async () => {
    const current = await fakeComputer({ screenControl: true, browserExtension: true });
    const older = await fakeComputer({ screenControl: true, browserExtension: true }, undefined, {
      switchable: false,
    });
    try {
      expect(await current.computer.screenControlSwitchSupported()).toBe(true);
      expect(await older.computer.screenControlSwitchSupported()).toBe(false);
    } finally {
      await current.done();
      await older.done();
    }
  });

  test("asks the agent binary once, and again only when it's replaced", async () => {
    const fake = await fakeComputer({ screenControl: true, browserExtension: true });
    const asked = { count: 0 };
    const internals = fake.computer as unknown as {
      permissions(): Promise<unknown>;
      permissionsCache: unknown;
      hostedPath: string;
    };
    const permissions = internals.permissions.bind(fake.computer);
    internals.permissions = () => {
      asked.count += 1;
      return permissions();
    };
    try {
      expect(await fake.computer.screenControlSwitchSupported()).toBe(true);
      internals.permissionsCache = null;
      expect(await fake.computer.screenControlSwitchSupported()).toBe(true);
      expect(asked.count).toBe(1);
      // An update replaces the binary: its answer is read again.
      const binary = await readFile(internals.hostedPath, "utf8");
      await writeFile(internals.hostedPath, binary.replace('"screenControlSwitch":true', '"x":1'));
      internals.permissionsCache = null;
      expect(await fake.computer.screenControlSwitchSupported()).toBe(false);
      expect(asked.count).toBe(2);
    } finally {
      await fake.done();
    }
  });
});
