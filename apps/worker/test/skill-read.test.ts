import { buildOpenGeniAgent } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import { Capability, Manifest, type SandboxSessionLike } from "@openai/agents/sandbox";
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
  test("worker host catalog coexists with exact repository reader for real OpenGeni skills", async () => {
    const names = ["opengeni", "opengeni-client"];
    const markdown = new Map(
      await Promise.all(
        names.map(
          async (name) =>
            [
              name,
              await Bun.file(
                new URL(`../../../.agents/skills/${name}/SKILL.md`, import.meta.url),
              ).text(),
            ] as const,
        ),
      ),
    );
    let allowed = true;
    const authorize = async () => {
      if (!allowed) throw new Error("attempt ended");
    };
    const managedReader = createSkillReadAttemptToolDefinition({
      authorize,
      load: async (skill) => {
        if (skill !== "session:opengeni" && skill !== "opengeni")
          throw new Error("Skill is not available in this session.");
        return [{ path: "SKILL.md", content: "Selected session guidance" }];
      },
    });
    const settings = testSettings({ sandboxBackend: "docker" });
    const agent = buildOpenGeniAgent(
      settings,
      [
        {
          kind: "repository",
          uri: "https://github.com/Cloudgeni-ai/opengeni.git",
          ref: "main",
          mountPath: "repos/opengeni",
        },
      ],
      {
        skillCatalog: [
          {
            id: "session:opengeni",
            name: "opengeni",
            description: "Explicitly selected session guidance",
          },
        ],
        authorizeAttemptExecution: authorize,
      },
    );
    const session = {
      state: { manifest: new Manifest({ root: "/workspace" }) },
      listDir: async ({ path }: { path: string }) =>
        path === ".agents/skills"
          ? names.map((name) => ({ name, path: `${path}/${name}`, type: "dir" as const }))
          : [{ name: "SKILL.md", path: `${path}/SKILL.md`, type: "file" as const }],
      readFile: async ({ path }: { path: string }) => markdown.get(path.split("/").at(-2)!)!,
    } as SandboxSessionLike;
    const capability = (agent as unknown as { capabilities: Capability[] }).capabilities
      .find((entry) => entry.type === "workspace-skills")!
      .clone()
      .bind(session);
    const catalog = await capability.instructions(session.state.manifest);
    const repositoryReader = capability
      .tools()
      .find((entry) => entry.type === "function" && entry.name === "repository_skill_read")!;
    if (repositoryReader.type !== "function") throw new Error("missing repository reader");
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [managedReader],
    });
    // This is the incident's old route, and remains correctly unavailable to the managed reader.
    await expect(
      environment.callModel({
        modelName: "skill_read",
        arguments: { skill: "opengeni-client" },
        subjectId: "agent:test",
      }),
    ).rejects.toThrow("not available");
    for (const name of names) {
      const skill = `repository:.agents/skills/${name}/SKILL.md`;
      expect(catalog).toContain(skill);
      expect(catalog).toContain('"reader":"repository_skill_read"');
      const output = JSON.parse(
        (await repositoryReader.invoke(undefined!, JSON.stringify({ skill }))) as string,
      );
      expect(output.files).toEqual([{ path: "SKILL.md", content: markdown.get(name) }]);
    }
    expect(catalog).not.toContain('"description":">-"');
    const managed = await environment.callModel({
      modelName: "skill_read",
      arguments: { skill: "opengeni" },
      subjectId: "agent:test",
    });
    expect(managed.structuredContent).toEqual({
      files: [{ path: "SKILL.md", content: "Selected session guidance" }],
    });
    allowed = false;
    await expect(
      repositoryReader.invoke(
        undefined!,
        JSON.stringify({ skill: "repository:.agents/skills/opengeni/SKILL.md" }),
      ),
    ).rejects.toThrow("attempt ended");
    const noSandbox = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      skillCatalog: [],
    });
    expect(
      noSandbox.tools.some(
        (entry) => entry.type === "function" && entry.name === "repository_skill_read",
      ),
    ).toBe(false);
  });

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
