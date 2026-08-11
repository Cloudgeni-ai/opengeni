import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { PluginReview } from "./source-import-dialog";
import {
  initialSourceImportState,
  sourceImportReducer,
  type InstalledSourceSkill,
} from "./source-import-flow";
import { SourcePackagesView } from "./source-packages-view";
import type {
  CapabilityCatalogItem,
  CapabilityInstallation,
  ConnectionMetadata,
  PluginInstallationSummary,
  PluginPreview,
} from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("source package components", () => {
  test("renders installed Skills and Plugins as distinct managed packages", async () => {
    const onUpdateSkill = mock(() => {});
    const onUpdatePlugin = mock(() => {});
    const rendered = await render(
      <SourcePackagesView
        skills={[installedSkill()]}
        plugins={[installedPlugin()]}
        loading={false}
        loadError={null}
        canManage
        filter="all"
        query=""
        busyKey={null}
        onRetry={() => {}}
        onImportSkill={() => {}}
        onInstallPlugin={() => {}}
        onUpdateSkill={onUpdateSkill}
        onUpdatePlugin={onUpdatePlugin}
        onRemoveSkill={() => {}}
        onRemovePlugin={() => {}}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("release-operator");
      expect(rendered.container.textContent).toContain("Research suite");
      expect(rendered.container.textContent).toContain("2 components");
      expect(rendered.container.textContent).toContain("Immutable source");

      const checkSkill = button(rendered.container, "Check for update");
      const reviewPlugin = button(rendered.container, "Review update");
      await act(async () => checkSkill.click());
      await act(async () => reviewPlugin.click());
      expect(onUpdateSkill).toHaveBeenCalledTimes(1);
      expect(onUpdatePlugin).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("keeps mutation actions disabled without workspace administrator authority", async () => {
    const rendered = await render(
      <SourcePackagesView
        skills={[installedSkill()]}
        plugins={[installedPlugin()]}
        loading={false}
        loadError={null}
        canManage={false}
        filter="all"
        query=""
        busyKey={null}
        onRetry={() => {}}
        onImportSkill={() => {}}
        onInstallPlugin={() => {}}
        onUpdateSkill={() => {}}
        onUpdatePlugin={() => {}}
        onRemoveSkill={() => {}}
        onRemovePlugin={() => {}}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("Workspace administrators can install");
      expect(button(rendered.container, "Import Skill").disabled).toBe(true);
      expect(button(rendered.container, "Install Plugin").disabled).toBe(true);
      expect(button(rendered.container, "Check for update").disabled).toBe(true);
      expect(button(rendered.container, "Review update").disabled).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("shows immutable Plugin facts and exact compatible Connection choices before install", async () => {
    let state = sourceImportReducer(initialSourceImportState(), {
      type: "new",
      kind: "plugin",
      operationId: "00000000-0000-4000-8000-000000000090",
    });
    state = sourceImportReducer(state, {
      type: "url",
      url: pluginPreview().sourceUrl,
    });
    state = sourceImportReducer(state, {
      type: "plugin_preview",
      preview: pluginPreview(),
    });
    const onBindingChange = mock((_componentKey: string, _connectionId: string) => {});
    const rendered = await render(
      <PluginReview
        state={state}
        connections={[connection()]}
        canManage
        busy={false}
        validationError="Choose an exact Connection for Linear."
        onPreview={() => {}}
        onBindingChange={onBindingChange}
        onInstall={() => {}}
        onBack={() => {}}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("Immutable Plugin bill of materials ready");
      expect(rendered.container.textContent).toContain("Manifest digest");
      expect(rendered.container.textContent).toContain("Component bill of materials");
      expect(rendered.container.textContent).toContain("Workspace Linear");
      expect(rendered.container.textContent).toContain("Choose an exact Connection");

      const select = rendered.container.querySelector<HTMLSelectElement>("select");
      expect(select).not.toBeNull();
      await act(async () => {
        select!.value = connection().id;
        select!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(onBindingChange).toHaveBeenCalledWith("linear", connection().id);
      expect(button(rendered.container, "Install this Plugin").disabled).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });
});

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
    },
  };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function installedSkill(): InstalledSourceSkill {
  const item: CapabilityCatalogItem = {
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
  const installation: CapabilityInstallation = {
    id: "00000000-0000-4000-8000-000000000020",
    accountId: "00000000-0000-4000-8000-000000000010",
    workspaceId: "00000000-0000-4000-8000-000000000011",
    capabilityId: item.id,
    kind: "skill",
    status: "active",
    config: {},
    metadata: {},
    enabledAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
  return {
    item,
    installation,
    sourceUrl: item.installUrl!,
    sourceCommit: "a".repeat(40),
    contentSha256: "b".repeat(64),
  };
}

function installedPlugin(): PluginInstallationSummary {
  return {
    pluginKey: "example/research",
    version: "2.0.0",
    name: "Research suite",
    description: "Research tools",
    category: "plugins",
    tags: ["research"],
    sourceUrl: "https://plugins.example.test/research.json",
    manifestDigest: "c".repeat(64),
    installationVersion: 2,
    componentCount: 2,
    status: "active",
    installedAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function pluginPreview(): PluginPreview {
  return {
    sourceUrl: "https://plugins.example.test/research.json",
    manifest: {
      schemaVersion: 1,
      pluginKey: "example/research",
      version: "2.0.0",
      name: "Research suite",
      description: "Research tools",
      category: "plugins",
      tags: ["research"],
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
    manifestDigest: "c".repeat(64),
    installed: false,
    installationVersion: null,
    components: [
      {
        key: "linear",
        kind: "integration",
        name: "Linear",
        capabilityId: "api:linear",
        digest: "d".repeat(64),
        connectionRequired: true,
        connectionId: null,
        instanceKey: "default",
        displayName: "Linear",
        facts: { providerDomain: "linear.example.test" },
      },
    ],
    diff: {
      fromVersion: null,
      toVersion: "2.0.0",
      added: ["linear"],
      removed: [],
      changed: [],
      unchanged: [],
    },
  };
}

function connection(): ConnectionMetadata {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    accountId: "00000000-0000-4000-8000-000000000010",
    workspaceId: "00000000-0000-4000-8000-000000000011",
    subjectId: null,
    providerDomain: "linear.example.test",
    kind: "api_key",
    status: "active",
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
