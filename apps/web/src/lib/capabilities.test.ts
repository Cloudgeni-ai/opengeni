import { describe, expect, test } from "bun:test";

import {
  capabilityAuthHint,
  capabilityConnectPlan,
  capabilityFilterLabel,
  capabilityFormError,
  capabilityKindLabel,
  capabilityMonogram,
  capabilitySourceLabel,
  connectionHealth,
  connectionToReuseForApiKey,
  domainFromUrl,
  emptyCapabilityForm,
  filterCapabilityCatalogItems,
  isMissingCredentialsError,
  normalizeProviderDomain,
  oauthResumeAction,
  registryResultsForQuery,
  workspaceConnectionForDomain,
} from "./capabilities";
import type { CapabilityCatalogItem, CapabilityKind, ConnectionMetadata } from "@/types";

function connection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: "conn-1",
    accountId: "a",
    workspaceId: "ws",
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
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function item(overrides: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem {
  return {
    id: "cap-1",
    kind: "mcp" as CapabilityKind,
    source: "public_registry",
    name: "Linear",
    description: "Issue tracking",
    category: "productivity",
    tags: ["issues"],
    homepageUrl: null,
    endpointUrl: null,
    installUrl: null,
    authModel: null,
    providerDomain: null,
    surfaceType: null,
    transport: null,
    mcpUrl: null,
    authKind: null,
    credentialFacts: [],
    tier: null,
    provenance: null,
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: { available: true, notes: null },
    enabled: false,
    enabledReason: null,
    connectionRef: null,
    metadata: {},
    ...overrides,
  };
}

describe("filterCapabilityCatalogItems", () => {
  const items = [
    item({ id: "a", kind: "mcp", name: "Linear", tags: ["issues"] }),
    item({ id: "b", kind: "api", name: "Stripe", description: "Payments", tags: [] }),
    item({ id: "c", kind: "skill", name: "Summarize", tags: ["text"] }),
  ];

  test("kind filter keeps only the matching kind", () => {
    expect(filterCapabilityCatalogItems(items, "api", "").map((entry) => entry.id)).toEqual(["b"]);
  });

  test("all filter keeps everything when the query is empty", () => {
    expect(filterCapabilityCatalogItems(items, "all", "")).toHaveLength(3);
  });

  test("query matches name, description, and tags case-insensitively", () => {
    expect(filterCapabilityCatalogItems(items, "all", "PAYMENTS").map((entry) => entry.id)).toEqual(["b"]);
    expect(filterCapabilityCatalogItems(items, "all", "issues").map((entry) => entry.id)).toEqual(["a"]);
  });

  test("query and kind filter compose", () => {
    expect(filterCapabilityCatalogItems(items, "skill", "summar").map((entry) => entry.id)).toEqual(["c"]);
    expect(filterCapabilityCatalogItems(items, "api", "summar")).toHaveLength(0);
  });
});

describe("human labels", () => {
  test("kind labels never leak enum slugs", () => {
    expect(capabilityKindLabel("mcp")).toBe("MCP server");
    expect(capabilityKindLabel("api")).toBe("API");
    expect(capabilityKindLabel("pack")).toBe("Pack");
  });

  test("source labels are human", () => {
    expect(capabilitySourceLabel("built_in")).toBe("Built in");
    expect(capabilitySourceLabel("public_registry")).toBe("Public registry");
    expect(capabilitySourceLabel("manual")).toBe("Added");
  });

  test("filter labels are plural human forms", () => {
    expect(capabilityFilterLabel("mcp")).toBe("MCP servers");
    expect(capabilityFilterLabel("all")).toBe("All");
  });
});

describe("capabilityConnectPlan", () => {
  test("non-MCP kinds just enable", () => {
    expect(capabilityConnectPlan(item({ kind: "skill" }))).toEqual({ mode: "enable" });
    expect(capabilityConnectPlan(item({ kind: "api", authKind: "api_key" }))).toEqual({ mode: "enable" });
  });

  test("OAuth-capable MCP connects via oauth with its mcp url", () => {
    const plan = capabilityConnectPlan(item({ kind: "mcp", authKind: "oauth2", providerDomain: "linear.app", mcpUrl: "https://mcp.linear.app/sse" }));
    expect(plan).toEqual({ mode: "oauth", providerDomain: "linear.app", mcpUrl: "https://mcp.linear.app/sse" });
  });

  test("MCP with required headers collects an api_key with humanized labels", () => {
    const plan = capabilityConnectPlan(item({
      kind: "mcp",
      authKind: "api_key",
      providerDomain: "api.supabase.com",
      metadata: { requiredHeaders: ["Authorization", "X-Region-Key"] },
    }));
    expect(plan.mode).toBe("api_key");
    if (plan.mode !== "api_key") return;
    expect(plan.providerDomain).toBe("api.supabase.com");
    expect(plan.fields).toEqual([
      { name: "Authorization", label: "API key" },
      { name: "X-Region-Key", label: "Region Key" },
    ]);
  });

  test("all-caps header names are sentence-cased, short acronyms keep caps", () => {
    const plan = capabilityConnectPlan(item({
      kind: "mcp",
      authKind: "api_key",
      providerDomain: "datadoghq.com",
      metadata: { requiredHeaders: ["DD-APPLICATION-KEY"] },
    }));
    expect(plan.mode).toBe("api_key");
    if (plan.mode !== "api_key") return;
    expect(plan.fields).toEqual([
      { name: "DD-APPLICATION-KEY", label: "DD Application Key" },
    ]);
  });

  test("MCP with no auth signal just enables", () => {
    expect(capabilityConnectPlan(item({ kind: "mcp", authKind: "none" }))).toEqual({ mode: "enable" });
  });

  test("provider domain falls back to the mcp url host", () => {
    const plan = capabilityConnectPlan(item({ kind: "mcp", authKind: "oauth2", mcpUrl: "https://mcp.notion.com/mcp" }));
    if (plan.mode !== "oauth") throw new Error("expected oauth");
    expect(plan.providerDomain).toBe("mcp.notion.com");
  });
});

describe("capabilityAuthHint", () => {
  test("reflects the connect plan", () => {
    expect(capabilityAuthHint(item({ kind: "mcp", authKind: "oauth2" }))).toBe("OAuth");
    expect(capabilityAuthHint(item({ kind: "mcp", authKind: "api_key", metadata: { requiredHeaders: ["X-API-Key"] } }))).toBe("API key");
    expect(capabilityAuthHint(item({ kind: "skill" }))).toBeNull();
  });
});

describe("isMissingCredentialsError", () => {
  test("matches the raw enable 422 and no unrelated errors", () => {
    expect(isMissingCredentialsError(new Error("API 422: MCP capability 'supabase' requires credentials; pass them in the enable request 'headers' field"))).toBe(true);
    expect(isMissingCredentialsError(new Error("API 500: internal error"))).toBe(false);
  });
});

describe("capabilityFormError", () => {
  test("requires a name for every kind", () => {
    expect(capabilityFormError({ ...emptyCapabilityForm(), name: "" })).toBe("Give it a name.");
  });

  test("only MCP servers require an endpoint URL", () => {
    expect(capabilityFormError({ ...emptyCapabilityForm(), kind: "mcp", name: "X", endpointUrl: "" })).toBe("Enter the MCP server URL.");
    expect(capabilityFormError({ ...emptyCapabilityForm(), kind: "mcp", name: "X", endpointUrl: "notaurl" })).toBe("Enter a valid URL, including https://.");
    expect(capabilityFormError({ ...emptyCapabilityForm(), kind: "mcp", name: "X", endpointUrl: "https://mcp.example.com" })).toBeNull();
  });

  test("non-MCP kinds never ask for a URL", () => {
    expect(capabilityFormError({ ...emptyCapabilityForm(), kind: "skill", name: "Summarize", endpointUrl: "" })).toBeNull();
    expect(capabilityFormError({ ...emptyCapabilityForm(), kind: "api", name: "Weather", endpointUrl: "" })).toBeNull();
  });
});

describe("oauthResumeAction", () => {
  test("a missing catalog row can't be enabled", () => {
    // The item resolved from the fresh post-redirect fetch is null.
    expect(oauthResumeAction(null, "conn-1")).toBe("missing");
  });

  test("a success with no connection id can't be enabled", () => {
    expect(oauthResumeAction(item({ enabled: false }), null)).toBe("no_connection");
  });

  test("an enabled item whose returned connection matches its ref is a reconnect", () => {
    const enabled = item({ enabled: true, connectionRef: { connectionId: "conn-1", providerDomain: "linear.app", kind: "oauth2" } });
    expect(oauthResumeAction(enabled, "conn-1")).toBe("reconnect");
  });

  test("an enabled item whose old row was gone (new connection id) re-enables to repoint it", () => {
    // The stored ref points at a deleted connection; OAuth minted "conn-2".
    const enabled = item({ enabled: true, connectionRef: { connectionId: "conn-1", providerDomain: "linear.app", kind: "oauth2" } });
    expect(oauthResumeAction(enabled, "conn-2")).toBe("enable");
  });

  test("a fresh connect of a disabled item enables it", () => {
    expect(oauthResumeAction(item({ enabled: false }), "conn-1")).toBe("enable");
  });
});

describe("normalizeProviderDomain", () => {
  test("trims, lowercases, and strips a single leading www.", () => {
    expect(normalizeProviderDomain("  WWW.Linear.App ")).toBe("linear.app");
    expect(normalizeProviderDomain("API.Supabase.com")).toBe("api.supabase.com");
    expect(normalizeProviderDomain("linear.app")).toBe("linear.app");
    // Only the leading www. is stripped; an inner "www" stays.
    expect(normalizeProviderDomain("www.www.example.com")).toBe("www.example.com");
  });
});

describe("connectionHealth", () => {
  const ref = { connectionId: "conn-1", providerDomain: "linear.app", kind: "oauth2" };

  test("no connection ref (headers-enabled or credential-free) is healthy 'none'", () => {
    // Headers-enabled and credential-free installations carry connectionRef null;
    // there is no connection to report on, so this must never read as broken.
    expect(connectionHealth(item({ enabled: true, connectionRef: null }), [])).toEqual({ state: "none" });
  });

  test("ref pointing at an active row is connected", () => {
    const conns = [connection({ id: "conn-1", status: "active" })];
    const health = connectionHealth(item({ enabled: true, connectionRef: ref }), conns);
    expect(health.state).toBe("connected");
    if (health.state !== "connected") return;
    expect(health.connection.id).toBe("conn-1");
  });

  test("ref whose row is MISSING needs attention (row null)", () => {
    const health = connectionHealth(item({ enabled: true, connectionRef: ref }), []);
    expect(health).toEqual({ state: "attention", connection: null });
  });

  test("ref pointing at an inactive row needs attention (carries the row)", () => {
    const conns = [connection({ id: "conn-1", status: "revoked" })];
    const health = connectionHealth(item({ enabled: true, connectionRef: ref }), conns);
    expect(health.state).toBe("attention");
    if (health.state !== "attention") return;
    expect(health.connection?.id).toBe("conn-1");
  });

  test("matches by id, not domain — a same-domain row with a different id is not a match", () => {
    const conns = [connection({ id: "other", providerDomain: "linear.app", status: "active" })];
    expect(connectionHealth(item({ enabled: true, connectionRef: ref }), conns)).toEqual({ state: "attention", connection: null });
  });
});

describe("workspaceConnectionForDomain", () => {
  test("matches a workspace-shared row across case and www differences", () => {
    const conns = [connection({ id: "c1", providerDomain: "linear.app", subjectId: null })];
    expect(workspaceConnectionForDomain(conns, "WWW.Linear.App")?.id).toBe("c1");
  });

  test("ignores subject-scoped connections (only workspace-shared)", () => {
    const conns = [connection({ id: "c1", providerDomain: "linear.app", subjectId: "user-1" })];
    expect(workspaceConnectionForDomain(conns, "linear.app")).toBeNull();
  });

  test("returns null when no domain matches", () => {
    const conns = [connection({ id: "c1", providerDomain: "linear.app" })];
    expect(workspaceConnectionForDomain(conns, "notion.com")).toBeNull();
  });
});

describe("connectionToReuseForApiKey", () => {
  test("reuses the installation's own connection ref first", () => {
    const cap = item({ enabled: true, connectionRef: { connectionId: "ref-conn", providerDomain: "api.supabase.com", kind: "api_key" } });
    const conns = [connection({ id: "other", providerDomain: "api.supabase.com", subjectId: null })];
    expect(connectionToReuseForApiKey(cap, conns, "api.supabase.com")).toBe("ref-conn");
  });

  test("falls back to a workspace-shared row for the domain — a retry reuses it, no duplicate", () => {
    // No ref yet (the enable half of a prior create-then-enable failed), but the
    // connection created on the first attempt is still on the workspace.
    const cap = item({ enabled: false, connectionRef: null });
    const conns = [connection({ id: "existing", providerDomain: "api.supabase.com", subjectId: null })];
    expect(connectionToReuseForApiKey(cap, conns, "API.Supabase.com")).toBe("existing");
  });

  test("returns null when nothing exists to reuse (a fresh connection is minted)", () => {
    expect(connectionToReuseForApiKey(item({ connectionRef: null }), [], "api.supabase.com")).toBeNull();
  });
});

describe("registryResultsForQuery", () => {
  const results = [item({ id: "r1", source: "public_registry" })];

  test("shows results when the searched term matches the live query", () => {
    expect(registryResultsForQuery("github", "github", results)).toEqual(results);
    // Live query is compared trimmed, mirroring how the search fires.
    expect(registryResultsForQuery("  github  ", "github", results)).toEqual(results);
  });

  test("invalidates results once the query changes away from the searched term", () => {
    expect(registryResultsForQuery("githubx", "github", results)).toEqual([]);
  });

  test("shows nothing before any search has run", () => {
    expect(registryResultsForQuery("github", null, [])).toEqual([]);
  });
});

describe("helpers", () => {
  test("domainFromUrl extracts the host or null", () => {
    expect(domainFromUrl("https://mcp.linear.app/sse")).toBe("mcp.linear.app");
    expect(domainFromUrl("garbage")).toBeNull();
    expect(domainFromUrl(null)).toBeNull();
  });

  test("monogram uses up to two initials", () => {
    expect(capabilityMonogram("Linear")).toBe("LI");
    expect(capabilityMonogram("Google Drive")).toBe("GD");
    expect(capabilityMonogram("")).toBe("?");
  });
});
