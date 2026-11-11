import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError, type InstallVaultProviderResponse } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { ConnectProviderPage } = await import("./connect-provider");
const { TooltipProvider } = await import("@opengeni/react/ui/tooltip");
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

describe("Bitwarden setup refusals", () => {
  async function submitBitwarden(error: OpenGeniApiError) {
    const sent: unknown[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ConnectProviderPage
            provider="bitwarden"
            owners={["user"]}
            organizationName="Acme"
            onClose={() => undefined}
            actions={
              {
                install: async (request) => {
                  sent.push(request);
                  throw error;
                },
              } as Partial<Actions> as Actions
            }
          />
        </TooltipProvider>,
      ),
    );
    await flush();
    const field = (name: string) => {
      const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (!input) throw new Error(`Missing ${name}`);
      return input;
    };
    field("clientId").value = "user.6f1c3c1e-2b1a-4c55-9d1e-0a0b0c0d0e0f";
    field("secret").value = "client-secret-0123456789";
    field("masterPassword").value = "not the password";
    await act(async () => {
      field("secret")
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    const text = container.textContent ?? "";
    await act(async () => root.unmount());
    container.remove();
    return { sent, text };
  }

  const refusal = (status: number, code: string, message: string) =>
    new OpenGeniApiError(status, JSON.stringify({ error: code, message }), { mutation: true });

  test("a wrong master password is said on its field, not as a signed-out session", async () => {
    const { sent, text } = await submitBitwarden(
      refusal(
        401,
        "provider_auth_invalid",
        "The master password does not open this Bitwarden account",
      ),
    );
    expect(sent).toEqual([
      {
        ownership: "user",
        credentials: {
          provider: "bitwarden",
          serverUrl: "https://vault.bitwarden.com",
          clientId: "user.6f1c3c1e-2b1a-4c55-9d1e-0a0b0c0d0e0f",
          clientSecret: "client-secret-0123456789",
          masterPassword: "not the password",
        },
      },
    ]);
    expect(text).toContain("This master password doesn't open the account.");
    expect(text).not.toContain("session");
  });

  test("a refused API key and an unreachable server name their own fields", async () => {
    const key = await submitBitwarden(refusal(401, "provider_auth_invalid", "invalid_client"));
    expect(key.text).toContain("Bitwarden didn't accept this API key.");
    const server = await submitBitwarden(
      refusal(
        503,
        "provider_unavailable",
        "https://vault.bitwarden.com points its API at another site (api.example.net); Opengeni only sends the API key to the server you entered",
      ),
    );
    expect(server.text).toContain("points its API at another site");
  });
});
