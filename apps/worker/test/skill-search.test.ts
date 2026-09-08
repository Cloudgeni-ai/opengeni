import { describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { PublicSkillSearchError } from "@opengeni/core";
import { createSkillSearchAttemptToolDefinition } from "../src/activities/agent-turn/skill-search";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

describe("skill_search gateway definition", () => {
  test("installed search never contacts a public provider", async () => {
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        createSkillSearchAttemptToolDefinition({
          authorize: async () => {},
          listWorkspace: async () => [
            { id: "skill-1", name: "deploy", description: "Deploy a service" },
          ],
          publicSearch: {
            search: async () => {
              throw new Error("must not contact public provider");
            },
          },
        }),
      ],
    });
    const result = await environment.callModel({
      modelName: "skill_search",
      arguments: { query: "deploy", scope: "installed" },
      subjectId: "agent:test",
    });
    expect(result.structuredContent).toMatchObject({
      workspace: [{ id: "skill-1", installed: true }],
      library: [],
      public: [],
      partial: false,
      errors: [],
    });
  });

  test("public outages preserve local matches and report partial failure", async () => {
    const environment = createAttemptToolEnvironment({
      scope,
      generation: 1,
      definitions: [
        createSkillSearchAttemptToolDefinition({
          authorize: async () => {},
          listWorkspace: async () => [
            { id: "skill-1", name: "deploy", description: "Deploy a service" },
          ],
          publicSearch: {
            search: async () => {
              throw new PublicSkillSearchError("rate_limited", "provider failed", 15);
            },
          },
        }),
      ],
    });
    const result = await environment.callModel({
      modelName: "skill_search",
      arguments: { query: "deploy" },
      subjectId: "agent:test",
    });
    expect(result.structuredContent).toMatchObject({
      workspace: [{ id: "skill-1" }],
      partial: true,
      errors: [{ source: "skills_sh", code: "rate_limited", retryAfterSeconds: 15 }],
    });
  });
});
