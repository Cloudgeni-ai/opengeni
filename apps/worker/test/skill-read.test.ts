import { describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { createSkillReadAttemptToolDefinition } from "../src/activities/agent-turn/skill-read";
import { loadConfiguredBundledSkills } from "../src/activities/agent-turn/skill-selection";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

describe("skill_read gateway definition", () => {
  test("selected Projects reads exact packaged guidance without sandbox access; host [] excludes it", async () => {
    const markdown = await Bun.file(
      new URL(
        "../../../packages/runtime/src/bundled_project_skills/opengeni-projects/SKILL.md",
        import.meta.url,
      ),
    ).text();
    for (const bundledSkillIds of [
      undefined,
      ["builtin:opengeni-projects"] as const,
      [],
    ] as const) {
      const selected = loadConfiguredBundledSkills({
        firstPartyTools: [],
        videoGenerationEnabled: false,
        bundledSkillIds,
        get sandboxBackend(): never {
          throw new Error("must not access sandbox");
        },
      } as Parameters<typeof loadConfiguredBundledSkills>[0]);
      const environment = createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions: [
          createSkillReadAttemptToolDefinition({
            authorize: async () => {},
            load: async (skill) => {
              const entry = selected.find(
                (item) => item.id === skill || item.artifact.name === skill,
              );
              if (!entry) throw new Error("Skill is excluded by source selection");
              return entry.artifact.files;
            },
          }),
        ],
      });
      for (const skill of ["builtin:opengeni-projects", "opengeni-projects"]) {
        const output = environment.callModel({
          modelName: "skill_read",
          arguments: { skill },
          subjectId: "agent:test",
        });
        if (bundledSkillIds?.length === 0)
          await expect(output).rejects.toThrow("excluded by source selection");
        else
          expect((await output).structuredContent).toEqual({
            files: [{ path: "SKILL.md", content: markdown }],
          });
      }
    }
  });

  test("returns edit metadata from the same read without expanding explicit paths", async () => {
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        createSkillReadAttemptToolDefinition({
          authorize: async () => {},
          load: async () => ({
            skillId: "workspace-skill",
            revisionId: "current-revision",
            scopeVersion: 4,
            installationVersion: 7,
            files: [
              { path: "SKILL.md", content: "main" },
              { path: "reference.md", content: "support" },
            ],
          }),
        }),
      ],
    });
    const output = await environment.callModel({
      modelName: "skill_read",
      arguments: { skill: "workspace-skill", paths: ["reference.md"] },
      subjectId: "agent:test",
    });
    expect(output.structuredContent).toEqual({
      skillId: "workspace-skill",
      revisionId: "current-revision",
      scopeVersion: 4,
      installationVersion: 7,
      files: [{ path: "reference.md", content: "support" }],
    });
  });

  test("uses the canonical attempt gateway and exact requested files", async () => {
    const calls: string[] = [];
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        createSkillReadAttemptToolDefinition({
          authorize: async () => {
            calls.push("authorize");
          },
          load: async (skill) => {
            calls.push(skill);
            return [
              { path: "SKILL.md", content: "main" },
              { path: "references/a.md", content: "reference" },
            ];
          },
        }),
      ],
    });
    const output = await environment.callModel({
      modelName: "skill_read",
      arguments: { skill: "deploy", paths: ["references/a.md"] },
      subjectId: "agent:test",
    });
    expect(calls).toEqual(["authorize", "deploy"]);
    expect(output.structuredContent).toEqual({
      files: [{ path: "references/a.md", content: "reference" }],
    });
  });

  test("does not bypass source selection for built-in management names", async () => {
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        createSkillReadAttemptToolDefinition({
          authorize: async () => {},
          load: async () => {
            throw new Error("Skill is excluded by source selection");
          },
        }),
      ],
    });
    await expect(
      environment.callModel({
        modelName: "skill_read",
        arguments: { skill: "opengeni-skills" },
        subjectId: "agent:test",
      }),
    ).rejects.toThrow("excluded by source selection");
  });

  test("rechecks attempt authority before loading any content", async () => {
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        createSkillReadAttemptToolDefinition({
          authorize: async () => {
            throw new Error("attempt no longer active");
          },
          load: async () => {
            throw new Error("must not load");
          },
        }),
      ],
    });
    await expect(
      environment.callModel({
        modelName: "skill_read",
        arguments: { skill: "opengeni-skills" },
        subjectId: "agent:test",
      }),
    ).rejects.toThrow("attempt no longer active");
  });
});
