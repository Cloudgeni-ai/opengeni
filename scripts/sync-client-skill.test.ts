import { expect, test } from "bun:test";
import {
  buildPortableSkillArtifact,
  readSkillLibraryArtifact,
} from "../packages/runtime/src/skill-library";
import { checkClientSkill } from "./sync-client-skill";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRuntimeSkillAssets } from "./build-runtime-processes";

test("the runtime ships the complete canonical client skill without a second identity", async () => {
  await checkClientSkill();
  const source = readSkillLibraryArtifact(
    new URL("../.agents/skills/opengeni-client", import.meta.url).pathname,
  );
  const bundled = readSkillLibraryArtifact(
    new URL("../packages/runtime/src/bundled_default_skills/opengeni-client", import.meta.url)
      .pathname,
  );
  expect(buildPortableSkillArtifact(bundled.files).name).toBe("opengeni-client");
  expect(bundled.files).toEqual(source.files);
  // Each relative Markdown reference can be read from the shipped artifact.
  const paths = new Set(bundled.files.map((file) => file.path));
  const entrypoint = bundled.files.find((file) => file.path === "SKILL.md")!.content;
  for (const match of entrypoint.matchAll(/\]\((references\/[^)]+\.md)\)/g))
    expect(paths.has(match[1]!)).toBe(true);
});

test("a standalone release bundle reads the client guide and references with no repository or network", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "opengeni-client-bundle-"));
  try {
    const outdir = join(temporary, "process");
    const result = await Bun.build({
      entrypoints: [new URL("../packages/runtime/src/runtime-skills.ts", import.meta.url).pathname],
      outdir,
      target: "bun",
      format: "esm",
      naming: "skills.js",
    });
    expect(result.success).toBe(true);
    await copyRuntimeSkillAssets(new URL("..", import.meta.url).pathname, outdir);
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      globalThis.fetch = () => { throw new Error("network must not be used"); };
      const { composeRuntimeSkills, readRuntimeSkill } = await import(${JSON.stringify(join(outdir, "skills.js"))});
      const skills = composeRuntimeSkills([]);
      console.log(JSON.stringify({
        entry: readRuntimeSkill(skills, { skill: "opengeni-client" }),
        reference: readRuntimeSkill(skills, { skill: "opengeni-client", paths: ["references/discovery-and-autonomy.md"] })
      }));
    `,
      ],
      { cwd: temporary, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    for (const [key, path] of [
      ["entry", "SKILL.md"],
      ["reference", "references/discovery-and-autonomy.md"],
    ]) {
      const expected = await readFile(
        new URL(`../.agents/skills/opengeni-client/${path}`, import.meta.url),
        "utf8",
      );
      expect(output[key!].files).toEqual([{ path, content: expected }]);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
