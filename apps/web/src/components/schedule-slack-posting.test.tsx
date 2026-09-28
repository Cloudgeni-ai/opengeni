import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OPENGENI_SLACK_BOT_REQUESTED_SCOPES } from "@opengeni/contracts";
import type { ConnectionMetadata, SlackReactionChannelListResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(channelId = "", onChange = mock(() => {})) {
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
        onChange={onChange}
      />,
    );
    await flush();
  });
  return { container, onChange, root };
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

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

describe("ScheduleSlackPosting", () => {
  test("a person picks one bot channel; the only bot is used implicitly", async () => {
    const { container, onChange, root } = await render();
    expect(container.textContent).toContain("Post to Slack");
    expect(container.textContent).toContain("Off");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
      await flush();
    });
    expect(listScheduledTaskSlackChannels).toHaveBeenCalledWith(WORKSPACE_ID, BOT_ID, undefined);
    const selects = container.querySelectorAll<HTMLSelectElement>("select");
    // A single installed bot needs no workspace picker.
    expect(selects).toHaveLength(1);
    expect([...selects[0]!.options].map((option) => option.textContent)).toEqual([
      "Don't post",
      "#daily-updates",
      "#ops (private)",
    ]);
    await act(async () => {
      selects[0]!.value = "C0SCHED01";
      selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ connectionId: BOT_ID, channelId: "C0SCHED01" });
    await act(async () => root.unmount());
  });

  test("shows the chosen channel by name when closed", async () => {
    const { container, root } = await render("C0SCHED01");
    expect(container.textContent).toContain("Posts to #daily-updates as the OpenGeni bot");
    await act(async () => root.unmount());
  });

  test("people who cannot manage connections cannot change the channel", async () => {
    context.accessContext = accessContext(["scheduled_tasks:manage", "connections:read"]);
    const { container, root } = await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
      await flush();
    });
    expect(container.textContent).toContain("Only people who can manage connections");
    expect(container.querySelector("select")).toBeNull();
    expect(listScheduledTaskSlackChannels).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
