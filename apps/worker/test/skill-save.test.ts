import { describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  createSkillSaveAttemptToolDefinition,
  type SkillSaveRequest,
} from "../src/activities/agent-turn/skill-save";
import { createSkillPublishAttemptToolDefinition } from "../src/activities/agent-turn/skill-checkout";
import { createSkillInstallAttemptToolDefinition } from "../src/activities/agent-turn/skill-install";
import { createSkillRemoveAttemptToolDefinition } from "../src/activities/agent-turn/skill-remove";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};
const revisionId = "66666666-6666-4666-8666-666666666666";
const args = {
  operationId: "77777777-7777-4777-8777-777777777777",
  skillId: "88888888-8888-4888-8888-888888888888",
  expectedRevisionId: revisionId,
  expectedScopeVersion: 1,
  files: [{ path: "references/a.md", content: "updated" }],
  reason: "Correct reference",
};
const original = [
  {
    path: "SKILL.md",
    content: "---\nname: example\ndescription: Example procedure\n---\nInstructions",
  },
  { path: "references/a.md", content: "old" },
  { path: "scripts/check.sh", content: "echo check" },
];

function fixture(options: { deny?: boolean; outcome?: "applied" | "pending" } = {}) {
  const calls: string[] = [];
  const writes: SkillSaveRequest[] = [];
  const environment = createAttemptToolEnvironment({
    scope,
    generation: 1,
    definitions: [
      createSkillSaveAttemptToolDefinition({
        authorize: async () => {
          calls.push("authorize");
          if (options.deny) throw new Error("Inactive attempt");
        },
        load: async (_skillId, requestedRevision) => {
          calls.push(requestedRevision);
          return { revisionId: requestedRevision, files: original };
        },
        save: async (request) => {
          writes.push(request);
          return {
            operationId: request.operationId,
            skillId: request.skillId,
            revisionId,
            outcome: options.outcome ?? "applied",
            replayed: writes.length > 1,
          };
        },
      }),
    ],
  });
  return {
    calls,
    writes,
    call: (arguments_: Record<string, unknown> = args) =>
      environment.callModel({
        modelName: "skill_save",
        arguments: arguments_,
        subjectId: "agent:test",
      }),
  };
}

describe("skill_save gateway", () => {
  test("describes scoped behavior and discoverable triggers without bypassing learning", () => {
    const definition = createSkillSaveAttemptToolDefinition({
      authorize: async () => {},
      load: async () => {
        throw new Error("Discovery must not load content");
      },
      save: async () => {
        throw new Error("Discovery must not save content");
      },
    });
    expect(definition.description).toContain("behavioral preferences");
    expect(definition.description).toContain("description");
    expect(definition.description).toContain("instruction_policy_save");
    expect(definition.description).toContain("Off prevents agent authoring");
    expect(definition.description).toContain("Set scope only when the person wants it elsewhere");
    expect(definition.inputSchema.properties).toHaveProperty("scope");
  });

  test("tells the agent a pending Skill or change has no effect until approved, and where it is approved", () => {
    const definition = createSkillSaveAttemptToolDefinition({
      authorize: async () => {},
      load: async () => {
        throw new Error("Discovery must not load content");
      },
      save: async () => {
        throw new Error("Discovery must not save content");
      },
    });
    expect(definition.description).toContain(
      "A Skill or change pending approval has no effect until someone who can manage it approves it, in Knowledge > Review or from its card in the chat where one is shown; an edited Skill keeps its current version until then. Say so when you report the receipt",
    );
  });

  test("every Skill write tool says the same about pending changes and names the Review tab", () => {
    const refuse = async () => {
      throw new Error("Discovery must not run");
    };
    const pending =
      "A Skill or change pending approval has no effect until someone who can manage it approves it, in Knowledge > Review or from its card in the chat where one is shown; an edited Skill keeps its current version until then. Say so in your reply.";
    const install = createSkillInstallAttemptToolDefinition({
      authorize: async () => {},
      install: refuse,
    });
    const publish = createSkillPublishAttemptToolDefinition({
      authorize: async () => {},
      filesystem: refuse,
      save: refuse,
    });
    const remove = createSkillRemoveAttemptToolDefinition({
      authorize: async () => {},
      remove: refuse,
    });
    expect(install.description).toContain(pending);
    expect(publish.description).toContain(pending);
    expect(remove.description).toContain("Knowledge > Review");
    for (const definition of [install, publish, remove])
      expect(definition.description).not.toContain("Needs review");
  });

  test("preserves omitted files and returns actual pending outcome", async () => {
    const f = fixture({ outcome: "pending" });
    const result = await f.call();
    expect(f.calls).toEqual(["authorize", revisionId]);
    expect(f.writes[0]?.files).toContainEqual(original[0]);
    expect(f.writes[0]?.files).toContainEqual(original[2]);
    expect(f.writes[0]?.files).toContainEqual(args.files[0]);
    expect(result.structuredContent).toMatchObject({ outcome: "pending" });
  });

  test("expands retries from the same immutable base for lifecycle replay", async () => {
    const f = fixture();
    await f.call();
    const result = await f.call();
    expect(f.writes[0]).toEqual(f.writes[1]);
    expect(result.structuredContent).toMatchObject({ replayed: true });
  });

  test("authorization precedes reads and writes", async () => {
    const f = fixture({ deny: true });
    await expect(f.call()).rejects.toThrow("Inactive attempt");
    expect(f.calls).toEqual(["authorize"]);
    expect(f.writes).toEqual([]);
  });

  test("deletions are explicit and malformed text never reaches persistence", async () => {
    const f = fixture();
    await f.call({ ...args, deletions: ["scripts/check.sh"] });
    expect(f.writes[0]?.files.some((file) => file.path === "scripts/check.sh")).toBe(false);
    await expect(
      f.call({ ...args, files: [{ path: "bad", content: "\u0000" }] }),
    ).rejects.toThrow();
    expect(f.writes).toHaveLength(1);
  });

  test("creation requires SKILL.md and does not load a nonexistent base", async () => {
    const f = fixture();
    await expect(f.call({ ...args, expectedRevisionId: null })).rejects.toThrow();
    expect(f.calls).toEqual(["authorize"]);
    expect(f.writes).toEqual([]);
    await f.call({ ...args, expectedRevisionId: null, files: [original[0]] });
    expect(f.writes).toHaveLength(1);
  });

  test("normalizes a stringified null creation revision before reads and persistence", async () => {
    const f = fixture();
    const creation = { ...args, expectedRevisionId: "null", files: [original[0]] };
    await f.call(creation);
    expect(f.calls).toEqual(["authorize"]);
    expect(f.writes[0]?.expectedRevisionId).toBeNull();
    expect(f.writes[0]?.files).toEqual([original[0]]);
    await f.call({ ...creation, expectedRevisionId: null });
    expect(f.writes[1]).toEqual(f.writes[0]);
  });

  test("rejects invalid write identities before loading or saving any content", async () => {
    for (const invalid of [
      { expectedRevisionId: "not-a-revision" },
      { expectedRevisionId: "" },
      { expectedRevisionId: undefined },
      { expectedRevisionId: false },
      { skillId: "not-a-skill" },
      { operationId: "not-an-operation" },
      { expectedScopeVersion: -1 },
      { expectedScopeVersion: 1.5 },
    ]) {
      const f = fixture();
      await expect(f.call({ ...args, ...invalid, files: [original[0]] })).rejects.toThrow(
        Object.keys(invalid)[0]!,
      );
      // The outer gateway may reject before dispatch; neither layer may load.
      expect(f.calls.filter((call) => call !== "authorize")).toEqual([]);
      expect(f.writes).toEqual([]);
    }
  });
});
