import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  activateTranscriptionGrant,
  createDb,
  reportTranscriptionGrantUsage,
  reserveTranscriptionGrant,
  settleTranscriptionGrant,
  withRlsContext,
  type DbClient,
} from "../src/index";
import { transcriptionGrants } from "../src/schema";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { asc } from "drizzle-orm";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const PROJECT_ID = "test-openai-project";
const ENDPOINT = "https://api.openai.com/v1/realtime";

type WorkspaceFixture = {
  accountId: string;
  workspaceId: string;
  sessionIds: string[];
};

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

function enabledPolicy(
  limits: Partial<{
    maxActiveGrantsPerWorkspace: number;
    maxActiveGrantsPerSubject: number;
    maxIssuancesPerMinutePerSubject: number;
    maxSessionDurationSeconds: number;
    maxMonthlyDurationSeconds: number;
    maxMonthlyCostMicros: number;
    reservationCostMicros: number;
  }> = {},
) {
  return {
    enabled: true,
    provider: "openai",
    providerProjectId: PROJECT_ID,
    endpoint: ENDPOINT,
    privacy: {
      retainAudio: false,
      retainTranscript: false,
      trainingAllowed: false,
      zeroDataRetentionEligible: true,
      processingRegion: "us",
      dataResidency: "United States",
      eligibilityVerifiedBy: "security:test",
      eligibilityVerifiedAt: "2026-07-19T00:00:00.000Z",
    },
    approvals: {
      security: {
        approved: true,
        approvedBy: "security:test",
        approvedAt: "2026-07-19T00:00:00.000Z",
      },
      finance: {
        approved: true,
        approvedBy: "finance:test",
        approvedAt: "2026-07-19T00:00:00.000Z",
      },
    },
    limits: {
      maxActiveGrantsPerWorkspace: 4,
      maxActiveGrantsPerSubject: 2,
      maxIssuancesPerMinutePerSubject: 20,
      maxSessionDurationSeconds: 60,
      maxMonthlyDurationSeconds: 6_000,
      maxMonthlyCostMicros: 1_000_000,
      reservationCostMicros: 10_000,
      ...limits,
    },
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("transcription_grants");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[transcription-grants] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function freshWorkspace(
  sessionCount = 1,
  accountId?: string,
  policy = enabledPolicy(),
): Promise<WorkspaceFixture> {
  const resolvedAccountId =
    accountId ??
    (
      await shared!.admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('transcription helper account') returning id`
    )[0]!.id;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name, settings)
    values (
      ${resolvedAccountId}, 'transcription helper workspace',
      ${JSON.stringify({ transcription: policy })}::jsonb
    ) returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${resolvedAccountId})`;
  const sessionIds: string[] = [];
  for (let index = 0; index < sessionCount; index += 1) {
    const sessionId = crypto.randomUUID();
    await shared!.admin`
      insert into sessions (
        id, account_id, workspace_id, status, initial_message, model,
        sandbox_backend, sandbox_group_id
      ) values (
        ${sessionId}, ${resolvedAccountId}, ${workspace!.id}, 'idle',
        ${`transcription helper ${index}`}, 'scripted-model', 'none', ${sessionId}
      )`;
    sessionIds.push(sessionId);
  }
  return {
    accountId: resolvedAccountId,
    workspaceId: workspace!.id,
    sessionIds,
  };
}

function admission(
  workspace: WorkspaceFixture,
  input: {
    sessionId?: string;
    subjectId?: string;
    requestId?: string;
    platformLimits?: {
      maxActiveGrantsPerWorkspace?: number;
      maxIssuancesPerMinutePerSubject?: number;
      maxMonthlyDurationSecondsPerWorkspace?: number;
      maxMonthlyTranscriptionCostMicrosPerAccount?: number;
      maxMonthlyCostMicrosPerAccount?: number;
    };
  } = {},
) {
  return reserveTranscriptionGrant(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    sessionId: input.sessionId ?? workspace.sessionIds[0]!,
    subjectId: input.subjectId ?? "user:transcription",
    requestId: input.requestId ?? `${crypto.randomUUID()}:0`,
    provider: "openai",
    providerProjectId: PROJECT_ID,
    endpoint: ENDPOINT,
    ...(input.platformLimits ? { platformLimits: input.platformLimits } : {}),
  });
}

describe("transcription grant admission and reconciliation (real PostgreSQL)", () => {
  test("writes one conservative reservation and idempotently reconciles usage and settlement", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const requestId = `${crypto.randomUUID()}:0`;
    const reserved = await admission(workspace, { requestId });
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) throw new Error("expected reservation");

    const duplicate = await admission(workspace, { requestId });
    expect(duplicate).toMatchObject({
      allowed: false,
      code: "transcription_request_already_used",
    });

    const active = await activateTranscriptionGrant(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      sessionId: workspace.sessionIds[0]!,
      subjectId: "user:transcription",
      grantId: reserved.grant.id,
      providerSessionId: "provider-session-1",
      clientSecretExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(active.status).toBe("active");

    const usageInput = {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      sessionId: workspace.sessionIds[0]!,
      subjectId: "user:transcription",
      grantId: reserved.grant.id,
      providerSessionId: "provider-session-1",
      providerEventId: "provider-event-1",
      durationSeconds: 1.1,
      costMicros: 50.1,
    };
    expect(await reportTranscriptionGrantUsage(client.db, usageInput)).toEqual({
      recorded: true,
    });
    expect(await reportTranscriptionGrantUsage(client.db, usageInput)).toEqual({
      recorded: false,
    });

    const settled = await settleTranscriptionGrant(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      sessionId: workspace.sessionIds[0]!,
      subjectId: "user:transcription",
      grantId: reserved.grant.id,
      providerSessionId: "provider-session-1",
      status: "completed",
    });
    const retried = await settleTranscriptionGrant(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      sessionId: workspace.sessionIds[0]!,
      subjectId: "user:transcription",
      grantId: reserved.grant.id,
      providerSessionId: "provider-session-1",
      status: "completed",
    });
    expect(settled.status).toBe("completed");
    expect(retried.status).toBe("completed");
    expect(retried.reportedDurationSeconds).toBe(2);
    expect(retried.reportedCostMicros).toBe(51);

    const events = await shared!.admin<Array<{ event_type: string; count: number }>>`
      select event_type, count(*)::int as count from usage_events
      where source_resource_type = 'transcription_grant'
        and source_resource_id = ${reserved.grant.id}
      group by event_type order by event_type`;
    expect(events.map(({ event_type, count }) => ({ event_type, count }))).toEqual([
      { event_type: "transcription.grant_reserved", count: 1 },
      { event_type: "transcription.reported_cost", count: 1 },
      { event_type: "transcription.reported_seconds", count: 1 },
      { event_type: "transcription.reserved_cost", count: 1 },
      { event_type: "transcription.reserved_seconds", count: 1 },
      { event_type: "transcription.secret_issued", count: 1 },
    ]);
  });

  test("serializes concurrent workspace admission and preserves one active grant per session", async () => {
    if (!available) return;
    const workspace = await freshWorkspace(
      3,
      undefined,
      enabledPolicy({ maxActiveGrantsPerWorkspace: 1 }),
    );

    const decisions = await Promise.all([
      admission(workspace, {
        sessionId: workspace.sessionIds[0]!,
        subjectId: "user:a",
      }),
      admission(workspace, {
        sessionId: workspace.sessionIds[1]!,
        subjectId: "user:b",
      }),
    ]);
    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(1);
    expect(decisions.find(({ allowed }) => !allowed)).toMatchObject({
      allowed: false,
      code: "transcription_workspace_concurrency",
    });

    const winner = decisions.find(
      (decision): decision is Extract<typeof decision, { allowed: true }> => decision.allowed,
    )!;
    const sameSession = await admission(workspace, {
      sessionId: winner.grant.sessionId,
      subjectId: "user:other",
    });
    expect(sameSession).toMatchObject({
      allowed: false,
      code: "transcription_session_active",
    });
  });

  test("expires abandoned grants before admission and releases the session slot", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const abandoned = await admission(workspace);
    if (!abandoned.allowed) throw new Error("expected reservation");
    await shared!.admin`
      update transcription_grants set active_expires_at = now() - interval '1 minute'
      where id = ${abandoned.grant.id}`;

    const replacement = await admission(workspace, {
      requestId: `${crypto.randomUUID()}:replacement`,
    });
    expect(replacement.allowed).toBe(true);
    const [expired] = await shared!.admin<Array<{ status: string }>>`
      select status from transcription_grants where id = ${abandoned.grant.id}`;
    expect(expired?.status).toBe("expired");
    const [audit] = await shared!.admin<Array<{ action: string }>>`
      select action from audit_events
      where target_id = ${abandoned.grant.id}
        and action = 'transcription.grant.expired'`;
    expect(audit?.action).toBe("transcription.grant.expired");
  });

  test("enforces account-wide platform cost caps across sibling workspaces atomically", async () => {
    if (!available) return;
    const first = await freshWorkspace();
    const second = await freshWorkspace(1, first.accountId);
    const platformLimits = {
      maxMonthlyTranscriptionCostMicrosPerAccount: 10_000,
    };

    const decisions = await Promise.all([
      admission(first, { subjectId: "user:first", platformLimits }),
      admission(second, { subjectId: "user:second", platformLimits }),
    ]);

    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(1);
    expect(decisions.find(({ allowed }) => !allowed)).toMatchObject({
      allowed: false,
      code: "transcription_platform_monthly_cost",
    });
    const [usage] = await shared!.admin<Array<{ total: string }>>`
      select coalesce(sum(quantity), 0) as total from usage_events
      where account_id = ${first.accountId}
        and event_type = 'transcription.reserved_cost'`;
    expect(usage?.total).toBe("10000");
  });

  test("binds usage and settlement to workspace, subject, session, and provider identity", async () => {
    if (!available) return;
    const workspace = await freshWorkspace(2);
    const other = await freshWorkspace();
    const reserved = await admission(workspace);
    if (!reserved.allowed) throw new Error("expected reservation");
    const otherReserved = await admission(other, {
      subjectId: "user:other-workspace",
    });
    if (!otherReserved.allowed) throw new Error("expected other workspace reservation");
    await activateTranscriptionGrant(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      sessionId: workspace.sessionIds[0]!,
      subjectId: "user:transcription",
      grantId: reserved.grant.id,
      providerSessionId: "provider-session-bound",
      clientSecretExpiresAt: new Date(Date.now() + 60_000),
    });

    const base = {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      sessionId: workspace.sessionIds[0]!,
      subjectId: "user:transcription",
      grantId: reserved.grant.id,
      providerSessionId: "provider-session-bound",
    };
    await expect(
      reportTranscriptionGrantUsage(client.db, {
        ...base,
        subjectId: "user:other",
        providerEventId: "wrong-subject",
        durationSeconds: 1,
      }),
    ).rejects.toThrow("not found");
    await expect(
      reportTranscriptionGrantUsage(client.db, {
        ...base,
        sessionId: workspace.sessionIds[1]!,
        providerEventId: "wrong-session",
        durationSeconds: 1,
      }),
    ).rejects.toThrow("not found");
    await expect(
      settleTranscriptionGrant(client.db, {
        ...base,
        providerSessionId: "provider-session-other",
        status: "error",
      }),
    ).rejects.toThrow("not found");

    const visible = await withRlsContext(
      client.db,
      { accountId: workspace.accountId, workspaceId: workspace.workspaceId },
      async (scopedDb) =>
        await scopedDb.select().from(transcriptionGrants).orderBy(asc(transcriptionGrants.id)),
    );
    expect(visible.map(({ id }) => id)).toEqual([reserved.grant.id]);
    const otherVisible = await withRlsContext(
      client.db,
      { accountId: other.accountId, workspaceId: other.workspaceId },
      async (scopedDb) =>
        await scopedDb.select().from(transcriptionGrants).orderBy(asc(transcriptionGrants.id)),
    );
    expect(otherVisible.map(({ id }) => id)).toEqual([otherReserved.grant.id]);
  });
});
