import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A tag or branch of a third-party action can be moved to new code at any
// time, and that code then runs with the job's secrets. Every external action
// is pinned to a full commit SHA; the trailing comment keeps the tag readable
// and lets Dependabot propose updates.
const repoRoot = join(import.meta.dir, "..");

function workflowFiles(): string[] {
  const workflows = readdirSync(join(repoRoot, ".github/workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(".github/workflows", name));
  const actions = readdirSync(join(repoRoot, ".github/actions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ["action.yml", "action.yaml"]
        .map((file) => join(".github/actions", entry.name, file))
        .filter((path) => {
          try {
            readFileSync(join(repoRoot, path));
            return true;
          } catch {
            return false;
          }
        }),
    );
  return [...workflows, ...actions];
}

export function unpinnedActionReferences(source: string): string[] {
  const unpinned: string[] = [];
  for (const match of source.matchAll(/^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/gm)) {
    const reference = match[1]!;
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    if (/@[0-9a-f]{40}$/.test(reference)) continue;
    unpinned.push(reference);
  }
  return unpinned;
}

describe("GitHub Actions pinning", () => {
  test("flags tag, branch and missing refs but accepts commit pins and local actions", () => {
    expect(
      unpinnedActionReferences(
        [
          "steps:",
          "  - uses: actions/checkout@v6",
          "  - uses: dtolnay/rust-toolchain@stable",
          "  - uses: owner/no-ref",
          "  - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2",
          "  - uses: ./.github/actions/setup",
        ].join("\n"),
      ),
    ).toEqual(["actions/checkout@v6", "dtolnay/rust-toolchain@stable", "owner/no-ref"]);
  });

  test("every external action in workflows and composite actions is pinned to a commit", () => {
    const offenders = workflowFiles().flatMap((path) =>
      unpinnedActionReferences(readFileSync(join(repoRoot, path), "utf8")).map(
        (reference) => `${path}: ${reference}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
