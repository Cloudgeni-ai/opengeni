// An agent-spawned child must not inherit its parent's personal (Only me)
// Connected Machine route. The owner's approval names the parent chat only, so
// a child seeded onto that machine was refused at its first claim by
// admit_session_attempt_personal_machine() ("personal machine use requires
// explicit grant", SQLSTATE 42501) and parked as an opaque admission block.
// The child now runs on its group's own home and claims normally.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  MemoryEventBus,
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  claimSessionWorkForAttempt,
  completeSelfServiceOrganizationSetup,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  setActiveSandbox,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { subjectFor } from "@opengeni/runtime";
import type { AccessGrant } from "@opengeni/contracts";
import { createSessionForRequest } from "@opengeni/core";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let app: postgres.Sql;
let client: DbClient;
let db: Database;
const CONNECTION_INSTANCE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const settings = testSettings({
  productAccessMode: "managed",
  sandboxBackend: "modal",
  sandboxOwnershipEnabled: true,
  sandboxSelfhostedEnabled: true,
  agentOpStreamEnabled: false,
  sandboxSelfhostedExecTimeoutMs: 30_000,
  selfhostedRelayUrl: "wss://relay.example",
  publicBaseUrl: "https://app.example",
});

function onlineBus(workspaceId: string, agentId: string): MemoryEventBus {
  const bus = new MemoryEventBus();
  bus.subscribeRequests(subjectFor(workspaceId, agentId, CONNECTION_INSTANCE_ID), async (raw) => {
    const request = ControlRequest.decode(raw);
    const op = request.op;
    const response: ControlResponse =
      op?.$case === "ping"
        ? {
            requestId: request.requestId,
            result: { $case: "ping", ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" } },
          }
        : {
            requestId: request.requestId,
            error: {
              code: ErrorCode.ERROR_CODE_UNSUPPORTED,
              message: "unsupported",
              retryable: false,
              detail: {},
            },
          };
    return ControlResponse.encode(response).finish();
  });
  return bus;
}

function deps(bus: MemoryEventBus, settingsOverride = settings): ApiRouteDeps {
  const noop = async () => {};
  return {
    settings: settingsOverride,
    db,
    bus,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "x",
    objectStorage: null,
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

/** A brand-new self-service organization whose owner enrolled an Only me machine. */
async function personalMachineOwner() {
  const userId = `personal-machine-owner-${crypto.randomUUID()}`;
  const owner = `user:${userId}`;
  await admin`insert into auth_users(id, name, email, email_verified)
    values (${userId}, 'Owner', ${`${userId}@example.test`}, true)`;
  const setup = await completeSelfServiceOrganizationSetup(db, {
    authUserId: userId,
    actorSubjectId: owner,
    organizationName: "Fresh organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "c".repeat(64),
  });
  const accountId = setup.organizationId;
  const workspaceId = setup.personalWorkspaceId;
  const [machine] = await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true),
      set_config('opengeni.subject_id', ${owner}, true)`;
    return await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(${accountId}::uuid, ${workspaceId}::uuid, 'user',
        ${`ed25519:${crypto.randomUUID()}`}, true, false, 'macos', 'x86_64', 'Laptop', false)`;
  });
  await admin`update enrollments set connection_instance_id = ${CONNECTION_INSTANCE_ID},
    connection_generation = 1, connection_lease_expires_at = now() + interval '1 hour',
    last_seen_at = now(), workspace_root = '/' where id = ${machine!.enrollmentId}`;
  return {
    accountId,
    workspaceId,
    owner,
    ...machine!,
    bus: onlineBus(workspaceId, machine!.enrollmentId),
  };
}

async function claim(workspaceId: string, sessionId: string) {
  const result = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (result.action !== "claimed") throw new Error(`turn was not claimed: ${result.reason}`);
  return result.turn;
}

/** The owner moved this chat onto their machine, approving it for this chat. */
async function parentOnPersonalMachine(
  f: Awaited<ReturnType<typeof personalMachineOwner>>,
  sandboxBackend: "modal" | "selfhosted",
) {
  const parent = await createSession(db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    visibility: "workspace_shared",
    initialMessage: "Use my machine for this chat",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: f.owner },
    subjectId: f.owner,
    model: settings.openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend,
    initialPersonalResourceAttachmentIntent: {
      mode: "session",
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1,
    },
  } as never);
  expect(
    await setActiveSandbox(db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: parent.id,
      subjectId: f.owner,
      expectedEpoch: parent.activeEpoch,
      targetSandboxId: f.sandboxId,
      workingDir: "/",
    }),
  ).toMatchObject({ swapped: true });
  await initializeSessionStartAtomically(db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: parent.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  } as never);
  // The parent's own turn is admitted on the machine by that approval.
  await claim(f.workspaceId, parent.id);
  return parent;
}

function childGrant(
  f: { accountId: string; workspaceId: string; owner: string },
  parentId: string,
): AccessGrant {
  return {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    subjectId: f.owner,
    permissions: ["sessions:create", "sessions:read"],
    metadata: { sessionId: parentId, firstPartyMcpTools: ["session_create"] },
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("child-personal-machine-placement");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL is required");
    return;
  }
  admin = shared.admin;
  app = postgres(shared.appUrl, { max: 2, prepare: false, onnotice: () => undefined });
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await app?.end({ timeout: 1 }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("child placement with a parent on its owner's personal machine", () => {
  test("the child keeps the shared group home and its first turn is claimed", async () => {
    if (!shared) return;
    const f = await personalMachineOwner();
    const parent = await parentOnPersonalMachine(f, "modal");

    const child = await createSessionForRequest(
      deps(f.bus),
      childGrant(f, parent.id),
      f.workspaceId,
      { initialMessage: "Research official sources" },
    );
    expect(child).toMatchObject({
      parentSessionId: parent.id,
      sandboxBackend: "modal",
      sandboxGroupId: parent.sandboxGroupId,
      activeSandboxId: null,
    });
    // Previously the child copied the machine route and this claim failed with
    // 42501 "personal machine use requires explicit grant".
    const turn = await claim(f.workspaceId, child.id);
    expect(turn.sessionId).toBe(child.id);
    const [authorizations] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from session_attempt_connected_machine_authorizations
      where session_id = ${child.id}`;
    expect(authorizations?.count).toBe(0);
  }, 120_000);

  test("without a managed home the child is refused at create, not parked", async () => {
    if (!shared) return;
    const selfhostedOnly = testSettings({ ...settings, sandboxBackend: "selfhosted" });
    const f = await personalMachineOwner();
    const parent = await parentOnPersonalMachine(f, "selfhosted");
    const [before] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from sessions where workspace_id = ${f.workspaceId}`;

    await expect(
      createSessionForRequest(
        deps(f.bus, selfhostedOnly),
        childGrant(f, parent.id),
        f.workspaceId,
        {
          initialMessage: "Research official sources",
        },
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("approved only for that session"),
    });
    const [after] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from sessions where workspace_id = ${f.workspaceId}`;
    expect(after?.count).toBe(before?.count);
  }, 120_000);
});
