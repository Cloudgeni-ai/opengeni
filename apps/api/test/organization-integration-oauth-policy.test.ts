import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import {
  beginConnectAttempt,
  createConnection,
  createDb,
  createWorkspace,
  getConnectAttempt,
  listConnectionsMetadata,
  type DbClient,
  installApiIntegration,
  configureIntegrationFacet,
  encryptEnvironmentValue,
  getConnectionMetadata,
} from "@opengeni/db";
import { updateOrganizationIntegrationPolicy } from "@opengeni/db/organization-integration-policy";
import { FIKEN_CREDENTIAL_ROLE, OrganizationIntegrationDeniedError } from "@opengeni/contracts";
import type { ConnectAttempt } from "@opengeni/contracts/connect";
import { requireEnvironmentEncryption, type ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  claimOAuthAcquisition,
  finishOAuthAcquisition,
  startMcpOAuth,
  integrationSourceSelectionRequiresAcquisition,
} from "../src/integrations/oauth-client";
import {
  startAtlassianOAuth,
  saveAtlassianSources,
  transitionAtlassianLifecycle,
} from "../src/integrations/atlassian";
import {
  startGoogleDriveOAuth,
  saveGoogleDriveSource,
  saveGoogleDriveFacetSource,
  transitionGoogleDriveLifecycle,
} from "../src/integrations/google-drive";
import {
  ATLASSIAN_CREDENTIAL_LABEL,
  ATLASSIAN_CREDENTIAL_ROLE,
  ATLASSIAN_PROVIDER_DOMAIN,
  ATLASSIAN_REQUIRED_SCOPES,
} from "@opengeni/contracts/atlassian";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GOOGLE_DRIVE_READONLY_SCOPE,
} from "@opengeni/contracts/google-drive";
import {
  completeFikenOAuthCallback,
  prepareFikenTokenInstall,
  startFikenOAuth,
} from "../src/integrations/fiken";
import { startPersonalGitHubOAuth } from "../src/integrations/personal-github";
import { startApiIntegrationProviderOAuth } from "../src/integrations/provider-oauth";
import { startSocialOAuth } from "../src/integrations/social-oauth";
import { OFFICIAL_GMAIL_MCP_URL, OFFICIAL_SLACK_MCP_URL } from "../src/integrations/oauth-profiles";

let shared: SharedTestDatabase;
let client: DbClient;
const scope = { accountId: crypto.randomUUID(), workspaceId: "", subjectId: "test:oauth-policy" };
const keyId = crypto.randomUUID();
let policyRevision = 0;
const digest = "a".repeat(64);

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) throw new Error("Set both policy fixture URLs");
  const acquired =
    adminUrl && appUrl
      ? {
          admin: postgres(adminUrl),
          adminUrl,
          appUrl,
          release: async () => {
            await shared.admin.end();
          },
        }
      : await acquireSharedTestDatabase("organization-integration-oauth-policy");
  if (!acquired) throw new Error("OAuth policy tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  await shared.admin`insert into managed_accounts (id, name) values (${scope.accountId}, 'OAuth policy fixture')`;
  scope.workspaceId = (
    await createWorkspace(client.db, { accountId: scope.accountId, name: "OAuth policy fixture" })
  ).id;
  await shared.admin`insert into api_keys (id, account_id, name, credential_kind, prefix, key_hash, permissions)
    values (${keyId}, ${scope.accountId}, 'Policy fixture', 'organization', 'test', ${crypto.randomUUID()}, '["workspace:admin"]'::jsonb)`;
}, 180_000);

afterAll(async () => {
  if (shared) await shared.admin`delete from managed_accounts where id = ${scope.accountId}`;
  await client?.close();
  await shared?.release();
});

async function allow(keys: string[]) {
  const policy = await updateOrganizationIntegrationPolicy(
    client.db,
    scope,
    {
      mode: "restricted",
      allowedIntegrationKeys: keys,
      expectedRevision: policyRevision,
      operationId: crypto.randomUUID(),
    },
    async () => ({ accountId: scope.accountId, subjectId: `api_key:${keyId}` }),
  );
  policyRevision = policy.revision;
}

function deps(): ApiRouteDeps {
  return {
    db: client.db,
    fikenFetch: async () => {
      throw new Error("Unexpected provider request in policy preflight test");
    },
    settings: testSettings({
      integrationsEnabled: true,
      integrationsStateSecret: "oauth-policy-fixture-state",
      environmentsEncryptionKey: randomBytes(32).toString("base64"),
      publicBaseUrl: "https://api.example.test",
      githubPersonalOauthEnabled: true,
      githubPersonalOauthClientId: "fixture-client",
      githubPersonalOauthClientSecret: "fixture-secret",
      atlassianClientId: "fixture-client",
      atlassianClientSecret: "fixture-secret",
      fikenClientId: "fixture-client",
      fikenClientSecret: "fixture-secret",
    }),
  } as ApiRouteDeps;
}

test("all OAuth starts and Fiken token preparation deny before provider discovery or effects", async () => {
  await allow([]);
  const api = deps();
  const input = { ...scope, requestUrl: "https://api.example.test/start", payload: {} };
  const starts = [
    () => startAtlassianOAuth(api, input),
    () => startGoogleDriveOAuth(api, { ...input, payload: { capability: "source_read" } }),
    () => startFikenOAuth(api, input),
    () =>
      prepareFikenTokenInstall(api, scope, { apiToken: "fixture-token-never-sent-to-provider" }),
    () =>
      startPersonalGitHubOAuth(api, {
        workspaceId: scope.workspaceId,
        access: { grant: scope } as never,
      }),
    () =>
      startApiIntegrationProviderOAuth(api, {
        ...input,
        personalOwnershipAllowed: true,
        payload: { definitionId: "microsoft-outlook-mail", ownership: "personal" },
      }),
    () =>
      startSocialOAuth(api, {
        ...input,
        personalOwnershipAllowed: true,
        payload: { provider: "x", ownership: "personal" },
      }),
    () =>
      startSocialOAuth(api, {
        ...input,
        personalOwnershipAllowed: true,
        payload: { provider: "reddit", ownership: "personal" },
      }),
    () =>
      startMcpOAuth(api, {
        ...input,
        personalOwnershipAllowed: true,
        payload: { mcpUrl: "https://mcp.example.test/mcp", requestedScopes: [] },
      }),
  ];
  for (const start of starts)
    await expect(start()).rejects.toBeInstanceOf(OrganizationIntegrationDeniedError);
});

test("curated-looking MCP URLs are still custom without a trusted adapter identity", async () => {
  await allow(["gmail", "slack-personal"]);
  for (const mcpUrl of [OFFICIAL_GMAIL_MCP_URL, OFFICIAL_SLACK_MCP_URL]) {
    await expect(
      startMcpOAuth(deps(), {
        ...scope,
        requestUrl: "https://api.example.test/start",
        personalOwnershipAllowed: true,
        payload: { mcpUrl, requestedScopes: [] },
      }),
    ).rejects.toBeInstanceOf(OrganizationIntegrationDeniedError);
  }
  await expect(
    startAtlassianOAuth(deps(), {
      ...scope,
      requestUrl: "https://api.example.test/start",
      payload: {},
    }),
  ).rejects.toBeInstanceOf(OrganizationIntegrationDeniedError);
  await allow(["atlassian"]);
  expect(
    (
      await startAtlassianOAuth(deps(), {
        ...scope,
        requestUrl: "https://api.example.test/start",
        payload: {},
      })
    ).authorizationUrl,
  ).toStartWith("https://auth.atlassian.com/");
});

async function begin(providerId = "atlassian", actorScope = scope) {
  const attempt: ConnectAttempt = {
    id: crypto.randomUUID(),
    workspaceId: scope.workspaceId,
    providerId,
    ownership: "workspace",
    revision: 1,
    state: "requires_user_action",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    nextAction: { type: "authorize", url: "https://provider.example.test/authorize" },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  return beginConnectAttempt(client.db, actorScope, {
    attempt,
    idempotencyKey: attempt.id,
    requestDigest: digest,
    returnUrl: "https://host.example.test/return?exact=%2f#receipt",
  });
}

test("OAuth claim and finish fence late restriction, exact writes and receipt replay", async () => {
  const attempt = await begin();
  let authorized = 0;
  let commits = 0;
  const operation = {
    attemptId: attempt.id,
    operationId: crypto.randomUUID(),
    inputDigest: digest,
    expectedRevision: 1,
    authorize: async () => {
      authorized++;
    },
  };
  await allow([]);
  await expect(
    claimOAuthAcquisition(client.db, scope, operation, "atlassian"),
  ).rejects.toBeInstanceOf(OrganizationIntegrationDeniedError);
  expect((await getConnectAttempt(client.db, scope, attempt.id)).operationInFlight).toBe(false);
  await allow(["atlassian"]);
  expect((await claimOAuthAcquisition(client.db, scope, operation, "atlassian")).status).toBe(
    "claimed",
  );
  // Simulated provider exchange is deliberately OUTSIDE both DB transactions.
  await allow([]);
  const finish = {
    ...operation,
    commit: async (tx: ApiRouteDeps["db"], current: ConnectAttempt) => {
      commits++;
      expect(tx).not.toBe(client.db);
      const connection = await createConnection(tx, {
        ...scope,
        subjectId: null,
        providerDomain: "fixture.example.test",
        kind: "oauth2",
        credentialEncrypted: "fixture-ciphertext",
        grantedScopes: [],
        metadata: {},
        createdBySubjectId: scope.subjectId,
      });
      return {
        ...current,
        revision: current.revision + 1,
        state: "complete" as const,
        credentialsCommitted: true,
        nextAction: { type: "none" as const },
        account: {
          id: connection.id,
          providerId: current.providerId,
          ownership: current.ownership,
          status: "connected" as const,
          label: "Fixture",
        },
      };
    },
  };
  await expect(
    finishOAuthAcquisition(client.db, scope, finish, "atlassian"),
  ).rejects.toBeInstanceOf(OrganizationIntegrationDeniedError);
  expect(commits).toBe(0);
  expect((await getConnectAttempt(client.db, scope, attempt.id)).operationInFlight).toBe(true);
  expect(await listConnectionsMetadata(client.db, scope.workspaceId, scope.subjectId)).toHaveLength(
    0,
  );
  await allow(["atlassian"]);
  const result = await finishOAuthAcquisition(client.db, scope, finish, "atlassian");
  await allow([]);
  expect((await claimOAuthAcquisition(client.db, scope, operation, "atlassian")).status).toBe(
    "replayed",
  );
  expect(await finishOAuthAcquisition(client.db, scope, finish, "atlassian")).toEqual(result);
  expect(commits).toBe(1);
  expect(authorized).toBeGreaterThan(2);
  await expect(
    claimOAuthAcquisition(
      client.db,
      scope,
      { ...operation, inputDigest: "b".repeat(64) },
      "atlassian",
    ),
  ).rejects.toThrow();
  await expect(
    finishOAuthAcquisition(
      client.db,
      scope,
      {
        ...finish,
        authorize: async () => {
          throw new Error("owner revoked");
        },
      },
      "atlassian",
    ),
  ).rejects.toThrow("owner revoked");
});

test("denial claim remains available under deny-all and does not create credentials", async () => {
  await allow([]);
  const attempt = await begin();
  const operation = {
    attemptId: attempt.id,
    operationId: crypto.randomUUID(),
    inputDigest: digest,
    expectedRevision: 1,
    authorize: async () => {},
  };
  expect(
    (await claimOAuthAcquisition(client.db, scope, operation, "atlassian", false)).status,
  ).toBe("claimed");
});

test("legacy Fiken callback preflights exchange and fences a restriction racing the provider", async () => {
  const api = deps();
  const actor = { ...scope, subjectId: `api_key:${keyId}` };
  let exchanges = 0;
  let restrictDuringExchange = false;
  api.fikenFetch = async (input) => {
    if (String(input).includes("/oauth/token")) {
      exchanges++;
      if (restrictDuringExchange) await allow([]);
      return Response.json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
      });
    }
    if (String(input).includes("/companies?"))
      return Response.json([{ slug: "fixture-company", name: "Fixture" }]);
    throw new Error("Unexpected provider fixture request");
  };
  const start = async () => {
    const started = await startFikenOAuth(api, {
      ...actor,
      requestUrl: "https://api.example.test/start",
      payload: {},
    });
    return new URL(started.authorizationUrl).searchParams.get("state")!;
  };
  const callback = (state: string) =>
    completeFikenOAuthCallback(api, {
      state,
      code: "fixture-code",
      requestUrl: "https://api.example.test/callback",
    });
  const count = async () =>
    (await listConnectionsMetadata(client.db, scope.workspaceId, actor.subjectId)).filter(
      (connection) => connection.metadata.credentialRole === FIKEN_CREDENTIAL_ROLE,
    ).length;
  const before = await count();
  await allow(["fiken"]);
  const denied = await start();
  await allow([]);
  expect(new URL((await callback(denied)).redirectTo).searchParams.get("fiken")).toBe("error");
  expect(exchanges).toBe(0);
  await allow(["fiken"]);
  const late = await start();
  restrictDuringExchange = true;
  expect(new URL((await callback(late)).redirectTo).searchParams.get("fiken")).toBe("error");
  expect(exchanges).toBe(1);
  expect(await count()).toBe(before);
  restrictDuringExchange = false;
  await allow(["fiken"]);
  const good = await start();
  expect(new URL((await callback(good)).redirectTo).searchParams.get("fiken")).toBe("connected");
  expect(exchanges).toBe(2);
  expect(await count()).toBe(before + 1);
  await allow([]);
  await callback(good);
  expect(exchanges).toBe(2);
});

test("linked Fiken completed receipt and provider denial remain readable under restriction", async () => {
  const api = deps();
  const actor = { ...scope, subjectId: `api_key:${keyId}` };
  let exchanges = 0;
  api.fikenFetch = async (input) => {
    if (String(input).includes("/oauth/token")) {
      exchanges++;
      return Response.json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
      });
    }
    if (String(input).includes("/companies?"))
      return Response.json([{ slug: "fixture-company", name: "Fixture" }]);
    throw new Error("Unexpected provider fixture request");
  };
  const start = async () => {
    const attempt = await begin("fiken-oauth", actor);
    const started = await startFikenOAuth(api, {
      ...actor,
      connectAttemptId: attempt.id,
      requestUrl: "https://api.example.test/start",
      payload: {},
    });
    return { attempt, state: new URL(started.authorizationUrl).searchParams.get("state")! };
  };
  const callback = (state: string, error?: string) =>
    completeFikenOAuthCallback(api, {
      state,
      ...(error ? { error } : { code: "fixture-code" }),
      requestUrl: "https://api.example.test/callback",
    });
  await allow(["fiken"]);
  const good = await start();
  const cancelled = await start();
  const completed = await callback(good.state);
  expect(completed).toEqual({
    redirectTo: "https://host.example.test/return?exact=%2f#receipt",
    exactReturn: true,
  });
  expect(
    (await getConnectAttempt(client.db, actor, good.attempt.id)).attempt.credentialsCommitted,
  ).toBe(true);
  await allow([]);
  expect(await callback(good.state)).toEqual(completed);
  expect(exchanges).toBe(1);
  expect(await callback(cancelled.state, "access_denied")).toEqual(completed);
  expect((await getConnectAttempt(client.db, actor, cancelled.attempt.id)).attempt.state).toBe(
    "cancelled",
  );
  expect(exchanges).toBe(1);
});

test("source comparison preserves nochange/removal/narrowing and detects new authority", () => {
  const source = {
    id: "source",
    syncEnabled: true,
    readPolicy: "ask" as const,
    syncCadence: "hourly",
    destination: { workspaceId: "a" },
    selectedAt: "old",
    configGeneration: 1,
  };
  expect(integrationSourceSelectionRequiresAcquisition([source], [])).toBe(false);
  expect(
    integrationSourceSelectionRequiresAcquisition(
      [source],
      [{ ...source, selectedAt: "new", configGeneration: 2 }],
    ),
  ).toBe(false);
  expect(
    integrationSourceSelectionRequiresAcquisition(
      [source],
      [{ ...source, syncEnabled: false, readPolicy: "block" }],
    ),
  ).toBe(false);
  expect(integrationSourceSelectionRequiresAcquisition([], [source])).toBe(true);
  expect(
    integrationSourceSelectionRequiresAcquisition([source], [{ ...source, readPolicy: "allow" }]),
  ).toBe(true);
  expect(
    integrationSourceSelectionRequiresAcquisition([{ ...source, syncEnabled: false }], [source]),
  ).toBe(true);
  expect(
    integrationSourceSelectionRequiresAcquisition(
      [source],
      [{ ...source, destination: { workspaceId: "b" } }],
    ),
  ).toBe(true);
});

async function sourceConnection(
  provider: "google-drive" | "atlassian",
  state: "paused" | "active",
  credentialEncrypted = "fixture-ciphertext",
) {
  const lifecycle = { state, recoverable: true, observedAt: new Date().toISOString() };
  const metadata =
    provider === "google-drive"
      ? {
          credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
          credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
          googlePermissionId: "fixture-permission",
          googleEmail: "fixture@example.test",
          googleDisplayName: "Fixture",
          accessMode: "readonly",
          verifiedAt: new Date().toISOString(),
          lifecycle,
          selectedSources: [],
        }
      : {
          credentialRole: ATLASSIAN_CREDENTIAL_ROLE,
          credentialLabel: ATLASSIAN_CREDENTIAL_LABEL,
          atlassianAccountId: "fixture-account",
          displayName: "Fixture",
          accessMode: "readonly",
          verifiedAt: new Date().toISOString(),
          lifecycle,
          selectedSources: [],
          sites: [
            {
              cloudId: "fixture-cloud",
              name: "Fixture",
              url: "https://fixture.atlassian.net",
              products: [],
            },
          ],
        };
  return createConnection(client.db, {
    ...scope,
    providerDomain:
      provider === "google-drive" ? GOOGLE_DRIVE_PROVIDER_DOMAIN : ATLASSIAN_PROVIDER_DOMAIN,
    kind: "oauth2",
    credentialEncrypted,
    metadata,
    grantedScopes:
      provider === "google-drive" ? [GOOGLE_DRIVE_READONLY_SCOPE] : [...ATLASSIAN_REQUIRED_SCOPES],
    createdBySubjectId: scope.subjectId,
  });
}

test("provider resume gates paused acquisition, preserving already-active convergence and pause", async () => {
  for (const provider of ["google-drive", "atlassian"] as const) {
    const api = deps();
    const transition =
      provider === "google-drive" ? transitionGoogleDriveLifecycle : transitionAtlassianLifecycle;
    const connection = await sourceConnection(provider, "paused");
    const input = {
      workspaceId: scope.workspaceId,
      subjectId: scope.subjectId,
      connectionId: connection.id,
      payload: { action: "resume" as const, expectedVersion: connection.version },
    };
    await allow([]);
    await expect(transition(api, input)).rejects.toBeInstanceOf(OrganizationIntegrationDeniedError);
    await allow([provider]);
    const resumed = await transition(api, input);
    await allow([]);
    const nochange = await transition(api, {
      ...input,
      payload: { action: "resume", expectedVersion: resumed.version },
    });
    expect(nochange.metadata.lifecycle).toMatchObject({ state: "active" });
    const paused = await transition(api, {
      ...input,
      payload: { action: "pause", expectedVersion: nochange.version },
    });
    expect(paused.metadata.lifecycle).toMatchObject({ state: "paused" });
  }
});

test("legacy provider source additions deny before provider use while empty selection remains available", async () => {
  await allow([]);
  const api = deps();
  let providerCalls = 0;
  const unexpectedProvider = async () => {
    providerCalls++;
    throw new Error("Unexpected source provider request");
  };
  api.googleDriveFetch = unexpectedProvider;
  api.atlassianFetch = unexpectedProvider;
  for (const provider of ["google-drive", "atlassian"] as const) {
    const connection = await sourceConnection(provider, "active");
    const source =
      provider === "google-drive"
        ? {
            id: "folder-fixture",
            name: "Folder",
            mimeType: "application/vnd.google-apps.folder",
            driveId: null,
          }
        : {
            id: "source-fixture",
            cloudId: "fixture-cloud",
            siteName: "Fixture",
            siteUrl: "https://fixture.atlassian.net",
            resourceId: "project-fixture",
            key: "TEST",
            name: "Project",
            kind: "jira_project",
          };
    const save = provider === "google-drive" ? saveGoogleDriveSource : saveAtlassianSources;
    const input = {
      ...scope,
      connectionId: connection.id,
      grant: scope as never,
      canManageOrganizationDestination: false,
      canManageWorkspaceDestination: true,
      canManagePersonalDestination: false,
      payload: {
        sources: [source],
        destination: { authorityKind: "workspace", collectionId: null },
        syncCadence: "hourly",
        syncEnabled: false,
        readPolicy: "allow",
      },
    };
    await expect(save(api, input)).rejects.toBeInstanceOf(OrganizationIntegrationDeniedError);
    const cleared = await save(api, { ...input, payload: { ...input.payload, sources: [] } });
    expect(cleared.metadata.selectedSources).toEqual([]);
  }
  expect(providerCalls).toBe(0);
});

test("Drive source facet preserves receipts/nochange/reduction and cannot forge curated provenance", async () => {
  await allow(["custom:openapi"]);
  const api = deps();
  api.googleDriveFetch = async () => {
    throw new Error("No provider request expected for receipt/nochange/reduction");
  };
  const connection = await sourceConnection("google-drive", "active");
  const definitionId = `policy-drive-${crypto.randomUUID()}`;
  const capabilityId = `api:${definitionId}`;
  const installed = await installApiIntegration(client.db, {
    ...scope,
    capabilityId,
    definitionId,
    definitionProvenance: "workspace",
    pluginKey: `integration/${definitionId}`,
    serverId: definitionId.replaceAll("-", "_"),
    name: "Drive facet fixture",
    providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
    protocol: "openapi",
    baseUrl: "https://www.googleapis.com/drive/v3/",
    connectionId: connection.id,
    authScheme: { kind: "none" },
    requiredScopes: [],
    ownership: "either",
    facetDefinitions: [
      {
        facetKey: "source",
        kind: "knowledge_source",
        configSchema: { type: "object" },
        capabilities: { provider: "google-drive", connectionRequired: true },
      },
    ],
    revision: {
      id: `openapi:${"2".repeat(24)}`,
      protocol: "openapi",
      definitionId,
      contentSha256: "2".repeat(64),
      source: { url: "https://fixture.example.test/openapi.json" },
      title: "Drive facet fixture",
      tools: [
        {
          id: "list_files",
          operationKey: "listFiles",
          name: "List files",
          description: "List files",
          inputSchema: { type: "object", properties: {} },
          safety: "read",
          approvalMode: "never",
          deprecated: false,
        },
      ],
      bindings: {
        list_files: {
          method: "get",
          pathTemplate: "/files",
          serverUrl: "https://www.googleapis.com/drive/v3/",
          parameters: [],
        },
      },
    },
  });
  const sources = ["folder-one", "folder-two"].map((id) => ({
    id,
    name: id,
    mimeType: "application/vnd.google-apps.folder",
    driveId: null,
  }));
  const config = {
    sources: sources.map(({ driveId: _driveId, ...source }) => ({
      ...source,
      sourceKind: "folder",
      includeDescendants: true,
    })),
    destination: {
      authorityKind: "workspace",
      authorityAccountId: scope.accountId,
      authorityWorkspaceId: scope.workspaceId,
    },
    syncCadence: "hourly",
    readPolicy: "allow",
  };
  const idempotencyKey = crypto.randomUUID();
  const identity = {
    ...scope,
    capabilityId,
    instanceKey: installed.instanceKey,
    facetKey: "source",
  };
  const seeded = await configureIntegrationFacet(client.db, {
    ...identity,
    displayName: "Fixture source",
    config,
    idempotencyKey,
  });
  const input = {
    ...identity,
    canManageOrganizationDestination: false,
    canManageWorkspaceDestination: true,
    canManagePersonalDestination: false,
    payload: {
      sources,
      destination: { authorityKind: "workspace", collectionId: null },
      syncCadence: "hourly",
      syncEnabled: false,
      readPolicy: "allow",
      idempotencyKey,
    },
  };
  await allow([]);
  const replayed = await saveGoogleDriveFacetSource(api, input);
  expect(replayed.binding?.id).toBe(seeded.binding?.id);
  const unchanged = await saveGoogleDriveFacetSource(api, {
    ...input,
    payload: { ...input.payload, idempotencyKey: crypto.randomUUID() },
  });
  expect(unchanged.binding?.id).toBe(seeded.binding?.id);
  const reduced = await saveGoogleDriveFacetSource(api, {
    ...input,
    payload: {
      ...input.payload,
      sources: sources.slice(0, 1),
      expectedVersion: unchanged.binding!.version,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(reduced.binding?.config.sources).toHaveLength(1);
  await allow(["google-drive"]);
  await expect(
    saveGoogleDriveFacetSource(api, {
      ...input,
      payload: {
        ...input.payload,
        expectedVersion: reduced.binding!.version,
        idempotencyKey: crypto.randomUUID(),
      },
    }),
  ).rejects.toBeInstanceOf(OrganizationIntegrationDeniedError);
});

test("Drive source verification stays outside the policy transaction and late restriction prevents selection persistence", async () => {
  await allow(["google-drive"]);
  const api = deps();
  await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role, permissions)
    values (${scope.accountId}, ${scope.workspaceId}, ${scope.subjectId}, 'Fixture', 'admin', '["workspace:admin"]'::jsonb)
    on conflict (workspace_id, subject_id) do nothing`;
  const encrypted = encryptEnvironmentValue(
    requireEnvironmentEncryption(api.settings),
    JSON.stringify({
      access_token: "fixture-access",
      token_type: "Bearer",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    }),
  );
  const connection = await sourceConnection("google-drive", "active", encrypted);
  const source = {
    id: "folder-late",
    name: "Folder late",
    mimeType: "application/vnd.google-apps.folder",
    driveId: null,
  };
  let providerCalls = 0;
  api.googleDriveFetch = async () => {
    providerCalls++;
    await allow([]);
    return Response.json(source);
  };
  await expect(
    saveGoogleDriveSource(api, {
      ...scope,
      connectionId: connection.id,
      grant: scope as never,
      canManageOrganizationDestination: false,
      canManageWorkspaceDestination: true,
      canManagePersonalDestination: false,
      payload: {
        sources: [source],
        destination: { authorityKind: "workspace", collectionId: null },
        syncCadence: "hourly",
        syncEnabled: false,
        readPolicy: "allow",
      },
    }),
  ).rejects.toBeInstanceOf(OrganizationIntegrationDeniedError);
  expect(providerCalls).toBe(1);
  const retained = await getConnectionMetadata(
    client.db,
    scope.workspaceId,
    connection.id,
    scope.subjectId,
  );
  expect(retained?.version).toBe(connection.version);
  expect(retained?.metadata.selectedSources).toEqual([]);
});
