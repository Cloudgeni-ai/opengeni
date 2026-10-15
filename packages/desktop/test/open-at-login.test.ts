import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installLinuxAutostart, removeLinuxAutostart } from "../src/main/linux-integration";
import { ThisComputer } from "../src/main/this-computer";

const folders: string[] = [];
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "open-at-login-"));
  folders.push(path);
  return path;
}
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

function computer(dataDir: string, onChange: () => void = () => undefined): ThisComputer {
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
    openSystemSettings: () => undefined,
    trash: async () => undefined,
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
