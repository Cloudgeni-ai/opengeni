import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { createDb, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";

import { createApp } from "../src/app";

const DELEGATION_SECRET = "transcription-route-delegation-secret";
const PLATFORM_KEY = "platform-key-must-never-leave-the-api";
const PROJECT_ID = "test-openai-project";
const PROTOTYPE_PRIVACY = {
  retainAudio: false,
  retainTranscript: false,
  trainingAllowed: false,
} as const;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

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
    enabled: true as const,
    provider: "openai" as const,
    providerProjectId: PROJECT_ID,
    endpoint: "https://api.openai.com/v1/realtime" as const,
    privacy: {
      retainAudio: false as const,
      retainTranscript: false as const,
      trainingAllowed: false as const,
      zeroDataRetentionEligible: true as const,
      processingRegion: "us",
      dataResidency: "United States",
      eligibilityVerifiedBy: "security:test",
      eligibilityVerifiedAt: "2026-07-19T00:00:00.000Z",
    },
    approvals: {
      security: {
        approved: true as const,
        approvedBy: "security:test",
        approvedAt: "2026-07-19T00:00:00.000Z",
      },
      finance: {
        approved: true as const,
        approvedBy: "finance:test",
        approvedAt: "2026-07-19T00:00:00.000Z",
      },
    },
    limits: {
      maxActiveGrantsPerWorkspace: 2,
      maxActiveGrantsPerSubject: 1,
      maxIssuancesPerMinutePerSubject: 3,
      maxSessionDurationSeconds: 60,
      maxMonthlyDurationSeconds: 600,
      maxMonthlyCostMicros: 100_000,
      reservationCostMicros: 10_000,
      ...limits,
    },
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_transcription");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[transcription-routes] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function app(overrides: Partial<Settings> = {}) {
  return createApp({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      openaiProvider: "openai",
      openaiApiKey: PLATFORM_KEY,
      openaiProjectId: PROJECT_ID,
      ...overrides,
    }),
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
}

async function freshWorkspace(
  settings: Record<string, unknown> = { transcription: enabledPolicy() },
  sessionCount = 1,
  accountId?: string,
): Promise<WorkspaceFixture> {
  const resolvedAccountId =
    accountId ??
    (
      await shared!.admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('transcription account') returning id`
    )[0]!.id;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name, settings)
    values (${resolvedAccountId}, 'transcription workspace', ${JSON.stringify(settings)}::jsonb)
    returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${resolvedAccountId})`;
  const sessionIds: string[] = [];
  for (let index = 0; index < sessionCount; index += 1) {
    const id = crypto.randomUUID();
    await shared!.admin`
      insert into sessions (
        id, account_id, workspace_id, status, initial_message, model,
        sandbox_backend, sandbox_group_id
      ) values (
        ${id}, ${resolvedAccountId}, ${workspace!.id}, 'idle',
        ${`transcription session ${index}`}, 'scripted-model', 'none', ${id}
      )`;
    sessionIds.push(id);
  }
  return { accountId: resolvedAccountId, workspaceId: workspace!.id, sessionIds };
}

async function bearer(
  workspace: Pick<WorkspaceFixture, "accountId" | "workspaceId">,
  subjectId: string,
  permissions: Permission[] = ["sessions:control"],
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    permissions,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return `Bearer ${token}`;
}

async function mint(
  workspace: WorkspaceFixture,
  input: {
    sessionId?: string;
    requestId?: string;
    subjectId?: string;
    permissions?: Permission[] | null;
    body?: unknown;
    settings?: Partial<Settings>;
  } = {},
): Promise<Response> {
  const sessionId = input.sessionId ?? workspace.sessionIds[0]!;
  const requestId = input.requestId ?? `${crypto.randomUUID()}:0`;
  const subjectId = input.subjectId ?? "user:transcription";
  return await app(input.settings).request(
    `/v1/workspaces/${workspace.workspaceId}/transcription/client-secret`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.permissions === null
          ? {}
          : {
              authorization: await bearer(
                workspace,
                subjectId,
                input.permissions ?? ["sessions:control"],
              ),
            }),
      },
      body: JSON.stringify(
        input.body ?? {
          sessionId,
          requestId,
          language: "en",
          diarization: false,
          privacy: PROTOTYPE_PRIVACY,
        },
      ),
    },
  );
}

function installSuccessfulProvider() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (providerInput, init) => {
    calls.push({ url: String(providerInput), init });
    const attempt = calls.length;
    return Response.json({
      expires_at: Math.floor(Date.now() / 1_000) + 60,
      value: `ek_ephemeral_${attempt}`,
      session: { id: `provider-session-${attempt}`, type: "transcription" },
    });
  }) as typeof fetch;
  return calls;
}

async function grantRows(workspaceId: string) {
  return await shared!.admin<
    Array<{
      id: string;
      session_id: string;
      subject_id: string;
      request_id: string;
      provider_session_id: string | null;
      status: string;
      reserved_duration_seconds: string;
      reserved_cost_micros: string;
      reported_duration_seconds: string;
    }>
  >`
    select id, session_id, subject_id, request_id, provider_session_id, status,
           reserved_duration_seconds, reserved_cost_micros, reported_duration_seconds
    from transcription_grants where workspace_id = ${workspaceId}
    order by created_at, id`;
}

describe("transcription client-secret route (real PostgreSQL)", () => {
  test("authorizes before parsing, database admission, or provider access", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    }) as typeof fetch;

    const missing = await mint(workspace, {
      permissions: null,
      body: "not a transcription payload",
    });
    const wrongScope = await mint(workspace, { permissions: ["workspace:read"] });

    expect(missing.status).toBe(401);
    expect(wrongScope.status).toBe(403);
    expect(providerCalls).toBe(0);
    expect(await grantRows(workspace.workspaceId)).toHaveLength(0);
  });

  test("fails closed for absent, disabled, or malformed workspace policy", async () => {
    if (!available) return;
    const absent = await freshWorkspace({}, 1);
    const disabled = await freshWorkspace({ transcription: { enabled: false } }, 1);
    const malformed = await freshWorkspace(
      { transcription: { enabled: true, provider: "openai" } },
      1,
    );
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    }) as typeof fetch;

    const responses = await Promise.all([mint(absent), mint(disabled), mint(malformed)]);

    expect(responses.map((response) => response.status)).toEqual([409, 409, 409]);
    expect(providerCalls).toBe(0);
    for (const workspace of [absent, disabled, malformed]) {
      const [denial] = await shared!.admin<Array<{ code: string }>>`
        select metadata->>'code' as code from audit_events
        where workspace_id = ${workspace.workspaceId}
          and action = 'transcription.grant.denied'`;
      expect(denial?.code).toBe("policy_disabled");
    }
  });

  test("rejects provider, project, endpoint, key, request privacy, and diarization mismatches", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    }) as typeof fetch;

    const responses = await Promise.all([
      mint(workspace, { settings: { openaiProvider: "azure" } }),
      mint(workspace, { settings: { openaiProjectId: "unapproved-project" } }),
      mint(workspace, { settings: { openaiBaseUrl: "https://proxy.example.test/v1" } }),
      mint(workspace, { settings: { openaiApiKey: undefined } }),
      mint(workspace, {
        body: {
          sessionId: workspace.sessionIds[0],
          requestId: `${crypto.randomUUID()}:0`,
          diarization: true,
          privacy: PROTOTYPE_PRIVACY,
        },
      }),
      mint(workspace, {
        body: {
          sessionId: workspace.sessionIds[0],
          requestId: `${crypto.randomUUID()}:0`,
          diarization: false,
          privacy: { ...PROTOTYPE_PRIVACY, retainAudio: true },
        },
      }),
      mint(workspace, {
        body: {
          sessionId: workspace.sessionIds[0],
          requestId: `${crypto.randomUUID()}:0`,
          diarization: false,
          privacy: { ...PROTOTYPE_PRIVACY, region: "eu-west" },
        },
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      409, 409, 409, 503, 422, 422, 422,
    ]);
    expect(providerCalls).toBe(0);
    expect(await grantRows(workspace.workspaceId)).toHaveLength(0);
  });

  test("requires an existing session in the authorized workspace", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const other = await freshWorkspace();
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    }) as typeof fetch;

    const invalid = await mint(workspace, { sessionId: "not-a-uuid" });
    const nonexistent = await mint(workspace, { sessionId: crypto.randomUUID() });
    const crossWorkspace = await mint(workspace, { sessionId: other.sessionIds[0] });

    expect(invalid.status).toBe(400);
    expect(nonexistent.status).toBe(404);
    expect(crossWorkspace.status).toBe(404);
    expect(providerCalls).toBe(0);
    expect(await grantRows(workspace.workspaceId)).toHaveLength(0);
  });

  test("reserves, mints, activates, meters idempotently, and settles with exact binding", async () => {
    if (!available) return;
    const workspace = await freshWorkspace({}, 1);
    await shared!.admin`
      update workspaces set settings = ${JSON.stringify({ transcription: enabledPolicy() })}::jsonb
      where id = ${workspace.workspaceId}`;
    const calls = installSuccessfulProvider();
    const requestId = `${crypto.randomUUID()}:0`;

    const response = await mint(workspace, {
      subjectId: "user:success",
      requestId,
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      value: "ek_ephemeral_1",
      expiresAt: expect.any(Number),
      providerSessionId: "provider-session-1",
      grantId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      maxSessionDurationSeconds: 60,
    });
    expect(JSON.stringify(body)).not.toContain(PLATFORM_KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(headers.get("openai-project")).toBe(PROJECT_ID);
    expect(headers.get("openai-safety-identifier")).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: {
        type: "transcription",
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            transcription: { model: "gpt-4o-transcribe", language: "en" },
            turn_detection: {
              type: "server_vad",
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              threshold: 0.5,
            },
          },
        },
      },
    });

    const [row] = await grantRows(workspace.workspaceId);
    expect(row).toMatchObject({
      session_id: workspace.sessionIds[0],
      subject_id: "user:success",
      request_id: requestId,
      provider_session_id: "provider-session-1",
      status: "active",
      reserved_duration_seconds: "60",
      reserved_cost_micros: "10000",
    });
    const usageTypes = await shared!.admin<Array<{ event_type: string; quantity: string }>>`
      select event_type, quantity from usage_events
      where source_resource_type = 'transcription_grant' and source_resource_id = ${row!.id}
      order by event_type`;
    expect(usageTypes.map(({ event_type }) => event_type)).toEqual([
      "transcription.grant_reserved",
      "transcription.reserved_cost",
      "transcription.reserved_seconds",
      "transcription.secret_issued",
    ]);
    const auditActions = await shared!.admin<Array<{ action: string }>>`
      select action from audit_events
      where workspace_id = ${workspace.workspaceId}
        and target_type = 'transcription_grant' and target_id = ${row!.id}
      order by occurred_at`;
    expect(auditActions.map(({ action }) => action)).toEqual([
      "transcription.grant.reserved",
      "transcription.grant.issued",
    ]);

    const subjectHeaders = {
      "content-type": "application/json",
      authorization: await bearer(workspace, "user:success"),
    };
    const usagePath = `/v1/workspaces/${workspace.workspaceId}/transcription/grants/${row!.id}/usage`;
    const usageBody = JSON.stringify({
      sessionId: workspace.sessionIds[0],
      providerSessionId: "provider-session-1",
      providerEventId: "accepted-event-1",
      durationSeconds: 1.25,
    });
    const firstUsage = await app().request(usagePath, {
      method: "POST",
      headers: subjectHeaders,
      body: usageBody,
    });
    const replayedUsage = await app().request(usagePath, {
      method: "POST",
      headers: subjectHeaders,
      body: usageBody,
    });
    expect(firstUsage.status).toBe(200);
    expect(await firstUsage.json()).toEqual({ recorded: true });
    expect(await replayedUsage.json()).toEqual({ recorded: false });

    const wrongSubject = await app().request(usagePath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await bearer(workspace, "user:other"),
      },
      body: usageBody,
    });
    const wrongProvider = await app().request(usagePath, {
      method: "POST",
      headers: subjectHeaders,
      body: JSON.stringify({
        ...JSON.parse(usageBody),
        providerSessionId: "provider-session-other",
      }),
    });
    expect(wrongSubject.status).toBe(404);
    expect(wrongProvider.status).toBe(404);

    const settlePath = `/v1/workspaces/${workspace.workspaceId}/transcription/grants/${row!.id}/settle`;
    const settleBody = JSON.stringify({
      sessionId: workspace.sessionIds[0],
      providerSessionId: "provider-session-1",
      status: "completed",
    });
    const settled = await app().request(settlePath, {
      method: "POST",
      headers: subjectHeaders,
      body: settleBody,
    });
    const settlementReplay = await app().request(settlePath, {
      method: "POST",
      headers: subjectHeaders,
      body: settleBody,
    });
    const wrongSettlementSubject = await app().request(settlePath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await bearer(workspace, "user:other"),
      },
      body: settleBody,
    });
    expect(await settled.json()).toEqual({ grantId: row!.id, status: "completed" });
    expect(await settlementReplay.json()).toEqual({ grantId: row!.id, status: "completed" });
    expect(wrongSettlementSubject.status).toBe(409);

    const [after] = await grantRows(workspace.workspaceId);
    expect(after).toMatchObject({ status: "completed", reported_duration_seconds: "2" });
  });

  test("enforces request, session, subject, and workspace admission under the database lock", async () => {
    if (!available) return;
    const workspace = await freshWorkspace(
      {
        transcription: enabledPolicy({
          maxActiveGrantsPerWorkspace: 2,
          maxActiveGrantsPerSubject: 1,
        }),
      },
      3,
    );
    const calls = installSuccessfulProvider();
    const requestId = `${crypto.randomUUID()}:0`;

    expect(
      (
        await mint(workspace, {
          subjectId: "user:a",
          requestId,
          sessionId: workspace.sessionIds[0],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mint(workspace, {
          subjectId: "user:a",
          requestId,
          sessionId: workspace.sessionIds[0],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await mint(workspace, {
          subjectId: "user:b",
          requestId: `${crypto.randomUUID()}:0`,
          sessionId: workspace.sessionIds[0],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await mint(workspace, {
          subjectId: "user:a",
          requestId: `${crypto.randomUUID()}:0`,
          sessionId: workspace.sessionIds[1],
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await mint(workspace, {
          subjectId: "user:b",
          requestId: `${crypto.randomUUID()}:0`,
          sessionId: workspace.sessionIds[1],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mint(workspace, {
          subjectId: "user:c",
          requestId: `${crypto.randomUUID()}:0`,
          sessionId: workspace.sessionIds[2],
        })
      ).status,
    ).toBe(429);

    expect(calls).toHaveLength(2);
    const codes = await shared!.admin<Array<{ code: string }>>`
      select metadata->>'code' as code from audit_events
      where workspace_id = ${workspace.workspaceId}
        and action = 'transcription.grant.denied'
      order by occurred_at`;
    expect(codes.map(({ code }) => code)).toEqual([
      "transcription_request_already_used",
      "transcription_session_active",
      "transcription_subject_concurrency",
      "transcription_workspace_concurrency",
    ]);
  });

  test("enforces policy issuance-rate, monthly-duration, and monthly-cost ceilings", async () => {
    if (!available) return;
    installSuccessfulProvider();
    const cases = [
      {
        code: "transcription_subject_rate",
        policy: enabledPolicy({ maxIssuancesPerMinutePerSubject: 1 }),
        firstSubject: "user:same",
        secondSubject: "user:same",
      },
      {
        code: "transcription_monthly_duration",
        policy: enabledPolicy({ maxMonthlyDurationSeconds: 60 }),
        firstSubject: "user:first",
        secondSubject: "user:second",
      },
      {
        code: "transcription_monthly_cost",
        policy: enabledPolicy({ maxMonthlyCostMicros: 10_000 }),
        firstSubject: "user:first",
        secondSubject: "user:second",
      },
    ];

    for (const admissionCase of cases) {
      const workspace = await freshWorkspace({ transcription: admissionCase.policy }, 2);
      const first = await mint(workspace, {
        subjectId: admissionCase.firstSubject,
        sessionId: workspace.sessionIds[0],
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { grantId: string; providerSessionId: string };
      const settle = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/transcription/grants/${firstBody.grantId}/settle`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: await bearer(workspace, admissionCase.firstSubject),
          },
          body: JSON.stringify({
            sessionId: workspace.sessionIds[0],
            providerSessionId: firstBody.providerSessionId,
            status: "completed",
          }),
        },
      );
      expect(settle.status).toBe(200);

      const denied = await mint(workspace, {
        subjectId: admissionCase.secondSubject,
        sessionId: workspace.sessionIds[1],
      });
      expect(denied.status).toBe(429);
      const [audit] = await shared!.admin<Array<{ code: string }>>`
        select metadata->>'code' as code from audit_events
        where workspace_id = ${workspace.workspaceId}
          and action = 'transcription.grant.denied'
          and metadata->>'code' = ${admissionCase.code}`;
      expect(audit?.code).toBe(admissionCase.code);
    }
  });

  test("serializes concurrent admission against stricter static platform caps", async () => {
    if (!available) return;
    const workspace = await freshWorkspace(
      { transcription: enabledPolicy({ maxActiveGrantsPerWorkspace: 3 }) },
      2,
    );
    const calls = installSuccessfulProvider();
    const settings: Partial<Settings> = {
      usageLimitsMode: "static",
      staticUsageLimitsJson: JSON.stringify({ maxActiveTranscriptionGrantsPerWorkspace: 1 }),
    };

    const responses = await Promise.all([
      mint(workspace, {
        subjectId: "user:concurrent-a",
        sessionId: workspace.sessionIds[0],
        settings,
      }),
      mint(workspace, {
        subjectId: "user:concurrent-b",
        sessionId: workspace.sessionIds[1],
        settings,
      }),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 429]);
    expect(calls).toHaveLength(1);
    expect(
      (await grantRows(workspace.workspaceId)).filter(({ status }) => status === "active"),
    ).toHaveLength(1);
  });

  test("keeps conservative reservations and audited terminal rows on provider failures", async () => {
    if (!available) return;
    const workspace = await freshWorkspace({ transcription: enabledPolicy() }, 2);
    globalThis.fetch = (async () =>
      new Response(`provider leaked ${PLATFORM_KEY}`, { status: 401 })) as typeof fetch;

    const rejected = await mint(workspace, { sessionId: workspace.sessionIds[0] });
    expect(rejected.status).toBe(502);
    expect(await rejected.text()).not.toContain(PLATFORM_KEY);

    globalThis.fetch = (async () =>
      Response.json({
        value: PLATFORM_KEY,
        expires_at: Math.floor(Date.now() / 1_000) - 1,
        session: { id: "malformed-provider-session", type: "transcription" },
      })) as typeof fetch;
    const malformed = await mint(workspace, { sessionId: workspace.sessionIds[1] });
    expect(malformed.status).toBe(502);
    expect(await malformed.text()).not.toContain(PLATFORM_KEY);

    const rows = await grantRows(workspace.workspaceId);
    expect(rows.map(({ status }) => status)).toEqual(["provider_rejected", "provider_rejected"]);
    for (const row of rows) {
      const events = await shared!.admin<Array<{ event_type: string }>>`
        select event_type from usage_events
        where source_resource_type = 'transcription_grant' and source_resource_id = ${row.id}
        order by event_type`;
      expect(events.map(({ event_type }) => event_type)).toEqual([
        "transcription.grant_reserved",
        "transcription.reserved_cost",
        "transcription.reserved_seconds",
      ]);
      const actions = await shared!.admin<Array<{ action: string }>>`
        select action from audit_events
        where target_type = 'transcription_grant' and target_id = ${row.id}
        order by occurred_at`;
      expect(actions.map(({ action }) => action)).toEqual([
        "transcription.grant.reserved",
        "transcription.grant.provider_rejected",
      ]);
    }
  });
});
