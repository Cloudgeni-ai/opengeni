import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { formatSecretReference, type AccessGrant } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  encryptEnvironmentValue,
  ensureDefaultVault,
  upsertVaultItem,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import {
  callWorkspaceToolGateway,
  type PreparedWorkspaceToolGateway,
} from "../src/workspace-tool-gateway";
import {
  withSiteSecretContext,
  workspaceGatewaySecretArguments,
  workspaceGatewaySecretPrincipal,
} from "../src/workspace-tool-gateway-secrets";

setDefaultTimeout(30_000);

const KEY = new Uint8Array(32).fill(9);
const CANARY = `og-canary-gw4-${crypto.randomUUID()}`;
const SITE_ID = "44444444-4444-4444-8444-444444444444";
const SITE_VERSION = "55555555-5555-4555-8555-555555555555";

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-tool-gateway-secrets");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type World = {
  owner: AccessGrant;
  member: AccessGrant;
  viewer: AccessGrant;
  reference: string;
};

async function world(): Promise<World> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: `gw-secrets-account-${suffix}`,
    accountName: "Gateway secrets",
    workspaceExternalSource: "test",
    workspaceExternalId: `gw-secrets-workspace-${suffix}`,
    workspaceName: "Gateway secrets",
    subjectId: `user:owner-${suffix}`,
  });
  const owner = access.workspaceGrants[0]! as AccessGrant;
  const memberSubject = `user:member-${suffix}`;
  const viewerSubject = `user:viewer-${suffix}`;
  for (const [subject, permissions] of [
    [owner.subjectId, ["workspace:admin"]],
    [memberSubject, ["sessions:read", "secrets:use"]],
    [viewerSubject, ["sessions:read"]],
  ] as const) {
    // Active members own a personal workspace.
    const [personal] = await shared!.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name) values (${owner.accountId}::uuid, 'Personal')
      returning id::text as id`;
    await shared!.admin`
      insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
      values (${owner.accountId}::uuid, ${subject}, 'active', 'member', ${personal!.id}::uuid)
      on conflict do nothing`;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, permissions)
      values (${owner.accountId}::uuid, ${owner.workspaceId}::uuid, ${subject},
        ${JSON.stringify(permissions)}::text::jsonb)
      on conflict do nothing`;
  }
  const context = {
    kind: "subject" as const,
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.subjectId,
  };
  const vault = await ensureDefaultVault(client!.db, context, {
    workspaceId: owner.workspaceId,
    ownerKind: "workspace",
  });
  await upsertVaultItem(client!.db, context, {
    vaultId: vault.id,
    name: "Inventory API",
    type: "api_key",
    primaryFieldName: "token",
    fields: [
      {
        name: "token",
        kind: "concealed",
        valueEncrypted: encryptEnvironmentValue(KEY, CANARY),
        valueSize: CANARY.length,
      },
    ],
  });
  const grantFor = (subjectId: string, permissions: string[]): AccessGrant => ({
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId,
    permissions: permissions as AccessGrant["permissions"],
    principalKind: "human_session",
  });
  return {
    owner,
    member: grantFor(memberSubject, ["sessions:read", "secrets:use"]),
    viewer: grantFor(viewerSubject, ["sessions:read"]),
    reference: formatSecretReference({ vault: vault.name, item: "Inventory API", field: "token" }),
  };
}

function gatewayFor(grant: AccessGrant, executed: Array<Record<string, unknown>>) {
  const settings = testSettings({ environmentsEncryptionKey: Buffer.from(KEY).toString("base64") });
  const { catalog, gateway } = createWorkspaceToolGateway({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    generation: 1,
    createdAt: new Date("2026-10-12T00:00:00.000Z"),
    resolveArguments: workspaceGatewaySecretArguments({ db: client!.db, settings, grant }),
    definitions: [
      {
        identity: { serverId: "inventory", toolName: "lookup" },
        modelName: "inventory__lookup",
        codemodePath: ["inventory", "lookup"],
        title: "Inventory lookup",
        inputSchema: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
          additionalProperties: false,
        },
        source: "mcp",
        approval: "none",
        execute: async (argumentsValue) => {
          executed.push(argumentsValue);
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    ],
  });
  return { toolGateway: gateway, toolGatewayCatalog: catalog, close: async () => undefined };
}

function call(
  prepared: PreparedWorkspaceToolGateway,
  grant: AccessGrant,
  reference: string,
  site: boolean,
) {
  return callWorkspaceToolGateway(
    prepared,
    grant,
    {
      operationId: crypto.randomUUID(),
      catalogDigest: prepared.toolGatewayCatalog.digest,
      identity: { serverId: "inventory", toolName: "lookup" },
      arguments: { token: reference },
      ...(site ? { siteArtifactId: SITE_ID, siteVersionId: SITE_VERSION } : {}),
    },
    client!.db,
    undefined,
    undefined,
    async () => undefined,
    async () => ({ siteId: SITE_ID, title: "Inventory Site" }),
  );
}

describe("workspace tool gateway secret references (GW-4)", () => {
  test("Site calls use the viewer principal; other calls use the caller", () => {
    const grant = {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      subjectId: "user:a",
      permissions: [],
    } satisfies AccessGrant;
    expect(
      workspaceGatewaySecretPrincipal(grant, { siteId: SITE_ID, siteVersion: SITE_VERSION }),
    ).toMatchObject({ kind: "site_viewer", subjectId: "user:a", siteId: SITE_ID });
    expect(
      workspaceGatewaySecretPrincipal({ ...grant, principalKind: "human_session" }, null),
    ).toMatchObject({ kind: "human", verifiedHuman: true, viaApiKey: false });
    expect(
      workspaceGatewaySecretPrincipal({ ...grant, principalKind: "api_key" }, null),
    ).toMatchObject({ kind: "human", verifiedHuman: false, viaApiKey: true });
  });

  test("a Site call resolves with the viewer's reach and audits the Site", async () => {
    if (!client) return;
    const fixture = await world();
    const executed: Array<Record<string, unknown>> = [];
    const prepared = gatewayFor(fixture.member, executed);
    const response = await call(prepared, fixture.member, fixture.reference, true);
    expect(response.result.isError ?? false).toBe(false);
    expect(executed).toEqual([{ token: CANARY }]);
    // The response and audit carry no value; the audit names the Site.
    expect(JSON.stringify(response)).not.toContain(CANARY);
    const audits = await shared!.admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where account_id = ${fixture.owner.accountId}::uuid and action = 'vault.secret.used'`;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      surface: "site",
      principalKind: "site_viewer",
      siteId: SITE_ID,
      toolName: "inventory__lookup",
    });
    expect(JSON.stringify(audits)).not.toContain(CANARY);
  });

  test("a Site viewer without secrets:use is refused before the tool runs", async () => {
    if (!client) return;
    const fixture = await world();
    const executed: Array<Record<string, unknown>> = [];
    const prepared = gatewayFor(fixture.viewer, executed);
    const error = await call(prepared, fixture.viewer, fixture.reference, true).catch((e) => e);
    expect(error).toMatchObject({ status: 422, code: "validation_failed" });
    expect(error.details.code).toBe("secret_reference_error");
    expect(error.details.failures[0].raw).toBe(fixture.reference);
    expect(executed).toEqual([]);
    expect(JSON.stringify(error.details)).not.toContain(CANARY);
  });

  test("a direct HTTP call needs secrets:use on the calling human", async () => {
    if (!client) return;
    const fixture = await world();
    const executed: Array<Record<string, unknown>> = [];
    const denied = await call(
      gatewayFor(fixture.viewer, executed),
      fixture.viewer,
      fixture.reference,
      false,
    ).catch((e) => e);
    expect(denied).toMatchObject({ status: 422 });
    expect(denied.details.failures[0].code).toBe("denied");
    expect(executed).toEqual([]);
    await call(gatewayFor(fixture.member, executed), fixture.member, fixture.reference, false);
    expect(executed).toEqual([{ token: CANARY }]);
  });

  test("the Site context does not leak into later calls", async () => {
    let seen: unknown = "unset";
    await withSiteSecretContext({ siteId: SITE_ID, siteVersion: SITE_VERSION }, async () => {
      await withSiteSecretContext(null, async () => {
        seen = null;
      });
    });
    expect(seen).toBeNull();
  });
});
