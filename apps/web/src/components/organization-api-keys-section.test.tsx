import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

import type { ApiKey } from "@/types";

const toastSuccess = mock((_message: string) => undefined);
const toastError = mock((_message: string) => undefined);

mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    {
      success: toastSuccess,
      error: toastError,
    },
  ),
}));

mock.module("@/components/ui/destructive-confirm", () => ({
  DestructiveConfirm: ({
    open,
    title,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    confirmLabel: string;
    onConfirm: () => unknown;
  }) =>
    open ? (
      <div data-testid="revoke-api-key-dialog">
        <span>{title}</span>
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

// Radix detects DOM availability at import time, before the first render.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { OrganizationApiKeysSection } = await import("./organization-api-keys-section");

const timestamp = "2026-08-20T10:00:00.000Z";

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: null,
    name: "Deployment automation",
    description: "Deploys the production service",
    prefix: "og_org_live",
    permissions: ["workspace:read"],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const match = Array.from(root.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("organization API keys section", () => {
  test.each([
    ["Developer setup", { preset: "developer_setup" }, "expires after 24 hours"],
    ["Read only", { access: "read" }, "Can't create or change anything"],
  ] as const)(
    "submits the exact %s choice on the existing create page",
    async (label, choice, hint) => {
      const createApiKey = mock(async () => ({ apiKey: key(), token: "og_setup_shown_once" }));
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <OrganizationApiKeysSection
            organizationId="22222222-2222-4222-8222-222222222222"
            canManage
            view="new-key"
            onViewChange={() => undefined}
            listApiKeys={async () => []}
            createApiKey={createApiKey}
            deleteApiKey={async () => key()}
          />,
        );
      });
      const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]');
      if (!trigger) throw new Error("Missing access picker");
      await act(async () => trigger.click());
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (candidate) => candidate.textContent?.startsWith(label),
      );
      if (!option) throw new Error(`Missing access choice: ${label}`);
      expect(document.body.textContent).not.toContain("All permissions");
      await act(async () => option.click());
      expect(container.textContent).toContain(hint);
      if (label === "Developer setup") {
        expect(container.textContent).toContain("broad workspace administration");
      }
      await act(async () => container.querySelector("form")!.requestSubmit());
      await flush();
      expect(createApiKey).toHaveBeenCalledWith({ name: "Organization automation", ...choice });
      await act(async () => root.unmount());
      container.remove();
    },
  );

  test("explains the boundary and shows the one-time secret on the create page", async () => {
    const created = key({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Organization automation",
      prefix: "og_org_new",
    });
    const listApiKeys = mock(async () => [] as ApiKey[]);
    const createApiKey = mock(async () => ({ apiKey: created, token: "og_secret_full_value" }));
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => void copied.push(value) },
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <OrganizationApiKeysSection
          organizationId="22222222-2222-4222-8222-222222222222"
          canManage
          listApiKeys={listApiKeys}
          createApiKey={createApiKey}
          deleteApiKey={async () => created}
        />,
      );
    });
    await flush();

    expect(listApiKeys).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("never Personal ones");
    // The integration guide starts collapsed below the keys.
    expect(container.textContent).toContain("Integration guide");
    expect(container.textContent).not.toContain("memoryEnabled");
    expect(container.textContent).toContain("No organization API keys yet");
    await act(async () => button(container, "Create API key").click());
    const form = container.querySelector("form");
    if (!form) throw new Error("Missing Create API key page");
    expect(container.textContent).toContain("can't open Personal workspaces");
    expect(container.textContent).not.toContain("workspace:read");
    await act(async () => form.requestSubmit());
    await flush();

    expect(createApiKey).toHaveBeenCalledWith({
      name: "Organization automation",
    });
    expect(container.textContent).toContain("API key created");
    expect(container.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value).toBe(
      "og_secret_full_value",
    );
    expect(container.textContent).toContain("won't be able to see it again");
    expect(container.textContent).toContain("OPENGENI_API_KEY");
    expect(container.textContent).toContain(
      "Organization API key created. Copy it before you leave this page.",
    );

    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy new API key"]',
    );
    if (!copy) throw new Error("Missing copy button");
    await act(async () => copy.click());
    await flush();
    expect(copied).toEqual(["og_secret_full_value"]);

    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();
    expect(container.textContent).not.toContain("og_secret_full_value");
    expect(container.textContent).toContain("Organization automation");

    await act(async () => root.unmount());
    container.remove();
  });

  test("lists and revokes an active key through a destructive confirmation", async () => {
    const existing = key();
    const deleteApiKey = mock(async () => ({ ...existing, revokedAt: timestamp }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationApiKeysSection
          organizationId="22222222-2222-4222-8222-222222222222"
          canManage
          listApiKeys={async () => [existing]}
          createApiKey={async () => ({ apiKey: existing, token: "unused" })}
          deleteApiKey={deleteApiKey}
        />,
      );
    });
    await flush();

    expect(container.textContent).toContain("Deployment automation");
    expect(container.textContent).toContain("1 active");
    const revoke = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Revoke organization API key Deployment automation"]',
    );
    if (!revoke) throw new Error("Missing revoke button");
    await act(async () => revoke.click());
    const confirmation = document.body.querySelector('[data-testid="revoke-api-key-dialog"]');
    if (!confirmation) throw new Error("Missing revoke confirmation");
    expect(confirmation.textContent).toContain("Deployment automation");
    await act(async () => button(confirmation, "Revoke key").click());
    await flush();

    expect(deleteApiKey).toHaveBeenCalledWith(existing.id);
    expect(container.textContent).toContain("Revoked");
    expect(container.textContent).toContain("No active keys");
    // A revoked key keeps its row but can't be revoked again.
    expect(
      container.querySelector(
        'button[aria-label="Revoke organization API key Deployment automation"]',
      ),
    ).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  test("does not present a permission-denied list as an empty organization", async () => {
    const listApiKeys = mock(async () => [key()]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationApiKeysSection
          organizationId="22222222-2222-4222-8222-222222222222"
          canManage={false}
          listApiKeys={listApiKeys}
          createApiKey={async () => ({ apiKey: key(), token: "unused" })}
          deleteApiKey={async () => key()}
        />,
      );
    });
    await flush();

    expect(listApiKeys).not.toHaveBeenCalled();
    expect(container.textContent).toContain("You can't manage organization API keys");
    expect(container.textContent).not.toContain("No organization API keys yet");
    expect(container.textContent).not.toContain("No active keys");

    await act(async () => root.unmount());
    container.remove();
  });

  test("announces a failed initial read without claiming there are no keys", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationApiKeysSection
          organizationId="22222222-2222-4222-8222-222222222222"
          canManage
          listApiKeys={async () => {
            throw new Error("service unavailable");
          }}
          createApiKey={async () => ({ apiKey: key(), token: "unused" })}
          deleteApiKey={async () => key()}
        />,
      );
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load organization API keys");
    expect(container.textContent).not.toContain("No organization API keys yet");
    expect(container.textContent).not.toContain("No active keys");

    await act(async () => root.unmount());
    container.remove();
  });
});
