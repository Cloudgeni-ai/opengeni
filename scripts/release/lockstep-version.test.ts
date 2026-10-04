import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedGitEnvironment } from "../../packages/runtime/test/isolated-git-home-fixture";
import { publishableWorkspacePackages } from "../publishable-workspaces";
import { DEPRECATION_MESSAGE, deprecationRanges, retiredVersions } from "./deprecate-pre-1.0";
import {
  LOCKSTEP_RESET_VERSION,
  RETIRED_PRE_RESET_VERSIONS,
  lockstepCanaryBase,
  nextFreeLockstepVersion,
  retiredVersionSet,
  retitleChangelog,
  setManifestVersion,
  sharedLockstepVersion,
} from "./lockstep-version";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("lockstep package versioning", () => {
  test("every published package is in one fixed Changesets group at one version", async () => {
    const config = await Bun.file(join(root, ".changeset/config.json")).json();
    const published = publishableWorkspacePackages(root);
    expect(config.linked ?? []).toEqual([]);
    expect(config.fixed).toHaveLength(1);
    expect([...config.fixed[0]].sort()).toEqual(published.map((pkg) => pkg.name).sort());
    const version = sharedLockstepVersion(published);
    expect(Bun.semver.order(version, LOCKSTEP_RESET_VERSION)).toBeGreaterThanOrEqual(0);
    expect(retiredVersionSet(published.map((pkg) => pkg.name)).has(version)).toBe(false);
    for (const name of Object.keys(RETIRED_PRE_RESET_VERSIONS)) {
      expect(published.map((pkg) => pkg.name)).toContain(name);
    }
  });

  test("skips every version a retired pre-reset release burned", () => {
    const taken = retiredVersionSet(Object.keys(RETIRED_PRE_RESET_VERSIONS));
    expect(nextFreeLockstepVersion("1.0.0", taken)).toBe("1.0.0");
    expect(nextFreeLockstepVersion("1.0.1", taken)).toBe("1.0.2");
    expect(nextFreeLockstepVersion("1.0.4", taken)).toBe("1.0.5");
    expect(nextFreeLockstepVersion("1.1.1", taken)).toBe("1.1.2");
    expect(nextFreeLockstepVersion("1.4.2", taken)).toBe("1.4.3");
    expect(nextFreeLockstepVersion("2.0.0", taken)).toBe("2.0.0");
    expect(lockstepCanaryBase("1.0.0", taken)).toBe("1.0.2");
    expect(() => nextFreeLockstepVersion("1.0.1-canary.1", taken)).toThrow("stable semver");
    expect(() =>
      sharedLockstepVersion([
        { name: "a", version: "1.0.0" },
        { name: "b", version: "1.0.2" },
      ]),
    ).toThrow("one lockstep version");
  });

  test("rewrites only the release version and its new changelog heading", () => {
    const manifest = '{\n  "name": "@opengeni/x",\n  "version": "1.0.1",\n  "files": ["dist"]\n}\n';
    expect(setManifestVersion(manifest, "1.0.1", "1.0.2")).toBe(
      '{\n  "name": "@opengeni/x",\n  "version": "1.0.2",\n  "files": ["dist"]\n}\n',
    );
    expect(() => setManifestVersion(manifest, "1.0.0", "1.0.2")).toThrow();
    expect(retitleChangelog("# x\n\n## 1.0.1\n\n- a\n\n## 1.0.0\n", "1.0.1", "1.0.2")).toBe(
      "# x\n\n## 1.0.2\n\n- a\n\n## 1.0.0\n",
    );
  });

  test("the operator deprecation plan retires exactly the pre-reset publications", () => {
    const packument = {
      versions: {
        "0.1.0": {},
        "1.0.1": {},
        "7.8.1": {},
        "7.8.1-canary.3": {},
        "6.0.0": { deprecated: DEPRECATION_MESSAGE },
        "1.0.0": {},
        "1.0.2": {},
        "1.0.3-canary.40000000000001": {},
      },
      time: {
        "0.1.0": "2026-01-01T00:00:00.000Z",
        "1.0.1": "2026-02-01T00:00:00.000Z",
        "6.0.0": "2026-05-01T00:00:00.000Z",
        "7.8.1": "2026-10-04T00:00:00.000Z",
        "7.8.1-canary.3": "2026-10-04T01:00:00.000Z",
        "1.0.0": "2026-10-05T00:00:00.000Z",
        "1.0.2": "2026-10-06T00:00:00.000Z",
        "1.0.3-canary.40000000000001": "2026-10-07T00:00:00.000Z",
      },
    };
    const versions = retiredVersions(packument);
    expect(versions).toEqual(["0.1.0", "1.0.1", "7.8.1-canary.3", "7.8.1"]);
    expect(deprecationRanges(versions)).toEqual(["0.1.0 || 1.0.1 || 7.8.1-canary.3 || 7.8.1"]);
    expect(() => retiredVersions({ versions: {}, time: {} })).toThrow("not published");
  });

  test("changeset version plus the guard moves a patch release off a retired version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lockstep-version-"));
    try {
      const names = ["@opengeni/contracts", "@opengeni/jev"];
      await mkdir(join(dir, ".changeset"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }),
      );
      for (const name of names) {
        const directory = join(dir, "packages", name.slice("@opengeni/".length));
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "package.json"),
          `${JSON.stringify({ name, version: "1.0.0" }, null, 2)}\n`,
        );
      }
      await writeFile(
        join(dir, ".changeset/config.json"),
        JSON.stringify({
          changelog: "@changesets/cli/changelog",
          commit: false,
          fixed: [names],
          access: "public",
          baseBranch: "main",
          updateInternalDependencies: "patch",
          ignore: [],
        }),
      );
      await writeFile(join(dir, ".changeset/fix.md"), '---\n"@opengeni/jev": patch\n---\n\nFix.\n');
      const env = isolatedGitEnvironment({
        HOME: join(dir, "home"),
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      });
      const run = async (command: string[], extraEnv: Record<string, string> = {}) => {
        const child = Bun.spawn(command, {
          cwd: dir,
          env: { ...env, ...extraEnv },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ command, status, stdout, stderr }).toMatchObject({ status: 0 });
        return stdout;
      };
      await run(["git", "init", "-b", "main"]);
      await run(["git", "add", "-A"]);
      await run(["git", "commit", "-m", "fixture"]);
      await run(["bun", join(root, "node_modules/@changesets/cli/bin.js"), "version"]);
      for (const name of names) {
        const path = join(dir, "packages", name.slice("@opengeni/".length), "package.json");
        expect(JSON.parse(await readFile(path, "utf8")).version).toBe("1.0.1");
      }
      const guard = join(root, "scripts/release/lockstep-version.ts");
      const output = await run(["bun", guard], { OPENGENI_RELEASE_SOURCE_ROOT: dir });
      expect(output).toContain("moved 2 packages to 1.0.2");
      for (const name of names) {
        const directory = join(dir, "packages", name.slice("@opengeni/".length));
        expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).version).toBe(
          "1.0.2",
        );
        const changelog = await readFile(join(directory, "CHANGELOG.md"), "utf8");
        expect(changelog).toContain("## 1.0.2");
        expect(changelog).not.toContain("## 1.0.1");
      }
      await run(["bun", guard, "--check"], { OPENGENI_RELEASE_SOURCE_ROOT: dir });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
