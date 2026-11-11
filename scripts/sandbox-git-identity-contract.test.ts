import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// Box commands run as a uid with no passwd entry, so without a configured
// identity Git finds neither a name nor an email and `git commit` fails. Both
// images set one at the system level, which every other source overrides.
describe("sandbox images commit without a configured Git identity", () => {
  test.each(["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"])(
    "%s sets a system-level identity and nothing stronger",
    async (path) => {
      const dockerfile = await readFile(resolve(root, path), "utf8");
      expect(dockerfile).toContain('git config --system user.name "Opengeni Agent"');
      expect(dockerfile).toContain("git config --system user.email agent@opengeni.invalid");
      expect(dockerfile).not.toMatch(/git config --global user\./u);
      expect(dockerfile).not.toMatch(/^ENV (?:GIT_AUTHOR|GIT_COMMITTER|EMAIL)\b/mu);
    },
  );
});
