import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as codex from "@opengeni/codex";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { resolveDefaultSessionModel } from "@opengeni/core";
import { bootstrapWorkspace, createDb, encryptEnvironmentValue, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
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
  }, 180_000);
});
