import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type {
  AccessContext,
  ApiIntegrationInstallationSummary,
  IntegrationDefinitionSummary,
} from "@/types";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

// The adapter reads everything through the app context; swap it per case.
const mutableContext: { current: Record<string, unknown> } = { current: {} };
mock.module("@/context", () => ({
  useAppContext: () => mutableContext.current,
}));

const { useOutlookMailIntegration } = await import("./use-outlook-mail-integration");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

function accessContext(permissions: string[]): AccessContext {
  return {
    mode: "managed",
    subjectId: "subject-a",
    accountGrants: [],
    workspaceGrants: [
      { workspaceId: WORKSPACE_ID, accountId: ACCOUNT_ID, subjectId: "subject-a", permissions },
    ],
    defaultAccountId: ACCOUNT_ID,
    defaultWorkspaceId: WORKSPACE_ID,
  } as unknown as AccessContext;
}

function appContext(permissions: string[], client: Record<string, unknown> = {}) {
  return { client, accessContext: accessContext(permissions) };
}

const DEFINITIONS: IntegrationDefinitionSummary[] = [
  {
    id: "microsoft-outlook-mail",
    name: "Outlook Mail",
    summary: "Messages, folders, attachments, settings, and sending mail.",
    protocol: "openapi",
    provider: { id: "microsoft", domain: "graph.microsoft.com" },
    authentication: { kind: "oauth2", scopes: ["Mail.ReadWrite"] },
    facets: [],
  },
];

function account(
  overrides: Partial<ApiIntegrationInstallationSummary> = {},
): ApiIntegrationInstallationSummary {
  return {
    capabilityId: "cap-1",
    pluginKey: "microsoft-outlook-mail",
    installationVersion: 1,
    instanceId: "instance-1",
    instanceKey: "account-1",
    displayName: "ana@acme.com",
    instanceVersion: 1,
    serverId: "server-1",
    name: "Outlook Mail",
    description: null,
    protocol: "openapi",
    definitionId: "microsoft-outlook-mail",
    definitionProvenance: "curated",
    providerDomain: "graph.microsoft.com",
    baseUrl: "https://graph.microsoft.com/v1.0/",
    sourceUrl: null,
    connected: true,
    requiresConnection: true,
    connectionId: "connection-1",
    ownership: "workspace",
    allowedTools: ["mail.list", "mail.send"],
    toolCount: 2,
    approvalRequiredToolCount: 0,
    revisionId: "rev-1",
    contentSha256: "sha-1",
    ...overrides,
  };
}

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

function Harness({
  permissions,
  instances,
  onModel,
}: {
  permissions: string[];
  instances: ApiIntegrationInstallationSummary[];
  onModel: (model: ReturnType<typeof useOutlookMailIntegration>["model"]) => void;
}) {
  mutableContext.current = appContext(permissions);
  const adapter = useOutlookMailIntegration({
    workspaceId: WORKSPACE_ID,
    definitions: DEFINITIONS,
    instances,
  });
  onModel(adapter.model);
  return null;
}

describe("useOutlookMailIntegration", () => {
  test("zero accounts: idle chip and a Set up footer for an admin", async () => {
    let model: ReturnType<typeof useOutlookMailIntegration>["model"] | undefined;
    const rendered = await render(
      <Harness
        permissions={["workspace:admin"]}
        instances={[]}
        onModel={(current) => (model = current)}
      />,
    );
    try {
      expect(model?.chip).toEqual({ label: "Not connected", tone: "idle" });
      expect(model?.access).toBeUndefined();
      expect(model?.footer.kind).toBe("setup");
    } finally {
      await rendered.unmount();
    }
  });

  test("zero accounts: a non-admin sees a plain admin-managed chip and a locked footer", async () => {
    let model: ReturnType<typeof useOutlookMailIntegration>["model"] | undefined;
    const rendered = await render(
      <Harness permissions={[]} instances={[]} onModel={(current) => (model = current)} />,
    );
    try {
      expect(model?.chip).toEqual({ label: "Set up by an admin", tone: "plain" });
      expect(model?.footer.kind).toBe("locked");
    } finally {
      await rendered.unmount();
    }
  });

  test("one healthy account: ok chip, Connected accounts block, and tools from allowedTools", async () => {
    let model: ReturnType<typeof useOutlookMailIntegration>["model"] | undefined;
    const rendered = await render(
      <Harness
        permissions={["workspace:admin"]}
        instances={[account()]}
        onModel={(current) => (model = current)}
      />,
    );
    try {
      expect(model?.chip).toEqual({ label: "Connected", tone: "ok" });
      expect(model?.access?.title).toBe("Connected accounts");
      expect(model?.access?.editLabel).toBe("+ Add account");
      expect(model?.access?.items).toHaveLength(1);
      expect(model?.access?.items[0]).toMatchObject({ name: "ana@acme.com", status: "ok" });
      // A healthy account offers no Reconnect, but always a per-instance Remove:
      // a connected curated account must never be un-removable.
      expect(model?.access?.items[0]?.actions?.map((entry) => entry.label)).toEqual(["Remove"]);
      expect(model?.footer.kind).toBe("locked");
      expect(model?.tools?.tools).toEqual(["mail.list", "mail.send"]);
    } finally {
      await rendered.unmount();
    }
  });

  test("an unhealthy account rolls the row chip up to warn and offers Reconnect plus Remove", async () => {
    let model: ReturnType<typeof useOutlookMailIntegration>["model"] | undefined;
    const rendered = await render(
      <Harness
        permissions={["workspace:admin"]}
        instances={[account({ connected: false })]}
        onModel={(current) => (model = current)}
      />,
    );
    try {
      expect(model?.chip).toEqual({ label: "Needs attention", tone: "warn" });
      expect(model?.access?.items[0]).toMatchObject({ status: "warn" });
      expect(model?.access?.items[0]?.actions?.map((entry) => entry.label)).toEqual([
        "Reconnect",
        "Remove",
      ]);
    } finally {
      await rendered.unmount();
    }
  });

  test("two accounts stay one row, each with its own removal affordance", async () => {
    let model: ReturnType<typeof useOutlookMailIntegration>["model"] | undefined;
    const rendered = await render(
      <Harness
        permissions={["workspace:admin"]}
        instances={[
          account({ instanceKey: "account-1", displayName: "ana@acme.com" }),
          account({
            instanceKey: "account-2",
            displayName: "ben@acme.com",
            connected: false,
          }),
        ]}
        onModel={(current) => (model = current)}
      />,
    );
    try {
      expect(model?.id).toBe("outlook-mail");
      expect(model?.access?.items).toHaveLength(2);
      expect(model?.access?.items.map((entry) => entry.id)).toEqual(["account-1", "account-2"]);
      expect(model?.access?.items[0]?.actions?.map((entry) => entry.label)).toEqual(["Remove"]);
      expect(model?.access?.items[1]?.actions?.map((entry) => entry.label)).toEqual([
        "Reconnect",
        "Remove",
      ]);
      expect(model?.chip.tone).toBe("warn");
    } finally {
      await rendered.unmount();
    }
  });
});
