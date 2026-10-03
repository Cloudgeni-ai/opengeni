import { describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  SkillWriteReceipt,
  SkillPublicationReceipt,
  SkillSourceReleaseReceipt,
} from "../src/skills";
import {
  HumanInputQuestion,
  RequestHumanInputToolInput,
  SessionHumanInputRequest,
} from "../src/index";

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
  test("keeps unused human-input question compositions out of unrelated browser imports", async () => {
    const [browserCore, humanInputValidation] = await Promise.all([
      bundle("browser-core-bundle-entry.ts"),
      bundle("human-input-validation-bundle-entry.ts"),
    ]);
    for (const marker of [
      "text questions cannot have options",
      "select questions require options",
    ]) {
      expect(browserCore.includes(marker)).toBe(false);
      expect(humanInputValidation).toContain(marker);
    }
  });

  test("retains explicit human-input validation and exact Skill review checks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "human-input-validator-bundle-"));
    let validators;
    try {
      const filename = path.join(directory, "validators.mjs");
      await writeFile(filename, await bundle("human-input-validation-bundle-entry.ts"));
      validators = (await import(filename)).humanInputValidators;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const id = "11111111-1111-4111-8111-111111111111";
    const review = {
      removalOperationId: id,
      sourceOperationId: id,
      skillId: id,
      revisionId: id,
      expectedRevisionId: null,
      expectedScopeVersion: 1,
    };
    const question = {
      id: "choice",
      kind: "single_select",
      prompt: "Choose a format",
      options: [{ id: "text", label: "Text" }],
    };
    const sessionRequest = {
      id,
      workspaceId: id,
      sessionId: id,
      turnId: id,
      turnGeneration: 1,
      creationAttemptId: id,
      toolCallId: "call",
      status: "pending",
      allowSkip: false,
      response: null,
      respondedBy: null,
      respondedAt: null,
      expiresAt: null,
      createdAt: "2026-10-03T00:00:00Z",
      updatedAt: "2026-10-03T00:00:00Z",
    };
    for (const input of [
      question,
      { ...question, skillReview: null },
      { ...question, skillReview: review, extra: true },
      { ...question, skillReview: {} },
      { ...question, skillReview: { ...review, expectedScopeVersion: 0 } },
      { ...question, options: [] },
      { ...question, options: [question.options[0], question.options[0]] },
      { ...question, kind: "text" },
      { ...question, kind: "text", options: [], allowOther: true },
      { ...question, validation: { minSelections: 2, maxSelections: 1 } },
    ]) {
      for (const [bundled, canonical, value] of [
        [validators.HumanInputQuestion, HumanInputQuestion, input],
        [validators.RequestHumanInputToolInput, RequestHumanInputToolInput, { questions: [input] }],
        [
          validators.SessionHumanInputRequest,
          SessionHumanInputRequest,
          { ...sessionRequest, questions: [input] },
        ],
      ] as const) {
        const expected = canonical.safeParse(value);
        const actual = bundled.safeParse(value);
        expect(actual.success).toBe(expected.success);
        if (expected.success) expect(actual.data).toEqual(expected.data);
        else expect(actual.error.issues).toEqual(expected.error.issues);
      }
    }
  });

  test("keeps unused installation validators out of unrelated browser imports", async () => {
    const [browserCore, installationValidation] = await Promise.all([
      bundle("browser-core-bundle-entry.ts"),
      bundle("installation-validation-bundle-entry.ts"),
    ]);

    // skillReleases also belongs to the independent uninstall response contracts.
    for (const marker of ["skillReceipt", "skillWrites", "skillPublications"]) {
      expect(browserCore.includes(marker)).toBe(false);
      expect(installationValidation).toContain(marker);
    }
  });

  test("retains explicitly imported installation schemas and canonical receipt validation", async () => {
    const installationValidation = await bundle("installation-validation-bundle-entry.ts");
    const directory = await mkdtemp(path.join(tmpdir(), "installation-validator-bundle-"));
    let validators;
    try {
      const filename = path.join(directory, "validators.mjs");
      await writeFile(filename, installationValidation);
      validators = (await import(filename)).installationValidators;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const id = "11111111-1111-4111-8111-111111111111";
    const write = {
      operationId: id,
      skillId: id,
      revisionId: id,
      outcome: "pending",
      replayed: false,
      removed: false,
      decision: "rejected",
      pendingReason: "approval",
      skillReview: {
        removalOperationId: id,
        sourceOperationId: id,
        skillId: id,
        revisionId: id,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
      },
    };
    const publication = { ...write, sourceOperationId: id, activationEventId: null };
    const release = {
      skillId: id,
      revisionId: null,
      disposition: "preserved",
      eventId: null,
      warning: null,
    };
    const skill = {
      capabilityId: "example",
      pluginId: id,
      pluginVersionId: id,
      facetId: id,
      pluginInstallationId: id,
      facetInstallationId: id,
      installationVersion: 1,
      source: "github",
      version: "1",
      sourceUrl: "https://github.com/example/skill",
      sourceCommit: "a".repeat(40),
      contentSha256: "b".repeat(64),
      name: "example",
      status: "installed",
    };
    const plugin = {
      pluginKey: "example",
      version: "1",
      pluginId: id,
      pluginVersionId: id,
      pluginInstallationId: id,
      installationVersion: 1,
      componentCount: 1,
      status: "installed",
    };
    expect(validators.InstalledSkill.parse(skill)).toEqual(skill);
    expect(validators.InstalledSkill.parse({ ...skill, skillReceipt: write, extra: true })).toEqual(
      {
        ...skill,
        skillReceipt: write,
      },
    );
    expect(validators.InstalledPlugin.parse(plugin)).toEqual(plugin);
    expect(() => validators.InstalledPlugin.parse({ ...plugin, extra: true })).toThrow();
    const receipts = {
      skillWrites: [write],
      skillPublications: [publication],
      skillReleases: [release],
    };
    expect(validators.InstalledPlugin.parse({ ...plugin, ...receipts })).toEqual({
      ...plugin,
      ...receipts,
    });

    for (const [bundled, canonical, valid] of [
      [validators.InstalledSkill.shape.skillReceipt.unwrap(), SkillWriteReceipt, write],
      [validators.InstalledPlugin.shape.skillWrites.unwrap().element, SkillWriteReceipt, write],
      [
        validators.InstalledPlugin.shape.skillPublications.unwrap().element,
        SkillPublicationReceipt,
        publication,
      ],
      [
        validators.InstalledPlugin.shape.skillReleases.unwrap().element,
        SkillSourceReleaseReceipt,
        release,
      ],
    ] as const) {
      for (const input of [valid, { ...valid, extra: true }, {}, null]) {
        const expected = canonical.safeParse(input);
        const actual = bundled.safeParse(input);
        expect(actual.success).toBe(expected.success);
        if (expected.success) expect(actual.data).toEqual(expected.data);
        else expect(actual.error.issues).toEqual(expected.error.issues);
      }
      // Every receipt field remains validated, including nested review references.
      for (const field of Object.keys(valid)) {
        const input = { ...valid, [field]: [] };
        expect(bundled.safeParse(input).error.issues).toEqual(
          canonical.safeParse(input).error?.issues,
        );
      }
    }
  });

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
