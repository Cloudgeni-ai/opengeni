import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installLinuxAutostart, removeLinuxAutostart } from "../src/main/linux-integration";
import { ThisComputer } from "@opengeni/agent-host";

const folders: string[] = [];
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "open-at-login-"));
  folders.push(path);
  return path;
}
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

function computer(
  dataDir: string,
  onChange: () => void = () => undefined,
  onScreenControlHandedOver?: () => void,
): ThisComputer {
  const unused = () => {
    throw new Error("not used");
  };
  return new ThisComputer({
    platform: "darwin",
    arch: "arm64",
    home: dataDir,
    env: {},
    agentSigningKey: "",
    fetch: unused,
    dataDir,
    logDir: dataDir,
    mintEnrollToken: unused,
    allowAgents: unused,
    openSystemSettings: () => undefined,
    trash: async () => undefined,
    ...(onScreenControlHandedOver ? { onScreenControlHandedOver } : {}),
    onChange,
  });
}

describe("opening at login", () => {
  test("starts once when the computer is connected and stops when it's disconnected", () => {
    const dataDir = folder();
    const first = computer(dataDir);
    expect(first.openAtLoginChange(false)).toBeNull();
    expect(first.openAtLoginChange(true)).toBe("open");
    expect(first.openAtLoginChange(true)).toBeNull();

    // Turning it off in the system's settings sticks: later launches don't set it again.
    const relaunched = computer(dataDir);
    expect(relaunched.openAtLoginChange(true)).toBeNull();
    expect(relaunched.openAtLoginChange(false)).toBe("stop");
    expect(computer(dataDir).openAtLoginChange(false)).toBeNull();
  });

  test("adds and removes the Linux autostart entry", () => {
    const config = folder();
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = config;
    try {
      const entry = join(config, "autostart", "product.desktop");
      installLinuxAutostart("Product");
      expect(existsSync(entry)).toBe(true);
      removeLinuxAutostart("Product");
      expect(existsSync(entry)).toBe(false);
      removeLinuxAutostart("Product");
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

describe.skipIf(process.platform === "win32")("noticing a disconnect", () => {
  test("tells the app when the last connection goes, but not when a read fails", async () => {
    const home = folder();
    writeFileSync(
      join(home, "this-computer.json"),
      JSON.stringify({ adopted: true, management: "app" }),
    );
    const listing = join(home, "connections.txt");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const agent = join(home, ".local", "bin", "opengeni-agent");
    // A stand-in agent: `connections` prints the listing, or fails when it's missing.
    writeFileSync(agent, `#!/bin/sh\n[ -f "${listing}" ] || exit 1\ncat "${listing}"\n`);
    chmodSync(agent, 0o755);
    const connected =
      "Configured Opengeni connections (1):\n  abc  https://server.example  workspace=w1  agent=a1\n";
    writeFileSync(listing, connected);

    let changes = 0;
    const machine = computer(home, () => changes++);
    expect((await machine.summary()).connected).toBe(true);
    expect(changes).toBe(0);

    rmSync(listing);
    machine.invalidate();
    expect((await machine.summary()).connected).toBe(true);
    expect(changes).toBe(0);

    writeFileSync(listing, "Configured Opengeni connections (0):\n");
    machine.invalidate();
    expect((await machine.summary()).connected).toBe(false);
    expect(changes).toBe(1);

    writeFileSync(listing, connected);
    machine.invalidate();
    expect((await machine.summary()).connected).toBe(true);
    expect(changes).toBe(2);
  });
});

describe.skipIf(process.platform === "win32")("running the app's own agent", () => {
  test("runs it with the app's own config folder", async () => {
    const home = folder();
    const configDir = join(home, "agent-config");
    const seen = join(home, "run-config-dir.txt");
    const agent = join(home, "agent", "opengeni-agent");
    mkdirSync(join(home, "agent"), { recursive: true });
    // A stand-in agent: a version, one connection, and `run` records its config folder and stays up.
    writeFileSync(
      agent,
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *--version*) echo "opengeni-agent 0.1.90" ;;',
        "  *connections*) printf 'Configured Opengeni connections (1):\\n  abc  https://server.example  workspace=w1  agent=a1\\n' ;;",
        `  *run*) echo "$OPENGENI_CONFIG_DIR" > "${seen}"; exec sleep 30 ;;`,
        "esac",
      ].join("\n"),
    );
    chmodSync(agent, 0o755);
    const unused = () => {
      throw new Error("not used");
    };
    const machine = new ThisComputer({
      platform: "linux",
      arch: "x64",
      home,
      env: {},
      agentSigningKey: "",
      fetch: unused,
      dataDir: home,
      logDir: home,
      agentPath: agent,
      agentConfigDir: configDir,
      adoptStandaloneAgent: false,
      mintEnrollToken: unused,
      allowAgents: unused,
      openSystemSettings: () => undefined,
      trash: async () => undefined,
      onChange: () => undefined,
    });
    try {
      await machine.boot();
      // The shell creates the file before it writes the folder, so wait for the content.
      const seenConfigDir = () => (existsSync(seen) ? readFileSync(seen, "utf8").trim() : "");
      for (let i = 0; i < 250 && !seenConfigDir(); i++) await Bun.sleep(20);
      // Not the default folder, where another agent on this computer may hold the lock.
      expect(seenConfigDir()).toBe(configDir);
      const running = await machine.status("https://server.example", "w1");
      expect(running.state).toBe("connected");
      expect(running.reconnecting).toBeUndefined();
    } finally {
      await machine.shutdown();
    }
  });
});

describe.skipIf(process.platform === "win32")("preserving the separate Mac agent app", () => {
  test("opening the desktop app never takes over an existing installation", async () => {
    const home = folder();
    const macApp = join(home, "Applications", "OpenGeni Agent.app");
    const binary = join(macApp, "Contents", "MacOS", "opengeni-agent");
    mkdirSync(join(macApp, "Contents", "MacOS"), { recursive: true });
    const calls = join(home, "agent-calls.txt");
    // Record every call: a read-only launch must not uninstall, enroll, run,
    // restart, or ask for permissions on behalf of the desktop app.
    writeFileSync(
      binary,
      `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$1" in\n  connections) printf 'Configured Opengeni connections (1):\\n  abc  https://server.example  workspace=w1  agent=a1\\n' ;;\n  --version) echo 'opengeni-agent 0.1.109' ;;\nesac\nexit 0\n`,
    );
    chmodSync(binary, 0o755);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const command = join(home, ".local", "bin", "opengeni-agent");
    symlinkSync(binary, command);
    const originalBinary = readFileSync(binary);

    let handedOver = 0;
    const machine = computer(home, undefined, () => handedOver++);
    try {
      await machine.boot();
      await machine.summary();
      await machine.status("https://server.example", "w1");
      await machine.boot();
      const invocations = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
      expect(invocations.every((call) => call === "connections" || call === "--version")).toBe(
        true,
      );
      expect(readFileSync(binary)).toEqual(originalBinary);
      expect(existsSync(command)).toBe(true);
      expect(handedOver).toBe(0);
      expect(existsSync(join(home, "this-computer.json"))).toBe(false);
    } finally {
      await machine.shutdown();
    }
  });
});
