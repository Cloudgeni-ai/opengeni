import { describe, expect, test } from "bun:test";

import { sortConnectorsForPresentation } from "@/components/capabilities/catalog-presentation";
import {
  apiKeyConnectionRef,
  apiKeyCredential,
  capabilityAuthHint,
  capabilityCategoryLabel,
  capabilityConnectPlan,
  capabilityCuration,
  capabilityFilterLabel,
  capabilityFormError,
  capabilityItemKindLabel,
  capabilityKindLabel,
  capabilityMonogram,
  capabilityQuickConnectPlan,
  capabilityReconnectPlan,
  capabilityRequiresPersonalConnection,
  capabilitySourceLabel,
  connectionHealth,
  connectionToReuseForApiKey,
  curatedSkillProvenance,
  domainFromUrl,
  GENERIC_API_KEY_FIELD,
  emptyCapabilityForm,
  fikenWorkspaceConnection,
  filterCapabilityCatalogItems,
  isMissingCredentialsError,
  normalizeProviderDomain,
  oauthConnectionOwnership,
  oauthConnectionRef,
  oauthResumeAction,
  preferredSocialConnection,
  registryResultsForQuery,
  resolveSheetItem,
  socialConnectionsForOwnership,
  sortFeaturedFirst,
  subjectOAuthConnectionRef,
  workspaceConnectionForDomain,
} from "./capabilities";
import type {
  CapabilityCatalogItem,
  CapabilityKind,
  ConnectionMetadata,
  SocialConnection,
} from "@/types";

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
    lifecycle: {
      status: "available",
      readiness: "setup_required",
      detail: null,
      managedBy: null,
    },
    actions: [],
    enabled: false,
    enabledReason: null,
    connectionRef: null,
    metadata: {},
    ...overrides,
  };
}

function socialConnection(overrides: Partial<SocialConnection> = {}): SocialConnection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    ownership: "workspace",
    provider: "x",
    accountHandle: "opengeni",
    accountName: "OpenGeni",
    externalAccountId: "x-account-1",
    status: "connected",
    scopes: ["tweet.read"],
    credentialRef: null,
    tokenMetadata: {},
    metadata: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterCapabilityCatalogItems", () => {
  const items = [
    item({ id: "a", kind: "mcp", name: "Linear", tags: ["issues"] }),
    item({
      id: "b",
      kind: "api",
      name: "Stripe",
      description: "Payments",
      tags: [],
    }),
    item({ id: "c", kind: "skill", name: "Summarize", tags: ["text"] }),
  ];

  test("kind filter keeps only the matching kind", () => {
    expect(filterCapabilityCatalogItems(items, "api", "").map((entry) => entry.id)).toEqual(["b"]);
  });

  test("all filter keeps everything when the query is empty", () => {
    expect(filterCapabilityCatalogItems(items, "all", "")).toHaveLength(3);
  });

  test("query matches name, description, and tags case-insensitively", () => {
    expect(filterCapabilityCatalogItems(items, "all", "PAYMENTS").map((entry) => entry.id)).toEqual(
      ["b"],
    );
    expect(filterCapabilityCatalogItems(items, "all", "issues").map((entry) => entry.id)).toEqual([
      "a",
    ]);
  });

  test("query and kind filter compose", () => {
    expect(filterCapabilityCatalogItems(items, "skill", "summar").map((entry) => entry.id)).toEqual(
      ["c"],
    );
    expect(filterCapabilityCatalogItems(items, "api", "summar")).toHaveLength(0);
  });

  test("keeps interactive filtering bounded across five thousand catalog rows", () => {
    const largeCatalog = Array.from({ length: 5_000 }, (_, index) =>
      item({
        id: `cap-${index}`,
        kind: index % 2 === 0 ? "mcp" : "api",
        name: index === 4_321 ? "Needle Analytics" : `Capability ${index}`,
        description: `Bounded catalog fixture ${index}`,
        tags: index === 4_321 ? ["needle", "analytics"] : ["catalog"],
      }),
    );

    const startedAt = performance.now();
    const results = filterCapabilityCatalogItems(largeCatalog, "all", "needle analytics");
    const durationMs = performance.now() - startedAt;

    expect(results.map((entry) => entry.id)).toEqual(["cap-4321"]);
    expect(durationMs).toBeLessThan(1_000);
  });
});

describe("human labels", () => {
  test("kind labels never leak enum slugs", () => {
    expect(capabilityKindLabel("mcp")).toBe("MCP server");
    expect(capabilityKindLabel("api")).toBe("API");
    expect(capabilityKindLabel("pack")).toBe("Pack");
    expect(
      capabilityItemKindLabel(item({ kind: "api", surfaceType: "provider_integration" })),
    ).toBe("Integration");
  });

  test("source labels are human", () => {
    expect(capabilitySourceLabel("built_in")).toBe("Built in");
    expect(capabilitySourceLabel("library")).toBe("Curated library");
    expect(capabilitySourceLabel("public_registry")).toBe("Public registry");
    expect(capabilitySourceLabel("manual")).toBe("Added");
  });

  test("filter labels are plural human forms", () => {
    expect(capabilityFilterLabel("mcp")).toBe("MCP servers");
    expect(capabilityFilterLabel("all")).toBe("All");
  });
});

describe("curated skill provenance", () => {
  test("projects immutable public metadata and effective selection", () => {
    const skill = item({
      kind: "skill",
      source: "library",
      enabled: true,
      enabledReason: "explicitly selected",
      provenance: "Reviewed curated entry",
      metadata: {
        libraryId: "azure-verified-modules",
        version: "1.0.0",
        contentSha256: "a".repeat(64),
        sourceCommit: "b".repeat(40),
        provenance: "Reviewed curated entry",
        sourceUrl: "https://example.com/source",
        license: "MPL-2.0",
        documentationUrl: "https://example.com/docs",
        artifactPath: "azure-verified-modules",
      },
    });

    expect(curatedSkillProvenance(skill)).toEqual({
      libraryId: "azure-verified-modules",
      version: "1.0.0",
      contentSha256: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      provenance: "Reviewed curated entry",
      sourceUrl: "https://example.com/source",
      license: "MPL-2.0",
      documentationUrl: "https://example.com/docs",
      artifactPath: "azure-verified-modules",
      status: "enabled",
      effectiveSelection: "explicitly selected",
    });
  });

  test("does not treat non-library capabilities as curated skills", () => {
    expect(curatedSkillProvenance(item({ kind: "skill", source: "manual" }))).toBeNull();
    expect(curatedSkillProvenance(item({ kind: "api", source: "library" }))).toBeNull();
  });
});

describe("capabilityConnectPlan", () => {
  test("social provider integrations use their dedicated OAuth connector", () => {
    const x = item({
      id: "api:x",
      kind: "api",
      surfaceType: "provider_integration",
      metadata: { providerAdapter: "social", provider: "x" },
    });
    expect(capabilityConnectPlan(x)).toEqual({
      mode: "social_oauth",
      provider: "x",
    });
    expect(capabilityAuthHint(x)).toBe("OAuth");
  });

  test("non-MCP kinds require their dedicated lifecycle", () => {
    expect(capabilityConnectPlan(item({ kind: "skill" }))).toEqual({
      mode: "dedicated",
    });
    expect(capabilityConnectPlan(item({ kind: "api", authKind: "api_key" }))).toEqual({
      mode: "dedicated",
    });
  });

  test("first-party Fiken uses the verified paste-a-token connector", () => {
    const fiken = item({
      id: "api:fiken",
      kind: "api",
      surfaceType: "first_party_fiken",
      authKind: "api_key",
      providerDomain: "fiken.no",
    });
    expect(capabilityConnectPlan(fiken)).toEqual({ mode: "fiken_api_token" });
    expect(capabilityAuthHint(fiken)).toBe("API key");
  });

  test("OAuth-capable MCP connects via oauth with its mcp url", () => {
    const plan = capabilityConnectPlan(
      item({
        kind: "mcp",
        authKind: "oauth2",
        providerDomain: "linear.app",
        mcpUrl: "https://mcp.linear.app/sse",
      }),
    );
    expect(plan).toEqual({
      mode: "oauth",
      providerDomain: "linear.app",
      mcpUrl: "https://mcp.linear.app/sse",
      requestedScopes: [],
    });
  });

  test("OAuth-capable MCP carries its reviewed least-privilege scopes", () => {
    const requestedScopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.modify",
    ];
    expect(
      capabilityConnectPlan(
        item({
          authKind: "oauth2",
          providerDomain: "gmailmcp.googleapis.com",
          mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
          metadata: { scopesHint: requestedScopes },
        }),
      ),
    ).toEqual({
      mode: "oauth",
      providerDomain: "gmailmcp.googleapis.com",
      mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      requestedScopes,
    });
  });

  test("official Gmail is personal-only even before refreshed catalog metadata arrives", () => {
    expect(
      capabilityRequiresPersonalConnection(
        item({
          mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
          metadata: {},
        }),
      ),
    ).toBe(true);
    expect(
      capabilityRequiresPersonalConnection(
        item({ metadata: { connectionOwnership: "personal_only" } }),
      ),
    ).toBe(true);
  });

  test("Slack's hosted MCP is personal-only; shared Slack access is the workspace bot", () => {
    expect(
      capabilityRequiresPersonalConnection(
        item({
          providerDomain: "slack.com",
          mcpUrl: "https://mcp.slack.com/mcp",
          metadata: {},
        }),
      ),
    ).toBe(true);
    expect(
      capabilityRequiresPersonalConnection(
        item({
          providerDomain: "slack.com",
          endpointUrl: "https://mcp.slack.com/mcp/",
          metadata: {},
        }),
      ),
    ).toBe(true);
    expect(
      capabilityRequiresPersonalConnection(
        item({ providerDomain: "slack.com", mcpUrl: "https://slack.example.test/mcp" }),
      ),
    ).toBe(false);
  });

  test("MCP with required headers collects an api_key with humanized labels", () => {
    const plan = capabilityConnectPlan(
      item({
        kind: "mcp",
        authKind: "api_key",
        providerDomain: "api.supabase.com",
        metadata: { requiredHeaders: ["Authorization", "X-Region-Key"] },
      }),
    );
    expect(plan.mode).toBe("api_key");
    if (plan.mode !== "api_key") return;
    expect(plan.providerDomain).toBe("api.supabase.com");
    expect(plan.fields).toEqual([
      { name: "Authorization", label: "API key" },
      { name: "X-Region-Key", label: "Region Key" },
    ]);
  });

  test("all-caps header names are sentence-cased, short acronyms keep caps", () => {
    const plan = capabilityConnectPlan(
      item({
        kind: "mcp",
        authKind: "api_key",
        providerDomain: "datadoghq.com",
        metadata: { requiredHeaders: ["DD-APPLICATION-KEY"] },
      }),
    );
    expect(plan.mode).toBe("api_key");
    if (plan.mode !== "api_key") return;
    expect(plan.fields).toEqual([{ name: "DD-APPLICATION-KEY", label: "DD Application Key" }]);
  });

  test("MCP with no auth signal just enables", () => {
    expect(capabilityConnectPlan(item({ kind: "mcp", authKind: "none" }))).toEqual({
      mode: "enable",
    });
    expect(capabilityConnectPlan(item({ kind: "mcp", authKind: "unknown" }))).toEqual({
      mode: "enable",
    });
  });

  test("credentialed MCP with no requiredHeaders still offers the api-key form (imported catalog rows)", () => {
    // Imported rows carry authKind api_key but no requiredHeaders in metadata; they
    // must NOT dead-end on Enable → 422, they get the generic single-field form.
    const byKind = capabilityConnectPlan(
      item({
        kind: "mcp",
        authKind: "api_key",
        providerDomain: "supabase.com",
      }),
    );
    expect(byKind).toEqual({
      mode: "api_key",
      providerDomain: "supabase.com",
      fields: [{ name: "Authorization", label: "API key" }],
    });
    // Manually-created credentialed items carry authModel credential_ref instead.
    const byModel = capabilityConnectPlan(
      item({
        kind: "mcp",
        authKind: "unknown",
        authModel: "credential_ref",
        providerDomain: "acme.com",
      }),
    );
    expect(byModel.mode).toBe("api_key");
  });

  test("provider domain falls back to the mcp url host", () => {
    const plan = capabilityConnectPlan(
      item({
        kind: "mcp",
        authKind: "oauth2",
        mcpUrl: "https://mcp.notion.com/mcp",
      }),
    );
    if (plan.mode !== "oauth") throw new Error("expected oauth");
    expect(plan.providerDomain).toBe("mcp.notion.com");
  });
});

describe("first-party fiken capability state", () => {
  const fikenItem = item({
    id: "api:fiken",
    kind: "api",
    surfaceType: "first_party_fiken",
    providerDomain: "fiken.no",
  });
  const fikenRow = (overrides: Partial<ConnectionMetadata> = {}) =>
    connection({
      providerDomain: "fiken.no",
      kind: "api_key",
      subjectId: null,
      metadata: { credentialRole: "fiken_api_token" },
      ...overrides,
    });

  test("health derives from the workspace fiken row without a connectionRef", () => {
    expect(connectionHealth(fikenItem, [], false)).toEqual({
      state: "unverified",
    });
    expect(connectionHealth(fikenItem, [], true)).toEqual({ state: "none" });
    const active = fikenRow();
    expect(connectionHealth(fikenItem, [active], true)).toEqual({
      state: "connected",
      connection: active,
    });
    const lapsed = fikenRow({ status: "needs_reauth" });
    expect(connectionHealth(fikenItem, [lapsed], true)).toEqual({
      state: "attention",
      connection: lapsed,
    });
  });

  test("accepts the OAuth lane's oauth2 rows like the server predicate", () => {
    const oauth = fikenRow({ kind: "oauth2" });
    expect(connectionHealth(fikenItem, [oauth], true)).toEqual({
      state: "connected",
      connection: oauth,
    });
  });

  test("ignores personal, foreign-domain, and unroled rows", () => {
    expect(
      connectionHealth(
        fikenItem,
        [
          fikenRow({ subjectId: "subject-a" }),
          fikenRow({ providerDomain: "linear.app" }),
          fikenRow({ metadata: {} }),
        ],
        true,
      ),
    ).toEqual({ state: "none" });
  });

  test("prefers the usable row, newest first", () => {
    const lapsed = fikenRow({
      id: "old",
      status: "needs_reauth",
      updatedAt: "2026-08-05T00:00:00.000Z",
    });
    const active = fikenRow({
      id: "new",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(fikenWorkspaceConnection([lapsed, active])?.id).toBe("new");
  });
});

describe("first-party social capability state", () => {
  test("prefers a usable connection", () => {
    const disabled = socialConnection({
      id: "11111111-1111-4111-8111-111111111112",
      status: "disabled",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    const connected = socialConnection({
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(preferredSocialConnection([disabled, connected], "x")?.status).toBe("connected");
  });

  test("keeps every exact account and filters ownership without singleton collapse", () => {
    const personal = socialConnection({
      id: "11111111-1111-4111-8111-111111111113",
      ownership: "personal",
      accountHandle: "personal",
      updatedAt: "2026-08-04T00:00:00.000Z",
    });
    const needsReauth = socialConnection({
      id: "11111111-1111-4111-8111-111111111114",
      status: "needs_reauth",
      accountHandle: "support",
      updatedAt: "2026-08-05T00:00:00.000Z",
    });
    const connected = socialConnection({
      id: "11111111-1111-4111-8111-111111111115",
      accountHandle: "main",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(socialConnectionsForOwnership([personal, needsReauth, connected], "workspace")).toEqual([
      connected,
      needsReauth,
    ]);
  });
});

describe("capabilityAuthHint", () => {
  test("reflects the connect plan", () => {
    expect(capabilityAuthHint(item({ kind: "mcp", authKind: "oauth2" }))).toBe("OAuth");
    expect(
      capabilityAuthHint(
        item({
          kind: "mcp",
          authKind: "api_key",
          metadata: { requiredHeaders: ["X-API-Key"] },
        }),
      ),
    ).toBe("API key");
    expect(capabilityAuthHint(item({ kind: "skill" }))).toBeNull();
  });
});

describe("isMissingCredentialsError", () => {
  test("matches the raw enable 422 and no unrelated errors", () => {
    expect(
      isMissingCredentialsError(
        new Error(
          "API 422: MCP capability 'supabase' requires credentials; pass them in the enable request 'headers' field",
        ),
      ),
    ).toBe(true);
    expect(isMissingCredentialsError(new Error("API 500: internal error"))).toBe(false);
  });
});

describe("capabilityFormError", () => {
  test("requires an MCP server name", () => {
    expect(capabilityFormError({ ...emptyCapabilityForm(), name: "" })).toBe("Give it a name.");
  });

  test("requires a valid MCP server URL", () => {
    expect(
      capabilityFormError({
        ...emptyCapabilityForm(),
        kind: "mcp",
        name: "X",
        endpointUrl: "",
      }),
    ).toBe("Enter the MCP server URL.");
    expect(
      capabilityFormError({
        ...emptyCapabilityForm(),
        kind: "mcp",
        name: "X",
        endpointUrl: "notaurl",
      }),
    ).toBe("Enter a valid URL, including https://.");
    expect(
      capabilityFormError({
        ...emptyCapabilityForm(),
        kind: "mcp",
        name: "X",
        endpointUrl: "https://mcp.example.com",
      }),
    ).toBeNull();
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
    const enabled = item({
      enabled: true,
      connectionRef: {
        connectionId: "conn-1",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    });
    expect(oauthResumeAction(enabled, "conn-1")).toBe("reconnect");
  });

  test("an enabled item whose old row was gone (new connection id) re-enables to repoint it", () => {
    // The stored ref points at a deleted connection; OAuth minted "conn-2".
    const enabled = item({
      enabled: true,
      connectionRef: {
        connectionId: "conn-1",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    });
    expect(oauthResumeAction(enabled, "conn-2")).toBe("enable");
  });

  test("an enabled generic subject binding remains a reconnect without persisting the returned UUID", () => {
    const enabled = item({
      enabled: true,
      connectionRef: {
        providerDomain: "slack.com",
        kind: "oauth2",
        subjectScope: "subject",
      },
    });
    expect(oauthResumeAction(enabled, "private-personal-row")).toBe("reconnect");
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
  const ref = {
    connectionId: "conn-1",
    providerDomain: "linear.app",
    kind: "oauth2",
  };

  test("no connection ref (headers-enabled or credential-free) is healthy 'none'", () => {
    // Headers-enabled and credential-free installations carry connectionRef null;
    // there is no connection to report on, so this must never read as broken.
    expect(connectionHealth(item({ enabled: true, connectionRef: null }), [], true)).toEqual({
      state: "none",
    });
  });

  test("ref present but connections NOT loaded is 'unverified', never attention", () => {
    // A failed listConnections (e.g. the grant lacks connections:read) passes an
    // empty array with loaded=false — a healthy integration must not go amber.
    expect(connectionHealth(item({ enabled: true, connectionRef: ref }), [], false)).toEqual({
      state: "unverified",
    });
  });

  test("ref pointing at an active row is connected", () => {
    const conns = [connection({ id: "conn-1", status: "active" })];
    const health = connectionHealth(item({ enabled: true, connectionRef: ref }), conns, true);
    expect(health.state).toBe("connected");
    if (health.state !== "connected") return;
    expect(health.connection.id).toBe("conn-1");
  });

  test("ref whose row is MISSING (loaded, absent) needs attention (row null)", () => {
    const health = connectionHealth(item({ enabled: true, connectionRef: ref }), [], true);
    expect(health).toEqual({ state: "attention", connection: null });
  });

  test("ref pointing at an inactive row needs attention (carries the row)", () => {
    const conns = [connection({ id: "conn-1", status: "revoked" })];
    const health = connectionHealth(item({ enabled: true, connectionRef: ref }), conns, true);
    expect(health.state).toBe("attention");
    if (health.state !== "attention") return;
    expect(health.connection?.id).toBe("conn-1");
  });

  test("matches a generic subject binding to the caller's personal provider/kind row without a UUID", () => {
    const subjectRef = {
      providerDomain: "slack.com",
      kind: "oauth2" as const,
      subjectScope: "subject" as const,
    };
    const personal = connection({
      id: "private-personal-row",
      subjectId: "current-user",
      providerDomain: "WWW.Slack.com",
      kind: "oauth2",
      status: "active",
    });
    const health = connectionHealth(
      item({ enabled: true, connectionRef: subjectRef }),
      [personal],
      true,
    );
    expect(health).toEqual({ state: "connected", connection: personal });
    expect(subjectRef).not.toHaveProperty("connectionId");
  });

  test("a workspace-shared row never satisfies a generic subject binding", () => {
    const subjectRef = {
      providerDomain: "slack.com",
      kind: "oauth2" as const,
      subjectScope: "subject" as const,
    };
    const shared = connection({
      id: "shared-bot-row",
      subjectId: null,
      providerDomain: "slack.com",
      kind: "oauth2",
      status: "active",
    });
    expect(
      connectionHealth(item({ enabled: true, connectionRef: subjectRef }), [shared], true),
    ).toEqual({ state: "attention", connection: null });
  });

  test("workspace bindings continue to match only their exact UUID", () => {
    const conns = [
      connection({
        id: "other",
        providerDomain: "linear.app",
        status: "active",
      }),
    ];
    expect(connectionHealth(item({ enabled: true, connectionRef: ref }), conns, true)).toEqual({
      state: "attention",
      connection: null,
    });
  });

  test("host bindings stay enabled without native connection health lookup", () => {
    const hostRef = {
      authoritySource: "host" as const,
      connectionId: "11111111-1111-4111-8111-111111111111",
      providerDomain: "cloudgeni.example",
      kind: "delegated",
      subjectScope: "subject" as const,
    };
    expect(
      connectionHealth(
        item({ enabled: true, connectionRef: hostRef }),
        [
          connection({
            id: hostRef.connectionId,
            subjectId: "current-user",
            providerDomain: hostRef.providerDomain,
            kind: "delegated",
            status: "revoked",
          }),
        ],
        true,
      ),
    ).toEqual({ state: "none" });
  });
});

describe("capabilityReconnectPlan", () => {
  const inactive = {
    state: "attention",
    connection: connection({ id: "conn-1", status: "revoked" }),
  } as const;
  const deleted = { state: "attention", connection: null } as const;

  test("offers api_key repair from connectionRef.kind even when the catalog plan drifted to 'enable'", () => {
    // Enabled item, live api_key connectionRef, inactive connection, but the
    // catalog no longer declares auth (plan would be "enable"). Reconnect must
    // still be offered, chosen from the ref's kind — not the stale plan.
    const drifted = item({
      enabled: true,
      kind: "api",
      authKind: null,
      connectionRef: {
        connectionId: "conn-1",
        providerDomain: "api.supabase.com",
        kind: "api_key",
      },
    });
    expect(capabilityReconnectPlan(drifted, inactive)).toEqual({
      kind: "api_key",
      connectionId: "conn-1",
      ownership: "workspace",
    });
  });

  test("oauth2 ref → oauth reconnect; a deleted row carries a null connectionId", () => {
    const oauthItem = item({
      enabled: true,
      connectionRef: {
        connectionId: "conn-1",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    });
    expect(capabilityReconnectPlan(oauthItem, deleted)).toEqual({
      kind: "oauth",
      connectionId: null,
      ownership: "workspace",
    });
  });

  test("a generic subject binding reconnects through OAuth without an installation UUID", () => {
    const oauthItem = item({
      enabled: true,
      connectionRef: {
        providerDomain: "slack.com",
        kind: "oauth2",
        subjectScope: "subject",
      },
    });
    expect(capabilityReconnectPlan(oauthItem, deleted)).toEqual({
      kind: "oauth",
      connectionId: null,
      ownership: "personal",
    });
    expect(oauthItem.connectionRef).not.toHaveProperty("connectionId");
  });

  test("nothing to repair when healthy, unverified, or without a ref", () => {
    const withRef = item({
      enabled: true,
      connectionRef: {
        connectionId: "conn-1",
        providerDomain: "linear.app",
        kind: "api_key",
      },
    });
    expect(
      capabilityReconnectPlan(withRef, {
        state: "connected",
        connection: connection({ id: "conn-1" }),
      }),
    ).toBeNull();
    expect(capabilityReconnectPlan(withRef, { state: "unverified" })).toBeNull();
    expect(
      capabilityReconnectPlan(item({ enabled: true, connectionRef: null }), deleted),
    ).toBeNull();
  });

  test("never offers native repair for a host-owned installation", () => {
    const hostItem = item({
      enabled: true,
      connectionRef: {
        authoritySource: "host",
        connectionId: "host:connection:42",
        providerDomain: "cloudgeni.example",
        kind: "oauth2",
      },
    });
    expect(capabilityReconnectPlan(hostItem, deleted)).toBeNull();
  });
});

describe("resolveSheetItem (sheet binds to the live catalog row, never a snapshot)", () => {
  test("re-derives to the disabled live row after a mutation — no stale Reconnect", () => {
    // Sheet opened on an enabled, connection-backed item; then the item was
    // disabled elsewhere (strip disable + refresh) so the catalog row for the same
    // id now reads enabled:false with no ref. The sheet must render THAT row.
    const enabledSnapshot = item({
      id: "cap-1",
      kind: "mcp",
      authKind: "oauth2",
      enabled: true,
      connectionRef: {
        connectionId: "conn-1",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    });
    const selected = {
      id: "cap-1",
      registry: false,
      snapshotFallback: false,
      snapshot: enabledSnapshot,
    };
    const disabledLive = item({
      id: "cap-1",
      kind: "mcp",
      authKind: "oauth2",
      enabled: false,
      connectionRef: null,
    });

    const live = resolveSheetItem(selected, [disabledLive]);
    expect(live).toBe(disabledLive);
    expect(live!.enabled).toBe(false);
    // Health has nothing to alarm on and reconnect is NOT offered — the sheet would
    // show Connect/Enable, never a Reconnect that could re-enable what was disabled.
    const health = connectionHealth(live!, [], true);
    expect(health).toEqual({ state: "none" });
    expect(capabilityReconnectPlan(live!, health)).toBeNull();
  });

  test("falls back to the snapshot for a registry item not yet in the catalog", () => {
    const snap = item({ id: "reg-1", source: "public_registry" });
    expect(
      resolveSheetItem({ id: "reg-1", registry: true, snapshotFallback: true, snapshot: snap }, []),
    ).toBe(snap);
  });

  test("falls back to the snapshot for a just-created item not yet in items (survives a failed refresh)", () => {
    // add-custom opens the sheet on the created row before refresh(); if refresh
    // fails the id isn't in `items`, but snapshotFallback keeps the connect sheet
    // open on the snapshot instead of the ghost-guard closing it.
    const snap = item({ id: "new-1" });
    expect(
      resolveSheetItem(
        {
          id: "new-1",
          registry: false,
          snapshotFallback: true,
          snapshot: snap,
        },
        [],
      ),
    ).toBe(snap);
  });

  test("a live-bound selection absent from the catalog resolves to null (sheet closes)", () => {
    const snap = item({ id: "gone", enabled: true });
    expect(
      resolveSheetItem(
        {
          id: "gone",
          registry: false,
          snapshotFallback: false,
          snapshot: snap,
        },
        [],
      ),
    ).toBeNull();
  });

  test("null selection resolves to null", () => {
    expect(resolveSheetItem(null, [item({ id: "cap-1" })])).toBeNull();
  });
});

describe("subjectOAuthConnectionRef", () => {
  test("builds a generic subject-owned OAuth ref with no private connection UUID", () => {
    const ref = subjectOAuthConnectionRef("slack.com");
    expect(ref).toEqual({
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectScope: "subject",
    });
    expect(ref).not.toHaveProperty("connectionId");
  });
});

describe("OAuth ownership helpers", () => {
  test("workspace refs pin the exact shared row while personal refs hide the private UUID", () => {
    expect(oauthConnectionRef("workspace", "workspace-conn", "linear.app")).toEqual({
      connectionId: "workspace-conn",
      providerDomain: "linear.app",
      kind: "oauth2",
      subjectScope: "workspace",
    });
    const personal = oauthConnectionRef("personal", "private-conn", "linear.app");
    expect(personal).toEqual({
      providerDomain: "linear.app",
      kind: "oauth2",
      subjectScope: "subject",
    });
    expect(personal).not.toHaveProperty("connectionId");
  });

  test("accepts only explicit callback ownership values", () => {
    expect(oauthConnectionOwnership("workspace")).toBe("workspace");
    expect(oauthConnectionOwnership("personal")).toBe("personal");
    expect(oauthConnectionOwnership("subject")).toBeNull();
    expect(oauthConnectionOwnership(null)).toBeNull();
  });
});

describe("API-key ownership helpers", () => {
  test("workspace refs pin the shared row while personal refs hide the private UUID", () => {
    expect(apiKeyConnectionRef("workspace", "workspace-conn", "api.example.com")).toEqual({
      connectionId: "workspace-conn",
      providerDomain: "api.example.com",
      kind: "api_key",
      subjectScope: "workspace",
    });
    const personal = apiKeyConnectionRef("personal", "private-conn", "api.example.com");
    expect(personal).toEqual({
      providerDomain: "api.example.com",
      kind: "api_key",
      subjectScope: "subject",
    });
    expect(personal).not.toHaveProperty("connectionId");
  });
});

describe("workspaceConnectionForDomain", () => {
  test("matches a workspace-shared row across case and www differences", () => {
    const conns = [connection({ id: "c1", providerDomain: "linear.app", subjectId: null })];
    expect(workspaceConnectionForDomain(conns, "WWW.Linear.App")?.id).toBe("c1");
  });

  test("ignores subject-scoped connections (only workspace-shared)", () => {
    const conns = [
      connection({
        id: "c1",
        providerDomain: "linear.app",
        subjectId: "user-1",
      }),
    ];
    expect(workspaceConnectionForDomain(conns, "linear.app")).toBeNull();
  });

  test("returns null when no domain matches", () => {
    const conns = [connection({ id: "c1", providerDomain: "linear.app" })];
    expect(workspaceConnectionForDomain(conns, "notion.com")).toBeNull();
  });
});

describe("connectionToReuseForApiKey", () => {
  test("reuses the installation's own connection ref first", () => {
    const cap = item({
      enabled: true,
      connectionRef: {
        connectionId: "ref-conn",
        providerDomain: "api.supabase.com",
        kind: "api_key",
      },
    });
    const conns = [
      connection({
        id: "other",
        providerDomain: "api.supabase.com",
        subjectId: null,
      }),
    ];
    expect(connectionToReuseForApiKey(cap, conns, "api.supabase.com")).toBe("ref-conn");
  });

  test("falls back to a workspace-shared row for the domain — a retry reuses it, no duplicate", () => {
    // No ref yet (the enable half of a prior create-then-enable failed), but the
    // connection created on the first attempt is still on the workspace.
    const cap = item({ enabled: false, connectionRef: null });
    const conns = [
      connection({
        id: "existing",
        providerDomain: "api.supabase.com",
        subjectId: null,
        kind: "api_key",
      }),
    ];
    expect(connectionToReuseForApiKey(cap, conns, "API.Supabase.com")).toBe("existing");
  });

  test("personal connect reuses only the current subject's visible personal row", () => {
    const cap = item({ enabled: false, connectionRef: null });
    const conns = [
      connection({
        id: "workspace",
        providerDomain: "api.supabase.com",
        subjectId: null,
        kind: "api_key",
      }),
      connection({
        id: "personal",
        providerDomain: "api.supabase.com",
        subjectId: "user-1",
        kind: "api_key",
      }),
    ];
    expect(connectionToReuseForApiKey(cap, conns, "api.supabase.com", "personal")).toBe("personal");
  });

  test("personal connect never reuses an exact workspace installation ref", () => {
    const cap = item({
      enabled: true,
      connectionRef: {
        connectionId: "workspace-ref",
        providerDomain: "api.supabase.com",
        kind: "api_key",
      },
    });
    expect(connectionToReuseForApiKey(cap, [], "api.supabase.com", "personal")).toBeNull();
  });

  test("returns null when nothing exists to reuse (a fresh connection is minted)", () => {
    expect(
      connectionToReuseForApiKey(item({ connectionRef: null }), [], "api.supabase.com"),
    ).toBeNull();
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

describe("capabilityCuration", () => {
  test("reads featured and official from import curation metadata", () => {
    expect(
      capabilityCuration(item({ metadata: { curation: { featured: true, official: true } } })),
    ).toEqual({ curated: false, featured: true, official: true });
  });

  test("defaults both flags to false when curation is absent or malformed", () => {
    expect(capabilityCuration(item({ metadata: {} }))).toEqual({
      curated: false,
      featured: false,
      official: false,
    });
    expect(capabilityCuration(item({ metadata: { curation: "yes" } }))).toEqual({
      curated: false,
      featured: false,
      official: false,
    });
    expect(capabilityCuration(item({ metadata: { curation: { featured: "true" } } }))).toEqual({
      curated: false,
      featured: false,
      official: false,
    });
  });
});

describe("sortFeaturedFirst", () => {
  test("moves featured rows to the front and preserves relative order otherwise", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b", metadata: { curation: { featured: true } } });
    const c = item({ id: "c" });
    const d = item({ id: "d", metadata: { curation: { featured: true } } });
    expect(sortFeaturedFirst([a, b, c, d]).map((entry) => entry.id)).toEqual(["b", "d", "a", "c"]);
  });

  test("returns a new array and leaves the input untouched", () => {
    const input = [
      item({ id: "x" }),
      item({ id: "y", metadata: { curation: { featured: true } } }),
    ];
    const sorted = sortFeaturedFirst(input);
    expect(sorted).not.toBe(input);
    expect(input.map((entry) => entry.id)).toEqual(["x", "y"]);
  });
});

describe("sortConnectorsForPresentation", () => {
  test("puts first-party and reviewed connectors before the raw long tail", () => {
    const raw = item({ id: "raw", name: "Access Owl" });
    const opaque = item({ id: "opaque", name: "4ygmimr3yj.us-east-2.awsapprunner.com" });
    const selfHostedLogo = item({
      id: "logo",
      name: "Recognizable",
      logoAssetPath: "catalog-assets/recognizable.svg",
    });
    const curated = item({
      id: "curated",
      name: "PayPal",
      metadata: { curation: { curated: true, official: true } },
    });
    const firstParty = item({
      id: "api:fiken",
      kind: "api",
      source: "built_in",
      surfaceType: "first_party_fiken",
      name: "Fiken",
    });

    expect(
      sortConnectorsForPresentation([opaque, raw, selfHostedLogo, curated, firstParty]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["api:fiken", "curated", "logo", "raw", "opaque"]);
  });

  test("is stable inside each tier and leaves the complete input discoverable", () => {
    const input = [
      item({ id: "b", name: "Beta", metadata: { curation: { curated: true } } }),
      item({ id: "a", name: "Alpha", metadata: { curation: { curated: true } } }),
      item({ id: "tail", name: "Tail" }),
    ];
    const sorted = sortConnectorsForPresentation(input);
    expect(sorted.map((entry) => entry.id)).toEqual(["b", "a", "tail"]);
    expect(new Set(sorted.map((entry) => entry.id))).toEqual(
      new Set(input.map((entry) => entry.id)),
    );
  });
});

describe("capabilityCategoryLabel", () => {
  test("maps known slugs to human labels and hides custom", () => {
    expect(capabilityCategoryLabel("project-management")).toBe("Project management");
    expect(capabilityCategoryLabel("developer-tools")).toBe("Developer tools");
    expect(capabilityCategoryLabel("integrations")).toBe("Integrations");
    expect(capabilityCategoryLabel("custom")).toBeNull();
    expect(capabilityCategoryLabel(null)).toBeNull();
  });

  test("title-cases an unknown slug instead of leaking it raw", () => {
    expect(capabilityCategoryLabel("knowledge-graphs")).toBe("Knowledge graphs");
    expect(capabilityCategoryLabel("weird_thing")).toBe("Weird thing");
  });
});

describe("filterCapabilityCatalogItems ignores curation flags", () => {
  test("typing official does not match every curated connector", () => {
    const curated = item({
      id: "cur",
      name: "Linear",
      description: "Issues",
      metadata: { curation: { featured: true, official: true } },
    });
    const plain = item({ id: "plain", name: "Official Widgets", description: "Widgets" });
    const hits = filterCapabilityCatalogItems([curated, plain], "all", "official");
    expect(hits.map((entry) => entry.id)).toEqual(["plain"]);
  });
});

describe("capabilityQuickConnectPlan (row/tile icon fast path)", () => {
  test("a credential-free MCP enables straight from the icon", () => {
    expect(capabilityQuickConnectPlan(item({ kind: "mcp", authKind: "none" }))).toEqual({
      mode: "enable",
    });
  });

  test("an official OAuth connector redirects with no dialog; an unreviewed one confirms first", () => {
    const official = item({
      kind: "mcp",
      authKind: "oauth2",
      providerDomain: "linear.app",
      mcpUrl: "https://mcp.linear.app/sse",
      metadata: { curation: { official: true } },
    });
    expect(capabilityQuickConnectPlan(official)).toEqual({
      mode: "oauth",
      ownership: "workspace",
      providerDomain: "linear.app",
      mcpUrl: "https://mcp.linear.app/sse",
      confirm: false,
    });
    expect(
      capabilityQuickConnectPlan({ ...official, metadata: {} })?.mode === "oauth" &&
        capabilityQuickConnectPlan({ ...official, metadata: {} }),
    ).toMatchObject({ confirm: true });
  });

  test("a personal-only connector never quick-connects a workspace-owned binding", () => {
    for (const mcpUrl of ["https://gmailmcp.googleapis.com/mcp/v1", "https://mcp.slack.com/mcp"]) {
      const personalOnly = item({
        kind: "mcp",
        authKind: "oauth2",
        providerDomain: "google.com",
        mcpUrl,
        metadata: { curation: { official: true } },
      });
      expect(capabilityRequiresPersonalConnection(personalOnly)).toBe(true);
      expect(capabilityQuickConnectPlan(personalOnly)).toMatchObject({
        mode: "oauth",
        ownership: "personal",
      });
    }
    expect(
      capabilityQuickConnectPlan(
        item({
          kind: "mcp",
          authKind: "api_key",
          providerDomain: "example.test",
          metadata: {
            connectionOwnership: "personal_only",
            requiredHeaders: ["X-Api-Key"],
          },
        }),
      ),
    ).toMatchObject({ mode: "api_key", ownership: "personal" });
  });

  test("the api-key field carries the WIRE header name, not the human label", () => {
    expect(
      capabilityQuickConnectPlan(
        item({
          kind: "mcp",
          authKind: "api_key",
          providerDomain: "datadog.com",
          metadata: { requiredHeaders: ["DD-API-KEY"] },
        }),
      ),
    ).toEqual({
      mode: "api_key",
      ownership: "workspace",
      providerDomain: "datadog.com",
      field: { name: "DD-API-KEY", label: "API key" },
    });

    // Drifted catalog rows with no declared headers fall back to the generic
    // bearer header - still a legal wire name, never the label.
    expect(
      capabilityQuickConnectPlan(
        item({ kind: "mcp", authKind: "api_key", providerDomain: "example.test" }),
      ),
    ).toMatchObject({ field: { name: "Authorization", label: "API key" } });
  });

  test("the stored credential is keyed by the wire header name", () => {
    const plan = capabilityQuickConnectPlan(
      item({
        kind: "mcp",
        authKind: "api_key",
        providerDomain: "datadog.com",
        metadata: { requiredHeaders: ["DD-API-KEY"] },
      }),
    );
    expect(plan?.mode).toBe("api_key");
    const credential = apiKeyCredential(
      plan?.mode === "api_key" ? plan.field : GENERIC_API_KEY_FIELD,
      "secret-token",
    );
    expect(credential).toEqual({ headers: { "DD-API-KEY": "secret-token" } });
    expect(Object.keys(credential.headers)).not.toContain("API key");
    expect(apiKeyCredential(GENERIC_API_KEY_FIELD, "t")).toEqual({
      headers: { Authorization: "t" },
    });
  });

  test("a connector needing more than one header has no fast path at all", () => {
    expect(
      capabilityQuickConnectPlan(
        item({
          kind: "mcp",
          authKind: "api_key",
          providerDomain: "datadog.com",
          metadata: { requiredHeaders: ["DD-API-KEY", "DD-APPLICATION-KEY"] },
        }),
      ),
    ).toBeNull();
  });

  test("dedicated and social lifecycles keep their own controls in the sheet", () => {
    expect(capabilityQuickConnectPlan(item({ kind: "skill" }))).toBeNull();
    expect(
      capabilityQuickConnectPlan(item({ kind: "api", surfaceType: "first_party_fiken" })),
    ).toBeNull();
    expect(
      capabilityQuickConnectPlan(
        item({
          kind: "api",
          surfaceType: "provider_integration",
          metadata: { providerAdapter: "social", provider: "x" },
        }),
      ),
    ).toBeNull();
  });
});
