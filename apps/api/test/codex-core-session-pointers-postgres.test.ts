import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant, type Permission } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import {
  bootstrapWorkspace,
  createApiKey,
  createDb,
  createSession,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { organizationReadApiKeyPermissions } from "../src/routes/api-keys";

// Every response that returns a Session shows the Codex pointers by the
// organization's cutover disposition (M3 PR 2b): legacy ids without a cutover
// row, the core binding with an enabled one, nulls with a disabled one, and
// never a failed read because of Codex state.

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const DELEGATION_SECRET = "codex-core-session-pointers-delegation-secret";
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  codexSubscriptionEnabled: true,
});
const SUBJECT = `user:codex-pointers-${crypto.randomUUID()}`;
const LEGACY_PINNED = crypto.randomUUID();
const LEGACY_LAST = crypto.randomUUID();

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let accountId = "";
let workspaceId = "";
let parentId = "";
let childId = "";
let connectionId = "";
const ORGANIZATION_KEY = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;

class FakeWorkflowClient implements SessionWorkflowClient {
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
  async startRigVerification(): Promise<void> {}
}

function deps(): ApiRouteDeps {
  return {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: new FakeWorkflowClient(),
    managedAuth: null,
    objectStorage: null,
    githubStateSecret: "codex-core-session-pointers-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as never;
}

const permissions: Permission[] = ["sessions:read", "sessions:control", "workspace:read"];

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId: SUBJECT,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return await createApp(deps() as never).request(`/v1/workspaces/${workspaceId}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

type Pointers = { codexPinnedCredentialId: string | null; codexLastCredentialId: string | null };
const pointersOf = (session: Pointers & { id: string }) => ({
  id: session.id,
  codexPinnedCredentialId: session.codexPinnedCredentialId,
  codexLastCredentialId: session.codexLastCredentialId,
});

/** Every Session-returning surface, keyed by name, for the two fixture sessions. */
async function everySessionResponse(): Promise<Record<string, Pointers & { id: string }>> {
  const got = await json<Pointers & { id: string }>(await request(`/sessions/${parentId}`));
  const listed = await json<unknown>(await request(`/sessions?limit=50`));
  const listItems = (
    Array.isArray(listed) ? listed : (listed as { sessions: unknown[] }).sessions
  ) as Array<Pointers & { id: string }>;
  const parentLineage = await json<{
    children: Array<{ session: Pointers & { id: string } }>;
  }>(await request(`/sessions/${parentId}/lineage`));
  const childLineage = await json<{ ancestors: Array<Pointers & { id: string }> }>(
    await request(`/sessions/${childId}/lineage`),
  );
  const pinned = await json<Pointers & { id: string; pinned: boolean }>(
    await request(`/sessions/${parentId}/pin`, {
      method: "PUT",
      body: JSON.stringify({ pinned: true }),
    }),
  );
  const unpinned = await json<Pointers & { id: string }>(
    await request(`/sessions/${parentId}/pin`, {
      method: "PUT",
      body: JSON.stringify({ pinned: false }),
    }),
  );
  const grant: AccessGrant = { accountId, workspaceId, subjectId: SUBJECT, permissions };
  const server = buildOpenGeniMcpServer(deps(), { ...grant, principalKind: "human_session" });
  const tool = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools.session_get!;
  const mcpResult = (await tool.handler({ sessionId: parentId, detail: "full" }, {})) as {
    content: Array<{ text: string }>;
  };
  const mcp = JSON.parse(mcpResult.content[0]!.text) as Pointers & { id: string };
  // The organization-wide list (SDK listOrganizationSessions, MCP action catalog).
  const organizationList = await createApp(deps() as never).request(
    `/v1/organizations/${accountId}/sessions?limit=50`,
    { headers: { authorization: `Bearer ${ORGANIZATION_KEY}` } },
  );
  const organizationItems = (
    await json<{ sessions: Array<Pointers & { id: string }> }>(organizationList)
  ).sessions;
  return {
    get: pointersOf(got),
    listParent: pointersOf(listItems.find((item) => item.id === parentId)!),
    listChild: pointersOf(listItems.find((item) => item.id === childId)!),
    lineageChild: pointersOf(parentLineage.children[0]!.session),
    lineageAncestor: pointersOf(childLineage.ancestors[0]!),
    pin: pointersOf(pinned),
    unpin: pointersOf(unpinned),
    mcp: pointersOf(mcp),
    organizationListParent: pointersOf(organizationItems.find((item) => item.id === parentId)!),
    organizationListChild: pointersOf(organizationItems.find((item) => item.id === childId)!),
  };
}

function expectEverywhere(
  responses: Record<string, Pointers & { id: string }>,
  parent: Pointers,
  child: Pointers,
) {
  for (const [surface, value] of Object.entries(responses)) {
    expect({ surface, ...value }).toEqual({
      surface,
      id: value.id,
      ...(value.id === childId ? child : parent),
    });
  }
}

async function setCutover(enabled: boolean | null): Promise<void> {
  if (enabled === null) {
    await shared!.admin`delete from subscription_provider_cutovers
      where account_id = ${accountId}::uuid and provider = 'codex'`;
    return;
  }
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("codex-core-session-pointers");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:test",
    accountExternalId: `codex-pointers-${crypto.randomUUID()}`,
    accountName: "Codex pointers",
    workspaceExternalSource: "opengeni:test",
    workspaceExternalId: `codex-pointers-${crypto.randomUUID()}`,
    workspaceName: "Codex pointers",
    subjectId: SUBJECT,
  });
  accountId = access.defaultAccountId!;
  workspaceId = access.defaultWorkspaceId!;
  const create = async (message: string) =>
    (
      await createSession(client.db, {
        accountId,
        workspaceId,
        initialMessage: message,
        resources: [],
        tools: [],
        metadata: {},
        model: "codex/gpt-5.5",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        subjectId: SUBJECT,
      })
    ).id;
  parentId = await create("Codex pointers parent");
  childId = await create("Codex pointers child");
  const [connection] = await shared.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind, provider_account_id
    ) values (
      ${accountId}::uuid, 'codex', 'subscription', 'v1:AAAA:AAAA', 'shared', 'organization',
      'chatgpt-pointers'
    ) returning id::text as id`;
  connectionId = connection!.id;
  const keyHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ORGANIZATION_KEY)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await createApiKey(client.db, {
    accountId,
    workspaceId: null,
    name: "Codex pointers organization key",
    prefix: ORGANIZATION_KEY.slice(0, 14),
    keyHash,
    permissions: organizationReadApiKeyPermissions,
    credentialKind: "organization",
  });
  // Fixture rows written directly: the legacy pointer columns as legacy wrote
  // them, a child link, and a core binding for the parent only.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set codex_pinned_credential_id = ${LEGACY_PINNED}::uuid,
        codex_last_credential_id = ${LEGACY_LAST}::uuid
      where id in (${parentId}::uuid, ${childId}::uuid)`;
    await tx`update sessions set parent_session_id = ${parentId}::uuid,
        root_session_id = ${parentId}::uuid, nested_agent_depth = 1
      where id = ${childId}::uuid`;
    await tx`insert into subscription_session_bindings (
        account_id, workspace_id, session_id, provider, connection_id, model_id, choice
      ) values (
        ${accountId}::uuid, ${workspaceId}::uuid, ${parentId}::uuid, 'codex',
        ${connectionId}::uuid, 'codex/gpt-5.5', 'explicit'
      )`;
  });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const restores: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  while (restores.length) restores.pop()!.mockRestore();
  if (realDb) await setCutover(null);
});

describe.skipIf(!realDb)("Codex session pointers on every Session response", () => {
  test("without a cutover row every response keeps the legacy pointers", async () => {
    // Migration 0680 seeds every organization on the core; this case
    // reproduces the pre-cutover world (no Codex row).
    await setCutover(null);
    const legacy = { codexPinnedCredentialId: LEGACY_PINNED, codexLastCredentialId: LEGACY_LAST };
    expectEverywhere(await everySessionResponse(), legacy, legacy);
  });

  test("an enabled cutover projects the core binding everywhere", async () => {
    await setCutover(true);
    expectEverywhere(
      await everySessionResponse(),
      { codexPinnedCredentialId: connectionId, codexLastCredentialId: connectionId },
      // No core binding: nulls, never the legacy ids.
      { codexPinnedCredentialId: null, codexLastCredentialId: null },
    );
  });

  test("a disabled cutover (maintenance) shows nulls everywhere", async () => {
    await setCutover(false);
    const none = { codexPinnedCredentialId: null, codexLastCredentialId: null };
    expectEverywhere(await everySessionResponse(), none, none);
  });

  test("an unreadable cutover never fails a session read", async () => {
    await setCutover(true);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    restores.push(
      warn,
      spyOn(opengeniDb, "readCodexCutoverDisposition").mockImplementation(async () => {
        throw new Error("cutover read failed");
      }),
    );
    const none = { codexPinnedCredentialId: null, codexLastCredentialId: null };
    expectEverywhere(await everySessionResponse(), none, none);
    expect(warn).toHaveBeenCalled();
  });
});
