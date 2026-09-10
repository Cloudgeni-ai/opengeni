import { describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  createSkillSaveAttemptToolDefinition,
  type SkillSaveRequest,
} from "../src/activities/agent-turn/skill-save";

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
});
