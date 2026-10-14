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
});
