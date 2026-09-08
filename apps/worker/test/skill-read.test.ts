import { describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { createSkillReadAttemptToolDefinition } from "../src/activities/agent-turn/skill-read";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

describe("skill_read gateway definition", () => {
  const files = [
    { path: "SKILL.md", content: "main" },
    { path: "references/a.md", content: "support" },
  ];

  function reader(load: Parameters<typeof createSkillReadAttemptToolDefinition>[0]["load"]) {
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [createSkillReadAttemptToolDefinition({ authorize: async () => {}, load })],
    });
    return (args: Record<string, unknown>) =>
      environment.callModel({
        modelName: "skill_read",
        arguments: { skill: "deploy", ...args },
        subjectId: "agent:test",
      });
  }

  test("default and listFiles:false still read only SKILL.md", async () => {
    const read = reader(async () => files);
    for (const args of [{}, { listFiles: false }]) {
      expect((await read(args)).structuredContent).toEqual({ files: [files[0]] });
    }
    expect((await read({ listFiles: false, paths: [files[1]!.path] })).structuredContent).toEqual({
      files: [files[1]],
    });
  });

  test("inventory returns paths and available identity without accessing any bodies", async () => {
    const identity = {
      skillId: "workspace-skill",
      revisionId: "revision",
      scopeVersion: 4,
      installationVersion: 7,
    };
    const noBodies = files.map(({ path }) => ({
      path,
      get content(): string {
        throw new Error("inventory must not access content");
      },
    }));
    for (const metadata of [false, true]) {
      const read = reader(async () => (metadata ? { ...identity, files: noBodies } : noBodies));
      const output = await read({ listFiles: true });
      const expected = { ...(metadata ? identity : {}), paths: ["SKILL.md", "references/a.md"] };
      expect(output.structuredContent).toEqual(expected);
      expect(output.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
    }
  });

  test("inventory rejects paths and invalid flags before loading", async () => {
    let loads = 0;
    const read = reader(async () => {
      loads++;
      return files;
    });
    for (const paths of [[], ["SKILL.md"]]) {
      await expect(read({ listFiles: true, paths })).rejects.toThrow();
    }
    for (const listFiles of ["true", 1, null]) {
      await expect(read({ listFiles })).rejects.toThrow();
    }
    expect(loads).toBe(0);
  });

  test("inventory permits 128 files and rejects overflow, unsafe and duplicate paths", async () => {
    const bounded = Array.from({ length: 128 }, (_, i) => ({ path: `ref-${i}.md`, content: "" }));
    expect((await reader(async () => bounded)({ listFiles: true })).structuredContent).toEqual({
      paths: bounded.map(({ path }) => path).sort(),
    });
    for (const invalid of [
      [...bounded, { path: "extra.md", content: "" }],
      [{ path: "../outside", content: "" }],
      [files[0]!, files[0]!],
      [{ path: "a".repeat(512 * 1024), content: "" }],
    ]) {
      await expect(reader(async () => invalid)({ listFiles: true })).rejects.toThrow();
    }
  });

  test("inventory rechecks authority before loading", async () => {
    const definition = createSkillReadAttemptToolDefinition({
      authorize: async () => {
        throw new Error("attempt no longer active");
      },
      load: async () => {
        throw new Error("must not load");
      },
    });
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [definition],
    });
    await expect(
      environment.callModel({
        modelName: "skill_read",
        arguments: { skill: "deploy", listFiles: true },
        subjectId: "agent:test",
      }),
    ).rejects.toThrow("attempt no longer active");
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
