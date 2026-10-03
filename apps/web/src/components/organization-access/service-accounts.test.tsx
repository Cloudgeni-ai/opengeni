import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ApiKey, OrganizationServiceAccount } from "@opengeni/sdk";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    { success: mock((_message: string) => undefined), error: mock(() => undefined) },
  ),
}));

mock.module("@/components/ui/destructive-confirm", () => ({
  DestructiveConfirm: ({
    open,
    title,
    consequences,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    consequences: ReactNode[];
    confirmLabel: string;
    onConfirm: () => unknown;
  }) =>
    open ? (
      <div data-testid="confirm">
        <span>{title}</span>
        {consequences.map((each) => (
          <span key={String(each)}>{each}</span>
        ))}
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { ServiceAccounts } = await import("./service-accounts");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const timestamp = "2026-09-01T10:00:00.000Z";
const bot: OrganizationServiceAccount = {
  id: "55555555-5555-4555-8555-555555555555",
  organizationId: "22222222-2222-4222-8222-222222222222",
  name: "Release bot",
  description: null,
  role: "admin",
  activeKeyCount: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const heldKey = {
  id: "66666666-6666-4666-8666-666666666666",
  accountId: bot.organizationId,
  workspaceId: null,
  name: "Release key",
  description: null,
  prefix: "og_org_rel",
  permissions: ["workspace:admin"],
  serviceAccount: { id: bot.id, name: bot.name, role: "admin" },
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
} as ApiKey;

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

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    mount: async () => {
      await act(async () => root.render(node));
      await flush();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("service accounts", () => {
  test("lists each service account with its role and keys; the row opens its page", async () => {
    const navigate = mock((_next: unknown) => undefined);
    const view = render(
      <ServiceAccounts
        api={{
          list: async () => [bot],
          get: async () => ({ ...bot, activeKeyCount: 1 }),
          create: async () => bot,
          update: async () => bot,
          remove: async () => undefined,
          listKeys: async () => [heldKey],
        }}
        canMakeAdmin
        location={{}}
        onNavigate={navigate}
        onCreateKey={() => undefined}
      />,
    );
    await view.mount();
    expect(view.container.textContent).toContain("Service accounts");
    expect(view.container.textContent).toContain("Release bot");
    expect(view.container.textContent).toContain("Admin · 1 key");
    await act(async () => button(view.container, "New service account").click());
    expect(navigate).toHaveBeenLastCalledWith({ view: "new-service-account" });
    await view.unmount();
  });

  test("its page shows the keys it holds, warns before narrowing them, and deletes with them", async () => {
    const update = mock(async (_id: string, request: { role?: string }) => ({
      ...bot,
      ...(request.role ? { role: request.role as "member" } : {}),
    }));
    const remove = mock(async (_id: string) => undefined);
    const navigate = mock((_next: unknown) => undefined);
    const createKey = mock((_id: string) => undefined);
    const view = render(
      <ServiceAccounts
        api={{
          list: async () => [bot],
          get: async () => ({ ...bot, activeKeyCount: 1 }),
          create: async () => bot,
          update,
          remove,
          listKeys: async () => [heldKey],
        }}
        canMakeAdmin
        location={{ serviceAccount: bot.id }}
        onNavigate={navigate}
        onCreateKey={createKey}
      />,
    );
    await view.mount();
    expect(view.container.textContent).toContain("Release key");
    await act(async () => button(view.container, "Create key").click());
    expect(createKey).toHaveBeenCalledWith(bot.id);

    const roleTrigger = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'),
    ).find((each) => each.textContent?.includes("Admin"));
    await act(async () => roleTrigger!.click());
    const member = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (each) => each.textContent?.startsWith("Member"),
    );
    await act(async () => member!.click());
    expect(view.container.textContent).toContain("Its keys lose administrator permissions");
    await act(async () => button(view.container, "Save").click());
    await flush();
    expect(update).toHaveBeenCalledWith(bot.id, { role: "member" });

    const more = view.container.querySelector<HTMLButtonElement>(
      `button[aria-label="More for ${bot.name}"]`,
    );
    await act(async () => {
      more!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    const deleteItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (each) => each.textContent?.trim() === "Delete",
    );
    await act(async () => deleteItem!.click());
    const confirm = document.querySelector('[data-testid="confirm"]')!;
    expect(confirm.textContent).toContain("Its 1 key stop working now.");
    await act(async () => button(confirm, "Delete").click());
    await flush();
    expect(remove).toHaveBeenCalledWith(bot.id);
    expect(navigate).toHaveBeenLastCalledWith({});
    await view.unmount();
  });
});
