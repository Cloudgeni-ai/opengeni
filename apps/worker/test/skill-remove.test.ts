import { expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  SkillRemoveRequest,
  createSkillRemoveAttemptToolDefinition,
} from "../src/activities/agent-turn/skill-remove";

test("skill_remove is lazy, destructive and rejects non-registry identities and model authority", async () => {
  const request = {
    operationId: crypto.randomUUID(),
    skillId: crypto.randomUUID(),
    expectedRevisionId: crypto.randomUUID(),
    expectedScopeVersion: 1,
    reason: "Remove obsolete Skill permanently",
  };
  const calls: string[] = [];
  const tool = createSkillRemoveAttemptToolDefinition({
    authorize: async () => {
      calls.push("authorize");
    },
    remove: async (value) => {
      calls.push("remove");
      expect(value).toEqual(request);
      return {
        ...value,
        revisionId: value.expectedRevisionId!,
        outcome: "applied",
        replayed: false,
        removed: true,
      };
    },
  });
  expect(tool.modelName).toBe("skill_remove");
  expect(tool.annotations?.destructiveHint).toBe(true);
  for (const skillId of ["builtin:opengeni-skills", "repository:skills/test", "session:inline"]) {
    expect(SkillRemoveRequest.safeParse({ ...request, skillId }).success).toBe(false);
  }
  expect(SkillRemoveRequest.safeParse({ ...request, actor: { kind: "human" } }).success).toBe(
    false,
  );
  expect(SkillRemoveRequest.safeParse({ ...request, expectedScopeVersion: 0 }).success).toBe(false);
  const environment = createAttemptToolEnvironment({
    scope: {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
    },
    generation: 1,
    definitions: [tool],
  });
  const result = await environment.callModel({
    modelName: "skill_remove",
    arguments: request,
    subjectId: "agent:test",
  });
  expect(result.structuredContent).toMatchObject({ removed: true });
  expect(calls).toEqual(["authorize", "remove"]);
});

test("authorization failure cannot reach deletion", async () => {
  let removed = false;
  const tool = createSkillRemoveAttemptToolDefinition({
    authorize: async () => {
      throw new Error("closed attempt");
    },
    remove: async () => {
      removed = true;
      throw new Error("unexpected");
    },
  });
  await expect(tool.execute({}, {} as never)).rejects.toThrow("closed attempt");
  expect(removed).toBe(false);
});
