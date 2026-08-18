import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ConnectionHealth } from "@/lib/capabilities";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";

import { CapabilityTile } from "./capability-tile";
import { FeaturedConnectorTile } from "./featured-connectors";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function item(overrides: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem {
  return {
    id: "mcp:linear",
    kind: "mcp",
    source: "public_registry",
    name: "Linear",
    description: "Issue tracking",
    category: "productivity",
    tags: [],
    homepageUrl: null,
    endpointUrl: null,
    installUrl: null,
    authModel: null,
    providerDomain: "linear.app",
    surfaceType: null,
    transport: null,
    mcpUrl: null,
    authKind: "oauth2",
    credentialFacts: [],
    tier: null,
    provenance: null,
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: { available: true, notes: null },
    lifecycle: { status: "available", readiness: "setup_required", detail: null, managedBy: null },
    actions: [],
    enabled: false,
    enabledReason: null,
    connectionRef: null,
    metadata: {},
    ...overrides,
  } as CapabilityCatalogItem;
}

/** A minimal healthy connection row; health only needs its identity here. */
function connection(): ConnectionMetadata {
  return {
    id: "connection-1",
    accountId: "account-1",
    workspaceId: "workspace-1",
    subjectId: null,
    providerDomain: "linear.app",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {},
    createdBySubjectId: null,
    updatedBySubjectId: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  } as unknown as ConnectionMetadata;
}

const CONNECTED: ConnectionHealth = { state: "connected", connection: connection() };
const ATTENTION: ConnectionHealth = { state: "attention", connection: connection() };

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("CapabilityTile", () => {
  test("only a not-connected tile exposes an interactive quick-connect indicator", async () => {
    const onQuickConnect = mock(() => {});
    const rendered = await render(
      <>
        <CapabilityTile
          item={item()}
          logoSrc={null}
          onOpen={() => {}}
          onQuickConnect={onQuickConnect}
        />
        <CapabilityTile
          item={item({ id: "mcp:notion", name: "Notion", enabled: true })}
          logoSrc={null}
          health={CONNECTED}
          onOpen={() => {}}
          onQuickConnect={onQuickConnect}
        />
      </>,
    );
    try {
      const tiles = [...rendered.container.querySelectorAll("[data-capability-catalog-tile]")];
      expect(tiles).toHaveLength(2);
      // Not connected: two buttons (open + connect).
      expect(tiles[0]!.querySelectorAll("button")).toHaveLength(2);
      const connect = [...tiles[0]!.querySelectorAll("button")].find(
        (node) => node.getAttribute("aria-label") === "Connect",
      );
      expect(connect).toBeDefined();
      await act(async () => connect!.click());
      expect(onQuickConnect).toHaveBeenCalledTimes(1);
      // Connected: the indicator is decorative, never a dead click target.
      expect(tiles[1]!.querySelectorAll("button")).toHaveLength(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("the connection state reaches assistive tech as text, not colour alone", async () => {
    const rendered = await render(
      <>
        <CapabilityTile
          item={item({ id: "mcp:notion", name: "Notion", enabled: true })}
          logoSrc={null}
          health={CONNECTED}
          onOpen={() => {}}
        />
        <CapabilityTile
          item={item({ id: "mcp:sentry", name: "Sentry", enabled: true })}
          logoSrc={null}
          health={ATTENTION}
          onOpen={() => {}}
        />
      </>,
    );
    try {
      const tiles = [...rendered.container.querySelectorAll("[data-capability-catalog-tile]")];
      expect(tiles[0]!.querySelector("button")?.getAttribute("aria-label")).toBe(
        "Notion. Connected",
      );
      expect(tiles[0]!.textContent).toContain("Connected");
      // An enabled-but-broken connector must never read as a plain green check.
      expect(tiles[1]!.querySelector("button")?.getAttribute("aria-label")).toBe(
        "Sentry. Needs attention",
      );
      expect(tiles[1]!.textContent).toContain("Needs attention");
    } finally {
      await rendered.unmount();
    }
  });
});

describe("FeaturedConnectorTile", () => {
  test("only a not-connected tile exposes an interactive quick-connect indicator", async () => {
    const onQuickConnect = mock(() => {});
    const rendered = await render(
      <>
        <FeaturedConnectorTile
          item={item()}
          logoSrc={null}
          onOpen={() => {}}
          onQuickConnect={onQuickConnect}
        />
        <FeaturedConnectorTile
          item={item({ id: "mcp:notion", name: "Notion", enabled: true })}
          logoSrc={null}
          health={CONNECTED}
          onOpen={() => {}}
          onQuickConnect={onQuickConnect}
        />
      </>,
    );
    try {
      const tiles = [...rendered.container.querySelectorAll("[data-featured-connector]")];
      expect(tiles).toHaveLength(2);
      expect(tiles[0]!.querySelectorAll("button")).toHaveLength(2);
      expect(tiles[1]!.querySelectorAll("button")).toHaveLength(1);
      expect(tiles[1]!.querySelector("button")?.getAttribute("aria-label")).toBe(
        "Notion. Connected",
      );
      expect(tiles[1]!.textContent).toContain("Connected");
    } finally {
      await rendered.unmount();
    }
  });
});
