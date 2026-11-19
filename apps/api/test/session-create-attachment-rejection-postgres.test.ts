import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import type { AccessGrant } from "@opengeni/contracts";
import {
  createDb,
  discardUninitializedSessionShell,
  ensureManagedAccessForUser,
  type DbClient,
} from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { createSessionForRequestWithOutcome } from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

function buildDeps(): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings: testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

async function humanContext() {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Attachment owner",
  });
  const grant: AccessGrant = {
    ...access.workspaceGrants.find(
      (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
    )!,
    principalKind: "human_session" as const,
  };
  const authorization = {
    grant,
    accountGrant: access.accountGrants[0] ?? null,
    authenticatedSubjectId: grant.subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: true,
  };
  const create = (payload: Record<string, unknown>) =>
    createSessionForRequestWithOutcome(
      buildDeps(),
      grant,
      grant.workspaceId,
      {
        model: "scripted-model",
        sandboxBackend: "none",
        visibility: "private",
        ...payload,
      } as Parameters<typeof createSessionForRequestWithOutcome>[3],
      authorization as Parameters<typeof createSessionForRequestWithOutcome>[4],
    );
  return { grant, create };
}

const DISCARD_ROUTINE = "opengeni_private.discard_refused_session_create_v1(uuid, uuid)";

/** Migration 1501 withholds the discard; the release after it grants it. */
async function withDiscardGranted<T>(fn: () => Promise<T>): Promise<T> {
  await shared!.admin.unsafe(`grant execute on function ${DISCARD_ROUTINE} to opengeni_app`);
  try {
    return await fn();
  } finally {
    await shared!.admin.unsafe(`revoke execute on function ${DISCARD_ROUTINE} from opengeni_app`);
  }
}

async function storedSessions(sessionId: string) {
  const [row] = await shared!.admin<Array<{ sessions: number; events: number; turns: number }>>`
    select
      (select count(*)::int from sessions where id = ${sessionId}) as sessions,
      (select count(*)::int from session_events where session_id = ${sessionId}) as events,
      (select count(*)::int from session_turns where session_id = ${sessionId}) as turns`;
  return row!;
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HTTPException) return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error("expected the create to be rejected");
}

// A personal-resource attachment with nothing personal selected (no personal
// Rig or Connected Machine on the new chat) is refused by the initial-turn
// acceptance, which runs after the session row is committed.
const nothingToAttach = { mode: "session", sharedOutputWarningVersion: 1 } as const;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-create-attachment-rejection");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("a create refused while accepting its first turn's personal resources", () => {
  test("an unkeyed private create leaves no session, so the corrected retry gets the same id", async () => {
    if (!available) return;
    const { create } = await humanContext();
    const sessionId = crypto.randomUUID();
    const refused = await rejection(
      create({
        requestedSessionId: sessionId,
        initialMessage: "Start here",
        personalResourceAttachment: nothingToAttach,
      }),
    );
    expect(refused).toEqual({
      status: 422,
      message: "The personal-resource attachment request is invalid",
    });
    expect(await storedSessions(sessionId)).toEqual({ sessions: 0, events: 0, turns: 0 });

    const corrected = await create({ requestedSessionId: sessionId, initialMessage: "Start here" });
    expect(corrected.session.id).toBe(sessionId);
    expect(corrected.outcome).toBe("created");
    expect((await storedSessions(sessionId)).turns).toBe(1);
  }, 60_000);

  test("a keyed private create replays the same refusal, leaves no session and frees its key", async () => {
    if (!available) return;
    await withDiscardGranted(async () => {
      const { grant, create } = await humanContext();
      const sessionId = crypto.randomUUID();
      const idempotencyKey = crypto.randomUUID();
      const request = {
        requestedSessionId: sessionId,
        idempotencyKey,
        initialMessage: "Start here",
        personalResourceAttachment: nothingToAttach,
      };
      const first = await rejection(create(request));
      expect(first).toEqual({
        status: 422,
        message: "The personal-resource attachment request is invalid",
      });
      expect(await storedSessions(sessionId)).toEqual({ sessions: 0, events: 0, turns: 0 });
      // The same request with the same key gets the same answer.
      expect(await rejection(create(request))).toEqual(first);
      expect(await storedSessions(sessionId)).toEqual({ sessions: 0, events: 0, turns: 0 });

      // The corrected request may keep both the key and the session id.
      const { personalResourceAttachment: _dropped, ...corrected } = request;
      const created = await create(corrected);
      expect(created.outcome).toBe("created");
      expect(created.session.id).toBe(sessionId);
      expect((await storedSessions(sessionId)).turns).toBe(1);
      // It is then an ordinary keyed session: a retry returns it (re-arming
      // its unclaimed wake) and the refused-start discard leaves it alone.
      const retried = await create(corrected);
      expect(retried.session.id).toBe(sessionId);
      expect(retried.outcome).toBe("repaired");
      expect(
        await discardUninitializedSessionShell(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          discardKeyed: true,
        }),
      ).toBe("initialized");
      expect((await storedSessions(sessionId)).sessions).toBe(1);
    });
  }, 60_000);

  test("until the discard is granted, a refused keyed shell stays as before", async () => {
    if (!available) return;
    const { create } = await humanContext();
    const sessionId = crypto.randomUUID();
    const request = {
      requestedSessionId: sessionId,
      idempotencyKey: crypto.randomUUID(),
      initialMessage: "Start here",
      personalResourceAttachment: nothingToAttach,
    };
    expect((await rejection(create(request))).status).toBe(422);
    expect(await storedSessions(sessionId)).toEqual({ sessions: 1, events: 0, turns: 0 });
    expect((await rejection(create(request))).status).toBe(422);
    // Once granted, the next refused retry discards it.
    await withDiscardGranted(async () => {
      expect((await rejection(create(request))).status).toBe(422);
    });
    expect(await storedSessions(sessionId)).toEqual({ sessions: 0, events: 0, turns: 0 });
  }, 60_000);
});
