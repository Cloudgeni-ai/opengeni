import { describe, expect, test } from "bun:test";

import type { ApiIntegrationInstallationSummary, ApiIntegrationPreview } from "@/types";
import {
  customApiAuthenticationStepRequired,
  compatibleCustomApiConnections,
  customApiConnectionRequest,
  customApiFlowReducer,
  customApiInstallValidationError,
  customApiPreviewDiff,
  customApiSourceFromDraft,
  emptyCustomApiDraft,
  filterCustomApiInstances,
  initialCustomApiFlowState,
  normalizeCustomApiUrl,
  type CustomApiFlowState,
} from "./custom-api-flow";

const basePreview: ApiIntegrationPreview = {
  source: { kind: "openapi", url: "https://linear.example.test/openapi.json" },
  definitionId: "linear-like",
  definitionProvenance: "workspace",
  protocol: "openapi",
  capabilityId: "api:linear-like",
  pluginKey: "integration/linear-like",
  serverId: "api_linear_like",
  name: "Linear-like API",
  description: "Issue tracker emulator",
  provider: null,
  providerDomain: "linear.example.test",
  baseUrl: "https://linear.example.test/api/",
  sourceUrl: "https://linear.example.test/openapi.json",
  revisionId: "openapi:revision",
  contentSha256: "a".repeat(64),
  auth: {
    kind: "api_key",
    providerDomain: "linear.example.test",
    carrier: "query",
    name: "api_key",
  },
  connectionId: null,
  connectionOwnership: null,
  tools: [
    {
      id: "issues_list",
      operationKey: "issues.list",
      name: "List issues",
      description: "List issues",
      safety: "read",
      approvalMode: "never",
      deprecated: false,
    },
  ],
  warnings: [],
};

describe("custom API flow", () => {
  test("normalizes a domain into the default auto source and preserves advanced source intent", () => {
    expect(normalizeCustomApiUrl("api.example.com/graphql")).toBe(
      "https://api.example.com/graphql",
    );
    expect(customApiSourceFromDraft({ ...emptyCustomApiDraft(), url: "api.example.com" })).toEqual({
      kind: "auto",
      url: "https://api.example.com/",
    });
    expect(
      customApiSourceFromDraft({
        ...emptyCustomApiDraft(),
        protocol: "graphql",
        graphqlEndpoint: "https://linear.example.test/graphql",
        graphqlName: "Finance Linear",
      }),
    ).toEqual({
      kind: "graphql",
      endpoint: "https://linear.example.test/graphql",
      name: "Finance Linear",
    });
  });

  test("preserves user input and actionable errors across failed preview and close/reopen", () => {
    let state = customApiFlowReducer(initialCustomApiFlowState(), { type: "new" });
    state = customApiFlowReducer(state, {
      type: "draft",
      patch: { url: "linear.example.test/graphql", displayName: "Linear — Finance" },
    });
    state = customApiFlowReducer(state, {
      type: "preview_error",
      message: "GraphQL introspection requires authentication",
      authenticationMayBeRequired: true,
    });
    expect(state.phase).toBe("auth");
    expect(state.draft.url).toBe("linear.example.test/graphql");
    expect(state.error).toContain("authentication");
    state = customApiFlowReducer(state, { type: "close" });
    state = customApiFlowReducer(state, { type: "open" });
    expect(state.draft.displayName).toBe("Linear — Finance");
    expect(state.error).toContain("authentication");
  });

  test("shows authentication again when Back is requested from a connected review", () => {
    const connectedReview = {
      ...initialCustomApiFlowState(),
      phase: "review" as const,
      preview: basePreview,
      connection: connection("00000000-0000-4000-8000-000000000001", "linear.example.test", null),
    };
    expect(customApiAuthenticationStepRequired(connectedReview)).toBe(false);
    expect(
      customApiAuthenticationStepRequired(
        customApiFlowReducer(connectedReview, { type: "phase", phase: "auth" }),
      ),
    ).toBe(true);
  });

  test("reuses an exact created Connection for safe preview retries and clears entered secrets", () => {
    const created = connection("00000000-0000-4000-8000-000000000001", "linear.example.test", null);
    let state: CustomApiFlowState = {
      ...initialCustomApiFlowState(),
      phase: "creating_connection" as const,
      preview: basePreview,
      selectedTools: ["issues_list"],
      draft: {
        ...emptyCustomApiDraft(),
        connectionMode: "new" as const,
        credentialValue: "query-secret",
        username: "agent",
        password: "password",
      },
    };
    state = customApiFlowReducer(state, { type: "connection", connection: created });

    expect(state.connection).toBe(created);
    expect(state.draft).toMatchObject({
      connectionMode: "existing",
      existingConnectionId: created.id,
      credentialValue: "",
      username: "",
      password: "",
    });

    state = customApiFlowReducer(state, {
      type: "phase",
      phase: "previewing",
      error: null,
    });
    expect(state.preview).toBeNull();
    expect(state.selectedTools).toEqual([]);
    expect(state.connection).toBe(created);
  });

  test("maps detected query credentials and HTTP bearer/basic into resolver-supported placements", () => {
    expect(
      customApiConnectionRequest({
        preview: basePreview,
        draft: {
          ...emptyCustomApiDraft(),
          ownership: "workspace",
          accountLabel: "Linear Finance",
          credentialValue: "query-secret",
        },
        providerDomain: "linear.example.test",
      }),
    ).toMatchObject({
      kind: "api_key",
      ownership: "workspace",
      credential: {
        placements: [{ carrier: "query", name: "api_key", value: "query-secret" }],
      },
      metadata: { credentialLabel: "Linear Finance" },
    });

    const bearer = customApiConnectionRequest({
      preview: {
        ...basePreview,
        auth: { kind: "http", providerDomain: "linear.example.test", scheme: "bearer" },
      },
      draft: { ...emptyCustomApiDraft(), credentialValue: "token-a" },
      providerDomain: "linear.example.test",
    });
    expect(bearer.credential).toEqual({
      placements: [
        {
          carrier: "header",
          name: "Authorization",
          value: "token-a",
          prefix: "Bearer ",
        },
      ],
    });

    const basic = customApiConnectionRequest({
      preview: {
        ...basePreview,
        auth: { kind: "http", providerDomain: "linear.example.test", scheme: "Basic" },
      },
      draft: { ...emptyCustomApiDraft(), username: "agent", password: "päss" },
      providerDomain: "linear.example.test",
    });
    expect(basic.credential).toEqual({
      placements: [
        expect.objectContaining({
          carrier: "header",
          name: "Authorization",
          prefix: "Basic ",
        }),
      ],
    });
  });

  test("offers only active exact-domain/ownership Connections and computes immutable update diffs", () => {
    const connections = [
      connection("00000000-0000-4000-8000-000000000001", "linear.example.test", null),
      connection("00000000-0000-4000-8000-000000000002", "linear.example.test", "subject-a"),
      connection("00000000-0000-4000-8000-000000000003", "evil-linear.example", null),
      connection("00000000-0000-4000-8000-000000000004", "linear.example.test", null, "oauth2"),
    ];
    expect(
      compatibleCustomApiConnections(
        connections,
        "linear.example.test",
        "workspace",
        basePreview,
      ).map((entry) => entry.id),
    ).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(
      compatibleCustomApiConnections(
        connections,
        "linear.example.test",
        "workspace",
        null,
        "basic",
      ).map((entry) => entry.id),
    ).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(
      compatibleCustomApiConnections(
        connections,
        "linear.example.test",
        "workspace",
        null,
        "bearer",
      ).map((entry) => entry.id),
    ).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000004"]);

    const instance = {
      capabilityId: basePreview.capabilityId,
      pluginKey: basePreview.pluginKey,
      installationVersion: 2,
      instanceId: "00000000-0000-4000-8000-000000000010",
      instanceKey: "linear-finance",
      displayName: "Linear — Finance",
      instanceVersion: 3,
      serverId: "api_linear_like__linear_finance",
      name: "Linear — Finance",
      description: null,
      protocol: "openapi",
      definitionId: basePreview.definitionId,
      definitionProvenance: "workspace",
      providerDomain: "linear.example.test",
      baseUrl: basePreview.baseUrl,
      sourceUrl: basePreview.sourceUrl,
      connected: true,
      requiresConnection: true,
      connectionId: connections[0]!.id,
      ownership: "workspace",
      allowedTools: ["issues_list", "issues_create"],
      toolCount: 2,
      approvalRequiredToolCount: 1,
      revisionId: "openapi:old",
      contentSha256: "b".repeat(64),
    } satisfies ApiIntegrationInstallationSummary;
    expect(
      customApiPreviewDiff(instance, {
        ...basePreview,
        tools: [
          basePreview.tools[0]!,
          { ...basePreview.tools[0]!, id: "issues_archive", name: "Archive issue" },
        ],
      }),
    ).toEqual({
      digestChanged: true,
      addedTools: ["issues_archive"],
      removedTools: ["issues_create"],
      unchangedTools: 1,
    });
  });

  test("keeps only previously allowed, still-available tools selected during update preview", () => {
    const instance = {
      capabilityId: basePreview.capabilityId,
      pluginKey: basePreview.pluginKey,
      installationVersion: 2,
      instanceId: "00000000-0000-4000-8000-000000000010",
      instanceKey: "linear-finance",
      displayName: "Linear — Finance",
      instanceVersion: 3,
      serverId: "api_linear_like__linear_finance",
      name: "Linear — Finance",
      description: null,
      protocol: "openapi",
      definitionId: basePreview.definitionId,
      definitionProvenance: "workspace",
      providerDomain: "linear.example.test",
      baseUrl: basePreview.baseUrl,
      sourceUrl: basePreview.sourceUrl,
      connected: true,
      requiresConnection: true,
      connectionId: "00000000-0000-4000-8000-000000000001",
      ownership: "workspace",
      allowedTools: ["issues_list", "issues_removed", "issues_deprecated"],
      toolCount: 3,
      approvalRequiredToolCount: 0,
      revisionId: "openapi:old",
      contentSha256: "b".repeat(64),
    } satisfies ApiIntegrationInstallationSummary;
    let state = customApiFlowReducer(initialCustomApiFlowState(), {
      type: "edit",
      intent: "update",
      instance,
      connection: null,
    });
    state = customApiFlowReducer(state, {
      type: "preview",
      preview: {
        ...basePreview,
        tools: [
          basePreview.tools[0]!,
          { ...basePreview.tools[0]!, id: "issues_new", name: "New issue operation" },
          {
            ...basePreview.tools[0]!,
            id: "issues_deprecated",
            name: "Deprecated operation",
            deprecated: true,
          },
        ],
      },
    });

    expect(state.selectedTools).toEqual(["issues_list"]);
  });

  test("rejects installation when no tools are selected", () => {
    let state = customApiFlowReducer(initialCustomApiFlowState(), { type: "new" });
    state = customApiFlowReducer(state, {
      type: "preview",
      preview: { ...basePreview, auth: { kind: "none" } },
    });
    state = customApiFlowReducer(state, { type: "tools", selectedTools: [] });
    expect(customApiInstallValidationError(state)).toContain("Select at least one tool");
  });

  test("rejects authenticated installation without an exact Connection", () => {
    let state = customApiFlowReducer(initialCustomApiFlowState(), { type: "new" });
    state = customApiFlowReducer(state, { type: "preview", preview: basePreview });
    expect(customApiInstallValidationError(state)).toContain("Connect an account");
  });
});

function connection(
  id: string,
  providerDomain: string,
  subjectId: string | null,
  kind: "api_key" | "oauth2" = "api_key",
) {
  return {
    id,
    accountId: "00000000-0000-4000-8000-000000000020",
    workspaceId: "00000000-0000-4000-8000-000000000021",
    subjectId,
    providerDomain,
    kind,
    status: "active" as const,
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { credentialLabel: subjectId ? "Personal Linear" : "Workspace Linear" },
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("filterCustomApiInstances", () => {
  const instances = [
    customApiInstance("finance", "Linear - Finance", "linear.example.test"),
    customApiInstance("billing", "Stripe billing", "api.stripe.com"),
  ];

  test("a blank query keeps every installed instance", () => {
    expect(filterCustomApiInstances(instances, "   ").map((entry) => entry.instanceKey)).toEqual([
      "finance",
      "billing",
    ]);
  });

  test("a query narrows custom APIs like every other connector", () => {
    expect(filterCustomApiInstances(instances, "stripe").map((entry) => entry.instanceKey)).toEqual(
      ["billing"],
    );
    expect(
      filterCustomApiInstances(instances, "linear.example").map((entry) => entry.instanceKey),
    ).toEqual(["finance"]);
    expect(filterCustomApiInstances(instances, "nothing-here")).toEqual([]);
  });
});

function customApiInstance(
  instanceKey: string,
  displayName: string,
  providerDomain: string,
): ApiIntegrationInstallationSummary {
  return {
    capabilityId: `api:${instanceKey}`,
    pluginKey: `integration/${instanceKey}`,
    installationVersion: 1,
    instanceId: `instance-${instanceKey}`,
    instanceKey,
    displayName,
    instanceVersion: 1,
    serverId: `api_${instanceKey}`,
    name: displayName,
    description: null,
    protocol: "openapi",
    definitionId: instanceKey,
    definitionProvenance: "workspace",
    providerDomain,
    baseUrl: `https://${providerDomain}/`,
    sourceUrl: null,
    connected: true,
    requiresConnection: true,
    connectionId: "connection-1",
    ownership: "workspace",
    allowedTools: [],
    toolCount: 0,
    approvalRequiredToolCount: 0,
    revisionId: "rev-1",
    contentSha256: "sha-1",
  } as unknown as ApiIntegrationInstallationSummary;
}
