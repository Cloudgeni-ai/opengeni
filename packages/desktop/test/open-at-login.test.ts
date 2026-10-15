import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

function computer(dataDir: string): ThisComputer {
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
    onChange: () => undefined,
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
