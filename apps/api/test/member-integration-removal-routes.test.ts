import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  deleteWorkspace,
  installApiIntegration,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import type { ApiRouteDeps } from "@opengeni/core";
import { Hono } from "hono";
import { registerApiIntegrationRoutes } from "../src/routes/api-integrations";
import { registerIntegrationFacetRoutes } from "../src/routes/integration-facets";

// A member (connections:write, no capabilities:manage) removes only the API
// integrations and sources they added. Anything an admin, another person or
// no recorded installer added stays with integration admins, who remove
// anything. Each list says which rows the caller may remove.

const DELEGATION_SECRET = "member-integration-removal-route-secret";
const settings = testSettings({ delegationSecret: DELEGATION_SECRET });
const MEMBER = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "connections:read",
  "connections:write",
];
const ADMIN = [...MEMBER, "capabilities:manage"];

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: Hono;
let workspaceId = "";
let accountId = "";
const member = `user:removal-member-${crypto.randomUUID()}`;
const admin = `user:removal-admin-${crypto.randomUUID()}`;
const otherMember = `user:removal-other-${crypto.randomUUID()}`;
const LEGACY = "unattributed-legacy";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-member-integration-removal");
  if (!shared) throw new Error("Real PostgreSQL fixture required");
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `removal-account-${crypto.randomUUID()}`,
    accountName: "Member removal account",
    workspaceExternalSource: "test",
    workspaceExternalId: `removal-workspace-${crypto.randomUUID()}`,
    workspaceName: "Member removal workspace",
    subjectId: admin,
  });
  workspaceId = access.workspaceGrants[0]!.workspaceId;
  accountId = access.workspaceGrants[0]!.accountId;
  for (const subjectId of [member, otherMember]) {
    await shared.admin`insert into workspace_memberships
      (account_id, workspace_id, subject_id, role, permissions)
      values (${accountId}, ${workspaceId}, ${subjectId}, 'member', ${JSON.stringify(MEMBER)}::jsonb)`;
  }
  app = new Hono();
  const deps = { db: client.db, settings } as ApiRouteDeps;
  registerApiIntegrationRoutes(app, deps);
  registerIntegrationFacetRoutes(app, deps);
}, 180_000);

afterAll(async () => {
  if (workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

async function call(
  subjectId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const bearer = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: (subjectId === admin ? ADMIN : MEMBER) as never,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return await app.request(`http://x/v1/workspaces/${workspaceId}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const FACETS = ["own", "admins", "others", "legacy"] as const;

async function installAs(
  subjectId: string,
  name: string,
  key = `${name}-${crypto.randomUUID().slice(0, 8)}`,
) {
  const installed = await installApiIntegration(client.db, {
    accountId,
    workspaceId,
    subjectId,
    capabilityId: `api:removal-${key}`,
    pluginKey: `integration/removal-${key}`,
    serverId: `removal_${key.replaceAll("-", "_")}`,
    name: `Removal ${name}`,
    description: "Who may remove it.",
    definitionId: `removal-${key}`,
    definitionProvenance: "workspace",
    providerDomain: "127.0.0.1",
    protocol: "openapi",
    baseUrl: "https://127.0.0.1/v1/",
    sourceUrl: "https://127.0.0.1/openapi.json",
    authScheme: { kind: "none" },
    instanceKey: "default",
    facetDefinitions: FACETS.map((facetKey) => ({
      facetKey,
      kind: "inbound_trigger" as const,
      configSchema: { type: "object", properties: {}, additionalProperties: false },
      capabilities: { connectionRequired: false, sync: "incremental" as const },
    })),
    revision: {
      id: `openapi:${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      protocol: "openapi",
      definitionId: `removal-${key}`,
      contentSha256: "4".repeat(64),
      source: { url: "https://127.0.0.1/openapi.json" },
      title: `Removal ${name}`,
      tools: [
        {
          id: "list_items",
          operationKey: "inventory.listItems",
          name: "List items",
          description: "List inventory items.",
          inputSchema: { type: "object", properties: {} },
          safety: "read",
          approvalMode: "never",
          deprecated: false,
        },
      ],
      bindings: {
        list_items: {
          method: "get",
          pathTemplate: "/items",
          serverUrl: "https://127.0.0.1/v1/",
          parameters: [],
        },
      },
    },
  });
  return { ...installed, key };
}

type Installed = Awaited<ReturnType<typeof installAs>>;

async function setInstaller(installed: Installed, installer: string) {
  await shared!.admin`update integration_facet_bindings set created_by_subject_id = ${installer}
    where workspace_id = ${workspaceId} and id = ${installed.instanceId}`;
}

const instancePath = (installed: Installed) =>
  `/integrations/${encodeURIComponent(installed.capabilityId)}/instances/default`;

async function listed(subjectId: string): Promise<Record<string, boolean | undefined>> {
  const response = await call(subjectId, "GET", "/integrations");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    integrations: { capabilityId: string; canRemove?: boolean }[];
  };
  return Object.fromEntries(body.integrations.map((row) => [row.capabilityId, row.canRemove]));
}

async function removeInstance(subjectId: string, installed: Installed): Promise<Response> {
  const [row] = await shared!.admin<{ instance_version: number; installation_version: number }[]>`
    select b.version as instance_version, i.version as installation_version
    from integration_facet_bindings b
    join capability_plugin_installations i on i.id = ${installed.pluginInstallationId}
    where b.id = ${installed.instanceId}`;
  return await call(subjectId, "DELETE", instancePath(installed), {
    expectedInstallationVersion: row!.installation_version,
    expectedInstanceVersion: row!.instance_version,
  });
}

describe("members remove only API integrations they added", () => {
  test("the list flags each instance and the removal follows it", async () => {
    const own = await installAs(member, "own");
    const admins = await installAs(admin, "admins");
    const others = await installAs(otherMember, "others");
    const legacy = await installAs(member, "legacy");
    await setInstaller(legacy, LEGACY);

    const forMember = await listed(member);
    expect(forMember[own.capabilityId]).toBe(true);
    expect(forMember[admins.capabilityId]).toBe(false);
    expect(forMember[others.capabilityId]).toBe(false);
    expect(forMember[legacy.capabilityId]).toBe(false);
    const forAdmin = await listed(admin);
    for (const row of [own, admins, others, legacy]) expect(forAdmin[row.capabilityId]).toBe(true);

    for (const row of [admins, others, legacy]) {
      const refused = await removeInstance(member, row);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain(
        "Only an admin can remove an account someone else added",
      );
    }
    expect((await removeInstance(member, own)).status).toBe(200);
    for (const row of [admins, others, legacy]) {
      expect((await removeInstance(admin, row)).status).toBe(200);
    }
    const remaining = await listed(admin);
    for (const row of [own, admins, others, legacy]) {
      expect(remaining[row.capabilityId]).toBeUndefined();
    }
  }, 60_000);

  test("adding a removed instance back makes the new adder its installer", async () => {
    const row = await installAs(admin, "readded");
    expect((await removeInstance(admin, row)).status).toBe(200);
    // A member adds the same account back: it is now theirs to remove.
    const readded = await installAs(member, "readded", row.key);
    expect((await listed(member))[row.capabilityId]).toBe(true);
    expect((await removeInstance(member, readded)).status).toBe(200);
  }, 60_000);
});

describe("members remove only sources they added", () => {
  test("the facet list flags each source and the removal follows it", async () => {
    const installed = await installAs(admin, "facets");
    const base = `${instancePath(installed)}/facets`;
    const configureAs: Record<(typeof FACETS)[number], string> = {
      own: member,
      admins: admin,
      others: otherMember,
      legacy: member,
    };
    for (const facetKey of FACETS) {
      const configured = await call(configureAs[facetKey], "PUT", `${base}/${facetKey}`, {
        displayName: `Source ${facetKey}`,
        config: {},
        idempotencyKey: crypto.randomUUID(),
      });
      expect(configured.status).toBe(201);
    }
    await shared!.admin`update integration_facet_bindings set created_by_subject_id = ${LEGACY}
      where workspace_id = ${workspaceId} and display_name = 'Source legacy'`;

    const flags = async (subjectId: string) => {
      const response = await call(subjectId, "GET", base);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        facets: {
          definition: { facetKey: string };
          binding: { canRemove?: boolean; version: number; status: string } | null;
        }[];
      };
      return Object.fromEntries(
        body.facets.map((facet) => [facet.definition.facetKey, facet.binding]),
      );
    };
    const forMember = await flags(member);
    expect(forMember.own?.canRemove).toBe(true);
    expect(forMember.admins?.canRemove).toBe(false);
    expect(forMember.others?.canRemove).toBe(false);
    expect(forMember.legacy?.canRemove).toBe(false);
    const forAdmin = await flags(admin);
    for (const facetKey of FACETS) expect(forAdmin[facetKey]?.canRemove).toBe(true);

    const remove = async (subjectId: string, facetKey: string) =>
      await call(subjectId, "DELETE", `${base}/${facetKey}`, {
        expectedVersion: forAdmin[facetKey]!.version,
        idempotencyKey: crypto.randomUUID(),
      });
    for (const facetKey of ["admins", "others", "legacy"]) {
      const refused = await remove(member, facetKey);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain(
        "Only an admin can remove a source or setting someone else added",
      );
    }
    expect((await remove(member, "own")).status).toBe(200);
    for (const facetKey of ["admins", "others", "legacy"]) {
      expect((await remove(admin, facetKey)).status).toBe(200);
    }
    const after = await flags(admin);
    for (const facetKey of FACETS) expect(after[facetKey]?.status).toBe("disabled");

    // A member sets up a source an admin removed again: it is now theirs.
    const readded = await call(member, "PUT", `${base}/admins`, {
      displayName: "Source admins",
      config: {},
      expectedVersion: after.admins!.version,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(readded.status).toBeLessThan(300);
    expect((await flags(member)).admins).toMatchObject({ status: "active", canRemove: true });
  }, 60_000);
});
