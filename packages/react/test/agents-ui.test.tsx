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
    }: {
      children?: ReactNode;
      onSelect?: () => void;
      title?: string;
    }) => (
      <button type="button" role="menuitem" title={title} onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
  };
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const kit = await import("./agents-test-kit");
const { AgentsPage, BOT_TEMPLATES_MOVED, SLACK_AGENTS_MOVED, duplicateNamesText } =
  await import("../src/app/components/agents/agents-page");
const { AgentPage } = await import("../src/app/components/agents/agent-page");
const { NewAgentPage, EditAgentPage, INSTRUCTIONS_LONG_HINT, agentChanges } =
  await import("../src/app/components/agents/agent-form-page");
const { ComposerAgentChip } = await import("../src/app/components/agents/composer-agent-chip");
const { agentInitialsAvatarLite } = await import("../src/app/lib/agent-avatar");
const { duplicateAgentNames, parseAgentFile, agentErrorCode } =
  await import("../src/app/lib/agents");
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

test("a .bot.json file imports as an agent whose setup text is its First message", () => {
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
    firstMessage: "Ask which repositories to watch.",
  });
  expect(parseAgentFile("not json")).toEqual({
    ok: false,
    error: "This file isn't an agent. Choose a .bot.json file.",
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
      firstMessage: "",
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
    firstMessage: "Which dashboard?",
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
    "Which dashboard?",
    "Remember across chats",
    "People in Platform",
    "Opengeni app",
    "Slack part",
    "Delete agent",
  ]) {
    expect(container.textContent).toContain(text);
  }
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
  });
  expect(path).toMatch(new RegExp(`/workspaces/${WORKSPACE_ID}/agents/[0-9a-f-]{36}$`));
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
