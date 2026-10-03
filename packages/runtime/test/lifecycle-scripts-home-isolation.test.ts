// Regression: running the lifecycle-script suite on a developer machine once
// rewrote that developer's ~/.gitconfig (an empty `credential.helper` reset plus
// the fixture's path-aware helper) and created ~/.opengeni, which removed their
// real credential helpers and broke every HTTPS push. This runs the suite exactly
// as a developer would, with a fake developer HOME, and proves it stays untouched.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("lifecycle script suite home isolation", () => {
  test("a full run leaves the invoking HOME, its .gitconfig, and its XDG Git config untouched", async () => {
    const developerHome = mkdtempSync(join(tmpdir(), "opengeni-developer-home-"));
    try {
      const gitconfig =
        '[credential "https://github.com"]\n\thelper = \n\thelper = !gh auth git-credential\n';
      const xdgConfig = "[user]\n\tname = Developer\n";
      mkdirSync(join(developerHome, ".config", "git"), { recursive: true });
      writeFileSync(join(developerHome, ".gitconfig"), gitconfig);
      writeFileSync(join(developerHome, ".config", "git", "config"), xdgConfig);

      // The ambient environment of a developer shell: HOME is theirs and nothing
      // redirects Git's global configuration elsewhere.
      const environment: Record<string, string | undefined> = {
        ...process.env,
        HOME: developerHome,
      };
      for (const name of Object.keys(environment)) {
        if (name.startsWith("GIT_CONFIG") || name === "XDG_CONFIG_HOME") {
          delete environment[name];
        }
      }
      const child = Bun.spawn(
        [process.execPath, "test", "--timeout=30000", "./lifecycle-scripts.test.ts"],
        { cwd: import.meta.dir, env: environment, stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`lifecycle-scripts suite failed (${exitCode}):\n${stdout}\n${stderr}`);
      }

      expect(readFileSync(join(developerHome, ".gitconfig"), "utf8")).toBe(gitconfig);
      expect(readFileSync(join(developerHome, ".config", "git", "config"), "utf8")).toBe(xdgConfig);
      expect(existsSync(join(developerHome, ".opengeni"))).toBe(false);
    } finally {
      rmSync(developerHome, { recursive: true, force: true });
    }
  }, 180_000);
});
