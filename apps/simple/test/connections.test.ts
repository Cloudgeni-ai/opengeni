import { describe, expect, test } from "bun:test";
import type { ConnectAccount } from "@opengeni/connect";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import {
  accountSubtitle,
  connectableCatalog,
  connectedServices,
  humanizeDomain,
  searchCatalog,
} from "../src/lib/connections";

function item(
  id: string,
  name: string,
  overrides: Partial<CapabilityCatalogItem> & { featured?: boolean } = {},
): CapabilityCatalogItem {
  const { featured = false, ...rest } = overrides;
  return {
    id,
    name,
    kind: "mcp",
    authKind: "oauth2",
    tier: "verified",
    enabled: false,
    surfaceType: "mcp",
    mcpUrl: `https://mcp.${name.toLowerCase()}.com/mcp`,
    providerDomain: `${name.toLowerCase()}.com`,
    logoAssetPath: `catalog-assets/${name.toLowerCase()}.png`,
    description: `${name} things.`,
    category: "productivity",
    metadata: featured ? { curation: { featured: true } } : {},
    ...rest,
  } as CapabilityCatalogItem;
}

function connection(
  id: string,
  domain: string,
  overrides: Partial<ConnectionMetadata> = {},
): ConnectionMetadata {
  return {
    id,
    subjectId: "user-1",
    providerDomain: domain,
    kind: "oauth2",
    status: "active",
    version: 1,
    metadata: { mcpUrl: `https://${domain}/mcp` },
    createdAt: "2026-09-01T10:00:00Z",
    ...overrides,
  } as ConnectionMetadata;
}

function account(
  id: string,
  providerId: string,
  label: string,
  overrides: Partial<ConnectAccount> = {},
) {
  return {
    id,
    providerId,
    label,
    ownership: "personal",
    status: "connected",
    version: 1,
    ...overrides,
  } as ConnectAccount;
}

const logo = (entry: CapabilityCatalogItem) => `/v1/${entry.logoAssetPath}`;

describe("connectedServices", () => {
  test("names services from the catalog and accounts by identity, never by domain", () => {
    const catalog = [item("linear", "Linear", { mcpUrl: "https://mcp.linear.app/mcp" })];
    const services = connectedServices({
      accounts: [account("c1", "mcp-oauth", "mcp.linear.app")],
      connections: [
        connection("c1", "mcp.linear.app", {
          metadata: { mcpUrl: "https://mcp.linear.app/mcp", email: "ada@example.com" },
        }),
      ],
      catalog,
      logo,
    });
    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe("Linear");
    expect(services[0]!.logo).toBe("/v1/catalog-assets/linear.png");
    expect(accountSubtitle(services[0]!.accounts[0]!)).toBe("ada@example.com · Only you");
    expect(services[0]!.accounts[0]!.canReconnect).toBe(true);
  });

  test("groups several accounts of one provider and tells identical ones apart", () => {
    const services = connectedServices({
      accounts: [
        account("a", "mcp-oauth", "mcp.linear.app", { ownership: "workspace" }),
        account("b", "mcp-oauth", "mcp.linear.app", { ownership: "workspace" }),
      ],
      connections: [
        connection("a", "mcp.linear.app", { subjectId: null, createdAt: "2026-09-01T10:00:00Z" }),
        connection("b", "mcp.linear.app", { subjectId: null, createdAt: "2026-09-03T10:00:00Z" }),
      ],
      catalog: [item("linear", "Linear", { mcpUrl: "https://mcp.linear.app/mcp" })],
      logo,
    });
    expect(services).toHaveLength(1);
    const labels = services[0]!.accounts.map((entry) => entry.label);
    expect(labels.every((label) => label?.startsWith("Added "))).toBe(true);
    expect(new Set(labels).size).toBe(2);
  });

  test("native providers get their product name, role and first-party logo", () => {
    const services = connectedServices({
      accounts: [
        account("github-installation:1", "github-app", "Acme", { ownership: "workspace" }),
        account("slack-bot:T1", "slack-bot", "Acme team", { ownership: "workspace" }),
      ],
      connections: [],
      catalog: [],
      logo,
      firstPartyLogo: (providerId) => (providerId === "github-app" ? "data:github" : null),
    });
    expect(services.map((service) => service.name)).toEqual(["GitHub", "Slack"]);
    expect(services[0]!.logo).toBe("data:github");
    expect(services[0]!.accounts[0]!.canReconnect).toBe(false);
    expect(accountSubtitle(services[1]!.accounts[0]!)).toBe("Acme team · Bot · Workspace");
  });

  test("an unknown endpoint reads as a humanized name, and attention comes first", () => {
    const services = connectedServices({
      accounts: [
        account("z", "mcp-oauth", "mcp.zeta.dev"),
        account("g", "mcp-oauth", "mcp.grafana.net", { status: "auth_needed" }),
      ],
      connections: [connection("z", "mcp.zeta.dev"), connection("g", "mcp.grafana.net")],
      catalog: [],
      logo,
    });
    expect(services.map((service) => service.name)).toEqual(["Grafana", "Zeta"]);
    expect(services[0]!.accounts[0]!.needsAttention).toBe(true);
    expect(services[0]!.logo).toBeNull();
  });

  test("keeps connection rows the account inventory leaves out, but not revoked ones", () => {
    const services = connectedServices({
      accounts: [],
      connections: [
        connection("x", "mcp.notion.com"),
        connection("y", "mcp.sentry.dev", { status: "revoked" }),
      ],
      catalog: [item("notion", "Notion", { mcpUrl: "https://mcp.notion.com/mcp" })],
      logo,
    });
    expect(services.map((service) => service.name)).toEqual(["Notion"]);
  });
});

describe("catalog", () => {
  test("only offers OAuth MCP services that can actually connect, one per name", () => {
    const items = connectableCatalog([
      item("a", "Notion", { featured: true }),
      item("a2", "Notion"),
      item("b", "Keyed", { authKind: "api_key" } as Partial<CapabilityCatalogItem>),
      item("c", "Locked", {
        runtime: { operatorOAuthClient: { configured: false } },
      } as Partial<CapabilityCatalogItem>),
      item("d", "Apps", { surfaceType: "codex_apps" } as Partial<CapabilityCatalogItem>),
    ]);
    expect(items.map((entry) => entry.id)).toEqual(["a"]);
  });

  test("browsing shows featured first and hides host-named rows; search ranks by name", () => {
    const items = [
      item("x", "Zendesk"),
      item("y", "bigquery.googleapis.com"),
      item("n", "Notion", { featured: true }),
      item("c", "Community", { tier: "community" } as Partial<CapabilityCatalogItem>),
      item("l", "Linear", { description: "Issues for notion fans." }),
    ];
    expect(searchCatalog(items, "").map((entry) => entry.id)).toEqual(["n", "x", "l"]);
    expect(searchCatalog(items, "not").map((entry) => entry.id)).toEqual(["n", "l"]);
    expect(searchCatalog(items, "bigquery").map((entry) => entry.id)).toEqual(["y"]);
  });
});

describe("humanizeDomain", () => {
  test("drops MCP and API prefixes and shared roots", () => {
    expect(humanizeDomain("mcp.grafana.net")).toBe("Grafana");
    expect(humanizeDomain("internal-tools.example.com")).toBe("Internal Tools");
    expect(humanizeDomain("https://api.acme.co.uk/mcp")).toBe("Acme");
  });
});
