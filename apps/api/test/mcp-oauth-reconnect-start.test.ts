import { describe, expect, mock, test } from "bun:test";
import * as realDb from "@opengeni/db";
import * as realNetwork from "@opengeni/network";
import * as realPolicy from "@opengeni/db/organization-integration-policy";
import { testSettings } from "@opengeni/testing/settings";

// The Capabilities page's Reconnect, as production sent it for Sentry and
// Stripe: the installation's exact connection id, the catalog's vendor domain
// (sentry.io, stripe.com) and the server URL. Connect had saved the row under
// the server's host (mcp.sentry.dev, mcp.stripe.com), so the start answered
// 404 "connection not found", shown as "It may have been removed".

const fakeDb = { fake: "database" };
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const PERSON = "user:person";

class DiscoveryReached extends Error {
  constructor(readonly url: string) {
    super("discovery reached");
  }
}

let saved: Record<string, unknown> | null = null;
const lookups: string[] = [];
const discovered: string[] = [];

mock.module("@opengeni/db", () => ({
  ...realDb,
  getConnectionMetadata: mock(async (...args: Parameters<typeof realDb.getConnectionMetadata>) => {
    if (args[0] !== (fakeDb as never)) return await realDb.getConnectionMetadata(...args);
    lookups.push(args[2]);
    return args[1] === WORKSPACE && args[2] === CONNECTION ? saved : null;
  }),
  getGlobalCatalogOAuthProfile: mock(
    async (...args: Parameters<typeof realDb.getGlobalCatalogOAuthProfile>) =>
      args[0] === (fakeDb as never) ? null : await realDb.getGlobalCatalogOAuthProfile(...args),
  ),
}));
mock.module("@opengeni/db/organization-integration-policy", () => ({
  ...realPolicy,
  withOrganizationIntegrationAcquisition: mock(
    async (
      ...args: Parameters<typeof realPolicy.withOrganizationIntegrationAcquisition>
    ): Promise<unknown> =>
      args[0] === (fakeDb as never)
        ? await args[3](fakeDb as never, null as never)
        : await realPolicy.withOrganizationIntegrationAcquisition(...args),
  ),
}));
// Discovery is the first network step after the account lookup; stop there.
mock.module("@opengeni/network", () => ({
  ...realNetwork,
  pinnedFetch: mock(async (url: string | URL) => {
    discovered.push(String(url));
    throw new DiscoveryReached(String(url));
  }),
}));

const { startMcpOAuth } = await import("../src/integrations/oauth-client");

async function reconnect(input: { mcpUrl: string; catalogDomain: string }): Promise<unknown> {
  try {
    return await startMcpOAuth(
      {
        db: fakeDb,
        settings: testSettings({
          integrationsEnabled: true,
          integrationsStateSecret: "reconnect-state-secret",
          publicBaseUrl: "https://api.opengeni.test",
        }),
      } as never,
      {
        accountId: "account",
        workspaceId: WORKSPACE,
        subjectId: PERSON,
        personalOwnershipAllowed: true,
        requestUrl: "https://api.opengeni.test/v1/connections/oauth/start",
        payload: {
          mcpUrl: input.mcpUrl,
          providerDomain: input.catalogDomain,
          connectionId: CONNECTION,
          ownership: "workspace",
          returnPath: "/integrations",
        },
      } as never,
    );
  } catch (error) {
    return error;
  }
}

describe("MCP OAuth Reconnect start", () => {
  test.each([
    ["Sentry", "https://mcp.sentry.dev/mcp", "mcp.sentry.dev", "sentry.io"],
    ["Stripe", "https://mcp.stripe.com/", "mcp.stripe.com", "stripe.com"],
  ])(
    "%s: Reconnect signs in to the saved account instead of answering 404",
    async (_, mcpUrl, host, catalogDomain) => {
      saved = {
        id: CONNECTION,
        version: 3,
        workspaceId: WORKSPACE,
        subjectId: null,
        kind: "oauth2",
        status: "needs_reauth",
        providerDomain: host,
        grantedScopes: [],
        metadata: { mcpUrl, oauthDiscovery: { mode: "rfc9728_protected_resource" } },
      };
      lookups.length = 0;
      discovered.length = 0;
      const outcome = (await reconnect({ mcpUrl, catalogDomain })) as {
        status?: number;
        message?: string;
      };
      expect(lookups).toEqual([CONNECTION]);
      // The start went on to the provider's own discovery for that endpoint
      // (stopped here by the test), not a 404.
      expect(discovered[0]).toBe(mcpUrl);
      expect(outcome.status).toBe(422);
      expect(outcome.message).toContain("discovery");
    },
  );

  test("a row for another endpoint is still not found", async () => {
    saved = {
      id: CONNECTION,
      version: 1,
      workspaceId: WORKSPACE,
      subjectId: null,
      kind: "oauth2",
      status: "needs_reauth",
      providerDomain: "mcp.sentry.dev",
      grantedScopes: [],
      metadata: { mcpUrl: "https://other.example/mcp" },
    };
    const outcome = (await reconnect({
      mcpUrl: "https://mcp.sentry.dev/mcp",
      catalogDomain: "sentry.io",
    })) as { status?: number; message?: string };
    expect(outcome.status).toBe(404);
    expect(outcome.message).toBe("connection not found");
  });
});
