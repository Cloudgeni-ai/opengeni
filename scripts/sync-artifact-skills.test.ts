import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_SKILL_NAMES,
  VIDEO_SKILL_NAMES,
  checkArtifactSkillBundle,
} from "./sync-artifact-skills";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("bundled editable-artifact skills", () => {
  test("are a deterministic copy of the repo agent skills", async () => {
    await expect(checkArtifactSkillBundle()).resolves.toBeUndefined();
  });

  test("teach the canonical durable artifact surface and only explicit file boundaries", async () => {
    for (const name of ARTIFACT_SKILL_NAMES) {
      const root = join(repoRoot, ".agents", "skills", name);
      const skill = await readFile(join(root, "SKILL.md"), "utf8");
      const api = await readFile(join(root, "references", "api.md"), "utf8");
      expect(skill).toStartWith("---\nname:");
      expect(skill).toContain("description:");
      expect(skill).toContain("editable_artifact_list");
      expect(skill).toContain("editable_artifact_apply");
      expect(skill).toContain("Artifacts dock");
      expect(api).toContain('from "@opengeni/codemode"');
      expect(api).toContain("$OPENGENI_ARTIFACT_TOOL_ENTRY");
      expect(`${skill}\n${api}`).not.toContain("publish_editable_artifact");
      expect(api).not.toMatch(/from ["']@opengeni\/artifact-tool/u);
      expect(api).not.toContain("@opengeni/artifact-tool@latest");
    }
  });

  test("keeps video guidance provider-neutral and independent from Office runtime", async () => {
    for (const name of VIDEO_SKILL_NAMES) {
      const skill = await readFile(join(repoRoot, ".agents", "skills", name, "SKILL.md"), "utf8");
      expect(skill).toStartWith("---\nname:");
      expect(skill).toContain("get_video_generation_capabilities");
      expect(skill).toContain("generate_video");
      expect(skill).not.toContain("Seedance");
      expect(skill).not.toContain("apiKey");
      expect(skill).not.toContain("opengeni-artifact-runtime");
    }
  });
});
