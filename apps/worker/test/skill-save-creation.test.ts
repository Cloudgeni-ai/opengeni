import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  saveAgentLearningSettings,
  withSessionRlsActorContext,
} from "@opengeni/db";
import { readSkill } from "@opengeni/core";
import type { SkillWriteReceipt } from "@opengeni/contracts";
import { createWorkspaceSkillTools } from "../src/activities/agent-turn/skill-tools";

let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("skill-save-creation");
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

async function fixture(personal: boolean, mode: "automatic" | "review_first" | "off") {
  const db = app!.db;
  const suffix = crypto.randomUUID();
  const subjectId = `user:skill-creation-${suffix}`;
  const grant = (
    await bootstrapWorkspace(db, {
      accountExternalSource: "skill-creation-test",
      accountExternalId: suffix,
      accountName: "Test",
      workspaceExternalSource: "skill-creation-test",
      workspaceExternalId: suffix,
      workspaceName: "Test",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const context = { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
  const learningScope = personal ? "personal" : "workspace";
  await saveAgentLearningSettings(
    db,
    {
      ...context,
      actor: {
        kind: "human",
        subjectId,
        principalKind: "human_session",
        settingsScopes: [learningScope],
      },
    },
    {
      scope: learningScope,
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "automatic", instructions: "review_first", skills: mode },
    },
  );
  const session = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(db, {
      ...context,
      initialMessage: "Save a reusable procedure",
      memoryScope: personal ? "user" : "workspace",
      resources: [],
      metadata: {},
      model: "scripted",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  await initializeSessionStartAtomically(db, {
    ...context,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, context.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: suffix,
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Could not claim fixture turn");
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
  const definition = createWorkspaceSkillTools({
    db,
    settings,
    ...context,
    actor: {
      kind: "agent",
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
    selected: [],
    filesystem: async () => {
      throw new Error("Skill creation needs no sandbox");
    },
    modelToolOutputTruncationTokens: () => settings.modelToolOutputTruncationTokens,
  }).find((tool) => tool.modelName === "skill_save")!;
  return {
    context,
    call: (args: Record<string, unknown>) =>
      definition.execute(args, {
        operationId: crypto.randomUUID(),
        caller: { kind: "model" },
      } as never),
  };
}

describe("skill_save creation through the real PostgreSQL boundary", () => {
  for (const personal of [false, true]) {
    for (const mode of ["automatic", "review_first", "off"] as const) {
      test(`${personal ? "personal" : "workspace"} creation respects ${mode}`, async () => {
        if (!app) return;
        const f = await fixture(personal, mode);
        for (const revision of [null, "null"]) {
          const args = {
            operationId: crypto.randomUUID(),
            skillId: crypto.randomUUID(),
            expectedRevisionId: revision,
            expectedScopeVersion: 1,
            files: [
              {
                path: "SKILL.md",
                content:
                  "---\nname: example\ndescription: Example procedure\n---\nUse this procedure.",
              },
            ],
            reason: "Save a new procedure",
          };
          const result = await f.call(args);
          const record = await readSkill(app.db, f.context, args.skillId);
          if (mode === "off") {
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({
              error: { code: "skill_change_refused", retryable: false },
            });
            expect(JSON.stringify(result.content)).toContain("Learning is Off");
            expect(JSON.stringify(result.content)).not.toContain("Failed query");
            expect(record).toBeNull();
            continue;
          }
          expect(result.isError).toBe(false);
          const receipt = result.structuredContent as SkillWriteReceipt;
          expect(receipt).toMatchObject({
            skillId: args.skillId,
            outcome: mode === "automatic" ? "applied" : "pending",
            replayed: false,
          });
          expect(record?.scope).toBe(personal ? "user" : "workspace");
          expect(record?.files).toEqual(args.files);
          expect(record?.activeRevisionId).toBe(mode === "automatic" ? receipt.revisionId : null);
          const replay = await f.call({ ...args, expectedRevisionId: null });
          expect(replay.structuredContent).toMatchObject({ ...receipt, replayed: true });
          if (mode === "automatic") {
            const stale = await f.call({ ...args, operationId: crypto.randomUUID() });
            expect(stale.isError).toBe(true);
          }
          expect((await readSkill(app.db, f.context, args.skillId))?.revisionId).toBe(
            receipt.revisionId,
          );
          if (personal) {
            expect(
              await readSkill(
                app.db,
                { ...f.context, subjectId: "user:someone-else" },
                args.skillId,
              ),
            ).toBeNull();
          }
        }
      }, 120_000);
    }
  }
});
