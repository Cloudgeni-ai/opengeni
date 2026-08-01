import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  signDelegatedAccessToken,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  bindSlackInteractionSession,
  bootstrapWorkspace,
  createDb,
  createSession,
  getOrCreateSlackInteraction,
  grantWorkspaceAccess,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  requireSessionAuthorization,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerSessionRoutes } from "../src/routes/sessions";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const signingMaterial = `slack-private-auth-${crypto.randomUUID()}`;
const authHeaderName = ["author", "ization"].join("");

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("slack-private-session-auth");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[slack-private-session-auth] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function app(): Hono {
  const noop = async () => undefined;
  const hono = new Hono();
  registerSessionRoutes(hono, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: signingMaterial,
      sandboxBackend: "none",
    }),
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
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps);
  return hono;
}

async function bearer(grant: AccessGrant): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(signingMaterial, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: grant.permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

function headers(value: string, json = false): Headers {
  const result = new Headers();
  result.set(authHeaderName, value);
  if (json) result.set("content-type", "application/json");
  return result;
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "slack-private-auth-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Slack private authorization",
    workspaceExternalSource: "slack-private-auth-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Slack private authorization",
    subjectId: `user:owner-${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const other: AccessGrant = {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: `user:other-${suffix}`,
    permissions: ["sessions:read", "sessions:control"],
  };
  await grantWorkspaceAccess(client.db, other);

  const [connection] = await shared!.admin<{ id: string }[]>`
    insert into connections (
      account_id, workspace_id, subject_id, provider_domain, kind,
      credential_encrypted, verified_install_at, verified_install_version, metadata
    ) values (
      ${owner.accountId}, ${owner.workspaceId}, null, 'slack.com', 'app_install',
      repeat('x', 32), now(), 1, ${shared!.admin.json({
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
        slackTeamId: `T_${suffix}`,
        slackTeamName: "Slack private authorization",
        botId: `B_${suffix}`,
        botUserId: `U_${suffix}`,
        botDisplayName: "OpenGeni",
        verifiedAt: new Date().toISOString(),
      })}
    ) returning id`;
  const { interaction } = await getOrCreateSlackInteraction(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    connectionId: connection!.id,
    slackTeamId: `T_${suffix}`,
    slackChannelId: `D_${suffix}`,
    slackThreadTs: "1710000000.000001",
    routeKey: `D_${suffix}:1710000000.000001`,
    triggeringProviderEventId: `E_${suffix}`,
    owningSubjectId: owner.subjectId,
    visibility: "private",
  });
  const root = await createSession(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    requestedSessionId: interaction.sessionReservationId,
    initialMessage: "Private Slack DM root",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: owner.subjectId },
    model: "test-model",
    sandboxBackend: "none",
  });
  const child = await createSession(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    parentSessionId: root.id,
    initialMessage: "Private Slack DM child",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: owner.subjectId },
    model: "test-model",
    sandboxBackend: "none",
  });
  await bindSlackInteractionSession(client.db, {
    ...interaction,
    owningSubjectId: owner.subjectId,
    sessionId: root.id,
  });
  return {
    owner,
    other,
    root,
    child,
    ownerBearer: await bearer(owner),
    otherBearer: await bearer(other),
  };
}

describe("private Slack session authorization without an embedding-host port", () => {
  test("preserves the legacy no-port path for definitively unmapped and missing sessions", async () => {
    if (!available) return;
    const value = await fixture();
    const ordinary = await createSession(client.db, {
      accountId: value.owner.accountId,
      workspaceId: value.owner.workspaceId,
      initialMessage: "Ordinary workspace session",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: value.owner.subjectId },
      model: "test-model",
      sandboxBackend: "none",
    });
    for (const sessionId of [ordinary.id, crypto.randomUUID()]) {
      await expect(
        requireSessionAuthorization({ db: client.db }, value.owner, {
          sessionId,
          operation: "session.read",
          surface: "core",
        }),
      ).resolves.toBeNull();
    }
  });

  test("fails closed when the durable Slack mapping lookup errors", async () => {
    const lookupFailure = new Error("Slack mapping lookup unavailable");
    const db = new Proxy(
      {},
      {
        get() {
          throw lookupFailure;
        },
      },
    ) as Database;
    await expect(
      requireSessionAuthorization(
        { db },
        {
          accountId: crypto.randomUUID(),
          workspaceId: crypto.randomUUID(),
          subjectId: "user:lookup-failure",
          permissions: ["sessions:read"],
        },
        {
          sessionId: crypto.randomUUID(),
          operation: "session.read",
          surface: "core",
        },
      ),
    ).rejects.toThrow(lookupFailure.message);
  });

  test("denies another workspace member across session, events, control, and human-input surfaces", async () => {
    if (!available) return;
    const value = await fixture();
    const api = app();
    const base = `/v1/workspaces/${value.owner.workspaceId}/sessions/${value.root.id}`;
    const childBase = `/v1/workspaces/${value.owner.workspaceId}/sessions/${value.child.id}`;

    for (const path of [base, childBase, `${base}/events`, `${base}/human-input-requests`]) {
      const response = await api.request(`http://x${path}`, {
        headers: headers(value.otherBearer),
      });
      expect(response.status).toBe(404);
    }

    const control = await api.request(`http://x${base}/control`, {
      method: "POST",
      headers: headers(value.otherBearer, true),
      body: JSON.stringify({
        action: "pause",
        clientEventId: crypto.randomUUID(),
        reason: "unauthorized",
      }),
    });
    expect(control.status).toBe(404);

    const message = await api.request(`http://x${base}/events`, {
      method: "POST",
      headers: headers(value.otherBearer, true),
      body: JSON.stringify({
        type: "user.message",
        payload: { text: "unauthorized continuation" },
        clientEventId: crypto.randomUUID(),
      }),
    });
    expect(message.status).toBe(404);

    const codexAccount = await api.request(`http://x${base}/codex-account`, {
      method: "POST",
      headers: headers(value.otherBearer, true),
      body: JSON.stringify({ target: "auto" }),
    });
    expect(codexAccount.status).toBe(404);

    const humanInput = await api.request(`http://x${base}/events`, {
      method: "POST",
      headers: headers(value.otherBearer, true),
      body: JSON.stringify({
        type: "user.humanInputResponse",
        payload: {
          requestId: crypto.randomUUID(),
          response: { answers: {} },
        },
        clientEventId: crypto.randomUUID(),
      }),
    });
    expect(humanInput.status).toBe(404);
  });

  test("allows the mapped owner to read the private root and its descendants", async () => {
    if (!available) return;
    const value = await fixture();
    const api = app();
    for (const sessionId of [value.root.id, value.child.id]) {
      const response = await api.request(
        `http://x/v1/workspaces/${value.owner.workspaceId}/sessions/${sessionId}`,
        { headers: headers(value.ownerBearer) },
      );
      expect(response.status).toBe(200);
    }
  });
});
