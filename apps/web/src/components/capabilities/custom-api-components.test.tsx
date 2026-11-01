import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { ADD_CUSTOM_CATALOG_KINDS } from "./add-custom-dialog";
import { CustomApiSection } from "./custom-api-section";
import { organizationApiOwnKeyRequest } from "./organization-api-key-dialog";
import type {
  ApiIntegrationInstallationSummary,
  ConnectionMetadata,
} from "@opengeni/react/app/types";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("custom API components", () => {
  test("legacy Add custom no longer offers the generic API catalog path", async () => {
    expect(ADD_CUSTOM_CATALOG_KINDS).toEqual(["mcp"]);
    expect(ADD_CUSTOM_CATALOG_KINDS).not.toContain("api");
  });

  test("never fabricates Ready when Connection data is unavailable", async () => {
    const rendered = await render(
      <CustomApiSection
        instances={[installedInstance()]}
        connections={null}
        canAdd
        canManage
        canChange
        busyKey={null}
        onConnect={() => {}}
        onUpdate={() => {}}
        onReconnect={() => {}}
        onRemove={() => {}}
        onAddOwnKey={() => {}}
        onSetOrganizationHere={() => {}}
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

  test("an instance carried into Personal names its workspace and offers no management", async () => {
    const rendered = await render(
      <CustomApiSection
        instances={[
          {
            ...installedInstance(),
            personalExtension: {
              originWorkspaceId: "00000000-0000-4000-8000-000000000099",
              originWorkspaceName: "Team workspace",
            },
          },
        ]}
        connections={[]}
        canAdd
        canManage
        canChange
        busyKey={null}
        onConnect={() => {}}
        onUpdate={() => {}}
        onReconnect={() => {}}
        onRemove={() => {}}
        onAddOwnKey={() => {}}
        onSetOrganizationHere={() => {}}
      />,
    );
    try {
      const card = rendered.container.querySelector("[data-custom-api-instance]")!;
      expect(card.textContent).toContain("From Team workspace");
      const labels = Array.from(card.querySelectorAll("button")).map(
        (button) => button.textContent,
      );
      expect(labels).toEqual([]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a member connects and removes custom APIs; reconnecting and updating stay with admins", async () => {
    const rendered = await render(
      <CustomApiSection
        instances={[{ ...installedInstance(), requiresConnection: true }]}
        connections={[]}
        canAdd
        canManage
        canChange={false}
        busyKey={null}
        onConnect={() => {}}
        onUpdate={() => {}}
        onReconnect={() => {}}
        onRemove={() => {}}
        onAddOwnKey={() => {}}
        onSetOrganizationHere={() => {}}
      />,
    );
    try {
      const enabled = Array.from(rendered.container.querySelectorAll("button"))
        .filter((button) => !button.disabled)
        .map((button) => button.textContent?.trim());
      expect(enabled).toEqual(["Connect custom API", "Remove"]);
    } finally {
      await rendered.unmount();
    }
  });

  test("an organization's API says where it comes from and offers only this workspace's switch and the person's own key", async () => {
    const calls: string[] = [];
    const props = (
      instance: ApiIntegrationInstallationSummary,
      connections: ConnectionMetadata[],
      canChange = true,
    ) => (
      <CustomApiSection
        instances={[instance]}
        connections={connections}
        canAdd
        canManage
        canChange={canChange}
        busyKey={null}
        onConnect={() => {}}
        onUpdate={() => calls.push("update")}
        onReconnect={() => calls.push("reconnect")}
        onRemove={() => calls.push("remove")}
        onAddOwnKey={() => calls.push("add-key")}
        onSetOrganizationHere={(_instance, enabledHere) => calls.push(`here:${enabledHere}`)}
      />
    );
    const buttons = (container: HTMLElement) =>
      Array.from(container.querySelectorAll("[data-custom-api-instance] button"));

    let rendered = await render(props(organizationInstance("each_person"), []));
    try {
      const card = rendered.container.querySelector("[data-custom-api-instance]")!;
      expect(card.textContent).toContain("From your organization");
      expect(card.textContent).toContain("Your organization");
      expect(card.textContent).toContain("Add your key to use it");
      expect(buttons(rendered.container).map((button) => button.textContent)).toEqual([
        "Add your key",
        "Turn off here",
      ]);
      for (const button of buttons(rendered.container))
        await act(async () => (button as HTMLButtonElement).click());
      expect(calls).toEqual(["add-key", "here:false"]);
    } finally {
      await rendered.unmount();
    }

    // The person's own Only me key to the same provider runs it; nothing left to add.
    rendered = await render(
      props(organizationInstance("each_person"), [ownKey("billing.example.test", "api_key")]),
    );
    try {
      const card = rendered.container.querySelector("[data-custom-api-instance]")!;
      expect(card.textContent).toContain("Ready · your own account");
      expect(buttons(rendered.container).map((button) => button.textContent)).toEqual([
        "Turn off here",
      ]);
    } finally {
      await rendered.unmount();
    }

    // Off here: a manager turns it back on; anyone else sees it off, with no switch.
    rendered = await render(props(organizationInstance("organization_key", false), []));
    try {
      const card = rendered.container.querySelector("[data-custom-api-instance]")!;
      expect(card.textContent).toContain("From your organization · Off here");
      expect(card.textContent).toContain("Off in this workspace");
      expect(buttons(rendered.container).map((button) => button.textContent)).toEqual([
        "Turn on here",
      ]);
    } finally {
      await rendered.unmount();
    }
    rendered = await render(props(organizationInstance("organization_key"), [], false));
    try {
      expect(rendered.container.textContent).toContain("The organization's key");
      expect(buttons(rendered.container)).toEqual([]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a person's own key for an organization's API is an Only me key to its provider, sent where the API expects it", () => {
    const instance = organizationInstance("each_person");
    expect(
      organizationApiOwnKeyRequest(instance, { value: "  ", username: "", password: "" }),
    ).toEqual({ issue: "Paste the key." });
    expect(
      organizationApiOwnKeyRequest(instance, { value: " secret ", username: "", password: "" }),
    ).toMatchObject({
      request: {
        providerDomain: "billing.example.test",
        kind: "api_key",
        ownership: "personal",
        credential: { placements: [{ carrier: "header", name: "X-Api-Key", value: "secret" }] },
      },
    });
  });
});

function organizationInstance(
  login: "each_person" | "organization_key" | "none",
  enabledHere = true,
): ApiIntegrationInstallationSummary {
  return {
    ...installedInstance(),
    capabilityId: "api:openapi:billing",
    instanceKey: "organization",
    displayName: "Billing API",
    name: "Billing API",
    protocol: "openapi",
    definitionId: "billing",
    providerDomain: "billing.example.test",
    baseUrl: "https://billing.example.test/v1/",
    connected: false,
    requiresConnection: login !== "none",
    connectionId: null,
    ownership: "none",
    organizationConnector: {
      connectorId: "00000000-0000-4000-8000-000000000077",
      login,
      auth: {
        kind: "api_key",
        providerDomain: "billing.example.test",
        carrier: "header",
        name: "X-Api-Key",
      },
      enabledHere,
    },
  };
}

function ownKey(providerDomain: string, kind: ConnectionMetadata["kind"]): ConnectionMetadata {
  return {
    id: "00000000-0000-4000-8000-000000000088",
    providerDomain,
    kind,
    status: "active",
    subjectId: "user:alice",
    metadata: { credentialLabel: "Billing API credential" },
    createdAt: "2026-10-31T00:00:00Z",
  } as unknown as ConnectionMetadata;
}

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
    definitionId: "linear-graphql",
    definitionProvenance: "workspace",
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
