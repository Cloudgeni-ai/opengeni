import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SlackAgentUpdateSettings } from "@opengeni/sdk";
import type { ReactNode } from "react";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
import * as SonnerPackage from "sonner";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "66666666-6666-4666-8666-666666666666";

const toasts: string[] = [];
const mutableContext: { current: Record<string, unknown> } = { current: {} };
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => mutableContext.current,
}));
mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(() => undefined, {
    success: (message: string) => toasts.push(message),
    error: (message: string) => toasts.push(message),
  }),
}));

const { SlackAgentUpdatesSection } = await import("./slack-agent-updates-section");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const connection = {
  id: CONNECTION_ID,
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  status: "active",
  metadata: {},
} as never;

function settings(overrides: Partial<SlackAgentUpdateSettings> = {}): SlackAgentUpdateSettings {
  return {
    connectionId: CONNECTION_ID,
    updatesEnabled: false,
    channelPostsOnly: false,
    announcementChannelId: null,
    viewerCanManage: true,
    updatedAt: null,
    ...overrides,
  };
}

async function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function switchNamed(host: ParentNode, label: string) {
  const match = host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
  if (!match) throw new Error(`Missing switch: ${label}`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("Slack update messages settings", () => {
  test("an organization admin turns updates on and sends a preview", async () => {
    const saves: unknown[] = [];
    const previews: unknown[] = [];
    mutableContext.current = {
      client: {
        getOpenGeniSlackAgentUpdateSettings: async () => settings(),
        listOpenGeniSlackReactionChannels: async () => ({ channels: [], nextCursor: null }),
        setOpenGeniSlackAgentUpdateSettings: async (
          _workspaceId: string,
          request: { updatesEnabled: boolean; channelPostsOnly: boolean },
        ) => {
          saves.push(request);
          return settings(request);
        },
        previewOpenGeniSlackAgentUpdate: async (workspaceId: string, request: unknown) => {
          previews.push({ workspaceId, request });
          return { kind: "update", slackUserId: "U1", agentIds: [] };
        },
      },
    };
    const view = await render(<SlackAgentUpdatesSection connection={connection} />);
    expect(view.host.textContent).toContain("Update messages");
    const updates = switchNamed(view.host, "Tell people about new agents");
    expect(updates.getAttribute("aria-checked")).toBe("false");
    await click(updates);
    expect(saves).toEqual([
      { connectionId: CONNECTION_ID, updatesEnabled: true, channelPostsOnly: false },
    ]);
    expect(
      switchNamed(view.host, "Tell people about new agents").getAttribute("aria-checked"),
    ).toBe("true");
    await click(switchNamed(view.host, "Channel posts only"));
    expect(saves.at(-1)).toEqual({
      connectionId: CONNECTION_ID,
      updatesEnabled: true,
      channelPostsOnly: true,
    });
    // Channel posts only means no direct messages at all.
    expect(
      switchNamed(view.host, "Tell people about new agents").getAttribute("aria-checked"),
    ).toBe("false");

    const previewButton = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Send me a preview",
    );
    expect(previewButton).toBeDefined();
    await click(previewButton!);
    expect(previews).toEqual([
      { workspaceId: WORKSPACE_ID, request: { connectionId: CONNECTION_ID } },
    ]);
    expect(toasts.at(-1)).toBe("Preview sent to your Slack messages");
    await view.unmount();
  });

  test("other people see the settings but can't change them or preview", async () => {
    let saved = false;
    mutableContext.current = {
      client: {
        getOpenGeniSlackAgentUpdateSettings: async () =>
          settings({ updatesEnabled: true, viewerCanManage: false }),
        setOpenGeniSlackAgentUpdateSettings: async () => {
          saved = true;
          return settings();
        },
      },
    };
    const view = await render(<SlackAgentUpdatesSection connection={connection} />);
    const updates = switchNamed(view.host, "Tell people about new agents");
    expect(updates.getAttribute("aria-checked")).toBe("true");
    expect(updates.getAttribute("aria-disabled")).toBe("true");
    await click(updates);
    expect(saved).toBe(false);
    expect(view.host.textContent).not.toContain("Send me a preview");
    const announce = view.host.querySelector<HTMLButtonElement>(
      '[data-slot="select-menu-trigger"][aria-label="Announce new agents in"]',
    );
    expect(announce?.disabled || announce?.getAttribute("aria-disabled") === "true").toBe(true);
    await view.unmount();
  });

  test("an organization admin picks the channel new agents are announced in", async () => {
    const saves: Record<string, unknown>[] = [];
    let current = settings();
    mutableContext.current = {
      client: {
        getOpenGeniSlackAgentUpdateSettings: async () => current,
        listOpenGeniSlackReactionChannels: async () => ({
          channels: [
            { id: "C0RANDOM", name: "random", isPrivate: false },
            { id: "C0ANNOUNCE", name: "announcements", isPrivate: false },
          ],
          nextCursor: null,
        }),
        setOpenGeniSlackAgentUpdateSettings: async (
          _workspaceId: string,
          request: Record<string, unknown>,
        ) => {
          saves.push(request);
          current = settings(request as Partial<SlackAgentUpdateSettings>);
          return current;
        },
      },
    };
    const view = await render(<SlackAgentUpdatesSection connection={connection} />);
    const trigger = () =>
      view.host.querySelector<HTMLButtonElement>(
        '[data-slot="select-menu-trigger"][aria-label="Announce new agents in"]',
      )!;
    expect(trigger().textContent).toContain("No channel");
    await click(trigger());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const labels = [...document.querySelectorAll('[role="option"]')].map((option) =>
      option.textContent?.trim(),
    );
    // Sorted by name, after "No channel".
    expect(labels).toEqual(["No channel", "#announcements", "#random"]);
    const announcements = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes("#announcements"),
    )!;
    await click(announcements);
    expect(saves.at(-1)).toEqual({
      connectionId: CONNECTION_ID,
      updatesEnabled: false,
      channelPostsOnly: false,
      announcementChannelId: "C0ANNOUNCE",
    });
    expect(trigger().textContent).toContain("#announcements");
    await view.unmount();
  });
});
