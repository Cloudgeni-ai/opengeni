import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  getSessionAuthorityProjection,
  getSessionAttemptMcpApprovalPolicies,
  initializeSessionStartAtomically,
  listSessionMcpServersForRun,
  withSessionRlsActorContext,
  withSiteViewerRlsContext,
  type SessionRlsActorContext,
} from "@opengeni/db";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("site-worker-rls");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

// Execute the production actor object, so removing the root binding from the
// worker reproduces the failed live startup rather than testing a parallel copy.
function workerActor(sessionId: string, rootSessionId: string, attemptId: string) {
  const source = readFileSync(
    new URL("../src/activities/agent-turn/run.ts", import.meta.url),
    "utf8",
  );
  const parsed = parseSync("run.ts", source);
  expect(parsed.errors).toEqual([]);
  let expression: { start: number; end: number } | undefined;
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    const node = value as Record<string, any>;
    if (
      node.type === "CallExpression" &&
      node.callee?.name === "withSessionRlsActorContext" &&
      node.arguments?.[0]?.type === "ObjectExpression"
    ) {
      expect(expression).toBeUndefined();
      expression = node.arguments[0];
    }
    Object.values(node).forEach(visit);
  }
  visit(parsed.program);
  if (!expression) throw new Error("Worker actor expression missing");
  return new Function(
    "input",
    "attachmentAuthority",
    "attempt",
    "fileAuthoritySubjectId",
    "learning",
    `return (${source.slice(expression.start, expression.end)});`,
  )(
    { sessionId },
    { authorityEpoch: 1, rootSessionId },
    { turnId: crypto.randomUUID(), attemptId, executionGeneration: 1 },
    null,
    { defaultScope: "workspace", subjectId: null },
  ) as SessionRlsActorContext;
}

test("claimed guest worker reads its frozen MCP policy without opening other viewers or settled attempts", async () => {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID();
  const siteId = crypto.randomUUID(),
    versionId = crypto.randomUUID();
  await shared.admin`insert into managed_accounts(id,name) values(${accountId},'Site worker')`;
  await shared.admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Site worker')`;
  await shared.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspaceId},${accountId})`;
  await shared.admin`insert into organization_private_session_settings(account_id,enabled) values(${accountId},true)`;
  await shared.admin.begin(async (tx) => {
    await tx`insert into workspace_artifacts(id,account_id,workspace_id,slug,title,current_version_id,created_by_subject_id)
      values(${siteId},${accountId},${workspaceId},'worker','Worker fixture',${versionId},'user:fixture')`;
    await tx`insert into workspace_artifact_versions(id,account_id,workspace_id,artifact_id,revision,content_key,content_sha256,size_bytes,operation_key,created_by_subject_id)
      values(${versionId},${accountId},${workspaceId},${siteId},1,'fixture',${"a".repeat(64)},1,'fixture','user:fixture')`;
  });
  async function start(principal: string) {
    const id = crypto.randomUUID();
    await shared.admin`insert into site_runtime_conversations(session_id,account_id,workspace_id,site_id,viewer_principal,viewer_kind,limit_micros,reserved_micros)
      values(${id},${accountId},${workspaceId},${siteId},${principal},'guest',1000000,0)`;
    await withSiteViewerRlsContext({ siteId, principal }, () =>
      withSessionRlsActorContext({ subjectId: `site:${siteId}` }, () =>
        createSession(client.db, {
          requestedSessionId: id,
          accountId,
          workspaceId,
          initialMessage: "fixture",
          resources: [],
          tools: [],
          metadata: {},
          model: "test-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "service", subjectId: `site:${siteId}` },
        }),
      ),
    );
    const started = await initializeSessionStartAtomically(client.db, {
      accountId,
      workspaceId,
      sessionId: id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: id,
      workflowId: started.temporalWorkflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(`Claim failed: ${claim.reason}`);
    return { id, attemptId, claim };
  }
  const own = await start("guest:one"),
    other = await start("guest:two");
  const authority = await getSessionAuthorityProjection(client.db, workspaceId, own.id);
  expect(authority?.siteAccessRootId).toBe(own.id);
  const actor = workerActor(own.id, authority!.rootSessionId, own.attemptId);
  expect(actor.subjectId).toBe("service:agent-turn");
  expect(actor.initiatingHumanSubjectId).toBeNull();
  await withSessionRlsActorContext(actor, async () => {
    expect(
      await getSessionAttemptMcpApprovalPolicies(client.db, workspaceId, own.id, own.attemptId),
    ).toEqual({});
    expect(
      await listSessionMcpServersForRun(client.db, workspaceId, own.id, own.attemptId, null),
    ).toEqual([]);
    expect(await getSession(client.db, workspaceId, other.id)).toBeNull();
    await expect(
      getSessionAttemptMcpApprovalPolicies(client.db, workspaceId, other.id, other.attemptId),
    ).rejects.toThrow("snapshot is unavailable");
  });
  await withSessionRlsActorContext({ subjectId: "service:agent-turn" }, async () => {
    await expect(
      getSessionAttemptMcpApprovalPolicies(client.db, workspaceId, own.id, own.attemptId),
    ).rejects.toThrow("snapshot is unavailable");
  });
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: own.id,
    turnId: own.claim.turn.id,
    triggerEventId: own.claim.turn.triggerEventId,
    attemptId: own.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [],
  });
  await withSessionRlsActorContext(actor, async () => {
    await expect(
      getSessionAttemptMcpApprovalPolicies(client.db, workspaceId, own.id, own.attemptId),
    ).rejects.toThrow("snapshot is unavailable");
  });
}, 60_000);
