import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { OPENGENI_SLACK_BOT_REQUESTED_SCOPES } from "@opengeni/contracts/slack-bot-scopes";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { AccessContext } from "@/types";
import {
  canInstallOpenGeniSlackBot,
  canManageSlackReactionSummon,
  canWriteWorkspaceConnections,
  SlackBotInstallControls,
  WorkspaceSlackBotRequestedScopes,
} from "./capabilities";

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

function accessContext(
  permissions: AccessContext["workspaceGrants"][number]["permissions"],
): AccessContext {
  return {
    mode: "managed",
    subjectId: "subject-a",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: "workspace-a",
        accountId: "account-a",
        subjectId: "subject-a",
        permissions,
      },
    ],
    defaultAccountId: "account-a",
    defaultWorkspaceId: "workspace-a",
  };
}

describe("OpenGeni Slack bot install controls", () => {
  test("renders every requested workspace-bot scope including read-only reactions", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<WorkspaceSlackBotRequestedScopes />));
      expect(container.textContent).toBe(OPENGENI_SLACK_BOT_REQUESTED_SCOPES.join(", "));
      expect(container.textContent).toContain("reactions:read");
      expect(container.textContent).not.toContain("reactions:write");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

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
    expect(canWriteWorkspaceConnections(accessContext(["connections:write"]), "workspace-a")).toBe(
      true,
    );
    expect(canManageSlackReactionSummon(accessContext(["connections:write"]), "workspace-a")).toBe(
      false,
    );
    expect(canManageSlackReactionSummon(accessContext(["workspace:admin"]), "workspace-a")).toBe(
      true,
    );
  });

  test("renders a disabled install control and administrator guidance without connections:write", async () => {
    const rendered = await renderControls({ canInstall: false });

    try {
      const install = rendered.container.querySelector<HTMLButtonElement>(
        "[data-opengeni-slack-install]",
      );
      expect(install?.disabled).toBe(true);
      expect(rendered.container.textContent).toContain(
        "Ask a workspace administrator or connection manager",
      );
      await act(async () => install!.click());
      expect(rendered.onInstall).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  test("renders a disabled reinstall control without offering another installation", async () => {
    const rendered = await renderControls({ canInstall: false, hasConnection: true });

    try {
      const buttons = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")];
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.textContent?.trim()).toBe("Reinstall");
      expect(buttons[0]?.disabled).toBe(true);
      expect(rendered.container.textContent).not.toContain("Install in another workspace");
      expect(rendered.container.textContent).toContain(
        "Ask a workspace administrator or connection manager",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("shows the Slack install badge only before installation", async () => {
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
      const buttons = [...connected.container.querySelectorAll<HTMLButtonElement>("button")];
      const reinstall = buttons.find((button) => button.textContent?.trim() === "Reinstall");
      const installAnother = [
        ...connected.container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Install in another workspace");
      expect(connected.container.querySelector("[data-opengeni-slack-install]")).toBeNull();
      expect(reinstall).not.toBeUndefined();
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
