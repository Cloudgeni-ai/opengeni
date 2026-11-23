import { expect, test } from "bun:test";
import type { ApiIntegrationRuntime } from "@opengeni/db";
import { digestCanonicalJson } from "@opengeni/tool-gateway";
import { targetFenceIntegrationRoutes } from "../src/workspace-tool-gateway";

// The route part of a targeted fence digests the API integration routes at
// preparation and again immediately before the provider request. The
// credential resolve of the call itself runs between the two and stamps the
// connection's last-used time.
const route = (overrides: Partial<ApiIntegrationRuntime> = {}): ApiIntegrationRuntime =>
  ({
    capabilityId: "api:drive",
    pluginKey: "integration/drive",
    pluginInstallationId: "00000000-0000-4000-8000-000000000001",
    installationVersion: 1,
    instanceId: "00000000-0000-4000-8000-000000000002",
    instanceKey: "default",
    displayName: "Drive",
    instanceVersion: 1,
    serverId: "account-1",
    name: "Drive",
    description: null,
    protocol: "openapi",
    definitionId: "drive",
    definitionProvenance: "curated",
    baseUrl: "https://drive.example/v1/",
    sourceUrl: null,
    providerDomain: "drive.example",
    authScheme: { kind: "oauth2" },
    connectionRef: {
      providerDomain: "drive.example",
      connectionId: "00000000-0000-4000-8000-000000000003",
    },
    connectionStatus: "active",
    connectionLastUsedAt: null,
    connectionAuthorityGeneration: 4,
    allowedTools: ["read_drive"],
    requireApproval: ["upload_file"],
    ...overrides,
  }) as ApiIntegrationRuntime;

const digest = (routes: readonly ApiIntegrationRuntime[]) =>
  digestCanonicalJson(targetFenceIntegrationRoutes(routes));

test("using the connection does not change the route a targeted fence compares", () => {
  const prepared = digest([route({ connectionLastUsedAt: "2026-11-22T14:45:50.000Z" })]);
  // What the call's own credential resolve leaves behind.
  const atProviderRequest = digest([route({ connectionLastUsedAt: "2026-11-22T14:45:50.412Z" })]);
  expect(atProviderRequest).toBe(prepared);
  expect(digest([route({ connectionLastUsedAt: null })])).toBe(prepared);
});

test("the connection's status and authority generation still change the route", () => {
  const prepared = digest([route()]);
  expect(digest([route({ connectionStatus: "needs_reauth" })])).not.toBe(prepared);
  expect(digest([route({ connectionAuthorityGeneration: 5 })])).not.toBe(prepared);
  expect(digest([route({ allowedTools: [] })])).not.toBe(prepared);
  expect(digest([])).not.toBe(prepared);
});

test("the compared routes carry no last-used time and leave their input unchanged", () => {
  const input = [route({ connectionLastUsedAt: "2026-11-22T14:45:50.000Z" })];
  const [compared] = targetFenceIntegrationRoutes(input);
  expect(compared).not.toHaveProperty("connectionLastUsedAt");
  expect(compared).toMatchObject({ serverId: "account-1", connectionStatus: "active" });
  expect(input[0]!.connectionLastUsedAt).toBe("2026-11-22T14:45:50.000Z");
});
