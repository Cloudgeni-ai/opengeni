import { describe, expect, test } from "bun:test";
import {
  effectiveNangoIntegrations,
  type ConnectionMetadata,
  type IntegrationBackendSetting,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import {
  applyNangoBackendsToSettings,
  builtInConnectorCatalogItems,
  catalogProviderDomain,
  configuredMcpCatalogItems,
  connectionsNeedingReconnectFor,
  nangoReplacedSocialProviders,
  projectConnectionsForBackends,
  withFrozenPersonalConnectionDelegations,
  withoutNangoReplacedSocialItems,
} from "../src";

const GMAIL_MCP = "https://gmailmcp.googleapis.com/mcp/v1";

function setting(
  integrationKey: string,
  backend: "native" | "nango",
  definition: IntegrationBackendSetting["definition"] = null,
): IntegrationBackendSetting {
  return {
    integrationKey,
    backend,
    providerConfigKey: backend === "nango" ? `${integrationKey}-managed` : null,
    enabled: true,
    definition,
    revision: 1,
    changedAt: "2026-11-13T00:00:00.000Z",
  };
}

const NANGO_ON = effectiveNangoIntegrations(
  [
    setting("gmail", "nango"),
    setting("linkedin", "nango", {
      displayName: "LinkedIn",
      description: "Post to LinkedIn.",
      tools: { source: "nango", write: ["create-post"] },
    }),
    setting("x", "nango", { displayName: "X", tools: { source: "nango" } }),
  ],
  true,
);
const NANGO_OFF = effectiveNangoIntegrations(
  [setting("gmail", "native"), setting("linkedin", "native"), setting("x", "native")],
  true,
);

function gmailServerSettings() {
  return {
    mcpServers: [
      {
        id: "gmail",
        url: GMAIL_MCP,
        cacheToolsList: false,
        connectionRef: {
          providerDomain: "gmailmcp.googleapis.com",
          subjectScope: "subject" as const,
          kind: "oauth2" as const,
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      },
    ],
  };
}

function connection(overrides: Partial<ConnectionMetadata>): ConnectionMetadata {
  return {
    id: crypto.randomUUID(),
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    subjectId: "user:person",
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    metadata: { mcpUrl: GMAIL_MCP },
    version: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  } as ConnectionMetadata;
}

describe("integration backend switch", () => {
  test("is entirely off without a configured Nango key", () => {
    expect(effectiveNangoIntegrations([setting("gmail", "nango")], false).size).toBe(0);
    const settings = gmailServerSettings();
    expect(applyNangoBackendsToSettings(settings, new Map())).toBe(settings);
  });

  test("a Nango-backed Google connector keeps its identity and resolves only Nango connections", () => {
    const [gmail] = applyNangoBackendsToSettings(gmailServerSettings(), NANGO_ON).mcpServers;
    expect(gmail).toMatchObject({ id: "gmail", url: GMAIL_MCP });
    expect(gmail!.connectionRef).toEqual({
      providerDomain: "nango:gmail",
      subjectScope: "subject",
      kind: "oauth2",
    });
    // Flipping back leaves the native reference exactly as stored.
    const [native] = applyNangoBackendsToSettings(gmailServerSettings(), NANGO_OFF).mcpServers;
    expect(native!.connectionRef!.providerDomain).toBe("gmailmcp.googleapis.com");
    expect(native!.connectionRef!.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    // Installations always store the native catalog identity.
    expect(catalogProviderDomain("nango:gmail")).toBe("gmailmcp.googleapis.com");
    expect(catalogProviderDomain("nango:linkedin")).toBe("nango:linkedin");
  });

  test("the catalog never lists one service twice, in either state", () => {
    for (const backends of [NANGO_ON, NANGO_OFF]) {
      const settings = applyNangoBackendsToSettings(
        { ...testSettings(), socialOauthClientsJson: JSON.stringify({}) },
        backends,
      );
      const items = [
        ...configuredMcpCatalogItems(settings, backends),
        ...withoutNangoReplacedSocialItems(
          builtInConnectorCatalogItems({
            settings,
            socialConnections: [],
            workspaceConnections: [],
          }),
          backends,
        ),
      ];
      const services = items.map(
        (item) =>
          item.metadata.nangoIntegrationKey ??
          (item.metadata.providerAdapter === "social" ? item.metadata.provider : item.id),
      );
      expect(new Set(services).size).toBe(services.length);
      const x = items.filter(
        (item) => item.metadata.nangoIntegrationKey === "x" || item.metadata.provider === "x",
      );
      expect(x).toHaveLength(1);
      expect(x[0]!.metadata.integrationBackend ?? "native").toBe(
        backends === NANGO_ON ? "nango" : "native",
      );
      // LinkedIn is offered only while it is allowlisted.
      expect(items.some((item) => item.metadata.nangoIntegrationKey === "linkedin")).toBe(
        backends === NANGO_ON,
      );
      // Native Google connectors are catalog rows, never added here.
      expect(items.some((item) => item.metadata.nangoIntegrationKey === "gmail")).toBe(false);
    }
    expect([...nangoReplacedSocialProviders(NANGO_ON)]).toEqual(["x"]);
  });

  test("config-only integrations are personal deployment connectors with their allowlist", () => {
    const linkedin = applyNangoBackendsToSettings({ mcpServers: [] }, NANGO_ON).mcpServers.find(
      (server) => server.id === "nango-linkedin",
    );
    expect(linkedin).toMatchObject({
      url: "https://nango.opengeni.invalid/tools/linkedin",
      connectionRef: { providerDomain: "nango:linkedin", subjectScope: "subject", kind: "oauth2" },
    });
  });

  test("native accounts read as needing reconnection while Nango serves them, and back", () => {
    const native = connection({});
    const projected = projectConnectionsForBackends([native], NANGO_ON);
    expect(projected[0]).toMatchObject({ id: native.id, status: "needs_reauth" });
    expect(projected[0]!.metadata.integrationBackendProjection).toBe("reconnect");
    // The reconnect notice still names the Gmail connector served through Nango.
    expect(
      connectionsNeedingReconnectFor(
        [
          {
            connectionId: native.id,
            providerDomain: native.providerDomain,
            mcpUrl: GMAIL_MCP,
            ownership: "personal",
            account: "person@example.com",
            since: native.updatedAt,
            addedHere: true,
          },
        ],
        { providerDomain: "nango:gmail" },
      ),
    ).toHaveLength(1);

    // Once the owner connected through Nango, the native account is superseded.
    const nango = connection({ providerDomain: "nango:gmail" });
    const both = projectConnectionsForBackends([native, nango], NANGO_ON);
    expect(both.map((entry) => entry.status)).toEqual(["needs_reauth", "active"]);
    expect(both[0]!.metadata.integrationBackendProjection).toBe("superseded");

    // Flipping back restores the native account exactly; Nango reads inactive.
    const back = projectConnectionsForBackends([native, nango], NANGO_OFF);
    expect(back[0]).toEqual(native);
    expect(back[1]).toMatchObject({ status: "error" });
    expect(back[1]!.metadata.integrationBackendProjection).toBe("inactive");
    // Stored rows are never changed.
    expect(native.status).toBe("active");
  });

  test("a delegation frozen under the other backend never satisfies a request", async () => {
    const calls: unknown[] = [];
    const resolve = withFrozenPersonalConnectionDelegations({
      resolveCredential: async (request) => {
        calls.push(request);
        return { status: "ok", headers: {} } as never;
      },
      settings: applyNangoBackendsToSettings(gmailServerSettings(), NANGO_ON) as never,
      personalConnectionDelegations: [
        {
          serverId: "gmail",
          connectionId: crypto.randomUUID(),
          ownerSubjectId: "user:person",
          providerDomain: "gmailmcp.googleapis.com",
          kind: "oauth2",
        },
      ],
      ownerHasWorkspaceMembership: async () => true,
    });
    const result = await resolve({
      serverId: "gmail",
      connectionRef: { providerDomain: "nango:gmail", subjectScope: "subject", kind: "oauth2" },
    } as never);
    expect(result.status).not.toBe("ok");
    expect(calls).toHaveLength(0);
  });
});
