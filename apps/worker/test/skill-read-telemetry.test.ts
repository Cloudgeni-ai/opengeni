import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { SKILL_USE_META_KEY, skillUseFromToolOutput, type SkillUse } from "@opengeni/contracts";
import { createObservability } from "@opengeni/observability";
import {
  buildOpenGeniAgent,
  formatSkillCatalog,
  normalizeSdkEvent,
  prepareAgentTools,
  skillCatalogEntryIds,
} from "@opengeni/runtime";
import { skillArtifactContentSha256 } from "@opengeni/runtime/skill-library";
import { createWorkspaceSkillTools } from "../src/activities/agent-turn/skill-tools";
import { loadConfiguredBundledSkills } from "../src/activities/agent-turn/skill-selection";
import { recordSkillRead } from "../src/observability-metrics";
import type { SkillReadObservation } from "../src/activities/agent-turn/skill-read";

let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("skill-read-telemetry");
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

test("Skill-use telemetry reaches the event projection and never what the model receives", async () => {
  if (!app || !shared) return;
  const db = app.db;
  const suffix = crypto.randomUUID();
  const subjectId = `user:skill-read-telemetry-${suffix}`;
  const grant = (
    await bootstrapWorkspace(db, {
      accountExternalSource: "skill-read-telemetry-test",
      accountExternalId: suffix,
      accountName: "Test",
      workspaceExternalSource: "skill-read-telemetry-test",
      workspaceExternalId: suffix,
      workspaceName: "Test",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const workspaceSkillId = crypto.randomUUID();
  const saved = await saveSkill(db, {
    accountId,
    workspaceId,
    actor: { kind: "human", subjectId, principalKind: "human_session" },
    operationId: crypto.randomUUID(),
    skillId: workspaceSkillId,
    expectedRevisionId: null,
    expectedScopeVersion: 1,
    stableKey: `replica-${suffix}`,
    files: [
      {
        path: "SKILL.md",
        content:
          "---\nname: replica-research\ndescription: Answer user questions from the replica\n---\n# Replica research\nPrivate procedure text.",
      },
      { path: "references/schema.md", content: "users(id, created_at)" },
    ],
    reason: "Fixture",
  });

  const session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "How many users signed up today?",
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
  const sessionSkill = {
    name: "quarterly-close",
    description: "Close the quarter",
    files: [
      {
        path: "SKILL.md",
        content: "---\nname: quarterly-close\ndescription: Close the quarter\n---\nSecret steps.",
      },
    ],
  };
  const selected = [...builtIns, { id: sessionSkillId, artifact: sessionSkill }];
  // The model-visible index lists the workspace Skill and the built-in only.
  const indexed = skillCatalogEntryIds(
    formatSkillCatalog([
      {
        id: workspaceSkillId,
        name: "replica-research",
        description: "Answer user questions from the replica",
      },
      ...builtIns.map((entry) => ({
        id: entry.id,
        name: entry.artifact.name,
        description: entry.artifact.description || entry.artifact.name,
      })),
    ]),
  );
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
  const observability = createObservability(settings, { component: "worker" });

  const script = () => [
    { output: [functionCall("skill_read", { skill: workspaceSkillId }, "read-workspace")] },
    { output: [functionCall("skill_read", { skill: "opengeni-help" }, "read-builtin")] },
    {
      output: [
        functionCall("skill_search", { query: "quarter", scope: "installed" }, "search-quarter"),
      ],
    },
    { output: [functionCall("skill_read", { skill: "quarterly-close" }, "read-session")] },
    {
      output: [
        functionCall("skill_read", { skill: workspaceSkillId, listFiles: true }, "list-workspace"),
      ],
    },
    {
      output: [
        functionCall(
          "skill_read",
          { skill: workspaceSkillId, paths: ["references/schema.md"] },
          "files-workspace",
        ),
      ],
    },
    { output: [functionCall("skill_read", { skill: "no-such-skill" }, "read-missing")] },
    { output: [assistantMessage("12 users signed up today.", "final-answer")] },
  ];

  async function run(telemetry: boolean) {
    const observations: SkillReadObservation[] = [];
    const definitions = createWorkspaceSkillTools({
      db,
      settings,
      accountId,
      workspaceId,
      actor: { kind: "agent", ...scope },
      selected,
      filesystem: async () => {
        throw new Error("skill_read must not need a sandbox");
      },
      modelToolOutputTruncationTokens: () => settings.modelToolOutputTruncationTokens,
      ...(telemetry
        ? {
            skillReadTelemetry: {
              indexedSkillIds: () => indexed,
              observe: (observation: SkillReadObservation) => {
                observations.push(observation);
                recordSkillRead(observability, observation);
              },
            },
          }
        : {}),
    }).filter((definition) => ["skill_read", "skill_search"].includes(definition.modelName));
    const prepared = await prepareAgentTools(settings, [], {
      ...scope,
      attemptToolDefinitions: definitions,
    });
    try {
      const model = new ScriptedModel(script());
      const agent = buildOpenGeniAgent(settings, [], {
        model,
        skillCatalog: [],
        mcpServers: prepared.mcpServers,
      });
      const result = await new Runner({ tracingDisabled: true }).run(
        agent,
        "How many users signed up today?",
        { stream: true, maxTurns: 20 },
      );
      const outputs = new Map<string, unknown>();
      for await (const event of result.toStream()) {
        for (const normalized of normalizeSdkEvent(event)) {
          if (normalized.type !== "agent.toolCall.output") continue;
          const payload = normalized.payload as { id: string; output: unknown };
          outputs.set(payload.id, payload.output);
        }
      }
      await result.completed;
      return {
        observations,
        outputs,
        modelInput: JSON.stringify(model.requests.map((request) => request.input)),
        history: JSON.stringify(result.history),
      };
    } finally {
      await prepared.close();
    }
  }

  const plain = await run(false);
  const observed = await run(true);

  // The model receives byte-identical input, and model history is identical.
  expect(observed.modelInput).toBe(plain.modelInput);
  expect(observed.history).toBe(plain.history);
  for (const text of [observed.modelInput, observed.history]) {
    expect(text).not.toContain("skillUse");
    expect(text).not.toContain(SKILL_USE_META_KEY);
    expect(text).not.toContain("contentSha256");
  }
  expect(observed.modelInput).toContain("Private procedure text.");

  const uses = new Map(
    [...observed.outputs].map(([id, output]) => [id, skillUseFromToolOutput(output)]),
  );
  for (const output of plain.outputs.values()) expect(skillUseFromToolOutput(output)).toBeNull();
  const workspaceText = (id: string) =>
    Buffer.byteLength(
      (
        (observed.outputs.get(id) as { content: Array<{ text: string }> }).content[0] as {
          text: string;
        }
      ).text,
    );
  const expected: Record<string, SkillUse | null> = {
    "read-workspace": {
      id: workspaceSkillId,
      source: "workspace",
      revisionId: saved.revisionId!,
      kind: "full",
      bytes: workspaceText("read-workspace"),
      inIndex: true,
      searchedThisTurn: false,
    },
    "read-builtin": {
      id: "builtin:opengeni-help",
      source: "builtin",
      contentSha256: skillArtifactContentSha256(builtIns[0]!.artifact.files),
      kind: "full",
      bytes: workspaceText("read-builtin"),
      inIndex: true,
      searchedThisTurn: false,
    },
    "search-quarter": null,
    "read-session": {
      id: sessionSkillId,
      source: "session",
      contentSha256: skillArtifactContentSha256(sessionSkill.files),
      kind: "full",
      bytes: workspaceText("read-session"),
      inIndex: false,
      searchedThisTurn: true,
    },
    "list-workspace": {
      id: workspaceSkillId,
      source: "workspace",
      revisionId: saved.revisionId!,
      kind: "list",
      bytes: workspaceText("list-workspace"),
      inIndex: true,
      searchedThisTurn: false,
    },
    "files-workspace": {
      id: workspaceSkillId,
      source: "workspace",
      revisionId: saved.revisionId!,
      kind: "files",
      bytes: workspaceText("files-workspace"),
      inIndex: true,
      searchedThisTurn: false,
    },
    "read-missing": null,
  };
  expect(Object.fromEntries(uses)).toEqual(expected);
  // The event keeps the exact model-visible result beside the fact.
  const builtinEvent = observed.outputs.get("read-builtin") as Record<string, unknown>;
  expect({ ...builtinEvent, _meta: undefined }).toEqual({
    ...(plain.outputs.get("read-builtin") as Record<string, unknown>),
    _meta: undefined,
  });
  expect(JSON.stringify(builtinEvent._meta)).not.toContain("opengeni-help\\n");

  expect(observed.observations).toEqual([
    { caller: "model", kind: "full", source: "workspace", skill: workspaceSkillId },
    { caller: "model", kind: "full", source: "builtin", skill: "builtin:opengeni-help" },
    { caller: "model", kind: "full", source: "session", skill: sessionSkillId },
    { caller: "model", kind: "list", source: "workspace", skill: workspaceSkillId },
    { caller: "model", kind: "files", source: "workspace", skill: workspaceSkillId },
    { caller: "model", kind: "refused", source: null, skill: "no-such-skill" },
  ]);
  const metrics = await observability.prometheusMetrics();
  for (const labels of [
    ['source="builtin"', 'skill="builtin:opengeni-help"', 'kind="full"'],
    ['source="workspace"', 'skill="custom"', 'kind="full"'],
    ['source="workspace"', 'skill="custom"', 'kind="list"'],
    ['source="workspace"', 'skill="custom"', 'kind="files"'],
    ['source="session"', 'skill="custom"', 'kind="full"'],
    ['source="unknown"', 'skill="custom"', 'kind="refused"'],
  ]) {
    const line = metrics
      .split("\n")
      .find(
        (entry) =>
          entry.startsWith("opengeni_skill_reads_total{") &&
          [...labels, 'caller="model"'].every((label) => entry.includes(label)),
      );
    expect(line?.split(" ").at(-1)).toBe("1");
  }
  expect(metrics).not.toContain(workspaceSkillId);
  expect(metrics).not.toContain("quarterly-close");
}, 180_000);
