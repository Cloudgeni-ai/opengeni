import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { PluginReview } from "./source-import-dialog";
import { initialSourceImportState, sourceImportReducer } from "./source-import-flow";
import type { ConnectionMetadata, PluginPreview } from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("source import review", () => {
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
