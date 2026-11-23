import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { submitComposerDraftForRequest } from "../src/application/composer-submit";
import { saveHumanComposerDraft } from "../src/application/session-commands";
import { listOwnConnectionAccountsForGrant } from "../src/domain/personal-connection-delegations";

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
    const admin = shared!.admin;
    const addLogin = async (label: string) =>
      await admin.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${grant.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<{ id: string }[]>`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted, label
          ) values (
            ${grant.accountId}, ${workspaceId}, ${subjectId}, 'linear.app', 'oauth2', 'ciphertext', ${label}
          ) returning id
        `;
        return row!.id;
      });
    const picked = await addLogin("work");
    const other = await addLogin("personal");
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
        model: "previous-model",
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
          model: "previous-model",
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
          intent: { selections: { serverId: string; connectionId: string }[] } | null;
        }[]
      >`
        select mcp_account_bindings as bindings, connection_account_intent as intent
        from session_turns where id = ${accepted.turn.id}
      `;
      return turn!;
    };

    // While it works, the pick is bound exactly.
    const before = await send([{ serverId: linear.id, connectionId: picked }]);
    expect(before.bindings?.map((binding) => binding.connectionId)).toEqual([picked]);

    // Its sign-in expires and a refresh is refused before the next Send.
    await admin`
      update connections set status = 'needs_reauth', last_error = 'connection refresh failed with HTTP 403'
      where id = ${picked}
    `;
    const stale = await send([{ serverId: linear.id, connectionId: picked }]);
    // Accepted, without the expired account and without the unpicked one.
    expect(stale.bindings).toEqual([]);
    // The pick is kept so a continuation narrows the same way, never widening.
    expect(stale.intent?.selections).toEqual([{ serverId: linear.id, connectionId: picked }]);

    // Picks of both accounts keep only the working one.
    const mixed = await send([
      { serverId: linear.id, connectionId: picked },
      { serverId: linear.id, connectionId: other },
    ]);
    expect(mixed.bindings?.map((binding) => binding.connectionId)).toEqual([other]);

    // An account disconnected since the list loaded is no longer visible to
    // the sender; it is left out the same way.
    const removed = await send([{ serverId: linear.id, connectionId: crypto.randomUUID() }]);
    expect(removed.bindings).toEqual([]);
  }, 180_000);
});
