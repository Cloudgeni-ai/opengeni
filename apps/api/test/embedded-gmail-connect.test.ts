import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
  createConnection,
  getConnectionMetadata,
  loadConnectionCredentialForBroker,
  refreshOAuthConnectionCredential,
  ConnectionRefreshHttpError,
  createOrganizationApiKey,
  deleteWorkspace,
  ensureExternalIdentity,
  revokeOrganizationApiKey,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";
import {
  OFFICIAL_GMAIL_MCP_SCOPES,
  OFFICIAL_GMAIL_MCP_URL,
} from "../src/integrations/oauth-profiles";
import * as network from "@opengeni/network";
import { readSignedState } from "@opengeni/github";
import postgres from "postgres";

let fixture: SharedTestDatabase;
let client: DbClient;
const workspaces: string[] = [];
beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = adminUrl ? postgres(adminUrl, { max: 4 }) : null;
  const acquired =
    admin && adminUrl && appUrl
      ? {
          admin,
          adminUrl,
          appUrl,
          release: async () => {
            await admin.end();
          },
        }
      : await acquireSharedTestDatabase("embedded-gmail-connect");
  if (!acquired) throw new Error("PostgreSQL fixture required");
  fixture = acquired;
  client = createDb(fixture.appUrl);
}, 180_000);
afterAll(async () => {
  for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  await client?.close();
  await fixture?.release();
});

test.each(["personal"] as const)(
  "Gmail %s callback binds the exact attempt and preserves lifecycle authority",
  async (ownership) => {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: randomUUID(),
      accountName: "Mail callback",
      workspaceExternalSource: "test",
      workspaceExternalId: randomUUID(),
      workspaceName: "Fixture",
      subjectId: `user:${randomUUID()}`,
    });
    const grant = access.workspaceGrants[0]!;
    workspaces.push(grant.workspaceId);
    const identity = await ensureExternalIdentity(client.db, {
      accountId: grant.accountId,
      externalId: "callback-user",
    });
    const key = randomBytes(24).toString("hex");
    const apiKey = await createOrganizationApiKey(client.db, {
      accountId: grant.accountId,
      name: "Fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(key).digest("hex"),
      permissions: ["workspace:read", "connections:read", "connections:write"],
    });
    const secret = "gmail-callback-synthetic-state";
    const returnUrl = "https://HOST.example:443/settings?opaque=%2f#Gmail";
    const encryptionKey = randomBytes(32).toString("base64");
    const app = createApp({
      db: client.db,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
      settings: testSettings({
        productAccessMode: "managed",
        integrationsEnabled: true,
        publicBaseUrl: "https://runtime.example.test",
        environmentsEncryptionKey: encryptionKey,
        integrationsStateSecret: secret,
        integrationsOauthClientsJson: JSON.stringify({
          "https://accounts.google.com": {
            clientId: "fixture-client",
            clientSecret: "fixture-secret",
            tokenEndpointAuthMethod: "client_secret_post",
          },
        }),
      }),
    });
    const headers = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-opengeni-external-actor": encodeURIComponent(
        JSON.stringify({
          mode: "external",
          identity: { externalId: identity.externalId },
        }),
      ),
    };
    const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect/attempts`;
    let exchanges = 0;
    let profileChecks = 0;
    let previewRequests = 0;
    let profileResponse: "valid" | "malformed" | "rejected" | "unavailable" = "valid";
    let hasRefreshToken = true;
    let reportedScopes: unknown = OFFICIAL_GMAIL_MCP_SCOPES.join(" ");
    let tokenRejected = false;
    const realPinnedFetch = network.pinnedFetch;
    // Exercise real routes, signed state, database claims and receipts. Only the
    // outbound transport is synthetic; unexpected destinations fail closed.
    const transport = spyOn(network, "pinnedFetch").mockImplementation(
      async (input, init, settings, options) => {
        if (options?.fetchImpl) return realPinnedFetch(input, init, settings, options);
        const url = String(input);
        if (new URL(url).hostname === "gmailmcp.googleapis.com") {
          previewRequests++;
          throw new Error("The Gmail preview is unavailable and must never be contacted");
        }
        if (url === "https://accounts.google.com/.well-known/openid-configuration")
          return Response.json({
            issuer: "https://accounts.google.com",
            authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint: "https://oauth2.googleapis.com/token",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          });
        if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
          profileChecks++;
          expect(init?.method).toBe("GET");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-access");
          if (profileResponse === "rejected") return new Response(null, { status: 401 });
          if (profileResponse === "unavailable") return new Response(null, { status: 503 });
          return Response.json(
            profileResponse === "malformed"
              ? {}
              : {
                  emailAddress: "mailbox@example.test",
                  messagesTotal: 99,
                  historyId: "private-history",
                },
          );
        }
        if (url === "https://oauth2.googleapis.com/token") {
          exchanges++;
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe("fixture-client");
          expect(body.get("client_secret")).toBe("fixture-secret");
          expect(body.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
          expect(body.has("resource")).toBe(false);
          if (tokenRejected) return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json({
            access_token: "synthetic-access",
            ...(hasRefreshToken ? { refresh_token: "synthetic-refresh" } : {}),
            token_type: "Bearer",
            expires_in: 3600,
            ...(reportedScopes !== undefined ? { scope: reportedScopes } : {}),
          });
        }
        throw new Error(`Unexpected synthetic OAuth destination: ${url}`);
      },
    );
    const callback = (state: string, code = true) =>
      app.request(
        `/v1/integrations/oauth/callback?${new URLSearchParams({ state, ...(code ? { code: "synthetic-code" } : {}) })}`,
      );
    const read = async (id: string) => (await app.request(`${base}/${id}`, { headers })).json();
    const begin = async (providerId = "gmail") => {
      const response = await app.request(base, {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId,
          ownership,
          returnUrl,
          idempotencyKey: randomUUID(),
        }),
      });
      expect(response.status).toBe(200);
      const attempt = await response.json();
      const advanced = await app.request(`${base}/${attempt.id}/advance`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedRevision: attempt.revision,
          idempotencyKey: randomUUID(),
          action: { type: "credentials", values: { mcpUrl: OFFICIAL_GMAIL_MCP_URL } },
        }),
      });
      expect(advanced.status).toBe(200);
      const ready = await advanced.json();
      expect(ready.state).toBe("requires_user_action");
      return { attempt: ready, state: new URL(ready.nextAction.url).searchParams.get("state")! };
    };
    const grantFailures = [
      "malformed",
      "rejected",
      "unavailable",
      "missing_refresh",
      "missing_scopes",
      "malformed_scopes",
      "wrong_scopes",
      "missing_readonly",
      "missing_compose",
      "missing_modify",
      "token_rejected",
    ] as const;
    const setGrantFailure = (failure?: (typeof grantFailures)[number]) => {
      profileResponse =
        failure === "malformed" || failure === "rejected" || failure === "unavailable"
          ? failure
          : "valid";
      hasRefreshToken = failure !== "missing_refresh";
      tokenRejected = failure === "token_rejected";
      reportedScopes =
        failure === "missing_scopes"
          ? undefined
          : failure === "malformed_scopes"
            ? { scope: "invalid" }
            : failure === "wrong_scopes"
              ? "https://www.googleapis.com/auth/drive.readonly"
              : OFFICIAL_GMAIL_MCP_SCOPES.filter(
                  (scope) =>
                    !scope.endsWith(
                      failure === "missing_readonly"
                        ? ".readonly"
                        : failure === "missing_compose"
                          ? ".compose"
                          : failure === "missing_modify"
                            ? ".modify"
                            : ".absent",
                    ),
                ).join(" ");
      return failure === "missing_refresh"
        ? "offline_access_unavailable"
        : failure === "token_rejected"
          ? "invalid_grant"
          : failure?.includes("scope") || failure?.startsWith("missing_")
            ? "insufficient_scope"
            : "tools_list_failed";
    };
    try {
      for (const failure of [
        "missing_refresh",
        "malformed",
        "missing_scopes",
        "token_rejected",
      ] as const) {
        const reason = setGrantFailure(failure);
        const initial = await begin();
        expect((await callback(initial.state)).headers.get("location")).toBe(returnUrl);
        expect(await read(initial.attempt.id)).toMatchObject({
          state: "failed",
          credentialsCommitted: false,
          error: { code: reason, retryable: true },
        });
        expect(
          await (
            await app.request(`${base.replace(/\/attempts$/u, "")}/accounts`, { headers })
          ).json(),
        ).toEqual([]);
      }
      setGrantFailure();
      const initialExchanges = exchanges;
      const { attempt, state } = await begin();
      const payload = readSignedState(state, secret) as Record<string, unknown>;
      expect(payload).toMatchObject({
        discoveryMode: "provider_oauth_metadata",
        authorizationServerMetadataUrl:
          "https://accounts.google.com/.well-known/openid-configuration",
        resource: OFFICIAL_GMAIL_MCP_URL,
        resourceParameterSupported: false,
      });
      expect(payload.protectedResourceMetadataUrl).toBeUndefined();
      // Deliberately preserve the original nonce/time when modifying signed
      // fixtures. createSignedState always generates a fresh nonce and timestamp,
      // which would not exercise same-key digest mismatch or expired state.
      const alteredState = (change: Record<string, unknown>) => {
        const encoded = Buffer.from(JSON.stringify({ ...payload, ...change })).toString(
          "base64url",
        );
        return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
      };
      const wrongProviderResponse = await app.request(base, {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: "mcp-bearer",
          ownership: "personal",
          returnUrl,
          idempotencyKey: randomUUID(),
        }),
      });
      expect(wrongProviderResponse.status).toBe(200);
      const wrongProvider = await wrongProviderResponse.json();
      await callback(alteredState({ connectAttemptId: wrongProvider.id }));
      expect(await read(wrongProvider.id)).toEqual(wrongProvider);
      expect(exchanges).toBe(initialExchanges);
      for (const change of [
        { mcpUrl: "https://other.example.test/mcp" },
        { mcpUrl: `${OFFICIAL_GMAIL_MCP_URL}?other=1` },
        { providerDomain: "other.example.test" },
        { resource: "https://other.example.test/mcp" },
        { issuer: "https://other.example.test" },
        { tokenEndpoint: "https://other.example.test/token" },
        { authorizationServerMetadataUrl: "https://other.example.test/metadata" },
        { resourceParameterSupported: true },
        { ownership: "workspace" },
        { ownership: "workspace", discoveryMode: undefined },
        { ownership: undefined },
        { ownership: "invalid" },
        { subjectId: "external_user:other" },
        { returnUrl: "https://other.example.test/return" },
        ...(ownership === "personal" ? [{ personalOwnerVerified: false }] : []),
        { iat: Math.floor(Date.now() / 1000) - 3600 },
      ]) {
        await callback(alteredState(change));
        expect(exchanges).toBe(initialExchanges);
        expect(await read(attempt.id)).toMatchObject({
          state: "requires_user_action",
          revision: attempt.revision,
        });
      }
      expect((await callback(state)).headers.get("location")).toBe(returnUrl);
      const completed = await read(attempt.id);
      expect(completed).toMatchObject({
        state: "complete",
        credentialsCommitted: true,
        account: { providerId: "gmail", ownership },
      });
      const saved = await getConnectionMetadata(
        client.db,
        identity.personalWorkspaceId,
        completed.account.id,
        identity.subjectId,
      );
      expect(saved?.subjectId).toBe(ownership === "personal" ? identity.subjectId : null);
      expect(saved?.metadata).toMatchObject({
        gmailEmail: "mailbox@example.test",
        mcpToolsVerification: { status: "ok", toolCount: 37 },
      });
      expect(JSON.stringify(saved?.metadata)).not.toContain("private-history");
      expect(saved?.grantedScopes).toEqual([...OFFICIAL_GMAIL_MCP_SCOPES]);
      const brokerSettings = testSettings({ environmentsEncryptionKey: encryptionKey });
      const credential = await loadConnectionCredentialForBroker(client.db, brokerSettings, {
        workspaceId: identity.personalWorkspaceId,
        subjectId: identity.subjectId,
        connectionId: completed.account.id,
        providerDomain: "gmailmcp.googleapis.com",
        allowSubjectOwned: true,
      });
      expect(credential?.subjectId).toBe(identity.subjectId);
      for (const status of [200, 400, 503]) {
        const refreshing = refreshOAuthConnectionCredential(
          credential!,
          {
            providerDomain: "gmailmcp.googleapis.com",
            kind: "oauth2",
            subjectScope: "subject",
            resource: OFFICIAL_GMAIL_MCP_URL,
            scopes: [...OFFICIAL_GMAIL_MCP_SCOPES],
          },
          brokerSettings,
          {
            dnsLookup: async () => [{ address: "142.250.74.106", family: 4 }],
            fetchImpl: async (url, init) => {
              expect(String(url)).toBe("https://oauth2.googleapis.com/token");
              const body = new URLSearchParams(String(init?.body));
              expect(body.get("grant_type")).toBe("refresh_token");
              expect(body.get("refresh_token")).toBe("synthetic-refresh");
              expect(body.get("client_id")).toBe("fixture-client");
              expect(body.get("client_secret")).toBe("fixture-secret");
              expect(body.has("resource")).toBe(false);
              return status === 200
                ? Response.json({ access_token: "synthetic-refreshed", expires_in: 3600 })
                : Response.json(
                    { error: status === 400 ? "invalid_grant" : "temporarily_unavailable" },
                    { status },
                  );
            },
          },
        );
        if (status === 200) {
          expect((await refreshing).credential).toMatchObject({
            access_token: "synthetic-refreshed",
            refresh_token: "synthetic-refresh",
            mcp_url: OFFICIAL_GMAIL_MCP_URL,
            resource: OFFICIAL_GMAIL_MCP_URL,
            resource_parameter_supported: false,
          });
        } else {
          await expect(refreshing).rejects.toBeInstanceOf(ConnectionRefreshHttpError);
        }
        expect(
          await getConnectionMetadata(
            client.db,
            identity.personalWorkspaceId,
            completed.account.id,
            identity.subjectId,
          ),
        ).toEqual(saved);
      }
      expect(previewRequests).toBe(0);
      expect(exchanges).toBe(initialExchanges + 1);
      expect((await callback(state)).headers.get("location")).toBe(returnUrl);
      expect(await read(attempt.id)).toEqual(completed);
      // Same operation key with altered signed bytes must not reuse its receipt;
      // a different nonce must not restart an already completed attempt either.
      await callback(alteredState({ clientId: "different" }));
      await callback(alteredState({ nonce: randomUUID() }));
      expect(exchanges).toBe(initialExchanges + 1);
      expect(await read(attempt.id)).toEqual(completed);

      // A failed exact-account reconnect must leave its previous credential
      // version and ownership unchanged; preview availability is irrelevant.
      for (const failure of grantFailures) {
        const reason = setGrantFailure(failure);
        const reconnect = await begin();
        const response = await callback(reconnect.state);
        expect(response.headers.get("location")).toBe(returnUrl);
        const failedAttempt = await read(reconnect.attempt.id);
        expect(failedAttempt).toMatchObject({
          state: "failed",
          credentialsCommitted: false,
          error: { code: reason, retryable: true },
        });
        expect(
          await getConnectionMetadata(
            client.db,
            identity.personalWorkspaceId,
            completed.account.id,
            identity.subjectId,
          ),
        ).toEqual(saved);
        const exchangesBeforeReplay = exchanges;
        await callback(reconnect.state);
        expect(await read(reconnect.attempt.id)).toEqual(failedAttempt);
        expect(exchanges).toBe(exchangesBeforeReplay);
      }
      setGrantFailure();
      expect(previewRequests).toBe(0);
      const verifiedReconnect = await begin();
      expect((await callback(verifiedReconnect.state)).headers.get("location")).toBe(returnUrl);
      expect(await read(verifiedReconnect.attempt.id)).toMatchObject({
        state: "complete",
        credentialsCommitted: true,
        account: { id: completed.account.id, version: saved!.version + 1, ownership },
      });
      expect(profileChecks).toBeGreaterThan(1);
      const acceptedExchanges = exchanges;

      const cancelled = await begin();
      const cancel = await app.request(`${base}/${cancelled.attempt.id}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          expectedRevision: cancelled.attempt.revision,
          idempotencyKey: randomUUID(),
        }),
      });
      expect(cancel.status).toBe(200);
      await callback(cancelled.state);
      expect(await read(cancelled.attempt.id)).toMatchObject({
        state: "cancelled",
        credentialsCommitted: false,
      });
      expect(exchanges).toBe(acceptedExchanges);

      const denied = await begin();
      expect((await callback(denied.state, false)).headers.get("location")).toBe(returnUrl);
      const failed = await read(denied.attempt.id);
      expect(failed).toMatchObject({
        state: "failed",
        credentialsCommitted: false,
        error: { code: "missing_code" },
      });
      await callback(denied.state);
      expect(await read(denied.attempt.id)).toEqual(failed);
      expect(exchanges).toBe(acceptedExchanges);

      const revoked = await begin();
      await revokeOrganizationApiKey(client.db, grant.accountId, apiKey.id);
      await callback(revoked.state);
      await callback(state); // Receipt replay still requires live origin authority.
      expect(exchanges).toBe(acceptedExchanges);
    } finally {
      transport.mockRestore();
    }
  },
  30_000,
);

test("Gmail is discoverable for named users without exposing mailbox credentials or a server URL", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Embedded mail",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "mail-user",
  });
  const key = randomBytes(24).toString("hex");
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["workspace:read", "connections:read", "connections:write"],
  });
  const configuredSettings = testSettings({
    productAccessMode: "managed",
    integrationsEnabled: true,
    publicBaseUrl: "https://runtime.example.test",
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
    integrationsStateSecret: "embedded-mail-fixture-state",
    integrationsOauthClientsJson: JSON.stringify({
      "https://accounts.google.com": {
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        tokenEndpointAuthMethod: "client_secret_post",
      },
    }),
  });
  const app = createApp({
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    settings: configuredSettings,
  });
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
    ),
  };
  const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect`;
  const unconfigured = createApp({
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    settings: { ...configuredSettings, integrationsOauthClientsJson: "{}" },
  });
  const unavailableCatalog = await unconfigured.request(`${base}/catalog`, { headers });
  expect(unavailableCatalog.status).toBe(200);
  expect(
    (await unavailableCatalog.json()).find((item: { id: string }) => item.id === "gmail"),
  ).toMatchObject({ readiness: "needs_configuration" });
  const catalog = await app.request(`${base}/catalog`, { headers });
  expect(catalog.status).toBe(200);
  expect((await catalog.json()).find((item: { id: string }) => item.id === "gmail")).toMatchObject({
    label: "Gmail",
    ownership: ["personal"],
    setup: ["oauth"],
  });
  const serviceCatalog = await app.request(`/v1/workspaces/${grant.workspaceId}/connect/catalog`, {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(serviceCatalog.status).toBe(200);
  expect(
    (await serviceCatalog.json()).find((item: { id: string }) => item.id === "gmail"),
  ).toMatchObject({
    readiness: "unsupported",
    ownership: [],
  });
  const begin = (ownership: string, idempotencyKey = randomUUID()) =>
    app.request(`${base}/attempts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "gmail",
        ownership,
        idempotencyKey,
        returnUrl: "https://product.example.test/chat",
      }),
    });
  const sharedStart = await begin("workspace");
  expect(sharedStart.status).toBe(422);
  expect(await sharedStart.text()).toContain("personal-owned");
  const operation = randomUUID();
  const started = await begin("personal", operation);
  expect(started.status).toBe(200);
  const attempt = await started.json();
  expect(attempt).toMatchObject({
    providerId: "gmail",
    ownership: "personal",
    credentialsCommitted: false,
    integrationInstalled: false,
    nextAction: { type: "credentials", fields: [] },
  });
  const repeated = await begin("personal", operation);
  expect(repeated.status).toBe(200);
  expect((await repeated.json()).id).toBe(attempt.id);
  const accounts = await app.request(`${base}/accounts`, { headers });
  expect(accounts.status).toBe(200);
  expect(await accounts.json()).toEqual([]);
  const connection = async (mcpUrl: string, subjectId: string | null = identity.subjectId) =>
    createConnection(client.db, {
      accountId: grant.accountId,
      workspaceId: identity.personalWorkspaceId,
      subjectId,
      providerDomain: new URL(mcpUrl).hostname,
      kind: "oauth2",
      credentialEncrypted: "synthetic-unreadable-credential",
      metadata: { oauthDiscovery: { issuer: "https://accounts.google.com" }, mcpUrl },
      createdBySubjectId: identity.subjectId,
    });
  const gmail = await connection(OFFICIAL_GMAIL_MCP_URL);
  const legacyShared = await connection(OFFICIAL_GMAIL_MCP_URL, null);
  const other = await connection("https://other.example.test/mcp");
  const reconnect = (reconnectAccountId: string) =>
    app.request(`${base}/attempts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "gmail",
        ownership: "personal",
        reconnectAccountId,
        idempotencyKey: randomUUID(),
        returnUrl: "https://product.example.test/chat",
      }),
    });
  expect((await reconnect(other.id)).status).toBe(404);
  expect((await reconnect(legacyShared.id)).status).toBe(404);
  const legacyStart = await app.request(
    `/v1/workspaces/${identity.personalWorkspaceId}/connections/oauth/start`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        mcpUrl: OFFICIAL_GMAIL_MCP_URL,
        providerDomain: "gmailmcp.googleapis.com",
        connectionId: legacyShared.id,
        ownership: "workspace",
        returnUrl: "https://product.example.test/chat",
      }),
    },
  );
  expect(legacyStart.status).toBe(422);
  expect(await legacyStart.text()).toContain("personal-owned");
  const reconnected = await reconnect(gmail.id);
  expect(reconnected.status).toBe(200);
  expect(await reconnected.json()).toMatchObject({
    account: { id: gmail.id, providerId: "gmail", ownership: "personal" },
  });
  const listed = await (await app.request(`${base}/accounts`, { headers })).json();
  expect(listed.find((account: { id: string }) => account.id === gmail.id)).toMatchObject({
    providerId: "gmail",
    ownership: "personal",
  });
  expect(JSON.stringify(listed)).not.toContain("synthetic-unreadable-credential");
  expect(listed.find((account: { id: string }) => account.id === legacyShared.id)).toMatchObject({
    providerId: "gmail",
    ownership: "workspace",
    status: "auth_needed",
  });
  expect(
    await getConnectionMetadata(
      client.db,
      identity.personalWorkspaceId,
      legacyShared.id,
      identity.subjectId,
    ),
  ).toEqual(legacyShared);
});
