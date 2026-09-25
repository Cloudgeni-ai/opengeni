// The isolated-HOME fixture is the only thing standing between a host-executed
// lifecycle script and the developer's real ~/.gitconfig, so its refusals are
// tested directly: a misdirected HOME must throw before anything is created.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertIsolatedHome,
  hostShellSession,
  isolatedGitEnvironment,
} from "./isolated-git-home-fixture";

describe("isolated Git HOME fixture", () => {
  test("refuses the account home and the inherited HOME", () => {
    expect(() => isolatedGitEnvironment({ HOME: homedir() })).toThrow("Refusing");
    if (process.env.HOME) {
      expect(() => isolatedGitEnvironment({ HOME: process.env.HOME! })).toThrow("Refusing");
    }
  });

  test("refuses relative, non-temporary, and escaping paths without creating them", () => {
    expect(() => assertIsolatedHome(undefined)).toThrow("absolute temporary directory");
    expect(() => assertIsolatedHome("relative/home")).toThrow("absolute temporary directory");
    expect(existsSync("relative")).toBe(false);

    const outsideTemporary = join(import.meta.dir, `fixture-refusal-${randomUUID()}`, "home");
    const escapingTemporary = join(tmpdir(), "..", `opengeni-fixture-escape-${randomUUID()}`);
    try {
      for (const home of [outsideTemporary, escapingTemporary]) {
        expect(() => isolatedGitEnvironment({ HOME: home })).toThrow(
          "tests must use an isolated HOME",
        );
        expect(() => hostShellSession(home)).toThrow("tests must use an isolated HOME");
        expect(existsSync(home)).toBe(false);
      }
      expect(existsSync(join(outsideTemporary, ".."))).toBe(false);
    } finally {
      rmSync(join(outsideTemporary, ".."), { recursive: true, force: true });
      rmSync(escapingTemporary, { recursive: true, force: true });
    }
  });

  test("pins HOME and Git config inside an accepted temporary HOME and drops ambient redirects", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-fixture-accepted-"));
    try {
      const home = join(root, "nested", "home");
      const environment = isolatedGitEnvironment(
        { HOME: home, KEEP_ME: "yes" },
        {},
        {
          PATH: "/bin",
          GIT_DIR: "/somewhere/else/.git",
          GIT_CONFIG_GLOBAL: "/real/.gitconfig",
          XDG_CONFIG_HOME: "/real/.config",
          OPENGENI_GIT_PROVISIONING_TARGET: "sandbox",
          OPENGENI_CODEMODE_TOKEN_FILE: "/real/.opengeni/codemode-token",
        },
      );
      expect(existsSync(home)).toBe(true);
      expect(environment).toEqual({
        PATH: "/bin",
        KEEP_ME: "yes",
        HOME: home,
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        XDG_CONFIG_HOME: join(home, ".config"),
        GIT_CONFIG_NOSYSTEM: "1",
      });
      expect(
        isolatedGitEnvironment({ HOME: home }, { sandboxGitProvisioning: true }, {})
          .OPENGENI_GIT_PROVISIONING_TARGET,
      ).toBe("sandbox");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("host shell sessions run in the isolated HOME without the sandbox provisioning target", async () => {
    const home = mkdtempSync(join(tmpdir(), "opengeni-fixture-shell-"));
    try {
      const result = await hostShellSession(home).exec({
        cmd: 'printf "%s|%s|%s|%s" "$HOME" "$GIT_CONFIG_GLOBAL" "${OPENGENI_GIT_PROVISIONING_TARGET:-unset}" "$(pwd -P)"',
      });
      expect(result.exitCode).toBe(0);
      const [shellHome, gitConfig, target, cwd] = result.stdout.split("|");
      expect(shellHome).toBe(home);
      expect(gitConfig).toBe(join(home, ".gitconfig"));
      expect(target).toBe("unset");
      expect(existsSync(cwd!)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
