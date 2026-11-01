import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

import type { McpConnection } from "@/lib/mcp-connections";

mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    { success: mock((_message: string) => undefined), error: mock(() => undefined) },
  ),
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { ConnectedAgents } = await import("./connected-agents");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const me = "user:11111111-1111-4111-8111-111111111111";
const timestamp = "2026-10-01T10:00:00.000Z";

function connection(id: string, overrides: Partial<McpConnection>): McpConnection {
  return {
    id,
    clientName: "Claude Code",
    clientHost: "127.0.0.1:4567",
    actor: "user",
    connectedBy: { subjectId: "user:owner", name: "Maja Berg" },
    policy: {
      preset: "read_only",
      permissions: ["workspace:read"],
      workspaceScope: { kind: "all" },
    },
    createdAt: timestamp,
    lastUsedAt: timestamp,
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function page(agent: McpConnection) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ConnectedAgents
        organizationName="Acme"
        mcpUrl="https://opengeni.test/v1/mcp"
        api={{
          list: async () => ({ connections: [agent], canManageAll: true }),
          update: async () => agent,
          disconnect: async () => undefined,
        }}
        currentSubjectId={me}
        workspaces={[]}
        location={{ agent: agent.id }}
        onNavigate={() => undefined}
      />,
    ),
  );
  await flush();
  return {
    more: () => container.querySelector(`button[aria-label="More for ${agent.clientName}"]`),
    text: () => container.textContent ?? "",
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("connected agents", () => {
  test("an admin who isn't the owner can't disconnect the owner's agent", async () => {
    const owners = await page(
      connection("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { canDisconnect: false }),
    );
    expect(owners.text()).toContain("Maja Berg");
    expect(owners.more()).toBeNull();
    await owners.unmount();

    const members = await page(
      connection("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
        connectedBy: { subjectId: "user:member", name: "Ola Nordmann" },
        canDisconnect: true,
      }),
    );
    expect(members.more()).not.toBeNull();
    await members.unmount();
  });
});
