import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OPENGENI_PERSONAL_SLACK_MCP_URL } from "@opengeni/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { PersonalSlackAccountState } from "@/lib/personal-slack";
import type { ConnectionMetadata } from "@/types";
import { PersonalSlackAccountCard } from "./personal-slack-account-card";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function connection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  const now = new Date("2026-07-31T12:00:00Z").toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    subjectId: "subject-a",
    providerDomain: "slack.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: ["search:read.public", "chat:write"],
    expiresAt: new Date("2026-08-01T12:00:00Z").toISOString(),
    lastRefreshAt: null,
    lastUsedAt: now,
    lastError: null,
    version: 1,
    metadata: { mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL },
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function renderCard(accountState: PersonalSlackAccountState) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onConnect = mock(() => {});
  const onReconnect = mock(() => {});
  const onDisconnect = mock(() => {});

  await act(async () => {
    root.render(
      <PersonalSlackAccountCard
        available
        canManage
        busy={false}
        accountState={accountState}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onDisconnect={onDisconnect}
      />,
    );
  });

  return {
    container,
    onConnect,
    onReconnect,
    onDisconnect,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("PersonalSlackAccountCard", () => {
  test("renders a subject-owned status without exposing its private row id", async () => {
    const rendered = await renderCard({
      state: "connected",
      connection: connection(),
      accessTokenRefreshDue: false,
    });
    try {
      expect(rendered.container.textContent).toContain("Personal · only you");
      expect(rendered.container.textContent).toContain("Connected");
      expect(rendered.container.textContent).toContain("search:read.public, chat:write");
      expect(rendered.container.textContent).not.toContain("11111111-1111-4111-8111-111111111111");
      expect(rendered.container.textContent).not.toContain("Required bot scopes");

      const buttons = [...rendered.container.querySelectorAll<HTMLButtonElement>("button")];
      await act(async () =>
        buttons.find((button) => button.textContent?.includes("Reconnect"))!.click(),
      );
      await act(async () =>
        buttons.find((button) => button.textContent?.includes("Disconnect"))!.click(),
      );
      expect(rendered.onReconnect).toHaveBeenCalledTimes(1);
      expect(rendered.onDisconnect).toHaveBeenCalledTimes(1);
      expect(rendered.onConnect).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });

  test("distinguishes refresh-pending, reconnect-required, and disconnected copy", async () => {
    const refreshPending = await renderCard({
      state: "connected",
      connection: connection(),
      accessTokenRefreshDue: true,
    });
    try {
      expect(refreshPending.container.textContent).toContain("Connected · refresh pending");
      expect(refreshPending.container.textContent).toContain("refresh it automatically on use");
    } finally {
      await refreshPending.unmount();
    }

    const reconnect = await renderCard({
      state: "reconnect_required",
      connection: connection({ status: "needs_reauth" }),
      reason: "expired",
    });
    try {
      expect(reconnect.container.textContent).toContain("Reconnect required");
      expect(reconnect.container.textContent).toContain("expired and could not be refreshed");
    } finally {
      await reconnect.unmount();
    }

    const disconnected = await renderCard({
      state: "disconnected",
      connection: connection({ status: "revoked" }),
    });
    try {
      expect(disconnected.container.textContent).toContain("Disconnected");
      expect(disconnected.container.textContent).toContain("Reconnect my Slack account");
      expect(disconnected.container.textContent).not.toContain("DisconnectDisconnect");
    } finally {
      await disconnected.unmount();
    }
  });
});
