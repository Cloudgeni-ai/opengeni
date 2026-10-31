import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SlackAgent } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { ReactNode } from "react";

// React reads the DOM when it loads (input events), so register first.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
import * as SonnerPackage from "sonner";

import * as DropdownModule from "@opengeni/react/ui/dropdown-menu";
import * as DestructiveModule from "@opengeni/react/app/components/ui/destructive-confirm";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "66666666-6666-4666-8666-666666666666";
const SECOND_CONNECTION_ID = "66666666-6666-4666-8666-666666666667";

const mutableContext: { current: Record<string, unknown> } = { current: {} };
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => mutableContext.current,
}));
mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }),
}));
mock.module("@opengeni/react/ui/dropdown-menu", () => ({
  ...DropdownModule,
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" role="menuitem" onClick={onSelect}>
      {children}
    </button>
  ),
}));
mock.module("@opengeni/react/app/components/ui/destructive-confirm", () => ({
  ...DestructiveModule,
  DestructiveConfirm: ({
    open,
    title,
    consequences,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    consequences?: ReactNode[];
    confirmLabel?: string;
    onConfirm?: () => unknown;
  }) =>
    open ? (
      <div data-testid="confirm">
        <h2>{title}</h2>
        <ul>
          {consequences?.map((line) => (
            <li key={String(line)}>{line}</li>
          ))}
        </ul>
        <button type="button" onClick={() => void onConfirm?.()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

const { SlackAgentsSection } = await import("./slack-agents");
const { SlackAgentFormPage, SlackAgentIntroPage } = await import("./slack-agent-form");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

function agent(overrides: Partial<SlackAgent> = {}): SlackAgent {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    connectionId: CONNECTION_ID,
    slackTeamId: "T1",
    slackTeamName: "Acme",
    targetWorkspaceId: WORKSPACE_ID,
    targetWorkspaceName: "Platform",
    name: "Data team",
    handle: "data-team",
    description: "Answers questions about our metrics.",
    avatar: { kind: "icon", icon: "database", hue: 215 },
    instructions: "",
    knowledgeCollectionId: null,
    open: false,
    version: 3,
    createdBySubjectId: "subject-a",
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
    viewerCanManage: true,
    memoryReviewFirst: false,
    ...overrides,
  };
}

function bot(id = CONNECTION_ID) {
  return {
    id,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    status: "active",
    metadata: {},
  } as never;
}

function setContext(client: Record<string, unknown>, organizationAdmin = false) {
  mutableContext.current = {
    client,
    workspaces: [
      { id: WORKSPACE_ID, accountId: ACCOUNT_ID, kind: "shared", name: "Platform" },
      { id: OTHER_WORKSPACE_ID, accountId: ACCOUNT_ID, kind: "shared", name: "Sales" },
    ],
    accessContext: {
      mode: "managed",
      subjectId: "subject-a",
      accountGrants: organizationAdmin
        ? [{ accountId: ACCOUNT_ID, subjectId: "subject-a", permissions: ["account:admin"] }]
        : [],
      workspaceGrants: [
        {
          workspaceId: WORKSPACE_ID,
          accountId: ACCOUNT_ID,
          subjectId: "subject-a",
          permissions: ["workspace:admin", "connections:write"],
        },
      ],
      defaultAccountId: ACCOUNT_ID,
      defaultWorkspaceId: WORKSPACE_ID,
    },
  };
}

async function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function buttonNamed(host: ParentNode, label: string) {
  const match = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(host: HTMLElement) {
  const form = host.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function state(agents: SlackAgent[] | undefined, routingEnabled = true) {
  return {
    agents,
    routingEnabled,
    memoryReviewFirst: false,
    error: null,
    reload: () => undefined,
    replace: () => undefined,
  };
}

describe("Slack agents section", () => {
  test("lists every agent with its workspace and how to call it", async () => {
    setContext({});
    const onEdit = mock(() => undefined);
    const view = await render(
      <SlackAgentsSection
        workspaceId={WORKSPACE_ID}
        state={state([
          agent(),
          agent({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            name: "Deal desk",
            handle: "deal-desk",
            targetWorkspaceId: OTHER_WORKSPACE_ID,
            targetWorkspaceName: "Sales",
            viewerCanManage: false,
          }),
        ])}
        canCreate
        onCreate={() => undefined}
        onEdit={onEdit}
        onIntroduce={() => undefined}
      />,
    );
    const text = view.host.textContent ?? "";
    expect(text).toContain("Data team");
    expect(text).toContain("@Opengeni +data-team");
    expect(text).toContain("Deal desk");
    expect(text).toContain("Sales");
    expect(text).toContain("@Opengeni +deal-desk");
    expect(buttonNamed(view.host, "Create agent")).toBeTruthy();
    // Only the manageable agent has Edit and Delete.
    const items = [...view.host.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent,
    );
    expect(items).toEqual(["Edit", "Introduce in channels", "Delete"]);
    await view.unmount();
  });

  test("delete confirms with what is removed and what stays", async () => {
    const deleteOpenGeniSlackAgent = mock(async () => ({ deleted: true }));
    setContext({ deleteOpenGeniSlackAgent });
    const view = await render(
      <SlackAgentsSection
        workspaceId={WORKSPACE_ID}
        state={state([agent()])}
        canCreate={false}
        onCreate={() => undefined}
        onEdit={() => undefined}
        onIntroduce={() => undefined}
      />,
    );
    expect(view.host.textContent).not.toContain("Create agent");
    await act(async () => buttonNamed(view.host, "Delete").click());
    const confirm = view.host.querySelector('[data-testid="confirm"]')!;
    expect(confirm.textContent).toContain("Delete Data team?");
    expect(confirm.textContent).toContain("Its channel settings are removed.");
    expect(confirm.textContent).toContain("Its chats stay.");
    await act(async () => buttonNamed(confirm, "Delete agent").click());
    expect(deleteOpenGeniSlackAgent).toHaveBeenCalledWith(WORKSPACE_ID, agent().id);
    await view.unmount();
  });

  test("shows nothing when there are no agents and the reader can't create one", async () => {
    setContext({});
    const view = await render(
      <SlackAgentsSection
        workspaceId={WORKSPACE_ID}
        state={state([])}
        canCreate={false}
        onCreate={() => undefined}
        onEdit={() => undefined}
        onIntroduce={() => undefined}
      />,
    );
    expect(view.host.textContent).toBe("");
    await view.unmount();
  });

  test("says when the server doesn't route channels, so agents don't answer", async () => {
    setContext({});
    const view = await render(
      <SlackAgentsSection
        workspaceId={WORKSPACE_ID}
        state={state([agent()], false)}
        canCreate
        onCreate={() => undefined}
        onEdit={() => undefined}
        onIntroduce={() => undefined}
      />,
    );
    expect(view.host.textContent).toContain("Slack agents don't answer");
    await view.unmount();
  });
});

describe("Slack agent form", () => {
  function form(
    props: Partial<Parameters<typeof SlackAgentFormPage>[0]> = {},
  ): Parameters<typeof SlackAgentFormPage>[0] {
    return {
      workspaceId: WORKSPACE_ID,
      workspaceName: "Platform",
      connections: [bot()],
      memoryReviewFirst: null,
      onClose: () => undefined,
      onSaved: () => undefined,
      ...props,
    };
  }

  async function fill(host: HTMLElement, name: string, description: string) {
    const inputs = [
      ...host.querySelectorAll<HTMLInputElement>("input[type=text], input:not([type])"),
    ];
    await type(inputs.find((input) => input.placeholder === "Data team")!, name);
    await type(
      inputs.find((input) => input.placeholder.startsWith("Answers questions"))!,
      description,
    );
  }

  test("creates an agent with the one Opengeni bot, showing how people call it", async () => {
    const created = agent();
    const createOpenGeniSlackAgent = mock(async () => ({ agent: created }));
    setContext({ createOpenGeniSlackAgent });
    const onSaved = mock(() => undefined);
    const view = await render(<SlackAgentFormPage {...form({ onSaved })} />);
    expect(view.host.textContent).toContain("Works in Platform. This can't change later.");
    // One bot: no installation choice.
    expect(view.host.textContent).not.toContain("Slack workspace");
    expect(view.host.textContent).toContain("A Knowledge collection named after the agent");
    expect(view.host.textContent).not.toContain("saved for review first");
    await fill(view.host, "Data Team", "Answers questions about our metrics.");
    expect(view.host.textContent).toContain("People call it with @Opengeni +data-team");
    await submit(view.host);
    expect(createOpenGeniSlackAgent).toHaveBeenCalledWith(WORKSPACE_ID, {
      connectionId: CONNECTION_ID,
      name: "Data Team",
      description: "Answers questions about our metrics.",
      avatar: expect.objectContaining({ kind: "icon", icon: "bot" }),
      instructions: "",
    });
    expect(onSaved).toHaveBeenCalledWith(created, true);
    await view.unmount();
  });

  test("refuses a reserved name before asking the server", async () => {
    const createOpenGeniSlackAgent = mock(async () => ({ agent: agent() }));
    setContext({ createOpenGeniSlackAgent });
    const view = await render(<SlackAgentFormPage {...form()} />);
    await fill(view.host, "Help", "Helps.");
    await submit(view.host);
    expect(createOpenGeniSlackAgent).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain('"Help" already means something in Slack.');
    await view.unmount();
  });

  test("a taken name is shown on the name field", async () => {
    setContext({
      createOpenGeniSlackAgent: mock(async () => {
        throw new OpenGeniApiError(
          409,
          JSON.stringify({
            error: {
              code: "conflict",
              message: "Taken",
              details: { code: "slack_agent_name_taken" },
            },
          }),
        );
      }),
    });
    const view = await render(<SlackAgentFormPage {...form()} />);
    await fill(view.host, "Data team", "Answers.");
    await submit(view.host);
    expect(view.host.textContent).toContain("Another Slack agent is already called this.");
    await view.unmount();
  });

  test("offers an organization admin to turn on the bot here, then creates", async () => {
    let attempts = 0;
    const createOpenGeniSlackAgent = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new OpenGeniApiError(
          409,
          JSON.stringify({
            error: {
              code: "conflict",
              message: "No bot",
              details: { code: "slack_bot_unavailable" },
            },
          }),
        );
      }
      return { agent: agent() };
    });
    const getOpenGeniSlackBotOrganizationAccess = mock(async () => ({
      enabled: true,
      generation: 1,
      workspaceIds: [OTHER_WORKSPACE_ID],
    }));
    const setOpenGeniSlackBotOrganizationAccess = mock(async () => ({
      enabled: true,
      generation: 2,
      workspaceIds: [OTHER_WORKSPACE_ID, WORKSPACE_ID],
    }));
    setContext(
      {
        createOpenGeniSlackAgent,
        getOpenGeniSlackBotOrganizationAccess,
        setOpenGeniSlackBotOrganizationAccess,
      },
      true,
    );
    const onSaved = mock(() => undefined);
    const view = await render(<SlackAgentFormPage {...form({ onSaved })} />);
    await fill(view.host, "Data team", "Answers.");
    await submit(view.host);
    expect(view.host.textContent).toContain("The Opengeni bot isn't available in Platform");
    await act(async () => {
      buttonNamed(view.host, "Turn on and create").click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(setOpenGeniSlackBotOrganizationAccess).toHaveBeenCalledWith(
      WORKSPACE_ID,
      CONNECTION_ID,
      {
        enabled: true,
        workspaceIds: [OTHER_WORKSPACE_ID, WORKSPACE_ID],
      },
    );
    expect(createOpenGeniSlackAgent).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  test("tells everyone else to ask an organization admin", async () => {
    setContext({
      createOpenGeniSlackAgent: mock(async () => {
        throw new OpenGeniApiError(
          409,
          JSON.stringify({
            error: {
              code: "conflict",
              message: "No bot",
              details: { code: "slack_bot_unavailable" },
            },
          }),
        );
      }),
    });
    const view = await render(<SlackAgentFormPage {...form()} />);
    await fill(view.host, "Data team", "Answers.");
    await submit(view.host);
    expect(view.host.textContent).toContain(
      "Ask an organization admin to turn it on for Platform.",
    );
    expect(view.host.textContent).not.toContain("Turn on and create");
    await view.unmount();
  });

  test("asks which Slack workspace only when several bots are available", async () => {
    setContext({});
    const view = await render(
      <SlackAgentFormPage {...form({ connections: [bot(), bot(SECOND_CONNECTION_ID)] })} />,
    );
    expect(view.host.textContent).toContain("Slack workspace");
    await view.unmount();
  });

  test("edits only what changed and says new Memory waits for review", async () => {
    const existing = agent({ memoryReviewFirst: true, instructions: "Be brief." });
    const updateOpenGeniSlackAgent = mock(async () => ({ agent: existing }));
    setContext({ updateOpenGeniSlackAgent });
    const view = await render(<SlackAgentFormPage {...form({ agent: existing })} />);
    expect(view.host.textContent).toContain("Edit Data team");
    expect(view.host.textContent).toContain("New Memory is saved for review first.");
    await type(view.host.querySelector("textarea")!, "Be brief. Link the chart you used.");
    await submit(view.host);
    expect(updateOpenGeniSlackAgent).toHaveBeenCalledWith(WORKSPACE_ID, existing.id, {
      expectedVersion: 3,
      instructions: "Be brief. Link the chart you used.",
    });
    await view.unmount();
  });

  const OPEN_DISCLOSURE =
    "Anyone in Slack can ask Data team. Its answers can use anything it can read in the Platform workspace (Knowledge, files, chats, shared connections). What people tell it is visible to that workspace's members.";

  function openSwitch(host: HTMLElement) {
    const label = [...host.querySelectorAll("label")].find(
      (candidate) => candidate.textContent === "Anyone in Slack can use this agent",
    );
    if (!label) throw new Error("Missing open switch");
    return host.querySelector<HTMLElement>(`#${CSS.escape(label.htmlFor)}`)!;
  }

  test("an organization admin opens an agent to anyone in Slack, seeing what that means", async () => {
    const existing = agent();
    const updateOpenGeniSlackAgent = mock(async () => ({ agent: { ...existing, open: true } }));
    setContext({ updateOpenGeniSlackAgent }, true);
    const view = await render(<SlackAgentFormPage {...form({ agent: existing })} />);
    expect(view.host.textContent).toContain(OPEN_DISCLOSURE);
    const control = openSwitch(view.host);
    expect(
      control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true",
    ).toBe(false);
    await act(async () => control.click());
    await submit(view.host);
    expect(updateOpenGeniSlackAgent).toHaveBeenCalledWith(WORKSPACE_ID, existing.id, {
      expectedVersion: 3,
      open: true,
    });
    await view.unmount();
  });

  test("a workspace admin can't open an agent, but can close an open one", async () => {
    setContext({});
    const closed = await render(<SlackAgentFormPage {...form({ agent: agent() })} />);
    const locked = openSwitch(closed.host);
    expect(locked.hasAttribute("disabled") || locked.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    expect(closed.host.textContent).toContain("Only an organization admin can turn this on.");
    await closed.unmount();

    const existing = agent({ open: true });
    const updateOpenGeniSlackAgent = mock(async () => ({ agent: { ...existing, open: false } }));
    setContext({ updateOpenGeniSlackAgent });
    const view = await render(<SlackAgentFormPage {...form({ agent: existing })} />);
    expect(view.host.textContent).toContain(OPEN_DISCLOSURE);
    await act(async () => openSwitch(view.host).click());
    await submit(view.host);
    expect(updateOpenGeniSlackAgent).toHaveBeenCalledWith(WORKSPACE_ID, existing.id, {
      expectedVersion: 3,
      open: false,
    });
    await view.unmount();
  });
});

describe("Introduce in channels", () => {
  test("posts the intro and says where the Opengeni app is missing", async () => {
    const postOpenGeniSlackAgentIntro = mock(async () => ({
      results: [
        { channelId: "C1", status: "posted" as const },
        { channelId: "C2", status: "not_in_channel" as const },
      ],
    }));
    setContext({
      listOpenGeniSlackAgentChannels: mock(async () => ({
        channels: [
          { id: "C1", name: "data", isPrivate: false },
          { id: "C2", name: "leads", isPrivate: true },
        ],
        nextCursor: null,
      })),
      postOpenGeniSlackAgentIntro,
    });
    const view = await render(
      <SlackAgentIntroPage agent={agent()} justCreated onClose={() => undefined} />,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(view.host.textContent).toContain("Data team is ready.");
    expect(view.host.textContent).toContain("#data");
    expect(view.host.textContent).toContain("Private · leads");
    expect(buttonNamed(view.host, "Skip")).toBeTruthy();
    for (const checkbox of view.host.querySelectorAll<HTMLElement>(
      '[role="checkbox"], input[type="checkbox"]',
    )) {
      await act(async () => checkbox.click());
    }
    await submit(view.host);
    expect(postOpenGeniSlackAgentIntro).toHaveBeenCalledWith(WORKSPACE_ID, agent().id, {
      channelIds: ["C1", "C2"],
    });
    expect(view.host.textContent).toContain("Posted.");
    expect(view.host.textContent).toContain("Add the Opengeni app to this channel first.");
    await view.unmount();
  });
});
