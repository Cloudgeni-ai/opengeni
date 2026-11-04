import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  GENERATED_ARTIFACT_CHECKS,
  GENERATED_ARTIFACTS_NOT_RECHECKED,
  REGENERATED_ON_CONFLICT,
  regenerates,
  regenerationPlan,
  runGeneratedArtifactChecks,
  staleArtifactAnnotation,
} from "./check-generated-artifacts";

const tracked = (await Bun.$`git ls-files`.text()).split("\n").filter(Boolean);

test("every tracked generated file is re-rendered here or has a stated reason", () => {
  const covered = new Set(GENERATED_ARTIFACT_CHECKS.flatMap((check) => check.artifacts));
  const unclassified = tracked
    .filter((path) => /\.(?:gen|generated)\.[^/]+$/.test(path))
    .filter((path) => !covered.has(path) && !(path in GENERATED_ARTIFACTS_NOT_RECHECKED));
  expect(unclassified).toEqual([]);
  // No stale entries: every listed exception is still a tracked file.
  for (const path of Object.keys(GENERATED_ARTIFACTS_NOT_RECHECKED)) {
    expect(tracked).toContain(path);
  }
});

test("every check names existing artifacts, a regenerate command and Batch's enforcement", () => {
  const names = new Set<string>();
  for (const check of GENERATED_ARTIFACT_CHECKS) {
    expect(names.has(check.name)).toBe(false);
    names.add(check.name);
    for (const artifact of check.artifacts) expect(existsSync(artifact)).toBe(true);
    expect(check.check[0]).toBe("bun");
    // Batch fails on the same staleness: the named Batch script or unit test
    // exists and references the generator or one of the artifacts.
    expect(existsSync(check.batchEnforcedBy)).toBe(true);
    const enforcement = readFileSync(check.batchEnforcedBy, "utf8");
    const generator = check.regenerate.split(" ").find((part) => /\.ts$/.test(part)) ?? "";
    const referenced = [
      ...check.artifacts.map((path) => path.split("/").pop()!),
      generator.split("/").pop()!,
    ].filter(Boolean);
    expect(referenced.some((needle) => enforcement.includes(needle))).toBe(true);
    // The annotation carries the exact fix.
    expect(staleArtifactAnnotation(check)).toContain(`Run \`${check.regenerate}\``);
    expect(staleArtifactAnnotation(check).startsWith("::error ")).toBe(true);
  }
});

test("the merge batcher regenerates existing artifacts with plain commands", () => {
  const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const entry of REGENERATED_ON_CONFLICT) {
    for (const artifact of entry.artifacts) expect(existsSync(artifact)).toBe(true);
    // scripts/ci/regenerate-merge.ts runs it as these words, without a shell.
    expect(entry.regenerate).toMatch(/^bun( [\w@./:-]+)+$/);
    const script = /^bun run ([\w:-]+)$/.exec(entry.regenerate)?.[1];
    if (script) expect(rootPackage.scripts[script]).toBeDefined();
  }
  const snapshot = REGENERATED_ON_CONFLICT.find((entry) => entry.name === "Public API snapshot")!;
  expect(regenerates(snapshot, "scripts/public-api/surface.gen.json")).toBe(true);
  expect(regenerates(snapshot, "scripts/public-api/surface.gen.json.bak")).toBe(false);
});

test("the merge batcher regenerates the public API snapshot before what reads it", () => {
  const names = (conflicted: string[]) =>
    regenerationPlan(REGENERATED_ON_CONFLICT, conflicted).map((entry) => entry.name);
  // The action catalog imports surface.gen.json: built before the snapshot is
  // refreshed, it lists a PR's new routes from main's old surface.
  expect(
    names([
      "apps/api/src/mcp/action-schema-imports.gen.ts",
      "packages/contracts/src/app-action-catalog.gen.ts",
      "scripts/public-api/surface.gen.json",
    ]),
  ).toEqual(["Public API snapshot", "Organization MCP action catalog"]);
  // A snapshot conflict alone still rebuilds the catalog from the new snapshot.
  expect(names(["scripts/public-api/surface.gen.json"])).toEqual([
    "Public API snapshot",
    "Organization MCP action catalog",
  ]);
  expect(names(["packages/react/styles/compiled.css"])).toEqual(["React compiled CSS"]);
  // Every input an entry reads is a registered artifact.
  for (const entry of REGENERATED_ON_CONFLICT)
    for (const input of entry.reads ?? [])
      expect(REGENERATED_ON_CONFLICT.some((other) => regenerates(other, input))).toBe(true);
});

test("an entry that reads what a later entry regenerates is refused", () => {
  const registry = [
    { name: "Reader", artifacts: ["b.gen.txt"], regenerate: "bun b.ts", reads: ["a.gen.txt"] },
    { name: "Source", artifacts: ["a.gen.txt"], regenerate: "bun a.ts" },
  ];
  expect(() => regenerationPlan(registry, ["b.gen.txt"])).toThrow(
    '"Reader" reads a.gen.txt, which "Source" regenerates after it',
  );
});

test("a failing check is reported as stale with its output", async () => {
  const [stale, current] = await runGeneratedArtifactChecks([
    {
      name: "stale fixture",
      artifacts: [],
      check: ["bun", "-e", "console.error('fixture is stale'); process.exit(3)"],
      regenerate: "bun fixture --write",
      batchEnforcedBy: "",
    },
    {
      name: "current fixture",
      artifacts: [],
      check: ["bun", "-e", "console.log('ok')"],
      regenerate: "",
      batchEnforcedBy: "",
    },
  ]);
  expect(stale).toMatchObject({ exit: 3, output: "fixture is stale" });
  expect(current).toMatchObject({ exit: 0, output: "ok" });
});
