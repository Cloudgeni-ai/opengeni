import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  GENERATED_ARTIFACT_CHECKS,
  GENERATED_ARTIFACTS_NOT_RECHECKED,
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
