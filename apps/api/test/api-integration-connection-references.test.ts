import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { compileOpenApiRevision } from "@opengeni/capabilities";
import {
  ApiIntegrationPreview,
  InstalledApiIntegration,
  signDelegatedAccessToken,
  type InstallApiIntegrationRequest,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  ApiIntegrationConnectionReferenceError,
  bootstrapWorkspace,
  createConnection,
  createDb,
  deleteWorkspace,
  encryptEnvironmentValue,
  grantWorkspaceAccess,
  installApiIntegration,
  listInstalledApiIntegrations,
  type DbClient,
  type InstallApiIntegrationInput,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";

import { registerApiIntegrationRoutes } from "../src/routes/api-integrations";

const delegationSecret = "connection-reference-test-secret";
const encryptionKey = new Uint8Array(32).fill(29);
const source = { kind: "openapi" as const, url: "https://127.0.0.1/reference-openapi.json" };
const document = {
  openapi: "3.1.0",
  info: { title: "Connection reference fixture", version: "1.0.0" },
  servers: [{ url: "https://127.0.0.1/v1/" }],
  components: {
    securitySchemes: { key: { type: "apiKey", in: "header", name: "X-API-Key" } },
  },
  security: [{ key: [] }],
  paths: {
    "/items": {
      get: { operationId: "listItems", responses: { "200": { description: "Items" } } },
    },
  },
};
const oauthSource = {
  kind: "openapi" as const,
  url: "https://127.0.0.1/oauth-reference-openapi.json",
};
const oauthDocument = {
  ...document,
  components: {
    securitySchemes: {
      oauth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://127.0.0.1/authorize",
            tokenUrl: "https://127.0.0.1/token",
            scopes: { "items.read": "Read items" },
          },
        },
      },
    },
  },
  security: [{ oauth: ["items.read"] }],
};

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono;
let accountId = "";
let workspaceId = "";
let foreignWorkspaceId = "";
const subjectId = `user:connection-reference-${crypto.randomUUID()}`;
const foreignSubjectId = `user:foreign-connection-reference-${crypto.randomUUID()}`;
const references = new Map<string, string>();
let sourceFetches = 0;
let duringSourceFetch: (() => Promise<void>) | null = null;
const unexpectedErrors: Error[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-integration-connection-references");
  // This verification must not silently pass without exercising real FORCE RLS.
  if (!shared) throw new Error("Connection-reference tests require a real PostgreSQL fixture");
  client = createDb(shared.appUrl);
  const externalAccountId = `connection-reference-${crypto.randomUUID()}`;
  const bootstrap = async (externalWorkspaceId: string) =>
    (
      await bootstrapWorkspace(client!.db, {
        accountExternalSource: "test",
        accountExternalId: externalAccountId,
        accountName: "Connection reference account",
        workspaceExternalSource: "test",
        workspaceExternalId: externalWorkspaceId,
        workspaceName: "Connection reference workspace",
        subjectId,
      })
    ).workspaceGrants[0]!;
  const grant = await bootstrap(`connection-reference-${crypto.randomUUID()}`);
  accountId = grant.accountId;
  workspaceId = grant.workspaceId;
  const foreignGrant = await bootstrap(`foreign-connection-reference-${crypto.randomUUID()}`);
  expect(foreignGrant.accountId).toBe(accountId);
  foreignWorkspaceId = foreignGrant.workspaceId;
  await grantWorkspaceAccess(client.db, {
    accountId,
    workspaceId,
    subjectId: foreignSubjectId,
    role: "admin",
    permissions: ["workspace:read", "workspace:admin"],
  });
  for (const [name, options] of [
    ["workspace", {}],
    ["personal", { subjectId }],
    ["foreign-workspace", { workspaceId: foreignWorkspaceId }],
    ["foreign-subject", { subjectId: foreignSubjectId }],
    ["inactive", { status: "revoked" }],
    ["provider-mismatch", { providerDomain: "different.example.com" }],
    ["kind-mismatch", { kind: "oauth2" }],
  ] as const) {
    references.set(name, (await connection(options)).id);
  }
  references.set("nonexistent", crypto.randomUUID());
  app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    // The actual registered route is exercised; only the outer 500 response is
    // simplified here (the full API adds its structured public error envelope).
    unexpectedErrors.push(error);
    return c.text("Internal Server Error", 500);
  });
  registerApiIntegrationRoutes(
    app,
    {
      db: client.db,
      settings: testSettings({
        productAccessMode: "managed",
        delegationSecret,
        environmentsEncryptionKey: Buffer.from(encryptionKey).toString("base64"),
      }),
    } as ApiRouteDeps,
    {
      fetchImpl: async (input) => {
        sourceFetches++;
        const change = duringSourceFetch;
        duringSourceFetch = null;
        await change?.();
        const url = input instanceof Request ? input.url : input.toString();
        return Response.json(url === oauthSource.url ? oauthDocument : document);
      },
    },
  );
}, 180_000);

afterAll(async () => {
  for (const id of [workspaceId, foreignWorkspaceId]) {
    if (client && id) await deleteWorkspace(client.db, id);
  }
  await client?.close();
  await shared?.release();
}, 60_000);

async function connection(
  options: {
    workspaceId?: string;
    subjectId?: string;
    status?: string;
    providerDomain?: string;
    kind?: "api_key" | "oauth2";
    grantedScopes?: string[];
  } = {},
) {
  return await createConnection(client!.db, {
    accountId,
    workspaceId,
    providerDomain: "127.0.0.1",
    kind: "api_key",
    credentialEncrypted: encryptEnvironmentValue(
      encryptionKey,
      JSON.stringify({ token: "synthetic-test-key", carrier: "header", name: "X-API-Key" }),
    ),
    createdBySubjectId: options.subjectId ?? subjectId,
    ...options,
  });
}

async function request(path: "preview" | "install", body: unknown, actor = subjectId) {
  const token = await signDelegatedAccessToken(delegationSecret, {
    accountId,
    workspaceId,
    subjectId: actor,
    permissions: ["workspace:read", "capabilities:manage"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return await app.request(`http://x/v1/workspaces/${workspaceId}/integrations/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function installBody(
  connectionId?: string,
  selectedSource: InstallApiIntegrationRequest["source"] = source,
): Promise<InstallApiIntegrationRequest> {
  const response = await request("preview", {
    source: selectedSource,
    ...(connectionId ? { connectionId } : {}),
  });
  if (response.status === 500) throw unexpectedErrors.at(-1);
  expect(response.status).toBe(200);
  const preview = ApiIntegrationPreview.parse(await response.json());
  return {
    source: selectedSource,
    ...(connectionId ? { connectionId } : {}),
    expectedRevisionId: preview.revisionId,
    expectedContentSha256: preview.contentSha256,
    allowedTools: preview.tools.map((tool) => tool.id),
  };
}

function dbInput(connectionId: string): InstallApiIntegrationInput {
  const definitionId = "reference-db-validation";
  return {
    accountId,
    workspaceId,
    subjectId,
    capabilityId: `api:${definitionId}`,
    pluginKey: `integration/${definitionId}`,
    serverId: "reference_db_validation",
    name: "Connection reference DB validation",
    definitionId,
    definitionProvenance: "workspace",
    providerDomain: "127.0.0.1",
    protocol: "openapi",
    baseUrl: "https://127.0.0.1/v1/",
    authScheme: { kind: "api_key", carrier: "header", name: "X-API-Key" },
    connectionId,
    revision: compileOpenApiRevision(document, { definitionId, sourceUrl: source.url }),
  };
}

async function storedBindings() {
  const [bindings, owners] = await Promise.all([
    shared!.admin`
      select * from integration_facet_bindings where workspace_id = ${workspaceId} order by id`,
    shared!.admin`
      select * from integration_facet_binding_owners where workspace_id = ${workspaceId} order by id`,
  ]);
  return { bindings, owners };
}

async function installationCounts() {
  return await shared!.admin`
    select
      (select count(*)::int from capability_plugins where workspace_id = ${workspaceId}) as plugins,
      (select count(*)::int from capability_plugin_versions v join capability_plugins p on p.id = v.plugin_id
        where p.workspace_id = ${workspaceId}) as versions,
      (select count(*)::int from capability_plugin_installations where workspace_id = ${workspaceId}) as plugin_installations,
      (select count(*)::int from capability_facet_installations where workspace_id = ${workspaceId}) as installations,
      (select count(*)::int from capability_facets f
        join capability_plugin_versions v on v.id = f.plugin_version_id
        join capability_plugins p on p.id = v.plugin_id
        where p.workspace_id = ${workspaceId}) as facets,
      (select count(*)::int from integration_facet_bindings where workspace_id = ${workspaceId}) as bindings,
      (select count(*)::int from integration_facet_binding_owners where workspace_id = ${workspaceId}) as owners`;
}

describe("API Integration connection reference rejection (real PostgreSQL)", () => {
  test("uses a non-superuser, non-bypass-RLS application role", async () => {
    const result = await client!.db.execute(sql`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
    expect(result[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  for (const [name, status, message] of [
    ["nonexistent", 404, "connection not found"],
    ["foreign-workspace", 404, "connection not found"],
    ["foreign-subject", 404, "connection not found"],
    ["inactive", 422, "connection is not active"],
    ["provider-mismatch", 422, "Selected Connection does not match the Integration provider"],
    ["kind-mismatch", 422, "This Integration requires a credential Connection, not OAuth"],
  ] as const) {
    for (const path of ["preview", "install"] as const) {
      test(`${path}: ${name} returns ${status}, not 500`, async () => {
        const body = path === "install" ? await installBody() : { source };
        const before = await installationCounts();
        const fetches = sourceFetches;
        const errors = unexpectedErrors.length;
        const response = await request(path, { ...body, connectionId: references.get(name) });
        expect(response.status).toBe(status);
        expect(await response.text()).toBe(message);
        expect(unexpectedErrors.length).toBe(errors);
        expect(await installationCounts()).toEqual(before);
        expect(sourceFetches - fetches).toBe(name.endsWith("mismatch") ? 1 : 0);
      });
    }
  }

  test("omitting a required connection allows preview but returns 422 at install", async () => {
    const body = await installBody();
    const before = await installationCounts();
    const response = await request("install", body);
    expect(response.status).toBe(422);
    expect(await response.text()).toBe("Connect an account before installing this Integration.");
    expect(await installationCounts()).toEqual(before);
  });

  test("DB reference recheck makes missing and invisible IDs indistinguishable", async () => {
    const before = await installationCounts();
    for (const name of ["nonexistent", "foreign-workspace", "foreign-subject"]) {
      await expect(
        installApiIntegration(client!.db, dbInput(references.get(name)!)),
      ).rejects.toMatchObject({
        name: ApiIntegrationConnectionReferenceError.name,
        reason: "not_found",
        message: "API Integration connection was not found in this workspace",
      });
    }
    expect(await installationCounts()).toEqual(before);
  });

  test("matching Workspace and Personal connections install successfully", async () => {
    for (const name of ["workspace", "personal"]) {
      const id = references.get(name)!;
      const body = await installBody(id);
      const response = await request("install", body);
      expect(response.status).toBe(201);
      const installed = InstalledApiIntegration.parse(await response.json());
      const integrations = await listInstalledApiIntegrations(client!.db, workspaceId, subjectId);
      expect(integrations.find((entry) => entry.instanceId === installed.instanceId)).toMatchObject(
        {
          connectionRef: {
            connectionId: id,
            subjectScope: name === "personal" ? "subject" : "workspace",
          },
        },
      );
    }
  });

  test("ownership mismatch and cross-subject rebind preserve existing owner rows", async () => {
    const victimId = references.get("personal")!;
    const body = { ...(await installBody(victimId)), instanceKey: "reference-owner-fence" };
    const installedResponse = await request("install", body);
    expect(installedResponse.status).toBe(201);
    const installed = InstalledApiIntegration.parse(await installedResponse.json());
    const bindings = await storedBindings();
    const counts = await installationCounts();
    const ownershipMismatch = await request("install", { ...body, ownership: "workspace" });
    expect(ownershipMismatch.status).toBe(422);
    expect(await ownershipMismatch.text()).toBe(
      "The selected Connection ownership does not match this install request.",
    );
    const foreign = await request(
      "install",
      {
        ...body,
        connectionId: references.get("foreign-subject"),
        expectedInstanceVersion: installed.instanceVersion,
      },
      foreignSubjectId,
    );
    expect(foreign.status).toBe(409);
    expect(await foreign.text()).toBe(
      "The Integration instance changed or is shared by another owner. Refresh its details before updating it.",
    );
    expect(await storedBindings()).toEqual(bindings);
    expect(await installationCounts()).toEqual(counts);
  });

  test("stale instance OCC rejects a rebind without replacing the original connection", async () => {
    const original = await connection({ subjectId });
    const replacement = await connection({ subjectId });
    const body = { ...(await installBody(original.id)), instanceKey: "reference-occ-fence" };
    const created = await request("install", body);
    expect(created.status).toBe(201);
    const installed = InstalledApiIntegration.parse(await created.json());
    const updated = await request("install", {
      ...body,
      expectedInstanceVersion: installed.instanceVersion,
      displayName: "Updated reference fixture",
    });
    expect(updated.status).toBe(200);
    const current = InstalledApiIntegration.parse(await updated.json());
    expect(current.instanceVersion).toBeGreaterThan(installed.instanceVersion);
    const before = await storedBindings();
    const counts = await installationCounts();
    const stale = await request("install", {
      ...body,
      connectionId: replacement.id,
      expectedInstanceVersion: installed.instanceVersion,
    });
    expect(stale.status).toBe(409);
    expect(await storedBindings()).toEqual(before);
    expect(await installationCounts()).toEqual(counts);
  });

  for (const change of ["subject", "workspace"] as const) {
    test(`database owner fence makes connection ${change} immutable`, async () => {
      const selected = await connection({ subjectId });
      const snapshot = () => shared!.admin`
        select account_id, workspace_id, subject_id, authority_generation
        from connections where id = ${selected.id}`;
      const before = await snapshot();
      const mutation = async () => {
        if (change === "subject") {
          await shared!
            .admin`update connections set subject_id = ${foreignSubjectId} where id = ${selected.id}`;
        } else {
          await shared!
            .admin`update connections set workspace_id = ${foreignWorkspaceId} where id = ${selected.id}`;
        }
      };
      await expect(mutation()).rejects.toMatchObject({
        code: "23514",
        message: "connection owner authority is immutable",
      });
      expect(await snapshot()).toEqual(before);
    });
  }

  for (const [change, status, message] of [
    ["inactive", 422, "API Integration connection is not active"],
    ["provider", 422, "API Integration connection provider does not match the destination"],
    ["deleted", 404, "connection not found"],
    ["kind", 422, "API Integration requires a credential Connection, not OAuth"],
    ["scopes", 422, "API Integration connection is missing required scopes"],
  ] as const) {
    test(`DB-time ${change} connection is rejected without an internal 500 or partial install`, async () => {
      const selected = await connection({
        subjectId,
        ...(change === "scopes" ? { kind: "oauth2", grantedScopes: ["items.read"] } : {}),
      });
      const body = {
        ...(await installBody(selected.id, change === "scopes" ? oauthSource : source)),
        instanceKey: `reference-race-${change}`,
      };
      const bindings = await storedBindings();
      const counts = await installationCounts();
      const errors = unexpectedErrors.length;
      let applied = false;
      duringSourceFetch = async () => {
        if (change === "inactive") {
          await shared!.admin`update connections set status = 'revoked' where id = ${selected.id}`;
        } else if (change === "provider") {
          await shared!
            .admin`update connections set provider_domain = 'different.example.com' where id = ${selected.id}`;
        } else if (change === "deleted") {
          await shared!.admin`delete from connections where id = ${selected.id}`;
        } else if (change === "kind") {
          await shared!.admin`update connections set kind = 'oauth2' where id = ${selected.id}`;
        } else {
          await shared!
            .admin`update connections set granted_scopes = '[]'::jsonb where id = ${selected.id}`;
        }
        applied = true;
      };
      const response = await request("install", body);
      expect(applied).toBe(true);
      expect(await storedBindings()).toEqual(bindings);
      expect(await installationCounts()).toEqual(counts);
      // Observe rollback before checking HTTP mapping so a red test still
      // establishes that the rejection did not corrupt existing owner/OCC rows.
      if (response.status === 500) {
        console.info(
          `[connection-reference:${change}] HTTP 500: ${unexpectedErrors.at(-1)?.message}`,
        );
      }
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(message);
      expect(unexpectedErrors.length).toBe(errors);
    });
  }

  test("unsupported internal auth schemes remain untyped internal failures", async () => {
    const input = dbInput(references.get("workspace")!);
    const before = await installationCounts();
    const error = await installApiIntegration(client!.db, {
      ...input,
      authScheme: { kind: "unsupported_internal_scheme" },
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiIntegrationConnectionReferenceError);
    expect((error as Error).message).toBe("API Integration auth scheme is unsupported");
    expect(await installationCounts()).toEqual(before);
  });

  test("manifest collisions remain internal HTTP 500s", async () => {
    const selectedSource = {
      kind: "openapi_document" as const,
      sourceKey: "reference-internal-failure",
      document: JSON.stringify(document),
    };
    const connectionId = references.get("workspace")!;
    const body = await installBody(connectionId, selectedSource);
    const previewResponse = await request("preview", { source: selectedSource, connectionId });
    expect(previewResponse.status).toBe(200);
    const preview = ApiIntegrationPreview.parse(await previewResponse.json());
    // Seed a conflicting manifest through the internal fixture API, not by
    // bypassing the published-version immutability trigger. The public adapter
    // would never prepare this deliberately inconsistent sourceUrl.
    const installed = await installApiIntegration(client!.db, {
      ...dbInput(connectionId),
      capabilityId: preview.capabilityId,
      pluginKey: preview.pluginKey,
      serverId: preview.serverId,
      name: preview.name,
      definitionId: preview.definitionId,
      baseUrl: preview.baseUrl,
      sourceUrl: "https://127.0.0.1/deliberately-conflicting-source.json",
      revision: compileOpenApiRevision(document, { definitionId: preview.definitionId }),
    });
    expect(installed.revisionId).toBe(body.expectedRevisionId);
    const before = await storedBindings();
    const counts = await installationCounts();
    const collision = await request("install", body);
    expect(collision.status).toBe(500);
    expect(await collision.text()).toBe("Internal Server Error");
    const error = unexpectedErrors.at(-1)!;
    expect(error).not.toBeInstanceOf(ApiIntegrationConnectionReferenceError);
    expect(error.message).toBe(
      `API Integration revision ${installed.revisionId} conflicts with stored content`,
    );
    expect(await storedBindings()).toEqual(before);
    expect(await installationCounts()).toEqual(counts);
  });

  test("published manifest metadata cannot be corrupted by database updates", async () => {
    const installed = await installApiIntegration(
      client!.db,
      dbInput(references.get("workspace")!),
    );
    const snapshot = () => shared!.admin`
      select manifest, manifest_digest from capability_plugin_versions where id = ${installed.pluginVersionId}`;
    const before = await snapshot();
    for (const change of ["digest", "metadata"]) {
      const mutation = async () => {
        if (change === "digest") {
          await shared!.admin`
            update capability_plugin_versions set manifest_digest = ${"0".repeat(64)}
            where id = ${installed.pluginVersionId}`;
        } else {
          await shared!.admin`
            update capability_plugin_versions set manifest = manifest - 'definitionId'
            where id = ${installed.pluginVersionId}`;
        }
      };
      await expect(mutation()).rejects.toMatchObject({
        code: "55000",
        message: "published capability plugin version identity is immutable",
      });
      expect(await snapshot()).toEqual(before);
    }
  });
});
