import { expect, test } from "bun:test";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import { catalogItemConnectable } from "@opengeni/contracts/personal-integration-setup";

import { catalogConnectAccess } from "./capability-copy";

// Enable's "Ask an admin" (the server's readiness check reads
// catalogItemConnectable) must match what the Connect pages offer
// (catalogConnectAccess) for the same person and item.

function item(overrides: Record<string, unknown>) {
  return CapabilityCatalogItem.parse({
    id: "item",
    kind: "mcp",
    source: "registry",
    name: "Item",
    lifecycle: { status: "available", readiness: "setup_required" },
    ...overrides,
  });
}

const items = [
  item({ id: "off" }),
  item({ id: "on", enabled: true, actions: ["connect"] }),
  item({
    id: "on-personal",
    enabled: true,
    connectionRef: { providerDomain: "x.test", kind: "oauth2", subjectScope: "subject" },
  }),
  item({
    id: "reviewed-oauth",
    source: "built_in",
    authKind: "oauth2",
    runtime: { available: true },
  }),
  item({ id: "custom", source: "manual", authKind: "oauth2", runtime: { available: true } }),
  item({ id: "native", kind: "plugin" }),
];

const grants = [
  { permissions: ["workspace:admin"] },
  { permissions: ["workspace:admin"], permissionMode: "explicit" as const },
  { permissions: ["capabilities:manage", "connections:personal"] },
  { permissions: ["connections:personal", "connections:read", "connections:write"] },
  { permissions: ["connections:personal"] },
  { permissions: ["sessions:read"] },
];

test("Enable may connect exactly what the Connect pages let the person connect", () => {
  for (const grant of grants) {
    for (const policy of [undefined, "members", "admins"] as const) {
      for (const entry of items) {
        const page = catalogConnectAccess(entry, grant, "shared", policy).blocked === null;
        expect({
          grant,
          policy,
          item: entry.id,
          connectable: catalogItemConnectable(grant, entry, policy),
        }).toEqual({ grant, policy, item: entry.id, connectable: page });
      }
    }
  }
});
