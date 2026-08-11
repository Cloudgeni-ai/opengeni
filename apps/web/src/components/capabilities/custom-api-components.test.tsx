import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { ADD_CUSTOM_CATALOG_KINDS } from "./add-custom-dialog";
import { CustomApiSection } from "./custom-api-section";
import type { ApiIntegrationInstallationSummary } from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("custom API components", () => {
  test("legacy Add custom no longer offers the generic API catalog path", async () => {
    expect(ADD_CUSTOM_CATALOG_KINDS).toEqual(["mcp", "skill", "plugin"]);
    expect(ADD_CUSTOM_CATALOG_KINDS).not.toContain("api");
  });

  test("never fabricates Ready when Connection data is unavailable", async () => {
    const rendered = await render(
      <CustomApiSection
        instances={[installedInstance()]}
        connections={null}
        canManage
        busyKey={null}
        onConnect={() => {}}
        onUpdate={() => {}}
        onReconnect={() => {}}
        onRemove={() => {}}
      />,
    );
    try {
      expect(rendered.container.textContent).toContain("Connection status unavailable");
      expect(rendered.container.textContent).toContain("Connection data unavailable");
      expect(rendered.container.textContent).not.toContain("StatusReady");
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
    container: document.body,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
    },
  };
}

function installedInstance(): ApiIntegrationInstallationSummary {
  return {
    capabilityId: "api:linear-like",
    pluginKey: "integration/linear-like",
    installationVersion: 2,
    instanceId: "00000000-0000-4000-8000-000000000050",
    instanceKey: "linear-finance",
    displayName: "Linear — Finance",
    instanceVersion: 3,
    serverId: "api_linear_like__linear_finance",
    name: "Linear — Finance",
    description: null,
    protocol: "graphql",
    presetId: null,
    providerDomain: "linear.example.test",
    baseUrl: "https://linear.example.test/graphql",
    sourceUrl: "https://linear.example.test/graphql",
    connected: true,
    requiresConnection: true,
    connectionId: "00000000-0000-4000-8000-000000000040",
    ownership: "workspace",
    allowedTools: ["query_issues"],
    toolCount: 1,
    approvalRequiredToolCount: 0,
    revisionId: "graphql:linear-revision",
    contentSha256: "b".repeat(64),
  };
}
