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
  clientConfig: {
    agentConfig: { enabled: true, defaultForNewSessions: true, capabilities: [] },
  } as {
    agentConfig: { enabled: boolean; defaultForNewSessions: boolean; capabilities: never[] };
    sessionArchive?: { enabled: true; idleDays: number };
  },
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

test("the Agent tab is one page: Identity, then Capabilities with Agent learning inside", async () => {
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
    expect(headings).toEqual(["Identity", "Capabilities"]);
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
    // This chat's learning is read and shown inside Knowledge and Skills.
    expect(getAgentLearningSettings).toHaveBeenCalledWith(workspaceId, "workspace", {
      kind: "chat",
      id: sessionId,
    });
    const knowledge = capabilities.querySelector<HTMLElement>('[data-capability="knowledge"]')!;
    expect(knowledge.textContent).toContain("Read and write · Review first");
    expect(knowledge.textContent).toContain("can save to them");
    expect(capabilities.querySelector('[data-capability="skills"]')?.textContent).toContain(
      "Read and write",
    );
    expect(capabilities.querySelector('[data-capability="webSearch"]')?.textContent).not.toContain(
      "Read and write",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a private chat's learning comes from your private chat settings", async () => {
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
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Chat settings from the composer opens the editor on Capabilities", async () => {
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
    expect(container.textContent).toContain("Edit agent");
    expect(document.activeElement?.textContent).toBe("Capabilities");
    expect(document.activeElement?.tagName).toBe("H3");
    // Knowledge is one Off / Read / Read and write choice with its review mode beside it.
    const knowledge = container.querySelector<HTMLElement>('[data-capability="knowledge"]')!;
    expect(knowledge.textContent).toContain("Read and write");
    expect(knowledge.textContent).toContain("Saved knowledge");
    expect(knowledge.textContent).toContain("Edits to instructions");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Storage keeps a chat active only where the deployment archives idle chats", async () => {
  const clientConfig = context.clientConfig;
  const updateSessionRetention = mock(
    async (_workspace: string, _session: string, request: { keepLive: boolean }) =>
      ({
        id: sessionId,
        workspaceId,
        retention: { keepLive: request.keepLive, archive: null },
      }) as unknown as Session,
  );
  const setSession = mock((_update: unknown) => undefined);
  Object.assign(context.client, { updateSessionRetention });
  Object.assign(context, { setSession });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const storageSection = () =>
    container.querySelector<HTMLElement>('[data-agent-section="Storage"]');
  try {
    // Off on this deployment: no Storage section at all.
    await act(async () =>
      root.render(<AgentConfigurationPanel session={session()} onReloadSession={async () => {}} />),
    );
    await settle();
    expect(storageSection()).toBeNull();

    context.clientConfig = { ...clientConfig, sessionArchive: { enabled: true, idleDays: 30 } };
    await act(async () =>
      root.render(
        <AgentConfigurationPanel
          session={session({ retention: { keepLive: false, archive: null } })}
          onReloadSession={async () => {}}
        />,
      ),
    );
    await settle();
    const storage = storageSection()!;
    expect(storage.textContent).toContain("Keep this chat active");
    expect(storage.textContent).toContain("no activity for 30 days become read-only");
    const toggle = storage.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    await settle();
    expect(updateSessionRetention).toHaveBeenCalledWith(workspaceId, sessionId, {
      keepLive: true,
    });
    expect(setSession).toHaveBeenCalled();

    // A read-only chat has nothing left to keep active.
    await act(async () =>
      root.render(
        <AgentConfigurationPanel
          session={session({
            retention: {
              keepLive: false,
              archive: { state: "archived", archivedAt: "2026-01-01T00:00:00.000Z" },
            },
          })}
          onReloadSession={async () => {}}
        />,
      ),
    );
    await settle();
    expect(storageSection()).toBeNull();
  } finally {
    context.clientConfig = clientConfig;
    await act(async () => root.unmount());
    container.remove();
  }
});
