import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
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

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="create-api-key-dialog">{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
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

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("organization API keys section", () => {
  test("explains the boundary and keeps the one-time secret in the create dialog", async () => {
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
    expect(container.textContent).toContain(
      "Organization API keys can access organization workspaces, never personal workspaces.",
    );
    expect(container.textContent).toContain("22222222-2222-4222-8222-222222222222");
    expect(container.textContent).toContain("client.ensureWorkspace");
    expect(container.textContent).toContain("No organization API keys yet");
    await act(async () => button(container, "Create Organization API Key").click());
    const dialog = document.body.querySelector('[data-testid="create-api-key-dialog"]');
    if (!dialog) throw new Error("Missing create API key dialog");
    expect(dialog.textContent).toContain("Provision and manage all organization workspaces");
    expect(dialog.textContent).not.toContain("workspace:read");
    expect(dialog.querySelector("[autofocus]")).toBeNull();
    await act(async () => button(dialog, "Create Organization API Key").click());
    await flush();

    expect(createApiKey).toHaveBeenCalledWith({
      name: "Organization automation",
    });
    expect(dialog.textContent).toContain("Organization API Key Created");
    expect(dialog.textContent).toContain("og_secret_full_value");
    expect(dialog.textContent).toContain("It will not be shown again");
    expect(dialog.textContent).toContain("OPENGENI_ORGANIZATION_API_KEY");
    expect(container.textContent).toContain("Organization automation");
    expect(container.textContent).toContain(
      "Organization API key created. Copy the full secret before closing.",
    );

    await act(async () => button(dialog, "Copy API key").click());
    await flush();
    expect(copied).toEqual(["og_secret_full_value"]);
    expect(container.textContent).toContain("API key copied.");
    expect(dialog.textContent).toContain("Copied");

    await act(async () => button(dialog, "Done").click());
    expect(container.textContent).not.toContain("og_secret_full_value");

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
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Revoke organization API key Deployment automation"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });
});
