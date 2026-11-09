import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import { agentInitialsAvatar } from "@opengeni/contracts";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// A semantic stand-in for the Radix menu: the same trigger and items, rendered
// in place, so the chip's choices can be read and clicked in happy-dom.
mock.module("../src/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuLabel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuCheck: ({ checked }: { checked: boolean }) => (checked ? <span>✓</span> : null),
    DropdownMenuItem: ({
      children,
      onSelect,
      title,
      disabled,
    }: {
      children?: ReactNode;
      onSelect?: () => void;
      title?: string;
      disabled?: boolean;
    }) => (
      <button
        type="button"
        role="menuitem"
        title={title}
        disabled={disabled}
        onClick={() => onSelect?.()}
      >
        {children}
      </button>
    ),
  };
});

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const kit = await import("./agents-test-kit");
const { AgentsPage, BOT_TEMPLATES_MOVED, SLACK_AGENTS_MOVED, duplicateNamesText } =
  await import("../src/app/components/agents/agents-page");
const { AgentPage } = await import("../src/app/components/agents/agent-page");
const {
  NewAgentPage,
  EditAgentPage,
  INSTRUCTIONS_LONG_HINT,
  ONLY_ME_UNAVAILABLE,
  agentChanges,
  lengthCount,
  lengthError,
} = await import("../src/app/components/agents/agent-form-page");
const { ComposerAgentChip } = await import("../src/app/components/agents/composer-agent-chip");
const { agentInitialsAvatarLite } = await import("../src/app/lib/agent-avatar");
const { duplicateAgentNames, parseAgentFile, agentErrorCode, agentFile, agentFileName } =
  await import("../src/app/lib/agents");
const { useComposerAgent, AGENT_ONLY_ME_UNAVAILABLE } =
  await import("../src/app/lib/composer-agent");
const { buildCreateSessionRequest } = await import("../src/app/lib/session-create");
const { composerLaunchAgentId, parseComposerLaunchSearch } =
  await import("../src/app/lib/composer-launch");
const { sessionAgentRef, sessionAgentSourceLine } = await import("../src/app/lib/session-agent");

const { WORKSPACE_ID, makeAgent, fakeAgentsClient, appContext, AgentsTestHost } = kit;

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

let mounted: { unmount: () => void; container: HTMLElement } | null = null;
afterEach(async () => {
  if (mounted) {
    const current = mounted;
    await act(async () => current.unmount());
    current.container.remove();
    mounted = null;
  }
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { unmount: () => root.unmount(), container };
  await act(async () => root.render(node));
  await flush();
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) =>
      element.textContent?.trim() === name || element.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

// --- helpers -----------------------------------------------------------------

test("the header's initials match the contracts' for an agent without an icon", () => {
  for (const [name, id] of [
    ["Release manager", "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"],
    ["data", "bbbbbbbb-bbbb-4bbb-8bbb-000000000002"],
    ["  Øyvind   Ås  ", "cccccccc-cccc-4ccc-8ccc-000000000003"],
    ["🤖 bot", "dddddddd-dddd-4ddd-8ddd-000000000004"],
    ["!!!", "eeeeeeee-eeee-4eee-8eee-000000000005"],
  ] as const) {
    expect(agentInitialsAvatarLite(name, id)).toEqual(agentInitialsAvatar(name, id));
  }
});

test("a .bot.json file imports as an agent whose setup text is its Instructions", () => {
  const parsed = parseAgentFile(
    JSON.stringify({
      format: "opengeni.bot-template",
      version: 1,
      name: "Release manager",
      description: "Plans releases",
      avatar: null,
      setupInstructions: "Ask which repositories to watch.",
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.request).toEqual({
    name: "Release manager",
    description: "Plans releases",
    avatar: null,
    instructions: "Ask which repositories to watch.",
  });
  expect(parseAgentFile("not json")).toEqual({
    ok: false,
    error: "This file isn't an agent. Choose an .agent.json or .bot.json file.",
  });
  expect(parseAgentFile("{}").ok).toBe(false);
});

test("duplicate names are found case-insensitively and named once", () => {
  expect(
    duplicateAgentNames([
      { name: "Data team" },
      { name: "data TEAM " },
      { name: "Release" },
      { name: "Data team" },
    ]),
  ).toEqual(["Data team"]);
  expect(duplicateNamesText(["Data team"])).toBe(
    "More than one agent is called “Data team”. Rename one so people can tell them apart.",
  );
  expect(duplicateNamesText(["A", "B", "C"])).toContain("“A”, “B” and “C”");
  expect(agentErrorCode({ details: { code: "agent_version_conflict" } })).toBe(
    "agent_version_conflict",
  );
  expect(agentErrorCode(new Error("x"))).toBeNull();
});

test("?agent= starts a chat with an agent and ?botTemplateId= links still do", () => {
  const agent = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
  const template = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
  expect(parseComposerLaunchSearch({ agent })).toEqual({ agent });
  expect(parseComposerLaunchSearch({ agent: "not-an-id" })).toEqual({});
  expect(composerLaunchAgentId(parseComposerLaunchSearch({ botTemplateId: template }))).toBe(
    template,
  );
  // Both: the newer parameter wins.
  expect(composerLaunchAgentId(parseComposerLaunchSearch({ agent, botTemplateId: template }))).toBe(
    agent,
  );
});

test("a chat knows its agent and where it started", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
  const other = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
  expect(sessionAgentRef({ agentId: id, metadata: {} })).toEqual({ id, name: null });
  const slack = { agentId: id, metadata: { slackAgent: { id, name: "Data team" } } };
  expect(sessionAgentRef(slack)).toEqual({ id, name: "Data team" });
  // Only agentId names the agent: metadata alone, or about another agent, does not.
  expect(sessionAgentRef({ ...slack, agentId: null })).toBeNull();
  expect(sessionAgentRef({ ...slack, agentId: other })).toEqual({ id: other, name: null });
  expect(sessionAgentRef({ metadata: {} })).toBeNull();
  expect(
    sessionAgentSourceLine({
      ...slack,
      createdBy: { kind: "subject", subjectId: "u", label: "Kari" },
    } as never),
  ).toBe("Started in Slack by Kari");
  expect(sessionAgentSourceLine({ ...slack, createdBy: null } as never)).toBe("Started in Slack");
  expect(sessionAgentSourceLine({ ...slack, agentId: null, createdBy: null } as never)).toBeNull();
  expect(sessionAgentSourceLine({ metadata: {}, createdBy: null } as never)).toBeNull();
});

test("the form sends only what changed, at the version it opened", () => {
  const agent = makeAgent({ version: 4, instructions: "Old" });
  expect(
    agentChanges(agent, {
      name: agent.name,
      description: agent.description,
      avatar: null,
      instructions: "New ",
      memoryEnabled: true,
      visibility: "workspace",
    }),
  ).toEqual({ expectedVersion: 4, instructions: "New", memoryEnabled: true });
});

// --- Agents page ---------------------------------------------------------------

test("the Agents page lists agents with their Slack badge and the moved-here notes", async () => {
  const client = fakeAgentsClient([
    makeAgent({ name: "Data team", origin: "slack_agent", slack: [slackAvailability()] }),
    makeAgent({ name: "Release manager", origin: "bot_template", visibility: "private" }),
    makeAgent({ name: "release manager", origin: "app" }),
  ]);
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <AgentsPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  expect(container.querySelector("h1")?.textContent).toBe("Agents");
  expect(container.textContent).toContain(BOT_TEMPLATES_MOVED);
  expect(container.textContent).toContain(SLACK_AGENTS_MOVED);
  expect(container.textContent).toContain("More than one agent is called “Release manager”.");
  expect(container.textContent).toContain("Slack");
  expect(container.textContent).toContain("Only me");
  // Dismissed notes stay dismissed.
  const dismiss = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (element) => element.getAttribute("aria-label") === "Dismiss",
  );
  expect(dismiss).toHaveLength(2);
  await act(async () => dismiss[0]!.click());
  expect(container.textContent).not.toContain(BOT_TEMPLATES_MOVED);
  expect(window.localStorage.getItem("opengeni.notice.agents.botTemplatesMoved")).toBe("dismissed");
});

test("Yours asks for the reader's own agents and New agent opens the form", async () => {
  const client = fakeAgentsClient([makeAgent({ name: "Mine" })], { yours: () => false });
  let path = "";
  const container = await render(
    <AgentsTestHost context={appContext(client)} onLocation={(location) => (path = location.href)}>
      <AgentsPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  const yours = [...container.querySelectorAll<HTMLElement>("[role='radio'], button")].find(
    (element) => element.textContent?.trim() === "Yours",
  )!;
  await act(async () => yours.click());
  await flush();
  expect(client.calls).toContainEqual(["listAgents", WORKSPACE_ID, { filter: "yours" }]);
  expect(container.textContent).toContain("You haven't made an agent here yet.");
  await act(async () => button(container, "New agent").click());
  expect(path).toBe(`/workspaces/${WORKSPACE_ID}/agents/new`);
});

// --- Agent page ----------------------------------------------------------------

function slackAvailability() {
  return {
    connectionId: "cccccccc-cccc-4ccc-8ccc-000000000001",
    slackTeamId: "T1",
    slackTeamName: "Acme",
    handle: "data-team",
    open: false,
    enabledBySubjectId: "user-me",
    version: 1,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  };
}

test("the agent page shows its chats, what it follows, Memory and where it is available", async () => {
  const agent = makeAgent({
    name: "Data team",
    instructions: "Answer metric questions from the dashboards.",
  });
  const client = fakeAgentsClient([agent], {
    chats: [
      {
        sessionId: "dddddddd-dddd-4ddd-8ddd-000000000001",
        title: "Weekly signups",
        visibility: "workspace",
        createdBySubjectId: "user-kari",
        source: "slack",
        slack: {
          connectionId: "cccccccc-cccc-4ccc-8ccc-000000000001",
          channelId: "C1",
          threadTs: "1.2",
          initiatingSlackUserId: "U1",
        },
        createdAt: "2026-10-30T09:00:00.000Z",
        updatedAt: "2026-10-30T09:00:00.000Z",
      },
    ],
  });
  let path = "";
  let slot: { agent: { id: string } } | null = null;
  const container = await render(
    <AgentsTestHost context={appContext(client)} onLocation={(location) => (path = location.href)}>
      <AgentPage
        workspaceId={WORKSPACE_ID}
        agentId={agent.id}
        renderSlack={(props) => {
          slot = props;
          return <p>Slack part</p>;
        }}
      />
    </AgentsTestHost>,
  );
  expect(container.querySelector("h1")?.textContent).toBe("Data team");
  for (const text of [
    "Weekly signups",
    "Answer metric questions from the dashboards.",
    "Remember across chats",
    "People in Platform",
    "Opengeni app",
    "Slack part",
    "Delete agent",
  ]) {
    expect(container.textContent).toContain(text);
  }
  expect(container.textContent).not.toContain("First message");
  expect(slot!.agent.id).toBe(agent.id);
  expect(container.querySelector("[data-agent-chat-source='slack']")).not.toBeNull();
  // Memory saves at the version the page read.
  const memory = container.querySelector<HTMLButtonElement>(
    "[role='switch'][aria-label='Remember across chats']",
  )!;
  await act(async () => memory.click());
  await flush();
  expect(client.calls).toContainEqual([
    "updateAgent",
    WORKSPACE_ID,
    agent.id,
    { expectedVersion: 1, memoryEnabled: true },
  ]);
  await act(async () => button(container, "Chat").click());
  expect(path).toBe(`/workspaces/${WORKSPACE_ID}/sessions?agent=${agent.id}`);
});

test("readers who can't edit see no Edit or Delete, and Memory is read-only", async () => {
  const agent = makeAgent({
    viewer: { canEdit: false, canManageSlack: false, canOpenInSlack: false },
  });
  const container = await render(
    <AgentsTestHost context={appContext(fakeAgentsClient([agent]))}>
      <AgentPage workspaceId={WORKSPACE_ID} agentId={agent.id} />
    </AgentsTestHost>,
  );
  expect(container.textContent).not.toContain("Delete agent");
  expect(
    [...container.querySelectorAll("button")].some((el) => el.textContent?.trim() === "Edit"),
  ).toBe(false);
  const memory = container.querySelector("[role='switch'][aria-label='Remember across chats']");
  expect(memory?.getAttribute("aria-disabled")).toBe("true");
});

// --- Form ----------------------------------------------------------------------

test("Make this an agent starts from the chat's name and links the new agent to it", async () => {
  const sessionId = "dddddddd-dddd-4ddd-8ddd-000000000009";
  const client = fakeAgentsClient([], {
    session: { title: "Release check", description: "Weekly release review" },
  });
  let path = "";
  const container = await render(
    <AgentsTestHost context={appContext(client)} onLocation={(location) => (path = location.href)}>
      <NewAgentPage workspaceId={WORKSPACE_ID} sourceSessionId={sessionId} />
    </AgentsTestHost>,
  );
  expect(container.querySelector("h1")?.textContent).toBe("Make this an agent");
  const name = container.querySelector<HTMLInputElement>("input[placeholder='Release manager']")!;
  expect(name.value).toBe("Release check");
  const instructions = container.querySelectorAll<HTMLTextAreaElement>("textarea")[0]!;
  await act(async () => setValue(instructions, "x".repeat(8_001)));
  expect(container.textContent).toContain(INSTRUCTIONS_LONG_HINT);
  await act(async () => button(container, "Create agent").click());
  await flush();
  const created = client.calls.find((call) => call[0] === "createAgent")?.[2] as Record<
    string,
    unknown
  >;
  expect(created).toMatchObject({
    name: "Release check",
    description: "Weekly release review",
    sourceSessionId: sessionId,
    visibility: "workspace",
    memoryEnabled: true,
  });
  expect(path).toMatch(new RegExp(`/workspaces/${WORKSPACE_ID}/agents/[0-9a-f-]{36}$`));
});

test("a new agent remembers by default, with a switch to turn Memory off", async () => {
  const client = fakeAgentsClient([]);
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <NewAgentPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  const memory = container.querySelector<HTMLElement>(
    "[role='switch'][aria-label='Remember across chats']",
  );
  expect(memory?.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector("[role='checkbox']")).toBeNull();
  await act(async () => memory!.click());
  expect(memory?.getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain("Each chat starts fresh.");
});

test("the icon picker of a new agent opens on the emoji choices and colours", async () => {
  const client = fakeAgentsClient([]);
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <NewAgentPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  await act(async () => button(container, "Change icon").click());
  await flush();
  const picker = document.querySelector<HTMLElement>("[role='dialog'][aria-label='Icon']")!;
  expect(picker).not.toBeNull();
  const emoji = [
    ...picker.querySelectorAll<HTMLButtonElement>("[aria-label='Suggested emoji'] button"),
  ];
  expect(emoji.length).toBeGreaterThan(0);
  expect(
    picker.querySelectorAll("[role='radiogroup'][aria-label='Colour'] [role='radio']").length,
  ).toBeGreaterThan(0);
  // Nothing is chosen until the person picks.
  expect(emoji.some((candidate) => candidate.getAttribute("aria-pressed") === "true")).toBe(false);
  await act(async () => emoji[1]!.click());
  expect(emoji[1]!.getAttribute("aria-pressed")).toBe("true");
});

test("browsing the icon picker's tabs and colours chooses nothing", async () => {
  const client = fakeAgentsClient([]);
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <NewAgentPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  await act(async () => button(container, "Change icon").click());
  await flush();
  const picker = document.querySelector<HTMLElement>("[role='dialog'][aria-label='Icon']")!;
  const tab = (label: string) =>
    [...picker.querySelectorAll<HTMLButtonElement>("[data-slot='segmented-control-item']")].find(
      (item) => item.textContent?.trim() === label,
    )!;
  await act(async () => tab("Icon").click());
  await flush();
  const icons = [...picker.querySelectorAll<HTMLButtonElement>("[aria-label='Icons'] button")];
  expect(icons.length).toBeGreaterThan(0);
  expect(icons.some((candidate) => candidate.getAttribute("aria-pressed") === "true")).toBe(false);
  const colours = [
    ...picker.querySelectorAll<HTMLButtonElement>("[aria-label='Colour'] [role='radio']"),
  ];
  await act(async () => colours[2]!.click());
  expect(colours[2]!.getAttribute("aria-checked")).toBe("true");
  await act(async () => tab("Letters").click());
  await flush();
  // Still no icon: the agent is created without one.
  const name = container.querySelector<HTMLInputElement>("input[placeholder='Release manager']")!;
  await act(async () => setValue(name, "Browser"));
  await act(async () => button(container, "Create agent").click());
  await flush();
  const created = client.calls.find((call) => call[0] === "createAgent")?.[2] as
    | Record<string, unknown>
    | undefined;
  expect(created?.avatar ?? null).toBeNull();
});

test("a name is the only required field", async () => {
  const client = fakeAgentsClient([]);
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <NewAgentPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  await act(async () => button(container, "Create agent").click());
  await flush();
  expect(container.textContent).toContain("Give it a name.");
  expect(client.calls.some((call) => call[0] === "createAgent")).toBe(false);
});

test("the count and the error measure the same text: outer spaces don't count", () => {
  const padded = `${"x".repeat(120)}   `;
  expect(lengthCount(padded, 120)).toBe("120 / 120");
  expect(lengthError(padded, 120)).toBeUndefined();
  expect(lengthCount("x".repeat(121), 120)).toBe("121 / 120");
  expect(lengthError("x".repeat(121), 120)).toBe("Shorten it to 120 characters. It has 121.");
});

test("an agent available in Slack can't be made Only me", async () => {
  const agent = makeAgent({ slack: [slackAvailability()] });
  const container = await render(
    <AgentsTestHost context={appContext(fakeAgentsClient([agent]))}>
      <EditAgentPage workspaceId={WORKSPACE_ID} agentId={agent.id} />
    </AgentsTestHost>,
  );
  expect(container.querySelector("h1")?.textContent).toBe(`Edit ${agent.name}`);
  const onlyMe = [...container.querySelectorAll<HTMLElement>("[role='radio']")].find(
    (element) => element.textContent?.trim() === "Only me",
  );
  expect(onlyMe?.getAttribute("aria-disabled") ?? onlyMe?.getAttribute("disabled")).not.toBeNull();
});

// --- Composer chip -------------------------------------------------------------

test("the composer chip lists agents to chat with and Browse agents", async () => {
  const agents = [makeAgent({ name: "Data team" }), makeAgent({ name: "Release manager" })].map(
    kit.summary,
  );
  const picked: (string | null)[] = [];
  let browsed = 0;
  const container = await render(
    <AgentsTestHost context={appContext(fakeAgentsClient([]))}>
      <ComposerAgentChip
        workspaceId={WORKSPACE_ID}
        agents={agents}
        selection={null}
        disabled={false}
        onSelect={(id) => picked.push(id)}
        onBrowse={() => (browsed += 1)}
      />
    </AgentsTestHost>,
  );
  expect(container.querySelector("[data-composer-agent]")?.getAttribute("aria-label")).toBe(
    "Chat with: Opengeni",
  );
  const items = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
  expect(
    items.map((item) => (item.querySelector(".truncate") ?? item).textContent?.trim()),
  ).toEqual(["Opengeni", "Data team", "Release manager", "Browse agents"]);
  await act(async () => items[1]!.click());
  await act(async () => items[3]!.click());
  expect(picked).toEqual([agents[0]!.id]);
  expect(browsed).toBe(1);
});

test("the chip names an agent that can't start a chat here, and Only me agents are off where Only me chats are", async () => {
  const shared = makeAgent({ name: "Data team" });
  const mine = makeAgent({ name: "Notes", visibility: "private" });
  const container = await render(
    <AgentsTestHost context={appContext(fakeAgentsClient([]))}>
      <ComposerAgentChip
        workspaceId={WORKSPACE_ID}
        agents={[shared, mine].map(kit.summary)}
        selection={{
          kind: "error",
          id: mine.id,
          name: "Notes",
          avatar: agentInitialsAvatar("Notes", mine.id),
          message: AGENT_ONLY_ME_UNAVAILABLE,
        }}
        disabled={false}
        onlyMeUnavailable
        onSelect={() => undefined}
        onBrowse={() => undefined}
      />
    </AgentsTestHost>,
  );
  const chip = container.querySelector("[data-composer-agent]")!;
  expect(chip.getAttribute("aria-label")).toBe("Chat with: Notes");
  expect(chip.getAttribute("title")).toBe(AGENT_ONLY_ME_UNAVAILABLE);
  const items = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
  const row = (name: string) => items.find((item) => item.textContent?.includes(name))!;
  expect(row("Notes").disabled).toBe(true);
  expect(row("Data team").disabled).toBe(false);
});

// --- New chat with an agent (the hooks the new-chat page uses) -----------------

type Visibility = "private" | "workspace";
type Harness = {
  state: ReturnType<typeof useComposerAgent>;
  message: string;
  visibility: Visibility;
  setAgentId: (id: string | undefined) => void;
  setMessage: (text: string) => void;
  setDraftLoading: (loading: boolean) => void;
  setKeepOnlyMe: (keep: boolean) => void;
};

function ComposerAgentHarness({
  api,
  agentId: initialAgentId,
  draftLoading: initialDraftLoading = false,
  canCreatePrivateChat = true,
}: {
  api: Partial<Harness>;
  agentId?: string | undefined;
  draftLoading?: boolean;
  canCreatePrivateChat?: boolean | null;
}) {
  const [agentId, setAgentId] = useState(initialAgentId);
  const [message, setMessage] = useState("");
  const [draftLoading, setDraftLoading] = useState(initialDraftLoading);
  const [visibility, setVisibility] = useState<Visibility>("workspace");
  const [keepOnlyMe, setKeepOnlyMe] = useState(false);
  const state = useComposerAgent({
    workspaceId: WORKSPACE_ID,
    agentId,
    canCreatePrivateChat,
    visibility,
    setVisibility,
    keepOnlyMe,
  });
  void draftLoading;
  Object.assign(api, {
    state,
    message,
    visibility,
    setAgentId,
    setMessage,
    setDraftLoading,
    setKeepOnlyMe,
  });
  return null;
}

async function harness(
  client: object,
  props: Omit<Parameters<typeof ComposerAgentHarness>[0], "api"> = {},
): Promise<Harness> {
  const api: Partial<Harness> = {};
  await render(
    <AgentsTestHost context={appContext(client)}>
      <ComposerAgentHarness api={api} {...props} />
    </AgentsTestHost>,
  );
  return api as Harness;
}

async function step(action: () => void) {
  await act(async () => action());
  await flush();
}

test("a chosen agent is selected and the composer stays as it is", async () => {
  const agent = makeAgent({ name: "Onboarding" });
  const api = await harness(fakeAgentsClient([agent]), { agentId: agent.id, draftLoading: true });
  expect(api.state.loading).toBe(false);
  expect(api.state.agent?.id).toBe(agent.id);
  expect(api.state.selection).toMatchObject({ kind: "ready", name: "Onboarding" });
  await step(() => api.setDraftLoading(false));
  expect(api.message).toBe("");
  // What the person typed is theirs: choosing or leaving an agent keeps it.
  await step(() => api.setMessage("My own question"));
  const other = makeAgent({ name: "Other" });
  const two = await harness(fakeAgentsClient([agent, other]), { agentId: agent.id });
  await step(() => two.setMessage("Typed"));
  await step(() => two.setAgentId(other.id));
  expect(two.message).toBe("Typed");
  await step(() => two.setAgentId(undefined));
  expect(two.message).toBe("Typed");
  expect(two.state.selection).toBeNull();
});

test("Send waits while the agent loads, and an agent that can't be read blocks it with the reason", async () => {
  const agent = makeAgent({ name: "Slow" });
  const client = fakeAgentsClient([agent], { holdGetAgent: true });
  const api = await harness(client, { agentId: agent.id });
  expect(api.state.loading).toBe(true);
  expect(api.state.agent).toBeNull();
  expect(api.state.blocker).toBeNull();
  expect(api.state.selection).toMatchObject({ kind: "loading" });
  await step(() => client.releaseGetAgent());
  expect(api.state.loading).toBe(false);
  expect(api.state.agent?.id).toBe(agent.id);

  const missing = await harness(fakeAgentsClient([]), {
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-ffffffffffff",
  });
  expect(missing.state.loading).toBe(false);
  expect(missing.state.agent).toBeNull();
  expect(missing.state.blocker).toBeTruthy();
  expect(missing.state.selection).toMatchObject({ kind: "error" });
});

test("an Only me agent makes the chat Only me, and going back restores the earlier choice unless the person chose", async () => {
  const mine = makeAgent({ name: "Notes", visibility: "private" });
  const shared = makeAgent({ name: "Team" });
  const api = await harness(fakeAgentsClient([mine, shared]), { agentId: mine.id });
  expect(api.state.onlyMe).toBe(true);
  expect(api.visibility).toBe("private");
  await step(() => api.setAgentId(shared.id));
  expect(api.visibility).toBe("workspace");
  await step(() => api.setAgentId(mine.id));
  expect(api.visibility).toBe("private");
  await step(() => api.state.visibilityChosen());
  await step(() => api.setAgentId(undefined));
  expect(api.visibility).toBe("private");
});

test("going back to Opengeni keeps the chat Only me while an Only me project needs it", async () => {
  const mine = makeAgent({ name: "Notes", visibility: "private" });
  const api = await harness(fakeAgentsClient([mine]), { agentId: mine.id });
  expect(api.visibility).toBe("private");
  // The person then picks an Only me project, which needs an Only me chat.
  await step(() => api.setKeepOnlyMe(true));
  await step(() => api.setAgentId(undefined));
  expect(api.visibility).toBe("private");
});

test("where Only me chats aren't available, an Only me agent says so and never starts a chat", async () => {
  const mine = makeAgent({ name: "Notes", visibility: "private" });
  const api = await harness(fakeAgentsClient([mine]), {
    agentId: mine.id,
    canCreatePrivateChat: false,
  });
  expect(api.state.agent).toBeNull();
  expect(api.state.blocker).toBe(AGENT_ONLY_ME_UNAVAILABLE);
  expect(api.state.selection).toMatchObject({ kind: "error", name: "Notes" });
  expect(api.visibility).toBe("workspace");
  expect(api.message).toBe("");
  // Not known yet: Send waits rather than failing.
  const unknown = await harness(fakeAgentsClient([mine]), {
    agentId: mine.id,
    canCreatePrivateChat: null,
  });
  expect(unknown.state.loading).toBe(true);
  expect(unknown.state.blocker).toBeNull();
});

test("a chat started with an agent is created with its agentId and icon", () => {
  const request = buildCreateSessionRequest({
    currentResources: [],
    submission: { text: "Set me up." },
    selectedTools: [],
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "medium",
    defaultLatencyMode: "standard",
    clientEventId: "event-1",
    idempotencyKey: "create-1",
    agent: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      avatar: { kind: "emoji", emoji: "🚀", hue: 210 },
    },
  });
  expect(request.agentId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-000000000001");
  expect(request.profile).toEqual({ avatar: { kind: "emoji", emoji: "🚀", hue: 210 } });
  expect(
    buildCreateSessionRequest({
      currentResources: [],
      submission: { text: "Hi" },
      selectedTools: [],
      defaultModel: "gpt-5.4",
      defaultReasoningEffort: "medium",
      defaultLatencyMode: "standard",
      clientEventId: "event-2",
      idempotencyKey: "create-2",
    }).agentId,
  ).toBeUndefined();
});

test("the new-chat page starts chats through the agent hooks, never an ordinary chat in an agent's place", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/app/routes/sessions-index.tsx", import.meta.url),
    "utf8",
  );
  for (const wiring of [
    "useComposerAgent({",
    "text: message,",
    "agentError={composerAgent.blocker}",
    "workspaceUnavailable={composerAgent.onlyMe ? AGENT_ONLY_ME_CHAT : null}",
    // Send's one guard (its enabled state, the early-Send hold, the guard
    // Send runs and voice) reads the agent.
    "agentLoading: composerAgent.loading,",
    "agentBlocked: composerAgent.blocker !== null,",
    "getNewSessionSendBlocker({ ...sendState, voice: realtimeModel !== null })",
    'voiceSendBlocker === "agent"',
    "keepOnlyMe: selectedProjectOnlyMe,",
  ]) {
    expect(source).toContain(wiring);
  }
  // Both the text and the voice start send the agent.
  expect(source.split("agent: newSessionAgent,").length - 1).toBe(2);
});

// --- Form: lengths, Only me, Make this an agent --------------------------------

test("long text is never cut: a count shows near the limit and Save says what to shorten", async () => {
  const client = fakeAgentsClient([]);
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <NewAgentPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  const name = container.querySelector<HTMLInputElement>("input[placeholder='Release manager']")!;
  await act(async () => setValue(name, "Long one"));
  const instructions = container.querySelectorAll<HTMLTextAreaElement>("textarea")[0]!;
  expect(instructions.hasAttribute("maxlength")).toBe(false);
  await act(async () => setValue(instructions, "x".repeat(20_001)));
  expect(instructions.value.length).toBe(20_001);
  expect(container.textContent).toContain("20,001 / 20,000");
  await act(async () => button(container, "Create agent").click());
  await flush();
  expect(container.textContent).toContain("Shorten it to 20,000 characters. It has 20,001.");
  expect(client.calls.some((call) => call[0] === "createAgent")).toBe(false);
});

test("Only me is off with a reason where Only me chats aren't available", async () => {
  const container = await render(
    <AgentsTestHost context={appContext(fakeAgentsClient([], { canCreatePrivate: false }))}>
      <NewAgentPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  const onlyMe = [...container.querySelectorAll<HTMLElement>("[role='radio']")].find(
    (element) => element.textContent?.trim() === "Only me",
  );
  expect(onlyMe?.getAttribute("aria-disabled") ?? onlyMe?.getAttribute("disabled")).not.toBeNull();
  expect(ONLY_ME_UNAVAILABLE).toBe("Only me chats aren't available here.");
});

test("Make this an agent takes the chat's instructions, and its back link names the chat", async () => {
  const sessionId = "dddddddd-dddd-4ddd-8ddd-000000000010";
  const client = fakeAgentsClient([], {
    session: { title: "Release check", instructions: "Check the open release PRs first." },
  });
  let path = "";
  const container = await render(
    <AgentsTestHost context={appContext(client)} onLocation={(location) => (path = location.href)}>
      <NewAgentPage workspaceId={WORKSPACE_ID} sourceSessionId={sessionId} />
    </AgentsTestHost>,
  );
  const instructions = container.querySelectorAll<HTMLTextAreaElement>("textarea")[0]!;
  expect(instructions.value).toBe("Check the open release PRs first.");
  await act(async () => button(container, "Release check").click());
  expect(path).toBe(`/workspaces/${WORKSPACE_ID}/sessions/${sessionId}`);
});

// --- Export and Import -----------------------------------------------------------

test("Export writes an .agent.json that Import reads back with its Instructions", () => {
  const agent = makeAgent({
    name: "Release manager",
    description: "Plans releases",
    avatar: { kind: "image", artifactId: "f".repeat(32) } as never,
    instructions: "Check the open PRs first.",
    memory: { enabled: true, collectionId: "c1", scope: "workspace", reviewFirst: false },
  });
  const file = agentFile(agent);
  expect(file).toEqual({
    format: "opengeni.agent",
    version: 1,
    name: "Release manager",
    description: "Plans releases",
    avatar: null,
    instructions: "Check the open PRs first.",
    memoryEnabled: true,
    visibility: "workspace",
  });
  expect(agentFileName(agent)).toBe("release-manager.agent.json");
  expect(agentFileName({ name: "Résumé helper" })).toBe("resume-helper.agent.json");
  const parsed = parseAgentFile(JSON.stringify(file));
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.request).toEqual({
    name: "Release manager",
    description: "Plans releases",
    avatar: null,
    instructions: "Check the open PRs first.",
    memoryEnabled: true,
  });
  // An older file's First message is still sent; the server joins it to the Instructions.
  const older = parseAgentFile(JSON.stringify({ ...file, firstMessage: "Which repositories?" }));
  expect(older.ok && older.request.firstMessage).toBe("Which repositories?");
  const onlyMe = parseAgentFile(JSON.stringify({ ...file, visibility: "private" }));
  expect(onlyMe.ok && onlyMe.request.visibility).toBe("private");
  expect(parseAgentFile(JSON.stringify({ ...file, visibility: "team" })).ok).toBe(false);
  expect(parseAgentFile(JSON.stringify({ ...file, version: 2 })).ok).toBe(false);
  expect(parseAgentFile(JSON.stringify({ ...file, instructions: 3 })).ok).toBe(false);
});

async function importAgentFile(canCreatePrivate: boolean | "unreadable") {
  const client = fakeAgentsClient([], { canCreatePrivate: canCreatePrivate !== false });
  if (canCreatePrivate === "unreadable") {
    client.getSessionTenancyCreateCapabilities = async () => {
      throw new Error("offline");
    };
  }
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <AgentsPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  const input = container.querySelector<HTMLInputElement>("input[type='file']")!;
  const text = JSON.stringify(agentFile(makeAgent({ name: "Notes", visibility: "private" })));
  const file = { name: "notes.agent.json", text: async () => text } as unknown as File;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await flush();
  await flush();
  const created = client.calls.find((call) => call[0] === "createAgent");
  return (created?.[2] as { visibility?: string } | undefined)?.visibility;
}

test("an imported Only me agent stays Only me, and is shared only where Only me chats aren't available", async () => {
  expect(await importAgentFile(true)).toBe("private");
  expect(await importAgentFile(false)).toBe("workspace");
  // Not knowing never stops the import: the server decides.
  expect(await importAgentFile("unreadable")).toBe("private");
});

// --- Lists: no stale rows --------------------------------------------------------

test("a Show more from the previous filter never lands in the new list", async () => {
  const agent = makeAgent({ name: "Data team" });
  const chat = (id: number, title: string) => ({
    sessionId: `dddddddd-dddd-4ddd-8ddd-${String(id).padStart(12, "0")}`,
    title,
    visibility: "workspace" as const,
    createdBySubjectId: "user-me",
    source: "app" as const,
    slack: null,
    createdAt: "2026-10-30T09:00:00.000Z",
    updatedAt: "2026-10-30T09:00:00.000Z",
  });
  const client = fakeAgentsClient([agent]);
  let releaseMore: () => void = () => undefined;
  client.listAgentChats = async (_workspace: string, _id: string, request) => {
    const { filter, cursor } = request as { filter: string; cursor?: string };
    if (cursor) {
      await new Promise<void>((resolve) => (releaseMore = resolve));
      return { chats: [chat(3, "Older mine")], nextCursor: null };
    }
    return filter === "yours"
      ? { chats: [chat(1, "Mine")], nextCursor: "more" }
      : { chats: [chat(2, "Everyone's chat")], nextCursor: null };
  };
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <AgentPage workspaceId={WORKSPACE_ID} agentId={agent.id} />
    </AgentsTestHost>,
  );
  await act(async () => button(container, "Show more").click());
  const everyone = [...container.querySelectorAll<HTMLElement>("[role='radio'], button")].find(
    (element) => element.textContent?.trim() === "Everyone's",
  )!;
  await act(async () => everyone.click());
  await flush();
  await act(async () => releaseMore());
  await flush();
  expect(container.textContent).toContain("Everyone's chat");
  expect(container.textContent).not.toContain("Older mine");
  expect(container.textContent).not.toContain("Mine");
});
