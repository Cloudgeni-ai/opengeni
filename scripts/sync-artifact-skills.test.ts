import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_SKILL_NAMES, checkArtifactSkillBundle } from "./sync-artifact-skills";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("bundled editable-artifact skills", () => {
  test("are a deterministic copy of the repo agent skills", async () => {
    await expect(checkArtifactSkillBundle()).resolves.toBeUndefined();
  });

  test("use only the verified, portable runtime bootstrap", async () => {
    for (const name of ARTIFACT_SKILL_NAMES) {
      const root = join(repoRoot, ".agents", "skills", name);
      const skill = await readFile(join(root, "SKILL.md"), "utf8");
      const api = await readFile(join(root, "references", "api.md"), "utf8");
      expect(skill).toStartWith("---\nname:");
      expect(skill).toContain("description:");
      expect(skill).toContain("opengeni-artifact-runtime locate --json");
      expect(api).toContain("process.env.OPENGENI_ARTIFACT_TOOL_ENTRY");
      expect(api).toContain("pathToFileURL(artifactEntry).href");
      expect(api).not.toMatch(/from ["']@opengeni\/artifact-tool/u);
      expect(api).not.toContain("@opengeni/artifact-tool@latest");
    }
  });
});
