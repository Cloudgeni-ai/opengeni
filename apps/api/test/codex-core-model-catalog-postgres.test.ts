import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as codex from "@opengeni/codex";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { resolveDefaultSessionModel } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import { bootstrapWorkspace, createDb, encryptEnvironmentValue, type DbClient } from "@opengeni/db";
import {
  ensureCodexRotationSettings,
  setInitialActiveCodexCredential,
  upsertCodexSubscriptionCredential,
} from "../../../packages/db/test/fixtures/legacy-codex";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

// The workspace model catalog, the server-side default model and fresh
// session creation after the drained Codex cutover (0680). Every organization
// is born with an enabled Codex cutover row, so a core-only connection makes
// Codex available and the default; a disabled row fails closed; no row keeps
// the legacy readers unchanged.

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const DELEGATION_SECRET = "codex-core-model-catalog-delegation-secret";
const encryptionKey = Buffer.alloc(32, 57);
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  codexSubscriptionEnabled: true,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
  sandboxBackend: "none",
});
const codexModels = configuredModels(withCodexCatalogProvider(settings)).filter((model) =>
  model.id.startsWith("codex/"),
);
// The live provider list serves every configured Codex model but the last.
const unserved = codexModels.at(-1)!;
const servedSlugs = codexModels.slice(0, -1).map((model) => model.upstreamModelId);

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("codex-core-model-catalog");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (restores.length) restores.pop()!.mockRestore();
});

function mockLiveModels() {
  const models = spyOn(codex, "fetchCodexModels").mockResolvedValue({
    ok: true,
    status: 200,
    slugs: servedSlugs,
  });
  restores.push(models);
  return models;
}

type Fixture = { accountId: string; workspaceId: string; subjectId: string };

async function organization(): Promise<Fixture> {
  const subjectId = `user:codex-core-catalog-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:test",
    accountExternalId: `codex-core-catalog-${crypto.randomUUID()}`,
    accountName: "Codex core catalog",
    workspaceExternalSource: "opengeni:test",
    workspaceExternalId: `codex-core-catalog-${crypto.randomUUID()}`,
    workspaceName: "Codex core catalog",
    subjectId,
  });
  const fixture = {
    accountId: access.defaultAccountId!,
    workspaceId: access.defaultWorkspaceId!,
    subjectId,
  };
  // 0680 seeds every new organization enabled on the shared core.
  const [cutover] = await shared!.admin<{ enabled: boolean }[]>`
    select enabled from subscription_provider_cutovers
    where account_id = ${fixture.accountId}::uuid and provider = 'codex'`;
  expect(cutover?.enabled).toBe(true);
  return fixture;
}

async function setCutover(fixture: Fixture, enabled: boolean | null): Promise<void> {
  if (enabled === null) {
    await shared!.admin`delete from subscription_provider_cutovers
      where account_id = ${fixture.accountId}::uuid and provider = 'codex'`;
    return;
  }
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${fixture.accountId}::uuid, 'codex', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

function tokens(label: string): string {
  return encryptEnvironmentValue(
    encryptionKey,
    JSON.stringify({
      access_token: `access-${label}`,
      refresh_token: `refresh-${label}`,
      id_token: `id-${label}`,
    }),
  );
}

/** A shared organization-scoped core connection: the only Codex state after 0680. */
async function coreConnection(fixture: Fixture, label: string): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      provider_account_id, plan_type, provider_state, expires_at, last_refresh_at, label
    ) values (
      ${fixture.accountId}::uuid, 'codex', 'subscription', ${tokens(label)}, 'shared',
      'organization', ${`chatgpt-${label}`}, 'pro',
      ${shared!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, now(), ${label}
    ) returning id::text as id`;
  return row!.id;
}

/** A legacy workspace credential, as the pre-cutover connect route wrote it. */
async function legacyCredential(fixture: Fixture, label: string): Promise<string> {
  const upserted = await upsertCodexSubscriptionCredential(client.db, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    credentialEncrypted: tokens(label),
    chatgptAccountId: `chatgpt-${label}`,
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 86_400_000),
    lastRefreshAt: new Date(),
  });
  if (upserted.kind === "unresolved_redemption") throw new Error("unexpected redemption fence");
  await ensureCodexRotationSettings(client.db, fixture.accountId, fixture.workspaceId);
  await setInitialActiveCodexCredential(client.db, fixture.workspaceId, upserted.id);
  return upserted.id;
}

const permissions: Permission[] = [
  "workspace:read",
  "workspace:admin",
  "sessions:read",
  "sessions:create",
];

async function request(fixture: Fixture, path: string, init: RequestInit = {}) {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    subjectId: fixture.subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const app = createApp({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    managedAuth: null,
  } as never);
  return await app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

type CatalogModel = {
  id: string;
  credentialReadiness: { status: string };
  availability: { status: string; selectable: boolean; reason: string | null };
};
type Catalog = {
  models: CatalogModel[];
  defaultSelection?: { model: string; source: string };
};

async function catalog(fixture: Fixture): Promise<Catalog> {
  const response = await request(fixture, `/v1/workspaces/${fixture.workspaceId}/model-catalog`);
  expect(response.status).toBe(200);
  return (await response.json()) as Catalog;
}

function codexEntries(value: Catalog): CatalogModel[] {
  const entries = value.models.filter((model) => model.id.startsWith("codex/"));
  expect(entries.map((entry) => entry.id).sort()).toEqual(
    codexModels.map((model) => model.id).sort(),
  );
  return entries;
}

async function defaultModel(fixture: Fixture) {
  return await resolveDefaultSessionModel(client.db, withCodexCatalogProvider(settings), fixture);
}

describe.skipIf(!realDb)("Codex model catalog and default after the cutover", () => {
  test("a core-only connection makes Codex available, the default, and freshly created", async () => {
    const fixture = await organization();
    await coreConnection(fixture, `core-only-${crypto.randomUUID()}`);
    const models = mockLiveModels();
    const legacyActive = spyOn(opengeniDb, "legacyWorkspaceCodexSubscriptionActive");
    const legacyAccounts = spyOn(opengeniDb, "listCodexAccountStatuses");
    const legacyCredentialRead = spyOn(opengeniDb, "loadCodexCredentialForRun");
    restores.push(legacyActive, legacyAccounts, legacyCredentialRead);

    const value = await catalog(fixture);
    for (const entry of codexEntries(value)) {
      expect({ id: entry.id, readiness: entry.credentialReadiness.status }).toEqual({
        id: entry.id,
        readiness: "ready",
      });
      expect({ id: entry.id, ...entry.availability }).toMatchObject(
        entry.id === unserved.id
          ? { id: entry.id, status: "unavailable", selectable: false, reason: "not_entitled" }
          : { id: entry.id, status: "available", selectable: true, reason: null },
      );
    }
    expect(value.defaultSelection?.source).toBe("subscription");
    expect(value.defaultSelection?.model.startsWith("codex/")).toBe(true);
    expect(value.defaultSelection?.model).not.toBe(unserved.id);
    expect(models).toHaveBeenCalled();

    // The server-side default for API creates, drafts and occurrences.
    const resolved = await defaultModel(fixture);
    expect(resolved.source).toBe("subscription");
    expect(resolved.model).toBe(value.defaultSelection!.model);

    // A create that names no model takes it, funded by the subscription.
    const created = await request(fixture, `/v1/workspaces/${fixture.workspaceId}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "Run on the connected subscription",
        visibility: "workspace",
        tools: [],
      }),
    });
    expect(created.status).toBe(202);
    expect((await created.json()).model).toBe(resolved.model);

    expect(legacyActive).not.toHaveBeenCalled();
    expect(legacyAccounts).not.toHaveBeenCalled();
    expect(legacyCredentialRead).not.toHaveBeenCalled();
  }, 180_000);

  test("frozen legacy rows never make Codex available on the core", async () => {
    const fixture = await organization();
    await setCutover(fixture, null);
    await legacyCredential(fixture, `frozen-${crypto.randomUUID()}`);
    await setCutover(fixture, true);
    mockLiveModels();
    const value = await catalog(fixture);
    for (const entry of codexEntries(value)) {
      expect({ id: entry.id, selectable: entry.availability.selectable }).toEqual({
        id: entry.id,
        selectable: false,
      });
    }
    expect(value.defaultSelection?.model.startsWith("codex/")).toBe(false);
    expect((await defaultModel(fixture)).model.startsWith("codex/")).toBe(false);
  }, 180_000);

  test("a disabled cutover reports Codex unavailable without reading a legacy table", async () => {
    const fixture = await organization();
    await coreConnection(fixture, `maintenance-${crypto.randomUUID()}`);
    await setCutover(fixture, false);
    const models = mockLiveModels();
    const legacyActive = spyOn(opengeniDb, "legacyWorkspaceCodexSubscriptionActive");
    const legacyAccounts = spyOn(opengeniDb, "listCodexAccountStatuses");
    restores.push(legacyActive, legacyAccounts);
    const value = await catalog(fixture);
    for (const entry of codexEntries(value)) {
      expect({
        id: entry.id,
        readiness: entry.credentialReadiness.status,
        selectable: entry.availability.selectable,
      }).toEqual({ id: entry.id, readiness: "not_ready", selectable: false });
    }
    expect(value.defaultSelection?.model.startsWith("codex/")).toBe(false);
    expect((await defaultModel(fixture)).model.startsWith("codex/")).toBe(false);
    expect(models).not.toHaveBeenCalled();
    expect(legacyActive).not.toHaveBeenCalled();
    expect(legacyAccounts).not.toHaveBeenCalled();
  }, 180_000);

  test("without a cutover row the catalog fails closed even with legacy rows", async () => {
    const fixture = await organization();
    await setCutover(fixture, null);
    // A core connection is invisible to the legacy path.
    await coreConnection(fixture, `ignored-${crypto.randomUUID()}`);
    mockLiveModels();
    const before = await catalog(fixture);
    for (const entry of codexEntries(before)) {
      expect({ id: entry.id, readiness: entry.credentialReadiness.status }).toEqual({
        id: entry.id,
        readiness: "not_ready",
      });
    }
    await legacyCredential(fixture, `legacy-${crypto.randomUUID()}`);
    const after = await catalog(fixture);
    for (const entry of codexEntries(after)) {
      expect({ id: entry.id, selectable: entry.availability.selectable }).toEqual({
        id: entry.id,
        selectable: false,
      });
    }
    expect(after.defaultSelection?.source).not.toBe("subscription");
    expect((await defaultModel(fixture)).source).not.toBe("subscription");
  }, 180_000);

  test("Codex connection access reads the core connection and refuses legacy writes", async () => {
    const fixture = await organization();
    const legacyId = await (async () => {
      await setCutover(fixture, null);
      const id = await legacyCredential(fixture, `access-legacy-${crypto.randomUUID()}`);
      await setCutover(fixture, true);
      return id;
    })();
    const [core] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        provider_account_id, plan_type, managed_by_workspace_id, allowed_model_ids
      ) values (
        ${fixture.accountId}::uuid, 'codex', 'subscription', ${tokens("access-core")}, 'shared',
        'workspaces', ${`chatgpt-access-${crypto.randomUUID()}`}, 'pro',
        ${fixture.workspaceId}::uuid, ${[codexModels[0]!.id]}::text[]
      ) returning id::text as id`;
    await shared!.admin`
      insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
      values (${fixture.accountId}::uuid, ${core!.id}::uuid, ${fixture.workspaceId}::uuid)`;
    const path = (id: string) =>
      `/v1/workspaces/${fixture.workspaceId}/model-connections/codex/${id}/access`;

    const read = await request(fixture, path(core!.id));
    expect(read.status).toBe(200);
    expect((await read.json()).policy).toEqual({
      allowedModels: [codexModels[0]!.id],
      allowedWorkspaces: [fixture.workspaceId],
      allowPersonalWorkspaces: true,
      version: 1,
    });
    // The frozen legacy row is not a core connection.
    expect((await request(fixture, path(legacyId))).status).toBe(404);
    const write = await request(fixture, path(core!.id), {
      method: "PUT",
      body: JSON.stringify({
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        version: 1,
      }),
    });
    expect(write.status).toBe(409);
    const [frozen] = await shared!.admin<{ version: number }[]>`
      select access_policy_version as version from codex_subscription_credentials
      where id = ${legacyId}::uuid`;
    expect(frozen?.version).toBe(1);

    await setCutover(fixture, false);
    expect((await request(fixture, path(core!.id))).status).toBe(503);
  }, 180_000);
});
