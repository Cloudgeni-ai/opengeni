import { describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const fixtureRoot = path.resolve(import.meta.dir, "fixtures");

async function bundle(entrypoint: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(fixtureRoot, entrypoint)],
    format: "esm",
    target: "browser",
    minify: true,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Could not bundle ${entrypoint}`);
  }
  return await result.outputs[0]!.text();
}

describe("contracts browser bundle boundary", () => {
  test("retains canonical YAML validation only when Skill validators are imported", async () => {
    const [browserCore, skillValidation] = await Promise.all([
      bundle("browser-core-bundle-entry.ts"),
      bundle("skill-validation-bundle-entry.ts"),
    ]);

    for (const marker of [
      "This skill's SKILL.md header contains invalid YAML",
      "DUPLICATE_KEY",
      "MULTIPLE_DOCS",
    ]) {
      expect(browserCore).not.toContain(marker);
      expect(skillValidation).toContain(marker);
    }

    const directory = await mkdtemp(path.join(tmpdir(), "skill-validator-bundle-"));
    let validators;
    try {
      const filename = path.join(directory, "validators.mjs");
      await writeFile(filename, skillValidation);
      validators = await import(filename);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const content =
      "---\r\nname: deploy\r\ndescription: >-\r\n  Run deployment\r\n  checks\r\n---\r\n# Exact bytes\r\n";
    const files = [{ path: "SKILL.md", content }];
    for (const validate of [validators.validatePackSkill, validators.validateSessionSkill]) {
      expect(validate({ files })).toEqual({
        name: "deploy",
        description: "Run deployment checks",
        files,
      });
      expect(() =>
        validate({
          files: [
            {
              path: "SKILL.md",
              content: "---\nname: deploy\nname: duplicate\ndescription: checks\n---\n",
            },
          ],
        }),
      ).toThrow();
    }
  });

  test("keeps agent-topology and work-claim validators out of unrelated browser imports", async () => {
    const [browserCore, agentTopology] = await Promise.all([
      bundle("browser-core-bundle-entry.ts"),
      bundle("agent-topology-bundle-entry.ts"),
    ]);

    expect(browserCore).toContain("work_claim_upsert");
    expect(browserCore).not.toContain("possibleOverlap");
    expect(browserCore).not.toContain("work claim canonical key");

    expect(agentTopology).toContain("possibleOverlap");
    expect(agentTopology).toContain("noAdditionalAccess");
  });
});
