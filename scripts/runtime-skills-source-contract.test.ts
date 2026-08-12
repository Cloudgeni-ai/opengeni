import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("runtime Skills have one explicit composition owner and no legacy default bundles", () => {
  for (const legacyDirectory of [
    "packages/runtime/src/bundled_hashicorp_terraform_skills",
    "packages/runtime/src/bundled_skill_library",
  ]) {
    expect(existsSync(join(repositoryRoot, legacyDirectory))).toBe(false);
  }

  expect(existsSync(join(repositoryRoot, "packages/runtime/src/curated_skill_library"))).toBe(true);

  const runtimeFacade = readFileSync(join(repositoryRoot, "packages/runtime/src/index.ts"), "utf8");
  const runtimeSkills = readFileSync(
    join(repositoryRoot, "packages/runtime/src/runtime-skills.ts"),
    "utf8",
  );

  expect(runtimeFacade).not.toContain("lazySkillSourceWithPackSkills");
  expect(runtimeFacade).not.toContain("bundled_hashicorp_terraform_skills");
  expect(runtimeFacade).not.toContain("bundled_skill_library");
  expect(runtimeSkills).not.toContain('source: "bundled"');
  expect(runtimeSkills).toContain('source: "installation"');
  expect(runtimeSkills).toContain('source: "pack"');
  expect(runtimeSkills).toContain('source: "session"');
  expect(runtimeSkills).toContain('source: "native_tool"');
});
