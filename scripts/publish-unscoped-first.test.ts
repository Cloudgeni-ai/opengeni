import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markPrivate,
  publishUnscopedFirst,
  type UnscopedPublisher,
} from "./publish-unscoped-first";
import { repoRoot } from "./publishable-workspaces";

type Recorder = UnscopedPublisher & {
  publishes: string[];
  excluded: string[];
  warnings: string[];
};

function publisher(
  packages: { name: string; version: string; dir: string }[],
  published: boolean,
): Recorder {
  const recorder: Recorder = {
    publishes: [],
    excluded: [],
    warnings: [],
    packages: () => packages,
    published: () => published,
    publish: (directory) => {
      recorder.publishes.push(directory);
    },
    exclude: (directory) => {
      recorder.excluded.push(directory);
    },
    log: () => {},
    warn: (message) => {
      recorder.warnings.push(message);
    },
  };
  return recorder;
}

const cli = { name: "opengeni", version: "6.30.2", dir: "packages/cli" };
const sdk = { name: "@opengeni/sdk", version: "6.30.2", dir: "packages/sdk" };
const cliDirectory = join(repoRoot, "packages/cli");

describe("best-effort unscoped CLI publication", () => {
  test("publishes an unpublished CLI version from its package directory", () => {
    const target = publisher([sdk, cli], false);
    expect(publishUnscopedFirst(target)).toBe("published");
    expect(target.publishes).toEqual([cliDirectory]);
    expect(target.excluded).toEqual([]);
    expect(target.warnings).toEqual([]);
  });

  test("skips a published version and a set without the CLI", () => {
    const published = publisher([sdk, cli], true);
    expect(publishUnscopedFirst(published)).toBe("already-published");
    expect(published.publishes).toEqual([]);
    const absent = publisher([sdk], false);
    expect(publishUnscopedFirst(absent)).toBe("absent");
    expect(absent.publishes).toEqual([]);
  });

  test("a refused write warns about NPM_TOKEN, excludes the CLI and never throws", () => {
    const target = publisher([cli], false);
    target.publish = () => {
      throw new Error("npm publish exited 1");
    };
    expect(publishUnscopedFirst(target)).toBe("skipped");
    expect(target.excluded).toEqual([cliDirectory]);
    expect(target.warnings).toHaveLength(1);
    expect(target.warnings[0]).toContain("opengeni@6.30.2 was not published");
    expect(target.warnings[0]).toContain("NPM_TOKEN");
    expect(target.warnings[0]).toContain('unscoped npm package "opengeni"');
  });

  test("registry and exclusion errors are warnings too", () => {
    const lookup = publisher([cli], false);
    lookup.published = () => {
      throw new Error("registry unreachable");
    };
    lookup.exclude = () => {
      throw new Error("read-only");
    };
    expect(publishUnscopedFirst(lookup)).toBe("skipped");
    expect(lookup.warnings).toHaveLength(2);
    expect(lookup.warnings[1]).toContain("Could not exclude opengeni");
    const listing = publisher([cli], false);
    listing.packages = () => {
      throw new Error("bad manifest");
    };
    expect(publishUnscopedFirst(listing)).toBe("skipped");
  });

  test("markPrivate makes changeset publish skip the package in the CI checkout", () => {
    const directory = mkdtempSync(join(tmpdir(), "opengeni-cli-private-"));
    try {
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ name: "opengeni", version: "6.30.2" }),
      );
      markPrivate(directory);
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      expect(manifest).toEqual({ name: "opengeni", version: "6.30.2", private: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("release scripts run it before the scoped publication and only the contract is strict", () => {
    const script = readFileSync(join(repoRoot, "scripts/release-publish.sh"), "utf8");
    const step = script.indexOf("bun scripts/publish-unscoped-first.ts");
    expect(step).toBeGreaterThan(script.indexOf("bun scripts/rewrite-entry-points.ts"));
    expect(step).toBeLessThan(script.indexOf("bun node_modules/@changesets/cli/bin.js publish"));
    const stable = readFileSync(join(repoRoot, "scripts/publish-stable.ts"), "utf8");
    expect(stable).toContain("topologicallySortedPackages(releaseContractPackages())");
    expect(stable.indexOf("publishUnscopedFirst();")).toBeGreaterThan(
      stable.indexOf('run("bun", ["scripts/rewrite-entry-points.ts"]);'),
    );
    const canary = readFileSync(join(repoRoot, "scripts/publish-canary.ts"), "utf8");
    expect(canary).toContain("topologicallySortedPackages(releaseContractPackages())");
  });
});
