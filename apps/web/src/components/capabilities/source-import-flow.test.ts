import { describe, expect, test } from "bun:test";

import type {
  CapabilityCatalogItem,
  CapabilityInstallation,
  ConnectionMetadata,
  PluginPreview,
} from "@/types";
import {
  initialSourceImportState,
  isWorkspaceImportedSkill,
  pluginBindingsRequest,
  pluginComponentConnections,
  sourceImportReducer,
  sourceImportValidationError,
  workspaceImportedSkills,
} from "./source-import-flow";

const pluginPreview: PluginPreview = {
  sourceUrl: "https://plugins.example.test/research.json",
  manifest: {
    schemaVersion: 1,
    pluginKey: "example/research",
    version: "1.0.0",
    name: "Research",
    description: "Research tools",
    category: "plugins",
    tags: [],
    components: [
      {
        key: "linear",
        kind: "integration",
        source: {
          kind: "graphql",
          endpoint: "https://linear.example.test/graphql",
        },
      },
    ],
  },
  manifestDigest: "a".repeat(64),
  installed: false,
  installationVersion: null,
  components: [
    {
      key: "linear",
      kind: "integration",
      name: "Linear",
      capabilityId: "api:linear",
      digest: "b".repeat(64),
      connectionRequired: true,
      connectionId: null,
      instanceKey: "default",
      displayName: "Linear",
      facts: { providerDomain: "linear.example.test" },
    },
  ],
  diff: {
    fromVersion: null,
    toVersion: "1.0.0",
    added: ["linear"],
    removed: [],
    changed: [],
    unchanged: [],
  },
};

describe("source import flow", () => {
  test("preserves source input and errors across close/reopen", () => {
    let state = sourceImportReducer(initialSourceImportState(), {
      type: "new",
      kind: "plugin",
      operationId: "operation-1",
    });
    state = sourceImportReducer(state, {
      type: "url",
      url: "https://plugins.example.test/research.json",
    });
    state = sourceImportReducer(state, {
      type: "error",
      message: "Manifest unavailable",
    });
    state = sourceImportReducer(state, { type: "close" });
    state = sourceImportReducer(state, { type: "open" });
    expect(state.url).toContain("research.json");
    expect(state.error).toBe("Manifest unavailable");
    expect(state.operationId).toBe("operation-1");
  });

  test("requires an exact compatible Plugin Connection and a rechecked preview", () => {
    let state = sourceImportReducer(initialSourceImportState(), {
      type: "new",
      kind: "plugin",
      operationId: "operation-2",
    });
    state = sourceImportReducer(state, {
      type: "url",
      url: pluginPreview.sourceUrl,
    });
    state = sourceImportReducer(state, {
      type: "plugin_preview",
      preview: pluginPreview,
    });
    expect(sourceImportValidationError(state)).toContain("Choose an exact Connection");
    state = sourceImportReducer(state, {
      type: "plugin_binding",
      componentKey: "linear",
      connectionId: "00000000-0000-4000-8000-000000000001",
    });
    expect(sourceImportValidationError(state)).toContain("Recheck");
    state = sourceImportReducer(state, {
      type: "plugin_preview",
      preview: pluginPreview,
    });
    expect(sourceImportValidationError(state)).toBeNull();
    expect(pluginBindingsRequest(state.pluginBindings)).toEqual({
      linear: { connectionId: "00000000-0000-4000-8000-000000000001" },
    });
  });

  test("rejects an update when the source changes Plugin identity", () => {
    let state = sourceImportReducer(initialSourceImportState(), {
      type: "edit_plugin",
      plugin: {
        pluginKey: "example/original",
        version: "1.0.0",
        name: "Original",
        description: "Original Plugin",
        category: "plugins",
        tags: [],
        sourceUrl: pluginPreview.sourceUrl,
        manifestDigest: "c".repeat(64),
        installationVersion: 1,
        componentCount: 1,
        status: "active",
        installedAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      },
      operationId: "operation-identity",
    });
    state = sourceImportReducer(state, {
      type: "plugin_preview",
      preview: pluginPreview,
    });
    state = sourceImportReducer(state, {
      type: "plugin_binding",
      componentKey: "linear",
      connectionId: "00000000-0000-4000-8000-000000000001",
    });
    state = sourceImportReducer(state, {
      type: "plugin_preview",
      preview: pluginPreview,
    });

    expect(sourceImportValidationError(state)).toContain("different Plugin identity");
  });

  test("filters Plugin Connection choices to active exact-domain accounts", () => {
    const connections = [
      connection("00000000-0000-4000-8000-000000000001", "linear.example.test", "active"),
      connection("00000000-0000-4000-8000-000000000002", "linear.example.test", "needs_reauth"),
      connection("00000000-0000-4000-8000-000000000003", "evil-linear.example", "active"),
    ];
    expect(
      pluginComponentConnections(connections, pluginPreview.components[0]!).map((row) => row.id),
    ).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  test("projects only executable workspace-imported Skills with OCC metadata", () => {
    const item = importedSkillItem();
    const installation = importedSkillInstallation();
    expect(isWorkspaceImportedSkill(item)).toBe(true);
    expect(workspaceImportedSkills([item], [installation])).toEqual([
      expect.objectContaining({
        sourceUrl: item.installUrl,
        sourceCommit: "a".repeat(40),
        contentSha256: "b".repeat(64),
        installation,
      }),
    ]);
    expect(workspaceImportedSkills([item], [{ ...installation, status: "disabled" }])).toEqual([]);
  });
});

function connection(
  id: string,
  providerDomain: string,
  status: ConnectionMetadata["status"],
): ConnectionMetadata {
  return {
    id,
    accountId: "00000000-0000-4000-8000-000000000010",
    workspaceId: "00000000-0000-4000-8000-000000000011",
    subjectId: null,
    providerDomain,
    kind: "api_key",
    status,
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { credentialLabel: "Workspace Linear" },
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function importedSkillItem(): CapabilityCatalogItem {
  return {
    id: "skill:release-operator-abc123",
    kind: "skill",
    source: "manual",
    name: "release-operator",
    description: "Release safely",
    category: "skills",
    tags: ["skill", "imported"],
    homepageUrl: "https://github.com/acme/skills",
    endpointUrl: null,
    installUrl: "https://github.com/acme/skills/tree/aaaaaaaa/release-operator",
    authModel: null,
    providerDomain: null,
    surfaceType: null,
    transport: null,
    mcpUrl: null,
    authKind: null,
    credentialFacts: [],
    tier: "community",
    provenance: "workspace_import",
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: { available: true, notes: null },
    lifecycle: {
      status: "installed",
      readiness: "ready",
      detail: "enabled",
      managedBy: "workspace",
    },
    actions: ["configure", "update", "uninstall", "inspect"],
    enabled: true,
    enabledReason: "enabled",
    connectionRef: null,
    metadata: {
      platformVersion: 2,
      provenance: "workspace_import",
      sourceCommit: "a".repeat(40),
      contentSha256: "b".repeat(64),
    },
  };
}

function importedSkillInstallation(): CapabilityInstallation {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    accountId: "00000000-0000-4000-8000-000000000010",
    workspaceId: "00000000-0000-4000-8000-000000000011",
    capabilityId: "skill:release-operator-abc123",
    kind: "skill",
    status: "active",
    config: { sourceCommit: "a".repeat(40) },
    metadata: {},
    enabledAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}
