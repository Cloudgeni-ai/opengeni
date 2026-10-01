import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveAgentConfig, type ResolvedAgentConfig } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  SessionCreateIdempotencyConflictError,
  SessionToolPolicyVersionConflictError,
  appendSessionEventsWithLockedSessionUpdate,
  bootstrapWorkspace,
  createDb,
  createSession,
  createSessionWithIdempotencyKeyResult,
  getSession,
} from "../src/index";

// Migration 0558: sessions.agent_config is one frozen, nullable agent
// configuration. NULL keeps a legacy session; the mid-session update shares the
// tool-policy version CAS.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-agent-config");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function config(capabilities: "all" | "none", identity: string | null = null): ResolvedAgentConfig {
  return resolveAgentConfig({
    creator: "api",
    request: { capabilities, ...(identity ? { identity } : {}) },
    workspace: { defaults: null, humanInputEnabled: true },
    deployment: { unavailable: {}, admissionEnabled: true, defaultForNewSessions: false },
    goal: false,
  }).config!;
}

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Agent config",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Agent config",
    subjectId: `subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

function sessionInput(grant: Awaited<ReturnType<typeof workspace>>) {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
}

async function storedConfig(sessionId: string): Promise<unknown> {
  const [row] = await shared.admin<{ agent_config: unknown }[]>`
    SELECT agent_config FROM sessions WHERE id = ${sessionId}
  `;
  return row?.agent_config ?? null;
}

describe("sessions.agent_config (0558)", () => {
  test("the complete fixture applies allowances and collaborator migrations before 0558", async () => {
    const applied = await shared.admin<{ name: string }[]>`
      SELECT name FROM schema_migrations
      WHERE name IN (
        '0552_usage_allowances.sql',
        '0553_non_model_debit_attribution.sql',
        '0554_video_allowance_refunds.sql',
        '0555_member_collaborator_permissions.sql',
        '0556_member_collaborator_permissions_backfill_index.sql',
        '0557_member_collaborator_permissions_backfill.sql',
        '0558_session_agent_config.sql'
      )
      ORDER BY name
    `;
    expect(applied.map((migration) => migration.name)).toEqual([
      "0552_usage_allowances.sql",
      "0553_non_model_debit_attribution.sql",
      "0554_video_allowance_refunds.sql",
      "0555_member_collaborator_permissions.sql",
      "0556_member_collaborator_permissions_backfill_index.sql",
      "0557_member_collaborator_permissions_backfill.sql",
      "0558_session_agent_config.sql",
    ]);
  }, 60_000);

  test("an omitted configuration stores NULL and reads as a legacy session", async () => {
    const grant = await workspace();
    const session = await createSession(client.db, sessionInput(grant));
    expect(session.agent).toBeNull();
    expect(await storedConfig(session.id)).toBeNull();
  }, 60_000);

  test("a resolved configuration round-trips exactly", async () => {
    const grant = await workspace();
    const agent = config("none", "Acme helper");
    const session = await createSession(client.db, { ...sessionInput(grant), agentConfig: agent });
    expect(session.agent).toEqual(agent);
    expect(await storedConfig(session.id)).toEqual(agent);
    expect((await getSession(client.db, grant.workspaceId!, session.id))?.agent).toEqual(agent);
  }, 60_000);

  test("an unreadable stored value projects as null instead of failing reads", async () => {
    const grant = await workspace();
    const session = await createSession(client.db, {
      ...sessionInput(grant),
      agentConfig: config("all"),
    });
    await shared.admin`UPDATE sessions SET agent_config = '{"version": 99}'::jsonb WHERE id = ${session.id}`;
    expect((await getSession(client.db, grant.workspaceId!, session.id))?.agent).toBeNull();
  }, 60_000);

  test("keyed-create replay compares the resolved configuration", async () => {
    const grant = await workspace();
    const key = `agent-${crypto.randomUUID()}`;
    const first = await createSessionWithIdempotencyKeyResult(client.db, {
      ...sessionInput(grant),
      agentConfig: config("none"),
      createIdempotencyKey: key,
    });
    if (first.denied) throw new Error("unexpected denial");
    // Same configuration (a different bookkeeping source label) replays.
    const replay = await createSessionWithIdempotencyKeyResult(client.db, {
      ...sessionInput(grant),
      agentConfig: { ...config("none"), source: "workspace_default" },
      createIdempotencyKey: key,
    });
    if (replay.denied) throw new Error("unexpected denial");
    expect(replay.session.id).toBe(first.session.id);
    expect(replay.created).toBe(false);
    await expect(
      createSessionWithIdempotencyKeyResult(client.db, {
        ...sessionInput(grant),
        agentConfig: config("all"),
        createIdempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(SessionCreateIdempotencyConflictError);
    await expect(
      createSessionWithIdempotencyKeyResult(client.db, {
        ...sessionInput(grant),
        agentConfig: null,
        createIdempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(SessionCreateIdempotencyConflictError);
  }, 60_000);

  test("the locked update writes configuration and instructions under the tool-policy CAS", async () => {
    const grant = await workspace();
    const session = await createSession(client.db, sessionInput(grant));
    const next = { ...config("none"), source: "legacy_conversion" as const };
    await appendSessionEventsWithLockedSessionUpdate(
      client.db,
      grant.workspaceId!,
      session.id,
      (current) => ({
        events: [
          {
            type: "session.agent.updated",
            payload: { before: current.agent, after: next, version: 2 },
          },
        ],
        update: {
          agentConfig: next,
          instructions: "Answer in one sentence.",
          toolPolicyVersion: 2,
          expectedToolPolicyVersion: 1,
        },
      }),
      { activity: "semantic" },
    );
    const updated = await getSession(client.db, grant.workspaceId!, session.id);
    expect(updated?.agent).toEqual(next);
    expect(updated?.instructions).toBe("Answer in one sentence.");
    expect(updated?.toolPolicyVersion).toBe(2);
    await expect(
      appendSessionEventsWithLockedSessionUpdate(
        client.db,
        grant.workspaceId!,
        session.id,
        () => ({
          events: [{ type: "session.agent.updated", payload: {} }],
          update: { agentConfig: null, toolPolicyVersion: 3, expectedToolPolicyVersion: 1 },
        }),
        { activity: "semantic" },
      ),
    ).rejects.toBeInstanceOf(SessionToolPolicyVersionConflictError);
    expect((await getSession(client.db, grant.workspaceId!, session.id))?.agent).toEqual(next);
  }, 60_000);
});
