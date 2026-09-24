import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import type { AccessContext, CapabilityCatalogItem, ConnectionMetadata } from "@/types";
import type { ComposerPlusProps } from "@/components/composer-mobile-plus";

let composer: ComposerPlusProps | null = null;
const context: {
  client: OpenGeniBrowserClient;
  accessContext: AccessContext;
  refreshWorkspaceMcpServers: (workspaceId: string) => Promise<void>;
} = {
  client: {} as OpenGeniBrowserClient,
  accessContext: {
    mode: "managed",
    subjectId: "user-a",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: "workspace-a",
        accountId: "account-a",
        subjectId: "user-a",
        permissions: ["connections:read"],
      },
    ],
    defaultAccountId: "account-a",
    defaultWorkspaceId: "workspace-a",
  },
  refreshWorkspaceMcpServers: async () => {},
};

mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@/components/composer-mobile-plus", () => ({
  ComposerMobilePlus: (props: ComposerPlusProps) => {
    composer = props;
    return null;
  },
}));
mock.module("sonner", () => ({ toast: { error: () => {}, success: () => {} } }));

const { WorkspaceComposerPlus } = await import("./workspace-composer-plus");

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

test("a catalog failure and connection 403 mask cached composer account status", async () => {
  const entry = {
    id: "mcp:slack",
    name: "Slack",
    kind: "mcp",
    enabled: true,
    runtime: { available: true, mcpServerId: "slack" },
    lifecycle: { readiness: "ready" },
    connectionRef: { connectionId: "connection-1", providerDomain: "slack.com", kind: "oauth2" },
  } as CapabilityCatalogItem;
  const connection = {
    id: "connection-1",
    providerDomain: "slack.com",
    subjectId: null,
    status: "active",
  } as ConnectionMetadata;
  let failure: "none" | "transient" | "denied" = "none";
  context.client = {
    listCapabilities: async () => {
      if (failure !== "none") throw new Error("Catalog unavailable");
      return { items: [entry] };
    },
    listConnections: async () => {
      if (failure === "transient") throw new Error("Connections unavailable");
      if (failure === "denied") throw { status: 403 };
      return [connection];
    },
    catalogAssetUrl: () => null,
  } as unknown as OpenGeniBrowserClient;

  const props = {
    workspaceId: "workspace-a",
    servers: [],
    firstPartyTools: [],
    fileUploadsEnabled: false,
    onToolSelectionChange: () => {},
  } as unknown as ComponentProps<typeof WorkspaceComposerPlus>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<WorkspaceComposerPlus {...props} />));
  expect(composer!.servers[0]?.connectionStatus).toBe("ready");

  failure = "transient";
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Bun.sleep(0);
  });
  expect(composer!.servers[0]?.connectionStatus).toBe("ready");
  expect(composer!.connectorActions?.error).toBe("Catalog unavailable");

  failure = "denied";
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Bun.sleep(0);
  });
  expect(composer!.servers[0]?.connectionStatus).toBe("unknown");
  expect(composer!.connectorActions?.error).toContain("doesn't allow connection discovery");

  await act(async () => root.unmount());
  container.remove();
});
