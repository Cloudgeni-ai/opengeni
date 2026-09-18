import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyRuntimeSkillAssets,
  RUNTIME_SKILL_ASSET_DIRECTORY_NAMES,
} from "./build-runtime-processes";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("production process bundles retain every runtime skill asset directory", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "opengeni-runtime-process-assets-"));
  try {
    const outdir = join(temporaryRoot, "dist", "process");
    await copyRuntimeSkillAssets(repositoryRoot, outdir);

    expect(RUNTIME_SKILL_ASSET_DIRECTORY_NAMES).toEqual([
      "curated_skill_library",
      "bundled_default_skills",
      "bundled_artifact_skills",
      "bundled_project_skills",
      "bundled_site_skills",
      "bundled_video_skills",
      "bundled_management_skills",
    ]);
    for (const [directoryName, skillName] of [
      ["curated_skill_library", "azure-verified-modules"],
      ["bundled_default_skills", "document-parsing"],
      ["bundled_artifact_skills", "opengeni-spreadsheets"],
      ["bundled_project_skills", "opengeni-projects"],
      ["bundled_site_skills", "opengeni-sites"],
      ["bundled_video_skills", "opengeni-video-generation"],
      ["bundled_management_skills", "opengeni-skills"],
    ] as const) {
      const skill = await readFile(
        join(outdir, "assets", "runtime", directoryName, skillName, "SKILL.md"),
        "utf8",
      );
      expect(skill).toContain(`name: ${skillName}`);
    }

    const builder = await readFile(
      join(repositoryRoot, "scripts/build-runtime-processes.ts"),
      "utf8",
    );
    expect(builder.match(/await copyRuntimeSkillAssets\(repositoryRoot, outdir\);/g)).toHaveLength(
      2,
    );
    expect(builder).toContain(
      'await writeManagedCodemodeClient(repositoryRoot, join(outdir, "assets/codemode-client.json"))',
    );
    const packageBuilder = await readFile(
      join(repositoryRoot, "scripts/build-typescript-package.ts"),
      "utf8",
    );
    expect(packageBuilder).toContain('"@opengeni/runtime"');
    expect(packageBuilder).toContain('join(packageDirectory, "dist/assets/codemode-client.json")');
    const runtimeManifest = JSON.parse(
      await readFile(join(repositoryRoot, "packages/runtime/package.json"), "utf8"),
    );
    expect(runtimeManifest.files).toContain("dist");
    // Build caching must include the CLI input closure as well as the JS SDK.
    expect(runtimeManifest.devDependencies["@opengeni/ogtool"]).toBe("workspace:*");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
