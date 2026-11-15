import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildConnectionTokenResolver,
  type ConnectionBrokerDeps,
  type ConnectionCredentialForBroker,
  type Database,
} from "../src/index";

const nangoSettings = testSettings({
  nangoSecretKey: "nango-secret-test",
  nangoApiBaseUrl: "https://api.nango.test",
}) as Settings;

function nangoCredential(
  overrides: Partial<ConnectionCredentialForBroker> = {},
): ConnectionCredentialForBroker {
  return {
    id: "nango-gmail-connection",
    accountId: "acct_1",
    workspaceId: "ws_1",
    subjectId: "user:a",
    providerDomain: "nango:gmail",
    kind: "oauth2",
    status: "active",
    credential: {
      type: "nango",
      nangoConnectionId: "nc-1",
      providerConfigKey: "google-mail",
      integrationKey: "gmail",
    },
    grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    expiresAt: null,
    lastRefreshAt: null,
    version: 1,
    metadata: { mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1" },
    ...overrides,
  };
}

function deps(credential: ConnectionCredentialForBroker) {
  const counts = { refresh: 0, recordUsed: 0 };
  const value: ConnectionBrokerDeps = {
    withRefreshLock: async (database, _credential, work) => work(database),
    loadCredential: async () => credential,
    recordRefresh: async () => true,
    setStatus: async () => true,
    recordUsed: async () => {
      counts.recordUsed += 1;
    },
    refresh: async () => {
      counts.refresh += 1;
      throw new Error("Nango connections are never refreshed locally");
    },
    encrypt: () => "v1:enc",
    keyBytes: () => new Uint8Array(32),
    now: () => new Date(),
  };
  return { deps: value, counts };
}

const gmailRef = {
  providerDomain: "nango:gmail",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
};

describe("Nango connection credentials", () => {
  test("resolve to Nango proxy headers and transport for a caller that declared it", async () => {
    const { deps: brokerDeps, counts } = deps(nangoCredential());
    const resolver = buildConnectionTokenResolver({} as Database, nangoSettings, brokerDeps);
    const result = await resolver({
      workspaceId: "ws_1",
      subjectId: "user:a",
      serverId: "gmail",
      destinationUrl: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      connectionRef: gmailRef,
      acceptedTransports: ["nango_proxy"],
      forceRefresh: true,
    });
    expect(result).toMatchObject({
      status: "ok",
      connectionId: "nango-gmail-connection",
      headers: {
        authorization: "Bearer nango-secret-test",
        "connection-id": "nc-1",
        "provider-config-key": "google-mail",
      },
      proxy: {
        kind: "nango_proxy",
        baseUrl: "https://api.nango.test",
        integrationKey: "gmail",
        providerConfigKey: "google-mail",
        nangoConnectionId: "nc-1",
      },
      grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    });
    // Nango refreshes provider tokens; even a forced refresh never runs locally.
    expect(counts.refresh).toBe(0);
    expect(counts.recordUsed).toBe(1);
  });

  test("fail closed for callers without the proxy transport or without a deployment key", async () => {
    const input = {
      workspaceId: "ws_1",
      subjectId: "user:a",
      serverId: "gmail",
      destinationUrl: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      connectionRef: gmailRef,
    };
    const configured = buildConnectionTokenResolver(
      {} as Database,
      nangoSettings,
      deps(nangoCredential()).deps,
    );
    await expect(configured(input)).resolves.toMatchObject({
      status: "auth_needed",
      reason: "unsupported_auth",
    });
    const unconfigured = buildConnectionTokenResolver(
      {} as Database,
      testSettings() as Settings,
      deps(nangoCredential()).deps,
    );
    await expect(
      unconfigured({ ...input, acceptedTransports: ["nango_proxy"] }),
    ).resolves.toMatchObject({
      status: "auth_needed",
      reason: "unsupported_auth",
    });
  });

  test("bind only the integration's exact provider routes", async () => {
    const resolver = buildConnectionTokenResolver(
      {} as Database,
      nangoSettings,
      deps(nangoCredential()).deps,
    );
    for (const destinationUrl of [
      "https://gmail.googleapis.com/gmail/v1/users/another/labels",
      "https://www.googleapis.com/drive/v3/files",
      "https://api.nango.test/proxy/gmail/v1/users/me/labels",
    ]) {
      await expect(
        resolver({
          workspaceId: "ws_1",
          subjectId: "user:a",
          serverId: "gmail",
          destinationUrl,
          connectionRef: gmailRef,
          acceptedTransports: ["nango_proxy"],
        }),
      ).resolves.toMatchObject({ status: "auth_needed", reason: "missing_connection" });
    }
  });

  test("native and Nango connections never satisfy each other's reference", async () => {
    const nativeRow = nangoCredential({
      providerDomain: "gmailmcp.googleapis.com",
      credential: { access_token: "native-token", token_type: "Bearer" },
    });
    const nativeResolver = buildConnectionTokenResolver(
      {} as Database,
      nangoSettings,
      deps(nativeRow).deps,
    );
    await expect(
      nativeResolver({
        workspaceId: "ws_1",
        subjectId: "user:a",
        serverId: "gmail",
        destinationUrl: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        connectionRef: gmailRef,
        acceptedTransports: ["nango_proxy"],
      }),
    ).resolves.toMatchObject({ status: "auth_needed", reason: "missing_connection" });
    const nangoResolver = buildConnectionTokenResolver(
      {} as Database,
      nangoSettings,
      deps(nangoCredential()).deps,
    );
    await expect(
      nangoResolver({
        workspaceId: "ws_1",
        subjectId: "user:a",
        serverId: "gmail",
        destinationUrl: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        connectionRef: { ...gmailRef, providerDomain: "gmailmcp.googleapis.com" },
        acceptedTransports: ["nango_proxy"],
      }),
    ).resolves.toMatchObject({ status: "auth_needed", reason: "missing_connection" });
  });

  test("config-only integrations bind to their tool bridge identity", async () => {
    const linkedin = nangoCredential({
      providerDomain: "nango:linkedin",
      credential: {
        type: "nango",
        nangoConnectionId: "nc-2",
        providerConfigKey: "linkedin",
        integrationKey: "linkedin",
      },
      metadata: { mcpUrl: "https://nango.opengeni.invalid/tools/linkedin" },
    });
    const resolver = buildConnectionTokenResolver(
      {} as Database,
      nangoSettings,
      deps(linkedin).deps,
    );
    const ref = {
      providerDomain: "nango:linkedin",
      kind: "oauth2" as const,
      subjectScope: "subject" as const,
    };
    await expect(
      resolver({
        workspaceId: "ws_1",
        subjectId: "user:a",
        serverId: "linkedin",
        destinationUrl: "https://nango.opengeni.invalid/tools/linkedin",
        connectionRef: ref,
        acceptedTransports: ["nango_proxy"],
      }),
    ).resolves.toMatchObject({ status: "ok", proxy: { nangoConnectionId: "nc-2" } });
    await expect(
      resolver({
        workspaceId: "ws_1",
        subjectId: "user:a",
        serverId: "linkedin",
        destinationUrl: "https://api.linkedin.com/v2/ugcPosts",
        connectionRef: ref,
        acceptedTransports: ["nango_proxy"],
      }),
    ).resolves.toMatchObject({ status: "auth_needed", reason: "missing_connection" });
  });
});
