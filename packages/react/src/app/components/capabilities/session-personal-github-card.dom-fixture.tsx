// Run explicitly through session-personal-github-card.test.tsx so Radix sees the DOM at import time.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

import type { AuthNeededItem } from "../../../timeline";

const assigned: string[] = [];
mock.module("../../lib/navigation", () => ({
  usePage: () => ({
    origin: () => window.location.origin,
    href: () => window.location.href,
    assign: (url: string) => void assigned.push(url),
  }),
}));

const connection = (status: "active" | "needs_reauth" | "revoked", githubLogin = "octocat") => ({
  id: "connection-1",
  version: 2,
  status,
  providerDomain: "github.com",
  kind: "oauth2",
  metadata: { githubLogin },
});
const everyone = ["connections:read", "connections:write"];
const context = {
  accessContext: {
    subjectId: "member",
    workspaceGrants: [{ workspaceId: "workspace", permissions: everyone }],
  },
  personalGitHubStatus: { enabled: true, connection: null, reviewUrl: null } as unknown,
  personalGitHubSelection: null as unknown,
  personalGitHubBusy: false,
  refreshPersonalGitHub: mock(async (_workspaceId: string) => {}),
  connectPersonalGitHub: mock(async (_workspaceId: string) => {}),
  reconnectPersonalGitHub: mock(async (_workspaceId: string) => {}),
};
mock.module("../../app-context", () => ({ useAppContext: () => context }));
GlobalRegistrator.register();
const { createRoot } = await import("react-dom/client");
const { SessionPersonalGitHubCapabilityCard } = await import("./session-personal-github-card");

const request = {
  id: "personal-github-request",
  kind: "auth-needed",
  serverId: "opengeni",
  providerDomain: "github.com",
  reason: "missing_connection",
  toolName: "capability_authorization_request",
  capability: {
    id: "api:github-personal",
    name: "Your GitHub",
    kind: "api",
    action: "connect",
    rationale: "Connect your GitHub so the pull request opens under your name.",
    requiredVariables: [],
  },
} as unknown as AuthNeededItem;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }).IS_REACT_ACT_ENVIRONMENT =
    true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  assigned.length = 0;
  context.personalGitHubStatus = { enabled: true, connection: null, reviewUrl: null };
  context.personalGitHubSelection = null;
  context.accessContext.workspaceGrants = [{ workspaceId: "workspace", permissions: everyone }];
  context.refreshPersonalGitHub.mockClear();
  context.connectPersonalGitHub.mockClear();
  context.reconnectPersonalGitHub.mockClear();
});

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SessionPersonalGitHubCapabilityCard item={request} workspaceId="workspace" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    text: () => container.textContent ?? "",
    buttons: () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].map((button) =>
        button.textContent?.trim(),
      ),
    click: async (name: string) => {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === name,
      );
      if (!button) throw new Error(`Missing button ${name}`);
      await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("Your GitHub card", () => {
  test("not connected: one Connect action that starts the personal GitHub flow", async () => {
    const card = await render();
    try {
      expect(card.text()).toContain("Your GitHub");
      expect(card.text()).toContain("pull request opens under your name");
      await card.click("Connect your GitHub");
      expect(context.connectPersonalGitHub).toHaveBeenCalledWith("workspace");
      expect(context.reconnectPersonalGitHub).not.toHaveBeenCalled();
    } finally {
      await card.unmount();
    }
  });

  test("a connection that needs attention reconnects; a revoked one connects again", async () => {
    context.personalGitHubStatus = {
      enabled: true,
      connection: connection("needs_reauth"),
      reviewUrl: null,
    };
    const card = await render();
    try {
      await card.click("Reconnect");
      expect(context.reconnectPersonalGitHub).toHaveBeenCalledWith("workspace");
    } finally {
      await card.unmount();
    }
    context.personalGitHubStatus = {
      enabled: true,
      connection: connection("revoked"),
      reviewUrl: null,
    };
    const revoked = await render();
    try {
      expect(revoked.buttons()).toContain("Connect your GitHub");
    } finally {
      await revoked.unmount();
    }
  });

  test("connected without repos: Choose repos opens the repository chooser", async () => {
    context.personalGitHubStatus = {
      enabled: true,
      connection: connection("active"),
      reviewUrl: null,
    };
    context.personalGitHubSelection = { repositories: [] };
    const card = await render();
    try {
      expect(card.text()).toContain(
        "Connected as @octocat. Choose the repos Opengeni may use as you.",
      );
      await card.click("Choose repos");
      expect(assigned).toEqual([
        "/workspaces/workspace/plugins?open=integration%3Agithub&github=personal",
      ]);
      expect(context.connectPersonalGitHub).not.toHaveBeenCalled();
    } finally {
      await card.unmount();
    }
  });

  test("connected with repos is complete and still lets the person change repos", async () => {
    context.personalGitHubStatus = {
      enabled: true,
      connection: connection("active"),
      reviewUrl: null,
    };
    context.personalGitHubSelection = { repositories: [{}, {}, {}] };
    const card = await render();
    try {
      expect(card.text()).toContain("Connected as @octocat · 3 repos");
      await card.click("Choose repos");
      expect(assigned).toHaveLength(1);
    } finally {
      await card.unmount();
    }
  });

  test("says why when the person can't connect here, and reads status when missing", async () => {
    context.accessContext.workspaceGrants = [
      { workspaceId: "workspace", permissions: ["connections:read"] },
    ];
    const card = await render();
    try {
      expect(card.text()).toContain("Your access doesn't allow connecting accounts");
      expect(card.buttons()).not.toContain("Connect your GitHub");
    } finally {
      await card.unmount();
    }
    context.personalGitHubStatus = { enabled: false, connection: null, reviewUrl: null };
    context.accessContext.workspaceGrants = [{ workspaceId: "workspace", permissions: everyone }];
    const disabled = await render();
    try {
      expect(disabled.text()).toContain("isn't available on this deployment");
    } finally {
      await disabled.unmount();
    }
    context.personalGitHubStatus = null;
    const unknown = await render();
    try {
      expect(context.refreshPersonalGitHub).toHaveBeenCalledWith("workspace");
    } finally {
      await unknown.unmount();
    }
  });
});
