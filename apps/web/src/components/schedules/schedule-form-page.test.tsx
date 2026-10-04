import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ScheduledTask, Session } from "@/types";
import type { ReactNode } from "react";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const selectMenu = await import("@/components/ui/select-menu");

const workspaceId = "workspace-example";
let task: ScheduledTask;
let chats: Session[];
let pendingAccountBaseline: Promise<Session> | null = null;
let sourceReads = 0;
const updateScheduledTask = mock(
  async (_workspace: string, _id: string, _request: unknown) => task,
);
const client = {
  getScheduledTask: async () => task,
  updateScheduledTask,
  getSession: async (_workspace: string, id: string) => {
    if (id === "source-chat" && ++sourceReads === 2 && pendingAccountBaseline)
      return pendingAccountBaseline;
    return chats.find((chat) => chat.id === id)!;
  },
  listSessions: async () => chats,
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
    ].map((connection) => ({ ...connection, status: "active", subjectId: null, metadata: {} })),
};
const context = {
  client,
  clientConfig: { mcpServers: [], defaultSandboxBackend: "none" },
  workspaces: [],
  managedSelfContext: null,
  model: "example-model",
  reasoningEffort: "high",
  selectedCapabilityToolIds: new Set<string>(),
  workspaceCapabilityCatalog: ["retained", "empty", "added"].map((id) => ({
    name: id,
    enabled: true,
    runtime: { mcpServerId: id },
    connectionRef: { providerDomain: `${id}.example.test` },
  })),
  accessContext: { workspaceGrants: [{ workspaceId, permissions: ["connections:read"] }] },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
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
mock.module("@/lib/use-workspace-machines", () => ({
  useWorkspaceMachines: () => ({ machines: [], loading: false }),
}));
mock.module("@/lib/use-workspace-model-catalog", () => ({
  useWorkspaceModelCatalog: () => ({ defaultSelection: null, rows: [], loading: false }),
}));
mock.module("@/components/knowledge/agent-learning-settings", () => ({
  AgentLearningDraftEditor: () => null,
}));
mock.module("./schedule-agent-capabilities", () => ({ ScheduleAgentCapabilities: () => null }));
mock.module("@/components/schedule-slack-posting", () => ({ ScheduleSlackPosting: () => null }));
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
mock.module("@/components/ui/form-dialog", () => ({
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
mock.module("@/components/ui/select-menu", () => ({
  ...selectMenu,
  SelectMenu: ({
    value,
    options,
    onValueChange,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
const { ScheduleFormPage } = await import("./schedule-form-page");

beforeEach(() => {
  document.body.replaceChildren();
  updateScheduledTask.mockClear();
  pendingAccountBaseline = null;
  sourceReads = 0;
  task = {
    id: "task-example",
    workspaceId,
    name: "Example schedule",
    ownerSubjectId: "viewer",
    runMode: "new_session_per_run",
    reusableSessionId: null,
    targetSessionId: null,
    schedule: { type: "manual" },
    overlapPolicy: "allow_concurrent",
    executionDigest: "0".repeat(64),
    variableSetId: null,
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
      connectionAccounts: [{ serverId: "retained", connectionId: "saved-account" }],
      connectionAccountsFrozen: true,
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
async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ScheduleFormPage workspaceId={workspaceId} mode={{ kind: "edit", scheduleId: task.id }} />,
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
    connectionAccounts?: unknown[];
    prompt?: string;
  };
}

test("enabling a connector saves its displayed defaults without changing retained or empty account groups", async () => {
  const { container, root } = await render();
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Add example connector")!
      .click();
    await flush();
  });
  const request = await save(container);
  expect(request.connectionAccounts).toEqual([
    { serverId: "retained", connectionId: "saved-account" },
    { serverId: "added", connectionId: "new-account" },
  ]);
  await act(async () => root.unmount());
});

test("retargeting a bound schedule saves newly applicable accounts while preserving its saved subset", async () => {
  task = { ...task, runMode: "existing_session", targetSessionId: "source-chat" };
  task.agentConfig.tools = [];
  const { container, root } = await render();
  const destination = [...container.querySelectorAll("select")].find(
    (select) => select.value === "source-chat",
  )!;
  await act(async () => {
    destination.value = "destination-chat";
    destination.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
  await act(flush);
  const request = await save(container);
  expect(request.connectionAccounts).toEqual([
    { serverId: "retained", connectionId: "saved-account" },
    { serverId: "added", connectionId: "new-account" },
  ]);
  await act(async () => root.unmount());
});

test("a saved empty account group stays unchecked and a message-only save leaves accounts omitted", async () => {
  const { container, root } = await render();
  const empty = container.querySelector('[aria-label="empty accounts"]')!;
  expect(empty.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Edit example message")!
      .click();
    await flush();
  });
  const request = await save(container);
  expect(request.prompt).toBe("Updated example message");
  expect(request.connectionAccounts).toBeUndefined();
  await act(async () => root.unmount());
});

test("explicitly deselecting the last account saves no access for an already-frozen schedule", async () => {
  const { container, root } = await render();
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="retained accounts"] [role="switch"]')!
      .click();
    await flush();
  });
  const group = container.querySelector('[aria-label="retained accounts"]')!;
  expect(group.querySelector('[role="status"]')?.textContent).toBe(
    "No account access when this schedule runs.",
  );
  expect(group.querySelectorAll('[role="status"]')).toHaveLength(1);
  const request = await save(container);
  expect(request.connectionAccounts).toEqual([]);
  await act(async () => root.unmount());
});

test("an inherited legacy schedule requiring accounts never suggests its hidden remove-connector control", async () => {
  task = { ...task, runMode: "existing_session", targetSessionId: "source-chat" };
  task.agentConfig.tools = [];
  delete task.agentConfig.connectionAccountsFrozen;
  const { container, root } = await render();
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="retained accounts"] [role="switch"]')!
      .click();
    await flush();
  });
  expect(container.querySelector<HTMLButtonElement>("[data-submit]")!.disabled).toBe(true);
  const reason = container.querySelector("[data-disabled-reason]")!.textContent;
  expect(reason).toBe("Pick an account for retained.");
  expect(reason).not.toContain("remove the connector");
  expect(updateScheduledTask).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("an unavailable saved account stays unresolved until explicitly removed", async () => {
  task.agentConfig.connectionAccounts = [{ serverId: "retained", connectionId: "missing-account" }];
  const { container, root } = await render();
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="retained accounts"] [role="switch"]')!
      .click();
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
  expect(request.connectionAccounts).toEqual([
    { serverId: "retained", connectionId: "saved-account" },
  ]);
  await act(async () => root.unmount());
});

test("choosing an account while the original chat loads does not freeze another group's temporary choice", async () => {
  task = { ...task, runMode: "existing_session", targetSessionId: "source-chat" };
  task.agentConfig.tools = [];
  let resolveBaseline!: (session: Session) => void;
  pendingAccountBaseline = new Promise((resolve) => {
    resolveBaseline = resolve;
  });
  const { container, root } = await render();
  const destination = [...container.querySelectorAll("select")].find(
    (select) => select.value === "source-chat",
  )!;
  await act(async () => {
    destination.value = "destination-chat";
    destination.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
  await act(flush);
  await act(async () => {
    container
      .querySelectorAll<HTMLButtonElement>('[aria-label="retained accounts"] [role="switch"]')[1]!
      .click();
    await flush();
  });
  await act(async () => {
    resolveBaseline(chats[0]!);
    await flush();
  });
  expect(
    container
      .querySelector('[aria-label="added accounts"] [role="switch"]')
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    container
      .querySelector('[aria-label="empty accounts"] [role="switch"]')
      ?.getAttribute("aria-checked"),
  ).toBe("false");
  const request = await save(container);
  expect(request.connectionAccounts).toEqual([
    { serverId: "retained", connectionId: "saved-account" },
    { serverId: "retained", connectionId: "later-account" },
    { serverId: "added", connectionId: "new-account" },
  ]);
  await act(async () => root.unmount());
});
