import { describe, expect, test } from "bun:test";
import { BrowserAccountsProvider, type BrowserAccountTransition } from "@opengeni/react/accounts";
import type {
  BrowserAccountsClientLike,
  ManagedAuthLoginTransaction,
  ManagedAuthSessionSetProjection,
} from "@opengeni/sdk/accounts";
import { useEffect } from "react";

import {
  actRun,
  flush,
  registerDom,
  renderComponent,
} from "../../../../packages/react/test/render-hook";
import {
  useBrowserAccountPopup,
  type BrowserAccountPopupController,
} from "./use-browser-account-popup";

registerDom();

const SLOT = "00000000-0000-4000-8000-000000000001";
const TRANSACTION = "00000000-0000-4000-8000-000000000002";

function projection(): ManagedAuthSessionSetProjection {
  return {
    mode: "dual",
    generation: "1",
    actorEpoch: "1",
    csrfToken: "c".repeat(43),
    selectedSlotId: SLOT,
    state: "ready",
    slots: [
      {
        id: SLOT,
        displayName: "Account One",
        verifiedClaim: { kind: "email", value: "one@example.test" },
        state: "active",
      },
    ],
  };
}

function client(): BrowserAccountsClientLike {
  const current = projection();
  return {
    getSessionSet: async () => current,
    reconcileSessionSetAuthority: async () => current,
    bootstrapSessionSet: async () => current,
    beginLoginTransaction: async () => transaction(),
    completeEmailPasswordTransaction: async () => ({ projection: current, returnIntent: null }),
    cancelLoginTransaction: async () => current,
    selectLoginSlot: async () => current,
    logoutLoginSlot: async () => current,
    logoutSessionSet: async () => ({ generation: "2", actorEpoch: "2", state: "logged_out" }),
    resolveDeepLink: async () => ({ kind: "unavailable" }),
  };
}

function transaction(): ManagedAuthLoginTransaction {
  return {
    id: TRANSACTION,
    kind: "add",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    returnIntentId: null,
  };
}

function fakePopup() {
  let closed = false;
  const calls = { close: 0, focus: 0, replace: [] as string[] };
  const popup = {
    get closed() {
      return closed;
    },
    close() {
      closed = true;
      calls.close += 1;
    },
    focus() {
      calls.focus += 1;
    },
    location: {
      replace(value: string) {
        calls.replace.push(value);
      },
    },
  } as unknown as Window;
  return { popup, calls };
}

async function renderPopupHook() {
  let current: BrowserAccountPopupController | null = null;
  function Probe() {
    const popup = useBrowserAccountPopup();
    useEffect(() => {
      current = popup;
    });
    return null;
  }
  const rendered = await renderComponent(
    <BrowserAccountsProvider
      client={client()}
      broadcastChannelName={null}
      onActorTransition={async (_transition: BrowserAccountTransition) => undefined}
    >
      <Probe />
    </BrowserAccountsProvider>,
  );
  await flush();
  return {
    get current() {
      if (!current) throw new Error("popup hook did not render");
      return current;
    },
    unmount: rendered.unmount,
  };
}

describe("useBrowserAccountPopup", () => {
  test("deduplicates activation while begin is pending and navigates one popup", async () => {
    const originalOpen = window.open;
    const fake = fakePopup();
    let openCalls = 0;
    window.open = (() => {
      openCalls += 1;
      return fake.popup;
    }) as typeof window.open;
    let release!: (value: ManagedAuthLoginTransaction) => void;
    const pending = new Promise<ManagedAuthLoginTransaction>((resolve) => {
      release = resolve;
    });
    let beginCalls = 0;
    const hook = await renderPopupHook();
    try {
      await actRun(() => {
        hook.current.open(() => {
          beginCalls += 1;
          return pending;
        });
        hook.current.open(() => {
          beginCalls += 1;
          return pending;
        });
      });
      expect(openCalls).toBe(1);
      expect(beginCalls).toBe(1);
      expect(fake.calls.focus).toBe(1);

      release(transaction());
      await flush();
      expect(fake.calls.replace).toEqual([`/account-auth?transaction=${TRANSACTION}`]);
    } finally {
      await hook.unmount();
      window.open = originalOpen;
    }
  });

  test("closes an in-progress popup on unmount and restores focus after begin failure", async () => {
    const originalOpen = window.open;
    const first = fakePopup();
    const second = fakePopup();
    const popups = [first.popup, second.popup];
    window.open = (() => popups.shift() ?? null) as typeof window.open;
    let release!: (value: ManagedAuthLoginTransaction) => void;
    const pending = new Promise<ManagedAuthLoginTransaction>((resolve) => {
      release = resolve;
    });
    const hook = await renderPopupHook();
    hook.current.open(() => pending);
    await hook.unmount();
    expect(first.calls.close).toBe(1);
    release(transaction());
    await flush();
    expect(first.calls.replace).toEqual([]);

    const secondHook = await renderPopupHook();
    let settled = 0;
    try {
      secondHook.current.open(
        async () => {
          throw new Error("begin failed");
        },
        {
          onError: () => undefined,
          onSettled: () => {
            settled += 1;
          },
        },
      );
      await flush();
      expect(second.calls.close).toBe(1);
      expect(settled).toBe(1);
    } finally {
      await secondHook.unmount();
      window.open = originalOpen;
    }
  });
});
