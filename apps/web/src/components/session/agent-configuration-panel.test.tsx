import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { allAgentCapabilities } from "@opengeni/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { Session } from "@/types";

const workspaceId = "00000000-0000-4000-8000-000000000101";
const sessionId = "00000000-0000-4000-8000-000000000102";
const getAgentLearningSettings = mock(
  async (_workspace: string, scope: string, source?: { kind: string; id: string }) => ({
    ownerKey: scope,
    contextKey: source ? `${source.kind}:${source.id}` : "defaults",
    version: 1,
    settings: source ? {} : { knowledge: "review_first" },
  }),
);
const navigate = mock(async (_options: unknown) => undefined);
const context = {
  client: { getAgentLearningSettings, saveAgentLearningSettings: mock(async () => ({})) },
  workspaces: [
    {
      id: workspaceId,
      accountId: "account-1",
      kind: "shared",
      name: "Design preview",
      settings: {},
      agentInstructions: null,
    },
  ],
  accessContext: {
    subjectId: "user-1",
    accountGrants: [],
    workspaceGrants: [{ workspaceId, permissions: ["sessions:control"] }],
  },
  clientConfig: { agentConfig: { enabled: true, defaultForNewSessions: true, capabilities: [] } },
  managedSelfContext: null,
  workspaceDefaultToolIds: [],
  toolMcpServers: [],
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
mock.module("sonner", () => ({
  toast: Object.assign(() => 0, { error: () => 0, success: () => 0 }),
}));
const { AgentConfigurationPanel } = await import("./agent-configuration-panel");

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => undefined;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: sessionId,
    workspaceId,
    agent: {
      version: 1,
      from: "all",
      capabilities: allAgentCapabilities(),
      unavailable: [],
      identity: null,
      renderer: "markdown",
      source: "workspace_default",
    },
    toolPolicyVersion: 1,
    mcpServers: [],
    tools: [],
    memoryScope: "workspace",
    ...overrides,
  } as unknown as Session;
}

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

test("the Agent tab is one page: Identity, Capabilities and this chat's Agent learning", async () => {
  getAgentLearningSettings.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<AgentConfigurationPanel session={session()} onReloadSession={async () => {}} />),
    );
    await settle();
    const headings = [...container.querySelectorAll("[data-agent-section] > div > h3")].map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["Identity", "Capabilities", "Agent learning"]);
    // Where each part comes from, with a way to the page that sets it.
    const identity = container.querySelector<HTMLElement>('[data-agent-section="Identity"]')!;
    expect(identity.textContent).toContain("Workspace default");
    expect(
      identity.querySelector<HTMLAnchorElement>("a[href*='view=agent-defaults']"),
    ).not.toBeNull();
    const capabilities = container.querySelector<HTMLElement>(
      '[data-agent-section="Capabilities"]',
    )!;
    expect(capabilities.textContent).toContain("Workspace default");
    // Each capability says what it lets the agent do; Knowledge and Skills point at learning.
    const knowledge = capabilities.querySelector<HTMLElement>('[data-capability="knowledge"]')!;
    expect(knowledge.textContent).toContain("Search and save workspace knowledge");
    expect(knowledge.textContent).toContain("Whether its saves need your OK");
    expect(capabilities.querySelector('[data-capability="skills"]')?.textContent).toContain(
      "Agent learning",
    );
    expect(capabilities.querySelector('[data-capability="webSearch"]')?.textContent).not.toContain(
      "Agent learning",
    );
    // This chat's own learning settings, over the workspace defaults.
    const learning = container.querySelector<HTMLElement>('[data-agent-section="Agent learning"]')!;
    expect(getAgentLearningSettings).toHaveBeenCalledWith(workspaceId, "workspace", {
      kind: "chat",
      id: sessionId,
    });
    expect(learning.textContent).toContain("Default (Review first)");
    expect(learning.querySelector("a[href*='/state?page=learning']")?.textContent).toBe(
      "the workspace",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a private chat's Agent learning follows your private defaults", async () => {
  getAgentLearningSettings.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AgentConfigurationPanel
          session={session({ tenancy: { visibility: "private" } } as Partial<Session>)}
          onReloadSession={async () => {}}
        />,
      ),
    );
    await settle();
    expect(getAgentLearningSettings).toHaveBeenCalledWith(workspaceId, "personal", {
      kind: "chat",
      id: sessionId,
    });
    expect(container.querySelector('[data-agent-section="Agent learning"]')?.textContent).toContain(
      "your private chats",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Chat settings from the composer focuses Agent learning", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AgentConfigurationPanel
          session={session()}
          onReloadSession={async () => {}}
          learningFocusRequest={1}
        />,
      ),
    );
    await settle();
    expect(document.activeElement?.textContent).toBe("Agent learning");
    expect(document.activeElement?.tagName).toBe("H3");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
