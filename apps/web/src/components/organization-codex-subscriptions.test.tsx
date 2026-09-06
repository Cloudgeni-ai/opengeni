import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CodexAccount, OrganizationCodexAccountsResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

const organizationId = "11111111-1111-4111-8111-111111111111";
const activeAccountId = "22222222-2222-4222-8222-222222222222";
const inactiveAccountId = "33333333-3333-4333-8333-333333333333";

function account(id: string, label: string, active: boolean): CodexAccount {
  return {
    id,
    label,
    status: "active",
    active,
    allocatorEnabled: true,
    allocatorVersion: 1,
    appsDesignated: false,
    canEnableApps: false,
  };
}

const response: OrganizationCodexAccountsResponse = {
  accounts: [
    account(activeAccountId, "Primary subscription", true),
    account(inactiveAccountId, "Backup subscription", false),
  ],
  activeAccountId,
  settings: {
    rotationEnabled: false,
    rotationStrategy: "sharded",
    activeCredentialId: activeAccountId,
  },
};

const requestJson = mock(async (method: string, path: string, _body?: unknown) => {
  if (method === "GET" && path === `/v1/organizations/${organizationId}/codex/accounts`) {
    return response;
  }
  if (
    method === "POST" &&
    path === `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}/activate`
  ) {
    return undefined;
  }
  if (
    method === "DELETE" &&
    path === `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}`
  ) {
    return undefined;
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
const context = { client: { requestJson } };

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

mock.module("sonner", () => ({
  toast: { error: mock(() => undefined), success: mock(() => undefined) },
}));

const { OrganizationCodexSubscriptions } = await import("./organization-codex-subscriptions");

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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("organization Codex subscriptions", () => {
  test("sends explicit JSON bodies for activate and disconnect mutations", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<OrganizationCodexSubscriptions organizationId={organizationId} />);
      });
      await flush();

      const activate = container.querySelector<HTMLInputElement>(
        'input[aria-label="Use Backup subscription as the organization default"]',
      );
      expect(activate).not.toBeNull();
      await act(async () => activate!.click());
      await flush();

      expect(requestJson.mock.calls).toContainEqual([
        "POST",
        `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}/activate`,
        {},
      ]);

      const disconnect = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Disconnect Backup subscription"]',
      );
      expect(disconnect).not.toBeNull();
      await act(async () => disconnect!.click());
      await flush();

      expect(requestJson.mock.calls).toContainEqual([
        "DELETE",
        `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}`,
        {},
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
