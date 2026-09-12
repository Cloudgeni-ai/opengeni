import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Site skill composition needs no writable application directory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "opengeni-readonly-skill-"));
  try {
    // Fail any attempt to create the former worker-local staging directory,
    // including when tests run as root and chmod would not enforce read-only.
    writeFileSync(join(cwd, ".opengeni"), "not a directory");
    const modulePath = new URL("../src/runtime-skills.ts", import.meta.url).pathname;
    const pins = {
      "@opengeni/sdk": "3.7.1-canary.2",
      "@opengeni/react": "3.7.1-canary.2",
      "@opengeni/codemode": "0.4.28-canary.2",
      "@opengeni/ogtool": "0.3.31-canary.2",
    };
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
      const { composeRuntimeSkills, loadNativeToolSkillArtifacts } = await import(${JSON.stringify(modulePath)});
      const native = loadNativeToolSkillArtifacts({
        sites: true, editableArtifacts: true, videoGeneration: true,
      });
      if (native.length !== 7) throw new Error("missing native Skill artifacts");
      if (loadNativeToolSkillArtifacts({ defaults: false, editableArtifacts: false, videoGeneration: false }).length !== 0)
        throw new Error("disabled native Skills leaked");
      const defaults = loadNativeToolSkillArtifacts({ sites: false, editableArtifacts: false, videoGeneration: false }).map(skill => skill.name).sort();
      if (JSON.stringify(defaults) !== JSON.stringify(["document-parsing", "opengeni-visualize"]))
        throw new Error("incorrect default Skills");
      const nativeSite = native.find(entry => entry.name === "opengeni-sites");
      const nativePins = nativeSite.files.find(entry => entry.path === "package-versions.json");
      if (nativePins.content !== JSON.stringify(${JSON.stringify(pins)}, null, 2))
        throw new Error("incorrect server-side package pins");
      const composition = composeRuntimeSkills([], {
        sites: true, editableArtifacts: false, videoGeneration: false,
      });
      const index = composition.index;
      const site = composition.artifacts.find(entry => entry.name === "opengeni-sites");
      if (!index.some(entry => entry.name === "opengeni-sites")) throw new Error("missing skill index");
      const skillMd = site.files.find(entry => entry.path === "SKILL.md");
      if (!skillMd.content.includes("OpenGeni")) throw new Error("missing skill");
      if (!site.files.find(entry => entry.path === "agents/openai.yaml")?.content) throw new Error("missing nested asset");
      console.log(site.files.find(entry => entry.path === "package-versions.json").content);
    `,
      ],
      {
        cwd,
        env: { ...process.env, OPENGENI_SITE_PACKAGE_VERSIONS: JSON.stringify(pins) },
      },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(pins);
    expect(readdirSync(cwd)).toEqual([".opengeni"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
