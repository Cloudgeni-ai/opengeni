import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BrowserAccountsProvider, type BrowserAccountTransition } from "@opengeni/react/accounts";
import type {
  BrowserAccountsClientLike,
  ManagedAuthSessionSetProjection,
  SelectManagedAuthLoginSlotRequest,
} from "@opengeni/sdk/accounts";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  BrowserAccountsLoadingGate,
  BrowserAccountsSignedOutPanel,
} from "./browser-accounts-runtime";

const SLOT_ID = "00000000-0000-4000-8000-000000000001";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function projection(selected: boolean): ManagedAuthSessionSetProjection {
  return {
    mode: "broker",
    generation: selected ? "3" : "2",
    actorEpoch: selected ? "2" : "1",
    csrfToken: "c".repeat(43),
    selectedSlotId: selected ? SLOT_ID : null,
    state: selected ? "ready" : "actor_change_required",
    slots: [
      {
        id: SLOT_ID,
        displayName: "Account Beta",
        verifiedClaim: { kind: "email", value: "beta@example.test" },
        state: "active",
      },
    ],
  };
}

function emptyBrokerProjection(): ManagedAuthSessionSetProjection {
  return {
    mode: "broker",
    generation: "1",
    actorEpoch: "1",
    csrfToken: "c".repeat(43),
    selectedSlotId: null,
    state: "ready",
    slots: [],
  };
}

async function flush(): Promise<void> {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("signed-out browser account recovery", () => {
  test("offers broker-safe account creation without replacing isolated sign-in", async () => {
    const current = emptyBrokerProjection();
    const client: BrowserAccountsClientLike = {
      getSessionSet: async () => current,
      reconcileSessionSetAuthority: async () => current,
      bootstrapSessionSet: async () => current,
      beginLoginTransaction: async () => {
        throw new Error("not used");
      },
      completeEmailPasswordTransaction: async () => {
        throw new Error("not used");
      },
      cancelLoginTransaction: async () => current,
      selectLoginSlot: async () => current,
      logoutLoginSlot: async () => current,
      logoutSessionSet: async () => ({ generation: "2", actorEpoch: "2", state: "logged_out" }),
      resolveDeepLink: async () => ({ kind: "unavailable" }),
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <BrowserAccountsProvider
            client={client}
            broadcastChannelName={null}
            onActorTransition={async () => undefined}
          >
            <BrowserAccountsSignedOutPanel
              emptySetRegistrationPanel={<div data-registration="true">Sign up and resend</div>}
            />
          </BrowserAccountsProvider>,
        ),
      );
      await flush();

      expect(container.textContent).toContain("Continue with email");
      expect(container.textContent).toContain("Create an account");
      expect(container.querySelector('[data-registration="true"]')).toBeNull();
      const createAccount = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Create an account",
      );
      expect(createAccount).not.toBeUndefined();
      await act(async () => createAccount!.click());
      expect(container.querySelector('[data-registration="true"]')).not.toBeNull();
      expect(container.textContent).toContain("Back to sign in");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("requires an explicit slot choice after add leaves the sole slot unselected", async () => {
    let current = projection(false);
    const selections: SelectManagedAuthLoginSlotRequest[] = [];
    const transitions: BrowserAccountTransition[] = [];
    const client: BrowserAccountsClientLike = {
      getSessionSet: async () => current,
      reconcileSessionSetAuthority: async () => current,
      bootstrapSessionSet: async () => current,
      beginLoginTransaction: async () => {
        throw new Error("not used");
      },
      completeEmailPasswordTransaction: async () => {
        throw new Error("not used");
      },
      cancelLoginTransaction: async () => current,
      selectLoginSlot: async (request) => {
        selections.push(request);
        current = projection(true);
        return current;
      },
      logoutLoginSlot: async () => current,
      logoutSessionSet: async () => ({ generation: "4", actorEpoch: "3", state: "logged_out" }),
      resolveDeepLink: async () => ({ kind: "unavailable" }),
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <BrowserAccountsProvider
            client={client}
            broadcastChannelName={null}
            onActorTransition={async (transition) => {
              transitions.push(transition);
            }}
          >
            <BrowserAccountsSignedOutPanel />
          </BrowserAccountsProvider>,
        ),
      );
      await flush();

      expect(container.textContent).toContain("Choose an account");
      expect(container.textContent).toContain("beta@example.test");
      const select = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Continue as Account Beta"]',
      );
      expect(select).not.toBeNull();
      await act(async () => select!.click());
      await flush();

      expect(selections).toHaveLength(1);
      expect(selections[0]?.slotId).toBe(SLOT_ID);
      expect(selections[0]?.expectedGeneration).toBe("2");
      expect(transitions.length).toBeGreaterThanOrEqual(1);
      const selectionTransition = transitions.at(-1);
      expect(selectionTransition?.from).toBeNull();
      expect(selectionTransition?.to?.selectedSlotId).toBe(SLOT_ID);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("hides the prior tenant surface while an accepted actor change settles", async () => {
    let current = projection(false);
    let releaseSelection!: () => void;
    const selectionSettled = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const client: BrowserAccountsClientLike = {
      getSessionSet: async () => current,
      reconcileSessionSetAuthority: async () => current,
      bootstrapSessionSet: async () => current,
      beginLoginTransaction: async () => {
        throw new Error("not used");
      },
      completeEmailPasswordTransaction: async () => {
        throw new Error("not used");
      },
      cancelLoginTransaction: async () => current,
      selectLoginSlot: async () => {
        current = projection(true);
        return current;
      },
      logoutLoginSlot: async () => current,
      logoutSessionSet: async () => ({ generation: "4", actorEpoch: "3", state: "logged_out" }),
      resolveDeepLink: async () => ({ kind: "unavailable" }),
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <BrowserAccountsProvider
            client={client}
            broadcastChannelName={null}
            onActorTransition={async (transition) => {
              if (transition.to?.selectedSlotId) {
                await selectionSettled;
              }
            }}
          >
            <BrowserAccountsSignedOutPanel />
            <BrowserAccountsLoadingGate>
              <div data-tenant-surface="true">Prior tenant surface</div>
            </BrowserAccountsLoadingGate>
          </BrowserAccountsProvider>,
        ),
      );
      await flush();

      expect(container.querySelector('[data-tenant-surface="true"]')).not.toBeNull();
      const select = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Continue as Account Beta"]',
      );
      expect(select).not.toBeNull();
      await act(async () => select!.click());
      await flush();

      expect(container.querySelector('[data-tenant-surface="true"]')).toBeNull();
      expect(container.textContent).toContain("Loading browser accounts");

      await act(async () => releaseSelection());
      await flush();
      expect(container.querySelector('[data-tenant-surface="true"]')).not.toBeNull();
    } finally {
      releaseSelection();
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
