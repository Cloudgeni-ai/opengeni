import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { VaultSummary } from "@opengeni/react";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { VaultPage } = await import("./vault-page");
const { TooltipProvider } = await import("@/components/ui/tooltip");

afterAll(() => {
  GlobalRegistrator.unregister();
});

function vault(overrides: Partial<VaultSummary>): VaultSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "ws",
    ownerKind: "user",
    ownerLabel: "Ola Nordmann",
    rootSessionId: null,
    name: "Side projects",
    description: null,
    source: "opengeni",
    mode: "read_write",
    syncStatus: "ok",
    syncErrorCode: null,
    syncErrorMessage: null,
    lastSyncedAt: null,
    rateLimitedUntil: null,
    providerConnectionId: null,
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
    isDefault: false,
    itemCount: 0,
    canWrite: true,
    canManage: true,
    generation: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function menuItems(subject: VaultSummary, canManageAvailability: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const noop = () => undefined;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <VaultPage
          vault={subject}
          items={[]}
          itemsLoading={false}
          itemsError={null}
          organizationName="Acme"
          showArchived={false}
          onShowArchivedChange={noop}
          canManageAvailability={canManageAvailability}
          actions={{
            back: noop,
            newItem: noop,
            openItem: noop,
            rename: noop,
            editAvailability: noop,
            sync: async () => undefined,
            reconnect: noop,
            deleteVault: noop,
            retry: noop,
          }}
        />
      </TooltipProvider>,
    ),
  );
  await flush();
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="More actions for ${subject.name}"]`,
  );
  if (!trigger) throw new Error("Missing vault menu");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flush();
  const labels = Array.from(document.querySelectorAll("[role=menuitem]")).map((each) =>
    each.textContent?.trim(),
  );
  await act(async () => root.unmount());
  container.remove();
  return labels;
}

describe("vault page menu", () => {
  test("an Only-me vault's owner can open Available in from the vault page", async () => {
    expect(await menuItems(vault({ ownerKind: "user" }), true)).toContain("Available in…");
  });

  test("Available in stays hidden when the person can't choose it", async () => {
    expect(await menuItems(vault({ ownerKind: "user", isDefault: true }), false)).not.toContain(
      "Available in…",
    );
  });

  test("a password manager vault offers Sync now but no archived items", async () => {
    const labels = await menuItems(
      vault({ source: "protonpass", ownerKind: "workspace", lastSyncedAt: "2026-10-15T09:00:00Z" }),
      false,
    );
    expect(labels).toContain("Sync now");
    expect(labels.some((label) => label?.includes("archived"))).toBe(false);
  });
});

async function renderPage(subject: VaultSummary) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const noop = () => undefined;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <VaultPage
          vault={subject}
          items={[]}
          itemsLoading={false}
          itemsError={null}
          organizationName="Acme"
          showArchived={false}
          onShowArchivedChange={noop}
          canManageAvailability={false}
          actions={{
            back: noop,
            newItem: noop,
            openItem: noop,
            rename: noop,
            editAvailability: noop,
            sync: async () => undefined,
            deleteVault: noop,
            retry: noop,
          }}
        />
      </TooltipProvider>,
    ),
  );
  await flush();
  const text = container.textContent ?? "";
  const buttons = Array.from(container.querySelectorAll("button")).map((each) =>
    each.textContent?.trim(),
  );
  await act(async () => root.unmount());
  container.remove();
  return { text, buttons };
}

describe("vault page capabilities", () => {
  test("a provider that only takes some types says which", async () => {
    const { text, buttons } = await renderPage(
      vault({
        source: "protonpass",
        lastSyncedAt: "2026-10-15T09:00:00Z",
        providerOperations: {
          createItemTypes: ["login", "note"],
          updateItem: false,
          removeField: false,
          archiveItem: true,
          archiveKind: "trash",
          deleteItem: false,
          restoreItem: false,
          readFiles: true,
          writeFiles: false,
          createTotp: false,
          updateTotp: false,
          createVault: false,
          restoreFieldHistory: false,
        },
      }),
    );
    expect(text).toContain("Add a login or note.");
    expect(text).toContain("Change existing ones in Proton Pass.");
    expect(buttons).toContain("New item");
  });

  test("a read-only vault adds nothing and says where items change", async () => {
    const { text, buttons } = await renderPage(
      vault({ source: "keeper", mode: "read_only", lastSyncedAt: "2026-10-15T09:00:00Z" }),
    );
    expect(buttons).not.toContain("New item");
    expect(text).toContain("Items you add to this vault in Keeper show up here.");
  });

  test("a locked source that never listed is not an empty vault", async () => {
    const { text } = await renderPage(
      vault({ source: "bitwarden", syncStatus: "error", syncErrorCode: "provider_locked" }),
    );
    expect(text).toContain("No items to show yet");
    expect(text).not.toContain("No items yet");
  });
});
