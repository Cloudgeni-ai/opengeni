import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  dismissInboxNotification,
  getInboxItem,
  grantWorkspaceAccess,
  listInboxItems,
  listSessionEvents,
  persistProviderOAuthConnection,
  setConnectionStatus,
  type Database,
  type DbClient,
} from "@opengeni/db";
import type { ConnectionAccountIntent } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { submitComposerDraftForRequest } from "../src/application/composer-submit";
import { getHumanComposerDraft, saveHumanComposerDraft } from "../src/application/session-commands";
import { connectionNeedsReauthNoticeKey } from "../src/domain/connections-needing-reconnect";
import { listOwnConnectionAccountsForGrant } from "../src/domain/personal-connection-delegations";
import { resolveContinuedConnectionAccounts } from "../src/domain/session-connection-accounts";

/*
 * Regression: a chat left open keeps the account list it loaded when it
 * opened. One of those accounts then stopped working (its sign-in expired and
 * a refresh was refused), and the next Send carried it as a pick. The server
 * refused the whole message with 422 connection_account_selection_unavailable.
 * A message must be sent without such an account, and its connector must
 * never be given another account the person did not pick.
 */

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-send-stale-connector-account");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const linear = {
  id: "linear",
  name: "Linear",
  url: "https://mcp.linear.app/mcp",
  cacheToolsList: false,
  connectionRef: {
    providerDomain: "linear.app",
    kind: "oauth2" as const,
    subjectScope: "subject" as const,
  },
};

type Pick = { serverId: string; connectionId: string };

async function fixture() {
  const suffix = crypto.randomUUID();
  const subjectId = `user:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: `stale-account-${suffix}`,
    accountName: "Stale connector account",
    workspaceExternalSource: "test",
    workspaceExternalId: `stale-workspace-${suffix}`,
    workspaceName: "Stale connector account",
    subjectId,
    subjectLabel: "Ada",
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const scope = { accountId: grant.accountId, workspaceId };
  const admin = shared!.admin;
  // Personal accounts follow their owner through the organization membership.
  const joinOrganization = async (member: string) => {
    const [personal] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${scope.accountId}, 'Personal')
      returning id
    `;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${personal!.id}, ${scope.accountId})
    `;
    await admin`
      insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${scope.accountId}, ${member}, 'active', ${personal!.id})
    `;
  };
  await joinOrganization(subjectId);
  const logins = new Map<string, { version: number; subjectId: string }>();
  const addLogin = async (email: string, owner = subjectId) => {
    const connection = await persistProviderOAuthConnection(db, {
      ...scope,
      subjectId: owner,
      visibleToSubjectId: owner,
      requireLiveUserAuthority: true,
      allowCanonicalPersonalWorkspaceOwner: true,
      providerDomain: "linear.app",
      kind: "oauth2",
      status: "active",
      credentialEncrypted: "test-ciphertext-never-resolved",
      grantedScopes: [],
      expiresAt: null,
      credentialRole: "linear_test_account",
      providerFamily: "linear",
      providerPrincipalId: email,
      metadata: {
        credentialRole: "linear_test_account",
        providerFamily: "linear",
        providerPrincipalId: email,
        email,
      },
    });
    if (!connection) throw new Error("connection was not created");
    logins.set(connection.id, { version: connection.version, subjectId: owner });
    return connection.id;
  };
  const expire = async (connectionId: string) => {
    const login = logins.get(connectionId)!;
    const moved = await setConnectionStatus(
      db,
      workspaceId,
      "needs_reauth",
      "connection refresh failed with HTTP 403",
      { id: connectionId, version: login.version, subjectId: login.subjectId },
    );
    if (!moved) throw new Error("connection status did not change");
  };
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [linear] });
  const deps = {
    settings,
    db,
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: async () => undefined },
    objectStorage: null,
  } as unknown as Parameters<typeof submitComposerDraftForRequest>[0];

  const newChat = async (visibility: "user_private" | "workspace_shared" = "user_private") =>
    (
      await createSession(db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "initial",
        resources: [],
        tools: [{ kind: "mcp", id: linear.id }],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "low",
        latencyMode: "standard",
        sandboxBackend: "none",
        ...(visibility === "workspace_shared"
          ? {
              visibility,
              createdBy: { kind: "subject" as const, subjectId, label: "Ada" },
              createdByContext: { label: "Ada" },
            }
          : {}),
      })
    ).id;

  const sendIn = async (
    sessionId: string,
    connectionAccounts: Pick[],
    sender: typeof grant = grant,
  ) => {
    const context = {
      accountId: sender.accountId,
      workspaceId,
      sessionId,
      subjectId: sender.subjectId,
    };
    const current = await getHumanComposerDraft({ db }, context);
    const saved = await saveHumanComposerDraft({ db }, context, {
      expectedRevision: current.revision,
      text: "follow up on the Linear issue",
      annotations: [],
      resources: [],
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
    });
    const accepted = await submitComposerDraftForRequest(deps, sender, workspaceId, sessionId, {
      clientEventId: crypto.randomUUID(),
      expectedDraftRevision: saved.revision,
      delivery: "send",
      text: saved.text,
      annotations: saved.annotations,
      resources: saved.resources,
      model: saved.model,
      reasoningEffort: saved.reasoningEffort,
      latencyMode: saved.latencyMode,
      connectionAccounts,
    } as Parameters<typeof submitComposerDraftForRequest>[4]);
    const [turn] = await admin<
      {
        bindings: { canonicalServerId: string; connectionId: string }[] | null;
        intent: ConnectionAccountIntent | null;
        gaps: unknown;
      }[]
    >`
      select mcp_account_bindings as bindings, connection_account_intent as intent,
        metadata -> 'connectionAccountGaps' as gaps
      from session_turns where id = ${accepted.turn.id}
    `;
    return { ...turn!, sessionId, turnId: accepted.turn.id as string };
  };
  const send = async (connectionAccounts: Pick[]) =>
    await sendIn(await newChat(), connectionAccounts);

  return {
    grant,
    subjectId,
    workspaceId,
    scope,
    settings,
    joinOrganization,
    addLogin,
    expire,
    newChat,
    sendIn,
    send,
  };
}

describe("sending with an account list loaded earlier", () => {
  test("an account that stopped working after the chat loaded is left out, never swapped", async () => {
    if (!available) return;
    const { grant, scope, settings, addLogin, expire, send } = await fixture();
    const picked = await addLogin("work@example.test");
    const other = await addLogin("home@example.test");

    // The composer's inventory, read when the chat opened: both work.
    const inventory = await listOwnConnectionAccountsForGrant(db, grant);
    expect(inventory.map((row) => row.id).sort()).toEqual([picked, other].sort());

    // While it works, the pick is bound exactly.
    const before = await send([{ serverId: linear.id, connectionId: picked }]);
    expect(before.bindings?.map((binding) => binding.connectionId)).toEqual([picked]);

    // Its sign-in expires and a refresh is refused before the next Send.
    await expire(picked);
    const stale = await send([{ serverId: linear.id, connectionId: picked }]);
    // Accepted, without the expired account and without the unpicked one.
    expect(stale.bindings).toEqual([]);
    // The pick is kept so a continuation narrows the same way, never widening.
    expect(stale.intent?.selections).toEqual([{ serverId: linear.id, connectionId: picked }]);
    expect(stale.gaps).toEqual([
      { serverId: linear.id, connectionId: picked, reason: "account_inactive" },
    ]);

    // Picks of both accounts keep only the working one.
    const mixedPicks = [
      { serverId: linear.id, connectionId: picked },
      { serverId: linear.id, connectionId: other },
    ];
    const mixed = await send(mixedPicks);
    expect(mixed.bindings?.map((binding) => binding.connectionId)).toEqual([other]);

    // A continuation of that message narrows exactly as the send did: it
    // keeps the working pick rather than dropping the connector, and never
    // adds an account that was not picked.
    const continued = await resolveContinuedConnectionAccounts({
      db,
      settings,
      ...scope,
      sessionId: mixed.sessionId,
      intent: mixed.intent!,
    });
    expect(continued.mcpAccountBindings?.map((binding) => binding.connectionId)).toEqual([other]);
    expect(continued.gaps).toEqual([
      { serverId: linear.id, connectionId: picked, reason: "account_inactive" },
    ]);
    // With only the expired pick, the connector runs with no account at all.
    const lapsed = await resolveContinuedConnectionAccounts({
      db,
      settings,
      ...scope,
      sessionId: stale.sessionId,
      intent: stale.intent!,
    });
    expect(lapsed.mcpAccountBindings).toEqual([]);
    expect(lapsed.gaps).toEqual([
      { serverId: linear.id, connectionId: picked, reason: "account_inactive" },
    ]);

    // An id the sender can't see (typo'd, forged or deleted) is still refused.
    await expect(
      send([{ serverId: linear.id, connectionId: crypto.randomUUID() }]),
    ).rejects.toMatchObject({ diagnostic: { reason: "selected_account_unavailable" } });
  }, 180_000);

  test("in a shared chat, the reconnect notice goes to the sender once, not the chat's owner", async () => {
    if (!available) return;
    const {
      grant,
      subjectId: owner,
      scope,
      joinOrganization,
      addLogin,
      expire,
      newChat,
      sendIn,
    } = await fixture();
    const sender = `user:${crypto.randomUUID()}`;
    await grantWorkspaceAccess(db, {
      ...scope,
      subjectId: sender,
      subjectLabel: "Bea",
      permissions: [...grant.permissions],
    });
    await joinOrganization(sender);
    const senderGrant = { ...grant, subjectId: sender, subjectLabel: "Bea" };
    const lapsedLogin = await addLogin("bea@example.test", sender);
    await expire(lapsedLogin);

    // The owner's shared chat; the sender's follow-up picks her expired account.
    const sessionId = await newChat("workspace_shared");
    const pick = [{ serverId: linear.id, connectionId: lapsedLogin }];
    const first = await sendIn(sessionId, pick, senderGrant);
    expect(first.bindings).toEqual([]);

    const key = connectionNeedsReauthNoticeKey(lapsedLogin);
    const notices = async () =>
      (await listSessionEvents(db, scope.workspaceId, sessionId)).filter(
        (event) =>
          event.type === "session.notification.posted" &&
          (event.payload as { key?: string }).key === key,
      );
    const posted = await notices();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.turnId).toBe(first.turnId);
    const inboxOf = async (person: string) =>
      (await listInboxItems(db, { accountId: scope.accountId, subjectId: person })).filter(
        (item) => item.sessionId === sessionId && item.kind === "notification",
      );
    const senderItems = await inboxOf(sender);
    expect(senderItems.map((item) => item.title)).toEqual(["Linear needs reconnecting"]);
    // The owner never sees the sender's account label.
    expect(await inboxOf(owner)).toEqual([]);

    // Sending again while it is still broken posts nothing new.
    await sendIn(sessionId, pick, senderGrant);
    expect(await notices()).toHaveLength(1);

    // Once dismissed, it stays dismissed through later sends.
    const itemId = senderItems[0]!.id;
    expect(
      await dismissInboxNotification(db, { itemId, accountId: scope.accountId, subjectId: sender }),
    ).toBe(true);
    await sendIn(sessionId, pick, senderGrant);
    expect(await notices()).toHaveLength(1);
    expect(await inboxOf(sender)).toEqual([]);
    expect(
      (await getInboxItem(db, { itemId, accountId: scope.accountId, subjectId: sender }))?.status,
    ).toBe("dismissed");
  }, 180_000);
});
