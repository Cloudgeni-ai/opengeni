import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import type {
  CreateAutomationTemplateRequest,
  CreateEventSourceRequest,
  EventSource,
  EventTypeDescriptor,
  OpenGeniClient,
  ScheduledTask,
  ScheduledTaskRun,
  WorkspaceAutomationTemplate,
} from "@opengeni/sdk";

import {
  actRun,
  flush,
  registerDom,
  renderComponent,
  withVirtualClock,
  type RenderedComponent,
} from "./render-hook";

registerDom();
// Imported after the DOM exists: Radix decides at load whether layout effects run.
const selectMenu = await import("../src/ui/select-menu");

// Popover menus need layout the test DOM lacks; plain option lists stand in,
// and `pick` chooses by the menu's label.
const menus = new Map<string, (value: string) => void>();
mock.module("../src/ui/select-menu", () => {
  const OptionList = ({
    options,
    onValueChange,
    "aria-label": ariaLabel,
  }: {
    options: ReadonlyArray<{ value: string; label: string }>;
    onValueChange?: (value: string) => void;
    "aria-label"?: string;
  }) => {
    if (ariaLabel && onValueChange) menus.set(ariaLabel, onValueChange);
    return (
      <ul aria-label={ariaLabel}>
        {options.map((option) => (
          <li key={option.value} data-value={option.value}>
            {option.label}
          </li>
        ))}
      </ul>
    );
  };
  return { ...selectMenu, SelectMenu: OptionList, ComboboxSelect: OptionList };
});
const { AutomationsPanel, builtinAutomationTemplates } = await import("../src/automations");
const { OpenGeniMessagesProvider, createOpenGeniText } = await import("../src/messages/runtime");
const { PortalContainerProvider } = await import("../src/ui/portal-container");

const WORKSPACE_ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const SESSION_ID = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SOURCE_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const WORKSPACE_SOURCE_ID = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const TIMESTAMP = "2026-10-21T10:00:00.000Z";

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    workspaceId: WORKSPACE_ID,
    name: "Morning digest",
    status: "active",
    schedule: { type: "manual" },
    events: null,
    runMode: "existing_session",
    targetSessionId: SESSION_ID,
    executionDigest: "0".repeat(64),
    agentConfig: { prompt: "Summarize yesterday's orders.", resources: [], metadata: {} },
    action: { kind: "agent" },
    updatedAt: TIMESTAMP,
    ...overrides,
  } as unknown as ScheduledTask;
}

const mcpSource: EventSource = {
  id: SOURCE_ID,
  workspaceId: WORKSPACE_ID,
  kind: "mcp",
  adapter: null,
  name: "Orders",
  ownerSubjectId: "viewer",
  visibility: "private",
  status: "active",
  statusReason: null,
  statusReasonCode: null,
  statusReasonDetail: null,
  webhookUrl: null,
  awaitingSigningSecret: false,
  mcp: { serverId: "orders-mcp", connectionId: null },
  lastDeliveryAt: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const orderCreated: EventTypeDescriptor = {
  type: "order.created",
  description: "A new order",
  fields: [],
  argumentsSchema: {
    type: "object",
    properties: { projectId: { type: "string", format: "uuid" } },
    required: ["projectId"],
  },
  available: true,
  unavailableReason: null,
  unavailableReasonCode: null,
  unavailableReasonDetail: null,
};

const workspaceSource: EventSource = {
  ...mcpSource,
  id: WORKSPACE_SOURCE_ID,
  kind: "workspace",
  name: "This workspace",
  mcp: null,
};

const transcriptReady: EventTypeDescriptor = {
  type: "recording.transcript.ready",
  description: "A recording's transcript is ready",
  fields: [],
  argumentsSchema: null,
  available: true,
  unavailableReason: null,
  unavailableReasonCode: null,
  unavailableReasonDetail: null,
};

const builtin = builtinAutomationTemplates(createOpenGeniText());
const meetingNotes = builtin.find((template) => template.id === "meeting-notes")!;
const morningBrief = builtin.find((template) => template.id === "morning-brief")!;

function savedTemplate(
  overrides: Partial<WorkspaceAutomationTemplate> = {},
): WorkspaceAutomationTemplate {
  return {
    id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
    workspaceId: WORKSPACE_ID,
    name: "Order digest",
    description: "What sold yesterday.",
    instructions: "Summarize yesterday's orders.",
    schedule: null,
    triggers: [],
    maxRunsPerHour: null,
    createdBySubjectId: "viewer",
    viewerAccess: "manage",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("Not found"), { status: 404 });
}

function run(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  return {
    id: "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b",
    workspaceId: WORKSPACE_ID,
    taskId: task().id,
    status: "dispatched",
    triggerType: "manual",
    scheduledAt: null,
    firedAt: TIMESTAMP,
    sessionId: SESSION_ID,
    triggerEventId: null,
    error: null,
    ...overrides,
  } as unknown as ScheduledTaskRun;
}

function fakeClient(
  options: {
    tasks?: ScheduledTask[];
    sources?: EventSource[] | "off";
    templates?: WorkspaceAutomationTemplate[] | "off";
  } = {},
) {
  const tasks = options.tasks ?? [];
  const client = {
    listScheduledTasks: mock(async () => tasks),
    listEventSources: mock(async () => {
      if (options.sources === "off") throw notFound();
      return options.sources ?? [];
    }),
    createEventSource: mock(async (_workspaceId: string, request: CreateEventSourceRequest) => ({
      source: request.kind === "workspace" ? workspaceSource : mcpSource,
    })),
    listEventSourceTypes: mock(async (_workspaceId: string, sourceId: string) =>
      sourceId === WORKSPACE_SOURCE_ID ? [transcriptReady] : [orderCreated],
    ),
    createScheduledTask: mock(async (_workspaceId: string, request: Record<string, unknown>) =>
      task({ id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", name: String(request.name) }),
    ),
    updateScheduledTask: mock(async () => task()),
    pauseScheduledTask: mock(async () => task({ status: "paused" })),
    resumeScheduledTask: mock(async () => task()),
    triggerScheduledTask: mock(async () => task({ updatedAt: "2026-10-21T10:05:00.000Z" })),
    deleteScheduledTask: mock(async () => undefined),
    listScheduledTaskRuns: mock(async (): Promise<ScheduledTaskRun[]> => []),
    listAutomationTemplates: mock(async () => {
      if (options.templates === "off") throw notFound();
      return options.templates ?? [];
    }),
    createAutomationTemplate: mock(
      async (_workspaceId: string, request: CreateAutomationTemplateRequest) =>
        savedTemplate({
          id: "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c",
          name: request.name,
          description: request.description ?? "",
          instructions: request.instructions,
        }),
    ),
    updateAutomationTemplate: mock(async () => savedTemplate()),
    deleteAutomationTemplate: mock(async () => undefined),
  };
  return client;
}

let rendered: RenderedComponent | null = null;
beforeEach(() => document.body.replaceChildren());
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
});

async function render(client: ReturnType<typeof fakeClient>, props: Record<string, unknown> = {}) {
  rendered = await renderComponent(
    <AutomationsPanel
      client={client as unknown as OpenGeniClient}
      workspaceId={WORKSPACE_ID}
      {...props}
    />,
  );
  await flush();
  return rendered.container;
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

async function click(element: HTMLElement) {
  await actRun(() => element.click());
  await flush();
}

/** Types into a text area: sets its value and calls React's change handler. */
async function change(element: HTMLTextAreaElement, value: string) {
  await actRun(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      element,
      value,
    );
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const props = (element as unknown as Record<string, { onChange?: (event: unknown) => void }>)[
      propsKey ?? ""
    ];
    if (!props?.onChange) throw new Error("No React change handler");
    props.onChange({ target: element, currentTarget: element });
  });
  await flush();
}

async function pick(menu: string, value: string) {
  const choose = menus.get(menu);
  if (!choose) throw new Error(`No menu "${menu}"`);
  await actRun(() => choose(value));
  await flush();
}

test("lists a chat's automations and turns one off", async () => {
  const client = fakeClient({ tasks: [task()] });
  const container = await render(client, { sessionId: SESSION_ID });
  expect(client.listScheduledTasks).toHaveBeenCalledWith(WORKSPACE_ID, { sessionId: SESSION_ID });
  expect(container.textContent).toContain("Morning digest");
  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Morning digest is on"]',
  );
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  await click(toggle!);
  expect(client.pauseScheduledTask).toHaveBeenCalledWith(WORKSPACE_ID, task().id);
  expect(container.textContent).toContain("Paused");
});

test("leaves knowledge syncs out of the list", async () => {
  const client = fakeClient({
    tasks: [
      task(),
      task({ id: "sync", name: "Docs sync", action: { kind: "knowledge_source_sync" } as never }),
    ],
  });
  const container = await render(client);
  expect(container.textContent).toContain("Morning digest");
  expect(container.textContent).not.toContain("Docs sync");
});

test("runs one now from its page and says so", async () => {
  const client = fakeClient({ tasks: [task()] });
  const container = await render(client, { sessionId: SESSION_ID });
  await click(container.querySelector<HTMLButtonElement>("[data-row-action]")!);
  await click(button(container, "Run now"));
  expect(client.triggerScheduledTask).toHaveBeenCalledTimes(1);
  const [, taskId, request] = client.triggerScheduledTask.mock.calls[0] as unknown as [
    string,
    string,
    { triggerId?: string },
  ];
  expect(taskId).toBe(task().id);
  expect(request.triggerId).toMatch(/^[0-9a-f-]{36}$/);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Morning digest");
  expect(client.listScheduledTaskRuns).toHaveBeenCalledWith(WORKSPACE_ID, task().id, { limit: 10 });
});

function recentRuns(container: ParentNode): string {
  return container.querySelector('section[aria-labelledby$="-runs"]')?.textContent ?? "";
}

test("a run started with Run now shows up in recent runs without leaving the page", async () =>
  await withVirtualClock(async () => {
    const client = fakeClient({ tasks: [task()] });
    // The run starts in the background, so the first reads don't have it yet.
    const reads: ScheduledTaskRun[][] = [[], []];
    client.listScheduledTaskRuns.mockImplementation(async () => reads.shift() ?? [run()]);
    const container = await render(client, { sessionId: SESSION_ID });
    await click(container.querySelector<HTMLButtonElement>("[data-row-action]")!);
    expect(recentRuns(container)).toContain("No runs yet.");
    await click(button(container, "Run now"));
    expect(recentRuns(container)).toContain("No runs yet.");
    await flush(1_500);
    expect(recentRuns(container)).toContain("Started");
    // Found it: no more reads.
    const readsSoFar = client.listScheduledTaskRuns.mock.calls.length;
    await flush(30_000);
    expect(client.listScheduledTaskRuns.mock.calls.length).toBe(readsSoFar);
  }));

test("a queued run's status keeps up while its automation is open", async () =>
  await withVirtualClock(async () => {
    const client = fakeClient({ tasks: [task()] });
    const reads: ScheduledTaskRun[][] = [[run({ status: "queued", sessionId: null })]];
    client.listScheduledTaskRuns.mockImplementation(async () => reads.shift() ?? [run()]);
    const container = await render(client, { sessionId: SESSION_ID });
    await click(container.querySelector<HTMLButtonElement>("[data-row-action]")!);
    expect(recentRuns(container)).toContain("Queued");
    await flush(5_000);
    expect(recentRuns(container)).toContain("Started");
    expect(recentRuns(container)).not.toContain("Queued");
    // Nothing is waiting any more: the list stops reading.
    const readsSoFar = client.listScheduledTaskRuns.mock.calls.length;
    await flush(30_000);
    expect(client.listScheduledTaskRuns.mock.calls.length).toBe(readsSoFar);
  }));

test("a failed or skipped run says why in words, never as its code", async () => {
  const client = fakeClient({ tasks: [task()] });
  client.listScheduledTaskRuns.mockImplementation(async () => [
    run({ status: "failed", error: "scheduled_turn_failed" }),
    run({
      id: "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c",
      status: "skipped",
      error: "scheduled_session_not_idle",
    }),
  ]);
  const container = await render(client, { sessionId: SESSION_ID });
  await click(container.querySelector<HTMLButtonElement>("[data-row-action]")!);
  const runs = recentRuns(container);
  expect(runs).toContain("The agent ran into an error.");
  expect(runs).toContain("Skipped because the chat was still busy with earlier work.");
  expect(runs).not.toContain("scheduled_");
});

test("a new automation in a chat continues it, on the default schedule when events are off", async () => {
  const client = fakeClient({ sources: "off" });
  const container = await render(client, { sessionId: SESSION_ID });
  expect(container.textContent).toContain("Nothing picks this chat up again yet.");
  await click(button(container, "New automation"));
  expect(container.textContent).not.toContain("Add an event");
  await change(container.querySelector("textarea")!, "Check the orders and tell me what changed.");
  await click(button(container, "Create automation"));
  expect(client.createScheduledTask).toHaveBeenCalledTimes(1);
  const [, request] = client.createScheduledTask.mock.calls[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(request).toMatchObject({
    name: "Check the orders and tell me what changed",
    prompt: "Check the orders and tell me what changed.",
    targetSessionId: SESSION_ID,
    schedule: { type: "calendar" },
  });
  expect(request).not.toHaveProperty("events");
  expect(container.textContent).toContain("Continues this chat.");
});

test("an empty form says what is missing and saves nothing", async () => {
  const client = fakeClient({ sources: "off" });
  const container = await render(client);
  await click(button(container, "New automation"));
  await click(button(container, "Create automation"));
  expect(container.textContent).toContain("Describe what the agent should do on each run.");
  expect(client.createScheduledTask).not.toHaveBeenCalled();
});

test("the host's MCP server is offered before its source exists, and saving adds it once", async () => {
  const client = fakeClient({ sources: [] });
  const container = await render(client, {
    sessionId: SESSION_ID,
    eventServers: [{ serverId: "orders-mcp", name: "Orders" }],
    argumentDefaults: { projectId: "3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f" },
  });
  await click(button(container, "New automation"));
  await click(button(container, "Add an event"));
  await flush();
  expect(client.createEventSource).toHaveBeenCalledTimes(1);
  expect(client.createEventSource).toHaveBeenCalledWith(WORKSPACE_ID, {
    kind: "mcp",
    serverId: "orders-mcp",
    name: "Orders",
  });
  expect(client.listEventSourceTypes).toHaveBeenCalledWith(WORKSPACE_ID, SOURCE_ID);
  expect(
    container.querySelector('[aria-label="Choose an event"] [data-value="order.created"]'),
  ).not.toBeNull();
  await pick("Choose an event", "order.created");
  await change(container.querySelector("textarea")!, "Tell me about each new order.");
  await click(button(container, "Create automation"));
  expect(client.createEventSource).toHaveBeenCalledTimes(1);
  const [, request] = client.createScheduledTask.mock.calls[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(request).toMatchObject({
    targetSessionId: SESSION_ID,
    schedule: { type: "manual" },
    events: {
      triggers: [
        {
          sourceId: SOURCE_ID,
          eventTypes: ["order.created"],
          arguments: { projectId: "3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f" },
        },
      ],
    },
  });
});

test("a failed load offers to try again", async () => {
  const client = fakeClient();
  client.listScheduledTasks.mockImplementationOnce(async () => {
    throw new Error("down");
  });
  const container = await render(client);
  expect(container.textContent).toContain("Couldn't load automations");
  await click(button(container, "Try again"));
  expect(client.listScheduledTasks).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("No automations yet.");
});

test("it is a styled root of its own, and its delete confirmation opens in a styled layer", async () => {
  const client = fakeClient({ tasks: [task()] });
  const container = await render(client, { sessionId: SESSION_ID });
  expect(container.querySelector("section")?.classList.contains("og-root")).toBe(true);
  await click(container.querySelector<HTMLButtonElement>("[data-row-action]")!);
  await click(button(container, "Delete"));
  // A host's dialog would clip or unstyle it: it opens under <body>, in the panel's own layer.
  const layer = document.body.querySelector<HTMLElement>(":scope > [data-og-overlays]");
  expect(layer?.classList.contains("og-root")).toBe(true);
  const dialog = layer?.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog?.textContent).toContain("Delete “Morning digest”?");
  expect(container.contains(dialog ?? null)).toBe(false);
  await click(button(dialog!, "Delete automation"));
  expect(client.deleteScheduledTask).toHaveBeenCalledWith(WORKSPACE_ID, task().id);
  expect(container.textContent).toContain("Nothing picks this chat up again yet.");
});

test("in an app with its own overlay container, the panel's overlays open there", async () => {
  const client = fakeClient({ tasks: [task()] });
  const appRoot = document.createElement("div");
  document.body.append(appRoot);
  rendered = await renderComponent(
    <PortalContainerProvider container={appRoot}>
      <AutomationsPanel
        client={client as unknown as OpenGeniClient}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
      />
    </PortalContainerProvider>,
  );
  await flush();
  const { container } = rendered;
  await click(container.querySelector<HTMLButtonElement>("[data-row-action]")!);
  await click(button(container, "Delete"));
  expect(document.body.querySelector("[data-og-overlays]")).toBeNull();
  expect(appRoot.querySelector('[role="dialog"]')?.textContent).toContain(
    "Delete “Morning digest”?",
  );
});

test("the loading note is in the host's language", async () => {
  const client = fakeClient();
  client.listScheduledTasks.mockImplementation(() => new Promise<ScheduledTask[]>(() => {}));
  rendered = await renderComponent(
    <OpenGeniMessagesProvider
      locale="nb"
      messages={{ "list.loading": "Laster {label}", "automations.panel.list": "Automatiseringer" }}
    >
      <AutomationsPanel client={client as unknown as OpenGeniClient} workspaceId={WORKSPACE_ID} />
    </OpenGeniMessagesProvider>,
  );
  await flush();
  const notes = [...rendered.container.querySelectorAll('[role="status"]')].map(
    (note) => note.textContent,
  );
  expect(notes).toContain("Laster automatiseringer");
});

/** A row's own action, by its title. */
function row(container: ParentNode, title: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>("[data-row-action]")].find(
    (candidate) => candidate.textContent?.trim() === title,
  );
  if (!found) throw new Error(`No row "${title}"`);
  return found;
}

test("Meeting notes starts from its template on this workspace's events, adding that source once", async () => {
  const client = fakeClient({ sources: [] });
  const container = await render(client, {
    sessionId: SESSION_ID,
    templates: builtin,
    workspaceEvents: true,
  });
  await click(button(container, "New automation"));
  expect(container.textContent).toContain("Start from scratch");
  expect(container.textContent).toContain("When a meeting's transcript is ready");
  await click(row(container, "Meeting notes"));
  // The form opens filled in; picking its source to read its events adds it.
  expect(container.querySelector("textarea")?.value).toBe(meetingNotes.instructions);
  expect(client.createEventSource).toHaveBeenCalledTimes(1);
  expect(client.createEventSource).toHaveBeenCalledWith(WORKSPACE_ID, { kind: "workspace" });
  expect(client.listEventSourceTypes).toHaveBeenCalledWith(WORKSPACE_ID, WORKSPACE_SOURCE_ID);
  await click(button(container, "Create automation"));
  expect(client.createEventSource).toHaveBeenCalledTimes(1);
  expect(client.createScheduledTask).toHaveBeenCalledTimes(1);
  const [, request] = client.createScheduledTask.mock.calls[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
  expect(request).toMatchObject({
    name: "Meeting notes",
    prompt: meetingNotes.instructions,
    schedule: { type: "manual" },
    events: {
      triggers: [
        {
          sourceId: WORKSPACE_SOURCE_ID,
          eventTypes: ["recording.transcript.ready"],
          conditions: [
            { field: "data.purpose", op: "equals", value: "meeting" },
            { field: "data.recordedByYou", op: "equals", value: true },
          ],
        },
      ],
    },
  });
});

test("a template on this workspace's events isn't offered where those aren't", async () => {
  const client = fakeClient({ sources: [] });
  const container = await render(client, { templates: [meetingNotes, morningBrief] });
  await click(button(container, "New automation"));
  expect(container.textContent).toContain("Morning brief");
  expect(container.textContent).not.toContain("Meeting notes");
  await click(row(container, "Start from scratch"));
  expect(container.querySelector("textarea")?.value).toBe("");
});

test("with no templates, New automation opens the form", async () => {
  const client = fakeClient({ sources: [] });
  const container = await render(client);
  await click(button(container, "New automation"));
  expect(container.textContent).not.toContain("Start from scratch");
  expect(container.querySelector("textarea")).not.toBeNull();
});

test("an automation saves as a workspace template, offered the next time", async () => {
  const client = fakeClient({ tasks: [task()], sources: [] });
  const container = await render(client, { sessionId: SESSION_ID });
  await click(container.querySelector<HTMLButtonElement>("[data-row-action]")!);
  await click(button(container, "Save as template"));
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain(
    "Everyone in this workspace can start an automation from it",
  );
  await change(dialog.querySelector("textarea")!, "What sold yesterday.");
  await click(button(dialog, "Save template"));
  expect(client.createAutomationTemplate).toHaveBeenCalledWith(WORKSPACE_ID, {
    name: "Morning digest",
    description: "What sold yesterday.",
    instructions: "Summarize yesterday's orders.",
    schedule: null,
    triggers: [],
    maxRunsPerHour: null,
  });
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Saved “Morning digest” as a template",
  );
  await click(button(container, "All automations"));
  await click(button(container, "New automation"));
  expect(container.textContent).toContain("Saved in this workspace");
  await click(row(container, "Morning digest"));
  expect(container.querySelector("textarea")?.value).toBe("Summarize yesterday's orders.");
});

test("a saved template its maker manages can be deleted from the list", async () => {
  const client = fakeClient({ sources: [], templates: [savedTemplate()] });
  const container = await render(client);
  await click(button(container, "New automation"));
  await actRun(() =>
    button(container, "More actions for the Order digest template").dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }),
    ),
  );
  await flush();
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === "Delete",
  );
  await click(item!);
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Delete the “Order digest” template?");
  await click(button(dialog, "Delete template"));
  expect(client.deleteAutomationTemplate).toHaveBeenCalledWith(WORKSPACE_ID, savedTemplate().id);
});

test("someone else's saved template has no menu, and an older server offers no saving", async () => {
  const client = fakeClient({
    sources: [],
    templates: [savedTemplate({ viewerAccess: "use", createdBySubjectId: "someone" })],
  });
  const container = await render(client);
  await click(button(container, "New automation"));
  expect(container.textContent).toContain("Order digest");
  expect(() => button(container, "More actions for the Order digest template")).toThrow();

  await rendered?.unmount();
  const older = fakeClient({ tasks: [task()], sources: [], templates: "off" });
  const page = await render(older, { sessionId: SESSION_ID });
  await click(page.querySelector<HTMLButtonElement>("[data-row-action]")!);
  expect(() => button(page, "Save as template")).toThrow();
});
