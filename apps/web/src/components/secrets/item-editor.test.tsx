import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { VaultSummary } from "@opengeni/react";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { ItemEditorPage } = await import("./item-editor");
const { TooltipProvider } = await import("@opengeni/react/ui/tooltip");

afterAll(() => {
  GlobalRegistrator.unregister();
});

// A fake token, assembled at runtime.
const TOKEN = `ghp_${"Ab1Cd2Ef3".repeat(4)}`;

const vault: VaultSummary = {
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
};

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  // happy-dom does not fire React's change event, so call the handler directly.
  const key = Object.keys(input).find((property) => property.startsWith("__reactProps$"))!;
  (input as unknown as Record<string, { onChange: (event: { target: HTMLInputElement }) => void }>)[
    key
  ]!.onChange({ target: input });
}

describe("item editor: a secret in a plain field", () => {
  test("a token typed into the username field offers Make concealed", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const noop = () => undefined;
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ItemEditorPage
            vault={vault}
            initialType="login"
            onClose={noop}
            onCreate={async () => undefined}
            onUpdate={async () => undefined}
            onReload={noop}
          />
        </TooltipProvider>,
      ),
    );
    const textInputs = () =>
      [...container.querySelectorAll<HTMLInputElement>("input")].filter(
        (input) => input.type === "text",
      );
    const label = [...container.querySelectorAll("label")].find((each) =>
      each.textContent?.startsWith("Username"),
    );
    const username = label?.htmlFor
      ? (container.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`) ?? undefined)
      : undefined;
    expect(username).toBeDefined();
    expect(container.textContent).not.toContain("Make concealed");

    await act(async () => typeInto(username!, "deploy-bot"));
    expect(container.textContent).not.toContain("Make concealed");

    await act(async () => typeInto(username!, TOKEN));
    expect(container.textContent).toContain("Looks like a GitHub token.");
    const button = [...container.querySelectorAll("button")].find(
      (each) => each.textContent === "Make concealed",
    );
    expect(button).toBeDefined();

    await act(async () => button!.click());
    expect(container.textContent).not.toContain("Make concealed");
    // The value is now in a concealed input, not shown as text.
    const stillText = textInputs().some((input) => input.value === TOKEN);
    expect(stillText).toBe(false);
    expect(
      [...container.querySelectorAll<HTMLInputElement>("input")].some(
        (input) => input.value === TOKEN,
      ),
    ).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });
});
