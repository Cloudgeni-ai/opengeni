import { buildOpenGeniAgent, modelToolResultFits } from "@opengeni/runtime";
import { SKILL_USE_META_KEY, skillUseFromToolOutput } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { Capability, Manifest, type SandboxSessionLike } from "@openai/agents/sandbox";
import { describe, expect, test } from "bun:test";
import {
  boundModelToolOutputItem,
  DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
} from "@opengeni/codex";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  createSkillReadAttemptToolDefinition,
  type SkillReadObservation,
} from "../src/activities/agent-turn/skill-read";
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

  for (const [name, directory] of [
    ["opengeni-help", "bundled_default_skills"],
    ["opengeni-client", "bundled_default_skills"],
    ["opengeni-projects", "bundled_project_skills"],
    ["opengeni-visualize", "bundled_default_skills"],
    ["document-parsing", "bundled_default_skills"],
  ] as const)
    test(`selected ${name} reads exact packaged guidance without sandbox access; host [] excludes it`, async () => {
      const markdown = await Bun.file(
        new URL(`../../../packages/runtime/src/${directory}/${name}/SKILL.md`, import.meta.url),
      ).text();
      for (const bundledSkillIds of [undefined, [`builtin:${name}`] as const, []] as const) {
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
        for (const skill of [`builtin:${name}`, name]) {
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

  test("inventory permits 1024 files and rejects overflow, unsafe and duplicate paths", async () => {
    const bounded = Array.from({ length: 1024 }, (_, i) => ({ path: `ref-${i}.md`, content: "" }));
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

  describe("repeated reads while the text is in active history", () => {
    const identity = { skillId: "workspace-skill", revisionId: "revision-1", scopeVersion: 4 };
    // The shape the SDK persists for a local MCP result.
    const historyResult = (output: unknown) => ({
      type: "function_call_result",
      name: "skill_read",
      callId: `call-${crypto.randomUUID()}`,
      output: [{ type: "input_text", text: JSON.stringify(output) }],
    });

    function historyReader(
      load: Parameters<typeof createSkillReadAttemptToolDefinition>[0]["load"],
      history: Record<string, unknown>[],
      options: {
        toolOutputTruncationTokens?: () => number;
        readResults?: () => Promise<Record<string, unknown>[]>;
        onLookupFailed?: (error: unknown) => void;
      } = {},
    ) {
      let lookups = 0;
      const definition = createSkillReadAttemptToolDefinition({
        authorize: async () => {},
        load,
        activeHistory: {
          readResults: async () => {
            lookups++;
            return options.readResults ? await options.readResults() : history;
          },
          toolOutputTruncationTokens:
            options.toolOutputTruncationTokens ??
            (() => DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS),
          ...(options.onLookupFailed ? { onLookupFailed: options.onLookupFailed } : {}),
        },
      });
      const environment = createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions: [definition],
      });
      return {
        definition,
        lookups: () => lookups,
        read: async (args: Record<string, unknown>) =>
          (
            await environment.callModel({
              modelName: "skill_read",
              arguments: { skill: "deploy", ...args },
              subjectId: "agent:test",
            })
          ).structuredContent,
      };
    }

    test("only the default read is replaced, and only after the same text was returned", async () => {
      const history: Record<string, unknown>[] = [];
      const skill = historyReader(async () => files, history);
      const full = { files: [files[0]] };
      expect(await skill.read({})).toEqual(full);
      history.push(historyResult(full));
      expect(await skill.read({})).toEqual({
        alreadyInContext: true,
        message:
          'Already in context: SKILL.md of "deploy" was returned earlier in this conversation and is unchanged. Use that copy. Re-read only if you need a fresh copy: call skill_read with paths ["SKILL.md"].',
      });
      expect(skill.lookups()).toBe(2);
      // An explicit path is the fresh-copy request, and inventory has no body.
      expect(await skill.read({ paths: ["SKILL.md"] })).toEqual(full);
      expect(await skill.read({ listFiles: true })).toEqual({
        paths: ["SKILL.md", "references/a.md"],
      });
      expect(skill.lookups()).toBe(2);
    });

    test("a different identity, different text, or partial output is not in context", async () => {
      const versioned = { ...identity, installationVersion: 7 };
      const skill = (history: Record<string, unknown>[]) =>
        historyReader(async () => ({ ...versioned, files }), history);
      const entry = { ...versioned, files: [files[0]] };
      for (const previous of [
        { ...entry, revisionId: "revision-0" },
        { ...entry, scopeVersion: 3 },
        { ...identity, files: [files[0]] },
        { ...entry, files: [{ path: "SKILL.md", content: "older main" }] },
        { ...entry, files: [files[1]] },
        { ...versioned, alreadyInContext: true, message: "Already in context" },
      ]) {
        expect(await skill([historyResult(previous)]).read({})).toEqual(entry);
      }
      const text = JSON.stringify(entry);
      for (const partial of [
        { ...historyResult(entry), output: [{ type: "input_text", text: text.slice(0, 40) }] },
        { ...historyResult(entry), output: [] },
        {
          ...historyResult(entry),
          output: [...historyResult(entry).output, { type: "input_text", text }],
        },
        { ...historyResult(entry), output: { type: "image", image: "data:" } },
      ]) {
        expect(await skill([partial]).read({})).toEqual(entry);
      }
      // A multi-file read that included SKILL.md counts, in every SDK output shape.
      for (const previous of [
        historyResult({ ...versioned, files }),
        { ...historyResult(entry), output: text },
        { ...historyResult(entry), output: { type: "text", text } },
      ]) {
        expect(await skill([previous]).read({})).toEqual({
          ...versioned,
          alreadyInContext: true,
          message:
            'Already in context: SKILL.md of "deploy" revision revision-1 was returned earlier in this conversation and is unchanged. Use that copy. Re-read only if you need a fresh copy: call skill_read with paths ["SKILL.md"].',
        });
      }
    });

    test("a copy this turn's model receives truncated is not in context", async () => {
      // Stored complete under the default bound, as the history sink does.
      const large = {
        path: "SKILL.md",
        content: `# Deploy\n${"Run the release checklist.\n".repeat(900)}`,
      };
      const entry = { ...identity, files: [large] };
      const stored = boundModelToolOutputItem(historyResult(entry));
      expect(JSON.parse((stored.output as Array<{ text: string }>)[0]!.text)).toEqual(entry);
      let tokens = DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS;
      const skill = historyReader(async () => ({ ...identity, files: [large] }), [stored], {
        toolOutputTruncationTokens: () => tokens,
      });
      expect(await skill.read({})).toEqual({
        ...identity,
        alreadyInContext: true,
        message:
          'Already in context: SKILL.md of "deploy" revision revision-1 was returned earlier in this conversation and is unchanged. Use that copy. Re-read only if you need a fresh copy: call skill_read with paths ["SKILL.md"].',
      });
      // A model with a lower bound received only a middle-truncated copy.
      tokens = 2_000;
      const seen = boundModelToolOutputItem(stored, tokens);
      expect((seen.output as Array<{ text: string }>)[0]!.text).toContain("tokens truncated");
      expect(await skill.read({})).toEqual(entry);
    });

    test("a failed history lookup returns the full text", async () => {
      const failures: unknown[] = [];
      const lookupError = new Error("statement timeout");
      const skill = historyReader(async () => files, [], {
        readResults: async () => {
          throw lookupError;
        },
        onLookupFailed: (error) => failures.push(error),
      });
      expect(await skill.read({})).toEqual({ files: [files[0]] });
      expect(failures).toEqual([lookupError]);
    });

    test("a Codemode program always receives the text and never reads model history", async () => {
      const skill = historyReader(async () => files, [historyResult({ files: [files[0]] })]);
      const output = await skill.definition.execute(
        { skill: "deploy" },
        { operationId: crypto.randomUUID(), caller: { kind: "codemode", subjectId: "agent:test" } },
      );
      expect(output.structuredContent).toEqual({ files: [files[0]] });
      expect(skill.lookups()).toBe(0);
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

describe("skill_read use telemetry", () => {
  const files = [
    { path: "SKILL.md", content: "---\nname: deploy\ndescription: Deploy it\n---\nmain" },
    { path: "references/a.md", content: "support" },
  ];
  const digest = "a".repeat(64);
  const builtin = {
    files,
    origin: { id: "builtin:opengeni-help", source: "builtin" as const, contentSha256: digest },
  };
  const workspace = {
    skillId: "workspace-skill",
    revisionId: "revision-1",
    scopeVersion: 4,
    files,
    origin: { id: "workspace-skill", source: "workspace" as const },
  };

  function readers(
    loaded: Parameters<typeof createSkillReadAttemptToolDefinition>[0]["load"] extends (
      skill: string,
    ) => Promise<infer T>
      ? T
      : never,
    options: {
      history?: Record<string, unknown>[];
      indexed?: () => ReadonlySet<string> | null;
      searched?: (id: string) => boolean;
      observe?: (observation: SkillReadObservation) => void;
    } = {},
  ) {
    const observations: SkillReadObservation[] = [];
    const activeHistory = options.history
      ? {
          readResults: async () => options.history!,
          toolOutputTruncationTokens: () => DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
        }
      : undefined;
    const definition = (telemetry: boolean) =>
      createSkillReadAttemptToolDefinition({
        authorize: async () => {},
        load: async () => loaded,
        ...(activeHistory ? { activeHistory } : {}),
        ...(telemetry
          ? {
              telemetry: {
                indexedSkillIds: options.indexed ?? (() => new Set(["builtin:opengeni-help"])),
                searched: options.searched ?? (() => false),
                observe: options.observe ?? ((observation) => void observations.push(observation)),
              },
            }
          : {}),
      });
    const call = (telemetry: boolean) => {
      const environment = createAttemptToolEnvironment({
        scope,
        generation: 1,
        definitions: [definition(telemetry)],
      });
      return (args: Record<string, unknown>) =>
        environment.callModel({
          modelName: "skill_read",
          arguments: { skill: "deploy", ...args },
          subjectId: "agent:test",
        });
    };
    return { observed: call(true), plain: call(false), definition, observations };
  }

  test("a model read carries the fact only in _meta and returns the same result", async () => {
    for (const [loaded, provenance] of [
      [builtin, { contentSha256: digest }],
      [workspace, { revisionId: "revision-1" }],
    ] as const) {
      const { observed, plain, observations } = readers(loaded, {
        searched: (id) => id === "workspace-skill",
      });
      for (const [args, kind] of [
        [{}, "full"],
        [{ paths: ["references/a.md"] }, "files"],
        [{ listFiles: true }, "list"],
      ] as const) {
        const expected = await plain(args);
        const actual = await observed(args);
        expect(expected._meta).toBeUndefined();
        const { _meta, ...visible } = actual;
        // The model reads the text part alone; nothing it receives changes.
        expect(visible).toEqual(expected);
        expect(JSON.stringify(visible)).toBe(JSON.stringify(expected));
        expect(Object.keys(_meta!)).toEqual([SKILL_USE_META_KEY]);
        const text = (expected.content[0] as { text: string }).text;
        expect(skillUseFromToolOutput(actual)).toEqual({
          id: loaded.origin.id,
          source: loaded.origin.source,
          ...provenance,
          kind,
          bytes: Buffer.byteLength(text),
          inIndex: loaded.origin.id === "builtin:opengeni-help",
          searchedThisTurn: loaded.origin.id === "workspace-skill",
        });
        expect(JSON.stringify(_meta)).not.toContain("main");
        expect(JSON.stringify(_meta)).not.toContain("Deploy it");
      }
      expect(observations).toEqual(
        (["full", "files", "list"] as const).map((kind) => ({
          caller: "model",
          kind,
          source: loaded.origin.source,
          skill: loaded.origin.id,
        })),
      );
    }
  });

  test("a repeated read reports already_in_context with the receipt's size", async () => {
    const history = [
      {
        type: "function_call_result",
        name: "skill_read",
        callId: "call-1",
        output: [
          {
            type: "input_text",
            text: JSON.stringify({
              skillId: "workspace-skill",
              revisionId: "revision-1",
              scopeVersion: 4,
              files: [files[0]],
            }),
          },
        ],
      },
    ];
    const { observed, plain } = readers(workspace, { history });
    const expected = await plain({});
    const actual = await observed({});
    expect(expected.structuredContent).toMatchObject({ alreadyInContext: true });
    expect({ ...actual, _meta: undefined }).toEqual({ ...expected, _meta: undefined });
    expect(skillUseFromToolOutput(actual)).toMatchObject({
      kind: "already_in_context",
      bytes: Buffer.byteLength((expected.content[0] as { text: string }).text),
      revisionId: "revision-1",
    });
  });

  test("Codemode reads are counted but never carry the fact", async () => {
    const { definition, observations } = readers(builtin);
    const output = await definition(true).execute(
      { skill: "deploy" },
      { operationId: crypto.randomUUID(), caller: { kind: "codemode", subjectId: "agent:test" } },
    );
    expect(output._meta).toBeUndefined();
    expect(output.structuredContent).toEqual({ files: [files[0]] });
    expect(observations).toEqual([
      { caller: "codemode", kind: "full", source: "builtin", skill: "builtin:opengeni-help" },
    ]);
  });

  test("a refused read is counted and its error is unchanged", async () => {
    const observations: SkillReadObservation[] = [];
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        createSkillReadAttemptToolDefinition({
          authorize: async () => {},
          load: async (skill) => {
            if (skill === "missing") throw new Error("Skill is not available in this session.");
            return builtin;
          },
          telemetry: {
            indexedSkillIds: () => null,
            searched: () => false,
            observe: (observation) => void observations.push(observation),
          },
        }),
      ],
    });
    const read = (args: Record<string, unknown>) =>
      environment.callModel({ modelName: "skill_read", arguments: args, subjectId: "agent:test" });
    await expect(read({ skill: "missing" })).rejects.toThrow("not available");
    await expect(read({ skill: "deploy", paths: ["nope.md"] })).rejects.toThrow();
    expect(observations).toEqual([
      { caller: "model", kind: "refused", source: null, skill: "missing" },
      { caller: "model", kind: "refused", source: "builtin", skill: "builtin:opengeni-help" },
    ]);
  });

  test("an authorization failure is not a Skill read", async () => {
    const observations: SkillReadObservation[] = [];
    const definition = createSkillReadAttemptToolDefinition({
      authorize: async () => {
        throw new Error("attempt no longer active");
      },
      load: async () => builtin,
      telemetry: {
        indexedSkillIds: () => null,
        searched: () => false,
        observe: (observation) => void observations.push(observation),
      },
    });
    await expect(
      definition.execute(
        { skill: "deploy" },
        { operationId: crypto.randomUUID(), caller: { kind: "model", subjectId: "agent:test" } },
      ),
    ).rejects.toThrow("attempt no longer active");
    expect(observations).toEqual([]);
  });

  test("failing telemetry never changes or fails a read", async () => {
    const throwing = readers(builtin, {
      observe: () => {
        throw new Error("registry down");
      },
    });
    expect(skillUseFromToolOutput(await throwing.observed({}))).toMatchObject({ kind: "full" });
    const broken = readers(builtin, {
      indexed: () => {
        throw new Error("index unavailable");
      },
    });
    expect(await broken.observed({})).toEqual(await broken.plain({}));
  });

  test("a read without a resolved origin carries no fact", async () => {
    const { observed, plain, observations } = readers(files);
    expect(await observed({})).toEqual(await plain({}));
    expect(observations).toEqual([
      { caller: "model", kind: "full", source: null, skill: "deploy" },
    ]);
  });

  test("the fact is dropped rather than push a result past the model-visible cap", async () => {
    const resultFor = async (size: number, telemetry: boolean) => {
      const { observed, plain } = readers({
        files: [{ path: "SKILL.md", content: "a".repeat(size) }],
        origin: builtin.origin,
      });
      return await (telemetry ? observed : plain)({});
    };
    // The largest SKILL.md whose plain result the model still receives as is.
    let low = 0;
    let high = 600_000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const fits = await resultFor(middle, false)
        .then(modelToolResultFits)
        .catch(() => false);
      if (fits) low = middle;
      else high = middle - 1;
    }
    const plainAtCap = await resultFor(low, false);
    expect(modelToolResultFits(plainAtCap)).toBe(true);
    const belowCap = skillUseFromToolOutput(await resultFor(low - 1_000, true));
    expect(belowCap).not.toBeNull();
    // With the fact attached, the model would get a spill receipt instead.
    expect(modelToolResultFits({ ...plainAtCap, _meta: { [SKILL_USE_META_KEY]: belowCap } })).toBe(
      false,
    );
    const observedAtCap = await resultFor(low, true);
    expect(observedAtCap).toEqual(plainAtCap);
  });
});
