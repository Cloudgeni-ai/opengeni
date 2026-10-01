import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OPENGENI_SLACK_BOT_REQUESTED_SCOPES } from "@opengeni/contracts";
import type { ConnectionMetadata, SlackReactionChannelListResponse } from "@opengeni/sdk";

// Register the DOM before React DOM and Radix load: Radix picks a no-op layout
// effect when it is imported without a document, and the menu never mounts.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const WORKSPACE_ID = "workspace-a";
const BOT_ID = "33333333-3333-4333-8333-333333333333";

const listConnections = mock(
  async (_workspaceId: string): Promise<ConnectionMetadata[]> => [botConnection()],
);
const listScheduledTaskSlackChannels = mock(
  async (
    _workspaceId: string,
    _connectionId: string,
    _cursor?: string,
  ): Promise<SlackReactionChannelListResponse> => ({
    channels: [
      { id: "C0SCHED01", name: "daily-updates", isPrivate: false },
      { id: "G0PRIVATE1", name: "ops", isPrivate: true },
    ],
    nextCursor: null,
  }),
);

const context = {
  client: { listConnections, listScheduledTaskSlackChannels },
  accessContext: accessContext(["scheduled_tasks:manage", "connections:read", "connections:write"]),
};

mock.module("@/context", () => ({ useAppContext: () => context }));

const { ScheduleSlackPosting } = await import("./schedule-slack-posting");

function accessContext(permissions: string[]) {
  return { workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions }] };
}

function botConnection(): ConnectionMetadata {
  const now = "2026-09-28T08:00:00.000Z";
  return {
    id: BOT_ID,
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: WORKSPACE_ID,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    status: "active",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
    verifiedInstallAt: now,
    verifiedInstallVersion: 1,
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {
      credentialRole: "opengeni_slack_bot",
      credentialLabel: "OpenGeni Slack bot",
      slackTeamId: "T0TEAM01",
      slackTeamName: "Example team",
      botId: "B0BOT01",
      botUserId: "U0BOT01",
      botDisplayName: "OpenGeni",
    },
    createdBySubjectId: "user:admin",
    updatedBySubjectId: "user:admin",
    createdAt: now,
    updatedAt: now,
  } as ConnectionMetadata;
}

// Radix mounts the menu content a tick after it opens.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function render(channelId = "", onChange = mock(() => {}), active = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ScheduleSlackPosting
        workspaceId={WORKSPACE_ID}
        connectionId=""
        channelId={channelId}
        disabled={false}
        active={active}
        onChange={onChange}
      />,
    );
    await flush();
  });
  return { container, onChange, root };
}

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
  listConnections.mockClear();
  listScheduledTaskSlackChannels.mockClear();
  context.accessContext = accessContext([
    "scheduled_tasks:manage",
    "connections:read",
    "connections:write",
  ]);
});

function optionLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => option.textContent ?? "",
  );
}

async function openChannelMenu(container: HTMLElement): Promise<HTMLButtonElement> {
  const triggers = container.querySelectorAll<HTMLButtonElement>('[role="combobox"]');
  const trigger = triggers[triggers.length - 1]!;
  await act(async () => {
    trigger.click();
    await flush();
  });
  return trigger;
}

describe("ScheduleSlackPosting", () => {
  test("a person picks one bot channel; the only bot is used implicitly", async () => {
    const { container, onChange, root } = await render();
    expect(container.textContent).toContain("Post to Slack");
    expect(listScheduledTaskSlackChannels).toHaveBeenCalledWith(WORKSPACE_ID, BOT_ID, undefined);
    // A single installed bot needs no workspace picker.
    expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(1);
    expect(container.textContent).toContain("Don't post");
    await openChannelMenu(container);
    const labels = optionLabels();
    expect(labels[0]).toContain("Don't post");
    expect(labels[1]).toContain("#daily-updates");
    expect(labels[2]).toContain("#ops");
    expect(labels[2]).toContain("Private");
    await act(async () => {
      document.querySelectorAll<HTMLElement>('[role="option"]')[1]!.click();
      await flush();
    });
    expect(onChange).toHaveBeenCalledWith({ connectionId: BOT_ID, channelId: "C0SCHED01" });
    await act(async () => root.unmount());
  });

  test("channels load only once the section is open or a channel is chosen", async () => {
    const closed = await render(
      "",
      mock(() => {}),
      false,
    );
    expect(listScheduledTaskSlackChannels).not.toHaveBeenCalled();
    await act(async () => closed.root.unmount());

    const chosen = await render(
      "C0SCHED01",
      mock(() => {}),
      false,
    );
    expect(listScheduledTaskSlackChannels).toHaveBeenCalledTimes(1);
    expect(chosen.container.textContent).toContain("#daily-updates");
    await act(async () => chosen.root.unmount());
  });

  test("choosing Don't post clears the channel", async () => {
    const { container, onChange, root } = await render("C0SCHED01");
    await openChannelMenu(container);
    await act(async () => {
      document.querySelectorAll<HTMLElement>('[role="option"]')[0]!.click();
      await flush();
    });
    expect(onChange).toHaveBeenCalledWith({ connectionId: "", channelId: "" });
    await act(async () => root.unmount());
  });

  test("people who cannot manage connections cannot change the channel", async () => {
    context.accessContext = accessContext(["scheduled_tasks:manage", "connections:read"]);
    const { container, root } = await render();
    expect(container.textContent).toContain("Only people who can manage connections");
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(listScheduledTaskSlackChannels).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
