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
  INSTRUCTIONS_OVER_LIMIT_HINT,
  ONLY_ME_UNAVAILABLE,
  ORGANIZATION_ACCESS_ADMIN_ONLY,
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
const { userErrorText } = await import("../src/ui/api-error");
const { composerLaunchAgentId, parseComposerLaunchSearch } =
  await import("../src/app/lib/composer-launch");
const { sessionAgentRef, sessionAgentSourceLine } = await import("../src/app/lib/session-agent");
const { AGENT_TRIGGER_SHARED_DENIED } =
  await import("../src/app/components/agents/agent-trigger-model");

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

test("saving an agent whose Memory has no collection yet sends Memory again, so it is set up", () => {
  const values = (agent: ReturnType<typeof makeAgent>) => ({
    name: agent.name,
    description: agent.description,
    avatar: agent.avatar,
    instructions: agent.instructions,
    memoryEnabled: true,
    visibility: agent.visibility,
  });
  const missing = makeAgent({
    version: 2,
    memory: { enabled: true, collectionId: null, scope: "workspace", reviewFirst: false },
  });
  expect(agentChanges(missing, values(missing))).toEqual({
    expectedVersion: 2,
    memoryEnabled: true,
  });
  const ready = makeAgent({
    version: 2,
    memory: {
      enabled: true,
      collectionId: "eeeeeeee-eeee-4eee-8eee-000000000001",
      scope: "workspace",
      reviewFirst: false,
    },
  });
  expect(agentChanges(ready, values(ready))).toEqual({ expectedVersion: 2 });
});

// --- Agents page ---------------------------------------------------------------

test("the Agents page lists agents, marks Only me ones, and shows the moved-here notes", async () => {
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
  // Every shared agent is in Slack: no per-agent Slack badge, only Only me.
  const badges = [...container.querySelectorAll('[data-slot="meta-chip"]')].map(
    (chip) => chip.textContent,
  );
  expect(badges).toEqual(["Only me"]);
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
  await act(async () => button(container, "Blank agent").click());
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

test("the agent page shows its chats, what it follows, Memory and its setup sections", async () => {
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
    "Starts when",
    "Can use",
    "Skills",
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

test("an agent in Slack can be made Only me, and the form says it leaves Slack", async () => {
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
  expect(onlyMe?.getAttribute("aria-disabled")).not.toBe("true");
  expect(onlyMe?.hasAttribute("disabled")).toBe(false);
  expect(container.textContent).not.toContain("stops answering in Slack");
  await act(async () => onlyMe!.click());
  expect(container.textContent).toContain(
    "Only me agents stay in the app, so it stops answering in Slack.",
  );
});

test("an agent's image icon shows in the form and is kept when saving other changes", async () => {
  const avatar = { kind: "image" as const, artifactId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001" };
  const agent = makeAgent({ avatar });
  const client = fakeAgentsClient([agent]);
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <EditAgentPage workspaceId={WORKSPACE_ID} agentId={agent.id} />
    </AgentsTestHost>,
  );
  const tile = container.querySelector<HTMLElement>("[aria-label='Change icon']")!;
  expect(tile.querySelector(".border-dashed")).toBeNull();
  const name = container.querySelector<HTMLInputElement>("input[placeholder='Release manager']")!;
  await act(async () => setValue(name, "Release desk"));
  await act(async () => button(container, "Save").click());
  await flush();
  const update = client.calls.find((call) => call[0] === "updateAgent")?.[3] as
    | Record<string, unknown>
    | undefined;
  expect(update).toMatchObject({ name: "Release desk" });
  expect(update && "avatar" in update).toBe(false);
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

test("an agent over the limit as stored still saves other changes, and says why its Instructions stay", async () => {
  const agent = makeAgent({ name: "Long one", instructions: "x".repeat(20_030) });
  const client = fakeAgentsClient([agent]);
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <EditAgentPage workspaceId={WORKSPACE_ID} agentId={agent.id} />
    </AgentsTestHost>,
  );
  expect(container.textContent).toContain(INSTRUCTIONS_OVER_LIMIT_HINT);
  const name = container.querySelector<HTMLInputElement>("input[placeholder='Release manager']")!;
  await act(async () => setValue(name, "Long desk"));
  await act(async () => button(container, "Save").click());
  await flush();
  const update = client.calls.find((call) => call[0] === "updateAgent")?.[3] as
    | Record<string, unknown>
    | undefined;
  expect(update).toMatchObject({ name: "Long desk" });
  expect(update && "instructions" in update).toBe(false);
});

test("Anyone in the organization takes an organization admin, and says who can then see the chat", async () => {
  const radio = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll<HTMLElement>("[role='radio']")].find(
      (element) => element.textContent?.trim() === label,
    );
  const member = await render(
    <AgentsTestHost context={appContext(fakeAgentsClient([]))}>
      <NewAgentPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  const memberOption = radio(member, "Anyone in Acme");
  expect(memberOption).toBeDefined();
  expect(
    memberOption?.getAttribute("aria-disabled") ?? memberOption?.getAttribute("disabled"),
  ).not.toBeNull();
  expect(ORGANIZATION_ACCESS_ADMIN_ONLY).toBe("Only an organization admin can choose this.");
  const first = mounted!;
  await act(async () => first.unmount());
  first.container.remove();

  const client = fakeAgentsClient([]);
  const orgAdmin = appContext(client, {
    accessContext: {
      subjectId: "user-me",
      subjectLabel: "Maja",
      workspaceGrants: [],
      accountGrants: [
        {
          accountId: "account-1",
          subjectId: "user-me",
          permissions: ["account:admin"],
          metadata: { accountName: "Acme" },
        },
      ],
    },
  });
  const container = await render(
    <AgentsTestHost context={orgAdmin}>
      <NewAgentPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  const name = container.querySelector<HTMLInputElement>("input[placeholder='Release manager']")!;
  await act(async () => setValue(name, "Help desk"));
  await act(async () => radio(container, "Anyone in Acme")!.click());
  expect(container.textContent).toContain("People in your organization can ask Help desk");
  await act(async () => button(container, "Create agent").click());
  await flush();
  const created = client.calls.find((call) => call[0] === "createAgent")?.[2] as
    | Record<string, unknown>
    | undefined;
  expect(created?.visibility).toBe("organization");
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
  // An organization agent's file imports as a shared one: opening it to the
  // organization stays an organization admin's choice.
  const organization = parseAgentFile(JSON.stringify({ ...file, visibility: "organization" }));
  expect(organization.ok).toBe(true);
  expect(organization.ok && organization.request.visibility).toBeUndefined();
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

const TRIAGE_TEMPLATE = {
  key: "triage",
  name: "Triage",
  description: "Sorts new issues and hands real bugs to Bug fixer.",
  avatar: null,
  instructions: "Triage new work.",
  memoryEnabled: true,
  toolPermissions: [],
  skills: [],
  suggestedTriggers: [
    {
      name: "When a GitHub issue opens",
      instructions: "Triage it.",
      schedule: null,
      triggers: [{ source: { kind: "github" }, eventTypes: ["issues.opened"] }],
    },
    {
      name: "When a Linear issue is created",
      instructions: "Triage it.",
      schedule: null,
      triggers: [
        {
          source: { kind: "webhook", adapter: "custom", preset: "linear" },
          eventTypes: ["Issue.create"],
        },
      ],
    },
  ],
};

test("the agent page's setup: triggers, suggestions, Can use, Memory entries and Skills", async () => {
  const agent = makeAgent({
    name: "Triage",
    templateKey: "triage",
    memory: { enabled: true, collectionId: "c1", scope: "workspace", reviewFirst: false },
    toolPermissions: [{ connector: "github.com", tool: "merge_pull_request", permission: "block" }],
    skills: [{ name: "release-notes" }],
  });
  const trigger = {
    id: "eeeeeeee-eeee-4eee-8eee-000000000001",
    name: "Triage: When a GitHub issue opens",
    status: "active",
    schedule: { type: "manual" },
    events: {
      triggers: [{ source: { kind: "github" }, eventTypes: ["issues.opened"], conditions: [] }],
    },
    agentConfig: { agentId: agent.id },
  };
  const client = fakeAgentsClient([agent], {
    templates: [TRIAGE_TEMPLATE],
    tasks: [trigger, { ...trigger, id: "other", name: "Unrelated", agentConfig: {} }],
    capabilities: [
      {
        id: "cap-gmail",
        name: "Gmail",
        kind: "mcp",
        source: "integration",
        enabled: true,
        providerDomain: "gmail.com",
        connectionRef: { providerDomain: "gmail.com" },
        tools: [{ kind: "mcp", id: "gmail" }],
      },
    ],
    skills: ["release-notes"],
    memoryEntries: [
      {
        id: "m1",
        version: 3,
        revision: { title: "Release day", preview: "Releases go out on Tuesdays." },
      },
    ],
  });
  let path = "";
  const container = await render(
    <AgentsTestHost context={appContext(client)} onLocation={(location) => (path = location.href)}>
      <AgentPage workspaceId={WORKSPACE_ID} agentId={agent.id} />
    </AgentsTestHost>,
  );
  // Only this agent's automations are its triggers, and a set-up suggestion isn't offered again.
  // The server filters them by agent.
  expect(client.calls).toContainEqual([
    "listScheduledTasks",
    WORKSPACE_ID,
    { agentId: agent.id, limit: 200 },
  ]);
  expect(container.querySelectorAll("[data-agent-trigger]").length).toBe(1);
  const suggested = [...container.querySelectorAll("[data-agent-suggested-trigger]")];
  expect(suggested.map((row) => row.textContent)).toEqual([
    expect.stringContaining("When a Linear issue is created"),
  ]);
  // Set up opens the light dialog at the suggestion; the full form stays one link away.
  await act(async () => button(container, "Set up").click());
  await flush();
  const dialog = document.body.querySelector<HTMLElement>("[role='dialog']")!;
  expect(dialog.textContent).toContain("When a Linear issue is created");
  await act(async () => button(dialog, "Open full form").click());
  await flush();
  expect(path).toBe(
    `/workspaces/${WORKSPACE_ID}/automations/new?agent=${agent.id}&agentTrigger=1&returnTo=agent`,
  );
  // Can use lists only connections with a rule: Opengeni's own GitHub tools,
  // whose row holds the ready-made agent's github.com rule, and not Gmail.
  expect(container.querySelector("[data-agent-can-use='gmail.com']")).toBeNull();
  const github = container.querySelector<HTMLElement>("[data-agent-can-use='github.com']")!;
  expect(github.textContent).toContain("GitHub");
  expect(github.querySelector("[data-slot='logo-tile']")).not.toBeNull();
  expect(github.textContent).toContain("merge_pull_request");
  await act(async () =>
    [...github.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Choose per tool"))!
      .click(),
  );
  await flush();
  expect(github.textContent).toContain("pull_request_merge");
  expect(github.textContent).toContain("merge_pull_request");
  expect(container.textContent).not.toContain("github.com · merge_pull_request");
  // Memory entries are listed and can be removed at the version read.
  expect(container.textContent).toContain("Releases go out on Tuesdays.");
  await act(async () =>
    container.querySelector<HTMLButtonElement>("[aria-label='Remove Release day']")!.click(),
  );
  await flush();
  expect(client.calls).toContainEqual([
    "archiveKnowledgeEntry",
    WORKSPACE_ID,
    "m1",
    { operationId: expect.any(String), expectedVersion: 3 },
  ]);
  expect(container.textContent).not.toContain("Releases go out on Tuesdays.");
  // Pausing a trigger pauses its automation.
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>("[aria-label='Triage: When a GitHub issue opens on']")!
      .click(),
  );
  await flush();
  expect(client.calls).toContainEqual(["pauseScheduledTask", WORKSPACE_ID, trigger.id]);
  // Skills show by name, linked to the Skill's page.
  const skill = [...container.querySelectorAll("a")].find(
    (link) => link.textContent === "Release notes",
  )!;
  expect(skill.getAttribute("href")).toBe(
    `/workspaces/${WORKSPACE_ID}/plugins?section=skills&open=skill%3Askill-release-notes`,
  );
});

const GITHUB_SOURCE = {
  id: "source-gh",
  name: "Acme GitHub",
  kind: "github",
  status: "active",
} as {
  id: string;
  name: string;
  kind: string;
  status: string;
  statusReason?: string | null;
  statusReasonCode?: string | null;
};

async function openAgentTrigger(
  options: {
    agent?: Parameters<typeof makeAgent>[0];
    eventTriggers?: boolean;
    eventSources?: (typeof GITHUB_SOURCE)[];
    createTaskError?: unknown;
    createSourceError?: unknown;
    chatsError?: unknown;
    chatsPageSize?: number;
    suggestion?: string;
    githubStatus?: string;
    /** Chats in the workspace, given the agent's id. */
    sessions?: (agentId: string) => { id: string; title: string; agentId?: string | null }[];
  } = {},
) {
  const agent = makeAgent({ name: "Triage", templateKey: "triage", ...options.agent });
  const client = fakeAgentsClient([agent], {
    templates: [TRIAGE_TEMPLATE],
    eventSources: options.eventSources ?? [],
    createTaskError: options.createTaskError,
    createSourceError: options.createSourceError,
    chatsError: options.chatsError,
    chatsPageSize: options.chatsPageSize,
    sessions: options.sessions?.(agent.id),
  });
  let path = "";
  let state: Record<string, unknown> = {};
  const container = await render(
    <AgentsTestHost
      context={appContext(client, {
        clientConfig: { eventTriggers: { enabled: options.eventTriggers ?? true } },
        ...(options.githubStatus ? { githubStatus: { status: options.githubStatus } } : {}),
      })}
      onLocation={(location) => {
        path = location.href;
        state = location.state;
      }}
    >
      <AgentPage workspaceId={WORKSPACE_ID} agentId={agent.id} />
    </AgentsTestHost>,
  );
  if (options.suggestion) {
    const row = [...container.querySelectorAll<HTMLElement>("[data-agent-suggested-trigger]")].find(
      (entry) => entry.textContent?.includes(options.suggestion!),
    )!;
    await act(async () => button(row, "Set up").click());
  } else {
    await act(async () => button(container, "Add trigger").click());
  }
  await flush();
  const dialog = document.body.querySelector<HTMLElement>("[role='dialog']")!;
  return { agent, client, dialog, path: () => path, state: () => state };
}

function createdTask(client: { calls: unknown[][] }) {
  return client.calls.find((call) => call[0] === "createScheduledTask")?.[2] as
    | Record<string, any>
    | undefined;
}

test("a suggested trigger is set up in place: its source is filled in and no message is needed", async () => {
  const { agent, client, dialog } = await openAgentTrigger({
    eventSources: [GITHUB_SOURCE],
    suggestion: "When a GitHub issue opens",
  });
  expect(dialog.textContent).toContain("When a GitHub issue opens");
  expect(dialog.textContent).toContain("Visible to the workspace.");
  expect(dialog.textContent).toContain("Acme GitHub");
  // The message is optional and starts at the suggestion's.
  expect(dialog.querySelector("textarea")!.value).toBe("Triage it.");
  await act(async () => button(dialog, "Add trigger").click());
  await flush();
  const request = createdTask(client)!;
  expect(request.name).toBe("Triage: When a GitHub issue opens");
  expect(request.visibility).toBe("workspace");
  expect(request.runMode).toBe("new_session_per_run");
  expect(request.schedule).toEqual({ type: "manual" });
  expect(request.agentConfig.agentId).toBe(agent.id);
  expect(request.agentConfig.prompt).toBe("Triage it.");
  expect(request.events.triggers).toEqual([
    expect.objectContaining({ sourceId: "source-gh", eventTypes: ["issues.opened"] }),
  ]);
  // The new trigger is listed and its suggestion isn't offered again.
  expect(document.body.querySelector("[role='dialog']")).toBeNull();
  expect(document.body.querySelectorAll("[data-agent-trigger]").length).toBe(1);
  expect(
    [...document.body.querySelectorAll("[data-agent-suggested-trigger]")].map(
      (row) => row.textContent,
    ),
  ).toEqual([expect.stringContaining("When a Linear issue is created")]);
});

test("a suggestion's GitHub source is added on save once GitHub is connected", async () => {
  const { client, dialog } = await openAgentTrigger({
    suggestion: "When a GitHub issue opens",
    githubStatus: "bound",
  });
  expect(dialog.querySelector("[data-agent-trigger-setup='create']")?.textContent).toContain(
    "GitHub",
  );
  await act(async () => button(dialog, "Add trigger").click());
  await flush();
  const added = client.calls.find((call) => call[0] === "createEventSource");
  expect(added?.[2]).toEqual({ kind: "github" });
  expect(createdTask(client)!.events.triggers[0].sourceId).toEqual(expect.any(String));
});

test("without GitHub connected, connecting it is the one action", async () => {
  const { client, dialog, path } = await openAgentTrigger({
    suggestion: "When a GitHub issue opens",
    githubStatus: "unbound",
  });
  expect(dialog.querySelector("[data-agent-trigger-setup='connect_github']")).not.toBeNull();
  expect(dialog.querySelector("textarea")).toBeNull();
  await act(async () => button(dialog, "Connect GitHub").click());
  await flush();
  expect(decodeURIComponent(path())).toBe(
    `/workspaces/${WORKSPACE_ID}/plugins?open=integration:github`,
  );
  expect(createdTask(client)).toBeUndefined();
});

test("a kind that needs its own setup opens Add a source at that kind", async () => {
  const { client, dialog, path } = await openAgentTrigger({
    suggestion: "When a Linear issue is created",
  });
  expect(dialog.querySelector("[data-agent-trigger-setup='add_source']")?.textContent).toContain(
    "Linear",
  );
  await act(async () => button(dialog, "Add Linear").click());
  await flush();
  expect(path()).toBe(`/workspaces/${WORKSPACE_ID}/automations/sources/new?kind=linear`);
  expect(createdTask(client)).toBeUndefined();
});

test("a blank trigger on a schedule saves with the default message, Only me like its agent", async () => {
  const { client, dialog } = await openAgentTrigger({
    agent: { visibility: "private", ownerSubjectId: "user-me" },
    eventTriggers: false,
  });
  expect(dialog.textContent).toContain("Each run starts a new chat with Triage. Only you see it.");
  expect(dialog.querySelector("[role='radiogroup']")).toBeNull();
  await act(async () => button(dialog, "Add trigger").click());
  await flush();
  const request = createdTask(client)!;
  expect(request.visibility).toBe("private");
  expect(request.agentConfig.prompt).toBe("Do your scheduled work.");
  expect(request.schedule.type).toBe("calendar");
  expect(request.name).toStartWith("Triage: ");
});

function pickTrigger(dialog: HTMLElement, key: string) {
  const tile = dialog.querySelector<HTMLButtonElement>(`[data-agent-trigger-option='${key}']`);
  if (!tile) throw new Error(`no trigger option ${key}`);
  return act(async () => tile.click());
}

test("the picker lists a schedule, the person's sources and every kind of source", async () => {
  const { client, dialog } = await openAgentTrigger({ eventSources: [GITHUB_SOURCE] });
  const options = [...dialog.querySelectorAll<HTMLElement>("[data-agent-trigger-option]")].map(
    (tile) => tile.dataset.agentTriggerOption,
  );
  expect(options[0]).toBe("schedule");
  expect(options).toContain("source:source-gh");
  for (const kind of ["slack", "gmail", "linear", "webhook", "mcp"]) {
    expect(options).toContain(`new:${kind}`);
  }
  // Nothing is picked yet; saving says so.
  expect(dialog.querySelector("textarea")).toBeNull();
  await act(async () => button(dialog, "Add trigger").click());
  await flush();
  expect(createdTask(client)).toBeUndefined();
  expect(dialog.textContent).toContain("Choose what starts it.");
  // A source asks for its events before saving.
  await pickTrigger(dialog, "source:source-gh");
  await flush();
  expect(dialog.querySelector("textarea")?.placeholder).toBe("Handle this event.");
  await act(async () => button(dialog, "Add trigger").click());
  await flush();
  expect(createdTask(client)).toBeUndefined();
});

test("Create a webhook makes its URL right there, then its events start the agent", async () => {
  const { client, dialog } = await openAgentTrigger({});
  await pickTrigger(dialog, "new:webhook");
  await flush();
  expect(dialog.querySelector("[data-agent-trigger-setup='create_webhook']")).not.toBeNull();
  await act(async () => button(dialog, "Create webhook").click());
  await flush();
  expect(client.calls.find((call) => call[0] === "createEventSource")?.[2]).toEqual(
    expect.objectContaining({ kind: "webhook", adapter: "standard", visibility: "workspace" }),
  );
  const shown = [
    ...dialog.querySelectorAll<HTMLInputElement>("[data-agent-trigger-webhook] input"),
  ].map((input) => input.value);
  expect(shown).toEqual([expect.stringContaining("https://hooks.example.com/"), "whsec_test"]);
  expect(document.body.querySelector("[role='dialog']")).not.toBeNull();
  expect(button(dialog, "Add trigger")).toBeTruthy();
});

test("Linear's webhook is made in place and takes its secret in one field, never shown again", async () => {
  const { client, dialog } = await openAgentTrigger({});
  await pickTrigger(dialog, "new:linear");
  await flush();
  expect(dialog.querySelector("[data-agent-trigger-setup='create_pasted']")).not.toBeNull();
  await act(async () => button(dialog, "Add Linear").click());
  await flush();
  const request = client.calls.find((call) => call[0] === "createEventSource")?.[2];
  expect(request).toEqual(expect.objectContaining({ kind: "webhook", adapter: "custom" }));
  expect(request).not.toHaveProperty("signingSecret");
  // The URL to paste into Linear, and one field for the secret it shows.
  const secretStep = dialog.querySelector<HTMLElement>("[data-agent-trigger-secret]")!;
  expect(secretStep).not.toBeNull();
  const url = secretStep.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea, input");
  expect(url?.value).toContain("https://hooks.example.com/");
  const field = secretStep.querySelector<HTMLInputElement>("input[type='password']")!;
  expect(field).not.toBeNull();
  expect(dialog.querySelector("textarea")).toBeNull();
  // Too short: refused here, nothing sent.
  await act(async () => setValue(field, "short"));
  await act(async () => button(dialog, "Save secret").click());
  await flush();
  expect(client.calls.some((call) => call[0] === "updateEventSource")).toBe(false);
  expect(dialog.textContent).toContain("Paste the signing secret Linear shows.");
  await act(async () => setValue(field, "  lin_wh_secret_value_123  "));
  await act(async () => button(dialog, "Save secret").click());
  await flush();
  const update = client.calls.find((call) => call[0] === "updateEventSource");
  expect(update?.[3]).toEqual({ signingSecret: "lin_wh_secret_value_123" });
  // Saved: the value is gone from the dialog; it only says the secret is set.
  expect(dialog.querySelector("[data-agent-trigger-secret]")).toBeNull();
  expect(dialog.innerHTML).not.toContain("lin_wh_secret_value_123");
  expect(dialog.querySelector("[data-agent-trigger-secret-set]")?.textContent).toContain(
    "Signing secret set.",
  );
  expect(button(dialog, "Add trigger")).toBeTruthy();
  // Replace opens an empty field again, and Keep current goes back.
  await act(async () => button(dialog, "Replace").click());
  await flush();
  const again = dialog.querySelector<HTMLInputElement>(
    "[data-agent-trigger-secret] input[type='password']",
  );
  expect(again?.value).toBe("");
  await act(async () => button(dialog, "Keep current signing secret").click());
  await flush();
  expect(dialog.querySelector("[data-agent-trigger-secret]")).toBeNull();
});

async function chooseFrom(dialog: HTMLElement, current: string, option: string) {
  const trigger = [...dialog.querySelectorAll<HTMLElement>("[role='combobox']")].find((entry) =>
    entry.textContent?.includes(current),
  );
  if (!trigger) throw new Error(`no menu showing ${current}`);
  await act(async () => trigger.click());
  await flush();
  const items = [...document.querySelectorAll<HTMLElement>("[role='option']")];
  const offered = items.map((entry) => entry.textContent);
  const item = items.find((entry) => entry.textContent?.includes(option));
  if (!item) throw new Error(`no option ${option}`);
  await act(async () => item.click());
  await flush();
  return offered;
}

test("a trigger's runs start a new chat by default, or continue one of this agent's chats", async () => {
  const { agent, client, dialog } = await openAgentTrigger({
    eventSources: [GITHUB_SOURCE],
    suggestion: "When a GitHub issue opens",
    sessions: (agentId) => [
      { id: "chat-triage", title: "Weekly triage", agentId },
      { id: "chat-other", title: "Someone else's agent", agentId: "another-agent" },
      { id: "chat-plain", title: "Plain chat", agentId: null },
    ],
  });
  expect(dialog.textContent).toContain("Each run starts a new chat with Triage");
  await chooseFrom(dialog, "New chat each run", "An existing chat");
  // Only chats with this agent are offered, and one must be picked.
  await act(async () => button(dialog, "Add trigger").click());
  await flush();
  expect(createdTask(client)).toBeUndefined();
  expect(dialog.textContent).toContain("Choose a chat.");
  expect(await chooseFrom(dialog, "Choose a chat", "Weekly triage")).toEqual([
    expect.stringContaining("Weekly triage"),
  ]);
  expect(dialog.textContent).toContain("Each run continues a chat with Triage");
  await act(async () => button(dialog, "Add trigger").click());
  await flush();
  const request = createdTask(client)!;
  expect(request.runMode).toBe("existing_session");
  expect(request.targetSessionId).toBe("chat-triage");
  expect(request.agentConfig.agentId).toBe(agent.id);
});

test("a shared trigger the person may not add says so in the dialog", async () => {
  const forbidden = Object.assign(new Error("Opengeni API 403: missing permission"), {
    status: 403,
  });
  const { dialog } = await openAgentTrigger({
    eventSources: [GITHUB_SOURCE],
    suggestion: "When a GitHub issue opens",
    createTaskError: forbidden,
  });
  await act(async () => button(dialog, "Add trigger").click());
  await flush();
  expect(dialog.textContent).toContain(AGENT_TRIGGER_SHARED_DENIED);
  expect(document.body.querySelector("[role='dialog']")).not.toBeNull();
});

test("a suggestion's source that can't be added says why, not the shared-automation refusal", async () => {
  const forbidden = Object.assign(new Error("Opengeni API 403: missing permission"), {
    status: 403,
  });
  const { client, dialog } = await openAgentTrigger({
    suggestion: "When a GitHub issue opens",
    githubStatus: "bound",
    createSourceError: forbidden,
  });
  await act(async () => button(dialog, "Add trigger").click());
  await flush();
  expect(client.calls.some((call) => call[0] === "createEventSource")).toBe(true);
  expect(createdTask(client)).toBeUndefined();
  expect(dialog.textContent).not.toContain(AGENT_TRIGGER_SHARED_DENIED);
  expect(dialog.textContent).toContain(userErrorText(forbidden));
  expect(document.body.querySelector("[role='dialog']")).not.toBeNull();
});

test("a paused GitHub source shows greyed with why, and GitHub isn't offered as new", async () => {
  const { dialog } = await openAgentTrigger({
    eventSources: [
      { ...GITHUB_SOURCE, status: "disabled", statusReasonCode: "turned_off", statusReason: null },
    ],
  });
  const tile = dialog.querySelector<HTMLButtonElement>(
    "[data-agent-trigger-option='source:source-gh']",
  )!;
  expect(tile.disabled).toBe(true);
  expect(tile.textContent).toContain("Turned off.");
  expect(dialog.querySelector("[data-agent-trigger-option='new:github']")).toBeNull();
  await act(async () => tile.click());
  await flush();
  expect(tile.getAttribute("aria-checked")).toBe("false");
});

test("Open full form starts the form at the source picked", async () => {
  const { dialog, path } = await openAgentTrigger({ eventSources: [GITHUB_SOURCE] });
  await pickTrigger(dialog, "source:source-gh");
  await flush();
  const link = dialog.querySelector<HTMLButtonElement>("[data-agent-trigger-full-form]")!;
  await act(async () => link.click());
  await flush();
  const url = new URL(path(), "https://example.test");
  expect(url.pathname).toBe(`/workspaces/${WORKSPACE_ID}/automations/new`);
  expect(url.searchParams.get("source")).toBe("source-gh");
  expect(url.searchParams.get("returnTo")).toBe("agent");
});

test("Open full form keeps the note and chat choice, out of the address", async () => {
  const { dialog, path, state } = await openAgentTrigger({
    eventSources: [GITHUB_SOURCE],
    suggestion: "When a GitHub issue opens",
    sessions: (agentId) => [{ id: "chat-3", title: "Old triage", agentId }],
  });
  const note = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    const setNative = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setNative.call(note, "Label it and reply");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await chooseFrom(dialog, "New chat each run", "An existing chat");
  await chooseFrom(dialog, "Choose a chat", "Old triage");
  const link = dialog.querySelector<HTMLButtonElement>("[data-agent-trigger-full-form]")!;
  await act(async () => link.click());
  await flush();
  expect(state().agentTriggerStart).toEqual({
    note: "Label it and reply",
    chat: { mode: "existing_session", sessionId: "chat-3" },
  });
  expect(path()).not.toContain("Label");
});

test("An existing chat lists the agent's chats, filtered by the server, across pages", async () => {
  const { dialog } = await openAgentTrigger({
    eventSources: [GITHUB_SOURCE],
    suggestion: "When a GitHub issue opens",
    chatsPageSize: 2,
    sessions: (agentId) => [
      { id: "chat-1", title: "Other 1", agentId: "another-agent" },
      { id: "chat-2", title: "Other 2", agentId: null },
      { id: "chat-3", title: "New triage", agentId },
      { id: "chat-4", title: "Mid triage", agentId },
      { id: "chat-5", title: "Old triage", agentId },
    ],
  });
  await chooseFrom(dialog, "New chat each run", "An existing chat");
  expect(await chooseFrom(dialog, "Choose a chat", "Old triage")).toEqual([
    expect.stringContaining("New triage"),
    expect.stringContaining("Mid triage"),
    expect.stringContaining("Old triage"),
  ]);
});

test("An existing chat that can't be read says so, not that there are none", async () => {
  const { dialog } = await openAgentTrigger({
    eventSources: [GITHUB_SOURCE],
    suggestion: "When a GitHub issue opens",
    chatsError: new Error("Opengeni API 500: down"),
  });
  await chooseFrom(dialog, "New chat each run", "An existing chat");
  expect(dialog.textContent).toContain("Couldn't load chats with Triage.");
  expect(dialog.textContent).not.toContain("No chats with Triage yet.");
  expect(button(dialog, "Try again")).toBeTruthy();
});

test("a listed GitHub connection's row also offers Opengeni's own GitHub tools", async () => {
  const agent = makeAgent({
    name: "Fixer",
    toolPermissions: [{ connector: "github.com", tool: "*", permission: "ask" }],
  });
  const client = fakeAgentsClient([agent], {
    capabilities: [
      {
        id: "cap-github",
        name: "GitHub MCP",
        kind: "mcp",
        source: "integration",
        enabled: true,
        providerDomain: "github.com",
        connectionRef: { providerDomain: "github.com" },
        tools: [{ kind: "mcp", id: "github" }],
      },
    ],
    connectorTools: { "cap-github": ["search_code"] },
  });
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <AgentPage workspaceId={WORKSPACE_ID} agentId={agent.id} />
    </AgentsTestHost>,
  );
  await flush();
  const rows = container.querySelectorAll<HTMLElement>("[data-agent-can-use='github.com']");
  expect(rows).toHaveLength(1);
  const perTool = [...rows[0]!.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Choose per tool"),
  )!;
  await act(async () => perTool.click());
  await flush();
  expect(rows[0]!.textContent).toContain("search_code");
  // The toggle names the tool list it opens.
  expect(document.getElementById(perTool.getAttribute("aria-controls")!)?.textContent).toContain(
    "search_code",
  );
  expect(rows[0]!.textContent).toContain("pull_request_merge");
});

test("Add agent offers every ready-made agent's content file not yet added here", async () => {
  const keys = [
    "triage",
    "bug-fixer",
    "pr-reviewer",
    "cve-scanner",
    "incident-responder",
    "dependency-updater",
  ];
  const templates = await Promise.all(
    keys.map(
      async (key) =>
        (await import(`../../core/src/agent-templates/${key}.agent.json`)).default as {
          name: string;
          description: string;
        },
    ),
  );
  const client = fakeAgentsClient([makeAgent({ name: "Triage", templateKey: "triage" })], {
    templates,
  });
  const container = await render(
    <AgentsTestHost context={appContext(client)}>
      <AgentsPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  await flush();
  const text = container.textContent ?? "";
  // Triage is already here, so it isn't offered again.
  expect(text).not.toContain(templates[0]!.description);
  for (const template of templates.slice(1)) {
    expect(text).toContain(template.name);
    expect(text).toContain(template.description);
  }
});

test("Add agent offers ready-made agents first and adds one", async () => {
  const client = fakeAgentsClient([], { templates: [TRIAGE_TEMPLATE] });
  let path = "";
  const container = await render(
    <AgentsTestHost context={appContext(client)} onLocation={(location) => (path = location.href)}>
      <AgentsPage workspaceId={WORKSPACE_ID} />
    </AgentsTestHost>,
  );
  expect(container.textContent).toContain("Add agent");
  expect(container.textContent).toContain("Sorts new issues");
  const triage = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find(
    (item) => item.textContent?.includes("Triage"),
  )!;
  await act(async () => triage.click());
  await flush();
  expect(client.calls).toContainEqual(["createAgentFromTemplate", WORKSPACE_ID, "triage"]);
  const created = [...client.agents.values()][0]!;
  expect(path).toBe(`/workspaces/${WORKSPACE_ID}/agents/${created.id}`);
});
