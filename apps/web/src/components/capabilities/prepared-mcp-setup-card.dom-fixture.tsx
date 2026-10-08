import { expect, mock, test } from "bun:test";
import { StrictMode } from "react";
import type { ConnectAttempt, ConnectTransport } from "@opengeni/connect";
import type { AuthNeededItem } from "@opengeni/react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  registerDom,
  renderComponent,
  flush,
  actRun,
} from "../../../../../packages/react/test/render-hook";

registerDom();
window.location.href = "https://console.example.test/workspaces/workspace/sessions/session";
const { PreparedMcpSetupCard } = await import("./prepared-mcp-setup-card");
const setup = {
  name: "Records MCP",
  endpointUrl: "https://mcp.example.test/tools",
  headers: [{ name: "Authorization", secret: "key", prefix: "Bearer " }],
  secretFields: [{ id: "key", label: "API key" }],
};
const notice = {
  id: "card",
  kind: "auth-needed",
  providerDomain: "mcp.example.test",
  setupRequest: {
    kind: "mcp",
    name: setup.name,
    endpointUrl: setup.endpointUrl,
    rationale: "Find the requested records.",
    ownership: "personal",
    mcpSetup: setup,
  },
} as AuthNeededItem;

function fixture(ownership: "personal" | "workspace" = "personal") {
  let current: ConnectAttempt = {
    id: "setup",
    workspaceId: "workspace",
    providerId: "mcp-headers",
    ownership,
    revision: 1,
    state: "credential_input",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "integration",
    mcpSetup: setup,
    expiresAt: "2030-01-01T00:00:00Z",
    nextAction: {
      type: "credentials",
      fields: [{ name: "key", label: "API key", required: true, secret: true }],
    },
  };
  let beginKey: string | undefined;
  const transport = {
    catalog: mock(async () => []),
    accounts: mock(async () => []),
    pending: mock(async () => []),
    begin: mock(async (_workspace: string, input: Parameters<ConnectTransport["begin"]>[1]) => {
      if (beginKey && beginKey !== input.idempotencyKey)
        current = {
          ...current,
          id: "restarted-setup",
          revision: 1,
          state: "credential_input",
          nextAction: {
            type: "credentials",
            fields: [{ name: "key", label: "API key", required: true, secret: true }],
          },
        };
      beginKey = input.idempotencyKey;
      return structuredClone(current);
    }),
    get: mock(async () => structuredClone(current)),
    advance: mock(
      async (
        _workspace: string,
        _id: string,
        _input: Parameters<ConnectTransport["advance"]>[2],
      ) => {
        current = {
          ...current,
          revision: current.revision + 1,
          state: "complete",
          credentialsCommitted: true,
          integrationInstalled: true,
          mcpCapabilityId: "mcp:records",
          nextAction: { type: "none" },
        };
        return structuredClone(current);
      },
    ),
    cancel: mock(async () => {
      current = { ...current, revision: 2, state: "cancelled", nextAction: { type: "none" } };
      return structuredClone(current);
    }),
    disconnect: mock(async () => {}),
  } satisfies ConnectTransport;
  const update = mock(async () => ({ firstPartyMcpTools: [] }));
  const capabilities = mock(async () => ({
    items: [
      {
        id: "mcp:records",
        kind: "mcp",
        enabled: true,
        runtime: { mcpServerId: "records" },
        tools: [{ kind: "mcp", id: "records" }],
      },
    ],
  }));
  const client = {
    connectTransport: () => transport,
    listCapabilities: capabilities,
    getSession: mock(async () => ({
      id: "session",
      tools: [{ kind: "mcp", id: "existing" }],
      firstPartyMcpTools: [],
      toolPolicy: { mode: "explicit" },
      toolPolicyVersion: 7,
    })),
    updateSessionToolPolicy: update,
  } as unknown as OpenGeniBrowserClient;
  return {
    transport,
    update,
    capabilities,
    props: {
      item: { ...notice, setupRequest: { ...notice.setupRequest!, ownership } },
      client,
      workspaceId: "workspace",
      sessionId: "session",
      actorId: "human",
      canConfigure: true,
    },
  };
}

for (const ownership of ["personal", "workspace"] as const)
  test(`inline ${ownership} setup submits only the key and retains the prepared mapping`, async () => {
    const f = fixture(ownership);
    const view = await renderComponent(
      <StrictMode>
        <PreparedMcpSetupCard {...f.props} />
      </StrictMode>,
    );
    try {
      await flush();
      const inputs = view.container.querySelectorAll("input");
      expect(inputs.length).toBe(1);
      expect(inputs[0]!.type).toBe("password");
      expect(view.container.textContent).toContain(
        ownership === "personal" ? "Personal connection" : "Workspace connection",
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      const calls = f.transport.begin.mock.calls as unknown as Array<
        [string, { idempotencyKey: string; ownership: string; mcpSetup: unknown }]
      >;
      expect(new Set(calls.map((call) => call[1].idempotencyKey)).size).toBe(1);
      expect(calls[0]![1]).toMatchObject({ ownership, mcpSetup: setup });
      inputs[0]!.value = "synthetic-key";
      await actRun(() =>
        view.container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await flush();
      expect(f.transport.advance).toHaveBeenCalledTimes(1);
      expect(f.transport.advance.mock.calls[0]![2].action).toEqual({
        type: "credentials",
        values: { key: "synthetic-key" },
      });
      expect(inputs[0]!.value).toBe("");
      expect(view.container.innerHTML).not.toContain("synthetic-key");
      expect(f.update).toHaveBeenCalledTimes(1);
      expect(
        (f.update.mock.calls as unknown as Array<[string, string, unknown]>)[0]![2],
      ).toMatchObject({
        expectedVersion: 7,
        tools: [
          { kind: "mcp", id: "existing" },
          { kind: "mcp", id: "records" },
        ],
      });
      expect(view.container.textContent).toContain("available from your next message");
    } finally {
      await view.unmount();
    }
  });

test("rejection offers corrected key input without an OAuth redirect or automatic retry", async () => {
  const f = fixture();
  f.transport.advance.mockImplementation(async () => ({
    ...(await f.transport.get()),
    revision: 2,
    error: { code: "mcp_verification_failed", message: "safe", retryable: false },
  }));
  const view = await renderComponent(<PreparedMcpSetupCard {...f.props} />);
  try {
    await flush();
    view.container.querySelector("input")!.value = "bad-synthetic-key";
    await actRun(() =>
      view.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await flush();
    expect(view.container.textContent).toContain("Nothing was connected");
    expect(view.container.querySelector("input")!.value).toBe("");
    expect(view.container.querySelector("a")).toBeNull();
    expect(f.transport.advance).toHaveBeenCalledTimes(1);
    expect(f.update).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

test("changing actor or losing permission removes unsent secret fields", async () => {
  const f = fixture();
  const view = await renderComponent(<PreparedMcpSetupCard {...f.props} />);
  try {
    await flush();
    view.container.querySelector("input")!.value = "unsent-key";
    await view.rerender(<PreparedMcpSetupCard {...f.props} actorId="other-human" />);
    await flush();
    expect(view.container.querySelector("input")!.value).toBe("");
    await view.rerender(<PreparedMcpSetupCard {...f.props} canConfigure={false} />);
    expect(view.container.querySelector("input")).toBeNull();
    expect(view.container.textContent).toContain("management access");
    expect(f.transport.advance).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

test("saved credentials are not resubmitted when selecting chat tools fails", async () => {
  const f = fixture();
  f.update.mockImplementation(async () => {
    throw new Error("Selection changed");
  });
  const view = await renderComponent(<PreparedMcpSetupCard {...f.props} />);
  try {
    await flush();
    view.container.querySelector("input")!.value = "synthetic-key";
    await actRun(() =>
      view.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await flush();
    expect(view.container.textContent).toContain("Your key is saved");
    expect(view.container.querySelector("input")).toBeNull();
    const retry = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Check chat access",
    )!;
    await actRun(() => retry.click());
    await flush();
    expect(f.transport.advance).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledTimes(2);
  } finally {
    await view.unmount();
  }
});

test("cancelled setup restarts only on an explicit click with a new durable identity", async () => {
  const f = fixture();
  const view = await renderComponent(<PreparedMcpSetupCard {...f.props} />);
  try {
    await flush();
    view.container.querySelector("input")!.value = "never-submitted";
    const button = (text: string) =>
      [...view.container.querySelectorAll("button")].find((item) => item.textContent === text)!;
    await actRun(() => button("Cancel setup").click());
    await flush();
    expect(view.container.querySelector("input")).toBeNull();
    expect(f.transport.begin).toHaveBeenCalledTimes(1);
    await actRun(() => button("Start a new setup").click());
    await flush();
    expect(f.transport.begin.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      "mcp-card:card",
      "mcp-restart:setup",
    ]);
    expect(view.container.querySelector("input")!.value).toBe("");
    expect(f.transport.advance).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});
