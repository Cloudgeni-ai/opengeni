import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@opengeni/db/schema";
import type { Database } from "@opengeni/db";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { configuredModels } from "@opengeni/config";
import type { AccessGrant, LatencyMode } from "@opengeni/contracts";
import { bootstrapWorkspace, claimSessionWorkForAttempt, createDb, getSession } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import type { ApiRouteDeps } from "../src";
import { createSessionForRequest } from "../src/domain/sessions";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-create-latency");
  if (!acquired) throw new Error("Session latency regression requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(parentLatency: LatencyMode = "fast", exactAttempt = true) {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "child-latency-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Child latency fixture",
    workspaceExternalSource: "child-latency-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Child latency fixture",
    subjectId: `user:child-latency:${crypto.randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  const noop = async () => undefined;
  const capabilities = configuredModels(testSettings())[0]!.capabilities;
  const deps = {
    db: client.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      sandboxBackend: "none",
      openaiAllowedModels: "scripted-model,gpt-6.1-sol,gpt-6-luna",
      openaiReasoningEffort: "low",
      modelProvidersJson: JSON.stringify([
        {
          id: "latency-fixture",
          kind: "anonymous",
          api: "responses",
          wireProfile: "openai",
          baseUrl: "https://latency.example.test/v1",
          models: [
            {
              id: "fixture/all-latencies",
              upstreamModelId: "all-latencies",
              capabilities: {
                ...capabilities,
                latencyModes: ["standard", "priority", "fast"].map((id) => ({
                  id,
                  upstream: "supported",
                  runnable: true,
                })),
              },
            },
          ],
        },
      ]),
    }),
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: noop, requestSessionWorkflowWakeDispatch: noop },
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const parent = await createSessionForRequest(deps, grant, grant.workspaceId, {
    initialMessage: "Synthetic parent; never execute a model",
    model: parentLatency === "priority" ? "fixture/all-latencies" : "gpt-6.1-sol",
    reasoningEffort: "high",
    latencyMode: parentLatency,
    sandboxBackend: "none",
  });
  let caller: AccessGrant = {
    ...grant,
    metadata: { ...grant.metadata, sessionId: parent.id },
  };
  if (exactAttempt) {
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: parent.id,
      workflowId: `session-${parent.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`Parent claim failed: ${claimed.reason}`);
    caller = {
      ...caller,
      principalKind: "agent_attempt",
      metadata: {
        ...caller.metadata,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
      },
    };
  }
  const create = (overrides: Record<string, unknown> = {}) =>
    createSessionForRequest(deps, caller, grant.workspaceId, {
      initialMessage: "Synthetic child; never execute a model",
      sandboxBackend: "none",
      ...overrides,
    });
  return { grant, deps, parent, caller, create };
}

import {
  ensureManagedAccessForUser,
  createOrganizationInvitation,
  acceptOrganizationInvitation,
  createSession,
  transitionSessionVisibility,
  withSessionRlsActorContext,
  enqueueSessionTurn,
  appendSessionEvents,
  getSessionModelGate,
} from "@opengeni/db";
test("model admission projection preserves fresh effective policy and omits unused presentation reads", async () => {
  const { grant, parent, create } = await fixture("standard");
  const child = await create();
  const statements: string[] = [];
  const traced = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    debug: (_c, q) => statements.push(q),
  });
  const db = drizzle(traced, { schema }) as unknown as Database;
  const narrow = (id: string) => getSessionModelGate(db, grant.workspaceId, id);

  try {
    await traced`select 1`;
    for (const [name, id] of [
      ["queued", child.id],
      ["active", parent.id],
      ["missing", crypto.randomUUID()],
    ] as const) {
      statements.length = 0;
      const full = await getSession(db, grant.workspaceId, id);
      const fullCount = statements.length;
      statements.length = 0;
      const simple = await narrow(id);
      const narrowCount = statements.length;
      expect(simple).toEqual(
        full ? { model: full.model, codexCompactionMode: full.codexCompactionMode } : null,
      );
      if (name === "missing") expect(narrowCount).toBe(fullCount);
      else expect(narrowCount).toBeLessThan(fullCount);
    }

    const compare = async (_name: string, expectedModel: string) => {
      statements.length = 0;
      const full = await getSession(db, grant.workspaceId, child.id);
      const fullCount = statements.length;
      statements.length = 0;
      const simple = await narrow(child.id);
      const narrowCount = statements.length;
      expect(simple).toEqual({
        model: full!.model,
        codexCompactionMode: full!.codexCompactionMode,
      });
      expect(simple!.model).toBe(expectedModel);
      expect(narrowCount).toBeLessThan(fullCount);
    };
    const queue = async (model: string, source: "user" | "schedule" = "user") =>
      enqueueSessionTurn(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: child.id,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `session-${child.id}`,
        source,
        prompt: "Synthetic policy projection research",
        model,
        reasoningEffort: "high",
        resources: [],
        tools: [],
        metadata: {},
        sandboxBackend: "none",
        initiator: { kind: "subject", subjectId: grant.subjectId },
      });
    const newer = await queue("gpt-6-luna");
    await appendSessionEvents(client.db, grant.workspaceId, child.id, [
      { type: "turn.queued", turnId: newer.id, payload: {} },
      { type: "turn.started", turnId: newer.id, payload: {} },
    ]);
    await compare("latest-started-human", "gpt-6-luna");
    const older = await queue("gpt-6-luna");
    await appendSessionEvents(client.db, grant.workspaceId, child.id, [
      { type: "turn.queued", turnId: older.id, payload: {} },
    ]);
    await shared.admin`update sessions set model='gpt-6.1-sol' where id=${child.id}`;
    await appendSessionEvents(client.db, grant.workspaceId, child.id, [
      { type: "session.model_settings.updated", payload: { model: "gpt-6.1-sol" } },
    ]);
    await compare("explicit-settings-boundary", "gpt-6.1-sol");
    await appendSessionEvents(client.db, grant.workspaceId, child.id, [
      { type: "turn.started", turnId: older.id, payload: {} },
    ]);
    await compare("pre-settings-queued-turn-starts-later", "gpt-6.1-sol");
    const after = await queue("gpt-6-luna");
    await appendSessionEvents(client.db, grant.workspaceId, child.id, [
      { type: "turn.queued", turnId: after.id, payload: {} },
      { type: "turn.started", turnId: after.id, payload: {} },
    ]);
    await compare("human-after-settings", "gpt-6-luna");
    await shared.admin`update sessions set codex_compaction_mode='remote_v2' where id=${child.id}`;
    await compare("remote-compaction-field", "gpt-6-luna");
  } finally {
    await traced.end();
  }
}, 60000);

async function organization() {
  const ownerUserId = `shared-box-owner-${crypto.randomUUID()}`;
  const memberUserId = `shared-box-member-${crypto.randomUUID()}`;
  const owner = `user:${ownerUserId}`;
  const member = `user:${memberUserId}`;
  const ownerAccess = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Shared box owner",
  });
  await ensureManagedAccessForUser(client.db, {
    userId: memberUserId,
    email: `${memberUserId}@example.test`,
    name: "Shared box member",
  });
  const grant = ownerAccess.workspaceGrants.find(
    (candidate) => candidate.workspaceId === ownerAccess.defaultWorkspaceId,
  );
  if (!grant) throw new Error("owner has no shared workspace grant");
  const { accountId, workspaceId } = grant;
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${memberUserId}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: member,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${member}, 'member',
      '["sessions:read","sessions:create","sessions:control"]'::jsonb)`;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'shared-box-test')`;
  await shared.admin`
    insert into organization_private_session_settings (
      account_id, enabled, version, updated_by_membership_id
    ) values (${accountId}, true, 1, null)
    on conflict (account_id) do update set enabled = true`;
  return { accountId, workspaceId, owner, member };
}

type Org = Awaited<ReturnType<typeof organization>>;

function sessionInput(org: Org, subjectId: string, initialMessage: string) {
  return {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    initialMessage,
    resources: [],
    metadata: {},
    createdBy: { kind: "subject" as const, subjectId },
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
}

function makePrivate(org: Org, sessionId: string, expectedAuthorityEpoch = 1) {
  return transitionSessionVisibility(client.db, {
    workspaceId: org.workspaceId,
    sessionId,
    actorSubjectId: org.owner,
    targetVisibility: "user_private",
    expectedAuthorityEpoch,
    operationKey: `visibility-${crypto.randomUUID()}`,
  });
}

test("model gate retains live private audience and workspace isolation", async () => {
  const org = await organization();
  const target = await createSession(
    client.db,
    sessionInput(org, org.owner, "private gate research"),
  );
  await makePrivate(org, target.id);
  for (const [name, subjectId] of [
    ["owner", org.owner],
    ["member", org.member],
    ["unknown", "user:unrelated"],
  ] as const) {
    const result = await withSessionRlsActorContext({ subjectId }, async () => {
      const full = await getSession(client.db, org.workspaceId, target.id);
      const gate = await getSessionModelGate(client.db, org.workspaceId, target.id);
      expect(gate).toEqual(
        full ? { model: full.model, codexCompactionMode: full.codexCompactionMode } : null,
      );
      return gate;
    });
    if (name === "owner") expect(result).not.toBeNull();
    else expect(result).toBeNull();
  }
  const foreign = await fixture("standard");
  expect(await getSessionModelGate(client.db, foreign.grant.workspaceId, target.id)).toBeNull();
  expect(await getSession(client.db, foreign.grant.workspaceId, target.id)).toBeNull();
}, 60000);

test("model gate preserves corrupt cursor and control refusals", async () => {
  const { create, grant } = await fixture("standard");
  const child = await create();
  const bothRefuse = async () => {
    await expect(getSession(client.db, grant.workspaceId, child.id)).rejects.toThrow();
    await expect(getSessionModelGate(client.db, grant.workspaceId, child.id)).rejects.toThrow();
  };
  const [cursor] =
    await shared.admin`select last_sequence from session_event_cursors where session_id=${child.id}`;
  await shared.admin`update session_event_cursors set last_sequence=0 where session_id=${child.id}`;
  try {
    await bothRefuse();
  } finally {
    await shared.admin`update session_event_cursors set last_sequence=${cursor!.last_sequence} where session_id=${child.id}`;
  }
  await shared.admin`delete from workspace_inference_controls where workspace_id=${grant.workspaceId}`;
  await bothRefuse();
}, 60000);
