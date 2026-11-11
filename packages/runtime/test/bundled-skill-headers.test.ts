import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSkillMetadata } from "@opengeni/contracts";

// A bundled Skill whose header does not parse fails every turn that loads it,
// so check each one here rather than at runtime.
const SRC = join(import.meta.dir, "..", "src");
const skillFiles = readdirSync(SRC)
  .filter((dir) => dir.startsWith("bundled_") && statSync(join(SRC, dir)).isDirectory())
  .flatMap((dir) =>
    readdirSync(join(SRC, dir))
      .filter((name) => statSync(join(SRC, dir, name)).isDirectory())
      .map((name) => ({ name, path: join(SRC, dir, name, "SKILL.md") })),
  );

describe("bundled Skill headers", () => {
  test("there are bundled Skills to check", () => {
    expect(skillFiles.length).toBeGreaterThan(5);
  });
  for (const skill of skillFiles) {
    test(`${skill.name} parses and is named after its directory`, () => {
      const metadata = readSkillMetadata(readFileSync(skill.path, "utf8"));
      expect(metadata.name).toBe(skill.name);
      expect(metadata.description.length).toBeGreaterThan(0);
    });
  }
});
