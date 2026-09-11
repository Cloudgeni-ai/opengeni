import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  allAccountPermissions,
  allWorkspacePermissions,
  appendSessionEvents,
  applyCreditLedgerEntry,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  bindAuthorizedGitHubInstallationRepositories,
  bindGitHubInstallationRepositories,
  buildConnectionTokenResolver,
  claimCodemodeOperation,
  claimSessionWorkForAttempt,
  completeCodemodeOperation,
  isSessionCompactionRequested,
  createDb,
  createSession,
  createWorkspaceEnvironment,
  dbSql,
  decryptEnvironmentValue,
  decodeSessionListCursor,
  encodeSessionListCursor,
  enableCapabilityInstallation,
  getActiveSessionHistoryItems,
  getBillingBalance,
  getCapabilityInstallation,
  getSession,
  getPackInstallation,
  getScheduledTask,
  getSessionGoal,
  getVariableSetValuesForRun,
  listGitHubInstallationAccessForWorkspace,
  initializeSessionStartAtomically,
  listInstalledPortableSkills,
  listSessionEvents,
  listScheduledTasks,
  listOutstandingSessionSystemUpdates,
  listSessionTurns,
  listSessionMcpServersForRun,
  listUsageEvents,
  markCodemodeOperationExecutionStarted,
  recordStripeWebhookEvent,
  recordUsageEvent,
  persistAttemptToolCatalog,
  requireSession,
  saveRunState,
  setSessionGoalStatus,
  sumUsageQuantity,
  synchronizeCanonicalHumanLoginBindings,
  updateScheduledTask,
  upsertCapabilityCatalogItem,
  withWorkspaceSessionActivityRls,
  withWorkspaceRls,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { appendAndPublishEvents } from "@opengeni/events";
import {
  signDelegatedAccessToken,
  type AccessContext,
  type AuthorizeSessionInput,
  type McpMutationReceiptType,
  type Permission,
  type SessionEvent,
  type SessionStatus,
} from "@opengeni/contracts";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { buildOpenGeniMcpServer } from "../../apps/api/src/mcp/server";
import {
  settingsWithCodexCredential,
  settingsWithEnabledCapabilityMcpServers,
  settingsWithSessionMcpServersForRun,
} from "../../apps/worker/src/activities/capabilities";
import {
  GARAGE_FIXTURE_ACCESS_KEY_ID,
  GARAGE_FIXTURE_SECRET_ACCESS_KEY,
  MemoryEventBus,
  parseSseBlock,
  startTestMcpServer,
  startTestServices,
  testSettings,
  waitFor,
  type TestServices,
} from "@opengeni/testing";
import { prepareAgentTools } from "@opengeni/runtime";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { buildTimeline } from "../../packages/react/src/timeline";
import { submitTestHumanPrompt } from "./helpers/session-control";

async function setSessionStatus(
  db: Database,
  workspaceId: string,
  sessionId: string,
  status: SessionStatus,
  activeTurnId: string | null = null,
): Promise<void> {
  await withWorkspaceSessionActivityRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(dbSql`
      update sessions
      set status = ${status}, active_turn_id = ${activeTurnId}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${sessionId}
    `);
  });
}

async function settleSessionTurnsForVariableSetDetach(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  await withWorkspaceSessionActivityRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(dbSql`
      update session_turns
      set status = 'cancelled', active_attempt_id = null,
        cancelled_by = 'integration-test', cancel_reason = 'explicit_variable_set_detach',
        finished_at = coalesce(finished_at, now()), updated_at = now()
      where workspace_id = ${workspaceId} and session_id = ${sessionId}
        and status in ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
    `);
  });
}

describe("API component integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let workflow: FakeWorkflowClient;

  beforeAll(async () => {
    services = await startTestServices({
      temporal: false,
      objectStorage: true,
    });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("configured browser principals pass the CORS preflight", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("http://api.test/v1/config/client", {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:24000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type,x-opengeni-api-contract,x-opengeni-subject",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:24000");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "x-opengeni-subject",
    );
  });

  test("creates sessions, persists initial events, and starts workflow", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);

    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "hello",
        clientEventId: "client-create",
        model: "scripted-model",
        reasoningEffort: "xhigh",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    const session = (await response.json()) as {
      id: string;
      temporalWorkflowId: string;
      model: string;
      metadata: Record<string, unknown>;
    };
    expect(session.temporalWorkflowId).toBe(`session-${session.id}`);
    expect(session.model).toBe("scripted-model");
    expect(session.metadata.reasoningEffort).toBe("xhigh");
    expect(workflow.wakeups).toHaveLength(1);
    const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    // Admission accepted the initial prompt directly. It belongs in chat even
    // while the physical turn row waits for a worker claim.
    expect(buildTimeline(events).map((item) => item.kind)).toEqual(["user-message"]);
    expect(events.find((event) => event.type === "user.message")?.payload).toMatchObject({
      routing: "accepted_for_execution",
    });
    expect(events.find((event) => event.type === "turn.queued")?.payload).toMatchObject({
      routing: "accepted_for_execution",
    });

    const listed = await app.request(workspacePath(workspaceId, "/sessions?limit=10"));
    expect(listed.status).toBe(200);
    const sessions = (await listed.json()) as Array<{
      id: string;
      workspaceId: string;
      initialMessage: string;
    }>;
    expect(
      sessions.some(
        (item) =>
          item.id === session.id &&
          item.workspaceId === workspaceId &&
          item.initialMessage === "hello",
      ),
    ).toBe(true);
  });

  test("keeps array session lists stable while pin pages are idempotent and OCC-fenced", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const create = async (initialMessage: string) => {
      const response = await app.request(workspacePath(workspaceId, "/sessions"), {
        method: "POST",
        body: JSON.stringify({ initialMessage, model: "scripted-model" }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status, await response.clone().text()).toBe(202);
      return (await response.json()) as {
        id: string;
        updatedAt: string;
        pinned: boolean;
        pinVersion: number;
      };
    };
    const pinnedTarget = await create("find pinned alpha");
    await create("ordinary beta");
    await create("ordinary gamma");

    const setPin = (body: { pinned: boolean; expectedVersion?: number }) =>
      app.request(workspacePath(workspaceId, `/sessions/${pinnedTarget.id}/pin`), {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });

    const first = await setPin({ pinned: true, expectedVersion: 0 });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      id: pinnedTarget.id,
      pinned: true,
      pinVersion: 1,
      updatedAt: pinnedTarget.updatedAt,
    });
    // A timed-out client may retry the same desired state with its stale
    // version. That is idempotent success, not an OCC conflict.
    const retry = await setPin({ pinned: true, expectedVersion: 0 });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ pinned: true, pinVersion: 1 });

    const conflict = await setPin({ pinned: false, expectedVersion: 0 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      current: { pinned: true, pinVersion: 1 },
    });

    // The historical endpoint remains an array for same-major SDK clients, but
    // carries pin metadata and puts the caller's pins before ordinary rows.
    const legacy = await app.request(workspacePath(workspaceId, "/sessions?limit=1"));
    expect(legacy.status).toBe(200);
    const legacyRows = (await legacy.json()) as Array<{
      id: string;
      pinned: boolean;
      pinVersion: number;
    }>;
    expect(Array.isArray(legacyRows)).toBe(true);
    expect(legacyRows[0]).toMatchObject({
      id: pinnedTarget.id,
      pinned: true,
      pinVersion: 1,
    });
    const pinsOnlyResponse = await app.request(
      workspacePath(workspaceId, "/sessions?view=page&pinsOnly=true&limit=1"),
    );
    expect(pinsOnlyResponse.status).toBe(200);
    expect(await pinsOnlyResponse.json()).toMatchObject({
      pinned: [{ id: pinnedTarget.id }],
      sessions: [],
      nextCursor: null,
    });
    const snapshotsBeforeStablePage = await dbClient.db.execute<{
      count: number;
    }>(dbSql`
      select count(*)::int as count
      from session_list_snapshots
      where workspace_id = ${workspaceId}`);
    expect(snapshotsBeforeStablePage).toEqual([{ count: 0 }]);

    const firstPageResponse = await app.request(
      workspacePath(workspaceId, "/sessions?view=page&limit=1"),
    );
    expect(firstPageResponse.status).toBe(200);
    const firstPage = (await firstPageResponse.json()) as {
      pinned: Array<{ id: string }>;
      sessions: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstPage.pinned.map((row) => row.id)).toEqual([pinnedTarget.id]);
    expect(firstPage.sessions).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.sessions.map((row) => row.id)).not.toContain(pinnedTarget.id);

    const secondPageResponse = await app.request(
      workspacePath(
        workspaceId,
        `/sessions?view=page&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      ),
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = (await secondPageResponse.json()) as typeof firstPage;
    expect(secondPage.pinned.map((row) => row.id)).toEqual([pinnedTarget.id]);
    expect(secondPage.sessions).toHaveLength(1);
    expect(secondPage.sessions[0]!.id).not.toBe(firstPage.sessions[0]!.id);
    expect(secondPage.sessions[0]!.id).not.toBe(pinnedTarget.id);

    const filtered = await app.request(
      workspacePath(workspaceId, "/sessions?view=page&search=pinned%20alpha"),
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({
      pinned: [{ id: pinnedTarget.id }],
      sessions: [],
    });
    const currentDateFiltered = await app.request(
      workspacePath(
        workspaceId,
        "/sessions?view=page&updatedFrom=2026-09-04T00%3A00%3A00.000Z&updatedBefore=2026-09-05T00%3A00%3A00.000Z",
      ),
    );
    expect(currentDateFiltered.status).toBe(200);
    expect((await currentDateFiltered.json()).filtersApplied).toBe(true);
    for (const name of ["updatedFrom", "updatedBefore", "createdFrom", "createdBefore"]) {
      const response = await app.request(
        workspacePath(workspaceId, `/sessions?view=page&${name}=2026-09-04T00%3A00%3A00.000001Z`),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("millisecond precision");
    }

    expect(
      (await app.request(workspacePath(workspaceId, "/sessions?view=page&createdByKind=subject")))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request(
          workspacePath(
            workspaceId,
            "/sessions?view=page&updatedFrom=2026-09-05T00%3A00%3A00.000Z&updatedBefore=2026-09-04T00%3A00%3A00.000Z",
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request(workspacePath(workspaceId, "/sessions?view=page&cursor=not-a-cursor")))
        .status,
    ).toBe(400);
    const decodedCursor = decodeSessionListCursor(firstPage.nextCursor!);
    expect(decodedCursor).not.toBeNull();
    const cursorEnvelope = JSON.parse(
      Buffer.from(firstPage.nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const outOfRangeTimestampCursor = Buffer.from(
      JSON.stringify({ ...cursorEnvelope, sortAt: "0000-01-01T00:00:00.000000Z" }),
    ).toString("base64url");
    expect(
      (
        await app.request(
          workspacePath(
            workspaceId,
            `/sessions?view=page&limit=1&cursor=${encodeURIComponent(outOfRangeTimestampCursor)}`,
          ),
        )
      ).status,
    ).toBe(400);
    for (const invalidCursor of [
      encodeSessionListCursor({
        ...decodedCursor!,
        search: "different-filter",
      }),
    ]) {
      expect(
        (
          await app.request(
            workspacePath(
              workspaceId,
              `/sessions?view=page&limit=1&cursor=${encodeURIComponent(invalidCursor)}`,
            ),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await app.request(
          workspacePath(
            workspaceId,
            `/sessions?view=page&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          workspacePath(
            workspaceId,
            `/sessions?view=page&limit=1&channelId=null&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
          ),
        )
      ).status,
    ).toBe(400);

    const unpinned = await setPin({ pinned: false, expectedVersion: 1 });
    expect(unpinned.status).toBe(200);
    expect(await unpinned.json()).toMatchObject({
      id: pinnedTarget.id,
      pinned: false,
      pinnedAt: null,
      pinVersion: 2,
      updatedAt: pinnedTarget.updatedAt,
    });
    const afterUnpinResponse = await app.request(
      workspacePath(workspaceId, "/sessions?view=page&search=find%20pinned%20alpha"),
    );
    expect(afterUnpinResponse.status).toBe(200);
    expect(await afterUnpinResponse.json()).toMatchObject({
      pinned: [],
      sessions: [{ id: pinnedTarget.id, pinned: false, pinnedAt: null, pinVersion: 2 }],
    });

    const renamed = await app.request(workspacePath(workspaceId, `/sessions/${pinnedTarget.id}`), {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed before re-pin" }),
      headers: { "content-type": "application/json" },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      id: pinnedTarget.id,
      title: "Renamed before re-pin",
      pinned: false,
      pinVersion: 2,
    });

    const repinned = await setPin({ pinned: true, expectedVersion: 2 });
    expect(repinned.status).toBe(200);
    expect(await repinned.json()).toMatchObject({
      pinned: true,
      pinVersion: 3,
    });
    const staleAfterRepin = await setPin({ pinned: false, expectedVersion: 0 });
    expect(staleAfterRepin.status).toBe(409);
    expect(await staleAfterRepin.json()).toMatchObject({
      current: { pinned: true, pinVersion: 3 },
    });

    const malformedSessionId = await app.request(
      workspacePath(workspaceId, "/sessions/not-a-uuid/pin"),
      {
        method: "PUT",
        body: JSON.stringify({ pinned: true }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(malformedSessionId.status).toBe(404);
    const malformedBody = await app.request(
      workspacePath(workspaceId, `/sessions/${pinnedTarget.id}/pin`),
      {
        method: "PUT",
        body: "{",
        headers: { "content-type": "application/json" },
      },
    );
    expect(malformedBody.status).toBe(400);
  });

  test("create-with-instructions persists and reads back the field without leaking a timeline event", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);

    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "review this PR",
        model: "scripted-model",
        // Trailing whitespace exercises the contracts .trim() on the create path.
        instructions: "  You are the PR-reviewer persona: be terse and cite files.  ",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    const created = (await response.json()) as {
      id: string;
      instructions: string | null;
    };
    // Create response exposes the (trimmed) instructions.
    expect(created.instructions).toBe("You are the PR-reviewer persona: be terse and cite files.");

    // Read path (GET /sessions/:id) returns it too.
    const read = await app.request(workspacePath(workspaceId, `/sessions/${created.id}`));
    expect(read.status).toBe(200);
    const fetched = (await read.json()) as { instructions: string | null };
    expect(fetched.instructions).toBe("You are the PR-reviewer persona: be terse and cite files.");

    // Persisted on the row (core/db roundtrip).
    const row = await requireSession(dbClient.db, workspaceId, created.id);
    expect(row.instructions).toBe("You are the PR-reviewer persona: be terse and cite files.");

    // It must NEVER surface as a timeline event, and no payload may carry it.
    const events = await listSessionEvents(dbClient.db, workspaceId, created.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    const serialized = JSON.stringify(events.map((event) => event.payload));
    expect(serialized).not.toContain("PR-reviewer persona");

    // Absent instructions read back as null (byte-identical to today).
    const plain = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no instructions",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const plainSession = (await plain.json()) as {
      id: string;
      instructions: string | null;
    };
    expect(plainSession.instructions).toBeNull();
  });

  test("create idempotency key dedups double-submit and concurrent creates to one session over the API", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const create = (idempotencyKey: string) =>
      app.request(workspacePath(workspaceId, "/sessions"), {
        method: "POST",
        body: JSON.stringify({
          initialMessage: "dedup me",
          idempotencyKey,
          model: "scripted-model",
        }),
        headers: { "content-type": "application/json" },
      });

    // Sequential double-submit: one session and one durable start state. The
    // retry re-delivers the same wake revision so an ambiguous first response
    // can repair a lost signal without duplicating the turn.
    const seqKey = `route-seq-${crypto.randomUUID()}`;
    const wakeupsBefore = workflow.wakeups.length;
    const firstResp = await create(seqKey);
    expect(firstResp.status).toBe(202);
    const firstSession = (await firstResp.json()) as { id: string };
    const secondResp = await create(seqKey);
    expect(secondResp.status).toBe(202);
    const secondSession = (await secondResp.json()) as { id: string };
    expect(secondSession.id).toBe(firstSession.id);
    expect(workflow.wakeups.length).toBe(wakeupsBefore + 2);
    const seqEvents = await listSessionEvents(dbClient.db, workspaceId, firstSession.id);
    expect(seqEvents.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);

    // Concurrent double-dispatch: N at once on the same key -> one session.
    const raceKey = `route-race-${crypto.randomUUID()}`;
    const wakeupsBeforeRace = workflow.wakeups.length;
    const responses = await Promise.all(Array.from({ length: 6 }, () => create(raceKey)));
    const raceSessions = await Promise.all(
      responses.map(async (resp) => {
        expect(resp.status).toBe(202);
        return ((await resp.json()) as { id: string }).id;
      }),
    );
    const uniqueRaceIds = new Set(raceSessions);
    expect(uniqueRaceIds.size).toBe(1);
    // Every retry may safely re-deliver the same revision; durable state still
    // contains exactly one session, first turn, and event batch.
    expect(workflow.wakeups.length).toBe(wakeupsBeforeRace + 6);
    const rows = await withWorkspaceCount(dbClient.db, workspaceId, raceKey);
    expect(rows).toBe(1);

    // Different key -> an independent session (back-compat).
    const otherResp = await create(`route-other-${crypto.randomUUID()}`);
    const otherSession = (await otherResp.json()) as { id: string };
    expect(otherSession.id).not.toBe(firstSession.id);

    // Absent key -> independent each time (the legacy path).
    const plain1 = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no key",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const plain2 = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no key",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(((await plain1.json()) as { id: string }).id).not.toBe(
      ((await plain2.json()) as { id: string }).id,
    );
  });

  test("creates sessions with goals and manages the goal lifecycle over the API", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: "http://127.0.0.1:65530/v1/workspaces/{workspaceId}/mcp",
            cacheToolsList: true,
          },
        ],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);

    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "take repo zero-to-one",
        model: "scripted-model",
        goal: {
          text: "repo deployed to staging",
          successCriteria: "health probe green",
          maxAutoContinuations: 7,
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(202);
    const session = (await created.json()) as {
      id: string;
      tools: Array<{ kind: string; id: string }>;
    };
    // Goal-bearing sessions force the first-party MCP server so goal tools are reachable.
    expect(session.tools).toContainEqual({ kind: "mcp", id: "opengeni" });
    const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "goal.set",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);

    const fetched = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/goal`));
    expect(fetched.status).toBe(200);
    const goal = (await fetched.json()) as {
      id: string;
      status: string;
      text: string;
      maxAutoContinuations: number;
    };
    expect(goal.status).toBe("active");
    expect(goal.text).toBe("repo deployed to staging");
    expect(goal.maxAutoContinuations).toBe(7);

    const paused = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/goal`), {
      method: "PATCH",
      body: JSON.stringify({ status: "paused", rationale: "operator hold" }),
      headers: { "content-type": "application/json" },
    });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { status: string }).status).toBe("paused");

    const wakeupsBeforeResume = workflow.wakeups.length;
    const resumed = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/goal`), {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
      headers: { "content-type": "application/json" },
    });
    expect(resumed.status).toBe(200);
    const resumedGoal = (await resumed.json()) as {
      status: string;
      autoContinuations: number;
      pausedReason: string | null;
    };
    expect(resumedGoal.status).toBe("active");
    expect(resumedGoal.autoContinuations).toBe(0);
    expect(resumedGoal.pausedReason).toBeNull();
    // Resume wakes the workflow so an idle session re-enters the goal loop.
    expect(workflow.wakeups.length).toBe(wakeupsBeforeResume + 1);

    const lifecycleEvents = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(lifecycleEvents.some((event) => event.type === "goal.paused")).toBe(true);
    expect(lifecycleEvents.some((event) => event.type === "goal.resumed")).toBe(true);

    // Resuming an already-active goal is an invalid transition.
    const resumeActive = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/goal`),
      {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(resumeActive.status).toBe(409);

    // Completed goals reject operator transitions.
    await setSessionGoalStatus(dbClient.db, workspaceId, session.id, {
      status: "completed",
      evidence: "done",
    });
    const resumeCompleted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/goal`),
      {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(resumeCompleted.status).toBe(409);

    // Sessions without goals 404.
    const plain = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no goal here",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const plainSession = (await plain.json()) as { id: string };
    const missing = await app.request(
      workspacePath(workspaceId, `/sessions/${plainSession.id}/goal`),
    );
    expect(missing.status).toBe(404);
  });

  test("POST /context/clear clears context (audit-preserved), 409s mid-turn, and emits the event", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "clear me",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    const persisted = await requireSession(dbClient.db, workspaceId, session.id);
    await withWorkspaceRls(dbClient.db, workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: persisted.accountId,
          workspaceId,
          sessionId: session.id,
          position: 0,
          item: { type: "message", role: "user", content: "earlier work" },
        },
        {
          accountId: persisted.accountId,
          workspaceId,
          sessionId: session.id,
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
      ]);
    });

    // While a turn is in flight, clearing is refused (409) — mid-turn safety.
    await setSessionStatus(dbClient.db, workspaceId, session.id, "running", null);
    const blocked = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/context/clear`),
      {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(blocked.status).toBe(409);

    // An explicit confirm is required on the wire.
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const noConfirm = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/context/clear`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(noConfirm.status).toBe(400);

    const cleared = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/context/clear`),
      {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(cleared.status).toBe(204);

    // Active read collapses to the single neutral marker; the cleared event lands.
    const active = await getActiveSessionHistoryItems(dbClient.db, workspaceId, session.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.item).toMatchObject({ content: "[context cleared]" });
    const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(events.some((event) => event.type === "session.context.cleared")).toBe(true);
  });

  test("POST /context/compact: records one provider-independent durable request", async () => {
    workflow = new FakeWorkflowClient();
    const workspaceId = await defaultWorkspaceId(
      createApp({
        settings: testSettings({ databaseUrl: services.databaseUrl }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: workflow,
      }),
    );

    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "compact me",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);

    const pending = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/context/compact`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { status: string }).status).toBe("pending");
    expect(await isSessionCompactionRequested(dbClient.db, workspaceId, session.id)).toBe(true);
  });

  test("registers session lifecycle MCP tools only for session-bound grants", async () => {
    const settings = testSettings({ databaseUrl: services.databaseUrl });
    const baseGrant = await bootstrapMcpGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: baseGrant.accountId,
      workspaceId: baseGrant.workspaceId,
      initialMessage: "goal tools",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(dbClient.db, {
      accountId: baseGrant.accountId,
      workspaceId: baseGrant.workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(dbClient.db, baseGrant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("goal MCP turn was not claimed");
    const mcpDeps = {
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by goal MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };

    // Without the worker-asserted sessionId claim, lifecycle tools do not exist.
    const sessionlessMcp = buildOpenGeniMcpServer(mcpDeps, baseGrant);
    await expect(callMcpTool(sessionlessMcp, "goal_set", { text: "x" })).rejects.toThrow(
      "MCP tool not registered",
    );

    const grant = {
      ...baseGrant,
      principalKind: "agent_attempt" as const,
      metadata: {
        delegated: true,
        sessionId: session.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
        firstPartyMcpTools: [
          "goal_set",
          "goal_update",
          "goal_progress",
          "wait_for_input",
          "goal_pause",
          "goal_resume",
          "goal_complete",
        ],
      },
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);

    const setGoal = await callMcpTool<McpMutationReceiptType>(mcp, "goal_set", {
      text: "keep CI green",
      successCriteria: "main pipeline passes",
    });
    expect(setGoal).toMatchObject({
      receiptVersion: "mcp-mutation-receipt.v1",
      outcome: "created",
      changed: true,
      resource: { state: "active", version: 1 },
    });
    expect(JSON.stringify(setGoal)).not.toContain("main pipeline passes");

    const updated = await callMcpTool<{
      version: number;
      text: string;
      operationId: string;
      replay: boolean;
    }>(mcp, "goal_update", {
      text: "keep CI green on main",
      changeKind: "refinement",
      rationale: "clarifies the existing CI objective without redirecting it",
      expectedObjectiveRevision: 1,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(updated.version).toBe(2);
    expect(updated.operationId).toBeTruthy();
    expect(updated.replay).toBe(false);

    const progress = await callMcpTool<{
      version: number;
      objectiveRevision: number;
      operationId: string;
      replay: boolean;
    }>(mcp, "goal_progress", {
      progressNote: "fixed two flaky tests",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(progress).toMatchObject({
      version: 2,
      objectiveRevision: 2,
      replay: false,
    });
    expect(progress.operationId).toBeTruthy();

    // wait_for_input: self-only, exact-attempt fenced, bounded relative timeout,
    // and idempotent per (turn, exact arguments) without a caller key.
    const waitArgs = {
      reason: "two child sessions are still implementing their slices",
      timeoutSeconds: 900,
    };
    const held = await callMcpTool<{
      status: string;
      deadlineAt: string;
      operationId: string;
      replay: boolean;
      nextAction: string;
    }>(mcp, "wait_for_input", waitArgs);
    expect(held).toMatchObject({ status: "waiting_for_input", replay: false });
    expect(new Date(held.deadlineAt).getTime()).toBeGreaterThan(Date.now() + 800_000);
    expect(held.nextAction).toContain("runtime yields this turn");
    const heldReplay = await callMcpTool<{ replay: boolean; deadlineAt: string }>(
      mcp,
      "wait_for_input",
      waitArgs,
    );
    expect(heldReplay).toMatchObject({ replay: true, deadlineAt: held.deadlineAt });
    await expect(
      callMcpTool(mcp, "wait_for_input", { reason: "too short", timeoutSeconds: 5 }),
    ).rejects.toThrow();
    const [waitRow] = await dbClient.db.execute<{
      input_wait_turn_id: string | null;
      input_wait_until: string | Date | null;
    }>(sql`
      select input_wait_turn_id, input_wait_until
      from sessions
      where workspace_id = ${grant.workspaceId} and id = ${session.id}`);
    expect(waitRow?.input_wait_turn_id).toBe(claimed.turn.id);
    expect(new Date(waitRow!.input_wait_until!).toISOString()).toBe(held.deadlineAt);

    const pausedGoal = await callMcpTool<McpMutationReceiptType>(mcp, "goal_pause", {
      rationale: "waiting on upstream fix",
    });
    expect(pausedGoal.resource.state).toBe("paused");
    expect(JSON.stringify(pausedGoal)).not.toContain("waiting on upstream fix");

    await expect(
      callMcpTool(mcp, "goal_set", {
        text: "upstream fixed; finish the job",
      }),
    ).rejects.toThrow("use goal_update to revise it");
    const revisedWhilePaused = await callMcpTool<{
      version: number;
      text: string;
      outcome: string;
    }>(mcp, "goal_update", {
      text: "upstream fixed; finish the job",
      expectedObjectiveRevision: 2,
      changeKind: "refinement",
      rationale: "the upstream blocker cleared without changing the objective",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(revisedWhilePaused).toMatchObject({
      version: 4,
      text: "upstream fixed; finish the job",
      outcome: "applied",
    });

    const resumedGoal = await callMcpTool<McpMutationReceiptType>(mcp, "goal_resume", {});
    expect(resumedGoal).toMatchObject({ changed: true, resource: { state: "active" } });
    const alreadyActive = await callMcpTool<McpMutationReceiptType>(mcp, "goal_resume", {});
    expect(alreadyActive).toMatchObject({ changed: false, resource: { state: "active" } });

    for (const pausedReason of ["user_pause", "api", "agent", "limits", "max_auto_continuations"]) {
      await setSessionGoalStatus(dbClient.db, baseGrant.workspaceId, session.id, {
        status: "paused",
        pausedReason,
      });
      const resumed = await callMcpTool<McpMutationReceiptType>(mcp, "goal_resume", {});
      expect(resumed).toMatchObject({ changed: true, resource: { state: "active" } });
      const goal = await getSessionGoal(dbClient.db, baseGrant.workspaceId, session.id);
      expect(goal).toMatchObject({ autoContinuations: 0, noProgressStreak: 0, pausedReason: null });
    }

    const completedGoal = await callMcpTool<McpMutationReceiptType>(mcp, "goal_complete", {
      evidence: "CI green for 3 consecutive runs",
    });
    expect(completedGoal.resource.state).toBe("completed");
    expect(JSON.stringify(completedGoal)).not.toContain("CI green for 3 consecutive runs");
    await expect(callMcpTool(mcp, "goal_pause", { rationale: "too late" })).rejects.toThrow(
      "completed",
    );
    await expect(
      callMcpTool(mcp, "goal_update", {
        text: "also too late",
        changeKind: "replacement",
        rationale: "attempting to replace a completed objective must remain forbidden",
        expectedObjectiveRevision: 3,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("completed");
    const replacementGoal = await callMcpTool<McpMutationReceiptType>(mcp, "goal_set", {
      text: "ship the next main pipeline improvement",
      successCriteria: "the next improvement is verified on main",
    });
    expect(replacementGoal).toMatchObject({
      outcome: "updated",
      changed: true,
      resource: { state: "active" },
      facts: { replaced: true },
    });

    const events = await listSessionEvents(dbClient.db, baseGrant.workspaceId, session.id);
    expect(
      events.filter((event) => event.type.startsWith("goal.")).map((event) => event.type),
    ).toEqual([
      "goal.set",
      "goal.updated",
      "goal.progress",
      "goal.paused",
      "goal.updated",
      ...Array(6).fill("goal.resumed"),
      "goal.completed",
      "goal.set",
    ]);
    expect(await getSessionGoal(dbClient.db, baseGrant.workspaceId, session.id)).toMatchObject({
      status: "active",
      text: "ship the next main pipeline improvement",
      evidence: null,
    });
  });

  test("managed email/password auth completes onboarding before using workspace API keys", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        billingMode: "stripe",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const email = `managed-${crypto.randomUUID()}@example.com`;
    const password = "password1234";
    const signup = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Managed User", email, password }),
    });
    expect(signup.status).toBeGreaterThanOrEqual(200);
    expect(signup.status).toBeLessThan(300);
    await dbClient.db.execute(
      dbSql`update auth_users set email_verified = true where email = ${email}`,
    );

    const signin = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signin.status).toBeGreaterThanOrEqual(200);
    expect(signin.status).toBeLessThan(300);
    const cookie = signin.headers.get("set-cookie");
    expect(cookie).toBeTruthy();

    const onboardingStatus = await app.request("/v1/auth/organization-onboarding", {
      headers: { cookie: cookie! },
    });
    expect(onboardingStatus.status).toBe(200);
    expect(await onboardingStatus.json()).toEqual({ state: "required" });
    const onboarding = await app.request("/v1/auth/organization-onboarding", {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({
        organizationName: "Managed integration organization",
        operationId: crypto.randomUUID(),
      }),
    });
    expect(onboarding.status).toBe(200);

    const access = await app.request("/v1/access/me", {
      headers: { cookie: cookie! },
    });
    expect(access.status).toBe(200);
    const context = (await access.json()) as AccessContext;
    expect(context.mode).toBe("managed");
    expect(context.accountGrants[0]?.permissions).toContain("billing:manage");
    // Personal workspaces deliberately cannot mint API keys. Provision the
    // shared workspace this API-key scenario is intended to administer.
    const createdWorkspace = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({
        accountId: context.defaultAccountId,
        name: "Managed integration workspace",
      }),
    });
    expect(createdWorkspace.status).toBe(201);
    const workspaceId = ((await createdWorkspace.json()) as { id: string }).id;
    const createdKey = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({
        name: "Managed test key",
        description: "Used by the managed authentication integration test",
        permissions: ["workspace:read", "sessions:create"],
      }),
    });
    expect(createdKey.status).toBe(201);
    const keyBody = (await createdKey.json()) as {
      token: string;
      apiKey: { workspaceId: string; description: string | null };
    };
    expect(keyBody.token).toStartWith("ogk_");
    expect(keyBody.apiKey.workspaceId).toBe(workspaceId);
    expect(keyBody.apiKey.description).toBe("Used by the managed authentication integration test");
    const listedKeys = await app.request(workspacePath(workspaceId, "/api-keys"), {
      headers: { cookie: cookie! },
    });
    expect(listedKeys.status).toBe(200);
    expect(
      (
        (await listedKeys.json()) as {
          apiKeys: Array<{ description: string | null }>;
        }
      ).apiKeys[0]?.description,
    ).toBe("Used by the managed authentication integration test");
    const keyWorkspaceList = await app.request("/v1/workspaces", {
      headers: { authorization: `Bearer ${keyBody.token}` },
    });
    expect(keyWorkspaceList.status).toBe(200);
    const keyWorkspaces = (await keyWorkspaceList.json()) as Array<{
      id: string;
    }>;
    expect(keyWorkspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);

    const billingKey = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({
        name: "Managed billing key",
        permissions: ["workspace:read", "billing:read"],
      }),
    });
    expect(billingKey.status).toBe(201);
    const billingKeyBody = (await billingKey.json()) as {
      token: string;
      apiKey: { description: string | null };
    };
    expect(billingKeyBody.apiKey.description).toBeNull();
    const billing = await app.request(`/v1/billing?accountId=${context.defaultAccountId}`, {
      headers: { authorization: `Bearer ${billingKeyBody.token}` },
    });
    expect(billing.status).toBe(200);
    const deniedBillingPortal = await app.request("/v1/billing/portal", {
      method: "POST",
      headers: {
        authorization: `Bearer ${billingKeyBody.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ accountId: context.defaultAccountId }),
    });
    expect(deniedBillingPortal.status).toBe(403);

    const workspaceOnlyKey = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({
        name: "Workspace only key",
        permissions: ["workspace:read"],
      }),
    });
    expect(workspaceOnlyKey.status).toBe(201);
    const workspaceOnlyKeyBody = (await workspaceOnlyKey.json()) as {
      token: string;
    };
    const deniedBilling = await app.request(`/v1/billing?accountId=${context.defaultAccountId}`, {
      headers: { authorization: `Bearer ${workspaceOnlyKeyBody.token}` },
    });
    expect(deniedBilling.status).toBe(403);
    const deniedWorkspaceBillingPortal = await app.request("/v1/billing/portal", {
      method: "POST",
      headers: {
        authorization: `Bearer ${workspaceOnlyKeyBody.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ accountId: context.defaultAccountId }),
    });
    expect(deniedWorkspaceBillingPortal.status).toBe(403);

    const exactSecret =
      `ordinary source: const fakeToken = "ghp_not_a_credential";\n` +
      `shell: printf '%s\\n' "$VALUE"`;
    const variableSetResponse = await app.request(workspacePath(workspaceId, "/variable-sets"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({
        name: `permissioned-read-${crypto.randomUUID()}`,
        variables: [{ name: "EXACT_VALUE", value: exactSecret }],
      }),
    });
    expect(variableSetResponse.status).toBe(201);
    const variableSet = (await variableSetResponse.json()) as { id: string };
    const secretPath = workspacePath(
      workspaceId,
      `/variable-sets/${variableSet.id}/variables/EXACT_VALUE`,
    );
    const createPermissionKey = async (name: string, permissions: Permission[]) => {
      const response = await app.request(workspacePath(workspaceId, "/api-keys"), {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie! },
        body: JSON.stringify({ name, permissions }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { token: string }).token;
    };
    const wildcardToken = await createPermissionKey("Legacy wildcard", ["workspace:admin"]);
    const wildcardRead = await app.request(secretPath, {
      headers: { authorization: `Bearer ${wildcardToken}` },
    });
    expect(wildcardRead.status).toBe(403);
    expect(await wildcardRead.text()).not.toContain(exactSecret);

    const wildcardEscalation = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${wildcardToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Forbidden plaintext escalation",
        permissions: ["variable-sets:read", "secrets:read"],
      }),
    });
    expect(wildcardEscalation.status).toBe(403);

    const resourceOnlyToken = await createPermissionKey("Resource read only", [
      "variable-sets:read",
    ]);
    expect(
      (
        await app.request(secretPath, {
          headers: { authorization: `Bearer ${resourceOnlyToken}` },
        })
      ).status,
    ).toBe(403);
    const secretOnlyToken = await createPermissionKey("Secret read only", ["secrets:read"]);
    expect(
      (
        await app.request(secretPath, {
          headers: { authorization: `Bearer ${secretOnlyToken}` },
        })
      ).status,
    ).toBe(403);

    const explicitReadToken = await createPermissionKey("Explicit plaintext read", [
      "variable-sets:read",
      "secrets:read",
    ]);
    const explicitRead = await app.request(secretPath, {
      headers: { authorization: `Bearer ${explicitReadToken}` },
    });
    expect(explicitRead.status).toBe(200);
    expect(await explicitRead.json()).toMatchObject({
      variableSetId: variableSet.id,
      name: "EXACT_VALUE",
      version: 1,
      value: exactSecret,
    });

    const otherAccount = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-key-other",
      accountExternalId: crypto.randomUUID(),
      accountName: "Other managed key account",
      workspaceExternalSource: "test:managed-key-other",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Other managed key workspace",
      subjectId: `test:managed-key-other:${crypto.randomUUID()}`,
    });
    const deniedOtherAccountBilling = await app.request(
      `/v1/billing?accountId=${otherAccount.defaultAccountId}`,
      {
        headers: { authorization: `Bearer ${billingKeyBody.token}` },
      },
    );
    expect(deniedOtherAccountBilling.status).toBe(403);
  });

  test("local access preserves valid worker delegation and falls back for ordinary requests", async () => {
    const delegationSecret = "test-local-delegation-secret";
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      productAccessMode: "local",
      delegationSecret,
    });
    const app = createApp({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const delegatedWorkspace = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:local-delegation",
      accountExternalId: crypto.randomUUID(),
      accountName: "Local delegation test",
      workspaceExternalSource: "test:local-delegation",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Local delegation workspace",
      subjectId: `test:local-delegation:${crypto.randomUUID()}`,
    });
    const delegatedGrant = delegatedWorkspace.workspaceGrants[0]!;
    const delegatedSession = await createSession(dbClient.db, {
      accountId: delegatedGrant.accountId,
      workspaceId: delegatedGrant.workspaceId,
      initialMessage: "exercise local delegated MCP access",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(dbClient.db, {
      accountId: delegatedGrant.accountId,
      workspaceId: delegatedGrant.workspaceId,
      sessionId: delegatedSession.id,
      clientEventId: `initial:${delegatedSession.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const delegatedAttempt = await claimCreatedSessionForRun(
      dbClient.db,
      delegatedGrant,
      delegatedSession.id,
    );
    const sessionId = delegatedSession.id;
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: delegatedWorkspace.defaultAccountId!,
      workspaceId: delegatedWorkspace.defaultWorkspaceId!,
      subjectId: "test:local-delegated-worker",
      permissions: ["workspace:read"],
      principalKind: "service",
      sessionId,
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const delegatedResponse = await app.request("/v1/access/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(delegatedResponse.status).toBe(200);
    const delegated = (await delegatedResponse.json()) as AccessContext;
    expect(delegated).toMatchObject({
      mode: "local",
      subjectId: "test:local-delegated-worker",
      defaultAccountId: delegatedWorkspace.defaultAccountId,
      defaultWorkspaceId: delegatedWorkspace.defaultWorkspaceId,
    });
    expect(delegated.workspaceGrants).toEqual([
      expect.objectContaining({
        permissions: ["workspace:read"],
        metadata: expect.objectContaining({ delegated: true, sessionId }),
      }),
    ]);

    const fallbackResponse = await app.request("/v1/access/me", {
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(fallbackResponse.status).toBe(200);
    const fallback = (await fallbackResponse.json()) as AccessContext;
    expect(fallback.mode).toBe("local");
    expect(fallback.subjectId).toBe("dev");
    expect(fallback.workspaceGrants[0]?.metadata).toBeUndefined();

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      prepared = await prepareAgentTools(
        {
          ...settings,
          opengeniMcpInternalUrl: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
          mcpServers: [
            {
              id: "opengeni",
              name: "OpenGeni",
              url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
              timeoutMs: undefined,
              cacheToolsList: false,
            },
          ],
        },
        [{ kind: "mcp", id: "opengeni" }],
        {
          accountId: delegatedWorkspace.defaultAccountId!,
          workspaceId: delegatedWorkspace.defaultWorkspaceId!,
          sessionId,
          turnId: delegatedAttempt.turnId,
          attemptId: delegatedAttempt.attemptId,
          executionGeneration: delegatedAttempt.executionGeneration,
        },
      );
      const toolNames = (await prepared.mcpServers[0]!.listTools()).map((tool) => tool.name);
      expect(toolNames).toContain("opengeni__set_session_title");
      expect(toolNames).toContain("opengeni__goal_set");
    } finally {
      await prepared?.close().catch(() => undefined);
      server.stop(true);
    }
  });

  test("managed session cookie still authenticates when an invalid bearer header is present", async () => {
    const userId = `managed-user-${crypto.randomUUID()}`;
    const email = `managed-cookie-${crypto.randomUUID()}@example.com`;
    await dbClient.db.execute(dbSql`
      insert into auth_users (id, name, email, email_verified)
      values (${userId}, 'Managed Cookie User', ${email}, true)
    `);
    await dbClient.db.execute(dbSql`
      insert into auth_identities (id, user_id, provider_id, account_id)
      values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})
    `);
    const identity = await synchronizeCanonicalHumanLoginBindings(dbClient.db, userId);
    const authSessionId = crypto.randomUUID();
    await dbClient.db.execute(dbSql`
      insert into auth_sessions (
        id, user_id, token, expires_at,
        identity_id, identity_revision, auth_revision
      ) values (
        ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
        ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
      )
    `);
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      managedAuth: {
        api: {
          getSession: async () => ({
            headers: new Headers(),
            response: {
              session: { id: authSessionId },
              user: { id: userId, email, name: "Managed Cookie User" },
            },
          }),
        },
      } as any,
    });

    const access = await app.request("/v1/access/me", {
      headers: {
        authorization: "Bearer not-a-valid-opengeni-token",
        cookie: "better-auth.session_token=test",
      },
    });
    expect(access.status).toBe(200);
    const context = (await access.json()) as AccessContext;
    expect(context.mode).toBe("managed");
    expect(context.subjectId).toBe(`user:${userId}`);
    expect(context.defaultAccountId).toBeNull();
    expect(context.defaultWorkspaceId).toBeNull();
    expect(context.accountGrants).toEqual([]);
    expect(context.workspaceGrants).toEqual([]);
  });

  test("managed credit gate blocks costly writes and exposes recorded usage", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        usageLimitsMode: "managed",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-credit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Managed credit test",
      workspaceExternalSource: "test:managed-credit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Managed credit workspace",
      subjectId: "test:managed-credit",
    });
    const grant = context.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId;
    const accountId = grant.accountId;
    const token = await signDelegatedAccessToken("test-delegation-secret", {
      accountId,
      workspaceId,
      subjectId: grant.subjectId,
      permissions: [...grant.permissions, "billing:read"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const authHeaders = { authorization: `Bearer ${token}` };

    const blocked = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "blocked until credits exist" }),
    });
    expect(blocked.status).toBe(402);

    await applyCreditLedgerEntry(dbClient.db, {
      accountId,
      type: "credit_topup",
      amountMicros: 1_000_000,
      sourceType: "test",
      sourceId: "managed-credit-gate",
      idempotencyKey: `test-credit:${accountId}`,
    });

    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "allowed with credits" }),
    });
    expect(created.status).toBe(202);
    const session = (await created.json()) as { id: string };

    const usage = await app.request(
      `/v1/billing/usage?accountId=${accountId}&workspaceId=${workspaceId}`,
      { headers: authHeaders },
    );
    expect(usage.status).toBe(200);
    const usageBody = (await usage.json()) as {
      usage: Array<{ eventType: string; sourceResourceId: string }>;
    };
    expect(usageBody.usage).toContainEqual(
      expect.objectContaining({
        eventType: "agent_run.created",
        sourceResourceId: session.id,
      }),
    );
  });

  test("zero-credit attachment staging survives tenant checks, duplicate finalize, and a rejected turn", async () => {
    const delegationSecret = "test-zero-credit-file-staging-secret";
    const app = createApp({
      settings: {
        ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
        productAccessMode: "managed",
        usageLimitsMode: "managed",
        delegationSecret,
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      },
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const owner = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:zero-credit-file-owner",
      accountExternalId: crypto.randomUUID(),
      accountName: "Zero credit file owner",
      workspaceExternalSource: "test:zero-credit-file-owner",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Zero credit file workspace",
      subjectId: `test:zero-credit-file-owner:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const otherTenant = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:zero-credit-file-other",
      accountExternalId: crypto.randomUUID(),
      accountName: "Other file account",
      workspaceExternalSource: "test:zero-credit-file-other",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Other file workspace",
      subjectId: `test:zero-credit-file-other:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const ownerWorkspaceId = owner.defaultWorkspaceId!;
    const otherWorkspaceId = otherTenant.defaultWorkspaceId!;
    const ownerHeaders = {
      authorization: `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId: owner.defaultAccountId!,
        workspaceId: ownerWorkspaceId,
        subjectId: owner.subjectId,
        permissions: [...allAccountPermissions, ...allWorkspacePermissions],
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1000) + 60,
      })}`,
    };
    const otherHeaders = {
      authorization: `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId: otherTenant.defaultAccountId!,
        workspaceId: otherWorkspaceId,
        subjectId: otherTenant.subjectId,
        permissions: [...allAccountPermissions, ...allWorkspacePermissions],
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1000) + 60,
      })}`,
    };
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    // Storage staging is not an inference purchase: no credit entry exists for
    // this account, but prepare must issue a scoped signed PUT.
    const begin = await app.request(workspacePath(ownerWorkspaceId, "/files/uploads"), {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders },
      body: JSON.stringify({
        filename: "a very long screenshot name with spaces and _ punctuation.png",
        contentType: "image/png",
        sizeBytes: image.byteLength,
      }),
    });
    expect(begin.status).toBe(201);
    const upload = (await begin.json()) as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
    };

    // The upload id and asset are invisible outside their RLS workspace.
    const wrongTenantComplete = await app.request(
      workspacePath(otherWorkspaceId, `/files/uploads/${upload.uploadId}/complete`),
      { method: "POST", headers: otherHeaders },
    );
    expect(wrongTenantComplete.status).toBe(404);
    const wrongTenantRead = await app.request(
      workspacePath(otherWorkspaceId, `/files/${upload.fileId}`),
      { headers: otherHeaders },
    );
    expect(wrongTenantRead.status).toBe(404);

    const put = await fetch(upload.putUrl, {
      method: "PUT",
      body: image,
      headers: upload.requiredHeaders,
    });
    expect(put.ok).toBe(true);

    // Two tabs (or a lost response retry) must converge on the one ready asset.
    const complete = () =>
      app.request(workspacePath(ownerWorkspaceId, `/files/uploads/${upload.uploadId}/complete`), {
        method: "POST",
        headers: ownerHeaders,
      });
    const [firstComplete, secondComplete] = await Promise.all([complete(), complete()]);
    expect(firstComplete.status).toBe(200);
    expect(secondComplete.status).toBe(200);
    const firstFile = ((await firstComplete.json()) as { file: { id: string; status: string } })
      .file;
    const secondFile = ((await secondComplete.json()) as { file: { id: string; status: string } })
      .file;
    expect(firstFile).toMatchObject({ id: upload.fileId, status: "ready" });
    expect(secondFile).toEqual(firstFile);

    // A later model-turn admission still fails at zero balance, but cannot
    // delete or orphan the already-finalized attachment reference.
    const rejectedTurn = await app.request(workspacePath(ownerWorkspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders },
      body: JSON.stringify({
        initialMessage: "inspect this screenshot",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
    });
    expect(rejectedTurn.status).toBe(402);
    expect(await rejectedTurn.text()).toContain("insufficient OpenGeni credits");
    const preserved = await app.request(
      workspacePath(ownerWorkspaceId, `/files/${upload.fileId}`),
      {
        headers: ownerHeaders,
      },
    );
    expect(preserved.status).toBe(200);
    expect((await preserved.json()) as { status: string }).toMatchObject({
      status: "ready",
    });

    // Retrying after funds arrive attaches the same durable file rather than
    // creating another object or requiring a re-upload.
    await applyCreditLedgerEntry(dbClient.db, {
      accountId: owner.defaultAccountId!,
      type: "credit_topup",
      amountMicros: 1_000_000,
      sourceType: "test",
      sourceId: "zero-credit-file-retry",
      idempotencyKey: `test:zero-credit-file-retry:${owner.defaultAccountId!}`,
    });
    const retriedTurn = await app.request(workspacePath(ownerWorkspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders },
      body: JSON.stringify({
        initialMessage: "inspect this screenshot",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
    });
    expect(retriedTurn.status).toBe(202);
    expect((await retriedTurn.json()) as { resources: unknown[] }).toMatchObject({
      resources: [{ kind: "file", fileId: upload.fileId }],
    });
  });

  test("managed credit gate blocks document indexing before enqueueing work", async () => {
    const delegationSecret = "test-managed-document-credit-secret";
    const app = createApp({
      settings: {
        ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
        productAccessMode: "managed",
        billingMode: "stripe",
        delegationSecret,
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
      },
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      documentIndexer: {
        indexDocument: async () => {
          throw new Error("document indexer should not run without credits");
        },
      },
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-document-credit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Managed document credit test",
      workspaceExternalSource: "test:managed-document-credit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Managed document credit workspace",
      subjectId: `test:managed-document-credit:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: access.defaultAccountId!,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const headers = { authorization: `Bearer ${token}` };
    const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name: "No credit docs" }),
    });
    expect(baseResponse.status).toBe(201);
    const base = (await baseResponse.json()) as { id: string };

    const blocked = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents`),
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ fileId: crypto.randomUUID() }),
      },
    );
    expect(blocked.status).toBe(402);
    expect(await blocked.text()).toContain("insufficient OpenGeni credits");
  });

  test("managed credit gate allows schedule creation but blocks manual trigger without credits", async () => {
    const delegationSecret = "test-managed-schedule-credit-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        usageLimitsMode: "managed",
        delegationSecret,
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-schedule-credit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Managed schedule credit test",
      workspaceExternalSource: "test:managed-schedule-credit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Managed schedule credit workspace",
      subjectId: `test:managed-schedule-credit:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: access.defaultAccountId!,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const headers = { authorization: `Bearer ${token}` };

    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        name: "runs later",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const triggered = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`),
      {
        method: "POST",
        headers,
      },
    );
    expect(triggered.status).toBe(402);
    expect(await triggered.text()).toContain("insufficient OpenGeni credits");
  });

  test("static usage limits enforce operator caps without Better Auth or Stripe", async () => {
    const delegationSecret = "test-static-usage-limits-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({
          maxWorkspacesPerAccount: 1,
          maxApiKeysPerWorkspace: 1,
          maxMonthlyAgentRunsPerWorkspace: 1,
        }),
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:static-usage-limits",
      accountExternalId: crypto.randomUUID(),
      accountName: "Static limits test",
      workspaceExternalSource: "test:static-usage-limits",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Static limits workspace",
      subjectId: `test:static-usage-limits:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const accountId = access.defaultAccountId!;
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const authHeaders = { authorization: `Bearer ${token}` };

    expect((await app.request("/v1/access/me")).status).toBe(401);
    expect(
      (
        await app.request("/v1/access/me", {
          headers: { authorization: "Bearer invalid-token" },
        })
      ).status,
    ).toBe(401);

    const extraWorkspace = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ accountId, name: "extra workspace" }),
    });
    expect(extraWorkspace.status).toBe(429);

    const keyOne = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        name: "first key",
        permissions: ["workspace:read"],
      }),
    });
    expect(keyOne.status).toBe(201);
    const keyTwo = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        name: "second key",
        permissions: ["workspace:read"],
      }),
    });
    expect(keyTwo.status).toBe(429);

    const runOne = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "allowed first run" }),
    });
    expect(runOne.status).toBe(202);
    const runTwo = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "blocked second run" }),
    });
    expect(runTwo.status).toBe(429);
  });

  test("static monthly cost cap blocks costly actions once reached", async () => {
    const delegationSecret = "test-static-cost-limit-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({
          maxMonthlyCostMicrosPerAccount: 100,
        }),
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:static-cost-limit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Static cost limit test",
      workspaceExternalSource: "test:static-cost-limit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Static cost limit workspace",
      subjectId: `test:static-cost-limit:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const accountId = access.defaultAccountId!;
    await recordUsageEvent(dbClient.db, {
      accountId,
      workspaceId,
      eventType: "model.cost",
      quantity: 100,
      unit: "usd_micros",
      sourceResourceType: "test",
      sourceResourceId: "static-cost-limit",
      idempotencyKey: `test:model.cost:${accountId}:static-cost-limit`,
    });
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const blocked = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ initialMessage: "blocked by cost cap" }),
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("monthly model cost limit reached");
  });

  test("Stripe webhooks apply checkout, refund, and dispute ledger entries idempotently", async () => {
    const webhookSecret = "whsec_test_webhook_secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        billingMode: "stripe",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
        stripeWebhookSecret: webhookSecret,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:stripe-webhook",
      accountExternalId: crypto.randomUUID(),
      accountName: "Stripe webhook test",
      workspaceExternalSource: "test:stripe-webhook",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Stripe webhook workspace",
      subjectId: "test:stripe-webhook",
    });
    const accountId = context.defaultAccountId!;
    const metadata = {
      opengeni_account_id: accountId,
      opengeni_package_id: "topup_25",
      opengeni_credit_micros: "25000000",
      opengeni_credit_idempotency_key: `stripe:test:checkout:${accountId}`,
    };

    const checkout = await postStripeEvent(app, webhookSecret, {
      id: `evt_checkout_${crypto.randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_${crypto.randomUUID()}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_123",
          customer_email: "billing@example.com",
          customer_details: { email: "billing@example.com" },
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (checkout.status !== 200) {
      throw new Error(`checkout webhook failed: ${checkout.status} ${await checkout.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);

    await checkout.json();
    const duplicate = await postStripeEvent(app, webhookSecret, {
      id: `evt_checkout_duplicate_${crypto.randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_duplicate_${crypto.randomUUID()}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_123",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (duplicate.status !== 200) {
      throw new Error(
        `duplicate checkout webhook failed: ${duplicate.status} ${await duplicate.text()}`,
      );
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);

    const refund = await postStripeEvent(app, webhookSecret, {
      id: `evt_refund_${crypto.randomUUID()}`,
      object: "event",
      type: "refund.created",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "re_test_123",
          object: "refund",
          amount: 500,
          currency: "usd",
          status: "succeeded",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (refund.status !== 200) {
      throw new Error(`refund webhook failed: ${refund.status} ${await refund.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(20_000_000);

    const releaseWithoutHold = await postStripeEvent(app, webhookSecret, {
      id: `evt_dispute_release_without_hold_${crypto.randomUUID()}`,
      object: "event",
      type: "charge.dispute.funds_reinstated",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "dp_without_hold",
          object: "dispute",
          amount: 1000,
          currency: "usd",
          status: "won",
          charge: "ch_test_without_hold",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (releaseWithoutHold.status !== 200) {
      throw new Error(
        `dispute release without hold webhook failed: ${releaseWithoutHold.status} ${await releaseWithoutHold.text()}`,
      );
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(20_000_000);

    const disputeHold = await postStripeEvent(app, webhookSecret, {
      id: `evt_dispute_${crypto.randomUUID()}`,
      object: "event",
      type: "charge.dispute.created",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "dp_test_123",
          object: "dispute",
          amount: 1000,
          currency: "usd",
          status: "needs_response",
          charge: "ch_test_123",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (disputeHold.status !== 200) {
      throw new Error(
        `dispute hold webhook failed: ${disputeHold.status} ${await disputeHold.text()}`,
      );
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(10_000_000);

    const disputeRelease = await postStripeEvent(app, webhookSecret, {
      id: `evt_dispute_release_${crypto.randomUUID()}`,
      object: "event",
      type: "charge.dispute.closed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "dp_test_123",
          object: "dispute",
          amount: 1000,
          currency: "usd",
          status: "won",
          charge: "ch_test_123",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (disputeRelease.status !== 200) {
      throw new Error(
        `dispute release webhook failed: ${disputeRelease.status} ${await disputeRelease.text()}`,
      );
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(20_000_000);
  });

  test("Stripe webhook retry processes stored events that were not marked processed", async () => {
    const webhookSecret = "whsec_test_webhook_retry_secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        billingMode: "stripe",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
        stripeWebhookSecret: webhookSecret,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:stripe-webhook-retry",
      accountExternalId: crypto.randomUUID(),
      accountName: "Stripe webhook retry test",
      workspaceExternalSource: "test:stripe-webhook-retry",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Stripe webhook retry workspace",
      subjectId: "test:stripe-webhook-retry",
    });
    const accountId = context.defaultAccountId!;
    const event = {
      id: `evt_checkout_retry_${crypto.randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_retry_${crypto.randomUUID()}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_retry",
          customer_email: "retry@example.com",
          customer_details: { email: "retry@example.com" },
          payment_intent: "pi_test_retry",
          metadata: {
            opengeni_account_id: accountId,
            opengeni_package_id: "topup_25",
            opengeni_credit_micros: "25000000",
            opengeni_credit_idempotency_key: `stripe:test:checkout-retry:${accountId}`,
          },
        },
      },
    };
    await recordStripeWebhookEvent(dbClient.db, {
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      payload: event,
    });

    const retry = await postStripeEvent(app, webhookSecret, event);
    if (retry.status !== 200) {
      throw new Error(`retry checkout webhook failed: ${retry.status} ${await retry.text()}`);
    }
    expect(await retry.json()).toEqual({ received: true });
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);

    const duplicate = await postStripeEvent(app, webhookSecret, event);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, duplicate: true });
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);
  });

  test("rejects unknown MCP tool refs during session create", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "search docs",
        tools: [{ kind: "mcp", id: "docs" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("persists valid MCP tool refs on sessions", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: "http://127.0.0.1:8787/mcp",
            allowedTools: ["search_documents", "fetch_document"],
            cacheToolsList: false,
          },
        ],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "search docs",
        tools: [{ kind: "mcp", id: "docs" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    const session = (await response.json()) as { tools: unknown[] };
    expect(session.tools).toEqual([{ kind: "mcp", id: "docs" }]);
  });

  test("rejects removed one-turn MCP tool overrides without mutating the session", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: "http://127.0.0.1:8787/mcp",
            allowedTools: ["search_documents"],
            cacheToolsList: false,
          },
        ],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const before = await requireSession(dbClient.db, workspaceId, session.id);
    const turnsBefore = await listSessionTurns(dbClient.db, workspaceId, session.id);

    const rejected = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "search docs",
            tools: [{ kind: "mcp", id: "docs" }],
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      error: {
        status: 422,
        code: "validation_failed",
        message: "invalid session event",
        retryable: false,
      },
    });
    expect((await requireSession(dbClient.db, workspaceId, session.id)).tools).toEqual(
      before.tools,
    );
    expect(await listSessionTurns(dbClient.db, workspaceId, session.id)).toHaveLength(
      turnsBefore.length,
    );
  });

  test("revives a failed session on a new user message but keeps cancelled terminal", async () => {
    const workflowClient = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    // A failed manager channel must answer when spoken to: the message is
    // accepted, the session transitions failed -> queued (stale active turn
    // cleared), the status change is on the timeline, and the workflow is
    // woken via signalWithStart exactly as for idle sessions.
    await setSessionStatus(dbClient.db, workspaceId, session.id, "failed", null);
    const wakeupsBefore = workflowClient.wakeups.length;
    const revived = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "are you still there?" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(revived.status).toBe(202);
    const afterRevival = await requireSession(dbClient.db, workspaceId, session.id);
    expect(afterRevival.status).toBe("queued");
    expect(afterRevival.activeTurnId).toBeNull();
    expect(workflowClient.wakeups.length).toBe(wakeupsBefore + 1);
    const events = await listSessionEvents(dbClient.db, workspaceId, session.id, 0, 100);
    const statusChanges = events.filter((event) => event.type === "session.status.changed");
    expect((statusChanges.at(-1)?.payload as { status?: string } | undefined)?.status).toBe(
      "queued",
    );

    // Cancelled stays terminal: an explicit user act, not a failure.
    await setSessionStatus(dbClient.db, workspaceId, session.id, "cancelled", null);
    const rejected = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "hello?" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(rejected.status).toBe(409);
  });

  test("queues model settings on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "hello",
        model: "scripted-model",
        reasoningEffort: "low",
      }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);

    const accepted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "use a stronger model",
            model: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(accepted.status).toBe(202);
    const event = (await accepted.json()) as SessionEvent;
    expect(event.payload).toEqual({
      text: "use a stronger model",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      delivery: "send",
      routing: "queued_for_execution",
      initiator: { kind: "subject", subjectId: "dev", label: "Local dev" },
    });
    const turns = await listSessionTurns(dbClient.db, workspaceId, session.id);
    const turn = turns.find((item) => item.triggerEventId === event.id);
    expect(turn?.model).toBe("gpt-5.6-sol");
    expect(turn?.reasoningEffort).toBe("xhigh");
  });

  test("keeps a committed follow-up accepted and metered when immediate workflow wake fails", async () => {
    const failingWorkflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: failingWorkflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    failingWorkflow.wakeError = new Error("temporal wake unavailable");
    const before = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });

    const accepted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "this wake fails" },
        }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(accepted.status).toBe(202);
    const after = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    expect(after).toBe(before + 1);
  });

  test("returns a committed prompt before replayable fanout and wake work runs", async () => {
    class FailingPromptBus extends MemoryEventBus {
      fail = false;
      private publishGate: Promise<void> | null = null;
      private releasePublishGate: (() => void) | null = null;

      holdPublishes(): void {
        this.publishGate = new Promise<void>((resolve) => {
          this.releasePublishGate = resolve;
        });
      }

      releasePublishes(): void {
        this.releasePublishGate?.();
        this.releasePublishGate = null;
        this.publishGate = null;
      }

      override async publish(
        workspaceId: string,
        sessionId: string,
        events: SessionEvent[],
      ): Promise<void> {
        await this.publishGate;
        if (this.fail) throw new Error("nats unavailable");
        await super.publish(workspaceId, sessionId, events);
      }
    }
    const bus = new FailingPromptBus();
    const workflowClient = new FakeWorkflowClient();
    const postCommitTasks: Array<() => Promise<void>> = [];
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus,
      workflowClient,
      schedulePromptPostCommit: (task) => postCommitTasks.push(task),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const publishedBefore = bus.published.length;
    const wakeupsBefore = workflowClient.wakeups.length;
    const usageBefore = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });

    const response = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          clientEventId: "prompt-response-boundary",
          payload: { text: "commit before fanout" },
        }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(response.status).toBe(202);
    expect(postCommitTasks).toHaveLength(1);
    expect(bus.published).toHaveLength(publishedBefore);
    expect(workflowClient.wakeups).toHaveLength(wakeupsBefore);
    const accepted = (await response.json()) as SessionEvent;
    expect(accepted).toMatchObject({
      type: "user.message",
      clientEventId: "prompt-response-boundary",
    });
    const durableEvents = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(durableEvents.some((event) => event.id === accepted.id)).toBe(true);
    expect(
      await sumUsageQuantity(dbClient.db, {
        workspaceId,
        eventType: "agent_run.created",
        since: startOfUtcMonth(),
      }),
    ).toBe(usageBefore + 1);

    const pausedResponse = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/control`),
      {
        method: "POST",
        body: JSON.stringify({
          action: "pause",
          clientEventId: "pause-response-boundary",
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(pausedResponse.status).toBe(200);
    expect(await pausedResponse.json()).toMatchObject({
      effectiveControl: { state: "paused" },
    });
    expect(postCommitTasks).toHaveLength(2);
    expect(bus.published).toHaveLength(publishedBefore);

    const queueResponse = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/queue`),
    );
    expect(queueResponse.status).toBe(200);
    const queue = (await queueResponse.json()) as {
      version: number;
      items: Array<{ id: string; version: number }>;
    };
    const queuedTurnId = queue.items[0]?.id;
    if (!queuedTurnId) throw new Error("committed prompt did not create a queue row");
    const movedResponse = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/queue/${queuedTurnId}/move`),
      {
        method: "POST",
        body: JSON.stringify({
          clientEventId: "queue-response-boundary",
          expectedQueueVersion: queue.version,
          beforeTurnId: null,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(movedResponse.status).toBe(200);
    expect(postCommitTasks).toHaveLength(3);
    expect(bus.published).toHaveLength(publishedBefore);
    expect(workflowClient.wakeups).toHaveLength(wakeupsBefore);

    const steeredResponse = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/queue/${queuedTurnId}/steer`),
      {
        method: "POST",
        body: JSON.stringify({
          clientEventId: "queue-steer-response-boundary",
          expectedTurnVersion: queue.items[0]!.version,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(steeredResponse.status).toBe(200);
    expect(postCommitTasks).toHaveLength(4);
    expect(workflowClient.wakeups).toHaveLength(wakeupsBefore);

    bus.holdPublishes();
    workflowClient.wakeError = new Error("temporal unavailable");
    const postCommitExecution = Promise.all(postCommitTasks.map(async (task) => await task()));
    await waitFor(() => workflowClient.wakeups.length === wakeupsBefore + 2);
    bus.fail = true;
    bus.releasePublishes();
    await expect(postCommitExecution).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(workflowClient.wakeups).toHaveLength(wakeupsBefore + 2);
  });

  test("rejects concurrent removed one-turn tool overrides without partial mutation", async () => {
    const mcpServers = Array.from({ length: 12 }, (_, index) => ({
      id: `docs-${index}`,
      name: `Docs ${index}`,
      url: `http://127.0.0.1:${8787 + index}/mcp`,
      allowedTools: ["search_documents"],
      cacheToolsList: false,
    }));
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const before = await requireSession(dbClient.db, workspaceId, session.id);
    const turnsBefore = await listSessionTurns(dbClient.db, workspaceId, session.id);

    const responses = await Promise.all(
      mcpServers.map((server) =>
        app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
          method: "POST",
          body: JSON.stringify({
            type: "user.message",
            payload: {
              text: `search ${server.id}`,
              tools: [{ kind: "mcp", id: server.id }],
            },
          }),
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    expect(responses.every((response) => response.status === 422)).toBe(true);
    expect(
      (await Promise.all(responses.map((response) => response.json()))).every(
        (body) => (body as { error?: { code?: string } }).error?.code === "validation_failed",
      ),
    ).toBe(true);
    expect((await requireSession(dbClient.db, workspaceId, session.id)).tools).toEqual(
      before.tools,
    );
    expect(await listSessionTurns(dbClient.db, workspaceId, session.id)).toHaveLength(
      turnsBefore.length,
    );
  });

  test("rejects unknown MCP tool refs on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const rejected = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "search docs",
            tools: [{ kind: "mcp", id: "docs" }],
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      error: {
        status: 422,
        code: "validation_failed",
        message: "invalid session event",
        retryable: false,
      },
    });
  });

  test("returns client model and reasoning config", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/config/client");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      deploymentRevision: string;
      defaultModel: string;
      allowedReasoningEfforts: string[];
      fileUploads: { enabled: boolean; maxSizeBytes: number };
    };
    expect(payload.deploymentRevision).toBe("dev");
    expect(payload.defaultModel).toBe("scripted-model");
    expect(payload.allowedReasoningEfforts).toContain("high");
    expect(payload.fileUploads).toEqual({
      enabled: false,
      maxSizeBytes: 5_000_000_000,
    });
  });

  test("catalog exposes workspace-template API paths and default MCP capability tools", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const context = await defaultAccessContext(app);
    const capabilityId = `mcp:test-${crypto.randomUUID()}`;
    await upsertCapabilityCatalogItem(dbClient.db, {
      accountId: context.defaultAccountId!,
      workspaceId,
      id: capabilityId,
      kind: "mcp",
      source: "manual",
      name: "Route MCP",
      endpointUrl: "https://example.com/mcp",
      metadata: { mcpServerId: "cap-route-mcp" },
    });
    await enableCapabilityInstallation(dbClient.db, {
      accountId: context.defaultAccountId!,
      workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: {
        mcpConnectivity: {
          status: "ok",
          checkedAt: new Date().toISOString(),
          toolCount: 1,
        },
      },
    });

    const catalogResponse = await app.request(workspacePath(workspaceId, "/capabilities"));
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as {
      items: Array<{
        id: string;
        metadata: Record<string, unknown>;
        runtime: { mcpServerId?: string };
        enabled: boolean;
      }>;
    };
    const apiPaths = Object.fromEntries(
      catalog.items
        .filter((item) => item.id.startsWith("api:"))
        .map((item) => [item.id, item.metadata.endpointPath]),
    );
    expect(apiPaths).toEqual({
      "api:x": undefined,
      "api:reddit": undefined,
    });
    expect(catalog.items.find((item) => item.id === capabilityId)).toMatchObject({
      enabled: true,
      runtime: { mcpServerId: "cap-route-mcp" },
    });

    const omittedTools = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "default tools" }),
      headers: { "content-type": "application/json" },
    });
    expect(omittedTools.status).toBe(202);
    const omittedSession = (await omittedTools.json()) as { id: string };
    expect(
      (await requireSession(dbClient.db, workspaceId, omittedSession.id)).tools,
    ).toContainEqual({ kind: "mcp", id: "cap-route-mcp", optional: true });

    const explicitEmptyTools = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "no tools", tools: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(explicitEmptyTools.status).toBe(202);
    const explicitEmptySession = (await explicitEmptyTools.json()) as {
      id: string;
    };
    expect((await requireSession(dbClient.db, workspaceId, explicitEmptySession.id)).tools).toEqual(
      [],
    );

    // Scheduled tasks mirror sessions: an absent agentConfig.tools key means
    // "give me the workspace's enabled capability MCP servers", an explicit
    // list (even empty) is taken verbatim. Without this, a task created
    // toolless runs with no MCP servers at all (live customer-one lesson:
    // maintenance tasks that cannot reach the workspace notebook MCP).
    const omittedTaskResponse = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "default tools task",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "sweep" },
      }),
    });
    expect(omittedTaskResponse.status).toBe(201);
    const omittedTask = (await omittedTaskResponse.json()) as {
      id: string;
      agentConfig: { tools: unknown[] };
    };
    expect(omittedTask.agentConfig.tools).toContainEqual({
      kind: "mcp",
      id: "cap-route-mcp",
      optional: true,
    });

    const explicitEmptyTaskResponse = await app.request(
      workspacePath(workspaceId, "/scheduled-tasks"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "explicit empty tools task",
          schedule: { type: "interval", everySeconds: 3600 },
          agentConfig: { prompt: "sweep", tools: [] },
        }),
      },
    );
    expect(explicitEmptyTaskResponse.status).toBe(201);
    const explicitEmptyTask = (await explicitEmptyTaskResponse.json()) as {
      id: string;
      agentConfig: { tools: unknown[] };
    };
    expect(explicitEmptyTask.agentConfig.tools).toEqual([]);

    // Updates follow the same contract when agentConfig is replaced.
    const patchedDefault = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${explicitEmptyTask.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentConfig: { prompt: "sweep again" } }),
      },
    );
    expect(patchedDefault.status).toBe(200);
    expect(
      ((await patchedDefault.json()) as { agentConfig: { tools: unknown[] } }).agentConfig.tools,
    ).toContainEqual({ kind: "mcp", id: "cap-route-mcp", optional: true });
    const patchedExplicit = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${omittedTask.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentConfig: { prompt: "sweep verbatim", tools: [] },
        }),
      },
    );
    expect(patchedExplicit.status).toBe(200);
    expect(
      ((await patchedExplicit.json()) as { agentConfig: { tools: unknown[] } }).agentConfig.tools,
    ).toEqual([]);
    await dbClient.db.execute(dbSql`
      update capability_installations
      set status = 'disabled', updated_at = now()
      where workspace_id = ${workspaceId} and capability_id = ${capabilityId}
    `);
  });

  test("enables a credential-header MCP capability end to end with encrypted storage", async () => {
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      environmentsEncryptionKey: Buffer.from(encryptionKey).toString("base64"),
    });
    const app = createApp({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const context = await defaultAccessContext(app);
    const bearer = `Bearer secure-${crypto.randomUUID()}`;
    const mcp = startTestMcpServer({ requiredAuthorization: bearer });
    const capabilityId = `mcp:secure-test-${crypto.randomUUID()}`;
    const mcpServerId = `cap-secure-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await upsertCapabilityCatalogItem(dbClient.db, {
        accountId: context.defaultAccountId!,
        workspaceId,
        id: capabilityId,
        kind: "mcp",
        source: "manual",
        name: "Secure Test MCP",
        endpointUrl: mcp.url,
        authModel: "credential_ref",
        metadata: { mcpServerId, requiredHeaders: ["Authorization"] },
      });

      // Without the declared credential header the enable is rejected up front.
      const withoutHeaders = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        },
      );
      expect(withoutHeaders.status).toBe(422);
      expect(await withoutHeaders.text()).toContain("requires credential header(s) Authorization");

      // A wrong credential fails the live probe (the test MCP returns 401).
      const wrongHeaders = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({ headers: { Authorization: "Bearer wrong" } }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(wrongHeaders.status).toBe(422);
      expect(await wrongHeaders.text()).toContain("could not be enabled");

      // Header values must be valid HTTP field values (RFC 9110): control
      // characters beyond CR/LF are rejected too.
      const controlChars = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({
            headers: { Authorization: "Bearer bad\u0007value" },
          }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(controlChars.status).toBe(422);
      expect(await controlChars.text()).toContain("forbidden control characters");

      const enabled = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({
            headers: { Authorization: bearer },
            // Reserved keys in caller config must be stripped, never stored —
            // a plaintext config.headers map must not bypass encryption.
            config: {
              headers: { Authorization: "plaintext-bypass" },
              headersEncrypted: "spoofed",
              note: "kept",
            },
          }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(enabled.status).toBe(201);
      const enabledBody = await enabled.text();
      // The API response exposes header names only — never the credential.
      expect(enabledBody).not.toContain(bearer);
      expect(enabledBody).not.toContain("plaintext-bypass");
      const installation = JSON.parse(enabledBody) as {
        config: Record<string, unknown>;
        metadata: Record<string, unknown>;
      };
      expect(installation.config.headerNames).toEqual(["Authorization"]);
      expect(installation.config.headersEncrypted).toBeUndefined();
      expect(installation.config.headers).toBeUndefined();
      expect(installation.config.note).toBe("kept");
      expect(installation.metadata.mcpConnectivity).toMatchObject({
        status: "ok",
      });

      // The stored value is AES-GCM ciphertext that decrypts back to the credential.
      const [row] = (await dbClient.db.execute(dbSql`
        select config from capability_installations
        where workspace_id = ${workspaceId} and capability_id = ${capabilityId}
      `)) as Array<{ config: { headersEncrypted: Record<string, string> } }>;
      const storedCiphertext = row!.config.headersEncrypted.Authorization!;
      expect(storedCiphertext.startsWith("v2:")).toBe(true);
      expect(decryptEnvironmentValue(encryptionKey, storedCiphertext)).toBe(bearer);

      // The catalog reports the capability enabled and runtime-ready.
      const catalogResponse = await app.request(workspacePath(workspaceId, "/capabilities"));
      const catalog = (await catalogResponse.json()) as {
        items: Array<{
          id: string;
          enabled: boolean;
          runtime: { available: boolean; mcpServerId?: string };
        }>;
      };
      expect(catalog.items.find((item) => item.id === capabilityId)).toMatchObject({
        enabled: true,
        runtime: { available: true, mcpServerId },
      });

      // The worker-side merge decrypts the headers for the runtime MCP client,
      // and the runtime can list tools against the credentialed server.
      const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
        dbClient.db,
        workspaceId,
        settings,
      );
      const merged = runtimeSettings.mcpServers.find((server) => server.id === mcpServerId);
      expect(merged?.headers).toEqual({ Authorization: bearer });
      const prepared = await prepareAgentTools(runtimeSettings, [{ kind: "mcp", id: mcpServerId }]);
      try {
        const tools = await prepared.mcpServers[0]!.listTools();
        expect(tools.map((tool) => tool.name)).toContain(`${mcpServerId}__search_documents`);
      } finally {
        await prepared.close();
      }

      // Re-enabling without headers reuses the stored credentials (probe still passes).
      const reEnabled = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        },
      );
      expect(reEnabled.status).toBe(201);
      const reEnabledInstallation = (await reEnabled.json()) as {
        config: Record<string, unknown>;
      };
      expect(reEnabledInstallation.config.headerNames).toEqual(["Authorization"]);
    } finally {
      mcp.close();
      await dbClient.db.execute(dbSql`
        update capability_installations
        set status = 'disabled', updated_at = now()
        where workspace_id = ${workspaceId} and capability_id = ${capabilityId}
      `);
    }
  });

  test("broker-authenticates a connectionRef MCP capability through the worker settings overlay", async () => {
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      environmentsEncryptionKey: Buffer.from(encryptionKey).toString("base64"),
    });
    const app = createApp({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const bearer = `Bearer broker-${crypto.randomUUID()}`;
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: bearer },
    });
    const providerDomain = new URL(mcp.url).hostname;
    const capabilityId = `mcp:i1accept-${crypto.randomUUID()}`;
    const mcpServerId = "i1accept";
    try {
      const createdCapability = await app.request(workspacePath(workspaceId, "/capabilities"), {
        method: "POST",
        body: JSON.stringify({
          id: capabilityId,
          kind: "mcp",
          source: "manual",
          name: "I1 Acceptance MCP",
          endpointUrl: mcp.url,
          authModel: "api_key",
          metadata: { mcpServerId },
        }),
        headers: { "content-type": "application/json" },
      });
      expect(createdCapability.status).toBe(201);

      const createdConnection = await app.request(workspacePath(workspaceId, "/connections"), {
        method: "POST",
        body: JSON.stringify({
          providerDomain,
          kind: "api_key",
          credential: { headers: { authorization: bearer } },
          metadata: { label: "I1 acceptance key" },
        }),
        headers: { "content-type": "application/json" },
      });
      expect(createdConnection.status).toBe(201);
      const { connection } = (await createdConnection.json()) as {
        connection: { id: string };
      };

      const enabled = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({
            connectionRef: {
              connectionId: connection.id,
              providerDomain,
              kind: "api_key",
            },
          }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(enabled.status).toBe(201);
      const installation = (await enabled.json()) as {
        config: Record<string, unknown>;
        metadata: Record<string, unknown>;
      };
      expect(installation.config.connectionRef).toMatchObject({
        connectionId: connection.id,
        providerDomain,
        kind: "api_key",
        subjectScope: "workspace",
      });
      expect(installation.metadata.mcpConnectivity).toMatchObject({
        status: "auth_deferred",
      });

      const createdSession = await app.request(workspacePath(workspaceId, "/sessions"), {
        method: "POST",
        body: JSON.stringify({
          initialMessage: "use the acceptance MCP",
          model: "scripted-model",
          tools: [{ kind: "mcp", id: mcpServerId }],
        }),
        headers: { "content-type": "application/json" },
      });
      expect(createdSession.status).toBe(202);
      const session = (await createdSession.json()) as {
        id: string;
        tools: Array<{ kind: string; id: string }>;
      };
      expect(session.tools).toContainEqual({ kind: "mcp", id: mcpServerId });

      const mcpSettings = await settingsWithEnabledCapabilityMcpServers(
        dbClient.db,
        workspaceId,
        settings,
      );
      const capabilitySettings = await settingsWithCodexCredential(
        dbClient.db,
        workspaceId,
        mcpSettings,
        false,
      );
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(dbClient.db, workspaceId, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: `dispatch-${crypto.randomUUID()}`,
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") {
        throw new Error(`failed to claim connectionRef fixture: ${claimed.reason}`);
      }
      const runSettings = await settingsWithSessionMcpServersForRun(
        dbClient.db,
        workspaceId,
        session.id,
        attemptId,
        capabilitySettings,
      );
      const resolveCredential = buildConnectionTokenResolver(dbClient.db, runSettings);
      const prepared = await prepareAgentTools(runSettings, [{ kind: "mcp", id: mcpServerId }], {
        workspaceId,
        sessionId: session.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
        subjectId: "worker:first-party-mcp",
        resolveCredential,
      });
      try {
        const merged = runSettings.mcpServers.find((server) => server.id === mcpServerId);
        expect(merged?.connectionRef).toMatchObject({
          connectionId: connection.id,
          providerDomain,
          kind: "api_key",
          subjectScope: "workspace",
        });
        const tools = await prepared.mcpServers[0]!.listTools();
        expect(tools.map((tool) => tool.name)).toContain(`${mcpServerId}__search_documents`);
        const result = await prepared.mcpServers[0]!.callTool(`${mcpServerId}__search_documents`, {
          query: "broker",
        });
        expect(JSON.stringify(result)).toContain("found document for broker");
      } finally {
        await prepared.close();
      }
    } finally {
      mcp.close();
      await dbClient.db.execute(dbSql`
        update capability_installations
        set status = 'disabled', updated_at = now()
        where workspace_id = ${workspaceId} and capability_id = ${capabilityId}
      `);
    }
  });

  test("returns 409 when disabling a never-enabled capability", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const capabilityId = `custom-mcp:test-${crypto.randomUUID()}`;
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/capabilities"), {
      method: "POST",
      body: JSON.stringify({
        id: capabilityId,
        kind: "mcp",
        source: "manual",
        name: "Test MCP",
        category: "test",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);

    const disabled = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/disable`),
      { method: "POST" },
    );
    expect(disabled.status).toBe(409);
    expect(await disabled.text()).toContain("capability is not currently enabled");
  });

  test("enforces shared-key auth on user-facing routes when enabled", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        authRequired: true,
        accessKey: "local-test-key",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });

    const config = await app.request("/v1/config/client");
    expect(config.status).toBe(200);
    expect(((await config.json()) as { auth: { mode: string } }).auth.mode).toBe("deploymentKey");

    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/metrics")).status).toBe(401);
    const authHeaders = { "x-opengeni-access-key": "local-test-key" };
    const workspaceId = await defaultWorkspaceId(app, authHeaders);
    expect(
      (
        await app.request(workspacePath(workspaceId, "/sessions"), {
          method: "POST",
          body: JSON.stringify({ initialMessage: "blocked" }),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(401);

    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "allowed" }),
      headers: {
        "content-type": "application/json",
        "x-opengeni-access-key": "local-test-key",
      },
    });
    expect(created.status).toBe(202);
  });

  test("can explicitly allow unauthenticated metrics for internal scrapers", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        authRequired: true,
        accessKey: "local-test-key",
        authAllowMetrics: true,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });

    // opengeni_http_requests_total is recorded after the response for each
    // request finishes, so a fresh app's very first request (this /metrics
    // scrape itself) can never see its own count. Warm the counter with a
    // prior request first, same as any real deployment's traffic would.
    await app.request("/healthz");
    const response = await app.request("/metrics");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("opengeni_http_requests_total");
  });

  test("creates and manages scheduled tasks", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "hourly",
        schedule: { type: "interval", everySeconds: 3600 },
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as {
      id: string;
      temporalScheduleId: string;
    };
    expect(task.temporalScheduleId).toBe(`scheduled-task-${task.id}`);
    expect(workflow.synced).toHaveLength(1);

    const paused = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/pause`),
      { method: "POST" },
    );
    expect(paused.status).toBe(200);
    expect(workflow.synced).toHaveLength(2);

    const firedBefore = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "scheduled_task.fired",
      since: startOfUtcMonth(),
    });
    const agentRunsBefore = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    const triggered = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`),
      { method: "POST" },
    );
    expect(triggered.status).toBe(202);
    expect(workflow.triggers).toHaveLength(1);
    expect(
      (workflow.triggers[0] as { task?: { id?: string; workspaceId?: string } }).task,
    ).toMatchObject({
      id: task.id,
      workspaceId,
    });
    const firedAfter = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "scheduled_task.fired",
      since: startOfUtcMonth(),
    });
    expect(firedAfter).toBe(firedBefore);
    const agentRunsAfter = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    expect(agentRunsAfter).toBe(agentRunsBefore + 1);

    const listed = await app.request(workspacePath(workspaceId, "/scheduled-tasks"));
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as Array<{ id: string }>).some((item) => item.id === task.id),
    ).toBe(true);
  });

  test("a retried manual trigger (same triggerId) charges once and starts one run", async () => {
    const workflowClient = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "idempotent",
        schedule: { type: "interval", everySeconds: 3600 },
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const triggerWith = async (triggerId: string) =>
      await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`), {
        method: "POST",
        body: JSON.stringify({ triggerId }),
        headers: { "content-type": "application/json" },
      });

    // The client retries the SAME logical trigger (a network blip re-POSTs with
    // the same idempotency token). Both reach the handler.
    const first = await triggerWith("retry-token-1");
    const second = await triggerWith("retry-token-1");
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    // Both calls derive the SAME usage idempotency key AND the SAME workflowId
    // from the shared token, so the charge dedupes and the duplicate workflow
    // start collapses (deterministic id + REJECT_DUPLICATE at the worker).
    const triggers = workflowClient.triggers as Array<{
      agentRunUsageIdempotencyKey?: string;
      triggerWorkflowId?: string;
    }>;
    expect(triggers).toHaveLength(2);
    expect(triggers[0]?.agentRunUsageIdempotencyKey).toBe(triggers[1]?.agentRunUsageIdempotencyKey);
    expect(triggers[0]?.triggerWorkflowId).toBe(triggers[1]?.triggerWorkflowId);
    expect(triggers[0]?.agentRunUsageIdempotencyKey).toContain("retry-token-1");
    expect(triggers[0]?.triggerWorkflowId).toContain("retry-token-1");

    // Exactly ONE agent_run.created usage row exists for this token despite two
    // POSTs (idempotency-key dedup in recordWorkspaceUsage).
    const usage = await listUsageEvents(dbClient.db, {
      accountId: (await getScheduledTask(dbClient.db, workspaceId, task.id))!.accountId,
      workspaceId,
    });
    const charged = usage.filter(
      (event) => event.idempotencyKey === triggers[0]?.agentRunUsageIdempotencyKey,
    );
    expect(charged).toHaveLength(1);

    // A DIFFERENT token is a genuinely distinct trigger: new key, new run, a
    // second charge.
    const third = await triggerWith("retry-token-2");
    expect(third.status).toBe(202);
    const allTriggers = workflowClient.triggers as Array<{
      agentRunUsageIdempotencyKey?: string;
      triggerWorkflowId?: string;
    }>;
    expect(allTriggers[2]?.agentRunUsageIdempotencyKey).not.toBe(
      triggers[0]?.agentRunUsageIdempotencyKey,
    );
    expect(allTriggers[2]?.triggerWorkflowId).not.toBe(triggers[0]?.triggerWorkflowId);
  });

  test("a manual trigger without a triggerId stays a distinct run each time", async () => {
    const workflowClient = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "anon-trigger",
        schedule: { type: "interval", everySeconds: 3600 },
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    const task = (await created.json()) as { id: string };

    // A bare POST (no body) is still a valid, distinct trigger.
    const a = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`), {
      method: "POST",
    });
    const b = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`), {
      method: "POST",
    });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const triggers = workflowClient.triggers as Array<{
      agentRunUsageIdempotencyKey?: string;
      triggerWorkflowId?: string;
    }>;
    expect(triggers[0]?.agentRunUsageIdempotencyKey).not.toBe(
      triggers[1]?.agentRunUsageIdempotencyKey,
    );
    expect(triggers[0]?.triggerWorkflowId).not.toBe(triggers[1]?.triggerWorkflowId);
  });

  test("does not record manual scheduled trigger usage when workflow start fails", async () => {
    workflow = new FakeWorkflowClient();
    workflow.triggerError = new Error("temporal trigger unavailable");
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "Manual trigger failure",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };
    const before = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });

    const failed = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`),
      { method: "POST" },
    );

    expect(failed.status).toBe(500);
    const after = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    expect(after).toBe(before);
  });

  test("creates marketing social scheduled tasks from connected accounts only", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: firstPartyMcpSettings(services.databaseUrl),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const suffix = crypto.randomUUID();
    const workspaceId = await defaultWorkspaceId(app);

    const enabled = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(enabled.status).toBeLessThan(300);

    const activeResponse = await app.request(workspacePath(workspaceId, "/social/connections"), {
      method: "POST",
      body: JSON.stringify({
        provider: "linkedin",
        accountHandle: `active-${suffix}`,
        accountName: "Active Company",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(activeResponse.status).toBe(201);
    const activeConnection = (await activeResponse.json()) as { id: string };

    const disabledResponse = await app.request(workspacePath(workspaceId, "/social/connections"), {
      method: "POST",
      body: JSON.stringify({
        provider: "linkedin",
        accountHandle: `disabled-${suffix}`,
        accountName: "Disabled Company",
        status: "disabled",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(disabledResponse.status).toBe(201);
    const disabledConnection = (await disabledResponse.json()) as {
      id: string;
    };

    const created = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/scheduled-tasks"),
      {
        method: "POST",
        body: JSON.stringify({
          connectionIds: [],
          documentBaseIds: [],
          timeZone: "UTC",
          hour: 9,
          minute: 0,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(201);
    const task = JSON.parse(createdBody) as {
      metadata: Record<string, unknown>;
      agentConfig: { metadata: Record<string, unknown> };
    };
    expect(task.metadata.socialConnectionIds).toEqual([activeConnection.id]);
    expect(task.agentConfig.metadata.socialConnectionIds).toEqual([activeConnection.id]);
    expect(task.metadata.socialConnectionIds).not.toContain(disabledConnection.id);
    expect(workflow.synced).toHaveLength(1);
  });

  test("registers workspace packs from manifests and installs them", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const packId = `infra-test-${crypto.randomUUID().slice(0, 8)}`;
    const manifest = {
      id: packId,
      name: "Infra test pack",
      description: "Registered from a manifest payload in tests.",
      role: "infrastructure",
      category: "deployment",
      version: "0.1.0",
      scheduledTaskTemplates: [
        {
          id: "drift-daily",
          name: "Daily drift check",
          description: "Compare expected state against live state.",
          defaultSchedule: {
            type: "calendar",
            timeZone: "UTC",
            hour: 6,
            minute: 0,
          },
          defaultRunMode: "new_session_per_run",
          defaultOverlapPolicy: "skip",
          prompt: "Run the daily drift check.",
        },
      ],
      environment: {
        description: "Cloud credentials for substrate work.",
        requiredVariables: ["CLOUD_TOKEN"],
        required: true,
      },
    };

    const registered = await app.request(workspacePath(workspaceId, "/packs"), {
      method: "POST",
      body: JSON.stringify(manifest),
      headers: { "content-type": "application/json" },
    });
    expect(registered.status).toBe(201);
    const registeredBody = (await registered.json()) as {
      pack: { id: string; scheduledTaskTemplates: Array<{ prompt?: string }> };
    };
    expect(registeredBody.pack.id).toBe(packId);
    expect(registeredBody.pack.scheduledTaskTemplates[0]?.prompt).toBe(
      "Run the daily drift check.",
    );

    const replaced = await app.request(workspacePath(workspaceId, "/packs"), {
      method: "POST",
      body: JSON.stringify({ ...manifest, version: "0.1.1" }),
      headers: { "content-type": "application/json" },
    });
    expect(replaced.status).toBe(200);

    const builtInCollision = await app.request(workspacePath(workspaceId, "/packs"), {
      method: "POST",
      body: JSON.stringify({
        ...manifest,
        id: "marketing-social-daily-analysis",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(builtInCollision.status).toBe(409);

    const listed = await app.request(workspacePath(workspaceId, "/packs"));
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      packs: Array<{ id: string; version: string }>;
    };
    expect(listedBody.packs.map((pack) => pack.id)).toContain(packId);
    expect(listedBody.packs.find((pack) => pack.id === packId)?.version).toBe("0.1.1");

    const enabledWithoutEnvironment = await app.request(
      workspacePath(workspaceId, `/packs/${packId}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(enabledWithoutEnvironment.status).toBe(422);

    const environmentResponse = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      body: JSON.stringify({
        name: `cloud-${crypto.randomUUID().slice(0, 8)}`,
        variables: [{ name: "OTHER_TOKEN", value: "value-1" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(environmentResponse.status).toBe(201);
    const environment = (await environmentResponse.json()) as { id: string };

    const enabledMissingVariable = await app.request(
      workspacePath(workspaceId, `/packs/${packId}/enable`),
      {
        method: "POST",
        body: JSON.stringify({ environmentId: environment.id }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(enabledMissingVariable.status).toBe(422);
    expect(await enabledMissingVariable.text()).toContain("CLOUD_TOKEN");

    const genericPackEnable = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packId}`)}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(genericPackEnable.status).toBe(409);
    expect(await genericPackEnable.text()).toContain("Pack installation preview flow");

    const setVariable = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}/variables/CLOUD_TOKEN`),
      {
        method: "PUT",
        body: JSON.stringify({ value: "cloud-token-value" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(setVariable.status).toBeLessThan(300);

    const enabled = await app.request(workspacePath(workspaceId, `/packs/${packId}/enable`), {
      method: "POST",
      body: JSON.stringify({ environmentId: environment.id }),
      headers: { "content-type": "application/json" },
    });
    expect(enabled.status).toBe(201);
    const installation = (await enabled.json()) as {
      status: string;
      metadata: Record<string, unknown>;
    };
    expect(installation.status).toBe("active");
    expect(installation.metadata.packVersion).toBe("0.1.1");
    expect(installation.metadata.variableSetId).toBe(environment.id);

    const catalogResponse = await app.request(workspacePath(workspaceId, "/capabilities"));
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as {
      items: Array<{
        id: string;
        kind: string;
        source: string;
        enabled: boolean;
      }>;
    };
    expect(catalog.items.find((item) => item.id === `pack:${packId}`)).toMatchObject({
      kind: "pack",
      source: "manual",
      enabled: true,
    });

    // Pack lifecycle remains owned by the dedicated Pack route even after the
    // Pack is active; the generic capability path cannot mutate the install.
    const capabilityEnable = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packId}`)}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(capabilityEnable.status).toBe(409);
    expect(await capabilityEnable.text()).toContain("Pack installation preview flow");
    const installationAfterCapabilityEnable = await getPackInstallation(
      dbClient.db,
      workspaceId,
      packId,
    );
    expect(installationAfterCapabilityEnable?.metadata.variableSetId).toBe(environment.id);

    const deletedBuiltIn = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis"),
      { method: "DELETE" },
    );
    expect(deletedBuiltIn.status).toBe(409);

    // Once the required variable disappears, the dedicated Pack enable path
    // re-validates the stored attachment and refuses.
    const removeVariable = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}/variables/CLOUD_TOKEN`),
      { method: "DELETE" },
    );
    expect(removeVariable.status).toBeLessThan(300);
    const capabilityEnableMissingVariable = await app.request(
      workspacePath(workspaceId, `/packs/${packId}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(capabilityEnableMissingVariable.status).toBe(422);
    expect(await capabilityEnableMissingVariable.text()).toContain("CLOUD_TOKEN");

    const deleted = await app.request(workspacePath(workspaceId, `/packs/${packId}`), {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    const missing = await app.request(workspacePath(workspaceId, `/packs/${packId}`));
    expect(missing.status).toBe(404);
    const installationAfterDelete = await getPackInstallation(dbClient.db, workspaceId, packId);
    expect(installationAfterDelete?.status).toBe("disabled");
    // Pack lifecycle is dedicated. The MCP-only generic installation ledger
    // must not retain a shadow Pack row after uninstall.
    const capabilityInstallationAfterDelete = await getCapabilityInstallation(
      dbClient.db,
      workspaceId,
      `pack:${packId}`,
    );
    expect(capabilityInstallationAfterDelete).toBeNull();
  });

  test("installs platform-base Packs through explicit Rigs and shares identical inline Skills", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const suffix = crypto.randomUUID().slice(0, 8);
    const skillName = `infra-ops-${suffix}`;
    const packManifest = (id: string) => ({
      id,
      name: `Pack ${id}`,
      description: "Pack with an explicit Rig on the deployment platform base.",
      role: "infrastructure",
      category: "infrastructure",
      version: "0.1.0",
      skills: [
        {
          name: skillName,
          description: "Operate infrastructure with the pack runbook.",
          files: [
            {
              path: "SKILL.md",
              content: `---\nname: ${skillName}\ndescription: Operate infrastructure with the pack runbook.\n---\n# Infra ops\n`,
            },
            { path: "references/runbook.md", content: "Runbook." },
          ],
        },
      ],
      metadata: {
        sandboxImage: "example.invalid/spoofed:latest",
        sandboxProviderImages: {
          modal: { imageId: "im-abcdefghijklmnopqrstuv" },
        },
        skills: ["spoofed-skill"],
      },
    });
    const packA = `img-a-${suffix}`;
    const packB = `img-b-${suffix}`;
    for (const packId of [packA, packB]) {
      const registered = await app.request(workspacePath(workspaceId, "/packs"), {
        method: "POST",
        body: JSON.stringify(packManifest(packId)),
        headers: { "content-type": "application/json" },
      });
      expect(registered.status, await registered.text()).toBe(201);
    }

    // Packs that compose runtime components cannot use the legacy enable
    // paths. This test selects an explicit Rig through the installation flow.
    const legacyEnableA = await app.request(workspacePath(workspaceId, `/packs/${packA}/enable`), {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(legacyEnableA.status).toBe(409);
    expect(await legacyEnableA.text()).toContain("Pack installation flow");
    const capabilityEnableB = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packB}`)}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(capabilityEnableB.status).toBe(409);

    const previewWithoutRig = await app.request(
      workspacePath(workspaceId, `/packs/${packA}/installation-preview`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(previewWithoutRig.status).toBe(200);
    expect(await previewWithoutRig.json()).toMatchObject({
      ready: true,
      rig: { required: false, status: "not_required" },
      legacyInlineSkillCount: 1,
      legacySandboxImage: null,
    });

    const createRig = async (name: string): Promise<{ id: string }> => {
      const response = await app.request(workspacePath(workspaceId, "/rigs"), {
        method: "POST",
        body: JSON.stringify({
          name,
          setupScript: "true",
          checks: [],
          credentialHooks: [],
          defaultVariableSetIds: [],
        }),
        headers: { "content-type": "application/json" },
      });
      const body = await response.text();
      expect(response.status, body).toBe(201);
      return JSON.parse(body) as { id: string };
    };
    const [rigA, rigB] = await Promise.all([
      createRig(`Pack A ${suffix}`),
      createRig(`Pack B ${suffix}`),
    ]);

    const previewPack = async (
      packId: string,
      rigId: string,
    ): Promise<{
      manifestDigest: string;
      installationVersion: number | null;
      ready: boolean;
      components: Array<{
        key: string;
        kind: string;
        status: string;
        resolvedId: string | null;
      }>;
    }> => {
      const response = await app.request(
        workspacePath(workspaceId, `/packs/${packId}/installation-preview`),
        {
          method: "POST",
          body: JSON.stringify({ rigId }),
          headers: { "content-type": "application/json" },
        },
      );
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return JSON.parse(body) as {
        manifestDigest: string;
        installationVersion: number | null;
        ready: boolean;
        components: Array<{
          key: string;
          kind: string;
          status: string;
          resolvedId: string | null;
        }>;
      };
    };
    const installPack = async (
      packId: string,
      rigId: string,
      preview: Awaited<ReturnType<typeof previewPack>>,
    ): Promise<{ status: string; selectedRigId: string | null; version: number }> => {
      const response = await app.request(workspacePath(workspaceId, `/packs/${packId}/install`), {
        method: "POST",
        body: JSON.stringify({
          expectedManifestDigest: preview.manifestDigest,
          ...(preview.installationVersion === null
            ? {}
            : { expectedInstallationVersion: preview.installationVersion }),
          rigId,
          idempotencyKey: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
      });
      const body = await response.text();
      expect(response.status, body).toBe(preview.installationVersion === null ? 201 : 200);
      return JSON.parse(body) as {
        status: string;
        selectedRigId: string | null;
        version: number;
      };
    };

    const previewA = await previewPack(packA, rigA.id);
    expect(previewA).toMatchObject({ ready: true, installationVersion: null });
    expect(previewA.components).toEqual([
      expect.objectContaining({
        key: `inline-skill/${skillName}`,
        kind: "inline_skill",
        status: "ready",
      }),
    ]);
    const installedA = await installPack(packA, rigA.id, previewA);
    expect(installedA).toMatchObject({ status: "active", selectedRigId: rigA.id });

    const previewB = await previewPack(packB, rigB.id);
    expect(previewB).toMatchObject({ ready: true, installationVersion: null });
    expect(previewB.components).toEqual([
      expect.objectContaining({
        key: `inline-skill/${skillName}`,
        kind: "inline_skill",
        status: "ready",
      }),
    ]);
    expect(previewB.components[0]?.resolvedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const installedB = await installPack(packB, rigB.id, previewB);
    expect(installedB).toMatchObject({ status: "active", selectedRigId: rigB.id });
    expect(
      (await listInstalledPortableSkills(dbClient.db, workspaceId)).filter(
        (skill) => skill.name === skillName,
      ),
    ).toHaveLength(1);

    // The catalog surfaces skill names without accepting image metadata or
    // leaking skill file content.
    const catalogResponse = await app.request(workspacePath(workspaceId, "/capabilities"));
    const catalog = (await catalogResponse.json()) as {
      items: Array<{ id: string; metadata: Record<string, unknown> }>;
    };
    const packAItem = catalog.items.find((item) => item.id === `pack:${packA}`);
    expect(packAItem?.metadata.sandboxImage).toBeUndefined();
    expect(packAItem?.metadata.sandboxProviderImages).toBeUndefined();
    expect(packAItem?.metadata.skills).toEqual([skillName]);
    expect(JSON.stringify(packAItem?.metadata)).not.toContain("spoofed");
    expect(JSON.stringify(packAItem?.metadata)).not.toContain("Runbook.");

    // V2 Packs cannot be disabled or unregistered through legacy paths while
    // their component ownership ledger is active.
    const disabledA = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packA}`)}/disable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(disabledA.status).toBe(409);
    expect(await disabledA.text()).toContain("Pack uninstall preview flow");
    const unregisterActiveA = await app.request(workspacePath(workspaceId, `/packs/${packA}`), {
      method: "DELETE",
    });
    expect(unregisterActiveA.status).toBe(409);

    const uninstallPreviewAResponse = await app.request(
      workspacePath(workspaceId, `/packs/${packA}/uninstall-preview`),
    );
    expect(uninstallPreviewAResponse.status).toBe(200);
    const uninstallPreviewA = (await uninstallPreviewAResponse.json()) as {
      installed: boolean;
      installationVersion: number;
      components: Array<{
        key: string;
        kind: string;
        retainedByOtherOwners: boolean;
      }>;
    };
    expect(uninstallPreviewA).toMatchObject({ installed: true });
    expect(uninstallPreviewA.components).toEqual([
      expect.objectContaining({
        key: `inline-skill/${skillName}`,
        kind: "inline_skill",
        retainedByOtherOwners: true,
      }),
    ]);
    const uninstallAResponse = await app.request(
      workspacePath(workspaceId, `/packs/${packA}/installation`),
      {
        method: "DELETE",
        body: JSON.stringify({
          expectedInstallationVersion: uninstallPreviewA.installationVersion,
          idempotencyKey: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const uninstallABody = await uninstallAResponse.text();
    expect(uninstallAResponse.status, uninstallABody).toBe(200);
    expect(JSON.parse(uninstallABody)).toMatchObject({
      packId: packA,
      status: "uninstalled",
    });
    expect(
      (await listInstalledPortableSkills(dbClient.db, workspaceId)).filter(
        (skill) => skill.name === skillName,
      ),
    ).toHaveLength(1);

    const unregisterA = await app.request(workspacePath(workspaceId, `/packs/${packA}`), {
      method: "DELETE",
    });
    expect(unregisterA.status).toBe(204);

    const uninstallPreviewBResponse = await app.request(
      workspacePath(workspaceId, `/packs/${packB}/uninstall-preview`),
    );
    expect(uninstallPreviewBResponse.status).toBe(200);
    const uninstallPreviewB = (await uninstallPreviewBResponse.json()) as {
      installationVersion: number;
      components: Array<{ retainedByOtherOwners: boolean }>;
    };
    expect(uninstallPreviewB.components).toEqual([
      expect.objectContaining({ retainedByOtherOwners: false }),
    ]);
    const uninstallBResponse = await app.request(
      workspacePath(workspaceId, `/packs/${packB}/installation`),
      {
        method: "DELETE",
        body: JSON.stringify({
          expectedInstallationVersion: uninstallPreviewB.installationVersion,
          idempotencyKey: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const uninstallBBody = await uninstallBResponse.text();
    expect(uninstallBResponse.status, uninstallBBody).toBe(200);
    expect(JSON.parse(uninstallBBody)).toMatchObject({
      packId: packB,
      status: "uninstalled",
      retainedComponents: [],
    });
    expect(
      (await listInstalledPortableSkills(dbClient.db, workspaceId)).filter(
        (skill) => skill.name === skillName,
      ),
    ).toHaveLength(0);
  });

  test("keeps scheduled task persistence consistent when schedule sync fails", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    workflow.syncError = new Error("temporal unavailable");
    const failedCreateName = `sync-fail-${crypto.randomUUID()}`;
    const workspaceId = await defaultWorkspaceId(app);
    const failedCreate = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: failedCreateName,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(failedCreate.status).toBe(500);
    expect(
      (await listScheduledTasks(dbClient.db, workspaceId)).some(
        (task) => task.name === failedCreateName,
      ),
    ).toBe(false);

    workflow.syncError = null;
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: `rollback-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    const task = (await created.json()) as { id: string };

    workflow.syncError = new Error("temporal unavailable");
    const failedPause = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/pause`),
      { method: "POST" },
    );
    expect(failedPause.status).toBe(500);
    expect((await getScheduledTask(dbClient.db, workspaceId, task.id))?.status).toBe("active");
  });

  test("keeps MCP scheduled task persistence consistent when schedule sync fails", async () => {
    workflow = new FakeWorkflowClient();
    const settings = testSettings({ databaseUrl: services.databaseUrl });
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcp = buildOpenGeniMcpServer(
      {
        settings,
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: workflow,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by scheduled task MCP tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );

    workflow.syncError = new Error("temporal unavailable");
    const failedCreateName = `mcp-sync-fail-${crypto.randomUUID()}`;
    await expect(
      callMcpTool(mcp, "scheduled_tasks_create", {
        name: failedCreateName,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
    ).rejects.toThrow("temporal unavailable");
    expect(
      (await listScheduledTasks(dbClient.db, grant.workspaceId)).some(
        (task) => task.name === failedCreateName,
      ),
    ).toBe(false);

    workflow.syncError = null;
    const taskReceipt = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_create", {
      name: `mcp-rollback-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "inspect" },
    });
    const taskId = taskReceipt.resource.id;
    expect(taskReceipt).toMatchObject({
      operation: "scheduled_tasks_create",
      outcome: "created",
      changed: true,
      resource: { type: "scheduled_task", id: taskId, state: "active" },
    });

    workflow.syncError = new Error("temporal unavailable");
    await expect(callMcpTool(mcp, "scheduled_tasks_pause", { id: taskId })).rejects.toThrow(
      "temporal unavailable",
    );
    expect((await getScheduledTask(dbClient.db, grant.workspaceId, taskId))?.status).toBe("active");
    await expect(
      callMcpTool(mcp, "scheduled_tasks_resume", { id: crypto.randomUUID() }),
    ).rejects.toThrow("Scheduled task not found");
  });

  test("returns compact receipts across the MCP scheduled task lifecycle", async () => {
    const workflowClient = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcp = buildOpenGeniMcpServer(
      {
        settings: testSettings({ databaseUrl: services.databaseUrl }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by scheduled task lifecycle tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );
    const prompt = `scheduled receipt prompt ${crypto.randomUUID()}`;
    const originalName = `scheduled-receipt-${crypto.randomUUID()}`;
    const created = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_create", {
      name: originalName,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt },
    });
    expect(created).toMatchObject({
      outcome: "created",
      changed: true,
      resource: { type: "scheduled_task", state: "active" },
    });
    expect(JSON.stringify(created)).not.toContain(prompt);
    expect(JSON.stringify(created)).not.toContain(originalName);

    const summary = await callMcpTool<{
      id: string;
      configuration: { promptBytes: number };
    }>(mcp, "scheduled_tasks_get", { id: created.resource.id });
    expect(summary).toMatchObject({
      id: created.resource.id,
      configuration: { promptBytes: Buffer.byteLength(prompt, "utf8") },
    });
    expect(JSON.stringify(summary)).not.toContain(prompt);

    const detail = await callMcpTool<{
      entity: { agentConfig: { prompt: string } };
      detailProjection: { bounded: boolean };
    }>(mcp, "scheduled_tasks_get", {
      id: created.resource.id,
      includeEntity: true,
    });
    expect(detail.entity.agentConfig.prompt).toBe(prompt);
    expect(detail.detailProjection.bounded).toBe(true);

    const updatedName = `scheduled-updated-${crypto.randomUUID()}`;
    const updated = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_update", {
      id: created.resource.id,
      name: updatedName,
    });
    expect(updated).toMatchObject({ outcome: "updated", changed: true });
    expect(JSON.stringify(updated)).not.toContain(updatedName);
    const unchanged = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_update", {
      id: created.resource.id,
      name: updatedName,
    });
    expect(unchanged).toMatchObject({ outcome: "unchanged", changed: false });

    const paused = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_pause", {
      id: created.resource.id,
    });
    expect(paused).toMatchObject({
      outcome: "updated",
      resource: { state: "paused" },
    });
    const alreadyPaused = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_pause", {
      id: created.resource.id,
    });
    expect(alreadyPaused).toMatchObject({
      outcome: "unchanged",
      changed: false,
    });

    const resumed = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_resume", {
      id: created.resource.id,
    });
    expect(resumed).toMatchObject({
      outcome: "updated",
      resource: { state: "active" },
    });

    const triggerId = `scheduled-receipt-trigger-${crypto.randomUUID()}`;
    const triggered = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_trigger", {
      id: created.resource.id,
      triggerId,
    });
    expect(triggered).toMatchObject({
      outcome: "triggered",
      changed: true,
      idempotency: { status: "unknown" },
    });
    expect(workflowClient.triggers).toHaveLength(1);

    const deleted = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_delete", {
      id: created.resource.id,
    });
    expect(deleted).toMatchObject({
      outcome: "deleted",
      changed: true,
      resource: { id: created.resource.id, state: "deleted" },
    });
    expect(await getScheduledTask(dbClient.db, grant.workspaceId, created.resource.id)).toBeNull();
  });

  test("MCP scheduled task tools enforce the same billing limits as REST routes", async () => {
    workflow = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const allowedMcp = buildOpenGeniMcpServer(
      {
        settings: testSettings({ databaseUrl: services.databaseUrl }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: workflow,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by scheduled task MCP tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );
    const task = await callMcpTool<McpMutationReceiptType>(allowedMcp, "scheduled_tasks_create", {
      name: `mcp-limit-trigger-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "inspect" },
    });
    workflow.synced = [];

    const blockedCreateMcp = buildOpenGeniMcpServer(
      {
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          usageLimitsMode: "static",
          staticUsageLimitsJson: JSON.stringify({
            maxSchedulesPerWorkspace: 1,
          }),
        }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: workflow,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by scheduled task MCP tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );

    await expect(
      callMcpTool(blockedCreateMcp, "scheduled_tasks_create", {
        name: `mcp-limit-create-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
    ).rejects.toThrow("scheduled task limit reached");
    expect(workflow.synced).toHaveLength(0);
    await recordUsageEvent(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "test",
      sourceResourceId: task.resource.id,
      idempotencyKey: `test:mcp-agent-run-cap:${task.resource.id}`,
    });

    const blockedTriggerMcp = buildOpenGeniMcpServer(
      {
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          usageLimitsMode: "static",
          staticUsageLimitsJson: JSON.stringify({
            maxMonthlyAgentRunsPerWorkspace: 1,
          }),
        }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: workflow,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by scheduled task MCP tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );
    await expect(
      callMcpTool(blockedTriggerMcp, "scheduled_tasks_trigger", {
        id: task.resource.id,
      }),
    ).rejects.toThrow("monthly agent run limit reached");
    expect(workflow.triggers).toHaveLength(0);
  });

  test("returns 404 for missing scheduled task actions", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${crypto.randomUUID()}/pause`),
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  test("validates scheduled task semantic edge cases", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const blankName = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "   ",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(blankName.status).toBe(422);

    const invalidWindow = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "bad-window",
        schedule: {
          type: "interval",
          everySeconds: 3600,
          startAt: "2026-05-08T12:00:00.000Z",
          endAt: "2026-05-08T11:00:00.000Z",
        },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidWindow.status).toBe(422);
  });

  test("creates and triggers an exact existing-session scheduled task through REST and MCP", async () => {
    const workflowClient = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const targetResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialMessage: "existing schedule target" }),
    });
    expect(targetResponse.status).toBe(202);
    const target = (await targetResponse.json()) as { id: string };

    const createResponse = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "continue existing session",
        schedule: { type: "interval", everySeconds: 3600 },
        runMode: "existing_session",
        targetSessionId: target.id,
        agentConfig: { prompt: "continue exactly here" },
      }),
    });
    expect(createResponse.status).toBe(201);
    const task = (await createResponse.json()) as {
      id: string;
      targetSessionId: string | null;
    };
    expect(task.targetSessionId).toBe(target.id);

    const triggerResponse = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`),
      { method: "POST" },
    );
    expect(triggerResponse.status).toBe(202);
    expect(workflowClient.triggers).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({
          id: task.id,
          runMode: "existing_session",
          targetSessionId: target.id,
        }),
      }),
    ]);

    const goalResponse = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "invalid existing goal",
        schedule: { type: "interval", everySeconds: 3600 },
        runMode: "existing_session",
        targetSessionId: target.id,
        agentConfig: {
          prompt: "continue",
          goal: { text: "replace target goal" },
        },
      }),
    });
    expect(goalResponse.status).toBe(400);

    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpTarget = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "MCP exact target",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const mcpWorkflow = new FakeWorkflowClient();
    const mcp = buildOpenGeniMcpServer(
      {
        settings: testSettings({ databaseUrl: services.databaseUrl }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: mcpWorkflow,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by scheduled task target tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );
    const receipt = await callMcpTool<McpMutationReceiptType>(mcp, "scheduled_tasks_create", {
      name: "MCP continue existing session",
      schedule: { type: "interval", everySeconds: 3600 },
      runMode: "existing_session",
      targetSessionId: mcpTarget.id,
      agentConfig: { prompt: "continue MCP target" },
    });
    const summary = await callMcpTool<{ targetSessionId: string | null }>(
      mcp,
      "scheduled_tasks_get",
      { id: receipt.resource.id },
    );
    expect(summary.targetSessionId).toBe(mcpTarget.id);
  });

  test("reports file upload support when object storage is configured", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        objectStorageEndpoint: "http://127.0.0.1:3900",
        objectStorageAccessKeyId: GARAGE_FIXTURE_ACCESS_KEY_ID,
        objectStorageSecretAccessKey: GARAGE_FIXTURE_SECRET_ACCESS_KEY,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/config/client");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      fileUploads: { enabled: boolean; maxSizeBytes: number };
    };
    expect(payload.fileUploads).toEqual({
      enabled: true,
      maxSizeBytes: 5_000_000_000,
    });
  });

  test("rejects mixed GitHub App repository installations during session create", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "bad repos",
        resources: [
          {
            kind: "repository",
            uri: "https://github.com/a/one.git",
            ref: "main",
            githubInstallationId: 1,
            githubRepositoryId: 11,
          },
          {
            kind: "repository",
            uri: "https://github.com/b/two.git",
            ref: "main",
            githubInstallationId: 2,
            githubRepositoryId: 22,
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("supports direct-to-object-storage file uploads and file resources", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);

    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({
        filename: "spec.txt",
        contentType: "text/plain",
        sizeBytes: 11,
        sha256: "test-sha",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(uploadResponse.status).toBe(201);
    const upload = (await uploadResponse.json()) as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
      maxSizeBytes: number;
    };
    expect(upload.maxSizeBytes).toBeGreaterThan(1_000_000_000);
    expect(upload.requiredHeaders).toMatchObject({
      "content-type": "text/plain",
    });

    const put = await fetch(upload.putUrl, {
      method: "PUT",
      body: "hello world",
      headers: upload.requiredHeaders,
    });
    expect(put.status).toBeGreaterThanOrEqual(200);
    expect(put.status).toBeLessThan(300);

    const completeResponse = await app.request(
      workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`),
      {
        method: "POST",
      },
    );
    expect(completeResponse.status).toBe(200);
    const completed = (await completeResponse.json()) as {
      file: { id: string; status: string; objectKey: string };
    };
    expect(completed.file.id).toBe(upload.fileId);
    expect(completed.file.status).toBe("ready");
    expect(completed.file.objectKey).toContain(`/original/spec.txt`);

    const metadataResponse = await app.request(
      workspacePath(workspaceId, `/files/${upload.fileId}`),
    );
    expect(metadataResponse.status).toBe(200);
    const metadata = (await metadataResponse.json()) as Record<string, unknown>;
    expect(metadata.status).toBe("ready");
    expect(metadata).not.toHaveProperty("url");

    const downloadResponse = await app.request(
      workspacePath(workspaceId, `/files/${upload.fileId}/download-url`),
      { method: "POST" },
    );
    expect(downloadResponse.status).toBe(200);
    const download = (await downloadResponse.json()) as { url: string };
    expect(download.url).toContain("X-Amz-Signature");

    const sessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use file",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(sessionResponse.status).toBe(202);
    const session = (await sessionResponse.json()) as {
      id: string;
      resources: unknown[];
    };
    expect(session.resources).toEqual([
      {
        kind: "file",
        fileId: upload.fileId,
        mountPath: `.opengeni/files/${upload.fileId}`,
      },
    ]);
    const initialEvents = await listSessionEvents(dbClient.db, workspaceId, session.id, 0, 10);
    const initialPayload = initialEvents.find((event) => event.type === "user.message")?.payload as
      | Record<string, unknown>
      | undefined;
    expect(initialPayload).toMatchObject({
      text: "use file",
      resources: [
        {
          kind: "file",
          fileId: upload.fileId,
          mountPath: `.opengeni/files/${upload.fileId}`,
        },
      ],
    });
    if (Array.isArray(initialPayload?.tools)) {
      expect(initialPayload.tools).toContainEqual({
        kind: "mcp",
        id: "cap-route-mcp",
        optional: true,
      });
    }

    const followUpSessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "start empty" }),
      headers: { "content-type": "application/json" },
    });
    const followUpSession = (await followUpSessionResponse.json()) as {
      id: string;
    };
    await setSessionStatus(dbClient.db, workspaceId, followUpSession.id, "idle", null);
    const followUp = await app.request(
      workspacePath(workspaceId, `/sessions/${followUpSession.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "use file now",
            resources: [{ kind: "file", fileId: upload.fileId }],
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(followUp.status).toBe(202);
    const followUpEvent = (await followUp.json()) as SessionEvent;
    expect(followUpEvent.payload).toMatchObject({
      text: "use file now",
      resources: [
        {
          kind: "file",
          fileId: upload.fileId,
          mountPath: `.opengeni/files/${upload.fileId}`,
        },
      ],
    });
    if (Array.isArray((followUpEvent.payload as Record<string, unknown>).tools)) {
      expect((followUpEvent.payload as { tools: unknown[] }).tools).toContainEqual({
        kind: "mcp",
        id: "cap-route-mcp",
        optional: true,
      });
    }
    expect((await requireSession(dbClient.db, workspaceId, followUpSession.id)).resources).toEqual([
      {
        kind: "file",
        fileId: upload.fileId,
        mountPath: `.opengeni/files/${upload.fileId}`,
      },
    ]);
  });

  test("rejects pending file resources during session create", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({
        filename: "pending.txt",
        contentType: "text/plain",
        sizeBytes: 7,
      }),
      headers: { "content-type": "application/json" },
    });
    const upload = (await uploadResponse.json()) as { fileId: string };
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use pending file",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("validates message, approval, Pause, and Resume state transitions", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "state" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };

    const rejected = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "too soon" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(rejected.status).toBe(202);

    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const accepted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "now" },
          clientEventId: "follow-up",
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(accepted.status).toBe(202);
    expect(workflow.wakeups.length).toBeGreaterThanOrEqual(2);

    const approvalRejected = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.approvalDecision",
          payload: { approvalId: "x", decision: "approve" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approvalRejected.status).toBe(409);

    const approvalWaitAttemptId = crypto.randomUUID();
    const approvalWaitClaim = await claimSessionWorkForAttempt(dbClient.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: approvalWaitAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (approvalWaitClaim.action !== "claimed") {
      throw new Error(`failed to claim approval fixture: ${approvalWaitClaim.reason}`);
    }
    const approvalSession = await requireSession(dbClient.db, workspaceId, session.id);
    expect(
      await saveRunState(dbClient.db, {
        accountId: approvalSession.accountId,
        workspaceId,
        sessionId: session.id,
        turnId: approvalWaitClaim.turn.id,
        expectedExecutionGeneration: approvalWaitClaim.turn.executionGeneration,
        expectedAttemptId: approvalWaitAttemptId,
        serializedRunState: JSON.stringify({
          kind: "api-integration-approval-state",
        }),
        pendingApprovals: [{ id: "x" }],
      }),
    ).toBe(true);
    await applySessionTurnSettlement(dbClient.db, workspaceId, {
      sessionId: session.id,
      turnId: approvalWaitClaim.turn.id,
      triggerEventId: approvalWaitClaim.turn.triggerEventId,
      attemptId: approvalWaitAttemptId,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: approvalWaitClaim.turn.id,
      events: [{ type: "session.requiresAction", payload: { approvalId: "x" } }],
    });
    const approvalAccepted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.approvalDecision",
          payload: { approvalId: "x", decision: "approve" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approvalAccepted.status).toBe(202);
    expect(workflow.approvals).toHaveLength(1);
    const approvalEvent = (await approvalAccepted.json()) as SessionEvent;

    const attemptId = crypto.randomUUID();
    const running = await claimSessionWorkForAttempt(dbClient.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "approval", triggerEventId: approvalEvent.id },
    });
    expect(running).toMatchObject({ action: "claimed" });
    if (running.action !== "claimed") throw new Error("approval fixture did not resume");

    const dispatchCountBeforePause = workflow.wakeDispatches;
    const paused = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/control`),
      {
        method: "POST",
        body: JSON.stringify({
          action: "pause",
          reason: "operator pause",
          clientEventId: `pause-${crypto.randomUUID()}`,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      effectiveControl: { state: "paused" },
      interruptionCount: 1,
    });
    await waitFor(() => workflow.wakeDispatches === dispatchCountBeforePause + 1);

    const resumed = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/control`),
      {
        method: "POST",
        body: JSON.stringify({
          action: "resume",
          reason: "continue",
          clientEventId: `resume-${crypto.randomUUID()}`,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      effectiveControl: { state: "active" },
    });

    const malformed = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({ type: "user.message", payload: { text: "" } }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(malformed.status).toBeGreaterThanOrEqual(400);
  });

  test("lists events and streams SSE replay plus live fanout", async () => {
    const bus = new MemoryEventBus();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus,
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "stream" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };

    const listed = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?limit=10`),
    );
    expect(listed.status).toBe(200);
    const initialEvents = (await listed.json()) as SessionEvent[];
    expect(initialEvents.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);

    const bulkEventCount = 2005;
    await appendSessionEvents(
      dbClient.db,
      workspaceId,
      session.id,
      Array.from({ length: bulkEventCount }, (_, index) => ({
        type: "agent.message.delta",
        payload: { text: `bulk-${index}` },
      })),
    );
    const latestSequence = initialEvents.length + bulkEventCount;
    const newest = await app.request(
      workspacePath(
        workspaceId,
        `/sessions/${session.id}/events?before=${Number.MAX_SAFE_INTEGER}&limit=3`,
      ),
    );
    expect(newest.status).toBe(200);
    expect(((await newest.json()) as SessionEvent[]).map((event) => event.sequence)).toEqual([
      latestSequence - 2,
      latestSequence - 1,
      latestSequence,
    ]);

    const ranged = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?after=4&before=8&limit=10`),
    );
    expect(ranged.status).toBe(200);
    expect(((await ranged.json()) as SessionEvent[]).map((event) => event.sequence)).toEqual([
      5, 6, 7,
    ]);

    const clampedMax = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?after=0&limit=1000000000`),
    );
    expect(clampedMax.status).toBe(200);
    expect((await clampedMax.json()) as SessionEvent[]).toHaveLength(2000);
    const clampedMin = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?after=0&limit=0`),
    );
    expect(clampedMin.status).toBe(200);
    expect((await clampedMin.json()) as SessionEvent[]).toHaveLength(1);

    const compact = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?limit=1000000000&compact=1`),
    );
    expect(compact.status).toBe(200);
    const compactEvents = (await compact.json()) as SessionEvent[];
    expect(compactEvents.slice(0, 4)).toEqual(initialEvents);
    expect(compactEvents).toHaveLength(5);
    expect(compactEvents[4]).toMatchObject({
      sequence: 5,
      type: "agent.message.delta",
      payload: { coalescedUntil: latestSequence },
    });
    expect(
      (compactEvents[4]?.payload as { text?: string } | undefined)?.text?.startsWith("bulk-0"),
    ).toBe(true);
    expect(
      (compactEvents[4]?.payload as { text?: string } | undefined)?.text?.endsWith(
        `bulk-${bulkEventCount - 1}`,
      ),
    ).toBe(true);

    const compactNewest = await app.request(
      workspacePath(
        workspaceId,
        `/sessions/${session.id}/events?before=${Number.MAX_SAFE_INTEGER}&limit=3&compact=true`,
      ),
    );
    expect(compactNewest.status).toBe(200);
    const compactNewestEvents = (await compactNewest.json()) as SessionEvent[];
    expect(compactNewestEvents).toHaveLength(1);
    expect(compactNewestEvents[0]?.sequence).toBe(latestSequence - 2);
    expect(
      (compactNewestEvents[0]?.payload as { coalescedUntil?: number } | undefined)?.coalescedUntil,
    ).toBe(latestSequence);

    const compactOlder = await app.request(
      workspacePath(
        workspaceId,
        `/sessions/${session.id}/events?before=${compactNewestEvents[0]!.sequence}&limit=3&compact=1`,
      ),
    );
    expect(compactOlder.status).toBe(200);
    const compactOlderEvents = (await compactOlder.json()) as SessionEvent[];
    expect(compactOlderEvents).toHaveLength(1);
    const compactPageChunks = [
      ...(((compactOlderEvents[0]?.payload as { text?: string } | undefined)?.text ?? "").match(
        /bulk-\d+/g,
      ) ?? []),
      ...(((compactNewestEvents[0]?.payload as { text?: string } | undefined)?.text ?? "").match(
        /bulk-\d+/g,
      ) ?? []),
    ];
    expect(compactPageChunks).toEqual(
      Array.from({ length: 6 }, (_, offset) => `bulk-${bulkEventCount - 6 + offset}`),
    );
    expect(new Set(compactPageChunks).size).toBe(compactPageChunks.length);

    const replayAbort = new AbortController();
    const replay = await app.request(
      new Request(
        `http://test${workspacePath(workspaceId, `/sessions/${session.id}/events/stream?after=0`)}`,
        {
          signal: replayAbort.signal,
        },
      ),
    );
    expect(replay.status).toBe(200);
    expect((await readSseEvents(replay, 4, replayAbort)).map((event) => event.type)).toEqual(
      initialEvents.map((event) => event.type),
    );

    const liveAbortA = new AbortController();
    const liveAbortB = new AbortController();
    const liveA = await app.request(
      new Request(
        `http://test${workspacePath(workspaceId, `/sessions/${session.id}/events/stream?after=${latestSequence}`)}`,
        {
          signal: liveAbortA.signal,
        },
      ),
    );
    const liveB = await app.request(
      new Request(
        `http://test${workspacePath(workspaceId, `/sessions/${session.id}/events/stream?after=${latestSequence}`)}`,
        {
          signal: liveAbortB.signal,
        },
      ),
    );
    const readA = readSseEvents(liveA, 1, liveAbortA);
    const readB = readSseEvents(liveB, 1, liveAbortB);
    const [appended] = await appendAndPublishEvents(dbClient.db, bus, workspaceId, session.id, [
      { type: "agent.message.delta", payload: { text: "live" } },
    ]);
    expect((await readA)[0]?.id).toBe(appended?.id);
    expect((await readB)[0]?.id).toBe(appended?.id);
  });

  test("reports missing GitHub App configuration", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/github/app"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: boolean;
      missing: string[];
    };
    expect(body.configured).toBe(false);
    expect(body.missing.length).toBeGreaterThan(0);
  });

  test("binds only after fresh GitHub owner authority and reports truthful status", async () => {
    const stateSecret = "github-owner-authority-state";
    const installationId = 338826628;
    const repository = {
      id: 3001,
      installationId,
      fullName: "owner/repository",
      name: "repository",
      private: true,
      htmlUrl: "https://github.com/owner/repository",
      cloneUrl: "https://github.com/owner/repository.git",
      defaultBranch: "main",
      accountLogin: "owner",
      accountType: "User",
    };
    let authorityCalls = 0;
    let installationLifecycle: "active" | "suspended" | "deleted" | "outage" = "active";
    const githubAppApi = {
      discoverInstallationBindingCandidates: async () => [],
      authorizeInstallationBinding: async () => {
        authorityCalls += 1;
        return {
          actorId: 501,
          actorLogin: "owner",
          authorityKind: "personal_owner" as const,
          installation: {
            installationId,
            accountId: 501,
            accountLogin: "owner",
            accountType: "User",
            suspended: false,
          },
          repositories: [repository],
        };
      },
      getInstallation: async ({ installationId: requested }: { installationId: number }) => {
        if (installationLifecycle === "outage") {
          throw new Error("GitHub installation lookup unavailable");
        }
        return requested === installationId && installationLifecycle !== "deleted"
          ? {
              installationId,
              accountId: 501,
              accountLogin: "owner",
              accountType: "User",
              suspended: installationLifecycle === "suspended",
            }
          : null;
      },
      listRepositories: async () => [repository],
    };
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        publicBaseUrl: "https://api.opengeni.test",
        githubAppId: "12345",
        githubClientId: "test-client-id",
        githubClientSecret: "test-client-secret",
        githubAppSlug: "opengeni-test-app",
        githubAppPrivateKey: "test-private-key",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      githubStateSecret: stateSecret,
      githubAppApi,
    });
    const context = await defaultAccessContext(app);
    const workspaceId = context.defaultWorkspaceId!;
    const secondWorkspaceResponse = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: context.defaultAccountId,
        name: "GitHub cross-workspace target",
      }),
    });
    const secondWorkspace = (await secondWorkspaceResponse.json()) as {
      id: string;
    };

    const before = await app.request(workspacePath(workspaceId, "/github/app"));
    const beforeInfo = (await before.json()) as {
      configured: boolean;
      status: string;
      installUrl: string | null;
      installations: unknown[];
    };
    expect(beforeInfo).toMatchObject({
      configured: true,
      status: "unbound",
      installations: [],
    });
    expect(beforeInfo.installUrl).not.toBeNull();

    await bindGitHubInstallationRepositories(dbClient.db, {
      accountId: context.defaultAccountId!,
      workspaceId: secondWorkspace.id,
      installationId,
      accountLogin: "owner",
      accountType: "User",
      linkedBySubjectId: context.subjectId,
      repositoryIds: [repository.id],
    });
    const legacyInfo = (await (
      await app.request(workspacePath(secondWorkspace.id, "/github/app"))
    ).json()) as {
      status: string;
      installations: Array<{ lifecycle: string }>;
    };
    expect(legacyInfo).toMatchObject({
      status: "unbound",
      installations: [{ lifecycle: "unverified" }],
    });
    expect(
      (
        (await (
          await app.request(workspacePath(secondWorkspace.id, "/github/repositories"))
        ).json()) as { repositories: unknown[] }
      ).repositories,
    ).toEqual([]);

    const connectUrl = new URL(beforeInfo.installUrl!);
    const initialState = connectUrl.searchParams.get("state")!;
    expect(
      (
        await app.request(
          workspacePath(
            secondWorkspace.id,
            `/github/connect?state=${encodeURIComponent(initialState)}`,
          ),
        )
      ).status,
    ).toBe(400);

    const connect = await app.request(beforeInfo.installUrl!);
    expect(connect.status).toBe(302);
    expect(connect.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
    const discoveryLocation = new URL(connect.headers.get("location")!);
    const discoveryState = discoveryLocation.searchParams.get("state")!;
    const discoveryCookie = connect.headers.get("set-cookie")!.split(";", 1)[0]!;
    const discovery = await app.request(
      `/v1/github/oauth/callback?code=discover-owner-installations&state=${encodeURIComponent(discoveryState)}`,
      { headers: { cookie: discoveryCookie } },
    );
    expect(discovery.status).toBe(302);
    const installLocation = new URL(discovery.headers.get("location")!);
    expect(installLocation.origin + installLocation.pathname).toBe(
      "https://github.com/apps/opengeni-test-app/installations/new",
    );
    const installState = installLocation.searchParams.get("state")!;
    const installCookie = discovery.headers.get("set-cookie")!.split(";", 1)[0]!;
    const setup = await app.request(
      `/v1/github/setup?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(installState)}`,
      { headers: { cookie: installCookie } },
    );
    expect(setup.status).toBe(302);
    const oauthLocation = new URL(setup.headers.get("location")!);
    expect(oauthLocation.origin + oauthLocation.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    const oauthState = oauthLocation.searchParams.get("state")!;
    const oauthCookie = setup.headers.get("set-cookie")!.split(";", 1)[0]!;

    const callback = await app.request(
      `/v1/github/oauth/callback?code=fresh-owner-code&state=${encodeURIComponent(oauthState)}`,
      { headers: { cookie: oauthCookie } },
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("GitHub App connected");

    const replay = await app.request(
      `/v1/github/oauth/callback?code=replayed-owner-code&state=${encodeURIComponent(oauthState)}`,
      { headers: { cookie: oauthCookie } },
    );
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("already used");
    expect(authorityCalls).toBe(2);

    const afterInfo = (await (
      await app.request(workspacePath(workspaceId, "/github/app"))
    ).json()) as {
      status: string;
      installations: Array<{
        lifecycle: string;
        githubAccountId: number;
        repositoryCount: number;
      }>;
    };
    expect(afterInfo).toMatchObject({
      status: "bound",
      installations: [{ lifecycle: "active", githubAccountId: 501, repositoryCount: 1 }],
    });
    expect(
      (
        (await (await app.request(workspacePath(workspaceId, "/github/repositories"))).json()) as {
          repositories: Array<{ id: number }>;
        }
      ).repositories.map(({ id }) => id),
    ).toEqual([repository.id]);

    for (const expected of [
      ["suspended", "suspended"],
      ["deleted", "deleted"],
      ["outage", "unverified"],
    ] as const) {
      installationLifecycle = expected[0];
      const lifecycleInfo = (await (
        await app.request(workspacePath(workspaceId, "/github/app"))
      ).json()) as {
        status: string;
        installations: Array<{ lifecycle: string }>;
      };
      expect(lifecycleInfo).toMatchObject({
        status: "unbound",
        installations: [{ lifecycle: expected[1] }],
      });
      const unavailableRepositories = (await (
        await app.request(workspacePath(workspaceId, "/github/repositories"))
      ).json()) as { repositories: Array<{ id: number }> };
      expect(unavailableRepositories.repositories).toEqual([]);
    }
    installationLifecycle = "active";

    const legacyChooser = await app.request(workspacePath(workspaceId, "/github/installations"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `oauth_state=${encodeURIComponent(initialState)}&installation_ticket=forged`,
    });
    expect(legacyChooser.status).toBe(410);
  });

  test("preserves independent workspace allowlists and downstream enforcement", async () => {
    const installationId = 138826628;
    const githubPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const adminRepository = {
      id: 1001,
      installationId,
      fullName: "acme/admin-repository",
      name: "admin-repository",
      private: true,
      htmlUrl: "https://github.com/acme/admin-repository",
      cloneUrl: "https://github.com/acme/admin-repository.git",
      defaultBranch: "main",
      accountLogin: "acme",
      accountType: "Organization",
    };
    const readOnlyRepository = {
      id: 1002,
      installationId,
      fullName: "acme/read-only-repository",
      name: "read-only-repository",
      private: true,
      htmlUrl: "https://github.com/acme/read-only-repository",
      cloneUrl: "https://github.com/acme/read-only-repository.git",
      defaultBranch: "main",
      accountLogin: "acme",
      accountType: "Organization",
    };
    const githubAppApi = {
      getInstallation: async ({ installationId: requested }: { installationId: number }) =>
        requested === installationId
          ? {
              installationId,
              accountId: 9001,
              accountLogin: "acme",
              accountType: "Organization",
              suspended: false,
            }
          : null,
      listRepositories: async () => [adminRepository, readOnlyRepository],
    };
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      publicBaseUrl: "https://api.opengeni.test",
      githubAppId: "12345",
      githubClientId: "test-client-id",
      githubClientSecret: "test-client-secret",
      githubAppSlug: "opengeni-test-app",
      githubAppPrivateKey: githubPrivateKey,
    });
    const app = createApp({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      githubAppApi,
    });
    const context = await defaultAccessContext(app);
    const firstWorkspaceResponse = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: context.defaultAccountId,
        name: "First GitHub workspace",
      }),
    });
    expect(firstWorkspaceResponse.status).toBe(201);
    const firstWorkspace = (await firstWorkspaceResponse.json()) as {
      id: string;
    };
    const firstWorkspaceId = firstWorkspace.id;
    const secondWorkspaceResponse = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: context.defaultAccountId,
        name: "Second GitHub workspace",
      }),
    });
    expect(secondWorkspaceResponse.status).toBe(201);
    const secondWorkspace = (await secondWorkspaceResponse.json()) as {
      id: string;
    };
    const refreshedContext = await defaultAccessContext(app);

    const authorityCheckedAt = new Date();
    const authorityExpiresAt = new Date(authorityCheckedAt.getTime() + 10 * 60_000);
    // One GitHub installation can be deliberately delegated into two OpenGeni
    // workspaces, but each workspace owns an independent exact allowlist and
    // an independent consumed owner-authority proof.
    await Promise.all([
      bindAuthorizedGitHubInstallationRepositories(dbClient.db, {
        accountId: context.defaultAccountId!,
        workspaceId: firstWorkspaceId,
        installationId,
        githubAccountId: 9001,
        accountLogin: "acme",
        accountType: "Organization",
        linkedBySubjectId: context.subjectId,
        githubActorId: 9002,
        githubActorLogin: "acme-owner",
        authorityKind: "organization_owner",
        authorityCheckedAt,
        authorityExpiresAt,
        authorityNonce: `first-${crypto.randomUUID()}`,
        repositoryIds: [adminRepository.id],
      }),
      bindAuthorizedGitHubInstallationRepositories(dbClient.db, {
        accountId: context.defaultAccountId!,
        workspaceId: secondWorkspace.id,
        installationId,
        githubAccountId: 9001,
        accountLogin: "acme",
        accountType: "Organization",
        linkedBySubjectId: context.subjectId,
        githubActorId: 9002,
        githubActorLogin: "acme-owner",
        authorityKind: "organization_owner",
        authorityCheckedAt,
        authorityExpiresAt,
        authorityNonce: `second-${crypto.randomUUID()}`,
        repositoryIds: [adminRepository.id],
      }),
    ]);

    const [firstAccess, secondAccess] = await Promise.all([
      listGitHubInstallationAccessForWorkspace(dbClient.db, firstWorkspaceId),
      listGitHubInstallationAccessForWorkspace(dbClient.db, secondWorkspace.id),
    ]);
    expect(firstAccess).toMatchObject([
      {
        installationId,
        repositoryScope: "selected",
        repositoryIds: [adminRepository.id],
      },
    ]);
    expect(secondAccess).toMatchObject([
      {
        installationId,
        repositoryScope: "selected",
        repositoryIds: [adminRepository.id],
      },
    ]);

    const firstRepositories = await app.request(
      workspacePath(firstWorkspaceId, "/github/repositories"),
    );
    const secondRepositories = await app.request(
      workspacePath(secondWorkspace.id, "/github/repositories"),
    );
    expect(
      (
        (await firstRepositories.json()) as {
          repositories: Array<{ id: number }>;
        }
      ).repositories.map(({ id }) => id),
    ).toEqual([adminRepository.id]);
    expect(
      (
        (await secondRepositories.json()) as {
          repositories: Array<{ id: number }>;
        }
      ).repositories.map(({ id }) => id),
    ).toEqual([adminRepository.id]);

    const deniedReadOnlySession = await app.request(
      workspacePath(secondWorkspace.id, "/sessions"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialMessage: "This repository was never selected",
          resources: [
            {
              kind: "repository",
              uri: readOnlyRepository.cloneUrl,
              ref: readOnlyRepository.defaultBranch,
              githubInstallationId: installationId,
              githubRepositoryId: readOnlyRepository.id,
            },
          ],
        }),
      },
    );
    expect(deniedReadOnlySession.status).toBe(422);

    const unlink = await app.request(
      workspacePath(firstWorkspaceId, `/github/installations/${installationId}`),
      {
        method: "DELETE",
      },
    );
    expect(unlink.status).toBe(204);
    expect(await listGitHubInstallationAccessForWorkspace(dbClient.db, firstWorkspaceId)).toEqual(
      [],
    );
    expect(
      await listGitHubInstallationAccessForWorkspace(dbClient.db, secondWorkspace.id),
    ).toMatchObject([{ installationId, repositoryIds: [adminRepository.id] }]);

    const disconnectedSession = await app.request(workspacePath(firstWorkspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "This repository is no longer authorized",
        resources: [
          {
            kind: "repository",
            uri: adminRepository.cloneUrl,
            ref: adminRepository.defaultBranch,
            githubInstallationId: installationId,
            githubRepositoryId: adminRepository.id,
          },
        ],
      }),
    });
    expect(disconnectedSession.status).toBe(422);
    const connectedSession = await app.request(workspacePath(secondWorkspace.id, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "This repository remains authorized",
        resources: [
          {
            kind: "repository",
            uri: adminRepository.cloneUrl,
            ref: adminRepository.defaultBranch,
            githubInstallationId: installationId,
            githubRepositoryId: adminRepository.id,
          },
        ],
      }),
    });
    expect(connectedSession.status).toBe(202);
    const connected = (await connectedSession.json()) as { id: string };

    const initialWorkspaceGrant = refreshedContext.workspaceGrants.find(
      (candidate) => candidate.workspaceId === firstWorkspaceId,
    );
    expect(initialWorkspaceGrant).toBeTruthy();
    const workspaceGrant = {
      ...initialWorkspaceGrant!,
      workspaceId: secondWorkspace.id,
    };
    const staleTokenMcp = buildOpenGeniMcpServer(
      {
        settings,
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: new FakeWorkflowClient(),
        objectStorage: null,
        githubStateSecret: "test-downstream-token-state-secret",
        githubAppApi,
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by the GitHub token retirement test");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      {
        ...workspaceGrant!,
        metadata: {
          sessionId: connected.id,
          firstPartyMcpTools: ["github_token"],
        },
      },
    );
    await expect(callMcpTool(staleTokenMcp, "github_token", {})).rejects.toThrow(
      "MCP tool not registered: github_token",
    );
  });

  test("configured-token browser handoff preserves OpenGeni grant but still requires GitHub owner proof", async () => {
    const stateSecret = "github-owner-authority-state";
    const delegationSecret = "test-delegation-secret";
    const installationId = 438826628;
    const grant = await bootstrapMcpGrant(dbClient.db);
    const managerBearer = await signDelegatedBearer(delegationSecret, grant, {
      subjectId: grant.subjectId,
      permissions: [...grant.permissions, "github:manage"],
    });
    const useOnlyBearer = await signDelegatedBearer(delegationSecret, grant, {
      subjectId: `${grant.subjectId}:use-only`,
      permissions: ["github:use"],
    });
    const authHeaderName = ["author", "ization"].join("");
    const responseStateHeaderName = ["set", "cookie"].join("-");
    const requestStateHeaderName = ["coo", "kie"].join("");
    let authorityCalls = 0;
    const repository = {
      id: 4001,
      installationId,
      fullName: "configured-owner/repository",
      name: "repository",
      private: true,
      htmlUrl: "https://github.com/configured-owner/repository",
      cloneUrl: "https://github.com/configured-owner/repository.git",
      defaultBranch: "main",
      accountLogin: "configured-owner",
      accountType: "User",
    };
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        publicBaseUrl: "https://api.opengeni.test",
        githubAppId: "12345",
        githubClientId: "test-client-id",
        githubClientSecret: "test-client-secret",
        githubAppSlug: "opengeni-test-app",
        githubAppPrivateKey: "test-private-key",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      githubStateSecret: stateSecret,
      githubAppApi: {
        discoverInstallationBindingCandidates: async () => [],
        authorizeInstallationBinding: async () => {
          authorityCalls += 1;
          return {
            actorId: 801,
            actorLogin: "configured-owner",
            authorityKind: "personal_owner" as const,
            installation: {
              installationId,
              accountId: 801,
              accountLogin: "configured-owner",
              accountType: "User",
              suspended: false,
            },
            repositories: [repository],
          };
        },
        listRepositories: async () => [repository],
      },
    });

    const managerInfo = (await (
      await app.request(workspacePath(grant.workspaceId, "/github/app"), {
        headers: { [authHeaderName]: managerBearer },
      })
    ).json()) as { status: string; installUrl: string | null };
    expect(managerInfo.status).toBe("unbound");
    expect(managerInfo.installUrl).not.toBeNull();
    const useOnlyInfo = (await (
      await app.request(workspacePath(grant.workspaceId, "/github/app"), {
        headers: { [authHeaderName]: useOnlyBearer },
      })
    ).json()) as { status: string; installUrl: string | null };
    expect(useOnlyInfo).toMatchObject({ status: "unbound", installUrl: null });

    const connect = await app.request(managerInfo.installUrl!);
    expect(connect.status).toBe(302);
    const discoveryState = new URL(connect.headers.get("location")!).searchParams.get("state")!;
    const discoveryStateHeader = connect.headers.get(responseStateHeaderName)!.split(";", 1)[0]!;
    const discovery = await app.request(
      `/v1/github/oauth/callback?code=discover-configured-owner&state=${encodeURIComponent(discoveryState)}`,
      { headers: { [requestStateHeaderName]: discoveryStateHeader } },
    );
    expect(discovery.status).toBe(302);
    const installLocation = new URL(discovery.headers.get("location")!);
    expect(installLocation.origin + installLocation.pathname).toBe(
      "https://github.com/apps/opengeni-test-app/installations/new",
    );
    const installState = installLocation.searchParams.get("state")!;
    const installStateHeader = discovery.headers.get(responseStateHeaderName)!.split(";", 1)[0]!;
    const setup = await app.request(
      `/v1/github/setup?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(installState)}`,
      { headers: { [requestStateHeaderName]: installStateHeader } },
    );
    expect(setup.status).toBe(302);
    const oauthState = new URL(setup.headers.get("location")!).searchParams.get("state")!;
    const oauthStateHeader = setup.headers.get(responseStateHeaderName)!.split(";", 1)[0]!;
    const callback = await app.request(
      `/v1/github/oauth/callback?code=fresh-configured-owner&state=${encodeURIComponent(oauthState)}`,
      { headers: { [requestStateHeaderName]: oauthStateHeader } },
    );
    expect(callback.status).toBe(200);
    expect(authorityCalls).toBe(1);
    expect(
      await listGitHubInstallationAccessForWorkspace(dbClient.db, grant.workspaceId),
    ).toMatchObject([
      {
        installationId,
        githubAccountId: 801,
        authorityKind: "personal_owner",
        repositoryIds: [repository.id],
      },
    ]);
  });

  // Source preparation, scope isolation, and agent MCP publication/review are
  // exercised against real Postgres in apps/api/test/knowledge-*.test.ts. These
  // HTTP checks pin the cutover and public entry lifecycle, replacing the old
  // document-index and Memory authoring API fixtures.
  test("retired Memory and document search routes direct callers to Knowledge", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await defaultAccessContext(app);
    const workspaceId = access.defaultWorkspaceId!;
    for (const [method, path] of [
      ["GET", "/knowledge/memories"],
      ["POST", "/knowledge/memories"],
      ["POST", "/knowledge/search"],
    ] as const) {
      const response = await app.request(workspacePath(workspaceId, path), {
        method,
        ...(method === "POST"
          ? { body: "{}", headers: { "content-type": "application/json" } }
          : {}),
      });
      expect(response.status).toBe(410);
    }
  });

  test("Knowledge HTTP retains exact sources, groups findings, and preserves correction history", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await defaultAccessContext(app);
    const base = workspacePath(access.defaultWorkspaceId!, "/knowledge/entries");
    const save = async (entryId: string, expectedVersion: number, entry: unknown) => {
      const response = await app.request(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          entryId,
          expectedVersion,
          scope: "workspace",
          entry,
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { revisionId: string; outcome: string };
    };
    const groupId = crypto.randomUUID();
    await save(groupId, 0, {
      title: "Network operations",
      kind: "group",
      content: "Network policies and incidents",
    });
    const sourceId = crypto.randomUUID();
    const text =
      "NETWORK RUNBOOK\n  Fix private endpoint failures by updating the network policy.\n";
    const source = await save(sourceId, 0, {
      title: "Network runbook",
      kind: "source",
      content: text,
      source: { kind: "manual", retention: "full_text" },
      groupIds: [groupId],
    });
    expect(source.outcome).toBe("published");
    const entryId = crypto.randomUUID();
    const entry = {
      title: "Private endpoint recovery",
      kind: "incident",
      content: "Update the network policy.",
      groupIds: [groupId],
      evidence: [
        {
          entryId: sourceId,
          revisionId: source.revisionId,
          quote: "Fix private endpoint failures by updating the network policy.",
        },
      ],
    };
    await save(entryId, 0, entry);
    const found = (await (await app.request(`${base}?query=endpoint&mode=keyword`)).json()) as {
      entries: { id: string }[];
    };
    expect(found.entries.map((item) => item.id)).toContain(entryId);
    const members = (await (await app.request(`${base}?groupId=${groupId}`)).json()) as {
      entries: { id: string }[];
    };
    expect(members.entries.map((item) => item.id).sort()).toEqual([sourceId, entryId].sort());
    await save(entryId, 1, {
      ...entry,
      content: "Update the network policy and verify endpoint connectivity.",
    });
    const current = (await (await app.request(`${base}/${entryId}`)).json()) as {
      revision: { entry: { content: string; evidence: { revisionId: string }[] } };
    };
    expect(current.revision.entry.content).toContain("verify endpoint connectivity");
    expect(current.revision.entry.evidence[0]?.revisionId).toBe(source.revisionId);
    const original = (await (await app.request(`${base}/${sourceId}`)).json()) as {
      revision: { entry: { content: string } };
    };
    expect(original.revision.entry.content).toBe(text);
    const history = await app.request(`${base}/${entryId}/history`);
    expect(history.status).toBe(200);
    expect(JSON.stringify(await history.json())).toContain("Update the network policy.");
  });

  test("manages workspace environments with write-only values", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const name = `staging-${crypto.randomUUID()}`;
    const createdResponse = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "staging secrets",
        variables: [
          { name: "API_TOKEN", value: "tok-write-only-123456" },
          { name: "DB_PASSWORD", value: "p4ssw0rd-write-only" },
        ],
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      name: string;
      variables: Array<{ name: string; version: number }>;
    };
    expect(created.name).toBe(name);
    expect(created.variables.map((variable) => variable.name).sort()).toEqual([
      "API_TOKEN",
      "DB_PASSWORD",
    ]);
    expect(created.variables.every((variable) => variable.version === 1)).toBe(true);
    expect(JSON.stringify(created)).not.toContain("tok-write-only-123456");
    expect(JSON.stringify(created)).not.toContain("p4ssw0rd-write-only");

    const reserved = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `reserved-${crypto.randomUUID()}`,
        variables: [{ name: "GH_TOKEN", value: "stolen-platform-token" }],
      }),
    });
    expect(reserved.status).toBe(422);
    expect(await reserved.text()).toContain("reserved environment variable name: GH_TOKEN");

    const duplicate = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(duplicate.status).toBe(409);

    const listed = await app.request(workspacePath(workspaceId, "/environments"));
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as Array<{ id: string }>;
    expect(listedBody.some((environment) => environment.id === created.id)).toBe(true);
    expect(JSON.stringify(listedBody)).not.toContain("tok-write-only-123456");
    const canonicalListed = await app.request(workspacePath(workspaceId, "/variable-sets"));
    expect(canonicalListed.status).toBe(200);
    const canonicalListedBody = (await canonicalListed.json()) as Array<{
      id: string;
    }>;
    expect(canonicalListedBody).toEqual(listedBody);

    const rotated = await app.request(
      workspacePath(workspaceId, `/environments/${created.id}/variables/API_TOKEN`),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "tok-rotated-654321" }),
      },
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      name: string;
      version: number;
    };
    expect(rotatedBody).toMatchObject({ name: "API_TOKEN", version: 2 });
    expect(JSON.stringify(rotatedBody)).not.toContain("tok-rotated-654321");

    const storedRows = await dbClient.db.execute(dbSql<{
      value_encrypted: string;
    }>`
      select value_encrypted from workspace_variable_set_variables
      where variable_set_id = ${created.id} and name = 'API_TOKEN'
    `);
    expect(storedRows[0]?.value_encrypted).toStartWith("v2:");
    expect(storedRows[0]?.value_encrypted).not.toContain("tok-rotated-654321");

    const renamed = await app.request(workspacePath(workspaceId, `/environments/${created.id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${name}-renamed`, description: null }),
    });
    expect(renamed.status).toBe(200);
    expect(
      ((await renamed.json()) as { name: string; description: string | null }).description,
    ).toBeNull();

    const deletedVariable = await app.request(
      workspacePath(workspaceId, `/environments/${created.id}/variables/DB_PASSWORD`),
      { method: "DELETE" },
    );
    expect(deletedVariable.status).toBe(200);
    const deletedAgain = await app.request(
      workspacePath(workspaceId, `/environments/${created.id}/variables/DB_PASSWORD`),
      { method: "DELETE" },
    );
    expect(deletedAgain.status).toBe(404);

    const missing = await app.request(
      workspacePath(workspaceId, `/environments/${crypto.randomUUID()}`),
    );
    expect(missing.status).toBe(404);

    const audited = await dbClient.db.execute(dbSql<{ count: string }>`
      select count(*)::text as count from audit_events
      where target_id = ${created.id} and action like 'variable_set.%'
    `);
    expect(Number(audited[0]?.count ?? 0)).toBeGreaterThanOrEqual(4);
    const auditedPayloads = await dbClient.db.execute(dbSql<{
      metadata: unknown;
    }>`
      select metadata from audit_events where target_id = ${created.id}
    `);
    expect(JSON.stringify(auditedPayloads)).not.toContain("tok-rotated-654321");

    const deletedEnvironment = await app.request(
      workspacePath(workspaceId, `/environments/${created.id}`),
      { method: "DELETE" },
    );
    expect(deletedEnvironment.status).toBe(200);
  });

  test("returns 503 for environment writes and attachments without the encryption key", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const createResponse = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `nokey-${crypto.randomUUID()}` }),
    });
    expect(createResponse.status).toBe(503);
    const createError = (await createResponse.json()) as {
      error: { code: string };
    };
    expect(createError.error.code).toBe("upstream_unavailable");
    expect(JSON.stringify(createError)).not.toContain("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");

    const sessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "attach",
        environmentId: crypto.randomUUID(),
      }),
    });
    expect(sessionResponse.status).toBe(503);
  });

  test("attaches environments to sessions at creation with names-only events", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const environment = await createTestEnvironment(app, workspaceId, {
      variables: [{ name: "SERVICE_TOKEN", value: "session-secret-abcdef" }],
    });

    const unknownAttachment = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "attach",
        environmentId: crypto.randomUUID(),
      }),
    });
    expect(unknownAttachment.status).toBe(422);
    expect(await unknownAttachment.text()).toContain("unknown variableSetId");

    const sessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "attach",
        environmentId: environment.id,
      }),
    });
    expect(sessionResponse.status).toBe(202);
    const session = (await sessionResponse.json()) as {
      id: string;
      environmentId: string | null;
    };
    expect(session.environmentId).toBe(environment.id);

    const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
    const createdEvent = events.find((event) => event.type === "session.created");
    expect(createdEvent?.payload).toMatchObject({
      variableSetId: environment.id,
      variableSetName: environment.name,
    });
    expect(JSON.stringify(events)).not.toContain("session-secret-abcdef");
  });

  test("keeps every session attachment fenced until an explicit quiescent detach", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);

    const createAttachedSession = async (status: SessionStatus) => {
      const environment = await createTestEnvironment(app, workspaceId, {});
      const response = await app.request(workspacePath(workspaceId, "/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialMessage: `deletion fence ${status}`,
          environmentId: environment.id,
        }),
      });
      expect(response.status).toBe(202);
      const session = (await response.json()) as {
        id: string;
        environmentId: string | null;
      };
      if (status !== "queued") {
        await setSessionStatus(dbClient.db, workspaceId, session.id, status, null);
      }
      return { environment, session };
    };

    for (const status of [
      "queued",
      "running",
      "requires_action",
      "recovering",
      "waiting_capacity",
      "idle",
      "failed",
      "cancelled",
    ] as const) {
      const { environment, session } = await createAttachedSession(status);
      const blocked = await app.request(
        workspacePath(workspaceId, `/environments/${environment.id}`),
        { method: "DELETE" },
      );
      expect(blocked.status).toBe(409);
      expect(await blocked.text()).toContain("session");
      const retained = await app.request(workspacePath(workspaceId, `/sessions/${session.id}`));
      expect(((await retained.json()) as { environmentId: string | null }).environmentId).toBe(
        environment.id,
      );

      await setSessionStatus(dbClient.db, workspaceId, session.id, "cancelled", null);
      await settleSessionTurnsForVariableSetDetach(dbClient.db, workspaceId, session.id);
      const detached = await app.request(
        workspacePath(workspaceId, `/sessions/${session.id}/variable-sets`),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ variableSetIds: [] }),
        },
      );
      expect(detached.status).toBe(200);
      expect(
        ((await detached.json()) as { environmentId: string | null }).environmentId,
      ).toBeNull();
      const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
      expect(events.filter((event) => event.type === "session.variable_sets.updated")).toHaveLength(
        1,
      );
      const cleanup = await app.request(
        workspacePath(workspaceId, `/environments/${environment.id}`),
        { method: "DELETE" },
      );
      expect(cleanup.status).toBe(200);
    }
  });

  test("enforces environment permissions for management and attachment", async () => {
    const delegationSecret = "test-environments-permission-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        delegationSecret,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const grant = await bootstrapMcpGrant(dbClient.db);
    const signToken = async (permissions: Permission[]) =>
      `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        permissions,
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}`;
    const adminAuth = {
      authorization: await signToken(allWorkspacePermissions),
    };
    const limitedAuth = {
      authorization: await signToken([
        "workspace:read",
        "sessions:create",
        "sessions:read",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
      ]),
    };

    const forbiddenCreate = await app.request(workspacePath(grant.workspaceId, "/environments"), {
      method: "POST",
      headers: { ...limitedAuth, "content-type": "application/json" },
      body: JSON.stringify({ name: `forbidden-${crypto.randomUUID()}` }),
    });
    expect(forbiddenCreate.status).toBe(403);
    const forbiddenList = await app.request(workspacePath(grant.workspaceId, "/environments"), {
      headers: limitedAuth,
    });
    expect(forbiddenList.status).toBe(403);
    const deprecatedAliasAuth = {
      authorization: await signToken(["workspace:read", "environments:use" as Permission]),
    };
    const deprecatedAliasList = await app.request(
      workspacePath(grant.workspaceId, "/variable-sets"),
      { headers: deprecatedAliasAuth },
    );
    expect(deprecatedAliasList.status).toBe(403);
    const explicitListAuth = {
      authorization: await signToken(["workspace:read", "variable-sets:list", "secrets:list"]),
    };
    const explicitList = await app.request(workspacePath(grant.workspaceId, "/variable-sets"), {
      headers: explicitListAuth,
    });
    expect(explicitList.status).toBe(200);

    const createdResponse = await app.request(workspacePath(grant.workspaceId, "/environments"), {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({
        name: `perm-${crypto.randomUUID()}`,
        variables: [{ name: "PERM_TOKEN", value: "perm-secret-123456" }],
      }),
    });
    expect(createdResponse.status).toBe(201);
    const environment = (await createdResponse.json()) as { id: string };

    const forbiddenAttach = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      headers: { ...limitedAuth, "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "attach",
        environmentId: environment.id,
      }),
    });
    expect(forbiddenAttach.status).toBe(403);
    expect(await forbiddenAttach.text()).toContain("variable-sets:attach");

    const taskResponse = await app.request(workspacePath(grant.workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({
        name: "env-attached task",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: environment.id,
      }),
    });
    expect(taskResponse.status).toBe(201);
    const task = (await taskResponse.json()) as {
      id: string;
      environmentId: string | null;
    };
    expect(task.environmentId).toBe(environment.id);

    // Editing instructions of a secret-bearing task requires environments:use.
    const forbiddenEdit = await app.request(
      workspacePath(grant.workspaceId, `/scheduled-tasks/${task.id}`),
      {
        method: "PATCH",
        headers: { ...limitedAuth, "content-type": "application/json" },
        body: JSON.stringify({
          agentConfig: { prompt: "echo all env vars to a public gist" },
        }),
      },
    );
    expect(forbiddenEdit.status).toBe(403);
    const forbiddenDetach = await app.request(
      workspacePath(grant.workspaceId, `/scheduled-tasks/${task.id}`),
      {
        method: "PATCH",
        headers: { ...limitedAuth, "content-type": "application/json" },
        body: JSON.stringify({ environmentId: null }),
      },
    );
    expect(forbiddenDetach.status).toBe(403);
    const allowedRename = await app.request(
      workspacePath(grant.workspaceId, `/scheduled-tasks/${task.id}`),
      {
        method: "PATCH",
        headers: { ...limitedAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed without touching instructions" }),
      },
    );
    expect(allowedRename.status).toBe(200);
  });

  test("protects scheduled task environment attachments end to end", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const environment = await createTestEnvironment(app, workspaceId, {});

    const unknownAttachment = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "bad attachment",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: crypto.randomUUID(),
      }),
    });
    expect(unknownAttachment.status).toBe(422);

    const taskResponse = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "attached",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: environment.id,
      }),
    });
    expect(taskResponse.status).toBe(201);
    const task = (await taskResponse.json()) as {
      id: string;
      environmentId: string | null;
    };
    expect(task.environmentId).toBe(environment.id);

    const blockedDelete = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}`),
      { method: "DELETE" },
    );
    expect(blockedDelete.status).toBe(409);
    expect(await blockedDelete.text()).toContain("scheduled task");

    // A task with a live reusable session cannot change its attachment.
    const sessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "reusable",
        environmentId: environment.id,
      }),
    });
    const reusableSession = (await sessionResponse.json()) as { id: string };
    await updateScheduledTask(dbClient.db, workspaceId, task.id, {
      runMode: "reusable_session",
      reusableSessionId: reusableSession.id,
    });
    const blockedDetach = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentId: null }),
      },
    );
    expect(blockedDetach.status).toBe(409);
    expect(await blockedDetach.text()).toContain("reusable session");

    // The reviewer-flagged scenario: an idle reusable session cannot be
    // silently detached because the task's own RESTRICT-backed attachment
    // still blocks deletion regardless of session status.
    await setSessionStatus(dbClient.db, workspaceId, reusableSession.id, "idle", null);
    const blockedWhileTaskAttached = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}`),
      { method: "DELETE" },
    );
    expect(blockedWhileTaskAttached.status).toBe(409);
    expect(await blockedWhileTaskAttached.text()).toContain("scheduled task");

    await updateScheduledTask(dbClient.db, workspaceId, task.id, {
      runMode: "new_session_per_run",
      reusableSessionId: null,
    });
    const detach = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentId: null }),
    });
    expect(detach.status).toBe(200);
    expect(((await detach.json()) as { environmentId: string | null }).environmentId).toBeNull();
    // The still-attached idle reusable session remains a live attachment even
    // after the task detaches. Terminal settlement alone cannot bypass lease
    // rotation, event, and audit evidence: detach through the session route.
    await setSessionStatus(dbClient.db, workspaceId, reusableSession.id, "failed", null);
    const blockedBySession = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}`),
      { method: "DELETE" },
    );
    expect(blockedBySession.status).toBe(409);
    expect(await blockedBySession.text()).toContain("session");
    await settleSessionTurnsForVariableSetDetach(dbClient.db, workspaceId, reusableSession.id);
    const sessionDetach = await app.request(
      workspacePath(workspaceId, `/sessions/${reusableSession.id}/variable-sets`),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variableSetIds: [] }),
      },
    );
    expect(sessionDetach.status).toBe(200);
    const deleteResponse = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}`),
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
  });

  test("MCP scheduled task tools require independent Variable Set attach and use permissions", async () => {
    workflow = new FakeWorkflowClient();
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      environmentsEncryptionKey: environmentsTestKey,
    });
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpDeps = {
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by environment MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const adminMcp = buildOpenGeniMcpServer(mcpDeps, grant);
    const environment = await createWorkspaceEnvironment(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: `mcp-env-${crypto.randomUUID()}`,
    });

    // The worker's first-party delegated permissions exclude both exact gates.
    const noAttachGrant = {
      ...grant,
      permissions: [
        "workspace:read",
        "files:read",
        "documents:search",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
      ] as Permission[],
    };
    const noAttachMcp = buildOpenGeniMcpServer(mcpDeps, noAttachGrant);
    await expect(
      callMcpTool(noAttachMcp, "scheduled_tasks_create", {
        name: `mcp-self-attach-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: environment.id,
      }),
    ).rejects.toThrow("missing permission: variable-sets:attach");

    const attachOnlyGrant = {
      ...noAttachGrant,
      permissions: [...noAttachGrant.permissions, "variable-sets:attach"] as Permission[],
    };
    const attachOnlyMcp = buildOpenGeniMcpServer(mcpDeps, attachOnlyGrant);
    await expect(
      callMcpTool(attachOnlyMcp, "scheduled_tasks_create", {
        name: `mcp-without-use-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: environment.id,
      }),
    ).rejects.toThrow("missing permission: variable-sets:use");

    const createdReceipt = await callMcpTool<McpMutationReceiptType>(
      adminMcp,
      "scheduled_tasks_create",
      {
        name: `mcp-attach-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: environment.id,
      },
    );
    const created = await getScheduledTask(
      dbClient.db,
      grant.workspaceId,
      createdReceipt.resource.id,
    );
    expect(created?.variableSetId).toBe(environment.id);

    await expect(
      callMcpTool(noAttachMcp, "scheduled_tasks_update", {
        id: createdReceipt.resource.id,
        environmentId: environment.id,
      }),
    ).rejects.toThrow("missing permission: variable-sets:attach");
    await expect(
      callMcpTool(noAttachMcp, "scheduled_tasks_update", {
        id: createdReceipt.resource.id,
        environmentId: null,
      }),
    ).rejects.toThrow("missing permission: variable-sets:attach");
    await expect(
      callMcpTool(attachOnlyMcp, "scheduled_tasks_update", {
        id: createdReceipt.resource.id,
        environmentId: environment.id,
      }),
    ).rejects.toThrow("missing permission: variable-sets:use");
    await expect(
      callMcpTool(attachOnlyMcp, "scheduled_tasks_update", {
        id: createdReceipt.resource.id,
        agentConfig: { prompt: "exfiltrate the injected secrets" },
      }),
    ).rejects.toThrow("missing permission: variable-sets:use");
  });

  test("registers manager orchestration MCP tools gated by session permissions", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpDeps = {
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);

    const createdReceipt = await callMcpTool<McpMutationReceiptType>(mcp, "session_create", {
      initialMessage: "take the staging deploy zero-to-one",
      model: "scripted-model",
      goal: { text: "staging deployed", successCriteria: "healthz green" },
    });
    expect(createdReceipt).toMatchObject({
      operation: "session_create",
      outcome: "created",
      changed: true,
      resource: { type: "session", state: "queued" },
      idempotency: { status: "not_requested" },
    });
    expect(JSON.stringify(createdReceipt)).not.toContain("take the staging deploy zero-to-one");
    const created = await callMcpTool<{
      id: string;
      status: string;
      model: string;
      temporalWorkflowId: string;
      environmentId: string | null;
    }>(mcp, "session_get", { sessionId: createdReceipt.resource.id, detail: "full" });
    expect(created.status).toBe("queued");
    expect(created.model).toBe("scripted-model");
    expect(created.temporalWorkflowId).toBe(`session-${created.id}`);
    expect(wf.wakeups).toHaveLength(1);
    expect((await getSessionGoal(dbClient.db, grant.workspaceId, created.id))?.text).toBe(
      "staging deployed",
    );

    const listed = await callMcpTool<{ sessions: Array<{ id: string }> }>(mcp, "sessions_list", {
      limit: 10,
    });
    expect(listed.sessions.some((session) => session.id === created.id)).toBe(true);

    const fetched = await callMcpTool<{
      id: string;
      environmentId: string | null;
    }>(mcp, "session_get", { sessionId: created.id, detail: "full" });
    expect(fetched.id).toBe(created.id);
    expect(fetched.environmentId).toBeNull();
    const compact = await callMcpTool<{ id: string; goal: { status: string; summary: string } }>(
      mcp,
      "session_get",
      { sessionId: created.id },
    );
    expect(compact.goal).toEqual({ status: "active", summary: "staging deployed" });
    expect(compact).not.toHaveProperty("effectiveToolPolicy");
    expect(compact).not.toHaveProperty("initialMessage");
    await expect(
      callMcpTool(mcp, "session_get", { sessionId: crypto.randomUUID() }),
    ).rejects.toThrow("session not found");

    const conversation = await callMcpTool<{ view: string; events: unknown[] }>(
      mcp,
      "session_events",
      { sessionId: created.id },
    );
    expect(conversation.view).toBe("conversation");
    expect(conversation.events).toEqual([]);
    const timeline = await callMcpTool<{
      events: Array<{ type: string; sequence: number }>;
      direction: "before";
      nextBefore: number;
      nextAfter: null;
    }>(mcp, "session_events", { sessionId: created.id, view: "debug" });
    // The MCP monitoring read omits the human prompt while its turn is unclaimed;
    // the exact row remains in forensic mode and in the REST events API.
    expect(timeline.events.map((event) => event.type)).toEqual([
      "session.created",
      "goal.set",
      "session.status.changed",
      "turn.queued",
    ]);
    expect(JSON.stringify(timeline.events)).not.toContain("take the staging deploy zero-to-one");
    const forensicTimeline = await callMcpTool<{ events: Array<{ type: string }> }>(
      mcp,
      "session_events",
      { sessionId: created.id, mode: "forensic", payloadMode: "full" },
    );
    expect(forensicTimeline.events.map((event) => event.type)).toEqual([
      "session.created",
      "goal.set",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    expect(timeline.direction).toBe("before");
    expect(timeline.nextBefore).toBe(timeline.events[0]!.sequence);
    expect(timeline.nextAfter).toBeNull();
    const lastTimelineSequence = timeline.events[timeline.events.length - 1]!.sequence;
    const caughtUp = await callMcpTool<{
      events: unknown[];
      direction: "after";
      nextAfter: number;
    }>(mcp, "session_events", {
      sessionId: created.id,
      after: lastTimelineSequence,
      view: "debug",
    });
    expect(caughtUp.events).toHaveLength(0);
    expect(caughtUp.direction).toBe("after");
    expect(caughtUp.nextAfter).toBe(lastTimelineSequence);

    const appended = await appendSessionEvents(dbClient.db, grant.workspaceId, created.id, [
      ...Array.from({ length: 30 }, (_, index) => ({
        type: "agent.message.completed" as const,
        payload: { index, text: "x".repeat(7_000) },
      })),
      {
        type: "turn.completed" as const,
        payload: { result: "stale" },
        turnGeneration: 1,
      },
      {
        type: "turn.completed" as const,
        payload: { result: "authoritative" },
        turnGeneration: 2,
      },
    ]);
    const latestTerminal = await callMcpTool<{
      events: Array<{
        sequence: number;
        type: string;
        turnGeneration: number | null;
        payload: { result: string };
      }>;
    }>(mcp, "session_events", { sessionId: created.id, latest: "terminal" });
    expect(latestTerminal.events).toEqual([
      expect.objectContaining({
        sequence: appended.at(-1)!.sequence,
        type: "turn.completed",
        turnGeneration: 2,
        payload: { result: "authoritative" },
      }),
    ]);

    const boundedForensic = await callMcpTool<{
      events: Array<{ id: string; sequence: number }>;
      direction: "after";
      nextAfter: number;
      hasMore: boolean;
      truncated: boolean;
      truncation: { reasons: string[]; resumeCursor: number };
      bytes: number;
      maxBytes: number;
    }>(mcp, "session_events", {
      sessionId: created.id,
      after: lastTimelineSequence,
      mode: "forensic",
      payloadMode: "full",
      limit: 40,
    });
    expect(boundedForensic.bytes).toBe(
      Buffer.byteLength(JSON.stringify(boundedForensic, null, 2), "utf8"),
    );
    expect(boundedForensic.bytes).toBeLessThanOrEqual(boundedForensic.maxBytes);
    expect(boundedForensic.maxBytes).toBe(64 * 1024);
    expect(boundedForensic.hasMore).toBeTrue();
    expect(boundedForensic.truncated).toBeTrue();
    expect(boundedForensic.truncation.reasons).toEqual(
      expect.arrayContaining(["model_payload", "model_bytes"]),
    );
    expect(boundedForensic.nextAfter).toBe(boundedForensic.events.at(-1)!.sequence);
    expect(boundedForensic.truncation.resumeCursor).toBe(boundedForensic.nextAfter);
    expect(
      boundedForensic.events.every((event) => event.id !== "00000000-0000-0000-0000-000000000000"),
    ).toBeTrue();

    const sent = await callMcpTool<McpMutationReceiptType>(mcp, "session_send_message", {
      sessionId: created.id,
      text: "also enable the health alerts",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(sent).toMatchObject({
      operation: "session_send_message",
      outcome: "accepted",
      resource: { type: "session_turn", state: "queued" },
      idempotency: { status: "applied" },
    });
    expect(JSON.stringify(sent)).not.toContain("also enable the health alerts");
    await waitFor(() => wf.wakeups.length === 2);
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, created.id);
    expect(turns.some((turn) => turn.id === sent.resource.id && turn.status === "queued")).toBe(
      true,
    );

    const callerAttemptId = crypto.randomUUID();
    const callerClaim = await claimSessionWorkForAttempt(dbClient.db, grant.workspaceId, {
      sessionId: created.id,
      workflowId: `session-${created.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: callerAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (callerClaim.action !== "claimed") {
      throw new Error(`manager MCP caller was not claimed: ${callerClaim.reason}`);
    }
    const workerMcpWithIdentity = buildOpenGeniMcpServer(mcpDeps, {
      ...grant,
      metadata: {
        delegated: true,
        sessionId: created.id,
        turnId: callerClaim.turn.id,
        attemptId: callerAttemptId,
        executionGeneration: callerClaim.turn.executionGeneration,
        firstPartyMcpTools: [
          "session_send_message",
          "session_create",
          "session_pause",
          "session_resume",
          "session_steer",
        ],
      },
    });
    const beforeInternalTurnIds = (
      await listSessionTurns(dbClient.db, grant.workspaceId, created.id)
    )
      .map((turn) => turn.id)
      .sort();
    const internal = await callMcpTool<McpMutationReceiptType>(
      workerMcpWithIdentity,
      "session_send_message",
      {
        sessionId: created.id,
        text: "child result one of several",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(internal).toMatchObject({
      outcome: "accepted",
      resource: { type: "session_system_update", state: "active" },
      facts: { delivery: "coalesced_internal_update" },
    });
    expect(JSON.stringify(internal)).not.toContain("child result one of several");
    expect(
      (await listSessionTurns(dbClient.db, grant.workspaceId, created.id))
        .map((turn) => turn.id)
        .sort(),
    ).toEqual(beforeInternalTurnIds);
    expect(
      await listOutstandingSessionSystemUpdates(dbClient.db, grant.workspaceId, created.id),
    ).toEqual([
      expect.objectContaining({
        id: internal.resource.id,
        kind: "agent_message",
        sourceId: created.id,
        summary: "child result one of several",
      }),
    ]);

    // Agent MCP owns the same recursive Pause/Resume plane as the UI. A live
    // descendant attempt receives an immediate revisioned control wake; Resume
    // creates no human prompt, and Agent Steer is one typed internal update
    // rather than a fake prompt-queue row.
    const controlledChild = await callMcpTool<McpMutationReceiptType>(
      workerMcpWithIdentity,
      "session_create",
      {
        initialMessage: "wait for manager control",
        title: "Manager-controlled child",
        model: "scripted-model",
      },
    );
    expect(
      await requireSession(dbClient.db, grant.workspaceId, controlledChild.resource.id),
    ).toMatchObject({
      title: "Manager-controlled child",
      titleSource: "agent",
    });
    expect(
      (await listSessionEvents(dbClient.db, grant.workspaceId, controlledChild.resource.id, 0, 10))
        .slice(0, 2)
        .map((event) => event.type),
    ).toEqual(["session.created", "session.title_set"]);
    const childAttemptId = crypto.randomUUID();
    const childClaim = await claimSessionWorkForAttempt(dbClient.db, grant.workspaceId, {
      sessionId: controlledChild.resource.id,
      workflowId: `session-${controlledChild.resource.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: childAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (childClaim.action !== "claimed") {
      throw new Error(`controlled child was not claimed: ${childClaim.reason}`);
    }
    const dispatchCountBeforeAgentPause = wf.wakeDispatches;
    const agentPause = await callMcpTool<McpMutationReceiptType>(
      workerMcpWithIdentity,
      "session_pause",
      {
        sessionId: controlledChild.resource.id,
        idempotencyKey: crypto.randomUUID(),
        reason: "manager inspection",
      },
    );
    expect(agentPause).toMatchObject({
      outcome: "updated",
      resource: { type: "session", state: "paused" },
      facts: { interruptionCount: 1 },
    });
    expect(JSON.stringify(agentPause)).not.toContain("manager inspection");
    await waitFor(() => wf.wakeDispatches === dispatchCountBeforeAgentPause + 1);
    const turnsBeforeAgentResume = await listSessionTurns(
      dbClient.db,
      grant.workspaceId,
      controlledChild.resource.id,
    );
    const agentResume = await callMcpTool<McpMutationReceiptType>(
      workerMcpWithIdentity,
      "session_resume",
      {
        sessionId: controlledChild.resource.id,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(agentResume.resource.state).toBe("active");
    expect(
      (await listSessionTurns(dbClient.db, grant.workspaceId, controlledChild.resource.id)).map(
        (turn) => turn.id,
      ),
    ).toEqual(turnsBeforeAgentResume.map((turn) => turn.id));
    const agentSteer = await callMcpTool<McpMutationReceiptType>(
      workerMcpWithIdentity,
      "session_steer",
      {
        sessionId: controlledChild.resource.id,
        instruction: "Inspect the new control-plane evidence first",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(agentSteer).toMatchObject({
      outcome: "updated",
      resource: { type: "session_system_update" },
      facts: { interruptionCount: 1, stoppingPreviousAttempt: true },
    });
    expect(JSON.stringify(agentSteer)).not.toContain(
      "Inspect the new control-plane evidence first",
    );
    expect(
      await listOutstandingSessionSystemUpdates(
        dbClient.db,
        grant.workspaceId,
        controlledChild.resource.id,
      ),
    ).toContainEqual(
      expect.objectContaining({
        id: agentSteer.resource.id,
        kind: "agent_steer_instruction",
        summary: "Inspect the new control-plane evidence first",
      }),
    );

    // The sandboxed worker's first-party delegated permission set sees none of
    // the manager tools: orchestration, environments, or the connect link.
    const workerGrant = {
      ...grant,
      permissions: [
        "workspace:read",
        "files:read",
        "documents:search",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
        "goals:manage",
      ] as Permission[],
    };
    const workerMcp = buildOpenGeniMcpServer(mcpDeps, workerGrant);
    for (const tool of [
      "sessions_list",
      "session_get",
      "session_events",
      "session_create",
      "session_send_message",
      "session_pause",
      "session_resume",
      "session_steer",
      "environment_list",
      "environment_set_variable",
      "github_connect_link",
    ]) {
      await expect(callMcpTool(workerMcp, tool, {})).rejects.toThrow("MCP tool not registered");
    }
  });

  test("MCP session_create returns a compact, truthful idempotent replay receipt", async () => {
    const workflowClient = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcp = buildOpenGeniMcpServer(
      {
        settings: testSettings({ databaseUrl: services.databaseUrl }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by session replay tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );
    const initialMessage = `idempotent secret ${crypto.randomUUID()}`;
    const idempotencyKey = `compact-receipt-session-create-${crypto.randomUUID()}`;
    const args = {
      initialMessage,
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      idempotencyKey,
    };

    const first = await callMcpTool<McpMutationReceiptType>(mcp, "session_create", args);
    const repaired = await callMcpTool<McpMutationReceiptType>(mcp, "session_create", args);

    expect(first).toMatchObject({
      operation: "session_create",
      outcome: "created",
      changed: true,
      idempotency: { status: "applied" },
      resource: { type: "session", state: "queued" },
    });
    expect(repaired).toMatchObject({
      operation: "session_create",
      committed: true,
      outcome: "repaired",
      changed: true,
      idempotency: { status: "applied" },
      resource: { type: "session", id: first.resource.id, state: "queued" },
    });
    const claimed = await claimSessionWorkForAttempt(dbClient.db, grant.workspaceId, {
      sessionId: first.resource.id,
      workflowId: `session-${first.resource.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    const replay = await callMcpTool<McpMutationReceiptType>(mcp, "session_create", args);
    expect(replay).toMatchObject({
      operation: "session_create",
      outcome: "replayed",
      changed: false,
      idempotency: { status: "replayed" },
      resource: { type: "session", id: first.resource.id },
    });
    expect(JSON.stringify(first)).not.toContain(initialMessage);
    expect(JSON.stringify(repaired)).not.toContain(initialMessage);
    expect(JSON.stringify(replay)).not.toContain(initialMessage);
    expect(await withWorkspaceCount(dbClient.db, grant.workspaceId, idempotencyKey)).toBe(1);
    expect(await requireSession(dbClient.db, grant.workspaceId, first.resource.id)).toMatchObject({
      id: first.resource.id,
      initialMessage,
      createIdempotencyKey: idempotencyKey,
    });
  });

  test("per-session first-party MCP permissions are capped by the creator and gate the manager tools", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    // Configured access mode: every request authenticates with a delegated
    // bearer token, so the grant the MCP endpoint sees is exactly the token's
    // permission set - the same shape the worker runtime uses live.
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      productAccessMode: "configured",
      delegationSecret,
    });
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
    });
    const signToken = async (permissions: Permission[]) =>
      await signDelegatedAccessToken(delegationSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: "test:first-party-mcp-permissions",
        permissions,
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1000) + 300,
      });

    // REST create: the permission set is stored and echoed; the creator must
    // hold every requested permission.
    const managerToken = await signToken([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "goals:manage",
    ]);
    const createResponse = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "orchestrate the fleet",
        model: "scripted-model",
        firstPartyMcpPermissions: [
          "workspace:read",
          "sessions:read",
          "sessions:create",
          "goals:manage",
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${managerToken}`,
      },
    });
    expect(createResponse.status).toBe(202);
    const managerSession = (await createResponse.json()) as {
      id: string;
      firstPartyMcpPermissions: string[] | null;
    };
    expect(managerSession.firstPartyMcpPermissions).toEqual([
      "workspace:read",
      "sessions:read",
      "sessions:create",
      "goals:manage",
    ]);
    expect(
      (await getSession(dbClient.db, grant.workspaceId, managerSession.id))
        ?.firstPartyMcpPermissions,
    ).toEqual([
      "workspace:read",
      "sessions:read",
      "sessions:create",
      "goals:manage",
    ] as Permission[]);

    // No escalation: a creator without the permission cannot mint it.
    const limitedToken = await signToken(["workspace:read", "sessions:create"]);
    const escalation = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "try to escalate",
        model: "scripted-model",
        firstPartyMcpPermissions: ["environments:manage"],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${limitedToken}`,
      },
    });
    expect(escalation.status).toBe(403);
    expect(await escalation.text()).toContain(
      "cannot grant first-party MCP permission beyond the creating grant: environments:manage",
    );

    // An empty set would sign an unusable zero-permission token; omit the
    // field for the default worker set instead.
    const emptySet = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "empty permission set",
        model: "scripted-model",
        firstPartyMcpPermissions: [],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${managerToken}`,
      },
    });
    expect(emptySet.status).toBe(422);
    expect(await emptySet.text()).toContain("firstPartyMcpPermissions must not be empty");

    // Same rule through the MCP session_create tool: a manager can only
    // delegate a subset of what it was itself granted.
    const mcpDeps = {
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const managerGrant = {
      ...grant,
      permissions: ["workspace:read", "sessions:create", "sessions:read"] as Permission[],
    };
    const managerMcp = buildOpenGeniMcpServer(mcpDeps, managerGrant);
    await expectMcpOrchestrationFailure(
      managerMcp,
      "session_create",
      {
        initialMessage: "spawn an over-privileged worker",
        model: "scripted-model",
        firstPartyMcpPermissions: ["environments:manage"],
      },
      "session_create_forbidden",
      "cannot grant first-party MCP permission beyond the creating grant",
    );
    const spawnedReceipt = await callMcpTool<McpMutationReceiptType>(managerMcp, "session_create", {
      initialMessage: "spawn a delegated worker",
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      firstPartyMcpPermissions: ["sessions:read"],
    });
    const spawned = await requireSession(
      dbClient.db,
      grant.workspaceId,
      spawnedReceipt.resource.id,
    );
    expect(spawned.firstPartyMcpPermissions).toEqual(["sessions:read"]);
    expect(spawned.sandboxBackend).toBe("none");

    // A worker-signed parent claim makes this a child create. Omitting the
    // override must inherit the manager's effective grant instead of widening
    // the child to OpenGeni's full standalone worker defaults.
    const childMcp = buildOpenGeniMcpServer(mcpDeps, {
      ...managerGrant,
      // Delegated permission arrays are semantically sets. Inheritance stores
      // one canonical copy even if an issuer supplied a duplicate.
      permissions: [...managerGrant.permissions, "sessions:read"],
      metadata: {
        sessionId: managerSession.id,
        firstPartyMcpTools: ["session_create"],
      },
    });
    const inheritedChildReceipt = await callMcpTool<McpMutationReceiptType>(
      childMcp,
      "session_create",
      {
        initialMessage: "inherit the manager boundary",
        model: "scripted-model",
        sandboxBackend: "none",
      },
    );
    const inheritedChild = await requireSession(
      dbClient.db,
      grant.workspaceId,
      inheritedChildReceipt.resource.id,
    );
    expect(inheritedChild.parentSessionId).toBe(managerSession.id);
    expect(inheritedChild.firstPartyMcpPermissions).toEqual([
      "workspace:read",
      "sessions:read",
      "sessions:create",
    ]);
    const managerAttempt = await claimCreatedSessionForRun(dbClient.db, grant, managerSession.id);

    // The delegated token the runtime mints for a session's first-party MCP
    // connection carries the session's permission and tool sets, which gate
    // manager visibility end to end. The second preparation deliberately uses
    // an explicit narrow worker policy rather than relying on broad defaults.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    let managerPrepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    let workerPrepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      const runtimeSettings = {
        ...appSettings,
        opengeniMcpInternalUrl: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
            timeoutMs: undefined,
            cacheToolsList: false,
          },
        ],
      };
      managerPrepared = await prepareAgentTools(
        runtimeSettings,
        [{ kind: "mcp", id: "opengeni" }],
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: managerSession.id,
          turnId: managerAttempt.turnId,
          attemptId: managerAttempt.attemptId,
          executionGeneration: managerAttempt.executionGeneration,
          firstPartyPermissions: [
            "workspace:read",
            "sessions:read",
            "sessions:create",
            "goals:manage",
          ],
          firstPartyTools: ["sessions_list", "session_create", "environment_set_variable"],
        },
      );
      const managerTools = (await managerPrepared.mcpServers[0]!.listTools()).map(
        (tool) => tool.name,
      );
      expect(managerTools).toContain("opengeni__sessions_list");
      expect(managerTools).toContain("opengeni__session_create");
      expect(managerTools).not.toContain("opengeni__set_child_notifications_mode");
      expect(managerTools).not.toContain("opengeni__environment_set_variable");

      workerPrepared = await prepareAgentTools(runtimeSettings, [{ kind: "mcp", id: "opengeni" }], {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: managerSession.id,
        turnId: managerAttempt.turnId,
        attemptId: managerAttempt.attemptId,
        executionGeneration: managerAttempt.executionGeneration,
        firstPartyPermissions: ["workspace:read", "sessions:control", "goals:manage"],
        firstPartyTools: [
          "set_session_title",
          "goal_set",
          "goal_update",
          "goal_complete",
          "goal_pause",
        ],
      });
      const workerTools = (await workerPrepared.mcpServers[0]!.listTools()).map(
        (tool) => tool.name,
      );
      expect(workerTools).toContain("opengeni__set_session_title");
      expect(workerTools).toContain("opengeni__goal_set");
      expect(workerTools).not.toContain("opengeni__sessions_list");
      expect(workerTools).not.toContain("opengeni__session_create");
      expect(workerTools).not.toContain("opengeni__set_child_notifications_mode");
      expect(workerTools).not.toContain("opengeni__environment_set_variable");
      expect(workerTools).not.toContain("opengeni__scheduled_tasks_list");
      expect(workerTools).not.toContain("opengeni__mcp_servers_attach");
    } finally {
      await managerPrepared?.close().catch(() => undefined);
      await workerPrepared?.close().catch(() => undefined);
      server.stop(true);
    }
  });

  test("per-session MCP servers are attach-gated, sanitized, rotatable credentials", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      productAccessMode: "configured",
      delegationSecret,
      environmentsEncryptionKey: environmentsTestKey,
    });
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
    });
    const signToken = async (permissions: Permission[]) =>
      `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: "test:session-mcp-servers",
        permissions,
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1000) + 300,
      })}`;
    const attachAuth = await signToken([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "mcp_servers:attach",
    ]);
    const limitedAuth = await signToken([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
    ]);

    const createSecret = "Bearer create-secret";
    const created = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use the crm server",
        model: "scripted-model",
        tools: [{ kind: "mcp", id: "crm" }],
        mcpServers: [
          {
            id: "crm",
            name: "CRM MCP",
            url: "https://crm.example/mcp",
            allowedTools: ["workouts.list"],
            timeoutMs: 2500,
            cacheToolsList: false,
            headers: { Authorization: createSecret },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: attachAuth,
      },
    });
    expect(created.status).toBe(202);
    const createText = await created.text();
    expect(createText).not.toContain(createSecret);
    const session = JSON.parse(createText) as {
      id: string;
      tools: Array<{ kind: string; id: string }>;
      mcpServers: Array<{
        id: string;
        name: string | null;
        url: string;
        headerNames: string[];
        credentialVersion: number;
        connectionRef: {
          connectionId?: string;
          providerDomain: string;
          kind?: string;
        } | null;
        headers?: unknown;
      }>;
    };
    expect(session.tools).toContainEqual({ kind: "mcp", id: "crm" });
    expect(session.mcpServers).toEqual([
      {
        id: "crm",
        name: "CRM MCP",
        url: "https://crm.example/mcp",
        headerNames: ["Authorization"],
        credentialVersion: 1,
        requireApproval: false,
        connectionRef: null,
      },
    ]);
    expect(session.mcpServers[0]?.headers).toBeUndefined();

    const key = new Uint8Array(Buffer.from(environmentsTestKey, "base64"));
    const { attemptId } = await claimCreatedSessionForRun(dbClient.db, grant, session.id);
    const runServers = await listSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      session.id,
      attemptId,
      key,
    );
    expect(runServers[0]?.headers).toEqual({ Authorization: createSecret });
    expect(runServers[0]?.allowedTools).toEqual(["workouts.list"]);
    const rawMcpRows = await dbClient.db.execute(dbSql<{
      headers_encrypted: Record<string, string>;
    }>`
      select headers_encrypted from session_mcp_servers where session_id = ${session.id}
    `);
    expect(JSON.stringify(rawMcpRows)).not.toContain(createSecret);

    const createdEventRows = await dbClient.db.execute(dbSql<{
      payload: unknown;
    }>`
      select payload from session_events where session_id = ${session.id} order by sequence
    `);
    const createdEventsJson = JSON.stringify(createdEventRows);
    expect(createdEventsJson).not.toContain(createSecret);
    expect(createdEventsJson).toContain("headerNames");

    const rotatedSecret = "Bearer rotated-secret";
    const rotated = await app.request(
      workspacePath(grant.workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "rotate then continue",
            mcpCredentialUpdates: [
              {
                id: "crm",
                headers: { Authorization: rotatedSecret, "X-Turn": "2" },
              },
            ],
          },
        }),
        headers: {
          "content-type": "application/json",
          authorization: attachAuth,
        },
      },
    );
    expect(rotated.status).toBe(202);
    const rotatedText = await rotated.text();
    expect(rotatedText).not.toContain(rotatedSecret);
    const accepted = JSON.parse(rotatedText) as {
      payload: {
        mcpCredentialUpdates?: Array<{
          id: string;
          headerNames: string[];
          credentialVersion: number;
          headers?: unknown;
        }>;
      };
    };
    expect(accepted.payload.mcpCredentialUpdates).toBeUndefined();
    const afterRotation = await listSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      session.id,
      attemptId,
      key,
    );
    expect(afterRotation[0]?.headers).toEqual({
      Authorization: rotatedSecret,
      "X-Turn": "2",
    });
    expect(afterRotation[0]?.credentialVersion).toBe(2);

    const allEventRows = await dbClient.db.execute(dbSql<{ payload: unknown }>`
      select payload from session_events where session_id = ${session.id} order by sequence
    `);
    const allEventsJson = JSON.stringify(allEventRows);
    expect(allEventsJson).not.toContain(createSecret);
    expect(allEventsJson).not.toContain(rotatedSecret);
    expect(allEventsJson).not.toContain('"headers"');

    const unknown = await app.request(
      workspacePath(grant.workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "bad rotate",
            mcpCredentialUpdates: [{ id: "unknown", headers: { Authorization: "Bearer nope" } }],
          },
        }),
        headers: {
          "content-type": "application/json",
          authorization: attachAuth,
        },
      },
    );
    expect(unknown.status).toBe(422);
    expect(await unknown.text()).toContain("unknown session MCP server id: unknown");

    const deniedRotate = await app.request(
      workspacePath(grant.workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "denied rotate",
            mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "Bearer denied" } }],
          },
        }),
        headers: {
          "content-type": "application/json",
          authorization: limitedAuth,
        },
      },
    );
    expect(deniedRotate.status).toBe(403);
    expect(await deniedRotate.text()).toContain("missing permission: mcp_servers:attach");

    const deniedCreate = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no permission",
        model: "scripted-model",
        mcpServers: [
          {
            id: "denied",
            url: "https://denied.example/mcp",
            headers: { Authorization: "Bearer denied" },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: limitedAuth,
      },
    });
    expect(deniedCreate.status).toBe(403);
    expect(await deniedCreate.text()).toContain("missing permission: mcp_servers:attach");

    const collision = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "reserved id",
        model: "scripted-model",
        mcpServers: [
          {
            id: "opengeni",
            url: "https://reserved.example/mcp",
            headers: { Authorization: "Bearer reserved" },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: attachAuth,
      },
    });
    expect(collision.status).toBe(422);
    expect(await collision.text()).toContain("MCP server id already exists: opengeni");

    const appWithoutKey = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const missingKey = await appWithoutKey.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "missing key",
        model: "scripted-model",
        mcpServers: [
          {
            id: "needs_key",
            url: "https://needs-key.example/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: attachAuth,
      },
    });
    expect(missingKey.status).toBe(503);
    const missingKeyError = (await missingKey.json()) as {
      error: { code: string };
    };
    expect(missingKeyError.error.code).toBe("upstream_unavailable");
    expect(JSON.stringify(missingKeyError)).not.toContain("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");

    const hostConnectionRef = {
      connectionId: "cloud-connection:github:1",
      providerDomain: "github.com",
      kind: "app_install",
    } as const;
    const hostBacked = await appWithoutKey.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use the host connection",
        model: "scripted-model",
        tools: [{ kind: "mcp", id: "host_github" }],
        mcpServers: [
          {
            id: "host_github",
            url: "https://host-github.example/mcp",
            connectionRef: hostConnectionRef,
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: attachAuth,
      },
    });
    expect(hostBacked.status).toBe(202);
    const hostSession = (await hostBacked.json()) as {
      id: string;
      mcpServers: Array<{
        headerNames: string[];
        credentialVersion: number;
        connectionRef: typeof hostConnectionRef | null;
      }>;
    };
    expect(hostSession.mcpServers[0]).toMatchObject({
      headerNames: [],
      credentialVersion: 1,
      requireApproval: false,
      connectionRef: hostConnectionRef,
    });
    const { attemptId: hostAttemptId } = await claimCreatedSessionForRun(
      dbClient.db,
      grant,
      hostSession.id,
    );
    const hostRunServers = await listSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      hostSession.id,
      hostAttemptId,
      null,
    );
    expect(hostRunServers[0]).toMatchObject({
      headers: {},
      connectionRef: hostConnectionRef,
    });
  });

  test("Codemode exposes the exact frozen attempt catalog and journals idempotent calls", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const bus = new MemoryEventBus();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
      }),
      db: dbClient.db,
      bus,
      workflowClient: new FakeWorkflowClient(),
    });
    const { session, turnId, attemptId, executionGeneration } = await createCodemodeAttempt(
      dbClient.db,
      grant,
    );
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId,
        attemptId,
        executionGeneration,
      },
      generation: 1,
      definitions: [
        {
          identity: { serverId: "crm", toolName: "search_documents" },
          modelName: "crm__search_documents",
          codemodePath: ["crm", "searchDocuments"],
          description: "Search CRM documents",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          source: "mcp",
          approval: "none",
          execute: async () => ({
            content: [{ type: "text", text: "worker-owned executor" }],
          }),
        },
      ],
    });
    const authorization = await signDelegatedBearer(delegationSecret, grant, {
      subjectId: `sandbox:${attemptId}`,
      permissions: ["codemode:call"],
      sessionId: session.id,
      turnId,
      attemptId,
      executionGeneration,
    });
    const base = workspacePath(grant.workspaceId, "/codemode");

    const catalogNotReady = await app.request(`${base}/catalog`, {
      headers: { authorization },
    });
    expect(catalogNotReady.status).toBe(409);
    const catalogNotReadyBody = await catalogNotReady.json();
    expect(catalogNotReadyBody).toMatchObject({
      error: {
        status: 409,
        code: "conflict",
        message: "Codemode tool catalog is not ready for the active execution attempt",
        retryable: true,
        details: { code: "codemode_catalog_not_ready" },
      },
    });
    expect(JSON.stringify(catalogNotReadyBody)).not.toContain("bearer");

    await persistAttemptToolCatalog(dbClient.db, environment.catalog);
    const catalogResponse = await app.request(`${base}/catalog`, {
      headers: { authorization },
    });
    expect(catalogResponse.status).toBe(200);
    expect(await catalogResponse.json()).toEqual(environment.catalog);

    const staleOperationId = crypto.randomUUID();
    const stale = await app.request(`${base}/calls`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        operationId: staleOperationId,
        catalogDigest: "f".repeat(64),
        identity: { serverId: "crm", toolName: "search_documents" },
        arguments: { query: "stale catalog" },
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: {
        code: "conflict",
        retryable: true,
        details: { code: "codemode_catalog_stale" },
      },
    });
    expect(
      (
        await app.request(`${base}/calls/${staleOperationId}`, {
          headers: { authorization },
        })
      ).status,
    ).toBe(404);

    const operationId = crypto.randomUUID();
    const request = {
      operationId,
      catalogDigest: environment.catalog.digest,
      identity: { serverId: "crm", toolName: "search_documents" },
      arguments: { query: "network policy" },
    };
    const first = await app.request(`${base}/calls`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      operation: { operationId, state: "queued", arguments: request.arguments },
      dispatch: "unavailable",
    });

    const replay = await app.request(`${base}/calls`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      operation: { operationId, state: "queued" },
    });

    const second = await app.request(`${base}/calls`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ ...request, operationId: crypto.randomUUID() }),
    });
    expect(second.status).toBe(202);

    const queued = await app.request(`${base}/calls/${operationId}`, {
      headers: { authorization },
    });
    expect(queued.status).toBe(200);
    expect(await queued.json()).toMatchObject({ operationId, state: "queued" });

    const claimId = crypto.randomUUID();
    expect(
      (
        await claimCodemodeOperation(dbClient.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          turnId,
          attemptId,
          executionGeneration,
          catalogDigest: environment.catalog.digest,
          operationId,
          claimId,
        })
      ).status,
    ).toBe("claimed");
    expect(
      await markCodemodeOperationExecutionStarted(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        attemptId,
        operationId,
        claimId,
      }),
    ).toBe(true);
    expect(
      await completeCodemodeOperation(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        attemptId,
        operationId,
        claimId,
        result: { content: [{ type: "text", text: "found" }] },
      }),
    ).toBe(true);
    const completed = await app.request(`${base}/calls/${operationId}`, {
      headers: { authorization },
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      operationId,
      state: "completed",
      result: { content: [{ type: "text", text: "found" }] },
    });

    const workspaceAuthorization = await signDelegatedBearer(delegationSecret, grant, {
      subjectId: "test:workspace",
      permissions: ["workspace:read"],
    });
    expect(
      (
        await app.request(`${base}/catalog`, {
          headers: { authorization: workspaceAuthorization },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(workspacePath(grant.workspaceId, "/mcp"), {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        })
      ).status,
    ).toBe(403);
  });
  test("cancelled-session user messages do not rotate per-session MCP credentials", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
    });
    const attachAuth = `Bearer ${await signDelegatedAccessToken(delegationSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: "test:session-mcp-cancelled-rotation",
      permissions: [
        "workspace:read",
        "sessions:create",
        "sessions:read",
        "sessions:control",
        "mcp_servers:attach",
      ],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 300,
    })}`;

    const createSecret = "Bearer create-secret";
    const created = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use the crm server",
        model: "scripted-model",
        tools: [{ kind: "mcp", id: "crm" }],
        mcpServers: [
          {
            id: "crm",
            name: "CRM MCP",
            url: "https://crm.example/mcp",
            headers: { Authorization: createSecret, "X-Initial": "1" },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: attachAuth,
      },
    });
    expect(created.status).toBe(202);
    const session = (await created.json()) as { id: string };
    const key = new Uint8Array(Buffer.from(environmentsTestKey, "base64"));
    const beforeCredentials = await readStoredSessionMcpServer(dbClient.db, session.id, "crm", key);
    expect(beforeCredentials?.headers).toEqual({
      Authorization: createSecret,
      "X-Initial": "1",
    });
    expect(beforeCredentials?.credentialVersion).toBe(1);

    await setSessionStatus(dbClient.db, grant.workspaceId, session.id, "cancelled", null);
    const beforeEvents = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      session.id,
      0,
      100,
    );
    const beforeTurns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id, 100);
    const beforeUsage = await listUsageEvents(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      limit: 100,
    });
    const wakeupsBefore = wf.wakeups.length;

    const rejected = await app.request(
      workspacePath(grant.workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "rotate after cancellation",
            mcpCredentialUpdates: [
              {
                id: "crm",
                headers: { Authorization: "Bearer rejected", "X-Initial": "2" },
              },
            ],
          },
        }),
        headers: {
          "content-type": "application/json",
          authorization: attachAuth,
        },
      },
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.text()).toContain("Cancelled session subtree cannot accept work");

    const afterCredentials = await readStoredSessionMcpServer(dbClient.db, session.id, "crm", key);
    expect(afterCredentials?.headers).toEqual({
      Authorization: createSecret,
      "X-Initial": "1",
    });
    expect(afterCredentials?.credentialVersion).toBe(1);
    expect(
      await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100),
    ).toHaveLength(beforeEvents.length);
    expect(await listSessionTurns(dbClient.db, grant.workspaceId, session.id, 100)).toHaveLength(
      beforeTurns.length,
    );
    expect(
      await listUsageEvents(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        limit: 100,
      }),
    ).toHaveLength(beforeUsage.length);
    expect(wf.wakeups.length).toBe(wakeupsBefore);
  });

  test("goal-bearing child permissions never expand beyond explicit creator authority", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      productAccessMode: "configured",
      delegationSecret,
    });
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
    });
    // The creating grant deliberately lacks goals:manage. Asking for it
    // explicitly must fail the same creator-holds-it check as every other
    // permission; supplying a goal never creates a hidden exception.
    const creatorToken = await signDelegatedAccessToken(delegationSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: "test:goal-first-party-permissions",
      permissions: ["workspace:read", "sessions:create", "sessions:read"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    const unauthorizedGoal = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "take repo zero-to-one",
        model: "scripted-model",
        goal: { text: "repo deployed to staging" },
        firstPartyMcpPermissions: ["workspace:read", "goals:manage"],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creatorToken}`,
      },
    });
    expect(unauthorizedGoal.status).toBe(403);
    expect(await unauthorizedGoal.text()).toContain(
      "cannot grant first-party MCP permission beyond the creating grant: goals:manage",
    );

    // A goalless session can retain the creator's narrower explicit set and
    // becomes the trusted parent for the child cases below.
    const withoutGoal = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no goal here",
        model: "scripted-model",
        sandboxBackend: "none",
        firstPartyMcpPermissions: ["workspace:read"],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creatorToken}`,
      },
    });
    expect(withoutGoal.status).toBe(202);
    const plainSession = (await withoutGoal.json()) as {
      id: string;
      firstPartyMcpPermissions: string[] | null;
    };
    expect(plainSession.firstPartyMcpPermissions).toEqual(["workspace:read"]);
    expect(
      (await getSession(dbClient.db, grant.workspaceId, plainSession.id))?.firstPartyMcpPermissions,
    ).toEqual(["workspace:read"] as Permission[]);

    const mcpDeps = {
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const managerGrant = {
      ...grant,
      permissions: ["workspace:read", "sessions:create", "sessions:read"] as Permission[],
      metadata: {
        sessionId: plainSession.id,
        firstPartyMcpTools: ["session_create", "goal_update", "goal_complete", "goal_pause"],
      },
    };
    const managerMcp = buildOpenGeniMcpServer(mcpDeps, managerGrant);

    // Omission inherits the manager's exact effective set. If that set lacks
    // goals:manage, a goal-bearing child is rejected instead of being widened.
    await expectMcpOrchestrationFailure(
      managerMcp,
      "session_create",
      {
        initialMessage: "spawn an under-authorized goal worker",
        model: "scripted-model",
        sandboxBackend: "none",
        sandbox: "new",
        goal: { text: "fleet healthy" },
      },
      "session_create_rejected",
      "goal-bearing sessions require goals:manage",
    );

    const authorizedParent = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "authorized goal manager parent",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      firstPartyMcpPermissions: [
        "workspace:read",
        "sessions:create",
        "sessions:read",
        "goals:manage",
      ],
    });
    const authorizedGrant = {
      ...managerGrant,
      permissions: [...managerGrant.permissions, "goals:manage"] as Permission[],
      metadata: {
        ...managerGrant.metadata,
        sessionId: authorizedParent.id,
      },
    };
    const authorizedMcp = buildOpenGeniMcpServer(mcpDeps, authorizedGrant);
    const spawnedReceipt = await callMcpTool<McpMutationReceiptType>(
      authorizedMcp,
      "session_create",
      {
        initialMessage: "spawn a goal-bearing worker",
        model: "scripted-model",
        sandboxBackend: "none",
        sandbox: "new",
        goal: { text: "fleet healthy" },
      },
    );
    const spawned = await requireSession(
      dbClient.db,
      grant.workspaceId,
      spawnedReceipt.resource.id,
    );
    expect(spawned.firstPartyMcpPermissions).toEqual(authorizedGrant.permissions);

    // Even an authorized creator cannot ask for a goal while explicitly
    // narrowing goals:manage out of the child token.
    await expectMcpOrchestrationFailure(
      authorizedMcp,
      "session_create",
      {
        initialMessage: "narrow away goal authority",
        model: "scripted-model",
        sandboxBackend: "none",
        sandbox: "new",
        goal: { text: "fleet healthy" },
        firstPartyMcpPermissions: ["workspace:read"],
      },
      "session_create_rejected",
      "goal-bearing sessions require goals:manage",
    );
  });

  test("manager MCP session tools enforce environment attachment permission and billing limits", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      environmentsEncryptionKey: environmentsTestKey,
    });
    const mcpDeps = {
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const environment = await createWorkspaceEnvironment(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: `manager-env-${crypto.randomUUID()}`,
    });

    // sessions:create alone cannot attach workspace secrets to a spawned
    // session; attachment and use remain independent exact gates.
    const spawnOnlyGrant = {
      ...grant,
      permissions: ["workspace:read", "sessions:create"] as Permission[],
    };
    const spawnOnlyMcp = buildOpenGeniMcpServer(mcpDeps, spawnOnlyGrant);
    await expectMcpOrchestrationFailure(
      spawnOnlyMcp,
      "session_create",
      {
        initialMessage: "exfiltrate",
        model: "scripted-model",
        environmentId: environment.id,
      },
      "session_create_forbidden",
      "missing permission: variable-sets:attach",
    );

    const attachOnlyMcp = buildOpenGeniMcpServer(mcpDeps, {
      ...spawnOnlyGrant,
      permissions: [...spawnOnlyGrant.permissions, "variable-sets:attach"] as Permission[],
    });
    await expectMcpOrchestrationFailure(
      attachOnlyMcp,
      "session_create",
      {
        initialMessage: "attach without use",
        model: "scripted-model",
        environmentId: environment.id,
      },
      "session_create_forbidden",
      "missing permission: variable-sets:use",
    );

    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);
    const attachedReceipt = await callMcpTool<McpMutationReceiptType>(mcp, "session_create", {
      initialMessage: "deploy with cloud credentials",
      model: "scripted-model",
      environmentId: environment.id,
    });
    const attached = await requireSession(
      dbClient.db,
      grant.workspaceId,
      attachedReceipt.resource.id,
    );
    expect(attached.variableSetId).toBe(environment.id);
    await expectMcpOrchestrationFailure(
      mcp,
      "session_create",
      {
        initialMessage: "unknown environment",
        model: "scripted-model",
        environmentId: crypto.randomUUID(),
      },
      "session_create_rejected",
      "unknown variableSetId",
    );

    // The successful create recorded one agent_run.created usage event, so a
    // one-run monthly cap now blocks both spawn and send-message.
    const limitedMcp = buildOpenGeniMcpServer(
      {
        ...mcpDeps,
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          environmentsEncryptionKey: environmentsTestKey,
          usageLimitsMode: "static",
          staticUsageLimitsJson: JSON.stringify({
            maxMonthlyAgentRunsPerWorkspace: 1,
          }),
        }),
      },
      grant,
    );
    await expectMcpOrchestrationFailure(
      limitedMcp,
      "session_create",
      {
        initialMessage: "over the cap",
        model: "scripted-model",
      },
      "session_create_limit_exceeded",
      "monthly agent run limit reached",
    );
    await expectMcpOrchestrationFailure(
      limitedMcp,
      "session_send_message",
      {
        sessionId: attached.id,
        text: "over the cap",
      },
      "session_send_message_limit_exceeded",
      "monthly agent run limit reached",
    );
  });

  test("manager MCP session_create forwards targetSandboxId to the domain (create-time machine targeting)", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpDeps = {
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);

    // Control: a backend:"none" create WITHOUT a target succeeds — no machine
    // is pinned, so nothing exercises the create-time targeting path.
    const plainReceipt = await callMcpTool<McpMutationReceiptType>(mcp, "session_create", {
      initialMessage: "no target",
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const plain = await requireSession(dbClient.db, grant.workspaceId, plainReceipt.resource.id);
    expect(plain.sandboxBackend).toBe("none");

    // targetSandboxId is declared on the session_create inputSchema, so the MCP
    // SDK does not strip it before the handler runs. The synthetic unknown id
    // reaches createSessionForRequest's ordinary workspace-scoped route
    // validator, which proves the value flowed end-to-end. A backend:"none"
    // home does not bypass target ownership or liveness checks.
    await expectMcpOrchestrationFailure(
      mcp,
      "session_create",
      {
        initialMessage: "pin to a machine",
        model: "scripted-model",
        sandboxBackend: "none",
        machineTarget: { targetSandboxId: crypto.randomUUID() },
      },
      "session_create_rejected",
      "not found in this workspace",
    );
  });

  test("manager MCP environment tools set variables write-only and create environments by name", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpDeps = {
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);
    const environmentName = `geni-cloud-${crypto.randomUUID()}`;
    const secretValue = `super-secret-${crypto.randomUUID()}`;

    const first = await callMcpTool<McpMutationReceiptType>(mcp, "environment_set_variable", {
      environmentName,
      name: "AZURE_CLIENT_SECRET",
      value: secretValue,
    });
    expect(first).toMatchObject({
      operation: "environment_set_variable",
      outcome: "created",
      resource: { type: "variable_set", version: 1, state: "variable_written" },
      facts: {
        variableCreated: true,
        variableSetCreated: true,
        deprecatedAlias: true,
      },
    });
    expect(JSON.stringify(first)).not.toContain(secretValue);
    expect(JSON.stringify(first)).not.toContain("AZURE_CLIENT_SECRET");
    expect(JSON.stringify(first)).not.toContain(environmentName);

    const rotatedValue = `rotated-${crypto.randomUUID()}`;
    const rotated = await callMcpTool<McpMutationReceiptType>(mcp, "environment_set_variable", {
      environmentId: first.resource.id,
      name: "AZURE_CLIENT_SECRET",
      value: rotatedValue,
    });
    expect(rotated).toMatchObject({
      outcome: "updated",
      resource: { id: first.resource.id, version: 2 },
      facts: {
        variableCreated: false,
        variableSetCreated: false,
        deprecatedAlias: true,
      },
    });

    // The stored value round-trips through the operator key, proving the MCP
    // write path encrypts exactly like the REST route.
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "verify exact variable-set storage",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      variableSetId: first.resource.id,
      subjectId: grant.subjectId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
    });
    await initializeSessionStartAtomically(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const claimed = await claimCreatedSessionForRun(dbClient.db, grant, session.id);
    if (!claimed.initiatingHumanSubjectId) {
      throw new Error("variable-set storage fixture has no initiating human");
    }
    const stored = await getVariableSetValuesForRun(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      variableSetId: first.resource.id,
      authority: {
        kind: "agent_attempt",
        subjectId: claimed.initiatingHumanSubjectId,
        sessionId: session.id,
        turnId: claimed.turnId,
        attemptId: claimed.attemptId,
        executionGeneration: claimed.executionGeneration,
      },
    });
    const key = new Uint8Array(Buffer.from(environmentsTestKey, "base64"));
    expect(decryptEnvironmentValue(key, stored!.values["AZURE_CLIENT_SECRET"]!)).toBe(rotatedValue);

    const listedEnvironments = await callMcpTool<{
      environments: Array<{
        id: string;
        name: string;
        variables: Array<{ name: string; version: number }>;
      }>;
    }>(mcp, "environment_list", {});
    const listedEnvironment = listedEnvironments.environments.find(
      (candidate) => candidate.id === first.resource.id,
    );
    expect(listedEnvironment?.variables).toEqual([
      expect.objectContaining({ name: "AZURE_CLIENT_SECRET", version: 2 }),
    ]);
    // Write-only invariant: no response carries a variable value.
    expect(JSON.stringify(listedEnvironments)).not.toContain(rotatedValue);
    expect(JSON.stringify(rotated)).not.toContain(rotatedValue);

    await expect(
      callMcpTool(mcp, "environment_set_variable", {
        environmentName,
        name: "GH_TOKEN",
        value: "nope",
      }),
    ).rejects.toThrow("reserved environment variable name");
    await expect(
      callMcpTool(mcp, "environment_set_variable", {
        environmentName,
        name: "lowercase",
        value: "nope",
      }),
    ).rejects.toThrow("environment variable names must match");
    await expect(
      callMcpTool(mcp, "environment_set_variable", {
        environmentId: first.resource.id,
        environmentName,
        name: "AMBIGUOUS",
        value: "nope",
      }),
    ).rejects.toThrow("exactly one of environmentId or environmentName");
    await expect(
      callMcpTool(mcp, "environment_set_variable", {
        environmentId: crypto.randomUUID(),
        name: "MISSING_TARGET",
        value: "nope",
      }),
    ).rejects.toThrow("environment not found");

    // Exact list permissions expose metadata but cannot write values.
    const listOnlyGrant = {
      ...grant,
      permissions: ["workspace:read", "variable-sets:list", "secrets:list"] as Permission[],
    };
    const listOnlyMcp = buildOpenGeniMcpServer(mcpDeps, listOnlyGrant);
    const listOnlyResult = await callMcpTool<{
      environments: Array<{ id: string }>;
    }>(listOnlyMcp, "environment_list", {});
    expect(
      listOnlyResult.environments.some((candidate) => candidate.id === first.resource.id),
    ).toBe(true);
    await expect(
      callMcpTool(listOnlyMcp, "environment_set_variable", {
        environmentName,
        name: "BLOCKED",
        value: "nope",
      }),
    ).rejects.toThrow("MCP tool not registered");
  });

  test("MCP plaintext reads require literal scope and the exact live attempt", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const observedOperations: string[] = [];
    const mcpDeps = {
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      sessionAuthorization: {
        authorizeSession: async (input: AuthorizeSessionInput) => {
          observedOperations.push(input.operation);
          return {
            allowed: true as const,
            relatedSessionAccess: "target" as const,
          };
        },
        resolveListScope: async () => ({ kind: "all" as const }),
      },
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by secret-read MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const writer = buildOpenGeniMcpServer(mcpDeps, grant);
    const exact =
      `ordinary source: const fakeKey = "sk_not_a_credential";\n` +
      `shell: printf '%s\\n' "$VALUE"\n` +
      `nul:${String.fromCharCode(0)}:lone:${String.fromCharCode(0xd800)}`;
    const written = await callMcpTool<McpMutationReceiptType>(writer, "variable_set_set_variable", {
      variableSetName: `permissioned-mcp-${crypto.randomUUID()}`,
      name: "EXACT_VALUE",
      value: exact,
    });

    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "read one configured value",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      firstPartyMcpPermissions: grant.permissions,
      variableSetId: written.resource.id,
      subjectId: grant.subjectId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
    });
    await initializeSessionStartAtomically(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(dbClient.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") {
      throw new Error(`failed to claim secret-read fixture: ${claimed.reason}`);
    }
    if (!claimed.turn.initiatingHumanSubjectId) {
      throw new Error("secret-read fixture has no initiating human");
    }
    const liveGrant = {
      ...grant,
      subjectId: claimed.turn.initiatingHumanSubjectId,
      principalKind: "agent_attempt" as const,
      metadata: {
        delegated: true,
        sessionId: session.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
        firstPartyMcpTools: ["variable_set_get_variable"],
      },
    };

    const sessionless = buildOpenGeniMcpServer(mcpDeps, grant);
    await expect(
      callMcpTool(sessionless, "variable_set_get_variable", {
        variableSetId: written.resource.id,
        name: "EXACT_VALUE",
      }),
    ).rejects.toThrow("MCP tool not registered");
    const narrowed = buildOpenGeniMcpServer(mcpDeps, {
      ...liveGrant,
      permissions: ["variable-sets:read"] as Permission[],
    });
    await expect(
      callMcpTool(narrowed, "variable_set_get_variable", {
        variableSetId: written.resource.id,
        name: "EXACT_VALUE",
      }),
    ).rejects.toThrow("MCP tool not registered");

    const staleGeneration = buildOpenGeniMcpServer(mcpDeps, {
      ...liveGrant,
      metadata: {
        ...liveGrant.metadata,
        executionGeneration: claimed.turn.executionGeneration + 1,
      },
    });
    await expect(
      callMcpTool(staleGeneration, "variable_set_get_variable", {
        variableSetId: written.resource.id,
        name: "EXACT_VALUE",
      }),
    ).rejects.toThrow("Session not found or access denied");

    const foreignGrant = await bootstrapMcpGrant(dbClient.db);
    const wrongWorkspace = buildOpenGeniMcpServer(mcpDeps, {
      ...foreignGrant,
      principalKind: "agent_attempt" as const,
      metadata: liveGrant.metadata,
    });
    await expect(
      callMcpTool(wrongWorkspace, "variable_set_get_variable", {
        variableSetId: written.resource.id,
        name: "EXACT_VALUE",
      }),
    ).rejects.toThrow("Session not found or access denied");

    const liveMcp = buildOpenGeniMcpServer(mcpDeps, liveGrant);
    const secret = await callMcpTool<{
      variableSetId: string;
      name: string;
      version: number;
      value: string;
    }>(liveMcp, "variable_set_get_variable", {
      variableSetId: written.resource.id,
      name: "EXACT_VALUE",
    });
    expect(secret).toEqual({
      variableSetId: written.resource.id,
      name: "EXACT_VALUE",
      version: 1,
      value: exact,
    });
    expect(observedOperations).toEqual(["session.secret.read"]);

    const audit = await withWorkspaceRls(dbClient.db, grant.workspaceId, async (scopedDb) => {
      const [row] = await scopedDb.execute(
        dbSql<{ metadata: Record<string, unknown> }>`
          select metadata
            from audit_events
           where workspace_id = ${grant.workspaceId}
             and target_id = ${written.resource.id}
             and action = 'variable_set.variable.read'
           order by occurred_at desc
           limit 1`,
      );
      return row;
    });
    expect(audit?.metadata).toMatchObject({
      actorKind: "agent_attempt",
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      variableSetId: written.resource.id,
      name: "EXACT_VALUE",
      scope: "workspace",
      generation: expect.any(Number),
    });
    expect(JSON.stringify(audit)).not.toContain(exact);

    await applySessionTurnSettlement(dbClient.db, grant.workspaceId, {
      sessionId: session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [{ type: "session.failed", payload: { reason: "test settlement" } }],
    });
    await expect(
      callMcpTool(liveMcp, "variable_set_get_variable", {
        variableSetId: written.resource.id,
        name: "EXACT_VALUE",
      }),
    ).rejects.toThrow("Session not found or access denied");
  });

  test("manager MCP github_connect_link reports unbound and returns only a manager consent link", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const configuredGitHub = {
      githubAppId: "12345",
      githubClientId: "test-client-id",
      githubClientSecret: "test-client-secret",
      githubAppSlug: "opengeni-test-app",
      githubAppPrivateKey: "test-private-key",
    };
    const mcpDeps = {
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        publicBaseUrl: "https://api.opengeni.test",
        ...configuredGitHub,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      objectStorage: null,
      githubStateSecret: "test-github-connect-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const link = await callMcpTool<{
      configured: boolean;
      status: string;
      appSlug: string;
      installUrl: string | null;
      linkUrl: string | null;
      missing: string[];
    }>(buildOpenGeniMcpServer(mcpDeps, grant), "github_connect_link", {});
    expect(link).toMatchObject({
      configured: true,
      status: "unbound",
      appSlug: "opengeni-test-app",
      missing: [],
    });
    expect(link.installUrl).toContain(`/v1/workspaces/${grant.workspaceId}/github/connect?state=`);
    expect(link.linkUrl).toBe(link.installUrl);

    const useOnlyLink = await callMcpTool<{
      status: string;
      installUrl: string | null;
      linkUrl: string | null;
    }>(
      buildOpenGeniMcpServer(mcpDeps, {
        ...grant,
        permissions: ["github:use"],
      }),
      "github_connect_link",
      {},
    );
    expect(useOnlyLink).toMatchObject({
      status: "unbound",
      installUrl: null,
      linkUrl: null,
    });

    const unconfigured = await callMcpTool<{
      configured: boolean;
      installUrl: string | null;
      linkUrl: string | null;
      missing: string[];
    }>(
      buildOpenGeniMcpServer(
        {
          ...mcpDeps,
          settings: testSettings({ databaseUrl: services.databaseUrl }),
        },
        grant,
      ),
      "github_connect_link",
      {},
    );
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.installUrl).toBeNull();
    expect(unconfigured.linkUrl).toBeNull();
    expect(unconfigured.missing.length).toBeGreaterThan(0);

    const noBase = await callMcpTool<{
      installUrl: string | null;
      linkUrl: string | null;
    }>(
      buildOpenGeniMcpServer(
        {
          ...mcpDeps,
          settings: testSettings({
            databaseUrl: services.databaseUrl,
            publicBaseUrl: undefined,
            ...configuredGitHub,
          }),
        },
        grant,
      ),
      "github_connect_link",
      {},
    );
    expect(noBase).toMatchObject({ installUrl: null, linkUrl: null });
  });

  test("pack enable validates and stores environment attachments", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const environment = await createTestEnvironment(app, workspaceId, {});

    const unknownAttachment = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentId: crypto.randomUUID() }),
      },
    );
    expect(unknownAttachment.status).toBe(422);

    const enabled = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentId: environment.id }),
      },
    );
    expect([200, 201]).toContain(enabled.status);
    const installation = (await enabled.json()) as {
      metadata: Record<string, unknown>;
    };
    expect(installation.metadata.variableSetId).toBe(environment.id);

    // Re-enabling without environmentId keeps the stored attachment.
    const reenabled = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(reenabled.status).toBe(200);
    const reenabledInstallation = (await reenabled.json()) as {
      metadata: Record<string, unknown>;
    };
    expect(reenabledInstallation.metadata.variableSetId).toBe(environment.id);

    // Back-compat: an installation enabled BEFORE the Variable Set rename stored
    // the attachment under the legacy `metadata.environmentId` key. Simulate that
    // legacy row, then re-enable empty and assert the attachment is still
    // inherited (the environmentId fallback), not silently dropped.
    await dbClient.db.execute(dbSql`
      update pack_installations set metadata = ${JSON.stringify({ environmentId: environment.id })}::jsonb
      where workspace_id = ${workspaceId} and pack_id = 'marketing-social-daily-analysis'`);
    const reenabledLegacy = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(reenabledLegacy.status).toBe(200);
    const reenabledLegacyInstallation = (await reenabledLegacy.json()) as {
      metadata: Record<string, unknown>;
    };
    expect(reenabledLegacyInstallation.metadata.variableSetId).toBe(environment.id);
  });

  test("file download MCP tool reports unconfigured object storage", async () => {
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      delegationSecret: "test-delegation-secret",
    });
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      delegationSecret: "test-delegation-secret",
      opengeniMcpInternalUrl: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
      mcpServers: [
        {
          id: "files",
          name: "Files",
          url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp/files`,
          allowedTools: ["files_get_download_url"],
          timeoutMs: undefined,
          cacheToolsList: false,
        },
      ],
    });
    let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      const access = await defaultAccessContext(app);
      prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "files" }], {
        accountId: access.defaultAccountId!,
        workspaceId: access.defaultWorkspaceId!,
        subjectId: "test:mcp-client",
      });
      expect(
        mcpText(
          await prepared.mcpServers[0]!.callTool("files__files_get_download_url", {
            fileId: crypto.randomUUID(),
          }),
        ),
      ).toContain("object storage is not configured");
    } finally {
      await prepared?.close().catch(() => undefined);
      server.stop(true);
    }
  });
});

const environmentsTestKey = Buffer.alloc(32, 5).toString("base64");

async function createTestEnvironment(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  input: {
    name?: string;
    variables?: Array<{ name: string; value: string }>;
  },
): Promise<{ id: string; name: string }> {
  const response = await app.request(workspacePath(workspaceId, "/environments"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name ?? `env-${crypto.randomUUID()}`,
      variables: input.variables ?? [],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

function mcpText(result: unknown): string {
  const content = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : [];
  const first = content[0];
  if (
    first &&
    typeof first === "object" &&
    typeof (first as { text?: unknown }).text === "string"
  ) {
    return (first as { text: string }).text;
  }
  throw new Error(`MCP result did not contain text content: ${JSON.stringify(result)}`);
}

async function fakeResumeBoxById(): Promise<never> {
  throw new Error("sandbox resume is not used by API integration MCP tests");
}

async function defaultAccessContext(
  app: ReturnType<typeof createApp>,
  headers?: HeadersInit,
): Promise<AccessContext> {
  const response = await app.request("/v1/access/me", {
    ...(headers ? { headers } : {}),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as AccessContext;
}

async function defaultWorkspaceId(
  app: ReturnType<typeof createApp>,
  headers?: HeadersInit,
): Promise<string> {
  const context = await defaultAccessContext(app, headers);
  expect(context.defaultWorkspaceId).toBeTruthy();
  return context.defaultWorkspaceId!;
}

async function postStripeEvent(
  app: ReturnType<typeof createApp>,
  webhookSecret: string,
  event: Record<string, unknown>,
): Promise<Response> {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacSha256Hex(webhookSecret, `${timestamp}.${payload}`);
  return await app.request("/v1/webhooks/stripe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  });
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function workspacePath(workspaceId: string, path: string): string {
  return `/v1/workspaces/${workspaceId}${path}`;
}

async function withWorkspaceCount(
  db: ReturnType<typeof createDb>["db"],
  workspaceId: string,
  createIdempotencyKey: string,
): Promise<number> {
  const rows = await db.execute(
    dbSql<{
      n: number;
    }>`select count(*)::int as n from sessions where workspace_id = ${workspaceId} and create_idempotency_key = ${createIdempotencyKey}`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function bootstrapMcpGrant(db: ReturnType<typeof createDb>["db"]) {
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:mcp",
    accountExternalId: crypto.randomUUID(),
    accountName: "MCP test account",
    workspaceExternalSource: "test:mcp",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "MCP test workspace",
    subjectId: `test:mcp:${crypto.randomUUID()}`,
    subjectLabel: "MCP test",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("MCP bootstrap did not create a workspace grant");
  }
  return grant;
}

type TestWorkspaceGrant = AccessContext["workspaceGrants"][number];

type ClaimedSessionAttempt = {
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  initiatingHumanSubjectId: string | null;
};

async function claimCreatedSessionForRun(
  db: ReturnType<typeof createDb>["db"],
  grant: TestWorkspaceGrant,
  sessionId: string,
): Promise<ClaimedSessionAttempt> {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") {
    throw new Error(`failed to claim session ${sessionId}: ${claimed.reason}`);
  }
  return {
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    initiatingHumanSubjectId: claimed.turn.initiatingHumanSubjectId,
  };
}

async function readStoredSessionMcpServer(
  db: ReturnType<typeof createDb>["db"],
  sessionId: string,
  serverId: string,
  encryptionKey: Uint8Array,
): Promise<{
  headers: Record<string, string>;
  credentialVersion: number;
} | null> {
  const [row] = await db.execute<{
    headers_encrypted: Record<string, string>;
    credential_version: number;
  }>(dbSql`
    select headers_encrypted, credential_version
    from session_mcp_servers
    where session_id = ${sessionId} and server_id = ${serverId}
    limit 1
  `);
  return row
    ? {
        headers: Object.fromEntries(
          Object.entries(row.headers_encrypted).map(([name, value]) => [
            name,
            decryptEnvironmentValue(encryptionKey, value),
          ]),
        ),
        credentialVersion: Number(row.credential_version),
      }
    : null;
}

async function signDelegatedBearer(
  secret: string,
  grant: TestWorkspaceGrant,
  input: {
    subjectId: string;
    permissions: Permission[];
    sessionId?: string;
    turnId?: string;
    attemptId?: string;
    executionGeneration?: number;
  },
): Promise<string> {
  const hasExactAgentAuthority =
    input.sessionId !== undefined &&
    input.turnId !== undefined &&
    input.attemptId !== undefined &&
    input.executionGeneration !== undefined;
  return `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: input.subjectId,
    subjectLabel: input.subjectId,
    permissions: input.permissions,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.executionGeneration ? { executionGeneration: input.executionGeneration } : {}),
    principalKind: hasExactAgentAuthority ? "agent_attempt" : "human_session",
    exp: Math.floor(Date.now() / 1000) + 300,
  })}`;
}

async function createCodemodeAttempt(
  db: ReturnType<typeof createDb>["db"],
  grant: TestWorkspaceGrant,
) {
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "use Codemode",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const queued = await submitTestHumanPrompt(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    subjectId: grant.subjectId,
    text: "start Codemode turn",
    resources: [],
    tools: [],
    delivery: "send",
    reasoningEffortFallback: "medium",
  });
  const attemptId = crypto.randomUUID();
  const running = await claimSessionWorkForAttempt(db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (running.action !== "claimed" || running.turn.id !== queued.turn.id) {
    throw new Error("failed to claim the Codemode fixture turn");
  }
  return {
    session,
    turnId: running.turn.id,
    attemptId,
    executionGeneration: running.turn.executionGeneration,
  };
}
async function readSseEvents(
  response: Response,
  count: number,
  abort: AbortController,
): Promise<SessionEvent[]> {
  expect(response.body).toBeTruthy();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: SessionEvent[] = [];
  let buffer = "";
  try {
    while (events.length < count) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (!parsed?.data) {
          continue;
        }
        events.push(JSON.parse(parsed.data) as SessionEvent);
        if (events.length === count) {
          break;
        }
      }
    }
    return events;
  } finally {
    abort.abort();
    await reader.cancel().catch(() => undefined);
  }
}

async function callMcpTool<T = unknown>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        {
          handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP tool returned no text: ${name}`);
  }
  return JSON.parse(text) as T;
}

async function expectMcpOrchestrationFailure(
  server: unknown,
  name: "session_create" | "session_send_message",
  args: Record<string, unknown>,
  code: string,
  message: string,
): Promise<void> {
  const result = await (
    server as {
      _registeredTools?: Record<
        string,
        {
          handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools?.[name]?.handler(args, {});
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code } },
  });
  const structured = (
    result as { structuredContent?: { error?: { code?: string; message?: string } } }
  ).structuredContent;
  expect(structured?.error?.message).toContain(message);
  expect(new TextEncoder().encode(structured?.error?.message ?? "").byteLength).toBeLessThanOrEqual(
    1_024,
  );
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  expect(text ? JSON.parse(text) : null).toEqual(structured);
}

class FakeWorkflowClient implements SessionWorkflowClient {
  userMessages: unknown[] = [];
  wakeups: unknown[] = [];
  wakeDispatches = 0;
  approvals: unknown[] = [];
  interrupts: unknown[] = [];
  synced: unknown[] = [];
  deletedSchedules: unknown[] = [];
  triggers: unknown[] = [];
  syncError: Error | null = null;
  wakeError: Error | null = null;
  triggerError: Error | null = null;

  async signalUserMessage(input: unknown): Promise<void> {
    this.userMessages.push(input);
  }

  async wakeSessionWorkflow(input: unknown): Promise<void> {
    this.wakeups.push(input);
    if (this.wakeError) {
      throw this.wakeError;
    }
  }

  async requestSessionWorkflowWakeDispatch(): Promise<void> {
    this.wakeDispatches += 1;
  }

  async signalApprovalDecision(input: unknown): Promise<void> {
    this.approvals.push(input);
  }

  async signalSessionControl(input: unknown): Promise<void> {
    this.interrupts.push(input);
  }

  async syncScheduledTask(input: unknown): Promise<void> {
    this.synced.push(input);
    if (this.syncError) {
      throw this.syncError;
    }
  }

  async deleteScheduledTaskSchedule(input: unknown): Promise<void> {
    this.deletedSchedules.push(input);
  }

  async triggerScheduledTask(input: unknown): Promise<void> {
    this.triggers.push(input);
    if (this.triggerError) {
      throw this.triggerError;
    }
  }
}

function objectStorageSettings(databaseUrl: string, endpoint: string) {
  return testSettings({
    databaseUrl,
    objectStorageEndpoint: endpoint,
    objectStorageSandboxEndpoint: endpoint,
    objectStorageAccessKeyId: GARAGE_FIXTURE_ACCESS_KEY_ID,
    objectStorageSecretAccessKey: GARAGE_FIXTURE_SECRET_ACCESS_KEY,
  });
}

function startOfUtcMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function firstPartyMcpSettings(databaseUrl: string) {
  return testSettings({
    databaseUrl,
    mcpServers: [
      {
        id: "opengeni",
        name: "OpenGeni",
        url: "http://127.0.0.1:8000/v1/mcp",
        cacheToolsList: true,
      },
      {
        id: "docs",
        name: "Document Search",
        url: "http://127.0.0.1:8000/v1/mcp/docs",
        allowedTools: ["search_documents", "fetch_document_chunk", "list_document_bases"],
        cacheToolsList: false,
      },
    ],
  });
}
