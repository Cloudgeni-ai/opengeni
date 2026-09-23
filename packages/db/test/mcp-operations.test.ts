import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { retrySessionActivityRls } from "../src/database";
import { provisionRoles } from "../src/provision-roles";
import {
  captureMcpOperation,
  claimMcpOperationObservation,
  readMcpOperation,
  settleMcpOperationObservation,
  settleOriginalMcpOperation,
} from "../src/mcp-operations";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  withRlsContext,
  applySessionTurnSettlement,
  enqueueSessionTurn,
  appendSessionEvents,
  ensureExternalIdentity,
  grantWorkspaceAccess,
  createWorkspace,
  createScheduledTask,
} from "../src/index";
import { createScheduledTaskActivities } from "../../../apps/worker/src/activities/scheduled-tasks";
import type { ActivityServices } from "../../../apps/worker/src/activities/types";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";
import {
  beginExternalIdentityLink,
  confirmExternalIdentityLink,
  revokeExternalIdentityLink,
} from "../src/external-identity-links";
import { captureExternalLinkTurnAuthority } from "../src/external-link-work";
import type { ExternalLinkWorkSnapshot } from "@opengeni/contracts/external-identities";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const nativeUrl = process.env.MCP_LEDGER_TEST_ADMIN_URL;
  const acquired = nativeUrl
    ? await (async () => {
        // Explicitly prepared native fixtures permit red/green replay against
        // the retained pre-fix schema without rewriting migration history.
        if (process.env.MCP_LEDGER_TEST_PREPARED !== "1") {
          await migrate(process.env.MCP_LEDGER_TEST_OWNER_URL ?? nativeUrl);
          await provisionRoles(nativeUrl, {
            appRole: "opengeni_app",
            appPassword: "ledger-test-only",
            rlsStrategy: "force",
          });
        }
        const admin = postgres(nativeUrl, { max: 4 });
        const appUrl = new URL(nativeUrl);
        appUrl.username = "opengeni_app";
        appUrl.password = "ledger-test-only";
        return {
          admin,
          adminUrl: nativeUrl,
          appUrl: appUrl.toString(),
          release: async () => {
            await admin.end();
          },
        };
      })()
    : await acquireSharedTestDatabase("mcp-operations");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(
  options: { human?: boolean; linked?: boolean; ancestor?: boolean; legacy?: boolean } = {},
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "MCP ledger",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "MCP ledger",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  let subjectId = "ledger-test";
  let linkSnapshot: ExternalLinkWorkSnapshot | undefined;
  if (options.human || options.linked || options.legacy) {
    const identity = await ensureExternalIdentity(client.db, {
      accountId: scope.accountId,
      externalId: suffix,
    });
    subjectId = identity.subjectId;
    if (options.legacy) subjectId = `user:${crypto.randomUUID()}`;
    if (options.linked) {
      subjectId = `user:${crypto.randomUUID()}`;
      const personal = await createWorkspace(client.db, {
        accountId: scope.accountId,
        name: "Ledger native owner",
      });
      await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id,authorization_revision)
        values(${scope.accountId},${subjectId},'member','active',${personal.id},1)`;
      const pending = await beginExternalIdentityLink(client.db, identity, {
        permissions: ["sessions:read", "sessions:create"],
      });
      const linked = await confirmExternalIdentityLink(client.db, {
        accountId: scope.accountId,
        linkId: pending.link.id,
        nativeSubjectId: subjectId,
        request: {
          challenge: pending.challenge,
          expectedRevision: 1,
          permissions: ["sessions:read", "sessions:create"],
        },
      });
      linkSnapshot = {
        identity: { source: identity.source, externalId: identity.externalId },
        actor: {
          accountId: scope.accountId,
          authenticatingApiKeyId: crypto.randomUUID(),
          externalIdentityId: identity.id,
          externalSubjectId: identity.subjectId,
          externalAuthorizationRevision: identity.authorizationRevision,
          effectiveSubjectId: subjectId,
          actingMode: "linked_native",
          linkId: linked.id,
          linkRevision: linked.revision,
        },
        permissions: ["sessions:read", "sessions:create"],
      };
    }
    await grantWorkspaceAccess(client.db, {
      ...scope,
      subjectId,
      permissions: [
        "sessions:read",
        "sessions:create",
        "sessions:control",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
      ],
    });
  }
  const parent = options.ancestor
    ? await createSession(client.db, {
        ...scope,
        initialMessage: "ancestor",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      })
    : null;
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: {
      kind: options.human || options.linked || options.legacy ? "subject" : "service",
      subjectId,
    },
    ...(parent ? { parentSessionId: parent.id } : {}),
  });
  await initializeSessionStartAtomically(client.db, {
    ...scope,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    ...(linkSnapshot
      ? {
          captureInitialTurnAuthority: (tx: typeof client.db, turnId: string) =>
            captureExternalLinkTurnAuthority(tx, {
              ...scope,
              sessionId: session.id,
              turnId,
              snapshot: linkSnapshot!,
            }),
        }
      : {}),
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("fixture not claimed");
  return {
    ...scope,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
  };
}
type Scope = Awaited<ReturnType<typeof fixture>>;
// Exercise the actual protected SQL boundary, including calls that bypass the TS adapter.
async function command(
  scope: Scope,
  action: string,
  payload: Record<string, unknown>,
  db = client.db,
): Promise<any> {
  return withRlsContext(
    db,
    scope,
    async (tx) => {
      const result =
        await tx.execute(sql`select mcp_operation_command(${JSON.stringify(scope)}::jsonb,
      ${action}::text, ${JSON.stringify(payload)}::jsonb) as value`);
      return (Array.isArray(result) ? result : result.rows)[0].value;
    },
    undefined,
    "none",
  );
}
const operation = () => ({
  operationId: crypto.randomUUID(),
  sourceCallId: "sdk_exact_call",
  serverId: "test",
  originalTool: "write",
  observerTool: "read_receipt",
  argumentDigest: "a".repeat(64),
  destinationDigest: "b".repeat(64),
  authorityDigest: "c".repeat(64),
});
const receipt = {
  receiptRevision: "v1",
  result: { content: [{ type: "text", text: "done" }], isError: true },
};

test("capture acknowledgment loss cannot reauthorize dispatch; survives new DB handles", async () => {
  const scope = await fixture();
  const op = operation();
  expect(await command(scope, "capture", op)).toBe("created");
  const restarted = createDb(shared.appUrl);
  try {
    expect(await command(scope, "capture", op, restarted.db)).toBe("existing");
    expect(
      await command(scope, "read", { operationId: op.operationId }, restarted.db),
    ).toMatchObject({
      status: "found",
      operation: { operationId: op.operationId, sourceCallId: op.sourceCallId },
    });
    await expect(
      command(scope, "capture", { ...op, argumentDigest: "d".repeat(64) }),
    ).rejects.toThrow();
  } finally {
    await restarted.close();
  }
});

test("race claims, idempotent and conflicting receipts preserve first terminal and original timeout", async () => {
  const scope = await fixture();
  const op = operation();
  await command(scope, "capture", op);
  await command(scope, "settle_original", {
    operationId: op.operationId,
    outcome: "outcome_unknown",
  });
  const claims = await Promise.all([
    command(scope, "claim_read", { operationId: op.operationId }),
    command(scope, "claim_read", { operationId: op.operationId }),
  ]);
  expect(claims.filter((c) => c.status === "claimed")).toHaveLength(1);
  expect(claims.filter((c) => c.status === "busy")).toHaveLength(1);
  const claimId = claims.find((c) => c.status === "claimed").claimId;
  const payload = { operationId: op.operationId, claimId, ...receipt };
  expect(await command(scope, "settle_observation", payload)).toMatchObject({ status: "settled" });
  expect(await command(scope, "settle_observation", payload)).toMatchObject({ status: "existing" });
  expect(
    await command(scope, "settle_observation", { ...payload, receiptRevision: "v2" }),
  ).toMatchObject({ status: "conflict" });
  await expect(
    command(scope, "settle_original", {
      operationId: op.operationId,
      outcome: "completed",
      result: receipt.result,
    }),
  ).rejects.toThrow();
  expect(await command(scope, "read", { operationId: op.operationId })).toMatchObject({
    status: "found",
    operation: {
      originalOutcome: "outcome_unknown",
      observationResult: receipt.result,
      receiptRevision: "v1",
    },
  });
});

test("exact source tuple ambiguity is explicit; tenant, session and stale attempts cannot read", async () => {
  const scope = await fixture();
  const op = operation();
  await command(scope, "capture", op);
  await command(scope, "capture", { ...op, operationId: crypto.randomUUID() });
  expect(
    await command(scope, "read", { sourceTurnId: scope.turnId, sourceCallId: op.sourceCallId }),
  ).toEqual({ status: "ambiguous" });
  expect(await command(scope, "read", { sourceTurnId: scope.turnId, sourceCallId: "sdk" })).toEqual(
    { status: "not_found" },
  );
  const other = await fixture();
  expect(await command(other, "read", { operationId: op.operationId })).toEqual({
    status: "not_found",
  });
  await expect(
    command({ ...scope, attemptId: crypto.randomUUID() }, "read", { operationId: op.operationId }),
  ).rejects.toThrow();
  await expect(
    command({ ...scope, sessionId: other.sessionId }, "capture", operation()),
  ).rejects.toThrow();
});

test("direct runtime table DML is forbidden", async () => {
  const scope = await fixture();
  const [table] =
    await shared.admin`select relrowsecurity, relforcerowsecurity from pg_class where oid='mcp_operations'::regclass`;
  expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  await expect(
    withRlsContext(client.db, scope, (tx) => tx.execute(sql`delete from mcp_operations`)),
  ).rejects.toThrow();
  await expect(
    withRlsContext(client.db, scope, (tx) => tx.execute(sql`select * from mcp_operations`)),
  ).rejects.toThrow();
});

test("expired observation claims can retry only reads; old claim and attempt cannot settle", async () => {
  const scope = await fixture();
  const op = operation();
  await command(scope, "capture", op);
  const first = await command(scope, "claim_read", { operationId: op.operationId });
  await shared.admin`update mcp_operations set observation_claim_expires_at=clock_timestamp()-interval '1 second' where operation_id=${op.operationId}`;
  expect(
    await command(scope, "settle_observation", {
      operationId: op.operationId,
      claimId: first.claimId,
      ...receipt,
    }),
  ).toEqual({ status: "stale_claim" });
  const next = await command(scope, "claim_read", { operationId: op.operationId });
  expect(next.status).toBe("claimed");
  expect(next.claimId).not.toBe(first.claimId);
  expect(await command(scope, "capture", op)).toBe("existing");
  expect(
    await command(scope, "settle_observation", {
      operationId: op.operationId,
      claimId: first.claimId,
      ...receipt,
    }),
  ).toEqual({ status: "stale_claim" });
  expect(
    await command(scope, "settle_observation", {
      operationId: op.operationId,
      claimId: next.claimId,
      ...receipt,
    }),
  ).toMatchObject({ status: "settled" });
});

async function successor(scope: Scope, principal: string): Promise<Scope> {
  const [turn] =
    await shared.admin`select trigger_event_id from session_turns where id=${scope.turnId}`;
  await applySessionTurnSettlement(client.db, scope.workspaceId, {
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    attemptId: scope.attemptId,
    triggerEventId: turn!.trigger_event_id,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { output: "done" } }],
  });
  const [trigger] = await appendSessionEvents(client.db, scope.workspaceId, scope.sessionId, [
    { type: "user.message", payload: { text: "read" } },
  ]);
  await enqueueSessionTurn(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    triggerEventId: trigger!.id,
    temporalWorkflowId: `session-${scope.sessionId}`,
    source: "api",
    prompt: "read",
    resources: [],
    tools: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "service", subjectId: principal },
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: scope.sessionId,
    workflowId: `session-${scope.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("successor not claimed");
  return {
    ...scope,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

test("current successor attempt may read only its original effective principal; source attempt is stale", async () => {
  const scope = await fixture();
  const op = operation();
  await command(scope, "capture", op);
  const original = await command(scope, "read", { operationId: op.operationId });
  expect(original.operation.principalId).toBe("ledger-test");
  const same = await successor(scope, "ledger-test");
  expect(await command(same, "read", { operationId: op.operationId })).toMatchObject({
    status: "found",
  });
  await expect(command(scope, "read", { operationId: op.operationId })).rejects.toThrow();
  await expect(
    command(same, "settle_original", { operationId: op.operationId, outcome: "outcome_unknown" }),
  ).rejects.toThrow();
  const other = await successor(same, "different-service");
  expect(await command(other, "read", { operationId: op.operationId })).toEqual({
    status: "not_found",
  });
  expect(await command(other, "claim_read", { operationId: op.operationId })).toEqual({
    status: "not_found",
  });
  await expect(
    command({ ...other, subjectId: "ledger-test" } as Scope, "read", {
      operationId: op.operationId,
    }),
  ).rejects.toThrow();
});

test("capture metadata and original outcome are immutable even at the table boundary", async () => {
  const scope = await fixture();
  const op = operation();
  await command(scope, "capture", op);
  await expect(
    shared.admin`update mcp_operations set original_tool='other' where operation_id=${op.operationId}`.then(
      () => undefined,
    ),
  ).rejects.toThrow();
  await command(scope, "settle_original", {
    operationId: op.operationId,
    outcome: "outcome_unknown",
  });
  await expect(
    shared.admin`update mcp_operations set original_outcome='captured' where operation_id=${op.operationId}`.then(
      () => undefined,
    ),
  ).rejects.toThrow();
});

test("the TypeScript port retains the full MCP result including PostgreSQL-hostile strings", async () => {
  const scope = await fixture();
  const op = operation();
  expect(await captureMcpOperation(client.db, scope, op)).toBe("created");
  const result = {
    content: [{ type: "text" as const, text: "before\u0000after\ud800" }],
    structuredContent: { exact: "value\u0000", nested: [1, true, null] },
    isError: true,
  };
  await settleOriginalMcpOperation(client.db, scope, {
    operationId: op.operationId,
    outcome: "completed",
    result,
  });
  expect(await readMcpOperation(client.db, scope, { operationId: op.operationId })).toMatchObject({
    status: "found",
    operation: { originalOutcome: "completed", originalResult: result },
  });
});

test("canonical full receipts dedupe across new handles and JSON key order; conflicting content preserves first", async () => {
  const scope = await fixture();
  const op = operation();
  await captureMcpOperation(client.db, scope, op);
  const claim = await claimMcpOperationObservation(client.db, scope, op.operationId);
  if (claim.status !== "claimed") throw new Error("read not claimed");
  const result = {
    content: [{ type: "text" as const, text: "receipt\u0000" }],
    structuredContent: { one: 1, two: 2 },
    isError: true,
    _meta: { evidence: "exact" },
  };
  const input = {
    operationId: op.operationId,
    claimId: claim.claimId,
    receiptRevision: "receipt-v1",
    result,
  };
  const first = await settleMcpOperationObservation(client.db, scope, input);
  expect(first.status).toBe("settled");
  if (!("receiptDigest" in first)) throw new Error("terminal receipt digest missing");
  const restarted = createDb(shared.appUrl);
  try {
    const replay = await settleMcpOperationObservation(restarted.db, scope, {
      ...input,
      result: {
        _meta: result._meta,
        isError: true,
        structuredContent: { two: 2, one: 1 },
        content: result.content,
      },
    });
    expect(replay).toEqual({ ...first, status: "existing" });
    expect(
      await settleMcpOperationObservation(restarted.db, scope, {
        ...input,
        result: { ...result, isError: false },
      }),
    ).toEqual({ ...first, status: "conflict" });
    expect(
      await readMcpOperation(restarted.db, scope, { operationId: op.operationId }),
    ).toMatchObject({ status: "found", operation: { observationResult: result } });
  } finally {
    await restarted.close();
  }
});

test("wrong account/generation and quiesced attempts cannot acquire or settle observations", async () => {
  const scope = await fixture();
  const op = operation();
  await command(scope, "capture", op);
  const claim = await command(scope, "claim_read", { operationId: op.operationId });
  await expect(
    command({ ...scope, accountId: crypto.randomUUID() }, "read", { operationId: op.operationId }),
  ).rejects.toThrow();
  await expect(
    command({ ...scope, executionGeneration: scope.executionGeneration + 1 }, "read", {
      operationId: op.operationId,
    }),
  ).rejects.toThrow();
  await shared.admin`update session_turn_attempts set quiesced_at=clock_timestamp() where id=${scope.attemptId}`;
  await expect(command(scope, "read", { operationId: op.operationId })).rejects.toThrow();
  await expect(command(scope, "claim_read", { operationId: op.operationId })).rejects.toThrow();
  await expect(
    command(scope, "settle_observation", {
      operationId: op.operationId,
      claimId: claim.claimId,
      ...receipt,
    }),
  ).rejects.toThrow();
});

test("release is exact-claim fenced, permits another read, and cannot clear a terminal receipt", async () => {
  const scope = await fixture();
  const op = operation();
  await command(scope, "capture", op);
  const first = await command(scope, "claim_read", { operationId: op.operationId });
  expect(
    await command(scope, "release_read", {
      operationId: op.operationId,
      claimId: crypto.randomUUID(),
    }),
  ).toEqual({ status: "stale_claim" });
  expect(
    await command(scope, "release_read", { operationId: op.operationId, claimId: first.claimId }),
  ).toEqual({ status: "released" });
  const next = await command(scope, "claim_read", { operationId: op.operationId });
  expect(next.status).toBe("claimed");
  expect(next.claimId).not.toBe(first.claimId);
  expect(
    await command(scope, "release_read", { operationId: op.operationId, claimId: first.claimId }),
  ).toEqual({ status: "stale_claim" });
  await command(scope, "settle_observation", {
    operationId: op.operationId,
    claimId: next.claimId,
    ...receipt,
  });
  expect(
    await command(scope, "release_read", { operationId: op.operationId, claimId: next.claimId }),
  ).toEqual({ status: "terminal" });
  expect(await command(scope, "read", { operationId: op.operationId })).toMatchObject({
    status: "found",
    operation: { observationResult: receipt.result },
  });
});

test("completed original cannot be observed, including a claim acquired before original completion", async () => {
  const scope = await fixture();
  const op = operation();
  await command(scope, "capture", op);
  const claim = await command(scope, "claim_read", { operationId: op.operationId });
  await command(scope, "settle_original", {
    operationId: op.operationId,
    outcome: "completed",
    result: receipt.result,
  });
  expect(await command(scope, "claim_read", { operationId: op.operationId })).toEqual({
    status: "terminal",
  });
  expect(
    await command(scope, "settle_observation", {
      operationId: op.operationId,
      claimId: claim.claimId,
      receiptRevision: "disagree",
      result: { content: [], isError: false },
    }),
  ).toEqual({ status: "original_completed" });
  expect(await command(scope, "read", { operationId: op.operationId })).toMatchObject({
    status: "found",
    operation: { originalResult: receipt.result, observationResult: null },
  });
});

test("cached results honor effective workspace pause and a newer selected-run override", async () => {
  const scope = await fixture();
  const op = operation();
  await command(scope, "capture", op);
  await command(scope, "settle_original", {
    operationId: op.operationId,
    outcome: "completed",
    result: receipt.result,
  });
  await shared.admin`update workspace_inference_controls set workspace_state='paused', revision=revision+1,
    workspace_pause_revision=revision+1 where workspace_id=${scope.workspaceId}`;
  await expect(command(scope, "read", { operationId: op.operationId })).rejects.toThrow();
  // The canonical control algebra permits a strictly newer selected branch override.
  await shared.admin`update sessions set subtree_run_override_revision=(select revision+1 from workspace_inference_controls
    where workspace_id=${scope.workspaceId}), control_version=(select revision+1 from workspace_inference_controls
    where workspace_id=${scope.workspaceId}) where id=${scope.sessionId}`;
  expect(await command(scope, "read", { operationId: op.operationId })).toMatchObject({
    status: "found",
  });
});

test("custom runtime role receives EXECUTE only and no ledger table privileges", async () => {
  await provisionRoles(shared.adminUrl, {
    appRole: "mcp_ledger_custom_app",
    appPassword: "ledger-custom-test-only",
    rlsStrategy: "force",
  });
  const [acl] =
    await shared.admin`select has_function_privilege('mcp_ledger_custom_app','mcp_operation_command(jsonb,text,jsonb)','EXECUTE') as execute,
    has_table_privilege('mcp_ledger_custom_app','mcp_operations','SELECT,INSERT,UPDATE,DELETE') as direct`;
  expect(acl).toEqual({ execute: true, direct: false });
  const [privateAcl] = await shared.admin`select
    has_function_privilege('mcp_ledger_custom_app','opengeni_private.mcp_operation_command_scoped(jsonb,text,jsonb)','EXECUTE') as bypass,
    has_function_privilege('mcp_ledger_custom_app','opengeni_private.guard_mcp_operation_immutable()','EXECUTE') as guard`;
  expect(privateAcl).toEqual({ bypass: false, guard: false });
  const scope = await fixture();
  const op = operation();
  const customUrl = new URL(shared.appUrl);
  customUrl.username = "mcp_ledger_custom_app";
  customUrl.password = "ledger-custom-test-only";
  const custom = createDb(customUrl.toString());
  try {
    expect(await command(scope, "capture", op, custom.db)).toBe("created");
    await assertRuntimeDatabasePosture(custom.db, {
      rlsStrategy: "force",
      expectedRole: "mcp_ledger_custom_app",
    });
  } finally {
    await custom.close();
  }
});

test("cached results deny suspended membership, changed membership revision, and removed workspace access", async () => {
  const scope = await fixture({ human: true });
  const op = operation();
  await command(scope, "capture", op);
  await command(scope, "settle_original", {
    operationId: op.operationId,
    outcome: "completed",
    result: receipt.result,
  });
  const [principal] =
    await shared.admin`select initiating_human_subject_id as subject from session_turns where id=${scope.turnId}`;
  expect(await command(scope, "read", { operationId: op.operationId })).toMatchObject({
    status: "found",
  });
  await shared.admin`update organization_memberships set status='suspended' where account_id=${scope.accountId} and subject_id=${principal!.subject}`;
  await expect(command(scope, "read", { operationId: op.operationId })).rejects.toThrow();
  await shared.admin`update organization_memberships set status='active',authorization_revision=authorization_revision+1
    where account_id=${scope.accountId} and subject_id=${principal!.subject}`;
  await expect(command(scope, "read", { operationId: op.operationId })).rejects.toThrow();
  const second = operation();
  await command(scope, "capture", second);
  await shared.admin`delete from workspace_memberships where workspace_id=${scope.workspaceId} and subject_id=${principal!.subject}`;
  await expect(command(scope, "read", { operationId: second.operationId })).rejects.toThrow();
});

test("cached linked receipts are denied immediately after canonical link revocation", async () => {
  const scope = await fixture({ linked: true });
  const op = operation();
  await command(scope, "capture", op);
  const claim = await command(scope, "claim_read", { operationId: op.operationId });
  await command(scope, "settle_observation", {
    operationId: op.operationId,
    claimId: claim.claimId,
    ...receipt,
  });
  const [source] =
    await shared.admin`select canonical_snapshot from external_link_turn_authorities where turn_id=${scope.turnId}`;
  const actor = source!.canonical_snapshot.actor;
  await revokeExternalIdentityLink(client.db, {
    accountId: scope.accountId,
    linkId: actor.linkId,
    subjectId: actor.effectiveSubjectId,
    expectedRevision: actor.linkRevision,
  });
  await expect(command(scope, "read", { operationId: op.operationId })).rejects.toThrow();
  await expect(
    command(scope, "settle_observation", {
      operationId: op.operationId,
      claimId: claim.claimId,
      ...receipt,
    }),
  ).rejects.toThrow();
});

test("cached evidence honors ancestor pauses and strictly newer descendant overrides", async () => {
  const scope = await fixture({ ancestor: true });
  const op = operation();
  await command(scope, "capture", op);
  const [source] =
    await shared.admin`select parent_session_id from sessions where id=${scope.sessionId}`;
  await shared.admin`update sessions set direct_control_state='paused',direct_pause_revision=10,control_version=10 where id=${source!.parent_session_id}`;
  await expect(command(scope, "read", { operationId: op.operationId })).rejects.toThrow();
  await shared.admin`update sessions set subtree_run_override_revision=11,control_version=11 where id=${scope.sessionId}`;
  expect(await command(scope, "read", { operationId: op.operationId })).toMatchObject({
    status: "found",
  });
});

async function scheduledFixture() {
  const origin = await fixture({ human: true });
  const [human] =
    await shared.admin`select initiating_human_subject_id as subject from session_turns where id=${origin.turnId}`;
  const task = await createScheduledTask(client.db, {
    accountId: origin.accountId,
    workspaceId: origin.workspaceId,
    createdBy: { kind: "subject", subjectId: human!.subject },
    name: "Ledger authority schedule",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: crypto.randomUUID(),
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "read", resources: [], tools: [], metadata: {} },
    metadata: {},
  });
  const settings = testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" });
  const activities = createScheduledTaskActivities(
    async () =>
      ({ settings, db: client.db, bus: new MemoryEventBus() }) as unknown as ActivityServices,
  );
  const dispatched = await activities.dispatchScheduledTaskRun({
    workspaceId: origin.workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey: crypto.randomUUID(),
  });
  if (dispatched.action !== "start" && dispatched.action !== "signal")
    throw new Error(`scheduled fixture ${dispatched.action}`);
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, origin.workspaceId, {
    sessionId: dispatched.sessionId,
    workflowId: dispatched.workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("scheduled attempt unavailable");
  const scope = {
    accountId: origin.accountId,
    workspaceId: origin.workspaceId,
    sessionId: dispatched.sessionId,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
  return { scope, human };
}

test("legacy user with explicit workspace membership retains authority without an organization membership", async () => {
  const scope = await fixture({ legacy: true });
  const op = operation();
  expect(await command(scope, "capture", op)).toBe("created");
  const [row] =
    await shared.admin`select principal_membership_id,principal_membership_revision,principal_id from mcp_operations where operation_id=${op.operationId}`;
  expect(row!.principal_membership_id).toBeNull();
  expect(row!.principal_membership_revision).toBeNull();
  expect(await command(scope, "read", { operationId: op.operationId })).toMatchObject({
    status: "found",
  });
  await shared.admin`delete from workspace_memberships where workspace_id=${scope.workspaceId} and subject_id=${row!.principal_id}`;
  await expect(command(scope, "read", { operationId: op.operationId })).rejects.toThrow();
});

test("scheduled read follows the resume session-before-run lock order across real connections", async () => {
  const { scope } = await scheduledFixture();
  const op = operation();
  await command(scope, "capture", op);
  let read: Promise<any> | undefined;
  try {
    await shared.admin.begin(async (tx) => {
      const [holder] = await tx`select pg_backend_pid() as pid`;
      await tx`select id from sessions where id=${scope.sessionId} for update`;
      read = command(scope, "read", { operationId: op.operationId });
      // Attach rejection handling immediately; transaction cleanup releases the
      // blocked reader even when the deliberate pre-fix regression fails.
      void read.catch(() => undefined);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const [state] =
          await shared.admin`select exists(select 1 from pg_stat_activity where ${holder!.pid} = any(pg_blocking_pids(pid))) as blocked`;
        if (state!.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(20);
      }
      expect(blocked).toBe(true);
      await tx`set local lock_timeout='500ms'`;
      // Canonical resume/claim owns the session before validating the run.
      // A read must not own that run while waiting for this session.
      await tx`select id from scheduled_task_runs where id=(select scheduled_task_run_id from session_turns where id=${scope.turnId}) for update`;
    });
  } finally {
    if (read) expect(await read).toMatchObject({ status: "found" });
  }
});

test("scheduled cached evidence revalidates the frozen run authority before disclosure", async () => {
  const { scope, human } = await scheduledFixture();
  const op = operation();
  await command(scope, "capture", op);
  await command(scope, "settle_original", {
    operationId: op.operationId,
    outcome: "completed",
    result: receipt.result,
  });
  expect(await command(scope, "read", { operationId: op.operationId })).toMatchObject({
    status: "found",
  });
  // The member stays active and retains workspace access; only the frozen
  // scheduled occurrence's admitted authorization revision is now stale.
  await shared.admin`update organization_memberships set authorization_revision=authorization_revision+1
    where account_id=${scope.accountId} and subject_id=${human!.subject}`;
  let failure: unknown;
  try {
    await command(scope, "read", { operationId: op.operationId });
  } catch (error) {
    failure = error;
  }
  expect((failure as { cause?: Error })?.cause?.message).toContain("scheduled authority revoked");
  await expect(command(scope, "capture", operation())).rejects.toThrow();
});

test("continuation claim membership prefix cannot invert against a concurrent ledger read", async () => {
  const scope = await fixture({ human: true });
  const op = operation();
  await command(scope, "capture", op);
  let read: Promise<any> | undefined;
  try {
    await retrySessionActivityRls(
      client.db,
      scope.workspaceId,
      {
        stage: "test.continuation_membership_prefix",
        maxAttempts: 1,
        organizationMembershipFence: true,
      },
      async (tx) => {
        const rows = await tx.execute(sql`select pg_backend_pid() as pid`);
        const holder = (Array.isArray(rows) ? rows : rows.rows)[0];
        await tx.execute(sql`select id from sessions where id=${scope.sessionId} for update`);
        read = command(scope, "read", { operationId: op.operationId });
        void read.catch(() => undefined);
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const [state] =
            await shared.admin`select exists(select 1 from pg_stat_activity where ${holder.pid} = any(pg_blocking_pids(pid))) as blocked`;
          if (state!.blocked) {
            blocked = true;
            break;
          }
          await Bun.sleep(20);
        }
        expect(blocked).toBe(true);
        await tx.execute(sql`set local lock_timeout='500ms'`);
        // Same lifecycle acquisition as causal host-MCP authority inheritance.
        // Reentrant only when claim established the canonical prefix up front.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${scope.accountId}`},0))`,
        );
      },
    );
  } finally {
    if (read) expect(await read).toMatchObject({ status: "found" });
  }
});

test("actual attempt claim waits at membership before acquiring tenancy or session locks", async () => {
  const scope = await fixture({ human: true });
  let claim: ReturnType<typeof claimSessionWorkForAttempt> | undefined;
  try {
    await shared.admin.begin(async (tx) => {
      const [holder] = await tx`select pg_backend_pid() as pid`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${scope.accountId}`},0))`;
      claim = claimSessionWorkForAttempt(client.db, scope.workspaceId, {
        sessionId: scope.sessionId,
        workflowId: `session-${scope.sessionId}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      void claim.catch(() => undefined);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const [state] =
          await shared.admin`select exists(select 1 from pg_stat_activity where ${holder!.pid} = any(pg_blocking_pids(pid))) as blocked`;
        if (state!.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(20);
      }
      expect(blocked).toBe(true);
      await tx`set local lock_timeout='500ms'`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`session-tenancy:${scope.workspaceId}`},0))`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`workspace-control:${scope.workspaceId}`},0))`;
      await tx`select id from sessions where id=${scope.sessionId} for update`;
    });
  } finally {
    if (claim) await claim;
  }
});
