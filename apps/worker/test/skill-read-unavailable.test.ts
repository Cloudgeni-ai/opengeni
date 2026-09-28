import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Runner } from "@openai/agents";
import {
  acquireSharedTestDatabase,
  assistantMessage,
  functionCall,
  ScriptedModel,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "@opengeni/db";
import { saveSkill } from "@opengeni/core";
import { buildOpenGeniAgent, normalizeSdkEvent, prepareAgentTools } from "@opengeni/runtime";
import {
  SKILL_UNAVAILABLE_LIST_MAX_BYTES,
  SKILL_UNAVAILABLE_LIST_MAX_ENTRIES,
  SKILL_UNAVAILABLE_MESSAGE,
  unavailableSkillError,
} from "../src/activities/agent-turn/skill-read";
import { createWorkspaceSkillTools } from "../src/activities/agent-turn/skill-tools";
import { loadConfiguredBundledSkills } from "../src/activities/agent-turn/skill-selection";

let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("skill-read-unavailable");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  app = createDb(shared.appUrl, { max: 4 });
}, 180_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

function errorText(output: unknown): string {
  const result = output as { isError?: boolean; content?: Array<{ text?: string }> };
  expect(result.isError).toBe(true);
  return result.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

function listed(message: string): Array<{ id: string; name: string }> {
  return message
    .split("\n")
    .filter((line) => line.startsWith("- {"))
    .map((line) => JSON.parse(line.slice(2)) as { id: string; name: string });
}

describe("unavailableSkillError", () => {
  const uuid = (index: number) =>
    `${index.toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${index.toString(16).padStart(12, "0")}`;

  test("lists every available Skill by id and name, sorted by name", () => {
    const { message } = unavailableSkillError("no-such-skill", [
      { id: uuid(2), name: "replica-research" },
      { id: "builtin:opengeni-help", name: "opengeni-help" },
      { id: uuid(1), name: "product-analytics" },
      { id: uuid(2), name: "replica-research" },
    ]);
    expect(message).toBe(
      [
        SKILL_UNAVAILABLE_MESSAGE,
        "Retry with an exact id from these available Skills:",
        `- {"id":"builtin:opengeni-help","name":"opengeni-help"}`,
        `- {"id":"${uuid(1)}","name":"product-analytics"}`,
        `- {"id":"${uuid(2)}","name":"replica-research"}`,
      ].join("\n"),
    );
    // The requested identifier is never echoed back.
    expect(message).not.toContain("no-such-skill");
  });

  test("says so when no Skills are available", () => {
    expect(unavailableSkillError("anything", []).message).toBe(
      `${SKILL_UNAVAILABLE_MESSAGE}\nNo configured Skills are available in this session.`,
    );
  });

  test("points a repository identifier at the repository reader", () => {
    const { message } = unavailableSkillError("repository:.agents/skills/deploy/SKILL.md", [
      { id: uuid(1), name: "product-analytics" },
    ]);
    expect(message.split("\n").slice(0, 2)).toEqual([
      SKILL_UNAVAILABLE_MESSAGE,
      "Repository Skills are read with repository_skill_read.",
    ]);
  });

  test("bounds the list by entry count and points at skill_search for the rest", () => {
    const available = Array.from({ length: 200 }, (_, index) => ({
      id: uuid(index),
      name: `skill-${index.toString().padStart(3, "0")}`,
    }));
    const { message } = unavailableSkillError("no-such-skill", available);
    const entries = listed(message);
    expect(entries).toHaveLength(SKILL_UNAVAILABLE_LIST_MAX_ENTRIES);
    expect(entries[0]).toEqual({ id: uuid(0), name: "skill-000" });
    expect(message.split("\n").at(-1)).toBe(
      `${200 - SKILL_UNAVAILABLE_LIST_MAX_ENTRIES} more available Skills are not listed. Use skill_search to find them.`,
    );
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(
      SKILL_UNAVAILABLE_LIST_MAX_BYTES,
    );
  });

  test("bounds the list by bytes and counts every entry it skips", () => {
    const available = Array.from({ length: 20 }, (_, index) => ({
      id: uuid(index),
      name: `${index.toString().padStart(2, "0")}-${"x".repeat(400)}`,
    }));
    const { message } = unavailableSkillError("no-such-skill", available);
    const entries = listed(message);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(20);
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(
      SKILL_UNAVAILABLE_LIST_MAX_BYTES,
    );
    expect(message.split("\n").at(-1)).toBe(
      `${20 - entries.length} more available Skills are not listed. Use skill_search to find them.`,
    );
  });

  test("a spliced id keeps both source Skills first, inside the bound", () => {
    // Every other Skill sorts before both by name, so only the ranking keeps them listed.
    const available = Array.from({ length: 60 }, (_, index) => ({
      id: uuid(index),
      name: `a-skill-${index.toString().padStart(2, "0")}`,
    }));
    const left = { id: "9f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f", name: "product-analytics" };
    const right = { id: "1a2b3c4d-5e6f-4a7b-9c8d-0e1f2a3b4c5d", name: "replica-research" };
    const spliced = `${left.id.slice(0, 18)}${right.id.slice(18)}`;
    const entries = listed(unavailableSkillError(spliced, [...available, left, right]).message);
    expect(entries).toHaveLength(SKILL_UNAVAILABLE_LIST_MAX_ENTRIES);
    expect(entries.slice(0, 2)).toEqual([left, right]);
  });

  test("a near name ranks its Skill first; unrelated order stays by name", () => {
    const entries = listed(
      unavailableSkillError("Replica-Research-v2", [
        { id: uuid(1), name: "alpha" },
        { id: uuid(2), name: "replica-research" },
        { id: uuid(3), name: "beta" },
      ]).message,
    );
    expect(entries.map((entry) => entry.name)).toEqual(["replica-research", "alpha", "beta"]);
  });
});

describe("skill_read and skill_checkout with an unavailable Skill", () => {
  test("a garbled id returns the available Skills so the model can retry", async () => {
    if (!app || !shared) return;
    const db = app.db;
    const suffix = crypto.randomUUID();
    const subjectId = `user:skill-read-unavailable-${suffix}`;
    const grant = (
      await bootstrapWorkspace(db, {
        accountExternalSource: "skill-read-unavailable-test",
        accountExternalId: suffix,
        accountName: "Test",
        workspaceExternalSource: "skill-read-unavailable-test",
        workspaceExternalId: suffix,
        workspaceName: "Test",
        subjectId,
      })
    ).workspaceGrants[0]!;
    const accountId = grant.accountId;
    const workspaceId = grant.workspaceId!;
    const saveFixture = async (skillId: string, name: string, description: string) =>
      await saveSkill(db, {
        accountId,
        workspaceId,
        actor: { kind: "human", subjectId, principalKind: "human_session" },
        operationId: crypto.randomUUID(),
        skillId,
        expectedRevisionId: null,
        expectedScopeVersion: 1,
        stableKey: `${name}-${suffix}`,
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: ${name}\ndescription: ${description}\n---\nPrivate procedure text for ${name}.`,
          },
        ],
        reason: "Fixture",
      });
    const analyticsId = crypto.randomUUID();
    const replicaId = crypto.randomUUID();
    await saveFixture(analyticsId, "product-analytics", "Answer product usage questions");
    await saveFixture(replicaId, "replica-research", "Answer user questions from the replica");

    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "Did anyone log in today?",
      resources: [],
      metadata: {},
      model: "scripted",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: suffix,
      attemptId,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("Could not claim fixture turn");
    const scope = {
      accountId,
      workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    };
    const builtIns = loadConfiguredBundledSkills({
      firstPartyTools: [],
      videoGenerationEnabled: false,
      bundledSkillIds: ["builtin:opengeni-help"],
    });
    const sessionSkillId = `session:${session.id}:quarterly-close`;
    const selected = [
      ...builtIns,
      {
        id: sessionSkillId,
        artifact: {
          name: "quarterly-close",
          description: "Close the quarter",
          files: [
            {
              path: "SKILL.md",
              content:
                "---\nname: quarterly-close\ndescription: Close the quarter\n---\nSecret steps.",
            },
          ],
        },
      },
    ];
    const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
    let filesystemUsed = false;
    const definitions = createWorkspaceSkillTools({
      db,
      settings,
      accountId,
      workspaceId,
      actor: { kind: "agent", ...scope },
      selected,
      filesystem: async () => {
        filesystemUsed = true;
        throw new Error("an unavailable Skill must not start a sandbox");
      },
      modelToolOutputTruncationTokens: () => settings.modelToolOutputTruncationTokens,
    });

    // The incident: a model spliced the two Skill UUIDs into one identifier.
    const garbled = `${analyticsId.slice(0, 18)}${replicaId.slice(18)}`;
    const prepared = await prepareAgentTools(settings, [], {
      ...scope,
      attemptToolDefinitions: definitions.filter((definition) =>
        ["skill_read"].includes(definition.modelName),
      ),
    });
    const outputs = new Map<string, unknown>();
    try {
      const model = new ScriptedModel([
        { output: [functionCall("skill_read", { skill: garbled }, "read-garbled")] },
        { output: [functionCall("skill_read", { skill: replicaId }, "read-retry")] },
        { output: [assistantMessage("Two people logged in today.")] },
      ]);
      const agent = buildOpenGeniAgent(settings, [], {
        model,
        skillCatalog: [],
        mcpServers: prepared.mcpServers,
      });
      const result = await new Runner({ tracingDisabled: true }).run(
        agent,
        "Did anyone log in today?",
        { stream: true, maxTurns: 10 },
      );
      for await (const event of result.toStream()) {
        for (const normalized of normalizeSdkEvent(event)) {
          if (normalized.type !== "agent.toolCall.output") continue;
          const payload = normalized.payload as { id: string; output: unknown };
          outputs.set(payload.id, payload.output);
        }
      }
      await result.completed;
    } finally {
      await prepared.close();
    }

    const text = errorText(outputs.get("read-garbled"));
    expect(text).toContain("Skill is not available in this session.");
    for (const [id, name] of [
      [analyticsId, "product-analytics"],
      [replicaId, "replica-research"],
      ["builtin:opengeni-help", "opengeni-help"],
      [sessionSkillId, "quarterly-close"],
    ] as const) {
      expect(text).toContain(JSON.stringify({ id, name }));
    }
    // Names and ids only: no descriptions or Skill text.
    expect(text).not.toContain("Answer product usage questions");
    expect(text).not.toContain("Private procedure text");
    expect(text).not.toContain("Secret steps");
    const retried = outputs.get("read-retry") as { isError?: boolean; content: [{ text: string }] };
    expect(retried.isError).toBeFalsy();
    expect(retried.content[0].text).toContain("Private procedure text for replica-research.");

    // skill_checkout resolves through the same reader and fails before a sandbox starts.
    const checkout = definitions.find((definition) => definition.modelName === "skill_checkout")!;
    const refused = checkout.execute(
      { skill: garbled, directory: "skills/replica" },
      { operationId: crypto.randomUUID(), caller: { kind: "model", subjectId: "agent:test" } },
    );
    await expect(refused).rejects.toThrow(
      JSON.stringify({ id: replicaId, name: "replica-research" }),
    );
    expect(filesystemUsed).toBe(false);
  }, 180_000);
});
