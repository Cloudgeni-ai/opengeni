import { afterEach, beforeEach, expect, test } from "bun:test";
import { mountWithRealScheduling, registerDom } from "./render-hook";

registerDom();
const { SessionIntegrationCapabilityCard } =
  await import("../src/components/session-integration-capability-card");

// The card polls its sign-in window on a timer, so it renders with real
// browser scheduling and the test waits in real time.
async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`${message}\n${document.body.textContent}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A sign-in window that shows the provider's site: the card can see whether
 * it is open but can't read or close it. */
function providerWindow() {
  return {
    opener: {} as unknown,
    closed: false,
    location: {
      replace() {},
      get href(): string {
        throw new Error("cross-origin");
      },
    },
    close() {},
    focus() {},
  };
}

let windows: ReturnType<typeof providerWindow>[] = [];
let previousOpen: PropertyDescriptor | undefined;
beforeEach(() => {
  windows = [];
  previousOpen = Object.getOwnPropertyDescriptor(window, "open");
  Object.defineProperty(window, "open", {
    configurable: true,
    value: () => {
      const opened = providerWindow();
      windows.push(opened);
      return opened;
    },
  });
});
afterEach(() => {
  if (previousOpen) Object.defineProperty(window, "open", previousOpen);
  else Reflect.deleteProperty(window, "open");
});

/** A Connect backend whose attempt waits for sign-in until `finish()`. */
function backend() {
  const definitionId = "microsoft-outlook-mail";
  let revision = 0;
  let current: Record<string, unknown> | null = null;
  let connected = false;
  const attempt = (overrides: Record<string, unknown>) => {
    revision += 1;
    current = {
      id: "attempt-1",
      workspaceId: "ws-1",
      providerId: definitionId,
      ownership: "personal",
      revision,
      state: "requires_user_action",
      nextAction: { type: "none" },
      credentialsCommitted: false,
      integrationInstalled: false,
      completionRequirement: "integration",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    };
    return structuredClone(current);
  };
  const transport = {
    catalog: async () => [
      {
        id: definitionId,
        label: "Outlook Mail",
        family: "microsoft",
        readiness: "available",
        ownership: ["personal"],
        setup: ["oauth"],
      },
    ],
    accounts: async () => [],
    pending: async () => [],
    begin: async () =>
      attempt({ nextAction: { type: "authorize", url: "https://login.example.com/authorize" } }),
    recover: async () => structuredClone(current),
    get: async () => structuredClone(current),
    advance: async () => structuredClone(current),
    cancel: async () => attempt({ state: "cancelled", nextAction: { type: "none" } }),
    disconnect: async () => {},
  };
  const client = {
    connectTransport: () => transport,
    listApiIntegrations: async () => ({
      integrations: connected
        ? [
            {
              definitionId,
              ownership: "personal",
              connected: true,
              serverId: "server-1",
              instanceKey: "outlook",
              displayName: "Outlook Mail",
              instanceVersion: 1,
            },
          ]
        : [],
    }),
    getSession: async () => ({ id: "session-1", tools: [], toolPolicy: { mode: "default" } }),
    updateSessionToolPolicy: async () => ({}),
    continueAfterCapabilitySetup: async () => ({ outcome: "queued", updateId: "update-1" }),
  };
  return {
    client,
    finish() {
      connected = true;
      attempt({
        state: "complete",
        credentialsCommitted: true,
        integrationInstalled: true,
        nextAction: { type: "none" },
      });
    },
  };
}

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );

function card(client: unknown) {
  return (
    <SessionIntegrationCapabilityCard
      client={client as never}
      workspaceId="ws-1"
      sessionId="session-1"
      capabilityId="api:integration:microsoft-outlook-mail"
      name="Outlook Mail"
      returnUrl="https://app.example.com/chat"
    />
  );
}

async function startSignIn() {
  await waitFor(
    () => button("Connect Outlook Mail")?.disabled === false,
    "The Connect button did not render",
  );
  button("Connect Outlook Mail")!.click();
  await waitFor(
    () => text().includes("Finish signing in to Outlook Mail"),
    "The card did not wait for the sign-in window",
  );
}

test("every line about the sign-in window stays true while it shows", async () => {
  const view = mountWithRealScheduling(card(backend().client));
  try {
    await startSignIn();
    // The person closes the window (or the provider cuts the card off from it).
    windows[0]!.closed = true;
    await waitFor(
      () =>
        text().includes(
          "Finish signing in to Outlook Mail. If you closed the sign-in window, open it again.",
        ),
      "The card kept saying to finish in a window it can't see",
    );
    // It can't tell a closed window from one the provider cut off, so it
    // never says the window closed, and it keeps waiting.
    expect(text()).not.toContain("in the window that opened");
    expect(document.querySelector(".og-session-capability-spinner")).not.toBeNull();
    button("Open sign-in window")!.click();
    await waitFor(
      () => text().includes("Finish signing in to Outlook Mail"),
      "Opening the window again did not resume waiting",
    );
    expect(windows.length).toBe(2);
    // Cancel can't close a window showing the provider's site, so the card
    // asks the person to, and drops that once the window is gone.
    button("Cancel")!.click();
    await waitFor(
      () => text().includes("You can close the sign-in window."),
      "Cancel did not ask to close the window it couldn't close",
    );
    windows[1]!.closed = true;
    await waitFor(
      () => !text().includes("You can close the sign-in window."),
      "The reminder stayed after the window closed",
    );
  } finally {
    await view.unmount();
  }
});

test("keyboard focus stays on the card once the account is connected", async () => {
  const fake = backend();
  const view = mountWithRealScheduling(card(fake.client));
  try {
    await startSignIn();
    (document.activeElement as HTMLElement | null)?.blur();
    fake.finish();
    await waitFor(
      () => text().includes("Your account is connected"),
      "The card did not show the connected account",
    );
    await waitFor(
      () => document.activeElement?.textContent === "Your account is connected",
      "Focus fell back to the page after connecting",
    );
  } finally {
    await view.unmount();
  }
});
