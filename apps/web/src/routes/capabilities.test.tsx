import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { AccessContext } from "@/types";
import { canInstallOpenGeniSlackBot, SlackBotInstallControls } from "./capabilities";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function renderControls(props: Partial<Parameters<typeof SlackBotInstallControls>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onInstall = mock((_createNewConnection: boolean) => {});

  await act(async () => {
    root.render(
      <SlackBotInstallControls
        canInstall={true}
        hasConnection={false}
        busy={false}
        onInstall={onInstall}
        {...props}
      />,
    );
  });

  return {
    container,
    onInstall,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function accessContext(permissions: string[]): AccessContext {
  return {
    workspaceGrants: [{ workspaceId: "workspace-a", permissions }],
    accountGrants: [],
  } as AccessContext;
}

describe("OpenGeni Slack bot install controls", () => {
  test("uses the authoritative workspace permission grant", () => {
    expect(canInstallOpenGeniSlackBot(accessContext(["connections:read"]), "workspace-a")).toBe(
      false,
    );
    expect(canInstallOpenGeniSlackBot(accessContext(["connections:write"]), "workspace-a")).toBe(
      true,
    );
    expect(canInstallOpenGeniSlackBot(accessContext(["workspace:admin"]), "workspace-a")).toBe(
      true,
    );
  });

  test("renders no actionable install control without connections:write", async () => {
    const rendered = await renderControls({ canInstall: false, hasConnection: true });

    try {
      expect(rendered.container.querySelector("[data-opengeni-slack-install]")).toBeNull();
      expect(rendered.container.querySelectorAll("button")).toHaveLength(0);
      expect(rendered.container.textContent).not.toContain("Install another Slack workspace/bot");
    } finally {
      await rendered.unmount();
    }
  });

  test("keeps install and reinstall actions available to authorized users", async () => {
    const initial = await renderControls();

    try {
      const install = initial.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Install OpenGeni in Slack"]',
      );
      expect(install).not.toBeNull();
      await act(async () => install!.click());
      expect(initial.onInstall).toHaveBeenCalledWith(false);
    } finally {
      await initial.unmount();
    }

    const connected = await renderControls({ hasConnection: true });

    try {
      const reinstall = connected.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Reinstall OpenGeni in Slack"]',
      );
      const installAnother = [
        ...connected.container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Install another Slack workspace/bot");
      expect(reinstall).not.toBeNull();
      expect(installAnother).not.toBeUndefined();

      await act(async () => reinstall!.click());
      await act(async () => installAnother!.click());
      expect(connected.onInstall).toHaveBeenNthCalledWith(1, false);
      expect(connected.onInstall).toHaveBeenNthCalledWith(2, true);
    } finally {
      await connected.unmount();
    }
  });
});
