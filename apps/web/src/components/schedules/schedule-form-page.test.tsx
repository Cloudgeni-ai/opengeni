import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ScheduledTask, Session } from "@opengeni/react/app/types";
import type { ReactNode } from "react";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const selectMenu = await import("@opengeni/react/ui/select-menu");

const workspaceId = "workspace-example";
let task: ScheduledTask;
let chats: Session[];
let privateAllowed = false;
let defaultVisibility: "private" | "workspace" = "workspace";
let machines: unknown[] = [];
const updateScheduledTask = mock(
  async (_workspace: string, _id: string, _request: unknown) => task,
);
const client = {
  getScheduledTask: async () => task,
  updateScheduledTask,
  getSession: async (_workspace: string, id: string) => chats.find((chat) => chat.id === id)!,
  listSessions: async () => chats,
  listSessionPage: async () => ({ pinned: [], sessions: chats, nextCursor: null }),
  getAgent: async (_workspace: string, id: string) => ({
    id,
    name: "Triage",
    visibility: "workspace",
    templateKey: null,
  }),
  listAgents: async () => [
    { id: AGENT, name: "Triage", description: "", visibility: "workspace", avatar: null },
    { id: OTHER_AGENT, name: "Reviewer", description: "", visibility: "workspace", avatar: null },
  ],
  // The server filters by agent.
  listAgentChats: async (_workspace: string, agentId: string) => ({
    chats: chats
      .filter((chat) => chat.agentId === agentId)
      .map((chat) => ({
        sessionId: chat.id,
        title: chat.title ?? null,
        visibility: "workspace" as const,
        createdBySubjectId: null,
        source: "app" as const,
        slack: null,
        createdAt: "2026-11-21T00:00:00.000Z",
        updatedAt: "2026-11-21T00:00:00.000Z",
      })),
    nextCursor: null,
  }),
  getSessionTenancyCreateCapabilities: async () => ({
    activated: true,
    canCreatePrivate: privateAllowed,
    reason: privateAllowed ? "available" : "not_activated",
    defaultVisibility: privateAllowed ? defaultVisibility : "workspace",
  }),
  getAgentLearningSettings: async () => ({
    settings: {},
    version: 1,
    ownerKey: `workspace:${workspaceId}`,
  }),
  listOwnConnectionAccounts: async () =>
    [
      { id: "saved-account", providerDomain: "retained.example.test" },
      { id: "later-account", providerDomain: "retained.example.test" },
      { id: "empty-account", providerDomain: "empty.example.test" },
      { id: "new-account", providerDomain: "added.example.test" },
    ].map((connection) => ({
      ...connection,
      status: "active",
      subjectId: null,
      metadata: {},
    })),
};
const context = {
  client,
  clientConfig: { mcpServers: [], defaultSandboxBackend: "none" },
  workspaces: [],
  managedSelfContext: null,
  model: "example-model",
  reasoningEffort: "high",
  selectedCapabilityToolIds: new Set<string>(),
  workspaceDefaultToolIds: [] as string[],
  workspaceCapabilityCatalog: ["retained", "empty", "added"].map((id) => ({
    name: id,
    enabled: true,
    runtime: { mcpServerId: id },
    connectionRef: { providerDomain: `${id}.example.test` },
  })),
  accessContext: {
    workspaceGrants: [{ workspaceId, permissions: ["connections:read"] }],
  },
};
mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#chat">{children}</a>,
}));
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => context,
  // The account picker reads the same context to name each account's origin.
  useOptionalAppContext: () => context,
}));
mock.module("./schedule-parts", () => ({
  useScheduleAccess: () => ({
    canManage: true,
    canRun: true,
    canTargetSessions: true,
    viewerSubjectId: "viewer",
  }),
  useScheduleNavigation: () => ({ detail: () => {}, list: () => {} }),
}));
mock.module("./create-with-opengeni", () => ({
  useCanCreateScheduleWithAgent: () => false,
  useCreateWithOpenGeni: () => ({ dialog: null }),
}));
mock.module("@opengeni/react/app/lib/use-workspace-machines", () => ({
  useWorkspaceMachines: () => ({ machines, loading: false }),
}));
mock.module("@opengeni/react/app/lib/use-workspace-model-catalog", () => ({
  useWorkspaceModelCatalog: () => ({
    defaultSelection: null,
    rows: [],
    loading: false,
  }),
}));
mock.module("@opengeni/react/app/components/knowledge/agent-learning-settings", () => ({
  AgentLearningDraftEditor: () => null,
}));
mock.module("./schedule-agent-capabilities", () => ({
  ScheduleAgentCapabilities: () => null,
}));
mock.module("./schedule-composer", () => ({
  ComposerField: ({
    draft,
    update,
  }: {
    draft: { prompt: string; mcpServerIds: string[] };
    update: (patch: unknown) => void;
  }) => (
    <>
      <textarea
        aria-label="Scheduled message"
        value={draft.prompt}
        onChange={(event) => update({ prompt: event.target.value })}
      />
      <button
        type="button"
        onClick={() => update({ mcpServerIds: [...draft.mcpServerIds, "added"] })}
      >
        Add example connector
      </button>
      <button type="button" onClick={() => update({ prompt: "Updated example message" })}>
        Edit example message
      </button>
    </>
  ),
}));
mock.module("@opengeni/react/ui/form-dialog", () => ({
  // The template dialog is never open on this page.
  FormDialog: () => null,
  FormPage: ({
    children,
    onSubmit,
    submitDisabled,
    disabledReason,
  }: {
    children?: ReactNode;
    onSubmit?: () => Promise<unknown>;
    submitDisabled?: boolean;
    disabledReason?: ReactNode;
  }) => (
    <>
      {children}
      <p data-disabled-reason>{disabledReason}</p>
      <button type="button" data-submit disabled={submitDisabled} onClick={() => void onSubmit?.()}>
        Save changes
      </button>
    </>
  ),
}));
mock.module("@opengeni/react/ui/select-menu", () => ({
  ...selectMenu,
  SelectMenu: ({
    value,
    options,
    onValueChange,
  }: {
    value: string;
    options: { value: string; label: string; disabled?: boolean; disabledReason?: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          data-locked={option.disabled ? option.disabledReason : undefined}
        >
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
const { ScheduleFormPage } = await import("./schedule-form-page");
type ScheduleFormMode = import("./schedule-form-page").ScheduleFormMode;

beforeEach(() => {
  document.body.replaceChildren();
  updateScheduledTask.mockClear();
  privateAllowed = false;
  defaultVisibility = "workspace";
  machines = [];
  task = {
    id: "task-example",
    workspaceId,
    name: "Example schedule",
    ownerSubjectId: "viewer",
    visibility: "workspace",
    runMode: "new_session_per_run",
    reusableSessionId: null,
    targetSessionId: null,
    schedule: { type: "manual" },
    overlapPolicy: "allow_concurrent",
    executionDigest: "0".repeat(64),
    rigId: null,
    metadata: {},
    agentConfig: {
      prompt: "Example message",
      resources: [],
      metadata: {},
      tools: [
        { kind: "mcp", id: "retained" },
        { kind: "mcp", id: "empty" },
      ],
      pinnedAccounts: [{ serverId: "retained", connectionId: "saved-account" }],
    },
  } as unknown as ScheduledTask;
  chats = [
    { id: "source-chat", title: "Source chat", tools: task.agentConfig.tools },
    {
      id: "destination-chat",
      title: "Destination chat",
      tools: [...task.agentConfig.tools, { kind: "mcp", id: "added" }],
    },
  ].map((chat) => ({
    ...chat,
    status: "idle",
    resources: [],
    firstPartyMcpTools: [],
    firstPartyMcpPermissions: [],
  })) as unknown as Session[];
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
async function render(mode?: ScheduleFormMode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ScheduleFormPage
        workspaceId={workspaceId}
        mode={mode ?? { kind: "edit", scheduleId: task.id }}
      />,
    );
    await flush();
  });
  await act(flush);
  return { container, root };
}
async function save(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>("[data-submit]")!;
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.click();
    await flush();
  });
  expect(updateScheduledTask).toHaveBeenCalledTimes(1);
  return updateScheduledTask.mock.calls[0]![2] as {
    pinnedAccounts?: unknown[];
    prompt?: string;
  };
}

function accountSwitches(container: HTMLElement, serverId: string) {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      `[aria-label="${serverId} accounts"] [role="switch"]`,
    ),
  ];
}

test("enabling a connector leaves it on current accounts and keeps the person's pins", async () => {
  const { container, root } = await render();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Add example connector")!
      .click();
    await flush();
  });
  expect(accountSwitches(container, "added")[0]?.getAttribute("aria-checked")).toBe("true");
  const request = await save(container);
  expect(request.pinnedAccounts).toBeUndefined();
  await act(async () => root.unmount());
});

test("an existing-chat schedule shows no account picker and saves no pins when retargeted", async () => {
  task = {
    ...task,
    runMode: "existing_session",
    targetSessionId: "source-chat",
  };
  task.agentConfig.tools = [];
  const { container, root } = await render();
  expect(container.querySelector('[aria-label="retained accounts"]')).toBeNull();
  const inherited = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Uses this chat’s settings"),
  )!;
  expect(inherited.getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    inherited.click();
    await flush();
  });
  expect(container.textContent).toContain("Changes apply to the chat and its automated runs.");
  expect(container.textContent).toContain("Open chat settings");
  const destination = [...container.querySelectorAll("select")].find(
    (select) => select.value === "source-chat",
  )!;
  await act(async () => {
    destination.value = "destination-chat";
    destination.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
  await act(flush);
  expect(container.querySelector('[aria-label="added accounts"]')).toBeNull();
  const request = await save(container);
  expect(request.pinnedAccounts).toBeUndefined();
  await act(async () => root.unmount());
});

test("an automation that continues a chat can steer its own running run", async () => {
  task = { ...task, runMode: "existing_session", targetSessionId: "source-chat" };
  task.agentConfig.tools = [];
  const { container, root } = await render();
  expect(container.textContent).toContain("Queue if still running");
  const choices = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const steer = choices.find((choice) => choice.textContent === "Steer")!;
  expect(choices.map((choice) => choice.textContent)).toEqual(
    expect.arrayContaining(["Queue", "Steer", "Skip"]),
  );
  await act(async () => {
    steer.click();
    await flush();
  });
  expect(steer.getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("The new run reaches the agent at its next step");
  expect(container.textContent).toContain("Steer if still running");
  const request = (await save(container)) as { overlapPolicy?: string };
  expect(request.overlapPolicy).toBe("steer");
  await act(async () => root.unmount());
});

test("an unpinned connector shows its current accounts and a message-only save sends no accounts", async () => {
  const { container, root } = await render();
  expect(container.textContent).not.toContain("If the previous run is still working");
  expect(accountSwitches(container, "empty")[0]?.getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain(
    "Pinned for retained. Other connectors use your current accounts each run.",
  );
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Edit example message")!
      .click();
    await flush();
  });
  const request = await save(container);
  expect(request.prompt).toBe("Updated example message");
  expect(request.pinnedAccounts).toBeUndefined();
  await act(async () => root.unmount());
});

test("picking accounts pins only the connector a person changed", async () => {
  const { container, root } = await render();
  await act(async () => {
    accountSwitches(container, "empty")[0]!.click();
    await flush();
  });
  // Unchecking the only account leaves nothing to pin: ask, never save no access.
  expect(container.querySelector<HTMLButtonElement>("[data-submit]")!.disabled).toBe(true);
  expect(container.querySelector("[data-disabled-reason]")!.textContent).toBe(
    "Pick an account for empty, or use your current accounts.",
  );
  await act(async () => {
    accountSwitches(container, "empty")[0]!.click();
    accountSwitches(container, "retained")[1]!.click();
    await flush();
  });
  const request = await save(container);
  expect(request.pinnedAccounts).toEqual([
    { serverId: "retained", connectionId: "saved-account" },
    { serverId: "retained", connectionId: "later-account" },
    { serverId: "empty", connectionId: "empty-account" },
  ]);
  await act(async () => root.unmount());
});

test("using current accounts clears every pin", async () => {
  const { container, root } = await render();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use current accounts")!
      .click();
    await flush();
  });
  expect(container.textContent).toContain(
    "Each run uses your current accounts. Changing one here pins it.",
  );
  const request = await save(container);
  expect(request.pinnedAccounts).toEqual([]);
  await act(async () => root.unmount());
});

test("an unavailable pinned account stays unresolved until explicitly removed", async () => {
  task.agentConfig.pinnedAccounts = [{ serverId: "retained", connectionId: "missing-account" }];
  const { container, root } = await render();
  await act(async () => {
    accountSwitches(container, "retained")[0]!.click();
    await flush();
  });
  expect(container.querySelector<HTMLButtonElement>("[data-submit]")!.disabled).toBe(true);
  expect(updateScheduledTask).not.toHaveBeenCalled();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Remove disconnected account")!
      .click();
    await flush();
  });
  const request = await save(container);
  expect(request.pinnedAccounts).toEqual([{ serverId: "retained", connectionId: "saved-account" }]);
  await act(async () => root.unmount());
});

function audienceOption(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (option) => option.textContent === label,
  );
}

test("who can see an automation is only asked when the organization allows Only me", async () => {
  const hidden = await render();
  expect(hidden.container.textContent).not.toContain("Who can see it");
  await act(async () => hidden.root.unmount());

  privateAllowed = true;
  const { container, root } = await render();
  expect(container.textContent).toContain("Who can see it");
  expect(audienceOption(container, "Workspace")!.getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain(
    "Everyone in this workspace can see this automation and its chats.",
  );
  await act(async () => {
    audienceOption(container, "Only me")!.click();
    await flush();
  });
  expect(container.textContent).toContain("Only you can see this automation and its chats.");
  const request = (await save(container)) as { visibility?: string };
  expect(request.visibility).toBe("private");
  await act(async () => root.unmount());
});

test("a schedule that posts into an Only me chat stays Only me", async () => {
  privateAllowed = true;
  task = {
    ...task,
    visibility: "private",
    runMode: "existing_session",
    targetSessionId: "source-chat",
  } as ScheduledTask;
  chats = chats.map((chat) =>
    chat.id === "source-chat"
      ? ({ ...chat, tenancy: { visibility: "private" } } as unknown as Session)
      : chat,
  );
  const { container, root } = await render();
  expect(audienceOption(container, "Only me")!.getAttribute("aria-checked")).toBe("true");
  expect(audienceOption(container, "Workspace")!.getAttribute("aria-disabled")).toBe("true");
  expect(container.textContent).toContain("It posts into an Only me chat.");
  await act(async () => root.unmount());
});

test("a schedule on your own machine can be shared; it runs as you", async () => {
  privateAllowed = true;
  machines = [
    {
      kind: "selfhosted",
      isSessionGroup: false,
      scope: "user",
      sandboxId: "my-laptop",
      name: "My laptop",
      state: "online",
    },
  ];
  task = {
    ...task,
    visibility: "private",
    agentConfig: {
      ...task.agentConfig,
      machineTarget: { targetSandboxId: "my-laptop" },
    },
  } as ScheduledTask;
  const { container, root } = await render();
  expect(audienceOption(container, "Only me")!.getAttribute("aria-checked")).toBe("true");
  expect(audienceOption(container, "Workspace")!.getAttribute("aria-disabled")).not.toBe("true");
  expect(container.textContent).not.toContain("It runs on your own machine");
  expect(container.textContent).toContain("My laptop");
  await act(async () => {
    audienceOption(container, "Workspace")!.click();
    await flush();
  });
  const request = (await save(container)) as { visibility?: string };
  expect(request.visibility).toBe("workspace");
  await act(async () => root.unmount());
});

test("a new schedule starts with the organization's default audience; an existing one keeps its own", async () => {
  privateAllowed = true;
  defaultVisibility = "private";
  const created = await render({ kind: "create" });
  expect(audienceOption(created.container, "Only me")!.getAttribute("aria-checked")).toBe("true");
  // Picking Workspace sticks.
  await act(async () => {
    audienceOption(created.container, "Workspace")!.click();
    await flush();
  });
  expect(audienceOption(created.container, "Workspace")!.getAttribute("aria-checked")).toBe("true");
  await act(async () => created.root.unmount());

  const edited = await render();
  expect(audienceOption(edited.container, "Workspace")!.getAttribute("aria-checked")).toBe("true");
  await act(async () => edited.root.unmount());
});

const AGENT = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_AGENT = "aaaaaaaa-0000-4000-8000-000000000002";

test("an automation's agent changes in the agent picker and is saved with it", async () => {
  task.agentConfig = { ...task.agentConfig, agentId: AGENT };
  const { container, root } = await render();
  const chip = container.querySelector<HTMLButtonElement>("[data-composer-agent]")!;
  expect(chip.textContent).toContain("Triage");
  await act(async () => {
    chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    await flush();
  });
  const reviewer = [...document.body.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (item) => item.textContent?.includes("Reviewer"),
  )!;
  await act(async () => {
    reviewer.click();
    await flush();
  });
  expect(chip.textContent).toContain("Reviewer");
  const request = (await save(container)) as { agentConfig?: { agentId?: string } };
  expect(request.agentConfig?.agentId).toBe(OTHER_AGENT);
  await act(async () => root.unmount());
});

test("an agent's automation can use its own chat or one of the agent's chats", async () => {
  task = { ...task, runMode: "existing_session", targetSessionId: "source-chat" };
  task.agentConfig = { ...task.agentConfig, agentId: AGENT, tools: [], pinnedAccounts: [] };
  chats = chats.map((chat) => (chat.id === "source-chat" ? { ...chat, agentId: AGENT } : chat));
  const { container, root } = await render();
  const option = (label: string) =>
    [...container.querySelectorAll("option")].find((entry) => entry.textContent === label);
  // Both chat choices are open to an agent's automation.
  expect(option("Use an existing chat")!.dataset.locked).toBeUndefined();
  expect(option("Create a chat for this automation")!.dataset.locked).toBeUndefined();
  // Only the agent's chats are offered.
  expect(option("Source chat")!.dataset.locked).toBeUndefined();
  expect(option("Destination chat")).toBeUndefined();
  await act(async () => root.unmount());
});

test("an agent's automation offers the agent's other chats", async () => {
  task = { ...task, runMode: "existing_session", targetSessionId: "source-chat" };
  task.agentConfig = { ...task.agentConfig, agentId: AGENT, tools: [], pinnedAccounts: [] };
  chats = [
    ...chats.map((chat) => (chat.id === "source-chat" ? { ...chat, agentId: AGENT } : chat)),
    { ...chats[0]!, id: "older-agent-chat", title: "Older agent chat", agentId: AGENT },
  ];
  const { container, root } = await render();
  const option = (label: string) =>
    [...container.querySelectorAll("option")].find((entry) => entry.textContent === label);
  // The agent's other chats come from the server's agent filter.
  expect(option("Older agent chat")!.dataset.locked).toBeUndefined();
  expect(option("Destination chat")).toBeUndefined();
  await act(async () => root.unmount());
});

test("another agent for an existing-chat automation asks for one of its chats, in place", async () => {
  task = { ...task, runMode: "existing_session", targetSessionId: "source-chat" };
  task.agentConfig = { ...task.agentConfig, agentId: AGENT, tools: [], pinnedAccounts: [] };
  chats = chats.map((chat) => (chat.id === "source-chat" ? { ...chat, agentId: AGENT } : chat));
  const { container, root } = await render();
  const chip = container.querySelector<HTMLButtonElement>("[data-composer-agent]")!;
  await act(async () => {
    chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    await flush();
  });
  const items = [...document.body.querySelectorAll<HTMLElement>("[role='menuitem']")];
  // Every agent is listed here; nothing navigates away from the draft.
  expect(items.some((item) => item.textContent?.includes("Browse agents"))).toBe(false);
  await act(async () => {
    items.find((item) => item.textContent?.includes("Reviewer"))!.click();
    await flush();
  });
  const selected = [...container.querySelectorAll<HTMLOptionElement>("option")].find(
    (entry) => entry.textContent === "Source chat",
  );
  // Triage's chat can't be Reviewer's, so it is no longer chosen.
  expect(selected?.selected).not.toBe(true);
  await act(async () => root.unmount());
});

test("an agent's automation aimed at another chat says it isn't the agent's", async () => {
  task = { ...task, runMode: "existing_session", targetSessionId: "destination-chat" };
  task.agentConfig = { ...task.agentConfig, agentId: AGENT, tools: [], pinnedAccounts: [] };
  chats = chats.map((chat) => (chat.id === "source-chat" ? { ...chat, agentId: AGENT } : chat));
  const { container, root } = await render();
  const option = (label: string) =>
    [...container.querySelectorAll("option")].find((entry) => entry.textContent === label);
  expect(option("Destination chat")!.dataset.locked).toBe("Not a chat with this agent.");
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-submit]")!.click();
    await flush();
  });
  expect(updateScheduledTask).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Not a chat with this agent.");
  await act(async () => root.unmount());
});

test("an agent's chats that can't be read show an error, not an empty list", async () => {
  task = { ...task, runMode: "existing_session", targetSessionId: "source-chat" };
  task.agentConfig = { ...task.agentConfig, agentId: AGENT, tools: [], pinnedAccounts: [] };
  const listAgentChats = client.listAgentChats;
  client.listAgentChats = async () => {
    throw Object.assign(new Error("Opengeni API 500: down"), { status: 500 });
  };
  try {
    const { container, root } = await render();
    expect(container.textContent).toContain("Chats couldn't load");
    await act(async () => root.unmount());
  } finally {
    client.listAgentChats = listAgentChats;
  }
});

test("Add trigger's note and chat choice start the full form", async () => {
  chats = chats.map((chat) => (chat.id === "source-chat" ? { ...chat, agentId: AGENT } : chat));
  const { container, root } = await render({
    kind: "create",
    agentId: AGENT,
    returnTo: "agent",
    agentTriggerStart: {
      note: "Label it and reply",
      chat: { mode: "existing_session", sessionId: "source-chat" },
    },
  });
  // Add trigger's note and chat choice carry into the full form.
  expect(container.querySelector("textarea")!.value).toBe("Label it and reply");
  const selected = (label: string) =>
    [...container.querySelectorAll<HTMLOptionElement>("option")].find(
      (entry) => entry.textContent === label,
    )?.selected;
  expect(selected("Use an existing chat")).toBe(true);
  expect(selected("Source chat")).toBe(true);
  await act(async () => root.unmount());
});

test("an agent's own chat says when a change of agent started a new one", async () => {
  task = {
    ...task,
    runMode: "reusable_session",
    reusableSessionId: null,
    metadata: {
      _opengeniAgentChatChange: { sessionId: "source-chat", agentId: null, changedAt: "now" },
    },
  };
  task.agentConfig = { ...task.agentConfig, agentId: AGENT };
  const { container, root } = await render();
  expect(container.textContent).toContain("Its agent changed, so it has a new chat.");
  expect(container.textContent).toContain("Previous chat");
  await act(async () => root.unmount());
});

test("a new automation opened from an agent's page goes back there on Cancel and Save", async () => {
  const { scheduleFormReturnAgent } = await import("./schedule-form-page");
  expect(
    scheduleFormReturnAgent({ kind: "create", agentId: "agent-example", returnTo: "agent" }),
  ).toBe("agent-example");
  expect(scheduleFormReturnAgent({ kind: "create", agentId: "agent-example" })).toBeUndefined();
  expect(scheduleFormReturnAgent({ kind: "create", returnTo: "agent" })).toBeUndefined();
  expect(scheduleFormReturnAgent({ kind: "edit", scheduleId: "task-example" })).toBeUndefined();
});
