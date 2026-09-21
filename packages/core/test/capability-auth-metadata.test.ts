import { expect, test } from "bun:test";
import { CapabilityCatalogItem, CapabilityInstallation } from "@opengeni/contracts";
import { applyCapabilityEnablement } from "../src/domain/capabilities";

const item = CapabilityCatalogItem.parse({
  id: "mcp:custom",
  name: "Custom service",
  kind: "mcp",
  source: "manual",
  endpointUrl: "https://example.test/mcp",
  runtime: { available: true, mcpServerId: "custom" },
});
const installation = CapabilityInstallation.parse({
  id: crypto.randomUUID(),
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  capabilityId: item.id,
  kind: "mcp",
  status: "active",
  enabledAt: "2026-09-20",
  updatedAt: "2026-09-20",
  config: {
    connectionRef: { providerDomain: "example.test", kind: "oauth2", subjectScope: "subject" },
  },
  metadata: { mcpConnectivity: { status: "ok" } },
});

test("legacy custom native OAuth installation supplies missing recovery metadata without exposing an account", () => {
  const result = applyCapabilityEnablement(item, installation);
  expect(result.authKind).toBe("oauth2");
  expect(result.connectionRef).not.toHaveProperty("connectionId");
  expect(result.endpointUrl).toBe(item.endpointUrl);
});

test("explicit auth contracts, host-managed refs and uninstalled endpoints never become native OAuth by inference", () => {
  expect(applyCapabilityEnablement({ ...item, authKind: "api_key" }, installation).authKind).toBe(
    "api_key",
  );
  expect(applyCapabilityEnablement(item, undefined).authKind).toBeNull();
  expect(
    applyCapabilityEnablement(item, {
      ...installation,
      config: {
        connectionRef: {
          ...(installation.config.connectionRef as object),
          authoritySource: "host",
        },
      },
    }).authKind,
  ).toBeNull();
  expect(
    applyCapabilityEnablement(item, { ...installation, status: "disabled" }).authKind,
  ).toBeNull();
});
