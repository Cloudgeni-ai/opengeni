import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  grantWorkspaceAccess,
  initializeSessionStartAtomically,
  listInboxItems,
  listSessionEvents,
  persistProviderOAuthConnection,
  setConnectionStatus,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  connectionNeedsReauthNoticeKey,
  connectionReconnectDay,
  connectionsNeedingReconnectFor,
  listConnectionsNeedingReconnect,
  postConnectionNeedsReauthNotice,
} from "../src/domain/connections-needing-reconnect";

/* A connection that exists but stopped working is named to the agent (which
   account, since when) and its owner is told once, on their inbox. */

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
setDefaultTimeout(60_000);

const MAIL_DOMAIN = "mail.example.test";
const MAIL_MCP = "https://mail.example.test/mcp";

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("connections-needing-reconnect");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

async function setup() {
  const db = client.db;
  const ada = `user:${crypto.randomUUID()}`;
  const bea = `user:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "connections-needing-reconnect",
    accountExternalId: `account:${crypto.randomUUID()}`,
    accountName: "Team",
    workspaceExternalSource: "connections-needing-reconnect",
    workspaceExternalId: `workspace:${crypto.randomUUID()}`,
    workspaceName: "Team",
    subjectId: ada,
    subjectLabel: "Ada",
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  await grantWorkspaceAccess(db, {
    ...scope,
    subjectId: bea,
    subjectLabel: "Bea",
    permissions: ["sessions:read"],
  });
  // Personal accounts follow their owner through the organization membership.
  const personalWorkspaces = new Map<string, string>();
  for (const subjectId of [ada, bea]) {
    const [personal] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${scope.accountId}, 'Personal')
      returning id
    `;
    await shared!.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${personal!.id}, ${scope.accountId})
    `;
    await shared!.admin`
      insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${scope.accountId}, ${subjectId}, 'active', ${personal!.id})
    `;
    personalWorkspaces.set(subjectId, personal!.id);
  }
  const connect = async (
    subjectId: string | null,
    email: string,
    status: "active" | "needs_reauth",
    workspaceId = scope.workspaceId,
  ) => {
    const connection = await persistProviderOAuthConnection(db, {
      ...scope,
      workspaceId,
      subjectId,
      visibleToSubjectId: subjectId ?? ada,
      ...(subjectId
        ? { requireLiveUserAuthority: true, allowCanonicalPersonalWorkspaceOwner: true }
        : {}),
      providerDomain: MAIL_DOMAIN,
      kind: "oauth2",
      status: "active",
      credentialEncrypted: "test-ciphertext-never-resolved",
      grantedScopes: [],
      expiresAt: null,
      credentialRole: "mail_test_account",
      providerFamily: "mail",
      providerPrincipalId: email,
      metadata: {
        credentialRole: "mail_test_account",
        providerFamily: "mail",
        providerPrincipalId: email,
        email,
        mcpUrl: MAIL_MCP,
      },
    });
    if (!connection) throw new Error("connection was not created");
    if (status === "needs_reauth") {
      const moved = await setConnectionStatus(
        db,
        workspaceId,
        "needs_reauth",
        "connection refresh failed with HTTP 400",
        { id: connection.id, version: connection.version, subjectId },
      );
      if (!moved) throw new Error("connection status did not change");
    }
    return connection;
  };
  return { db, scope, ada, bea, connect, personalWorkspaces };
}

describe("connections that need reconnecting", () => {
  test("lists the workspace's and the person's own broken accounts, never others'", async () => {
    if (!shared) return;
    const { db, scope, ada, bea, connect, personalWorkspaces } = await setup();
    const adaBroken = await connect(ada, "ada@example.test", "needs_reauth");
    // Added in her Personal workspace: named here, reconnected there.
    const adaElsewhere = await connect(
      ada,
      "ada.home@example.test",
      "needs_reauth",
      personalWorkspaces.get(ada),
    );
    await connect(ada, "ada.active@example.test", "active");
    const sharedBroken = await connect(null, "team@example.test", "needs_reauth");
    await connect(bea, "bea@example.test", "needs_reauth");

    const forAda = await listConnectionsNeedingReconnect(db, { ...scope, subjectId: ada });
    expect(
      forAda.map(({ connectionId, account, ownership, providerDomain, mcpUrl, addedHere }) => ({
        connectionId,
        account,
        ownership,
        providerDomain,
        mcpUrl,
        addedHere,
      })),
    ).toEqual([
      {
        connectionId: adaElsewhere.id,
        account: "ada.home@example.test",
        ownership: "personal",
        providerDomain: MAIL_DOMAIN,
        mcpUrl: MAIL_MCP,
        addedHere: false,
      },
      {
        connectionId: adaBroken.id,
        account: "ada@example.test",
        ownership: "personal",
        providerDomain: MAIL_DOMAIN,
        mcpUrl: MAIL_MCP,
        addedHere: true,
      },
      {
        connectionId: sharedBroken.id,
        account: "team@example.test",
        ownership: "workspace",
        providerDomain: MAIL_DOMAIN,
        mcpUrl: MAIL_MCP,
        addedHere: true,
      },
    ]);
    expect(connectionReconnectDay(forAda[1]!.since)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    // Without a person, only the shared account.
    expect(
      (await listConnectionsNeedingReconnect(db, { ...scope, subjectId: null })).map(
        (entry) => entry.connectionId,
      ),
    ).toEqual([sharedBroken.id]);

    // Matched to a connector or catalog entry by provider and endpoint.
    expect(
      connectionsNeedingReconnectFor(forAda, {
        providerDomain: MAIL_DOMAIN.toUpperCase(),
        mcpUrl: `${MAIL_MCP}/`,
      }),
    ).toHaveLength(3);
    expect(
      connectionsNeedingReconnectFor(forAda, {
        providerDomain: MAIL_DOMAIN,
        mcpUrl: "https://other.example.test/mcp",
      }),
    ).toEqual([]);
    expect(
      connectionsNeedingReconnectFor(forAda, { providerDomain: "other.example.test" }),
    ).toEqual([]);
  });

  test("tells the owner on their inbox once per connection, on the chat that found it", async () => {
    if (!shared) return;
    const { db, scope, ada, connect } = await setup();
    const broken = await connect(ada, "ada@example.test", "needs_reauth");
    const session = await createSession(db, {
      ...scope,
      initialMessage: "Read my mail",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ada, label: "Ada" },
      createdByContext: { label: "Ada" },
    });
    await initializeSessionStartAtomically(db, {
      ...scope,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db, scope.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`expected a claim, got ${claimed.action}`);
    const bus = new MemoryEventBus();
    const breakFound = {
      workspaceId: scope.workspaceId,
      connectionId: broken.id,
      subjectId: ada,
      providerDomain: MAIL_DOMAIN,
      httpStatus: 400,
      use: {
        workspaceId: scope.workspaceId,
        sessionId: session.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
      },
    };
    await postConnectionNeedsReauthNotice({ db, bus }, breakFound);
    // A second report of the same connection updates the same item.
    await postConnectionNeedsReauthNotice({ db, bus }, breakFound);
    // A break found outside a chat has nowhere to post.
    await postConnectionNeedsReauthNotice({ db, bus }, { ...breakFound, use: undefined });

    const notices = (await listSessionEvents(db, scope.workspaceId, session.id)).filter(
      (event) => event.type === "session.notification.posted",
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]!.payload).toMatchObject({
      key: connectionNeedsReauthNoticeKey(broken.id),
      title: "Mail needs reconnecting",
      subtitle: "ada@example.test",
      urgency: "normal",
    });
    const inbox = (await listInboxItems(db, { accountId: scope.accountId, subjectId: ada })).filter(
      (item) => item.sessionId === session.id && item.kind === "notification",
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ title: "Mail needs reconnecting" });
  });
});
