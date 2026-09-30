import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  applyCreditDebitAfterUse,
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  createSession,
  getWorkspaceUsage,
  grantWorkspaceCredits,
  setWorkspaceAllowance,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("nonmodel-video-refund");
  if (!acquired) throw new Error("Video allowance refund verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("video refund reverses exact original member/included/FEFO allocation, not current-period spend", async () => {
  const subjectId = `human:video:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "video-refund-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Video refund",
    workspaceExternalSource: "video-refund-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Video refund",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const personalId = crypto.randomUUID();
  await shared.admin`INSERT INTO workspaces(id,account_id,name)
    VALUES(${personalId},${grant.accountId},'Personal')`;
  await shared.admin`INSERT INTO organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    VALUES(${grant.accountId},${subjectId},'owner','active',${personalId})`;
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actorSubjectId: subjectId,
    subjectId,
  };
  const allowance = await setWorkspaceAllowance(client.db, {
    ...scope,
    includedCredits: 100,
    period: "none",
    memberDefault: { credits: 1000 },
    expectedVersion: 0,
  });
  await grantWorkspaceCredits(client.db, {
    ...scope,
    operationId: "early",
    credits: 20,
    expiresAt: "2090-01-01T00:00:00Z",
  });
  await grantWorkspaceCredits(client.db, { ...scope, operationId: "late", credits: 80 });
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "video",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
    createdByContext: {},
  });
  const [turn] = await shared.admin`SELECT id FROM session_turns WHERE session_id=${session.id}`;
  const operationId = crypto.randomUUID();
  await applyCreditDebitAfterUse(client.db, {
    ...scope,
    type: "video_generation_debit",
    amountMicros: 130,
    sourceType: "video_generation_operation",
    sourceId: operationId,
    idempotencyKey: `credit:video_generation_debit:${operationId}`,
    metadata: { turnId: turn!.id },
  });
  const [allocation] = await shared.admin`
    SELECT amount,included_used,grants_used,grant_allocations,human_subject_id,period_key
    FROM workspace_video_allowance_allocations WHERE operation_id=${operationId}`;
  expect(Number(allocation?.amount)).toBe(130);
  expect(Number(allocation?.included_used)).toBe(100);
  expect(Number(allocation?.grants_used)).toBe(30);
  expect(allocation?.human_subject_id).toBe(subjectId);
  expect(allocation?.grant_allocations).toEqual([
    { operationId: "early", credits: 20 },
    { operationId: "late", credits: 10 },
  ]);
  // Changing period/policy cannot charge the refund against a fresh allowance.
  await setWorkspaceAllowance(client.db, {
    ...scope,
    includedCredits: 1000,
    period: "monthly",
    memberDefault: { credits: 1000 },
    expectedVersion: allowance.version,
  });
  const refund = {
    ...scope,
    type: "video_generation_refund",
    amountMicros: 130,
    sourceType: "video_generation_operation",
    sourceId: operationId,
    idempotencyKey: `credit:video_generation_refund:${operationId}`,
  };
  await applyCreditLedgerEntry(client.db, refund);
  await applyCreditLedgerEntry(client.db, refund);
  const originalCounters = await shared.admin`
    SELECT subject_id,used,included_used,grants_used FROM workspace_allowance_counters
    WHERE workspace_id=${scope.workspaceId} AND period_key=${allocation!.period_key}`;
  expect(originalCounters).toHaveLength(2);
  for (const counter of originalCounters) {
    expect(Number(counter.used)).toBe(0);
    expect(Number(counter.included_used)).toBe(0);
    expect(Number(counter.grants_used)).toBe(0);
  }
  const grants = await shared.admin`
    SELECT operation_id,remaining::integer FROM workspace_allowance_grants
    WHERE workspace_id=${scope.workspaceId} ORDER BY operation_id`;
  expect([...grants]).toEqual([
    { operation_id: "early", remaining: 20 },
    { operation_id: "late", remaining: 80 },
  ]);
  expect((await getWorkspaceUsage(client.db, scope)).workspace.used).toBe(0);
}, 60_000);
