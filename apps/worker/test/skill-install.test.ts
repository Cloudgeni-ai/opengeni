import { expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { createSkillInstallAttemptToolDefinition } from "../src/activities/agent-turn/skill-install";

test("lazy installer authorizes before resolving and returns preservation receipt", async () => {
  const calls: string[] = [];
  let deny = false;
  const operationId = "77777777-7777-4777-8777-777777777777";
  const environment = createAttemptToolEnvironment({
    scope: {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
    },
    generation: 1,
    definitions: [
      createSkillInstallAttemptToolDefinition({
        authorize: async () => {
          calls.push("authorize");
          if (deny) throw new Error("Inactive attempt");
        },
        install: async (request) => {
          calls.push(request.source);
          expect(request).toEqual({
            operationId,
            source: "library:checkov",
            reason: "Scan infrastructure",
          });
          return {
            operationId,
            skillId: "skill",
            revisionId: "revision",
            outcome: "preserved",
            replayed: false,
          };
        },
      }),
    ],
  });
  expect(calls).toEqual([]);
  const call = () =>
    environment.callModel({
      modelName: "skill_install",
      subjectId: "agent:test",
      arguments: { operationId, source: "library:checkov", reason: "Scan infrastructure" },
    });
  const output = await call();
  expect(calls).toEqual(["authorize", "library:checkov"]);
  expect(output.structuredContent).toMatchObject({ outcome: "preserved" });
  deny = true;
  await expect(call()).rejects.toThrow("Inactive attempt");
  expect(calls).toEqual(["authorize", "library:checkov", "authorize"]);
});
