import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
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
import { saveHumanComposerDraft } from "../src/application/session-commands";
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

describe("sending with an account list loaded earlier", () => {
  test("an account that stopped working after the chat loaded is left out, never swapped", async () => {
    if (!available) return;
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
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const scope = { accountId: grant.accountId, workspaceId };
    const admin = shared!.admin;
    // Personal accounts follow their owner through the organization membership.
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
      values (${scope.accountId}, ${subjectId}, 'active', ${personal!.id})
    `;
    const logins = new Map<string, { version: number }>();
    const addLogin = async (email: string) => {
      const connection = await persistProviderOAuthConnection(db, {
        ...scope,
        subjectId,
        visibleToSubjectId: subjectId,
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
      logins.set(connection.id, { version: connection.version });
      return connection.id;
    };
    const expire = async (connectionId: string) => {
      const moved = await setConnectionStatus(
        db,
        workspaceId,
        "needs_reauth",
        "connection refresh failed with HTTP 403",
        { id: connectionId, version: logins.get(connectionId)!.version, subjectId },
      );
      if (!moved) throw new Error("connection status did not change");
    };
    const picked = await addLogin("work@example.test");
    const other = await addLogin("home@example.test");
    const settings = testSettings({ sandboxBackend: "none", mcpServers: [linear] });
    const deps = {
      settings,
      db,
      bus: new MemoryEventBus(),
      workflowClient: { wakeSessionWorkflow: async () => undefined },
      objectStorage: null,
    } as unknown as Parameters<typeof submitComposerDraftForRequest>[0];

    // The composer's inventory, read when the chat opened: both work.
    const inventory = await listOwnConnectionAccountsForGrant(db, grant);
    expect(inventory.map((row) => row.id).sort()).toEqual([picked, other].sort());

    const send = async (connectionAccounts: { serverId: string; connectionId: string }[]) => {
      const session = await createSession(db, {
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
      });
      const saved = await saveHumanComposerDraft(
        { db },
        { accountId: grant.accountId, workspaceId, sessionId: session.id, subjectId },
        {
          expectedRevision: 0,
          text: "follow up on the Linear issue",
          annotations: [],
          resources: [],
          model: "scripted-model",
          reasoningEffort: "low",
          latencyMode: "standard",
        },
      );
      const accepted = await submitComposerDraftForRequest(deps, grant, workspaceId, session.id, {
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
      return { ...turn!, sessionId: session.id };
    };

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
});
