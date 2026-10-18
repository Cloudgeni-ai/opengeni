import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError, type InstallVaultProviderResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { ConnectProviderPage } = await import("./connect-provider");
const { TooltipProvider } = await import("@/components/ui/tooltip");
type Actions = Parameters<typeof ConnectProviderPage>[0]["actions"];

afterAll(() => {
  GlobalRegistrator.unregister();
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const PENDING: InstallVaultProviderResponse = {
  connectionId: "keeper-connection",
  provider: "keeper",
  accountName: "Opengeni agents",
  operations: {
    createVault: false,
    createItem: true,
    updateItem: true,
    archiveItem: false,
    restoreItem: false,
    archiveKind: "none",
    fieldHistory: false,
    createTypes: ["login"],
    updateFiles: false,
    totp: false,
  } as unknown as InstallVaultProviderResponse["operations"],
  vaults: [],
  discoveryPending: true,
  errorCode: "provider_unavailable",
};

function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
}

function button(label: string): HTMLButtonElement | undefined {
  return buttons().find((each) => each.textContent?.trim() === label);
}

async function setUp(actions: Partial<Actions>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ConnectProviderPage
          provider="keeper"
          owners={["workspace"]}
          organizationName="Acme"
          onClose={() => undefined}
          actions={actions as Actions}
        />
      </TooltipProvider>,
    ),
  );
  await flush();
  const input = container.querySelector<HTMLInputElement>('input[name="secret"]');
  if (!input) throw new Error("Missing token field");
  input.value = "US:one-time-token";
  const form = input.closest("form");
  if (!form) throw new Error("Missing form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
  return {
    container,
    cleanUp: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("Keeper setup that saved its device but didn't finish", () => {
  test("a refused saved access reconnects this connection, never a second setup", async () => {
    let installs = 0;
    const renewed: string[] = [];
    const { container, cleanUp } = await setUp({
      install: async () => {
        installs += 1;
        return PENDING;
      },
      verify: async () => {
        // The API's own shape: `{ error, message }` with the contract status.
        throw new OpenGeniApiError(
          401,
          JSON.stringify({
            error: "provider_auth_invalid",
            message: "Saved configuration refused.",
          }),
          { mutation: true },
        );
      },
      renew: (connectionId) => {
        renewed.push(connectionId);
      },
    });
    // The token form is gone: a spent one-time token is never asked for here.
    expect(container.querySelector('input[name="secret"]')).toBeNull();
    expect(container.textContent).toContain("You don't need a new token.");
    const finish = button("Finish connecting");
    if (!finish) throw new Error("Missing Finish connecting");
    await act(async () => finish.click());
    await flush();
    expect(container.textContent).toContain("Keeper no longer accepts the saved access.");
    expect(button("Finish connecting")).toBeUndefined();
    const reconnect = button("Reconnect");
    if (!reconnect) throw new Error("Missing Reconnect");
    await act(async () => reconnect.click());
    expect(renewed).toEqual(["keeper-connection"]);
    expect(installs).toBe(1);
    await cleanUp();
  });

  test("a provider that still doesn't answer keeps Finish connecting", async () => {
    let verifies = 0;
    const { container, cleanUp } = await setUp({
      install: async () => PENDING,
      verify: async () => {
        verifies += 1;
        return PENDING;
      },
      renew: () => undefined,
    });
    const finish = button("Finish connecting");
    if (!finish) throw new Error("Missing Finish connecting");
    await act(async () => finish.click());
    await flush();
    expect(verifies).toBe(1);
    expect(button("Finish connecting")).toBeDefined();
    expect(button("Reconnect")).toBeUndefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Keeper");
    await cleanUp();
  });
});
